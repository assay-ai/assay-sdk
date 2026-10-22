"""One client per MCP URL: ``mcp_url`` paths, ``at()``, ``tools.list()``, URL errors and link-token redaction."""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from typing import Any

import httpx
import pytest

from goassay import Assay, AssayError, ConfigError, McpUrlNotFoundError, PaymentRefusedError
from goassay._eip155 import reset_spend_ledger
from goassay._mcp_url import resolve_mcp_url
from tests.fake import BASE, MCP, TOOL, Answer, Fake, Seen, get_tool_answer, payment_required, tool_result

ORIGIN = "https://mcp.example.test"
TOKEN = "abcdefghij_klmnopqrs-tuvwxyz012"
RECEIPT: dict[str, Any] = {"intentId": "2f1c0b7e-4a3d-4e5f-8a9b-0c1d2e3f4a5b", "charged": {"amount": "100000"}}


@pytest.fixture(autouse=True)
def _fresh_ledger() -> Iterator[None]:
    reset_spend_ledger()
    yield
    reset_spend_ledger()


def name_of(s: Seen) -> Any:
    return s.body["params"].get("name") if s.url.startswith(MCP) else None


def method_of(s: Seen) -> Any:
    return s.body["method"]


def paid(params: dict[str, Any], _seen: Seen) -> Any:
    """A paid tool on every URL: PAYMENT_REQUIRED without a voucher, the result with one."""
    if params.get("name") == "get_tool":
        return get_tool_answer()
    if "assay/voucher" in params["_meta"]:
        return tool_result({"assay/receipt": RECEIPT})
    return payment_required()


ACCEPTED = [
    "/",
    "/my/research",
    "/my/research@2",
    "/my/research/",
    "/@acme/twitter-kit",
    "/@acme/twitter-kit@3",
    "/%40acme/twitter-kit",
    f"/u/{TOKEN}",
    f"/u/{TOKEN}@4",
    "/c/weather",
    "/@acme",
    "/?tools=get_weather",
    "/?tools=get_weather@1,acme__get_quote",
    "/my/research?free=1",
    "/c/weather?category=maps,weather&discovery=full",
    "/?discovery=search&free=0",
    "/My/Research",
    "https://mcp.example.test",
    "https://mcp.example.test/@acme?tools=acme__get_quote",
    "http://localhost:8080/my/research",
]

REJECTED = [
    "",
    "my/research",
    "//evil.example/my/x",
    "/my",
    "/my/x",
    "/my/research@0",
    "/my/research@1234567",
    "/my/a/b",
    "/@ab",
    "/@acme/kit/extra",
    "/u/short",
    "/c/1weather",
    "/t/abc",
    "/docs",
    "/health",
    "/.well-known/oauth",
    "/my/../research",
    "/my//research",
    "/my/%72esearch",
    "/?tool=get_weather",
    "/?tools=Get Weather",
    "/?tools=x",
    "/?free=true",
    "/?discovery=all",
    "/?tools=" + ",".join(f"tool_{i}" for i in range(51)),
    "/my/research#frag",
    "https://mcp.example.test/my/./research",
    "/" + "a" * 2050,
]


@pytest.mark.parametrize("url", ACCEPTED)
def test_accepts_served_shapes(url: str) -> None:
    resolve_mcp_url("mcp_url", url, ORIGIN)


@pytest.mark.parametrize("url", REJECTED, ids=lambda u: u[:60])
def test_rejects_other_shapes(url: str) -> None:
    with pytest.raises(ConfigError):
        resolve_mcp_url("mcp_url", url, ORIGIN)


def test_path_resolves_against_goassay_and_is_checked_at_construction() -> None:
    assert repr(Assay(api_key="k-123", mcp_url="/my/research@2")) == "Assay(https://mcp.goassay.ai/my/research@2)"
    with pytest.raises(ConfigError):
        Assay(api_key="k-123", mcp_url="/my")


