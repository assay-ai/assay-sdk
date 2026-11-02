"""Channel-debt renew: the shared vectors (``channel.json`` ``renews``) and the client's renew flow."""

from __future__ import annotations

import asyncio
import copy
import json
import re
from typing import Any

import pytest

from goassay import MemoryChannelStore
from goassay._channel import (
    LANE_PAIRS_KEPT,
    ChannelBookError,
    advance_lane,
    build_channel_voucher,
    finish_lane,
    lane_outcome_of,
    parse_book,
    pick_lane,
    renew_lane,
    renew_target,
)
from goassay._renew import (
    CHANNEL_DEBT_RENEWED_TEXT,
    CHANNEL_DEBT_RETRY_TEXT,
    DEBT_COLLECTING_TEXT,
    OTHER_WALLET_DEBT_TEXT,
    DebtRenewal,
    all_debts_collecting,
    channel_debt_answer,
    channel_debt_no_record_text,
    parse_debt_list,
)
from goassay.errors import AssayError, ConfigError, PaymentError, PaymentRefusedError

from .fake import (
    ACCOUNT,
    BASE,
    NETWORKS,
    NOW,
    TOOL,
    WEB,
    Answer,
    Fake,
    Seen,
    get_tool_answer,
    load,
    payment_required,
    tool_result,
)
from .test_vectors import as_vector, sign

V = load("channel.json")
R = V["renews"]
KEY = V["testKey"]["privateKey"]


def _case_lane(changes: dict[str, Any] | None = None) -> dict[str, Any]:
    """The vectors' base lane with a case's ``lane`` changes (a ``None`` value deletes the field)."""
    lane = dict(R["lane"])
    for k, v in (changes or {}).items():
        if v is None:
            lane.pop(k, None)
        else:
            lane[k] = v
    return lane


def _book(changes: dict[str, Any] | None = None) -> dict[str, Any]:
    return parse_book({"version": 1, "lanes": [_case_lane(changes)]})


def _pool() -> dict[str, Any]:
    lane = R["lane"]
    return {
        "channelId": lane["channelId"],
        "network": R["network"]["id"],
        "escrow": lane["escrow"],
        "payer": lane["payer"],
        "signer": lane["signer"],
    }


@pytest.mark.parametrize("case", R["valid"], ids=lambda c: c["name"])
def test_renew_vector(case: dict[str, Any]) -> None:
    before = _book(case.get("lane"))
    assert renew_target(before, {**_pool(), "cumulative": int(case["cumulative"]), "calls": case["calls"]})
    step = renew_lane(
        before, R["lane"]["channelId"], int(case["cumulative"]), case["calls"], case["issuedAt"], R["lifetimeSeconds"]
    )
    built = build_channel_voucher(
        R["lane"], step.channel_id, step.cumulative, step.calls, step.issued_at, step.expires_at, R["network"]
    )
    assert built.wire == case["expect"]["wire"]
    assert as_vector(built.typed_data) == case["expect"]["typedData"]
    signed = sign(built.typed_data, KEY)
    assert signed["digest"] == case["expect"]["digest"]
    assert signed["signature"] == case["expect"]["signature"]
    # Nothing on the lane moves but renewedIssuedAt.
    assert step.book["lanes"][0] == {**before["lanes"][0], "renewedIssuedAt": case["expect"]["renewedIssuedAt"]}
    assert parse_book(json.loads(json.dumps(step.book))) == step.book


@pytest.mark.parametrize("case", R["invalid"], ids=lambda c: c["name"])
def test_renew_vector_refused(case: dict[str, Any]) -> None:
    book = _book(case.get("lane"))
    with pytest.raises(ChannelBookError):
        renew_lane(book, R["lane"]["channelId"], int(case["cumulative"]), case["calls"], 1786007200, 240)
    assert renew_target(book, {**_pool(), "cumulative": int(case["cumulative"]), "calls": case["calls"]}) is None


