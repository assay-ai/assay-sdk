from __future__ import annotations

from typing import Any

import pytest
from eth_account import Account
from eth_account.messages import encode_typed_data

from goassay import AssayError, ConfigError
from goassay._binding import check_binding_challenge
from goassay.signers import full_message
from tests.fake import ACCOUNT, BINDING, NOW, Answer, Fake, Seen

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


def test_no_approval_url_without_server_link() -> None:
    assert Fake(api=delegate_api(2, None)).client().paid_calls.bind().approval_url is None


def test_link_for_another_credential_is_dropped() -> None:
    api = delegate_api(2, "https://app.example.test/agents/enable-paid?credential=other")
    assert Fake(api=api).client().paid_calls.status().approval_url is None


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