def test_another_hosts_url_is_judged_by_its_path_shape_only() -> None:
    Assay(api_key="k-123", mcp_url="https://mcp.my-deployment.example/c/weather")
    with pytest.raises(ConfigError):
        Assay(api_key="k-123", mcp_url="https://mcp.my-deployment.example/mcp")


# --- at() ---------------------------------------------------------------------------------------


def test_at_sends_to_its_own_url() -> None:
    fake = Fake(mcp=lambda p, s: tool_result({}))
    client = fake.client()
    kit = client.at("/@acme/kit@3")
    assert repr(kit) == f"Assay({ORIGIN}/@acme/kit@3)"
    kit.tools.call("acme__get_profile", {"user": "x"})
    client.tools.call("get_weather", {})
    assert [(s.url, name_of(s)) for s in fake.seen] == [
        (f"{ORIGIN}/@acme/kit@3", "acme__get_profile"),
        (MCP, "get_weather"),
    ]


def test_at_refuses_a_bad_path_and_another_origin() -> None:
    client = Fake().client()
    with pytest.raises(ConfigError):
        client.at("/nope/x")
    with pytest.raises(ConfigError):
        client.at("https://mcp.goassay.ai/my/research")
    client.at(f"{ORIGIN}/my/research")


def test_at_shares_the_spend_ledger_and_limits() -> None:
    fake = Fake(mcp=paid)
    client = fake.client(limits={"max_per_call": "0.15", "max_per_day": "0.15"})
    kit = client.at("/my/research")
    client.tools.call(TOOL, {})
    with pytest.raises(PaymentRefusedError) as err:
        kit.tools.call(TOOL, {})
    assert err.value.code == "G7_PER_DAY"
    assert fake.signer.calls == 1