def test_only_the_lane_the_debt_names() -> None:
    book = _book()
    ok = {**_pool(), "cumulative": 250_000, "calls": 2}
    assert renew_target(book, ok)["channelId"] == R["lane"]["channelId"]  # type: ignore[index]
    for bad in (
        {"channelId": "0x" + "ab" * 32},
        {"channelId": R["lane"]["channelId"].upper()},
        {"payer": "0x1111111111111111111111111111111111111111"},
        {"signer": "0x2222222222222222222222222222222222222222"},
        {"escrow": "0x3333333333333333333333333333333333333333"},
        {"network": "eip155:1"},
    ):
        assert renew_target(book, {**ok, **bad}) is None


def _taken(book: dict[str, Any], now: int) -> dict[str, Any]:
    pool = {k: R["lane"][k] for k in ("escrow", "payer", "signer", "provider")}
    pick = pick_lane(
        book,
        {**pool, "network": "eip155:31337"},
        100_000,
        max_lanes=1,
        rotate_at=10**9,
        now=now,
        new_channel_id=lambda: R["lane"]["channelId"],
    )
    assert pick.lane is not None
    return advance_lane(pick.book, pick.lane["channelId"], 100_000, now, 240, now).book


def test_a_refused_pair_leaves_the_renewable_set() -> None:
    cid = R["lane"]["channelId"]
    book = finish_lane(_taken({"version": 1, "lanes": []}, 1786000000), cid, "served")
    book = finish_lane(_taken(book, 1786000001), cid, "reuse")  # PAYMENT_UNSETTLED_LIMIT: not stored
    assert book["lanes"][0]["renewable"] == [["100000", 1]]
    book = finish_lane(_taken(book, 1786000002), cid, "served")  # the same pair again, stored now
    assert book["lanes"][0]["renewable"] == [["100000", 1], ["200000", 2]]
    refused = finish_lane(_taken(book, 1786000003), cid, "retire")  # CHANNEL_DESYNC
    assert refused["lanes"][0]["renewable"] == [["100000", 1], ["200000", 2]]
    assert (refused["lanes"][0]["retired"], refused["lanes"][0]["maxSigned"]) == (True, "300000")
    with pytest.raises(ChannelBookError):
        renew_lane(refused, cid, 300_000, 3, 1786000100, 240)
    unknown = finish_lane(_taken(book, 1786000003), cid, "unknown")  # no answer
    assert unknown["lanes"][0]["renewable"][-1] == ["300000", 3]
    assert unknown["lanes"][0]["retired"] is True
    for code in ("CHANNEL_ROTATE", "CHANNEL_DESYNC", "PAYMENT_UNSETTLED_LIMIT", "SOMETHING_NEW"):
        assert lane_outcome_of(code) in ("reuse", "retire")


def test_a_later_voucher_never_goes_below_the_renew() -> None:
    live = _book({"retired": False, "checkedAt": 1786007000})
    step = renew_lane(live, R["lane"]["channelId"], 250_000, 2, 1786007200, 240)
    nxt = advance_lane(step.book, R["lane"]["channelId"], 50_000, 1786007100, 240, 1786007100)
    assert nxt.issued_at == 1786007200
    assert nxt.cumulative == 350_000
    assert nxt.book["lanes"][0]["renewable"][-1] == ["350000", 4]


def test_damaged_renewable_is_refused_and_old_pairs_are_not_trusted() -> None:
    bad: list[Any] = [
        [["300000", 3], ["250000", 2]],
        [["400000", 4]],
        [["250000", 4]],
        [[250000, 2]],
        [[str(i + 1), i + 1] for i in range(LANE_PAIRS_KEPT + 1)],
    ]
    for pairs in bad:
        with pytest.raises(ChannelBookError):
            parse_book({"version": 1, "lanes": [{**R["lane"], "renewable": pairs}]})
    old = _case_lane({"renewable": None, "pairs": R["lane"]["renewable"], "retired": False})
    lane0 = parse_book({"version": 1, "lanes": [old]})["lanes"][0]
    assert "renewable" not in lane0
    assert "pairs" not in lane0


