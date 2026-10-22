from __future__ import annotations

import asyncio
import copy
from typing import Any

import pytest
from eth_account import Account
from eth_account.messages import encode_typed_data

from goassay import (
    AssayError,
    AuthError,
    ConfigError,
    HumanSessionRequiredError,
    PaymentError,
    PaymentRefusedError,
    PaymentRequiredError,
    PaymentSchemeUnsupportedError,
    RateLimitError,
    ScopeMissingError,
)
from goassay._voucher import build_voucher
from goassay.signers import full_message
from tests.fake import (
    ACCOUNT,
    BASE,
    GUARDS,
    MCP,
    TOOL,
    Answer,
    Fake,
    Seen,
    get_tool_answer,
    meta_of,
    payment_required,
    tool_result,
)

RECEIPT: dict[str, Any] = {
    "intentId": "2f1c0b7e-4a3d-4e5f-8a9b-0c1d2e3f4a5b",
    "charged": {"amount": "100000", "asset": BASE["quote"]["asset"], "decimals": 6},
}


def paid_tool(after: Any = None) -> Any:
    """MCP answers for a paid tool: PAYMENT_REQUIRED without a voucher; ``after(n)`` with one."""
    attempts = {"n": 0}

    def handler(params: dict[str, Any], _seen: Seen) -> Any:
        if params["name"] == "get_tool":
            return get_tool_answer()
        if "assay/voucher" not in params["_meta"]:
            return payment_required()
        n = attempts["n"]
        attempts["n"] += 1
        return after(n) if after else tool_result({"assay/receipt": RECEIPT})

    return handler


# --- free call ----------------------------------------------------------------------------


def test_free_call_receipt_has_null_intent_id() -> None:
    receipt = {**RECEIPT, "intentId": None, "charged": {**RECEIPT["charged"], "amount": "0"}}
    fake = Fake(mcp=lambda p, s: tool_result({"assay/receipt": receipt}))
    r = fake.client().tools.call("get_weather", {})
    assert r.receipt is not None and r.receipt["intentId"] is None


def test_free_call_sends_key_and_protocol_headers() -> None:
    fake = Fake(mcp=lambda p, s: tool_result({"assay/receipt": RECEIPT}, structuredContent={"t": 21}))
    r = fake.client(with_signer=False).tools.call(TOOL, {"city": "Lisbon"})
    assert r.is_error is False and r.structured_content == {"t": 21}
    assert r.receipt is not None and r.receipt["intentId"] == RECEIPT["intentId"]
    req = fake.seen[0]
    assert req.headers["authorization"] == "Bearer test-api-key-123"
    assert req.headers["mcp-protocol-version"] == "2026-07-28"
    assert req.headers["mcp-name"] == TOOL
    meta = meta_of(req)
    assert meta["assay/idempotency-key"] == r.idempotency_key
    assert meta["io.modelcontextprotocol/protocolVersion"] == "2026-07-28"
    assert "assay/voucher" not in meta


def test_caller_key_and_provider_error_as_value() -> None:
    fake = Fake(mcp=lambda p, s: tool_result({}, isError=True))
    r = fake.client().tools.call(TOOL, {}, idempotency_key="order-42-weather")
    assert r.is_error is True
    assert meta_of(fake.seen[0])["assay/idempotency-key"] == "order-42-weather"


def test_invalid_idempotency_key_sends_nothing() -> None:
    fake = Fake(mcp=lambda p, s: tool_result({}))
    with pytest.raises(ConfigError):
        fake.client().tools.call(TOOL, {}, idempotency_key="é")
    assert fake.seen == []


# --- paid call ----------------------------------------------------------------------------


