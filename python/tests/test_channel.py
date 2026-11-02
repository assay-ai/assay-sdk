"""Channel vouchers: the shared vectors (``vectors/eip155/channel.json``) and the client's lane handling."""

from __future__ import annotations

import asyncio
import copy
import json
import os
from pathlib import Path
from typing import Any

import pytest
from eth_utils.crypto import keccak

from goassay import FileChannelStore, MemoryChannelStore, PaymentUnsettledLimitError
from goassay._channel import (
    advance_lane,
    build_channel_voucher,
    channel_key,
    check_channel_offer,
    empty_book,
    finish_lane,
    lane_covers_chain,
    lane_outcome_of,
    parse_book,
    pick_lane,
    prune_book,
    record_check,
    unpack_channel_state,
)
from goassay._errors import SignerRefusal
from goassay.channels import take_lock
from goassay.errors import AssayError, PaymentError, PaymentRefusedError

from .fake import (
    BASE,
    NETWORKS,
    NOW,
    TOOL,
    Answer,
    Fake,
    Seen,
    get_tool_answer,
    load,
    meta_of,
    payment_required,
    tool_result,
)
from .test_vectors import as_vector, sign

V = load("channel.json")


def apply(source: Any, changes: list[dict[str, Any]]) -> Any:
    out = copy.deepcopy(source)
    for ch in changes:
        if not ch["path"]:
            out = copy.deepcopy(ch.get("value"))
            continue
        node = out
        for k in ch["path"][:-1]:
            node = node[k]
        if ch["op"] == "delete":
            del node[ch["path"][-1]]
        else:
            node[ch["path"][-1]] = copy.deepcopy(ch["value"])
    return out


# ---- vectors ---------------------------------------------------------------------------------


def test_type_hash() -> None:
    assert "0x" + keccak(text=V["typeString"]).hex() == V["typeHash"]


@pytest.mark.parametrize("case", V["cases"], ids=lambda c: c["name"])
def test_channel_voucher_vector(case: dict[str, Any]) -> None:
    net = case["network"]
    lane = {
        "network": net["id"],
        "escrow": net["escrow"],
        "payer": case["lane"]["payer"],
        "provider": case["lane"]["provider"],
    }
    s = case["step"]
    built = build_channel_voucher(
        lane, case["lane"]["channelId"], int(s["cumulative"]), s["calls"], s["issuedAt"], s["expiresAt"], net
    )
    assert built.wire == case["wire"]
    assert as_vector(built.typed_data) == case["typedData"]
    out = sign(built.typed_data, V["testKey"]["privateKey"])
    for key in ("domainSeparator", "structHash", "digest", "signature"):
        assert out[key] == case[key], key
    assert out["recovered"] == case["lane"]["signer"]
    lane_in = case["lane"]
    assert channel_key(lane_in["payer"], lane_in["signer"], lane_in["provider"], lane_in["channelId"]) == case["key"]
    settled, calls = unpack_channel_state(int(case["slot"], 16))
    assert {"settled": str(settled), "calls": calls} == case["slotDecoded"]


def test_refuses_values_the_contract_would_revert_on() -> None:
    c = V["cases"][0]
    net, s, cid = c["network"], c["step"], c["lane"]["channelId"]
    lane = {
        "network": net["id"],
        "escrow": net["escrow"],
        "payer": c["lane"]["payer"],
        "provider": c["lane"]["provider"],
    }
    ok = (int(s["cumulative"]), s["calls"], s["issuedAt"], s["expiresAt"])
    bad = [
        (0, ok[1], ok[2], ok[3]),
        (2**56, ok[1], ok[2], ok[3]),
        (ok[0], 0, ok[2], ok[3]),
        (ok[0], 2**24, ok[2], ok[3]),
        (ok[0], ok[1], ok[2], ok[2]),
        (ok[0], ok[1], ok[2], ok[2] + 301),
    ]
    for b in bad:
        with pytest.raises(SignerRefusal):
            build_channel_voucher(lane, cid, *b, net)
    with pytest.raises(SignerRefusal):
        build_channel_voucher(lane, "0x" + cid[2:].upper(), *ok, net)
    with pytest.raises(SignerRefusal):
        build_channel_voucher({**lane, "escrow": V["cases"][1]["network"]["escrow"]}, cid, *ok, net)