def test_debt_refusal_re_arms_the_lane() -> None:
    assert lane_outcome_of("PAYMENT_DEBT_OUTSTANDING") == "reuse"


PAYER_CAIP = BASE["requirement"]["payer"]
PAYER = PAYER_CAIP.split(":")[2]
ESCROW = BASE["network"]["escrow"].split(":")[2]
CHANNEL_NETWORKS = {BASE["network"]["id"]: {**NETWORKS[BASE["network"]["id"]], "channels": True}}


def ID(n: int) -> str:
    return f"00000000-0000-4000-8000-{n:012d}"


def LID(n: int) -> str:
    return "0x" + format(n, "064x")


_NO_LANE = object()


def debt(intent: str, lane: Any = None, **over: Any) -> dict[str, Any]:
    """A CHANNEL debt on ``lane`` (``_NO_LANE``: the field is left out)."""
    channel: dict[str, Any] = {"cumulative": "200000", "calls": 2}
    if lane is not _NO_LANE:
        channel["channelId"] = lane if lane is not None else LID(1)
    return {
        "intentId": intent,
        "payer": PAYER_CAIP,
        "amount": BASE["requirement"]["amount"],
        "state": "OPEN",
        "voucherFormat": "CHANNEL",
        "channel": channel,
        **over,
    }


def test_debt_list_entries_it_cannot_read_are_left_out() -> None:
    out = parse_debt_list(
        {
            "debts": [
                debt("not-a-uuid"),
                debt(ID(1), channel={"cumulative": "01", "calls": 1}),
                debt(ID(2), payer="solana:abc:xyz"),
                debt(ID(3), state="SETTLED"),
                debt(ID(4), "0x" + "AB" * 32, payer=PAYER_CAIP.lower()),
                debt(ID(5), "0x1234"),
            ]
        }
    )
    assert [(d["intentId"], d["payer"], d["channel"]["channelId"]) for d in out] == [
        (ID(4), PAYER, "0x" + "ab" * 32),
        (ID(5), PAYER, None),
    ]


def offer() -> dict[str, Any]:
    r = BASE["requirement"]
    return {
        "scheme": "channel-v1",
        "network": r["network"],
        "payer": r["payer"],
        "provider": r["provider"],
        "providerId": r["providerId"],
        "price": dict(r["amount"]),
        "domain": {"name": "Assay Settlement", "version": "2", "chainId": 31337, "verifyingContract": ESCROW},
        "minLifeSeconds": 60,
        "maxLifeSeconds": 300,
        "maxOpenChannels": 16,
        "signers": ["payer", "delegate"],
        "delegate": r["delegate"],
    }


DEBT_REFUSAL = tool_result(
    {
        "assay/error": {
            "code": "PAYMENT_DEBT_OUTSTANDING",
            "message": "This payer owes for 1 served call(s)",
            "retryable": False,
        }
    },
    isError=True,
)

VOUCHER_PATH = re.compile(r".*/escrow/debts/[0-9a-f-]+/voucher$")


