from __future__ import annotations

from typing import Any

import pytest
from eth_account import Account
from eth_account.messages import encode_typed_data

from goassay import (
    AssayError,
    ConfigError,
    DelegateAlreadyBoundError,
    DelegateBindConflictError,
    ScopeMissingError,
)
from goassay._binding import check_binding_challenge
from goassay.signers import full_message
from tests.fake import ACCOUNT, BINDING, NOW, WEB, Answer, Fake, Seen

CTX = BINDING["context"]
CREDENTIAL = CTX["credentialId"]
CAIP10 = f"{CTX['network']}:{ACCOUNT.address}"
APPROVAL = f"https://app.example.test/agents/enable-paid?credential={CREDENTIAL}"


def delegate_api(active_after: int = 2, approval_url: str | None = APPROVAL) -> Any:
    state = {"bound": False, "reads": 0}

    def api(req: Seen) -> Answer | None:
        if req.method == "GET" and req.url.endswith("/agents/me/delegate"):
            if state["bound"]:
                state["reads"] += 1
            status = "ACTIVE" if state["bound"] and state["reads"] > active_after else "NONE"
            data: dict[str, Any] = {
                "credentialId": CREDENTIAL,
                "delegate": CAIP10 if state["bound"] else None,
                "pendingDelegate": None,
                "paidCalls": {
                    "status": status,
                    "maxVoucherAmount": "500000",
                    "maxPerWindow": "5000000",
                    "spentInWindow": "0",
                    "validUntil": None,
                }
                if state["bound"]
                else None,
            }
            if approval_url:
                data["approvalUrl"] = approval_url
            return Answer({"data": data})
        if req.method == "POST" and req.url.endswith("/agents/me/delegate/challenge"):
            return Answer({"data": BINDING["valid"][0]["challenge"]})
        if req.method == "POST" and req.url.endswith("/agents/me/delegate"):
            state["bound"] = True
            return Answer({"data": {"credentialId": CREDENTIAL, "delegate": CAIP10, "status": "ACTIVE"}})
        return None

    return api


def test_status_unbound_with_link_and_fingerprint() -> None:
    s = Fake(api=delegate_api()).client().paid_calls.status()
    assert s.state == "unbound" and s.credential_id == CREDENTIAL
    assert s.fingerprint == f"{ACCOUNT.address[-8:-4].upper()} {ACCOUNT.address[-4:].upper()}"
    assert s.approval_url == f"{APPROVAL}#key={ACCOUNT.address}"


def test_bind_then_wait_until_active() -> None:
    fake = Fake(api=delegate_api())
    client = fake.client()
    setup = client.paid_calls.bind()
    assert setup.already_bound is False and setup.state == "pending_approval"
    assert setup.bind_status == "ACTIVE"
    assert setup.delegate == ACCOUNT.address
    assert setup.approval_url == f"{APPROVAL}#key={ACCOUNT.address}"
    assert fake.signer.calls == 1
    bind_req = next(s for s in fake.seen if s.method == "POST" and s.url.endswith("/agents/me/delegate"))
    assert bind_req.body["challengeId"] == BINDING["valid"][0]["challenge"]["challengeId"]
    assert bind_req.body["signature"] == BINDING["valid"][0]["signature"]
    td = check_binding_challenge(
        BINDING["valid"][0]["challenge"],
        local_address=ACCOUNT.address,
        credential_id=CREDENTIAL,
        chain_id=31337,
        now_seconds=NOW,
    )
    signable = encode_typed_data(full_message=full_message(td))
    assert Account.recover_message(signable, signature=bind_req.body["signature"]) == ACCOUNT.address

    active = client.paid_calls.wait_until_active()
    assert active.state == "active" and active.caps and active.caps["maxVoucherAmount"] == "500000"
    assert 5.0 in fake.sleeps


def test_bind_is_noop_when_bound() -> None:
    fake = Fake(api=delegate_api(0))
    client = fake.client()
    client.paid_calls.bind()
    assert client.paid_calls.bind().already_bound is True
    assert fake.signer.calls == 1


BUILT = f"{WEB}/agents/enable-paid?credential={CREDENTIAL}#key={ACCOUNT.address}"