def test_lane_script() -> None:
    lanes = V["lanes"]
    pool = lanes["pool"]
    ids = list(lanes["channelIds"])
    book = empty_book()
    for i, s in enumerate(lanes["steps"]):
        where = f"step {i} ({s['op']})"
        if s["op"] == "take":
            pick = pick_lane(
                book,
                pool,
                int(s["price"]),
                max_lanes=lanes["maxLanes"],
                rotate_at=int(lanes["rotateAt"]),
                now=s["now"],
                new_channel_id=lambda: ids.pop(0),
            )
            book = pick.book
            e = s["expect"]
            if "none" in e:
                assert pick.lane is None, where
                continue
            assert pick.lane is not None, where
            assert pick.lane["channelId"] == e["channelId"], where
            assert pick.needs_check == e["needsCheck"], where
            if pick.needs_check:
                continue
            step = advance_lane(
                book, pick.lane["channelId"], int(s["price"]), s["issuedAt"], lanes["lifetimeSeconds"], s["now"]
            )
            book = step.book
            got = {
                "channelId": step.channel_id,
                "cumulative": str(step.cumulative),
                "calls": step.calls,
                "increase": str(step.increase),
                "issuedAt": step.issued_at,
                "expiresAt": step.expires_at,
                "needsCheck": False,
            }
            assert got == e, where
        elif s["op"] == "finish":
            book = finish_lane(book, s["channelId"], s["outcome"])
        elif s["op"] == "check":
            lane = next(x for x in book["lanes"] if x["channelId"] == s["channelId"])
            covered = lane_covers_chain(lane, int(s["chain"]["settled"]), s["chain"]["calls"])
            assert covered == s["expect"]["covered"], where
            book = record_check(book, s["channelId"], covered, s["now"])
        elif s["op"] == "state":
            lane = next(x for x in prune_book(book, s["now"])["lanes"] if x["channelId"] == s["expect"]["channelId"])
            assert lane["retired"] == s["expect"]["retired"], where
            assert lane["inFlightSince"] == s["expect"]["inFlightSince"], where
        else:
            raise AssertionError(f"unknown op {s['op']}")
        assert parse_book(json.loads(json.dumps(book))) == book, where


def test_damaged_record_is_refused_never_reset() -> None:
    for raw in ({"version": 2, "lanes": []}, {"version": 1, "lanes": [{"channelId": "0x00"}]}, [1]):
        with pytest.raises(Exception, match="channel record"):
            parse_book(raw)
    assert parse_book(None) == empty_book()


def test_outcomes() -> None:
    assert lane_outcome_of(None) == "served"
    for c in ("PAYMENT_UNSETTLED_LIMIT", "CHANNEL_LIMIT", "CHANNEL_SIGNER_EXPIRING", "CHANNEL_NOT_OFFERED"):
        assert lane_outcome_of(c) == "reuse"
    for c in ("CHANNEL_ROTATE", "CHANNEL_DESYNC", "PAYMENT_VOUCHER_EXPIRED", "SOMETHING_NEW"):
        assert lane_outcome_of(c) == "retire"