class Server:
    """Paid calls with a debt switch; ``GET /escrow/debts`` and the renew route. ``debts`` gets the
    lane the client last paid on."""

    def __init__(self, debts: Any = None, post: Any = None, refuse: Any = None) -> None:
        self.owes = False
        self.lane = ""
        self.paid = 0
        self.debts = debts or (lambda lane: [debt(ID(1), lane)])
        self.post = post
        # ``refuse(n)``: the answer to the n-th channel voucher instead of a receipt (or ``None``).
        self.refuse = refuse
        self.fake = Fake(mcp=self.mcp, api=self.api)

    def mcp(self, params: dict[str, Any], _seen: Seen) -> Any:
        if params["name"] == "get_tool":
            return get_tool_answer()
        if self.owes:
            return DEBT_REFUSAL
        meta = params["_meta"]
        env = meta.get("assay/channelVoucher")
        if env is not None:
            self.lane = env["voucher"]["channelId"]
            self.paid += 1
            refused = self.refuse(self.paid) if self.refuse else None
            if refused is not None:
                return refused
        if env is not None or "assay/voucher" in meta:
            return tool_result({"assay/receipt": {"intentId": ID(9)}})
        r = payment_required()
        if isinstance(meta.get("assay/paymentSchemes"), list):
            r["_meta"]["assay/channelRequired"] = offer()
        return r

    def api(self, seen: Seen) -> Answer | None:
        if seen.method == "GET" and seen.url.endswith("/escrow/debts"):
            return Answer({"success": True, "data": {"account": PAYER_CAIP, "debts": self.debts(self.lane)}})
        if seen.method == "POST" and VOUCHER_PATH.fullmatch(seen.url):
            if self.post is not None:
                return self.post(seen)  # type: ignore[no-any-return]
            return Answer({"success": True, "data": {"status": "REPLACING", "remainingDebts": 0}}, 201)
        return None

    def client(self, channels: Any = True, **kw: Any) -> Any:
        if channels is True:
            kw["channels"] = MemoryChannelStore()
        elif channels is not False:
            kw["channels"] = channels
        return self.fake.client(networks=CHANNEL_NETWORKS, **kw)

    def posts(self) -> list[Seen]:
        return [s for s in self.fake.seen if s.method == "POST" and "/escrow/debts/" in s.url]

    def lists(self) -> list[Seen]:
        return [s for s in self.fake.seen if s.method == "GET" and s.url.endswith("/escrow/debts")]


def refused(code: str, status: int = 409) -> Any:
    return lambda _seen: Answer({"success": False, "error": {"code": code, "message": "x"}}, status)


def three_calls(client: Any) -> None:
    for _ in range(3):
        client.tools.call(TOOL, {})


def lane_record(i: int, **over: Any) -> dict[str, Any]:
    """A served lane of this client (signed ``(100000, 1)`` .. ``(300000, 3)``)."""
    return {
        "channelId": LID(i),
        "network": BASE["network"]["id"],
        "escrow": ESCROW,
        "payer": PAYER,
        "signer": ACCOUNT.address,
        "provider": BASE["requirement"]["provider"].split(":")[2],
        "maxSigned": "300000",
        "callsSigned": 3,
        "topIncrease": "100000",
        "lastIssuedAt": int(NOW) - 600,
        "lastExpiresAt": int(NOW) - 360,
        "reuseTop": False,
        "inFlightSince": None,
        "retired": False,
        "checkedAt": None,
        "renewable": [["100000", 1], ["200000", 2], ["300000", 3]],
        **over,
    }


def store_with(*lanes: dict[str, Any]) -> MemoryChannelStore:
    store = MemoryChannelStore()
    store.save({"version": 1, "lanes": list(lanes)})
    return store


def test_renews_the_exact_pair_it_signed_on_the_lane_the_debt_names() -> None:
    s = Server()
    client = s.client()
    three_calls(client)
    out = client.paid_calls.renew_channel_debts()
    assert [(r.intent_id, r.status, r.cumulative, r.calls, r.channel_id) for r in out] == [
        (ID(1), "renewed", "200000", 2, s.lane)
    ]
    [p] = s.posts()
    assert p.url == f"https://api.example.test/api/v1/escrow/debts/{ID(1)}/voucher"
    assert list(p.body) == ["channelVoucher"]
    v = p.body["channelVoucher"]["voucher"]
    assert (v["cumulative"], v["calls"], v["payer"], v["channelId"]) == ("200000", 2, PAYER, s.lane)
    assert v["expiresAt"] - v["issuedAt"] == 240
    lane = {
        "network": BASE["network"]["id"],
        "escrow": ESCROW,
        "payer": PAYER,
        "provider": BASE["requirement"]["provider"].split(":")[2],
    }
    net = {"id": BASE["network"]["id"], "chainId": 31337, "escrow": ESCROW}
    built = build_channel_voucher(lane, v["channelId"], 200_000, 2, v["issuedAt"], v["expiresAt"], net)
    assert sign(built.typed_data, KEY)["signature"] == p.body["channelVoucher"]["signature"]
    assert ACCOUNT.address == V["testKey"]["address"]