def test_paid_call_signs_once_and_retries_with_same_key() -> None:
    hooks: list[dict[str, Any]] = []

    def on_payment(details: dict[str, Any]) -> bool:
        hooks.append(details)
        return True

    fake = Fake(mcp=paid_tool())
    r = fake.client(on_payment=on_payment).tools.call(TOOL, {"city": "Lisbon"})
    assert r.receipt is not None and r.receipt["intentId"] == RECEIPT["intentId"]
    assert fake.signer.calls == 1
    unsigned, signed = fake.calls()
    assert meta_of(unsigned)["assay/idempotency-key"] == meta_of(signed)["assay/idempotency-key"]
    env = meta_of(signed)["assay/voucher"]
    assert env["providerId"] == BASE["requirement"]["providerId"] and env["contractVersion"] == 3
    net = {"caip2": BASE["network"]["id"], **{k: BASE["network"][k] for k in ("escrow", "asset", "decimals")}}
    built = build_voucher(BASE["requirement"], env["voucher"]["issuedAt"], net)
    assert env["voucher"] == built.wire
    recovered = Account.recover_message(
        encode_typed_data(full_message=full_message(built.typed_data)), signature=env["signature"]
    )
    assert recovered == ACCOUNT.address
    assert hooks and hooks[0]["tool"] == TOOL and hooks[0]["amount"] == BASE["requirement"]["amount"]
    assert hooks[0]["idempotency_key"] == r.idempotency_key


def test_network_retry_resends_same_envelope_without_resigning() -> None:
    down = Answer({"success": False, "error": {"code": "UNAVAILABLE", "message": "down"}}, 503)
    fake = Fake(mcp=paid_tool(lambda n: down if n == 0 else tool_result({"assay/receipt": RECEIPT})))
    fake.client().tools.call(TOOL, {})
    assert fake.signer.calls == 1
    sent = fake.calls()
    assert len(sent) == 3
    assert len({meta_of(s)["assay/idempotency-key"] for s in sent}) == 1
    assert meta_of(sent[1])["assay/voucher"] == meta_of(sent[2])["assay/voucher"]
    assert len(fake.sleeps) == 1


def test_in_progress_waits_and_resends_same_signed_request() -> None:
    busy = tool_result(
        {"assay/error": {"code": "IDEMPOTENCY_IN_PROGRESS", "retryable": True, "retryAfter": 2}}, isError=True
    )
    fake = Fake(mcp=paid_tool(lambda n: busy if n == 0 else tool_result({})))
    fake.client().tools.call(TOOL, {})
    assert fake.signer.calls == 1
    assert fake.sleeps == [2.0]
    assert meta_of(fake.calls()[1])["assay/voucher"] == meta_of(fake.calls()[2])["assay/voucher"]


def test_server_refusal_of_signed_voucher_is_raised_and_not_resigned() -> None:
    refused = tool_result(
        {"assay/error": {"code": "PAYMENT_VOUCHER_DELEGATE_INACTIVE", "message": "revoked"}}, isError=True
    )
    fake = Fake(mcp=paid_tool(lambda n: refused))
    with pytest.raises(PaymentError) as err:
        fake.client().tools.call(TOOL, {})
    assert err.value.code == "PAYMENT_VOUCHER_DELEGATE_INACTIVE"
    assert fake.signer.calls == 1


# A free-calls-only key (no ``payments`` scope): the paid path refuses it with AUTH_SCOPE_MISSING on
# ``assay/error``, naming the scope at the top level, with or without a voucher.
NO_PAYMENTS = tool_result(
    {"assay/error": {"requiredScope": "payments", "code": "AUTH_SCOPE_MISSING", "retryable": False}},
    isError=True,
    content=[
        {"type": "text", "text": "This key does not have the payments scope. Create a key with that scope to use this"}
    ],
)


def test_free_only_key_on_paid_tool_is_scope_missing_nothing_signed() -> None:
    fake = Fake(mcp=lambda p, s: get_tool_answer() if p["name"] == "get_tool" else NO_PAYMENTS)
    with pytest.raises(ScopeMissingError) as err:
        fake.client().tools.call(TOOL, {})
    assert err.value.required_scope == "payments" and err.value.retryable is False
    assert err.value.status == 403
    assert "payments scope" in str(err.value)
    assert fake.signer.calls == 0 and len(fake.calls()) == 1 and fake.sleeps == []


