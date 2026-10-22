from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, NoReturn

from eth_utils.address import to_checksum_address
from eth_utils.crypto import keccak

from goassay._caip import parse_caip10, parse_caip19_erc20
from goassay._errors import SignerRefusal

# The escrow's EIP-712 domain name and version (spec section 6.1).
VOUCHER_DOMAIN_NAME = "Assay Settlement"
VOUCHER_DOMAIN_VERSION = "2"

# The lifetime a client asks for: well inside the server's 300 s ceiling.
VOUCHER_LIFETIME_SECONDS = 240

# The eight signed fields. The order is the type hash.
VOUCHER_TYPES: dict[str, list[dict[str, str]]] = {
    "Voucher": [
        {"name": "payer", "type": "address"},
        {"name": "provider", "type": "address"},
        {"name": "amount", "type": "uint64"},
        {"name": "resourceHash", "type": "bytes32"},
        {"name": "requestHash", "type": "bytes32"},
        {"name": "seq", "type": "uint64"},
        {"name": "issuedAt", "type": "uint64"},
        {"name": "expiresAt", "type": "uint64"},
    ],
}

_MAX_UINT64 = 2**64 - 1
_CAIP2 = re.compile(r"eip155:([1-9][0-9]*)")
_UINT = re.compile(r"0|[1-9][0-9]*")
_HEX64 = re.compile(r"[0-9a-fA-F]{64}")


@dataclass(frozen=True)
class BuiltVoucher:
    """The wire voucher (spec section 6.3) and the EIP-712 typed data to sign (integers as ints)."""

    wire: dict[str, Any]
    typed_data: dict[str, Any]


def _refuse(field: str, reason: str) -> NoReturn:
    raise SignerRefusal("the voucher", field, reason)


def _uint64(field: str, value: object) -> int:
    if isinstance(value, str) and _UINT.fullmatch(value):
        n = int(value)
    elif isinstance(value, int) and not isinstance(value, bool) and 0 <= value < 2**53:
        n = value
    else:
        _refuse(field, "is not a non-negative integer")
    if n > _MAX_UINT64:
        _refuse(field, "does not fit uint64")
    return n


def _account(field: str, value: object, chain_id: int) -> str:
    parsed = parse_caip10(value)
    if parsed is None:
        _refuse(field, "is not a checksummed CAIP-10 account")
    if parsed[0] != chain_id:
        _refuse(field, "is not on the requirement's network")
    return parsed[1]


def _request_hash(value: object) -> bytes:
    hex_part = value.removeprefix("sha256:") if isinstance(value, str) else ""
    if not _HEX64.fullmatch(hex_part):
        _refuse("requestHash", "is not 32 bytes of hex")
    return bytes.fromhex(hex_part)


def _resolve(net: Mapping[str, Any]) -> tuple[int, str]:
    caip2 = net.get("caip2")
    chain = _CAIP2.fullmatch(caip2) if isinstance(caip2, str) else None
    if chain is None:
        _refuse("network", "is not an eip155 CAIP-2 chain id")
    chain_id = int(chain.group(1))
    escrow = parse_caip10(net.get("escrow"))
    if escrow is None or escrow[0] != chain_id:
        _refuse("network.escrow", "is not a CAIP-10 account on the network's chain")
    asset = parse_caip19_erc20(net.get("asset"))
    if asset is None or asset[0] != chain_id:
        _refuse("network.asset", "is not a CAIP-19 erc20 asset on the network's chain")
    decimals = net.get("decimals")
    if not isinstance(decimals, int) or isinstance(decimals, bool) or not 0 <= decimals <= 36:
        _refuse("network.decimals", "is invalid")
    return chain_id, to_checksum_address(escrow[1])


def build_voucher(requirement: Mapping[str, Any], issued_at: int, net: Mapping[str, Any]) -> BuiltVoucher:
    """Builds the wire voucher and the EIP-712 typed data the payment key signs (spec section 6).

    The inputs are a rail-B requirement, a corrected ``issued_at`` and the client's own network
    entry (``caip2``, ``escrow``, ``asset``, ``decimals``), never one from the server.

    Raises ``SignerRefusal`` for a requirement on another network, a ``payTo`` other than the
    escrow, an amount in another asset or scale, and anything that cannot be encoded.
    """
    chain_id, verifying_contract = _resolve(net)
    if requirement.get("network") != net["caip2"]:
        _refuse("network", "is not the client's network")

    pay_to = _account("payTo", requirement.get("payTo"), chain_id)
    if pay_to != verifying_contract:
        _refuse("payTo", "is not the built-in escrow")
    payer = _account("payer", requirement.get("payer"), chain_id)
    provider = _account("provider", requirement.get("provider"), chain_id)

    money = requirement.get("amount")
    if not isinstance(money, Mapping):
        _refuse("amount", "is missing")
    amount = _uint64("amount", money.get("amount"))
    if money.get("asset") != net["asset"]:
        _refuse("amount.asset", "is not the built-in asset")
    if money.get("decimals") != net["decimals"]:
        _refuse("amount.decimals", "are not the built-in decimals")
    seq = _uint64("seq", requirement.get("seq"))
    resource = requirement.get("resource")
    if not isinstance(resource, str) or len(resource) == 0:
        _refuse("resource", "is empty")
    request_hash = _request_hash(requirement.get("requestHash"))
    max_timeout = requirement.get("maxTimeoutSeconds")
    if not isinstance(max_timeout, int) or isinstance(max_timeout, bool) or max_timeout < 1:
        _refuse("maxTimeoutSeconds", "is not a positive integer")
    if not isinstance(issued_at, int) or isinstance(issued_at, bool) or issued_at <= 0:
        _refuse("issuedAt", "is not a positive integer")

    expires_at = issued_at + min(VOUCHER_LIFETIME_SECONDS, max_timeout)

    # Built fresh: nothing the server sent beyond the checked fields reaches the wire.
    wire = {
        "payer": requirement["payer"],
        "payTo": requirement["payTo"],
        "provider": requirement["provider"],
        "amount": {"amount": str(amount), "asset": net["asset"], "decimals": net["decimals"]},
        "resource": resource,
        "requestHash": requirement["requestHash"],
        "seq": str(seq),
        "issuedAt": issued_at,
        "expiresAt": expires_at,
    }
    typed_data = {
        "domain": {
            "name": VOUCHER_DOMAIN_NAME,
            "version": VOUCHER_DOMAIN_VERSION,
            "chainId": chain_id,
            "verifyingContract": verifying_contract,
        },
        "types": VOUCHER_TYPES,
        "primaryType": "Voucher",
        "message": {
            "payer": payer,
            "provider": provider,
            "amount": amount,
            # Always the UTF-8 bytes of the string, even when it starts with "0x".
            "resourceHash": keccak(resource.encode("utf-8")),
            "requestHash": request_hash,
            "seq": seq,
            "issuedAt": issued_at,
            "expiresAt": expires_at,
        },
    }
    return BuiltVoucher(wire=wire, typed_data=typed_data)