@pytest.mark.parametrize(
    ("make", "status"),
    [
        (lambda lane: debt(ID(1), _NO_LANE), "no_lane"),
        (lambda lane: debt(ID(1), LID(7)), "not_signed_here"),
        (
            lambda lane: debt(ID(1), lane, channel={"cumulative": "400000", "calls": 4, "channelId": lane}),
            "not_signed_here",
        ),
        (
            lambda lane: debt(ID(1), lane, channel={"cumulative": "150000", "calls": 2, "channelId": lane}),
            "not_signed_here",
        ),
    ],
    ids=["missing channelId", "another lane", "larger pair", "unsigned pair"],
)
def test_refuses_a_missing_or_wrong_lane_and_a_larger_or_unsigned_pair(make: Any, status: str) -> None:
    s = Server(debts=lambda lane: [make(lane)])
    client = s.client()
    three_calls(client)
    before = s.fake.signer.calls
    out = client.paid_calls.renew_channel_debts()
    assert [r.status for r in out] == [status]
    assert s.fake.signer.calls == before
    assert s.posts() == []


def test_a_pair_the_server_refused_is_never_renewed() -> None:
    def refuse(n: int) -> Any:
        if n != 3:
            return None
        return tool_result({"assay/error": {"code": "CHANNEL_DESYNC", "message": "x"}}, isError=True)

    s = Server(
        debts=lambda lane: [debt(ID(1), lane, channel={"cumulative": "300000", "calls": 3, "channelId": lane})],
        refuse=refuse,
    )
    client = s.client()
    client.tools.call(TOOL, {})
    client.tools.call(TOOL, {})
    with pytest.raises(AssayError) as err:
        client.tools.call(TOOL, {})
    assert err.value.code == "CHANNEL_DESYNC"
    before = s.fake.signer.calls
    assert [r.status for r in client.paid_calls.renew_channel_debts()] == ["not_signed_here"]
    assert s.fake.signer.calls == before


def test_adversarial_list_20_fake_debts_sign_once_on_the_one_real_lane() -> None:
    lanes = [lane_record(1)] + [lane_record(i, renewable=[["100000", 1]], retired=True) for i in (2, 3, 4, 5)]
    fake = [
        *[
            d
            for i in (2, 3, 4, 5)
            for d in (
                debt(ID(i * 10), LID(i)),  # a pair refused on those lanes
                debt(ID(i * 10 + 1), LID(i), channel={"cumulative": "300000", "calls": 3, "channelId": LID(i)}),
            )
        ],
        *[debt(ID(100 + i), LID(50 + i)) for i in range(6)],  # lanes it never had
        *[debt(ID(200 + i), _NO_LANE) for i in range(4)],  # no lane named
        debt(ID(300), LID(1), channel={"cumulative": "100000", "calls": 1, "channelId": LID(1)}),  # 2nd on lane 1
        debt(ID(1), LID(1)),  # the real one
    ]
    assert len(fake) == 20
    s = Server(debts=lambda _lane: fake)
    client = s.client(channels=store_with(*lanes))
    out = client.paid_calls.renew_channel_debts()
    assert s.fake.signer.calls == 1
    assert [
        (p.body["channelVoucher"]["voucher"]["channelId"], p.body["channelVoucher"]["voucher"]["cumulative"])
        for p in s.posts()
    ] == [(LID(1), "200000")]
    by = {r.intent_id: r.status for r in out}
    assert (by[ID(1)], by[ID(300)], by[ID(200)], by[ID(20)]) == (
        "renewed",
        "rate_limited",
        "no_lane",
        "not_signed_here",
    )