def test_scope_missing_on_signed_request_is_raised_not_resigned_or_resent() -> None:
    fake = Fake(mcp=paid_tool(lambda n: NO_PAYMENTS))
    with pytest.raises(ScopeMissingError) as err:
        fake.client().tools.call(TOOL, {})
    assert err.value.required_scope == "payments"
    assert fake.signer.calls == 1 and len(fake.calls()) == 2 and fake.sleeps == []


def test_payment_required_without_signer() -> None:
    fake = Fake(mcp=lambda p, s: payment_required(fix_url="https://app.example.test/agents/enable-paid?credential=x"))
    with pytest.raises(PaymentRequiredError) as err:
        fake.client(with_signer=False).tools.call(TOOL, {})
    assert err.value.requirement == BASE["requirement"]
    assert err.value.fix_url and "enable-paid" in err.value.fix_url


def test_network_mismatch_names_the_network() -> None:
    network = "solana:placeholder"
    fake = Fake(mcp=lambda p, s: payment_required({**BASE["requirement"], "network": network}))
    with pytest.raises(PaymentSchemeUnsupportedError) as err:
        fake.client().tools.call(TOOL, {})
    assert err.value.network == network and network in str(err.value)
    assert fake.signer.calls == 0


def test_on_payment_refusal_signs_nothing() -> None:
    fake = Fake(mcp=paid_tool())
    with pytest.raises(PaymentRefusedError) as err:
        fake.client(on_payment=lambda d: False).tools.call(TOOL, {})
    assert err.value.guard == "on_payment"
    assert fake.signer.calls == 0 and len(fake.calls()) == 1


REQUIREMENT_CASES = [
    c
    for c in GUARDS["cases"]
    if not c["expect"]["ok"]
    and c["changes"]
    and all(ch["path"][0] == "requirement" and len(ch["path"]) > 1 for ch in c["changes"])
    and c["expect"]["guard"] not in ("G1", "G4")
]


@pytest.mark.parametrize("case", REQUIREMENT_CASES, ids=lambda c: f"{c['expect']['code']} {c['name']}")
def test_guard_refusal_from_vectors(case: dict[str, Any]) -> None:
    requirement = copy.deepcopy(BASE["requirement"])
    for ch in case["changes"]:
        node = requirement
        for k in ch["path"][1:-1]:
            node = node[k]
        if ch["op"] == "delete":
            del node[ch["path"][-1]]
        else:
            node[ch["path"][-1]] = copy.deepcopy(ch["value"])
    fake = Fake(mcp=lambda p, s: get_tool_answer() if p["name"] == "get_tool" else payment_required(requirement))
    with pytest.raises(PaymentRefusedError) as err:
        fake.client().tools.call(TOOL, {})
    assert (err.value.guard, err.value.code) == (case["expect"]["guard"], case["expect"]["code"])
    assert fake.signer.calls == 0 and len(fake.calls()) == 1


def test_requirement_cases_not_empty() -> None:
    assert len(REQUIREMENT_CASES) > 20


def test_async_paid_call() -> None:
    fake = Fake(mcp=paid_tool())

    async def run() -> Any:
        async with fake.async_client() as client:
            return await client.tools.call(TOOL, {})

    r = asyncio.run(run())
    assert r.receipt is not None and fake.signer.calls == 1


# --- errors -------------------------------------------------------------------------------

SCOPE = Answer(
    {
        "success": False,
        "error": {
            "code": "AUTH_SCOPE_MISSING",
            "message": "This key does not have the tools:call scope.",
            "statusCode": 403,
            "context": {"requiredScope": "tools:call"},
        },
    },
    403,
)


def test_scope_missing_over_mcp() -> None:
    fake = Fake(mcp=lambda p, s: SCOPE)
    with pytest.raises(ScopeMissingError) as err:
        fake.client().tools.call(TOOL, {})
    assert err.value.required_scope == "tools:call" and err.value.status == 403


