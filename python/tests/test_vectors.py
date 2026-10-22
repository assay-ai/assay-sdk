from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest
from eth_account import Account
from eth_account.messages import encode_typed_data
from eth_utils.crypto import keccak

from goassay._binding import binding_typed_data, check_binding_challenge
from goassay._eip155 import NetworkEntry, bind_evm_key, guard_and_build
from goassay._errors import SignerRefusal
from goassay._guards import RUN, check_all
from goassay._ops import CallOp
from goassay._voucher import build_voucher
from goassay.errors import PaymentError
from goassay.signers import evm_signer

VECTORS = Path(__file__).resolve().parents[2] / "vectors" / "eip155"

# Every file in vectors/eip155/ is run here; a new file fails until it is listed.
RUN_FILES = ["binding.json", "guards.json", "seq.json", "vouchers.json"]


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
    assert files == RUN_FILES


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


def apply(source: Any, changes: list[dict[str, Any]]) -> Any:
    out = copy.deepcopy(source)
    for ch in changes:
        node = out
        for k in ch["path"][:-1]:
            node = node[k]
        last = ch["path"][-1]
        if ch["op"] == "delete":
            del node[last]
        elif ch["op"] == "set":
            if isinstance(node, list) and last == len(node):
                node.append(copy.deepcopy(ch["value"]))
            else:
                node[last] = copy.deepcopy(ch["value"])
        else:
            raise AssertionError(ch["op"])
    return out


CTX = BINDING["context"]
CHAIN_ID = int(CTX["network"].split(":")[1])


def check(challenge: Any) -> dict[str, Any]:
    return check_binding_challenge(
        challenge,
        local_address=CTX["localAddress"],
        credential_id=CTX["credentialId"],
        chain_id=CHAIN_ID,
        now_seconds=CTX["nowSeconds"],
    )


def run_bind(challenge: Any) -> tuple[list[Any], list[str]]:
    """The bind flow on a stub API; returns what it signed and the paths it posted."""
    account = Account.from_key(BINDING["testKey"]["privateKey"])
    real = evm_signer(account)
    signed: list[Any] = []
    posted: list[str] = []

    def rest(method: str, path: str, body: Any = None) -> Any:
        posted.append(path)
        if path.endswith("/challenge"):
            return challenge, None
        return {"credentialId": CTX["credentialId"], "delegate": f"{CTX['network']}:{account.address}"}, None
        yield  # a flow

    flow = bind_evm_key(
        signer=real, chain_id=CHAIN_ID, credential_id=CTX["credentialId"], rest=rest, now=lambda: CTX["nowSeconds"]
    )
    value: Any = None
    try:
        while True:
            op = flow.send(value)
            assert isinstance(op, CallOp)
            out = op.fn(*op.args)
            signed.append(out)
            value = out
    except StopIteration:
        pass
    return signed, posted


@pytest.mark.parametrize("case", BINDING["valid"], ids=lambda c: c["name"])
def test_binding_check_and_flow(case: dict[str, Any]) -> None:
    td = check(case["challenge"])
    assert as_vector(td) == case["typedData"]
    signed, _ = run_bind(case["challenge"])
    assert signed == [case["signature"]]


@pytest.mark.parametrize("case", BINDING["invalid"], ids=lambda c: c["name"])
def test_binding_invalid(case: dict[str, Any]) -> None:
    challenge = apply(BINDING["valid"][0]["challenge"], [case])
    with pytest.raises(SignerRefusal) as err:
        check(challenge)
    assert err.value.field == case["field"]
    with pytest.raises(PaymentError):
        run_bind(challenge)


GUARDS = load("guards.json")
BASE = GUARDS["base"]


def table(ctx: dict[str, Any]) -> dict[str, NetworkEntry]:
    n = ctx.get("network")
    if not isinstance(n, dict) or not isinstance(n.get("id"), str):
        return {}
    escrow = str(n.get("escrow"))
    parts = escrow.split(":")
    return {
        n["id"]: NetworkEntry(
            n["id"],
            int(n["id"].split(":")[1]),
            parts[-1],
            escrow,
            n.get("asset"),  # type: ignore[arg-type]
            n.get("decimals"),  # type: ignore[arg-type]
        )
    }


def via_scheme(ctx: dict[str, Any]) -> Any:
    rest = {k: v for k, v in ctx.items() if k != "network"}
    g = guard_and_build(rest, ctx["nowSeconds"], table(ctx))
    return g.refusal if not g.ok else None


@pytest.mark.parametrize("case", GUARDS["cases"], ids=lambda c: f"{c['guard']} {c['name']}")
def test_guards(case: dict[str, Any]) -> None:
    ctx = apply(BASE, case["changes"])
    for result in (check_all(ctx), via_scheme(ctx)):
        if case["expect"]["ok"]:
            assert result is None or result.ok
            continue
        assert result is not None
        assert (result.ok, result.guard, result.code) == (False, case["expect"]["guard"], case["expect"]["code"])
        if "reason" in case["expect"]:
            assert result.reason == case["expect"]["reason"].replace("{run}", RUN)


@pytest.mark.parametrize("case", load("seq.json")["cases"], ids=lambda c: c["seq"])
def test_seq(case: dict[str, Any]) -> None:
    result = via_scheme(apply(BASE, [{"op": "set", "path": ["requirement", "seq"], "value": case["seq"]}]))
    if case["ok"]:
        assert result is None
    else:
        assert result is not None and (result.guard, result.code) == ("G9", "G9_SEQ")
