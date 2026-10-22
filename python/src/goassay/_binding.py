from __future__ import annotations

import math
import re
from typing import Any, NoReturn

from eth_utils.address import is_address, to_checksum_address

from goassay._errors import SignerRefusal

# The binding proof's own EIP-712 domain (spec section 5). Not the escrow's.
DELEGATE_BINDING_DOMAIN_NAME = "GoAssay Agent Binding"
DELEGATE_BINDING_DOMAIN_VERSION = "1"

# The longest challenge life a client accepts: the server's challenge TTL.
MAX_BINDING_CHALLENGE_SECONDS = 300

# Exactly these fields, in this order. The order is part of the type hash.
DELEGATE_BINDING_TYPES: dict[str, list[dict[str, str]]] = {
    "DelegateBinding": [
        {"name": "delegate", "type": "address"},
        {"name": "credentialId", "type": "string"},
        {"name": "nonce", "type": "string"},
        {"name": "expiresAt", "type": "uint64"},
    ],
}

_DOMAIN_KEYS = ("name", "version", "chainId")
_MESSAGE_KEYS = ("delegate", "credentialId", "nonce", "expiresAt")
_MAX_UINT64 = 2**64 - 1
_UINT = re.compile(r"0|[1-9][0-9]*")
_ADDRESS = re.compile(r"0x[0-9a-fA-F]{40}")
_UUID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")


def binding_typed_data(chain_id: int, delegate: str, credential_id: str, nonce: str, expires_at: int) -> dict[str, Any]:
    """The typed data for checked values."""
    return {
        "domain": {
            "name": DELEGATE_BINDING_DOMAIN_NAME,
            "version": DELEGATE_BINDING_DOMAIN_VERSION,
            "chainId": chain_id,
        },
        "types": DELEGATE_BINDING_TYPES,
        "primaryType": "DelegateBinding",
        "message": {
            "delegate": delegate,
            "credentialId": credential_id,
            "nonce": nonce,
            "expiresAt": expires_at,
        },
    }


def _refuse(field: str, reason: str) -> NoReturn:
    raise SignerRefusal("the binding challenge", field, reason)


def _integer(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if 0 <= value < 2**53 else None
    if isinstance(value, str) and _UINT.fullmatch(value):
        return int(value)
    return None


def _is_address(value: object) -> bool:
    return isinstance(value, str) and _ADDRESS.fullmatch(value) is not None and is_address(value.lower())


def check_binding_challenge(
    challenge: object, *, local_address: str, credential_id: str, chain_id: int, now_seconds: float
) -> dict[str, Any]:
    """Checks the server's ``DelegateBinding`` challenge field by field (spec section 5.2).

    Returns the typed data to sign, rebuilt from the SDK's own constants. Raises
    ``SignerRefusal`` naming the first field that fails.
    """
    if not _is_address(local_address):
        _refuse("context.localAddress", "is not an address")
    if not isinstance(challenge, dict):
        _refuse("challenge", "is not an object")
    t = challenge.get("typedData")
    if not isinstance(t, dict):
        _refuse("typedData", "is not an object")

    domain = t.get("domain")
    if not isinstance(domain, dict):
        _refuse("domain", "is not an object")
    for key in domain:
        if key not in _DOMAIN_KEYS:
            _refuse(f"domain.{key}", "must not be present")
    if domain.get("name") != DELEGATE_BINDING_DOMAIN_NAME:
        _refuse("domain.name", f'must be "{DELEGATE_BINDING_DOMAIN_NAME}"')
    if domain.get("version") != DELEGATE_BINDING_DOMAIN_VERSION:
        _refuse("domain.version", f'must be "{DELEGATE_BINDING_DOMAIN_VERSION}"')
    if _integer(domain.get("chainId")) != chain_id:
        _refuse("domain.chainId", f"must be {chain_id}")

    if t.get("primaryType") != "DelegateBinding":
        _refuse("primaryType", 'must be "DelegateBinding"')
    types = t.get("types")
    if not isinstance(types, dict):
        _refuse("types", "is not an object")
    for key in types:
        if key != "DelegateBinding":
            _refuse(f"types.{key}", "must not be present")
    fields = types.get("DelegateBinding")
    expected = DELEGATE_BINDING_TYPES["DelegateBinding"]
    if not (
        isinstance(fields, list)
        and len(fields) == len(expected)
        and all(isinstance(f, dict) and f == e for f, e in zip(fields, expected, strict=True))
    ):
        _refuse(
            "types.DelegateBinding",
            "must be exactly delegate:address, credentialId:string, nonce:string, expiresAt:uint64",
        )

    message = t.get("message")
    if not isinstance(message, dict):
        _refuse("message", "is not an object")
    for key in message:
        if key not in _MESSAGE_KEYS:
            _refuse(f"message.{key}", "must not be present")
    delegate = message.get("delegate")
    if not _is_address(delegate):
        _refuse("message.delegate", "is not an address")
    assert isinstance(delegate, str)
    if to_checksum_address(delegate) != to_checksum_address(local_address):
        _refuse("message.delegate", "is not the local key")
    if message.get("credentialId") != credential_id:
        _refuse("message.credentialId", "is not this key's credential")
    nonce = message.get("nonce")
    if not isinstance(nonce, str) or not 0 < len(nonce) <= 256:
        _refuse("message.nonce", "is not a usable nonce")
    expires_at = _integer(message.get("expiresAt"))
    if expires_at is None or expires_at > _MAX_UINT64:
        _refuse("message.expiresAt", "is not a uint64")
    now = math.floor(now_seconds)
    if expires_at <= now:
        _refuse("message.expiresAt", "is not in the future")
    if expires_at > now + MAX_BINDING_CHALLENGE_SECONDS:
        _refuse("message.expiresAt", f"is more than {MAX_BINDING_CHALLENGE_SECONDS}s away")
    challenge_id = challenge.get("challengeId")
    if not isinstance(challenge_id, str) or not _UUID.fullmatch(challenge_id):
        _refuse("challengeId", "is not a UUID")
    return binding_typed_data(chain_id, to_checksum_address(delegate), credential_id, nonce, expires_at)