def test_approval_url_built_from_web_url_without_server_link() -> None:
    assert Fake(api=delegate_api(2, None)).client().paid_calls.bind().approval_url == BUILT


def test_server_link_for_another_credential_is_not_used() -> None:
    api = delegate_api(2, f"{WEB}/agents/enable-paid?credential=other")
    assert Fake(api=api).client().paid_calls.status().approval_url == BUILT


def test_server_link_on_another_origin_is_not_used() -> None:
    api = delegate_api(2, f"https://look-alike.example.test/agents/enable-paid?credential={CREDENTIAL}")
    assert Fake(api=api).client().paid_calls.status().approval_url == BUILT


def test_wait_times_out() -> None:
    clock = {"t": NOW, "tick": False}

    def now() -> float:
        if clock["tick"]:
            clock["t"] += 60
        return clock["t"]

    client = Fake(api=delegate_api(1000)).client(now=now)
    client.paid_calls.bind()
    clock["tick"] = True
    with pytest.raises(AssayError) as err:
        client.paid_calls.wait_until_active(timeout=300)
    assert err.value.code == "WAIT_TIMEOUT"


def test_bind_needs_a_signer() -> None:
    with pytest.raises(ConfigError):
        Fake(api=delegate_api()).client(with_signer=False).paid_calls.bind()


# --- replacing a bound key ----------------------------------------------------------------

OTHER = "0x5555555555555555555555555555555555555555"
OTHER10 = f"{CTX['network']}:{OTHER}"


def rebind_api(promote_after: int = 2, bind_answer: Any = None) -> Any:
    """Another key is bound: binding this key leaves it pending (the old key keeps signing) until
    the approval lands after ``promote_after`` reads."""
    state = {"pending": False, "reads": 0}

    def api(req: Seen) -> Answer | None:
        if req.method == "GET" and req.url.endswith("/agents/me/delegate"):
            if state["pending"]:
                state["reads"] += 1
            promoted = state["pending"] and state["reads"] > promote_after
            waiting = state["pending"] and not promoted
            return Answer(
                {
                    "data": {
                        "credentialId": CREDENTIAL,
                        "delegate": CAIP10 if promoted else OTHER10,
                        "boundAt": "2026-10-22T10:05:00.000Z" if promoted else "2026-10-01T00:00:00.000Z",
                        "pendingDelegate": CAIP10 if waiting else None,
                        "pendingSince": "2026-10-22T10:00:00.000Z" if waiting else None,
                        "paidCalls": {
                            "status": "ACTIVE",
                            "maxVoucherAmount": "1",
                            "maxPerWindow": "2",
                            "spentInWindow": "0",
                            "validUntil": None,
                        },
                        "paidCallsUnknown": False,
                        "approvalUrl": f"{APPROVAL}#key={ACCOUNT.address if waiting else OTHER}",
                    }
                }
            )
        if req.method == "POST" and req.url.endswith("/agents/me/delegate/challenge"):
            return Answer({"data": BINDING["valid"][0]["challenge"]})
        if req.method == "POST" and req.url.endswith("/agents/me/delegate"):
            if bind_answer is not None:
                return bind_answer  # type: ignore[no-any-return]
            state["pending"] = True
            return Answer(
                {
                    "data": {
                        "credentialId": CREDENTIAL,
                        "status": "PENDING_APPROVAL",
                        "delegate": OTHER10,
                        "boundAt": "2026-10-01T00:00:00.000Z",
                        "pendingDelegate": CAIP10,
                        "pendingSince": "2026-10-22T10:00:00.000Z",
                        "approvalUrl": f"{APPROVAL}#key={ACCOUNT.address}",
                    }
                },
                201,
            )
        return None

    return api


def test_status_with_another_key_bound() -> None:
    s = Fake(api=rebind_api()).client().paid_calls.status()
    assert s.state == "bound_to_other_key" and s.delegate == OTHER
    assert s.bound_at == "2026-10-01T00:00:00.000Z" and s.pending_delegate is None
    # The server's link names the old key; this client's key replaces it in the fragment.
    assert s.approval_url == f"{APPROVAL}#key={ACCOUNT.address}"