def test_not_a_new_spend() -> None:
    s = Server()
    client = s.client(limits={"max_per_call": "0.10", "max_per_day": "0.30"})
    three_calls(client)
    assert client.paid_calls.renew_channel_debts()[0].status == "renewed"
    with pytest.raises(PaymentRefusedError) as err:
        client.tools.call(TOOL, {})
    assert err.value.code == "G7_PER_DAY"


def test_needs_a_signer_and_uses_the_default_lane_file_without_channels() -> None:
    s = Server()
    assert isinstance(s.client(channels=False).paid_calls.renew_channel_debts(), list)
    with pytest.raises(ConfigError):
        s.fake.client(with_signer=False, channels=MemoryChannelStore()).paid_calls.renew_channel_debts()


def test_rate_limit_ends_the_debt() -> None:
    def post(_seen: Seen) -> Answer:
        return Answer(
            {
                "success": False,
                "error": {"code": "PAYMENT_UNSETTLED_LIMIT", "message": "x", "context": {"retryAfter": 50}},
            },
            429,
        )

    s = Server(post=post)
    client = s.client()
    three_calls(client)
    [r] = client.paid_calls.renew_channel_debts()
    assert (r.status, r.retry_after) == ("rate_limited", 50.0)
    assert len(s.posts()) == 1


def test_at_most_eight_requests_per_run_one_per_debt() -> None:
    s = Server(debts=lambda _lane: [debt(ID(i + 1), LID(i + 1)) for i in range(12)], post=refused("CHANNEL_DESYNC"))
    client = s.client(channels=store_with(*[lane_record(i + 1) for i in range(12)]))
    out = client.paid_calls.renew_channel_debts()
    assert len(s.posts()) == 8
    assert len(out) == 12
    assert sorted(r.status for r in out) == ["rate_limited"] * 4 + ["refused"] * 8


def test_manual_runs_are_throttled_like_the_automatic_one() -> None:
    s = Server(post=refused("PAYMENT_VOUCHER_ADMISSION_PAUSED", 503))
    client = s.client()
    three_calls(client)
    [r] = client.paid_calls.renew_channel_debts()
    assert (r.status, r.code) == ("refused", "PAYMENT_VOUCHER_ADMISSION_PAUSED")
    signed = s.fake.signer.calls
    assert [r.status for r in client.paid_calls.renew_channel_debts()] == ["rate_limited"]
    assert s.fake.signer.calls == signed
    assert len(s.posts()) == 1


def test_refused_paid_call_renews_once_and_says_so() -> None:
    s = Server()
    client = s.client()
    three_calls(client)
    s.owes = True
    sent = len(s.fake.calls())
    with pytest.raises(PaymentError) as err:
        client.tools.call(TOOL, {})
    assert err.value.code == "PAYMENT_DEBT_OUTSTANDING"
    assert err.value.retryable is True
    assert err.value.message == CHANNEL_DEBT_RENEWED_TEXT
    assert [r.status for r in err.value.details["renewals"]] == ["renewed"]  # type: ignore[index]
    assert len(s.fake.calls()) == sent + 1
    assert len(s.posts()) == 1
    # Within the minute the next refusal only lists, and still says it is being collected (REPLACING,
    # or still listed OPEN right after the renew).
    for state in ("REPLACING", "OPEN"):
        s.debts = lambda lane, st=state: [debt(ID(1), lane, state=st)]
        with pytest.raises(PaymentError) as again:
            client.tools.call(TOOL, {})
        assert (again.value.retryable, again.value.message) == (True, CHANNEL_DEBT_RENEWED_TEXT)
    assert len(s.posts()) == 1
    assert len(s.lists()) == 4  # the run (a list, the list again after the renew), then two list-only runs