def test_outcomes_spend_policy_refusals_keyed_on_code_and_reason() -> None:
    vel = "MCP_VELOCITY_LIMIT_EXCEEDED"
    for r in ("DUPLICATE_REQUEST", "CALLS_PER_MINUTE", "CALLS_PER_HOUR", "SPEND_PER_HOUR"):
        assert lane_outcome_of(vel, r) == "reuse"
    for c in ("MCP_SPEND_LIMIT_EXCEEDED", "MCP_POLICY_AGENT_PAUSED", "MCP_APPROVAL_REQUIRED"):
        assert lane_outcome_of(c) == "reuse"
        assert lane_outcome_of(c, "anything") == "reuse"
    # The spend lock may fail after the voucher was stored: never re-armed.
    assert lane_outcome_of(vel, "UNAVAILABLE") == "retire"
    for bad in (None, "", "SOMETHING_NEW", "duplicate_request", 5):
        assert lane_outcome_of(vel, bad) == "retire"
    # A reason never turns another code into a re-arm.
    assert lane_outcome_of("CHANNEL_ROTATE", "DUPLICATE_REQUEST") == "retire"
    # A re-armed refusal drops the refused top pair from the renewable pairs, as any refusal does.
    for code, reason in ((vel, "DUPLICATE_REQUEST"), ("MCP_SPEND_LIMIT_EXCEEDED", None)):
        lane = {
            "channelId": "0x" + format(1, "064x"),
            **V["lanes"]["pool"],
            "maxSigned": "200000",
            "callsSigned": 2,
            "topIncrease": "100000",
            "lastIssuedAt": 1000,
            "lastExpiresAt": 1240,
            "reuseTop": False,
            "inFlightSince": 1000,
            "retired": False,
            "checkedAt": None,
            "renewable": [["100000", 1], ["200000", 2]],
        }
        outcome = lane_outcome_of(code, reason)
        done = finish_lane({"version": 1, "lanes": [lane]}, lane["channelId"], outcome)["lanes"][0]
        assert done["reuseTop"] is True
        assert done["retired"] is False
        assert [list(p) for p in done["renewable"]] == [["100000", 1]]


def test_offer_valid() -> None:
    o = V["offers"]
    r = check_channel_offer(o["offer"], o["requirement"], o["network"])
    assert not isinstance(r, str)
    assert (r.price, r.lifetime_seconds, r.max_lanes) == (
        int(o["valid"]["price"]),
        o["valid"]["lifetimeSeconds"],
        o["valid"]["maxLanes"],
    )


@pytest.mark.parametrize("case", V["offers"]["invalid"], ids=lambda c: c["name"])
def test_offer_invalid(case: dict[str, Any]) -> None:
    o = V["offers"]
    assert isinstance(check_channel_offer(apply(o["offer"], case["changes"]), o["requirement"], o["network"]), str)


# ---- the client ------------------------------------------------------------------------------

NET = BASE["network"]
ESCROW = NET["escrow"].split(":")[2]
CHANNEL_NETWORKS = {NET["id"]: {**NETWORKS[NET["id"]], "channels": True}}
CHANNEL_BOOKS = keccak(text="channelBooks(bytes32,address)")[:4].hex()


def offer() -> dict[str, Any]:
    r = BASE["requirement"]
    return {
        "scheme": "channel-v1",
        "network": r["network"],
        "payer": r["payer"],
        "provider": r["provider"],
        "providerId": r["providerId"],
        "price": dict(r["amount"]),
        "contractVersion": 3,
        "domain": {"name": "Assay Settlement", "version": "2", "chainId": 31337, "verifyingContract": ESCROW},
        "primaryType": "ChannelVoucher",
        "minLifeSeconds": 60,
        "maxLifeSeconds": 300,
        "maxOpenChannels": 16,
        "signers": ["payer", "delegate"],
        "delegate": r["delegate"],
    }


def refusal(code: str, **extra: Any) -> dict[str, Any]:
    return tool_result({"assay/error": {"code": code, "message": code, "retryable": True, **extra}}, isError=True)


def channel_tool(answer: Any = None, make_offer: Any = None) -> Any:
    n = {"i": 0}

    def handler(params: dict[str, Any], _seen: Seen) -> Any:
        if params["name"] == "get_tool":
            return get_tool_answer()
        meta = params["_meta"]
        if "assay/channelVoucher" in meta:
            i = n["i"]
            n["i"] += 1
            out = answer(meta["assay/channelVoucher"], i) if answer else None
            return out if out is not None else tool_result({"assay/receipt": {"intentId": f"i{i}"}})
        if "assay/voucher" in meta:
            return tool_result({"assay/receipt": {"intentId": "per-call"}})
        r = payment_required()
        if isinstance(meta.get("assay/paymentSchemes"), list):
            r["_meta"]["assay/channelRequired"] = make_offer() if make_offer else offer()
        return r

    return handler


