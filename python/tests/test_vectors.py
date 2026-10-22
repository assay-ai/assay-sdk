from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from eth_account import Account
from eth_account.messages import encode_typed_data
from eth_utils.crypto import keccak

from goassay import binding_typed_data, build_voucher

VECTORS = Path(__file__).resolve().parents[2] / "vectors" / "eip155"

# Files this test runs, and files a later milestone runs (with the reason).
RUN = ["binding.json", "vouchers.json"]
PENDING = {
    "guards.json": "the guards land with the paid-call client",
    "seq.json": "the guards land with the paid-call client",
}


def load(name: str) -> Any:
    return json.loads((VECTORS / name).read_text(encoding="utf-8"))


VOUCHERS = load("vouchers.json")
BINDING = load("binding.json")


def as_vector(td: dict[str, Any]) -> dict[str, Any]:
    """The typed data as the vectors write it: integers as decimal strings, bytes as 0x hex."""

    def conv(v: Any) -> Any:
        if isinstance(v, bool):
            return v
        if isinstance(v, int):
            return str(v)
        if isinstance(v, bytes):
            return "0x" + v.hex()
        return v

    return {**td, "message": {k: conv(v) for k, v in td["message"].items()}}


def full_message(td: dict[str, Any]) -> dict[str, Any]:
    domain_fields = [
        {"name": "name", "type": "string"},
        {"name": "version", "type": "string"},
        {"name": "chainId", "type": "uint256"},
    ]
    if "verifyingContract" in td["domain"]:
        domain_fields.append({"name": "verifyingContract", "type": "address"})
    return {**td, "types": {"EIP712Domain": domain_fields, **td["types"]}}


def sign(td: dict[str, Any], private_key: str) -> dict[str, str]:
    """The EIP-712 hashes, the test key's signature and the address recovered from it."""
    signable = encode_typed_data(full_message=full_message(td))
    signed = Account.sign_message(signable, private_key)
    return {
        "domainSeparator": "0x" + signable.header.hex(),
        "structHash": "0x" + signable.body.hex(),
        "digest": "0x" + keccak(b"\x19\x01" + signable.header + signable.body).hex(),
        "signature": "0x" + signed.signature.hex(),
        "recovered": Account.recover_message(signable, signature=signed.signature),
    }


def test_every_vector_file_is_listed() -> None:
    files = sorted(p.name for p in VECTORS.glob("*.json"))
    assert files == sorted(RUN + list(PENDING))


@pytest.mark.parametrize("case", VOUCHERS["cases"], ids=lambda c: c["name"])
def test_voucher(case: dict[str, Any]) -> None:
    built = build_voucher(case["requirement"], case["issuedAt"], case["network"])
    assert built.wire == case["wire"]
    assert as_vector(built.typed_data) == case["typedData"]
    out = sign(built.typed_data, VOUCHERS["testKey"]["privateKey"])
    for key in ("domainSeparator", "structHash", "digest", "signature"):
        assert out[key] == case[key], key
    assert out["recovered"] == VOUCHERS["testKey"]["address"]


@pytest.mark.parametrize("case", BINDING["valid"], ids=lambda c: c["name"])
def test_binding(case: dict[str, Any]) -> None:
    m = case["typedData"]["message"]
    td = binding_typed_data(
        case["typedData"]["domain"]["chainId"], m["delegate"], m["credentialId"], m["nonce"], int(m["expiresAt"])
    )
    assert as_vector(td) == case["typedData"]
    out = sign(td, BINDING["testKey"]["privateKey"])
    assert out["digest"] == case["digest"]
    assert out["signature"] == case["signature"]
    assert out["recovered"] == BINDING["testKey"]["address"]