def test_a_debt_a_person_settled_in_the_portal_gets_the_neutral_collecting_text() -> None:
    # A per-call REPLACING debt (also a channel debt moved to a per-call replacement in the portal):
    # the agent did not sign it, so the text does not say it did.
    s = Server()
    client = s.client()
    three_calls(client)
    s.owes = True
    s.debts = lambda _lane: [debt(ID(1), state="REPLACING", voucherFormat="PER_CALL", channel=None)]
    with pytest.raises(PaymentError) as err:
        client.tools.call(TOOL, {})
    assert (err.value.retryable, err.value.message) == (True, DEBT_COLLECTING_TEXT)
    assert "already signed" not in DEBT_COLLECTING_TEXT
    assert s.posts() == []


def test_collecting_text_is_neutral_when_any_pending_debt_is_per_call() -> None:
    renewed = DebtRenewal(ID(1), "renewed", channel_id=LID(1), cumulative="100", calls=1)
    by_person = DebtRenewal(ID(2), "pending", format="PER_CALL")
    assert channel_debt_answer([renewed], WEB) == (CHANNEL_DEBT_RENEWED_TEXT, True)
    assert channel_debt_answer([renewed, by_person], WEB) == (DEBT_COLLECTING_TEXT, True)
    assert channel_debt_answer([by_person], WEB) == (DEBT_COLLECTING_TEXT, True)


def test_a_channel_debt_it_cannot_renew_gets_the_portal_text() -> None:
    s = Server(debts=lambda _lane: [debt(ID(1), LID(7))])
    client = s.client()
    three_calls(client)
    s.owes = True
    for _ in range(2):  # the second within the minute (list only): the same text
        with pytest.raises(PaymentError) as err:
            client.tools.call(TOOL, {})
        assert (err.value.retryable, err.value.message) == (False, channel_debt_no_record_text(WEB))
    assert s.posts() == []


def test_only_channel_debts_not_renewed_now_are_retryable_never_the_funding_text() -> None:
    s = Server(post=refused("PAYMENT_VOUCHER_ESCROW_LIMIT_EXCEEDED"))
    client = s.client()
    three_calls(client)
    s.owes = True
    for _ in range(2):
        with pytest.raises(PaymentError) as err:
            client.tools.call(TOOL, {})
        assert (err.value.retryable, err.value.message) == (True, CHANNEL_DEBT_RETRY_TEXT)
    assert len(s.posts()) == 1


def test_r7c_a_renew_refused_for_good_gets_the_portal_text_never_call_again() -> None:
    s = Server(post=refused("CHANNEL_DESYNC"))
    client = s.client()
    three_calls(client)
    s.owes = True
    for _ in range(2):  # the second within the minute (list only): the same text
        with pytest.raises(PaymentError) as err:
            client.tools.call(TOOL, {})
        assert (err.value.retryable, err.value.message) == (False, channel_debt_no_record_text(WEB))
    assert len(s.posts()) == 1


OTHER_CAIP = "eip155:31337:0x976EA74026E726554dB657fA54763abd0C3a0aa9"


def test_r6_another_wallets_debt_is_marked_any_case_is_the_same_wallet() -> None:
    account = "eip155:" + PAYER_CAIP.split(":", 1)[1].upper().replace("0X", "0x")
    out = parse_debt_list({"account": account, "debts": [debt(ID(1)), debt(ID(2), payer=OTHER_CAIP)]})
    assert [d.get("otherWallet") for d in out] == [None, True]
    # Without a readable account nothing is marked (the old answer).
    assert "otherWallet" not in parse_debt_list({"debts": [debt(ID(2), payer=OTHER_CAIP)]})[0]