def chain_with(state: Any) -> Any:
    def rpc(seen: Seen) -> Answer | None:
        body = seen.body
        if body["method"] != "eth_call" or not body["params"][0]["data"].startswith("0x" + CHANNEL_BOOKS):
            return None
        key = "0x" + body["params"][0]["data"][10:74]
        words = "".join(format(w, "x").rjust(64, "0") for w in (state(key), 0, 0, 0))
        return Answer({"jsonrpc": "2.0", "id": body["id"], "result": "0x" + words})

    return rpc


def sent(fake: Fake) -> list[dict[str, Any]]:
    return [meta_of(s)["assay/channelVoucher"] for s in fake.calls() if "assay/channelVoucher" in meta_of(s)]


def pairs(fake: Fake) -> list[tuple[str, int]]:
    return [(e["voucher"]["cumulative"], e["voucher"]["calls"]) for e in sent(fake)]


def channel_client(fake: Fake, store: Any = None, **kw: Any) -> Any:
    return fake.client(networks=CHANNEL_NETWORKS, channels=store or MemoryChannelStore(), **kw)


def test_offers_channel_v1_only_with_a_store_and_a_capable_network() -> None:
    plain = Fake(mcp=channel_tool())
    plain.client().tools.call(TOOL, {})
    assert all("assay/paymentSchemes" not in meta_of(s) for s in plain.calls())
    assert sent(plain) == []

    not_capable = Fake(mcp=channel_tool())
    not_capable.client(channels=MemoryChannelStore()).tools.call(TOOL, {})
    assert all("assay/paymentSchemes" not in meta_of(s) for s in not_capable.calls())

    on = Fake(mcp=channel_tool())
    channel_client(on).tools.call(TOOL, {})
    assert meta_of(on.calls()[0])["assay/paymentSchemes"] == ["channel-v1", "voucher"]
    assert len(sent(on)) == 1


def test_signs_from_its_own_record_and_shows_the_increase() -> None:
    details: list[dict[str, Any]] = []
    fake = Fake(mcp=channel_tool())
    client = channel_client(fake, on_payment=lambda d: details.append(d))
    client.tools.call(TOOL, {})
    client.tools.call(TOOL, {})
    assert pairs(fake) == [("100000", 1), ("200000", 2)]
    a, b = sent(fake)
    assert a["voucher"]["channelId"] == b["voucher"]["channelId"]
    assert fake.signer.calls == 2
    assert details[1]["amount"] == BASE["requirement"]["amount"]
    assert details[1]["channel"]["cumulative"] == "200000"
    assert details[1]["channel"]["increase"] == "100000"
    # The signature is the test key's over the contract's typed data.
    v = b["voucher"]
    lane = {"network": NET["id"], "escrow": ESCROW, "payer": v["payer"], "provider": v["provider"]}
    net = {"id": NET["id"], "chainId": 31337, "escrow": ESCROW, "asset": NET["asset"], "decimals": 6}
    built = build_channel_voucher(
        lane, v["channelId"], int(v["cumulative"]), v["calls"], v["issuedAt"], v["expiresAt"], net
    )
    assert sign(built.typed_data, V["testKey"]["privateKey"])["signature"] == b["signature"]


def test_ignores_a_server_named_cumulative() -> None:
    fake = Fake(mcp=channel_tool(make_offer=lambda: {**offer(), "cumulative": "4000000", "calls": 40}))
    channel_client(fake).tools.call(TOOL, {})
    assert pairs(fake) == [("100000", 1)]


def test_offer_for_another_escrow_is_paid_per_call() -> None:
    other = {**offer()["domain"], "verifyingContract": "0x1111111111111111111111111111111111111111"}
    fake = Fake(mcp=channel_tool(make_offer=lambda: {**offer(), "domain": other}))
    r = channel_client(fake).tools.call(TOOL, {})
    assert sent(fake) == []
    assert r.receipt == {"intentId": "per-call"}