def test_at_shares_in_flight_calls_by_key() -> None:
    fake = Fake(mcp=lambda p, s: tool_result({}))

    async def slow(request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(0.01)  # both calls are in flight at once
        return fake.handle(request)

    client = fake.async_client(http_client=httpx.AsyncClient(transport=httpx.MockTransport(slow)))
    kit = client.at("/my/research")

    async def run() -> None:
        a, b = await asyncio.gather(
            client.tools.call("get_weather", {"city": "Oslo"}, idempotency_key="same-key"),
            kit.tools.call("get_weather", {"city": "Oslo"}, idempotency_key="same-key"),
        )
        assert a is b
        assert len(fake.seen) == 1
        first = asyncio.ensure_future(client.tools.call("get_weather", {"city": "Oslo"}, idempotency_key="k2"))
        await asyncio.sleep(0)
        with pytest.raises(AssayError, match="in use for another call"):
            await kit.tools.call("get_weather", {"city": "Rome"}, idempotency_key="k2")
        await first

    asyncio.run(run())
    sync = Fake().client()
    assert sync.at("/c/weather").tools._in_flight is sync.tools._in_flight


def test_at_keeps_its_own_quote_cache() -> None:
    fake = Fake(mcp=paid)
    client = fake.client()
    kit = client.at("/my/research")
    client.tools.get(TOOL)
    client.tools.call(TOOL, {})
    kit.tools.call(TOOL, {})
    assert [s.url for s in fake.seen if name_of(s) == "get_tool"] == [MCP, f"{ORIGIN}/my/research"]
    assert fake.signer.calls == 2


def test_paid_call_on_a_tool_set_url() -> None:
    fake = Fake(mcp=paid)
    client = fake.client(mcp_url=f"{ORIGIN}/my/research@2")
    r = client.tools.call(TOOL, {})
    assert r.receipt is not None and r.receipt["intentId"] == RECEIPT["intentId"]
    assert fake.signer.calls == 1
    assert [s.url for s in fake.seen if name_of(s) == TOOL] == [f"{ORIGIN}/my/research@2"] * 2


# --- tools.list() -------------------------------------------------------------------------------


def test_list_returns_tools_and_meta() -> None:
    meta = {"assay/toolsetVersion": 3, "assay/ignoredTools": ["nope"]}

    def mcp(params: dict[str, Any], seen: Seen) -> Any:
        tools = [{"name": "acme__get_quote", "inputSchema": {"type": "object"}, "_meta": {}}, {"name": "bad name!"}]
        return {"tools": tools, "_meta": meta} if method_of(seen) == "tools/list" else {}

    fake = Fake(mcp=mcp)
    out = fake.client().at("/@acme/kit").tools.list()
    assert [t["name"] for t in out.tools] == ["acme__get_quote"]
    assert out.meta == meta
    assert out.next_cursor is None
    assert [(s.url, method_of(s)) for s in fake.seen] == [(f"{ORIGIN}/@acme/kit", "tools/list")]


def test_list_keeps_prices_as_quotes() -> None:
    price = {"assay/price": dict(BASE["quote"])}

    def mcp(params: dict[str, Any], seen: Seen) -> Any:
        return {"tools": [{"name": TOOL, "_meta": price}]} if method_of(seen) == "tools/list" else paid(params, seen)

    fake = Fake(mcp=mcp)
    client = fake.client()
    client.tools.list()
    client.tools.call(TOOL, {})
    assert not [s for s in fake.seen if name_of(s) == "get_tool"]
    assert fake.signer.calls == 1


def test_async_list() -> None:
    fake = Fake(mcp=lambda p, s: {"tools": [{"name": "get_weather"}]})
    out = asyncio.run(fake.async_client().at("/c/weather").tools.list())
    assert [t["name"] for t in out.tools] == ["get_weather"]


# --- McpUrlNotFoundError ------------------------------------------------------------------------


def test_mcp_url_not_found_is_typed_and_not_retried() -> None:
    body = {"success": False, "error": {"code": "MCP_URL_NOT_FOUND", "message": "no such server", "statusCode": 404}}
    fake = Fake(mcp=lambda p, s: Answer(body, 404))
    with pytest.raises(McpUrlNotFoundError) as err:
        fake.client().at("/my/gone").tools.list()
    assert (err.value.code, err.value.status) == ("MCP_URL_NOT_FOUND", 404)
    assert len(fake.seen) == 1


def test_bare_404_from_the_mcp_host_is_url_not_found() -> None:
    fake = Fake(mcp=lambda p, s: Answer("not found", 404))
    with pytest.raises(McpUrlNotFoundError):
        fake.client().tools.call("get_weather", {})


# --- link-only tokens ---------------------------------------------------------------------------


class Lines:
    def __init__(self) -> None:
        self.lines: list[str] = []

    def debug(self, msg: str, *args: Any, **kwargs: Any) -> None:
        self.lines.append(msg % args)

    def warning(self, msg: str, *args: Any, **kwargs: Any) -> None:
        self.lines.append(msg % args)


def test_link_tokens_are_redacted_in_repr_and_logs() -> None:
    log = Lines()
    fake = Fake(mcp=lambda p, s: tool_result({}))
    shared = fake.client(logger=log).at(f"/u/{TOKEN}@2?tools=get_weather")
    shared.tools.call("get_weather", {})
    direct = Fake().client(mcp_url=f"{ORIGIN}/u/{TOKEN}")
    asyncs = Fake().async_client().at(f"/u/{TOKEN}")
    for c in (shared, direct, asyncs):
        for text in (repr(c), str(c), f"{c!r}"):
            assert TOKEN not in text
            assert "/u/…" in text
    assert repr(shared) == f"Assay({ORIGIN}/u/…@2?tools=get_weather)"
    assert log.lines
    assert all(TOKEN not in line for line in log.lines)
    assert any("/u/…" in line for line in log.lines)


def test_link_token_never_in_a_config_error() -> None:
    with pytest.raises(ConfigError) as err:
        Assay(api_key="k-123", mcp_url=f"/u/{TOKEN}/extra")
    assert TOKEN not in str(err.value)