def test_rebind_is_pending_then_wait_until_promoted() -> None:
    fake = Fake(api=rebind_api())
    client = fake.client()
    setup = client.paid_calls.bind()
    assert setup.already_bound is False and setup.bind_status == "PENDING_APPROVAL"
    assert setup.state == "pending_approval" and setup.delegate == OTHER
    assert setup.pending_delegate == ACCOUNT.address
    assert setup.pending_since == "2026-10-22T10:00:00.000Z"
    assert setup.approval_url == f"{APPROVAL}#key={ACCOUNT.address}"
    assert fake.signer.calls == 1
    # The old key's paid calls are ACTIVE, but this key is not the delegate yet: keep waiting.
    active = client.paid_calls.wait_until_active()
    assert active.state == "active" and active.delegate == ACCOUNT.address
    assert active.pending_delegate is None


def test_rebind_again_while_pending_is_noop() -> None:
    fake = Fake(api=rebind_api(1000))
    client = fake.client()
    client.paid_calls.bind()
    again = client.paid_calls.bind()
    assert again.already_bound is True and again.bind_status == "PENDING_APPROVAL"
    assert fake.signer.calls == 1


@pytest.mark.parametrize(
    "answer",
    [
        {"status": "PENDING_APPROVAL", "delegate": OTHER10, "pendingDelegate": OTHER10},
        {"status": "ACTIVE", "delegate": OTHER10, "pendingDelegate": CAIP10},
    ],
)
def test_bind_answer_not_naming_this_key_in_its_slot_is_refused(answer: dict[str, Any]) -> None:
    api = rebind_api(2, Answer({"data": {"credentialId": CREDENTIAL, **answer}}))
    with pytest.raises(AssayError) as err:
        Fake(api=api).client().paid_calls.bind()
    assert err.value.code == "BINDING_NOT_ACCEPTED"


def test_delegate_already_bound_is_typed() -> None:
    body = {
        "success": False,
        "error": {"code": "ACCOUNT_DELEGATE_ALREADY_BOUND", "message": "bound elsewhere", "statusCode": 409},
    }
    with pytest.raises(DelegateAlreadyBoundError) as err:
        Fake(api=rebind_api(2, Answer(body, 409))).client().paid_calls.bind()
    assert err.value.code == "ACCOUNT_DELEGATE_ALREADY_BOUND" and err.value.status == 409


def test_bind_conflict_is_typed_and_one_more_bind_parks_the_key() -> None:
    parks = rebind_api(1_000)
    body = {
        "success": False,
        "error": {"code": "ACCOUNT_DELEGATE_BIND_CONFLICT", "message": "bound at the same moment", "statusCode": 409},
    }
    binds = {"n": 0}

    def api(req: Seen) -> Answer | None:
        if req.method == "POST" and req.url.endswith("/agents/me/delegate"):
            binds["n"] += 1
            if binds["n"] == 1:
                return Answer(body, 409)
        return parks(req)  # type: ignore[no-any-return]

    fake = Fake(api=api)
    client = fake.client()
    with pytest.raises(DelegateBindConflictError) as err:
        client.paid_calls.bind()
    assert err.value.code == "ACCOUNT_DELEGATE_BIND_CONFLICT" and err.value.status == 409
    assert err.value.retryable is True
    # Not retried by the SDK: one bind request, one signature.
    assert binds["n"] == 1 and fake.signer.calls == 1

    again = client.paid_calls.bind()
    assert again.already_bound is False and again.bind_status == "PENDING_APPROVAL"
    assert again.pending_delegate == ACCOUNT.address
    assert len([s for s in fake.seen if s.url.endswith("/agents/me/delegate/challenge")]) == 2
    assert fake.signer.calls == 2


def test_bind_without_payments_scope_is_scope_missing() -> None:
    inner = rebind_api()
    body = {
        "success": False,
        "error": {
            "code": "AUTH_SCOPE_MISSING",
            "message": "no",
            "statusCode": 403,
            "context": {"requiredScope": "payments"},
        },
    }

    def api(req: Seen) -> Answer | None:
        if req.url.endswith("/agents/me/delegate/challenge"):
            return Answer(body, 403)
        return inner(req)  # type: ignore[no-any-return]

    with pytest.raises(ScopeMissingError) as err:
        Fake(api=api).client().paid_calls.bind()
    assert err.value.required_scope == "payments"