def test_daily_limit_counts_increases_only() -> None:
    first = {"done": False}

    def answer(_e: Any, _i: int) -> Any:
        if first["done"]:
            return None
        first["done"] = True
        return refusal("PAYMENT_UNSETTLED_LIMIT", retryAfter=600)

    fake = Fake(mcp=channel_tool(answer))
    client = channel_client(fake, limits={"max_per_call": "0.10", "max_per_day": "0.25"})
    with pytest.raises(PaymentUnsettledLimitError):
        client.tools.call(TOOL, {})
    client.tools.call(TOOL, {})
    client.tools.call(TOOL, {})
    assert pairs(fake) == [("100000", 1), ("100000", 1), ("200000", 2)]
    with pytest.raises(PaymentRefusedError) as err:
        client.tools.call(TOOL, {})
    assert err.value.code == "G7_PER_DAY"


def test_unsettled_limit_long_wait_is_raised_short_wait_resent_as_is() -> None:
    long = Fake(mcp=channel_tool(lambda _e, _i: refusal("PAYMENT_UNSETTLED_LIMIT", retryAfter=900)))
    with pytest.raises(PaymentUnsettledLimitError) as err:
        channel_client(long).tools.call(TOOL, {})
    assert err.value.retry_after == 900
    assert err.value.retryable is True
    assert len(sent(long)) == 1

    short = Fake(mcp=channel_tool(lambda _e, i: refusal("PAYMENT_UNSETTLED_LIMIT", retryAfter=5) if i == 0 else None))
    channel_client(short).tools.call(TOOL, {})
    a, b = sent(short)
    assert a == b
    assert 5 in short.sleeps


def test_rotate_is_one_voucher_and_a_retryable_error_then_a_new_lane() -> None:
    fake = Fake(mcp=channel_tool(lambda _e, i: refusal("CHANNEL_ROTATE") if i == 1 else None))
    client = channel_client(fake)
    client.tools.call(TOOL, {})
    with pytest.raises(PaymentError) as err:
        client.tools.call(TOOL, {})
    assert (err.value.code, err.value.retryable) == ("CHANNEL_ROTATE", True)
    assert fake.signer.calls == 2
    client.tools.call(TOOL, {})
    assert pairs(fake) == [("100000", 1), ("200000", 2), ("100000", 1)]
    s = sent(fake)
    assert s[2]["voucher"]["channelId"] != s[0]["voucher"]["channelId"]
    assert not any("assay/voucher" in meta_of(x) for x in fake.calls())


def test_five_rotations_in_an_hour_pause_channels() -> None:
    fake = Fake(mcp=channel_tool(lambda _e, _i: refusal("CHANNEL_ROTATE")))
    client = channel_client(fake)
    for _ in range(5):
        with pytest.raises(PaymentError):
            client.tools.call(TOOL, {})
    assert client.tools.call(TOOL, {}).receipt == {"intentId": "per-call"}
    assert "assay/paymentSchemes" not in meta_of(fake.calls()[-1])
    assert len(sent(fake)) == 5


def test_channel_limit_is_retryable_pauses_and_rearms_the_lane() -> None:
    clock = {"t": NOW}
    fake = Fake(
        mcp=channel_tool(lambda _e, i: refusal("CHANNEL_LIMIT", retryAfter=60) if i == 0 else None),
        rpc=chain_with(lambda _k: 0),
    )
    client = channel_client(fake, now=lambda: clock["t"])
    with pytest.raises(PaymentError) as err:
        client.tools.call(TOOL, {})
    assert (err.value.code, err.value.retryable) == ("CHANNEL_LIMIT", True)
    assert fake.signer.calls == 1
    # Paused: the next call offers no channel and is paid per call.
    assert client.tools.call(TOOL, {}).receipt == {"intentId": "per-call"}
    assert "assay/paymentSchemes" not in meta_of(fake.calls()[-1])
    clock["t"] = NOW + 3601
    client.tools.call(TOOL, {})
    assert pairs(fake) == [("100000", 1), ("100000", 1)]
    s = sent(fake)
    assert s[0]["voucher"]["channelId"] == s[1]["voucher"]["channelId"]