def test_r6_another_wallets_channel_debt_gets_its_own_text_nothing_signed() -> None:
    s = Server(debts=lambda lane: [debt(ID(1), lane, payer=OTHER_CAIP)])
    client = s.client()
    three_calls(client)
    s.owes = True
    for _ in range(2):
        with pytest.raises(PaymentError) as err:
            client.tools.call(TOOL, {})
        assert (err.value.retryable, err.value.message) == (False, OTHER_WALLET_DEBT_TEXT)
        assert [r.status for r in err.value.details["renewals"]] == ["other_wallet"]  # type: ignore[index]
    assert s.posts() == []


def test_r6_answer_is_per_payer_and_permanent_codes_go_to_the_portal() -> None:
    mine = DebtRenewal(ID(1), "not_signed_here")
    other = DebtRenewal(ID(2), "other_wallet")
    retry = DebtRenewal(ID(3), "rate_limited")
    renewed = DebtRenewal(ID(4), "renewed")
    assert channel_debt_answer([mine, other], WEB) == (channel_debt_no_record_text(WEB), False)
    assert channel_debt_answer([renewed, other], WEB) == (OTHER_WALLET_DEBT_TEXT, False)
    assert channel_debt_answer([retry, other], WEB) == (OTHER_WALLET_DEBT_TEXT, False)
    assert "no longer has" not in OTHER_WALLET_DEBT_TEXT
    later = DebtRenewal(ID(5), "refused", code="PAYMENT_DEBT_NOT_YET_REPLACEABLE")
    assert channel_debt_answer([later], WEB) == (CHANNEL_DEBT_RETRY_TEXT, True)
    for_good = DebtRenewal(ID(5), "refused", code="PAYMENT_VOUCHER_SIGNATURE_INVALID")
    assert channel_debt_answer([for_good], WEB) == (channel_debt_no_record_text(WEB), False)


def test_per_call_debts_keep_their_behaviour() -> None:
    s = Server(debts=lambda _lane: [debt(ID(1), voucherFormat="PER_CALL", channel=None)])
    client = s.client()
    client.tools.call(TOOL, {})
    s.owes = True
    before = s.fake.signer.calls
    with pytest.raises(PaymentError) as err:
        client.tools.call(TOOL, {})
    assert (err.value.retryable, err.value.message) == (False, "This payer owes for 1 served call(s)")
    assert s.fake.signer.calls == before
    assert s.posts() == []
    assert all_debts_collecting([]) is False


def test_without_channels_a_fresh_default_lane_file_signs_nothing_for_a_debt() -> None:
    s = Server()
    client = s.client(channels=False)
    s.owes = True
    with pytest.raises(PaymentError):
        client.tools.call(TOOL, {})
    assert s.posts() == []


def test_async_client_renews_too() -> None:
    s = Server()

    async def run() -> Any:
        client = s.fake.async_client(networks=CHANNEL_NETWORKS, channels=MemoryChannelStore())
        for _ in range(3):
            await client.tools.call(TOOL, {})
        direct = await client.paid_calls.renew_channel_debts()
        s.owes = True
        with pytest.raises(PaymentError) as err:
            await client.tools.call(TOOL, {})
        return direct, err.value

    direct, err = asyncio.run(run())
    assert [r.status for r in direct] == ["renewed"]
    # Within the minute: listed only; the debt renewed a moment ago is being collected.
    assert err.message == CHANNEL_DEBT_RENEWED_TEXT
    assert len(s.posts()) == 1


def test_the_lane_record_keeps_the_renewable_pairs() -> None:
    store = MemoryChannelStore()
    s = Server()
    three_calls(s.fake.client(networks=CHANNEL_NETWORKS, channels=store))
    lane = parse_book(copy.deepcopy(store.load()))["lanes"][0]
    assert lane["renewable"] == [["100000", 1], ["200000", 2], ["300000", 3]]
