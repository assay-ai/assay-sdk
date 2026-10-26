"""Regression tests for the phase-1 review (I1-I8 and the minor findings fixed with them)."""

from __future__ import annotations

import asyncio
import copy
import json
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import pytest

import goassay
from goassay import (
    BUILT_IN_NETWORKS,
    DEFAULT_WEB_URL,
    AssayError,
    ConfigError,
    NetworkError,
    PaymentNetworkUnknownError,
    PaymentRefusedError,
)
from goassay._http import retry_after_seconds
from goassay._networks import network_table
from tests.fake import (
    ACCOUNT,
    BASE,
    BINDING,
    MCP,
    NETWORKS,
    RPC,
    TOOL,
    Answer,
    Fake,
    Seen,
    get_tool_answer,
    meta_of,
    payment_required,
    tool_result,
)

RECEIPT = {"intentId": "2f1c0b7e-4a3d-4e5f-8a9b-0c1d2e3f4a5b"}


def paid_mcp(delay: float = 0.0) -> Any:
    def handler(params: dict[str, Any], _seen: Seen) -> Any:
        if params["name"] == "get_tool":
            return get_tool_answer()
        if "assay/voucher" in params["_meta"]:
            return tool_result({"assay/receipt": RECEIPT})
        time.sleep(delay)
        return payment_required()

    return handler


# --- I1 -----------------------------------------------------------------------------------


def test_i1_threads_with_the_same_key_sign_once() -> None:
    fake = Fake(mcp=paid_mcp(delay=0.2))
    client = fake.client()
    with ThreadPoolExecutor(4) as pool:
        results = list(pool.map(lambda _: client.tools.call(TOOL, {}, idempotency_key="order-1"), range(4)))
    assert fake.signer.calls == 1
    assert all(r is results[0] for r in results)


def test_i1_same_key_other_arguments_in_flight_is_refused() -> None:
    fake = Fake(mcp=paid_mcp(delay=0.2))
    client = fake.client()
    with ThreadPoolExecutor(2) as pool:
        first = pool.submit(client.tools.call, TOOL, {"a": 1}, idempotency_key="order-2")
        time.sleep(0.05)
        second = pool.submit(client.tools.call, TOOL, {"a": 2}, idempotency_key="order-2")
        first.result()
        with pytest.raises(AssayError) as err:
            second.result()
    assert err.value.code == "IDEMPOTENCY_KEY_REUSED"
    assert fake.signer.calls == 1