def test_stale_rearmed_pair_is_not_resigned_for_free() -> None:
    clock = {"t": NOW}
    fake = Fake(
        mcp=channel_tool(lambda _e, i: refusal("PAYMENT_UNSETTLED_LIMIT", retryAfter=900) if i == 0 else None),
        rpc=chain_with(lambda _k: 0),
    )
    client = channel_client(fake, now=lambda: clock["t"])
    with pytest.raises(PaymentUnsettledLimitError):
        client.tools.call(TOOL, {})
    clock["t"] = NOW + 240 + 7201
    client.tools.call(TOOL, {})
    s = sent(fake)
    assert s[1]["voucher"]["channelId"] != s[0]["voucher"]["channelId"]
    assert (s[1]["voucher"]["cumulative"], s[1]["voucher"]["calls"]) == ("100000", 1)


def test_retired_lanes_are_capped_per_pool() -> None:
    pool = V["lanes"]["pool"]
    now = 1_000_000

    def lane(n: int, last_expires: int) -> dict[str, Any]:
        return {
            "channelId": "0x" + format(n, "064x"),
            **pool,
            "maxSigned": "1",
            "callsSigned": 1,
            "topIncrease": "1",
            "lastIssuedAt": last_expires - 240,
            "lastExpiresAt": last_expires,
            "reuseTop": False,
            "inFlightSince": None,
            "retired": True,
            "checkedAt": None,
        }

    lanes = [lane(i + 1, now - 1000 + i) for i in range(20)] + [lane(21, now + 100), lane(22, now + 200)]
    kept = [int(x["channelId"], 16) for x in prune_book({"version": 1, "lanes": lanes}, now)["lanes"]]
    assert kept == [*range(7, 21), 21, 22]


def test_other_refusal_retires_the_lane() -> None:
    fake = Fake(mcp=channel_tool(lambda _e, i: refusal("CHANNEL_DESYNC", retryable=False) if i == 0 else None))
    client = channel_client(fake)
    with pytest.raises(AssayError) as err:
        client.tools.call(TOOL, {})
    assert err.value.code == "CHANNEL_DESYNC"
    client.tools.call(TOOL, {})
    s = sent(fake)
    assert pairs(fake)[1] == ("100000", 1)
    assert s[1]["voucher"]["channelId"] != s[0]["voucher"]["channelId"]


def test_duplicate_request_rearms_the_lane_and_the_retry_signs_the_same_pair() -> None:
    def answer(_e: Any, i: int) -> Any:
        if i == 1:
            return refusal("MCP_VELOCITY_LIMIT_EXCEEDED", reason="DUPLICATE_REQUEST", retryAfter=19)
        return None

    fake = Fake(mcp=channel_tool(answer))
    client = channel_client(fake)
    client.tools.call(TOOL, {})
    with pytest.raises(AssayError) as err:
        client.tools.call(TOOL, {})
    assert err.value.code == "MCP_VELOCITY_LIMIT_EXCEEDED"
    client.tools.call(TOOL, {})
    s = sent(fake)
    assert pairs(fake) == [("100000", 1), ("200000", 2), ("200000", 2)]
    assert {e["voucher"]["channelId"] for e in s} == {s[0]["voucher"]["channelId"]}


def test_velocity_unavailable_retires_the_lane() -> None:
    def answer(_e: Any, i: int) -> Any:
        if i == 0:
            return refusal("MCP_VELOCITY_LIMIT_EXCEEDED", reason="UNAVAILABLE", retryAfter=1)
        return None

    fake = Fake(mcp=channel_tool(answer))
    client = channel_client(fake)
    with pytest.raises(AssayError) as err:
        client.tools.call(TOOL, {})
    assert err.value.code == "MCP_VELOCITY_LIMIT_EXCEEDED"
    client.tools.call(TOOL, {})
    s = sent(fake)
    assert pairs(fake)[1] == ("100000", 1)
    assert s[1]["voucher"]["channelId"] != s[0]["voucher"]["channelId"]