def test_mcp_host_plain_403_is_scope_missing_on_every_method_not_retried() -> None:
    fake = Fake(mcp=lambda p, s: SCOPE)
    client = fake.client()
    for run in (lambda: client.tools.search("weather"), lambda: client.tools.get(TOOL)):
        with pytest.raises(ScopeMissingError) as err:
            run()
        assert err.value.required_scope == "tools:call"
    assert len([s for s in fake.seen if s.url == MCP]) == 2


def test_human_session_required_is_an_auth_error() -> None:
    body = {
        "success": False,
        "error": {"code": "AUTH_HUMAN_SESSION_REQUIRED", "message": "needs a signed-in user", "statusCode": 403},
    }
    fake = Fake(api=lambda s: Answer(body, 403))
    with pytest.raises(HumanSessionRequiredError) as err:
        fake.client().receipts.get(RECEIPT["intentId"])
    assert isinstance(err.value, AuthError)
    assert err.value.code == "AUTH_HUMAN_SESSION_REQUIRED" and err.value.status == 403


def test_scope_missing_on_api() -> None:
    fake = Fake(api=lambda s: SCOPE)
    with pytest.raises(ScopeMissingError):
        fake.client().receipts.get(RECEIPT["intentId"])


def test_unknown_code_is_base_error() -> None:
    fake = Fake(
        mcp=lambda p, s: tool_result({"assay/error": {"code": "SOMETHING_NEW", "message": "new"}}, isError=True)
    )
    with pytest.raises(AssayError) as err:
        fake.client().tools.call(TOOL, {})
    assert type(err.value) is AssayError and err.value.code == "SOMETHING_NEW"


def test_api_key_required(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("ASSAY_API_KEY", raising=False)
    with pytest.raises(ConfigError):
        Fake().client(api_key=None)


# --- Retry-After --------------------------------------------------------------------------


def limited(retry_after: str) -> Answer:
    return Answer(
        {"success": False, "error": {"code": "RATE_LIMITED", "message": "slow"}}, 429, {"retry-after": retry_after}
    )


def test_retry_after_is_honoured() -> None:
    n = {"i": 0}

    def mcp(p: dict[str, Any], s: Seen) -> Any:
        n["i"] += 1
        return limited("3") if n["i"] == 1 else tool_result({})

    fake = Fake(mcp=mcp)
    fake.client().tools.call(TOOL, {})
    assert fake.sleeps == [3.0]


def test_rpc_rate_limit_retry_after_ms() -> None:
    n = {"i": 0}

    def mcp(p: dict[str, Any], s: Seen) -> Any:
        n["i"] += 1
        if n["i"] == 1:
            err = {"code": -32029, "message": "limited", "data": {"code": "RATE_LIMITED", "retryAfterMs": 1500}}
            return Answer({"jsonrpc": "2.0", "id": s.body["id"], "error": err})
        return tool_result({})

    fake = Fake(mcp=mcp)
    fake.client().tools.call(TOOL, {})
    assert fake.sleeps == [1.5]


def test_rate_limit_after_max_retries() -> None:
    fake = Fake(mcp=lambda p, s: limited("1"))
    with pytest.raises(RateLimitError) as err:
        fake.client().tools.call(TOOL, {})
    assert err.value.retry_after == 1.0
    assert len(fake.seen) == 3 and len(fake.sleeps) == 2


def test_long_retry_after_is_not_retried() -> None:
    fake = Fake(mcp=lambda p, s: limited("3600"))
    with pytest.raises(RateLimitError):
        fake.client().tools.call(TOOL, {})
    assert len(fake.seen) == 1


# --- receipts and secrets -----------------------------------------------------------------


def test_receipt() -> None:
    fake = Fake(
        api=lambda s: (
            Answer({"data": {"intentId": RECEIPT["intentId"], "chargedPrice": RECEIPT["charged"]}})
            if s.url.endswith(RECEIPT["intentId"])
            else None
        )
    )
    r = fake.client().receipts.get(RECEIPT["intentId"])
    assert r["chargedPrice"]["amount"] == "100000"


def test_repr_hides_the_key() -> None:
    client = Fake().client()
    assert "test-api-key" not in repr(client) and "test-api-key" not in repr(client.tools)
    assert MCP in repr(client)