def test_i1_async_same_key_signs_once() -> None:
    import httpx

    fake = Fake(mcp=paid_mcp())

    async def slow(request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(0.05)  # lets the other calls start while this one is in flight
        return fake.handle(request)

    async def run() -> list[Any]:
        transport = httpx.MockTransport(slow)
        async with fake.async_client(http_client=httpx.AsyncClient(transport=transport)) as client:
            return list(await asyncio.gather(*(client.tools.call(TOOL, {}, idempotency_key="k") for _ in range(3))))

    results = asyncio.run(run())
    assert fake.signer.calls == 1 and all(r is results[0] for r in results)


# --- I2 -----------------------------------------------------------------------------------


def test_i2_network_failure_carries_the_key_and_retrying_reuses_it() -> None:
    fail = {"on": True}
    inner = paid_mcp()

    def mcp(params: dict[str, Any], seen: Seen) -> Any:
        if fail["on"] and "assay/voucher" in params["_meta"]:
            return Answer({"success": False, "error": {"code": "DOWN", "message": "down"}}, 503)
        return inner(params, seen)

    fake = Fake(mcp=mcp)
    client = fake.client()
    with pytest.raises(AssayError) as err:
        client.tools.call(TOOL, {})
    key = err.value.idempotency_key
    assert key is not None and len(key) == 36
    fail["on"] = False
    assert client.tools.call(TOOL, {}, idempotency_key=key).idempotency_key == key
    assert {meta_of(s)["assay/idempotency-key"] for s in fake.calls()} == {key}


def test_i2_connection_error_carries_the_key() -> None:
    import httpx

    def boom(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route")

    client = Fake().client(http_client=httpx.Client(transport=httpx.MockTransport(boom)))
    with pytest.raises(NetworkError) as err:
        client.tools.call(TOOL, {}, idempotency_key="k-net")
    assert err.value.idempotency_key == "k-net"


def test_i2_local_refusal_carries_the_key() -> None:
    with pytest.raises(PaymentRefusedError) as err:
        Fake(mcp=paid_mcp()).client(on_payment=lambda d: False).tools.call(TOOL, {}, idempotency_key="k-1")
    assert err.value.idempotency_key == "k-1"


# --- I3 -----------------------------------------------------------------------------------


def test_i3_threads_cannot_pass_the_daily_cap_together() -> None:
    fake = Fake(mcp=paid_mcp())
    client = fake.client(limits={"max_per_call": "0.10", "max_per_day": "0.50"})

    def one(i: int) -> str:
        try:
            client.tools.call(TOOL, {}, idempotency_key=f"t-{i}")
            return "ok"
        except PaymentRefusedError as e:
            return e.code

    with ThreadPoolExecutor(8) as pool:
        outcomes = list(pool.map(one, range(8)))
    assert outcomes.count("ok") == 5 and outcomes.count("G7_PER_DAY") == 3
    assert fake.signer.calls == 5


def test_i3_a_release_after_another_reservation_frees_its_amount() -> None:
    gate, b_done = threading.Event(), threading.Event()

    def on_payment(d: dict[str, Any]) -> bool:
        if d["idempotency_key"] == "a":
            gate.wait(5)
            return False
        return True

    fake = Fake(mcp=paid_mcp())
    client = fake.client(on_payment=on_payment, limits={"max_per_call": "0.10", "max_per_day": "0.20"})
    with ThreadPoolExecutor(2) as pool:
        a = pool.submit(client.tools.call, TOOL, {}, idempotency_key="a")
        time.sleep(0.1)
        client.tools.call(TOOL, {}, idempotency_key="b")
        b_done.set()
        gate.set()
        with pytest.raises(PaymentRefusedError):
            a.result()
    client.tools.call(TOOL, {}, idempotency_key="c")  # A's 0.10 was released: B + C fit 0.20
    assert fake.signer.calls == 2
    with pytest.raises(PaymentRefusedError) as err:
        client.tools.call(TOOL, {}, idempotency_key="d")
    assert err.value.code == "G7_PER_DAY"


# --- I4 -----------------------------------------------------------------------------------


def test_i4_no_secret_in_any_repr() -> None:
    def mcp(params: dict[str, Any], _s: Seen) -> Any:
        if params["name"] == "get_tool":
            return get_tool_answer()
        if "assay/voucher" in params["_meta"]:
            return tool_result({"assay/error": {"code": "PAYMENT_VOUCHER_EXPIRED", "message": "late"}}, isError=True)
        return payment_required()

    client = Fake(mcp=mcp).client()
    with pytest.raises(AssayError) as err:
        client.tools.call(TOOL, {})
    ctx = client._ctx
    shown = "\n".join(
        repr(x) + str(x)
        for x in (client, ctx, ctx.http, client.tools, client.paid_calls, client.receipts, err.value, ctx.signers)
    )
    assert "test-api-key-123" not in shown
    assert not re.search(r"0x[0-9a-fA-F]{130}", shown)


# --- I5 -----------------------------------------------------------------------------------


def test_i5_default_web_url_is_the_portal() -> None:
    assert DEFAULT_WEB_URL == "https://portal.goassay.ai"
    credential = BINDING["context"]["credentialId"]
    data = {"credentialId": credential, "delegate": None, "pendingDelegate": None, "paidCalls": None}
    client = Fake(api=lambda s: Answer({"data": data})).client(web_url=DEFAULT_WEB_URL)
    assert client.paid_calls.status().approval_url == (
        f"https://portal.goassay.ai/agents/enable-paid?credential={credential}#key={ACCOUNT.address}"
    )


# --- networks: pinned in the SDK ----------------------------------------------------------


def test_built_in_table_pins_robinhood_mainnet() -> None:
    assert list(BUILT_IN_NETWORKS) == ["eip155:4663"]
    n = BUILT_IN_NETWORKS["eip155:4663"]
    assert n["chainId"] == 4663
    assert n["escrow"] == "eip155:4663:0xe54E0142b1D0d34226498D563A16074C81Bc9A5e"
    assert n["asset"] == "eip155:4663/erc20:0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"
    assert n["decimals"] == 6
    # The vector signed for this escrow carries its on-chain DOMAIN_SEPARATOR().
    vectors = json.loads(
        (Path(__file__).resolve().parents[2] / "vectors" / "eip155" / "vouchers.json").read_text(encoding="utf-8")
    )
    mainnet = next(c for c in vectors["cases"] if c["name"] == "robinhood-mainnet-escrow")
    assert mainnet["network"] == {"caip2": "eip155:4663", "escrow": n["escrow"], "asset": n["asset"], "decimals": 6}
    assert len({u.split("/")[2] for u in n["rpcUrls"]}) == 2


def test_unknown_network_is_refused_without_signing_or_reading() -> None:
    fake = Fake(mcp=paid_mcp())
    with pytest.raises(PaymentNetworkUnknownError) as err:
        fake.client(pinned=False).tools.call(TOOL, {})
    assert err.value.network == BASE["network"]["id"] and err.value.code == "G2_NETWORK"
    assert isinstance(err.value, PaymentRefusedError)
    assert fake.signer.calls == 0
    assert not any(s.url.startswith("https://rpc") or "/networks" in s.url for s in fake.seen)


def test_bind_with_no_network_in_the_table() -> None:
    credential = BINDING["context"]["credentialId"]
    data = {"credentialId": credential, "delegate": None, "pendingDelegate": None, "paidCalls": None}
    fake = Fake(api=lambda s: Answer({"data": data}))
    with pytest.raises(PaymentNetworkUnknownError):
        fake.client(pinned=False).paid_calls.bind(network=BINDING["context"]["network"])
    assert fake.signer.calls == 0


def test_rpc_urls_replace_the_tables_rpcs() -> None:
    mine = "https://rpc-private.example.test/"
    fake = Fake(mcp=paid_mcp())
    client = fake.client(rpc_urls={BASE["network"]["id"]: [mine]})
    client.tools.call(TOOL, {})
    assert {s.url for s in fake.seen if s.url.startswith("https://rpc")} == {mine}
    assert client.networks[BASE["network"]["id"]].rpc == (mine,)


@pytest.mark.parametrize(
    "change",
    [
        lambda n: n.update(escrow=n["escrow"].lower()),
        lambda n: n.update(rpcUrls=["http://rpc.example.test/"]),
        lambda n: n.update(asset=n["asset"].replace(BASE["network"]["id"], "eip155:1")),
    ],
    ids=["escrow not checksummed", "plain-http RPC", "asset on another chain"],
)
def test_invalid_networks_option_is_config_error(change: Any) -> None:
    table = copy.deepcopy(NETWORKS)
    change(table[BASE["network"]["id"]])
    with pytest.raises(ConfigError):
        Fake().client(networks=table)


_ID = BASE["network"]["id"]
_BUILT_IN = {_ID: dict(NETWORKS[_ID])}
_OTHER_ID = "eip155:8453"
_OTHER: dict[str, Any] = {
    "chainId": 8453,
    "escrow": "eip155:8453:0xE5c0e5C0e5C0e5C0E5c0E5c0E5C0E5C0E5C0E5C0",
    "asset": "eip155:8453/erc20:0xA55E7a55E7A55E7a55e7A55e7a55e7A55e7a55E7",
    "decimals": 18,
    "rpcUrls": ["http://localhost:8545"],
}


def test_networks_add_beside_built_in_with_localhost_rpc() -> None:
    t = network_table({_OTHER_ID: _OTHER}, None, _BUILT_IN)
    assert sorted(t) == sorted([_ID, _OTHER_ID])
    assert t[_OTHER_ID].rpc == ("http://localhost:8545",)


def test_networks_entry_replaces_built_in_whole() -> None:
    mine = {
        "escrow": _OTHER["escrow"].replace("8453", _ID.split(":")[1]),
        "asset": BASE["network"]["asset"],
        "decimals": 18,
        "rpcUrls": ["https://rpc-mine.example.test/"],
    }
    e = network_table({_ID: mine}, None, _BUILT_IN)[_ID]
    assert (e.escrow_caip10, e.decimals, e.rpc) == (mine["escrow"], 18, ("https://rpc-mine.example.test/",))


def test_rpc_urls_replace_only_rpcs() -> None:
    e = network_table(None, {_ID: ["https://rpc-x.example.test/"]}, _BUILT_IN)[_ID]
    assert (e.escrow_caip10, e.rpc) == (_BUILT_IN[_ID]["escrow"], ("https://rpc-x.example.test/",))


def test_chain_id_not_the_keys_is_refused() -> None:
    with pytest.raises(ConfigError):
        network_table({_OTHER_ID: {**_OTHER, "chainId": 1}}, None, _BUILT_IN)


def test_invalid_rpc_urls_is_config_error() -> None:
    with pytest.raises(ConfigError):
        Fake().client(rpc_urls={BASE["network"]["id"]: ["http://rpc.example.test/"]})


# --- minor findings -----------------------------------------------------------------------


def test_m1_unbound_key_is_refused_before_any_chain_read() -> None:
    req = {**BASE["requirement"], "delegate": None}
    fake = Fake(mcp=lambda p, s: get_tool_answer() if p["name"] == "get_tool" else payment_required(req))
    with pytest.raises(PaymentRefusedError) as err:
        fake.client().tools.call(TOOL, {})
    assert err.value.code == "G5_DELEGATE_MISMATCH" and "paid_calls.bind()" in str(err.value)
    assert not any(s.url == RPC for s in fake.seen)


def test_m5_odd_retry_after_is_ignored() -> None:
    assert retry_after_seconds("²", 0) is None
    assert retry_after_seconds("7", 0) == 7.0


def test_m6_rate_limited_tool_result_is_retried() -> None:
    n = {"i": 0}

    def mcp(p: dict[str, Any], s: Seen) -> Any:
        n["i"] += 1
        if n["i"] == 1:
            return tool_result({"assay/error": {"code": "RATE_LIMITED", "retryAfterMs": 700}}, isError=True)
        return tool_result({})

    fake = Fake(mcp=mcp)
    fake.client().tools.call(TOOL, {})
    assert fake.sleeps == [0.7]


def test_m7_unreadable_grant_is_unknown() -> None:
    ctx = BINDING["context"]
    data = {
        "credentialId": ctx["credentialId"],
        "delegate": f"{ctx['network']}:{ACCOUNT.address}",
        "pendingDelegate": None,
        "paidCalls": None,
        "paidCallsUnknown": True,
    }
    assert Fake(api=lambda s: Answer({"data": data})).client().paid_calls.status().state == "unknown"


def test_m11_version_matches_pyproject() -> None:
    text = (Path(__file__).resolve().parents[1] / "pyproject.toml").read_text(encoding="utf-8")
    m = re.search(r'^version = "([^"]+)"', text, re.M)
    assert m is not None and goassay.__version__ == m.group(1)


def test_mcp_constant() -> None:
    assert MCP.startswith("https://")