def test_refused_on_payment_retires_the_advanced_lane() -> None:
    state = {"refuse": True}

    def hook(_d: Any) -> bool:
        if state["refuse"]:
            state["refuse"] = False
            return False
        return True

    fake = Fake(mcp=channel_tool())
    client = channel_client(fake, on_payment=hook)
    with pytest.raises(PaymentRefusedError):
        client.tools.call(TOOL, {})
    client.tools.call(TOOL, {})
    assert pairs(fake) == [("100000", 1)]


def test_async_client_channel_call() -> None:
    fake = Fake(mcp=channel_tool())

    async def run() -> None:
        client = fake.async_client(networks=CHANNEL_NETWORKS, channels=MemoryChannelStore())
        await client.tools.call(TOOL, {})
        await client.tools.call(TOOL, {})

    asyncio.run(run())
    assert pairs(fake) == [("100000", 1), ("200000", 2)]


# ---- persistence ------------------------------------------------------------------------------


def test_restart_continues_the_lane_after_the_chain_confirms(tmp_path: Path) -> None:
    path = tmp_path / "lanes.json"
    settled: dict[str, int] = {}
    first = Fake(mcp=channel_tool(), rpc=chain_with(lambda k: settled.get(k, 0)))
    c1 = channel_client(first, FileChannelStore(path))
    c1.tools.call(TOOL, {})
    c1.tools.call(TOOL, {})
    book = parse_book(json.loads(path.read_text()))
    assert len(book["lanes"]) == 1
    lane = book["lanes"][0]
    assert (lane["maxSigned"], lane["callsSigned"], lane["inFlightSince"]) == ("200000", 2, None)
    if os.name != "nt":
        assert path.stat().st_mode & 0o777 == 0o600

    key = channel_key(lane["payer"], lane["signer"], lane["provider"], lane["channelId"])
    settled[key] = 100000 | (1 << 56)
    second = Fake(mcp=channel_tool(), rpc=chain_with(lambda k: settled.get(k, 0)))
    channel_client(second, FileChannelStore(path), now=lambda: NOW + 30).tools.call(TOOL, {})
    v = sent(second)[0]["voucher"]
    assert (v["channelId"], v["cumulative"], v["calls"]) == (lane["channelId"], "300000", 3)
    reads = [s for s in second.seen if s.url.startswith("https://rpc") and CHANNEL_BOOKS in json.dumps(s.body)]
    assert reads and key[2:] in json.dumps(reads[0].body)


def test_a_record_the_chain_shows_more_than_is_retired(tmp_path: Path) -> None:
    path = tmp_path / "lanes.json"
    first = Fake(mcp=channel_tool())
    channel_client(first, FileChannelStore(path)).tools.call(TOOL, {})
    old = parse_book(json.loads(path.read_text()))["lanes"][0]
    second = Fake(mcp=channel_tool(), rpc=chain_with(lambda _k: 500000 | (5 << 56)))
    channel_client(second, FileChannelStore(path)).tools.call(TOOL, {})
    v = sent(second)[0]["voucher"]
    assert v["channelId"] != old["channelId"]
    assert (v["cumulative"], v["calls"]) == ("100000", 1)
    after = parse_book(json.loads(path.read_text()))
    assert next(x for x in after["lanes"] if x["channelId"] == old["channelId"])["retired"] is True


def test_no_agreed_chain_read_pays_per_call_and_leaves_the_lane(tmp_path: Path) -> None:
    path = tmp_path / "lanes.json"
    channel_client(Fake(mcp=channel_tool()), FileChannelStore(path)).tools.call(TOOL, {})

    def failing(seen: Seen) -> Answer | None:
        return Answer({}, 500) if CHANNEL_BOOKS in json.dumps(seen.body) else None

    second = Fake(mcp=channel_tool(), rpc=failing)
    r = channel_client(second, FileChannelStore(path)).tools.call(TOOL, {})
    assert r.receipt == {"intentId": "per-call"}
    lane = parse_book(json.loads(path.read_text()))["lanes"][0]
    assert (lane["retired"], lane["maxSigned"]) == (False, "100000")


def test_damaged_file_stops_channel_signing_only(tmp_path: Path) -> None:
    path = tmp_path / "lanes.json"
    path.write_text('{"version":1,"lanes":[{"channelId":"0xzz"}]}')
    fake = Fake(mcp=channel_tool())
    r = channel_client(fake, FileChannelStore(path)).tools.call(TOOL, {})
    assert r.receipt == {"intentId": "per-call"}
    assert sent(fake) == []
    assert "0xzz" in path.read_text()


def test_two_clients_on_one_file_never_sign_conflicting_totals(tmp_path: Path) -> None:
    path = tmp_path / "lanes.json"
    # The chain shows nothing settled: a lane the other client opened is checked and then continued
    # (without an answer for channelBooks that check would fail and the call would be paid per call).
    fa = Fake(mcp=channel_tool(), rpc=chain_with(lambda _key: 0))
    fb = Fake(mcp=channel_tool(), rpc=chain_with(lambda _key: 0))
    ca, cb = channel_client(fa, FileChannelStore(path)), channel_client(fb, FileChannelStore(path))
    import concurrent.futures

    with concurrent.futures.ThreadPoolExecutor(8) as pool:
        list(pool.map(lambda c: c.tools.call(TOOL, {}), [ca, cb] * 4))
    every = sent(fa) + sent(fb)
    assert len(every) == 8
    assert len({(e["voucher"]["channelId"], e["voucher"]["cumulative"]) for e in every}) == 8
    for lane in parse_book(json.loads(path.read_text()))["lanes"]:
        mine = sorted(e["voucher"]["calls"] for e in every if e["voucher"]["channelId"] == lane["channelId"])
        assert mine == list(range(1, lane["callsSigned"] + 1))


@pytest.mark.skipif(os.name == "nt", reason="pid liveness is POSIX only")
def test_two_spellings_of_one_file_share_one_lock(tmp_path: Path) -> None:
    real = tmp_path / "real"
    real.mkdir()
    (tmp_path / "link").symlink_to(real)
    a = FileChannelStore(real / "lanes.json")
    b = FileChannelStore(tmp_path / "link" / "lanes.json")
    assert a.lock is b.lock  # resolve() follows the symlink


def test_stale_lock_takeover_and_a_fresh_lock_moved_by_mistake(tmp_path: Path) -> None:
    lock = tmp_path / "lanes.json.lock"
    lock.write_text("99999999")  # above every pid_max: no such process
    take_lock(lock)
    assert lock.read_text() == str(os.getpid())

    lock.write_text("99999999")

    def another_process_took_it() -> None:
        lock.unlink()
        lock.write_text("1")  # pid 1 is always alive

    with pytest.raises(AssayError, match="another process"):
        take_lock(lock, another_process_took_it)
    assert lock.read_text() == "1"
    assert sorted(p.name for p in tmp_path.iterdir()) == ["lanes.json.lock"]


@pytest.mark.skipif(os.name == "nt", reason="pid liveness is POSIX only")
def test_a_forked_child_does_not_inherit_the_lock(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    store = FileChannelStore(tmp_path / "lanes.json")
    store.load()
    parent = os.getpid()
    monkeypatch.setattr(os, "getpid", lambda: parent + 100000)
    with pytest.raises(AssayError, match="another process"):
        store.load()


@pytest.mark.skipif(os.name == "nt", reason="pid liveness is POSIX only")
def test_a_second_process_is_kept_off_the_file(tmp_path: Path) -> None:
    path = tmp_path / "lanes.json"
    (tmp_path / "lanes.json.lock").write_text("1")  # pid 1 is always alive
    with pytest.raises(AssayError, match="another process"):
        FileChannelStore(path).load()
