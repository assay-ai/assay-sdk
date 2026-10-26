"""A fake transport for the unit tests: one ``httpx.MockTransport`` answering the MCP endpoint, the
REST API and a chain RPC from the guard vectors' base context. Nothing leaves the process."""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass, field
from email.utils import formatdate
from pathlib import Path
from typing import Any

import httpx
from eth_account import Account
from eth_utils.crypto import keccak

from goassay import Assay, AsyncAssay, evm_signer

VECTORS = Path(__file__).resolve().parents[2] / "vectors" / "eip155"


def load(name: str) -> Any:
    return json.loads((VECTORS / name).read_text(encoding="utf-8"))


GUARDS = load("guards.json")
BASE = GUARDS["base"]
BINDING = load("binding.json")
ACCOUNT = Account.from_key(load("vouchers.json")["testKey"]["privateKey"])
NOW = float(BASE["nowSeconds"])
MCP = "https://mcp.example.test/"
API = "https://api.example.test/api/v1"
RPC = "https://rpc.example.test/"
WEB = "https://app.example.test"
TOOL = "weather_forecast"
NETWORKS = {
    BASE["network"]["id"]: {
        "escrow": BASE["network"]["escrow"],
        "asset": BASE["network"]["asset"],
        "decimals": BASE["network"]["decimals"],
        "rpcUrls": [RPC],
    }
}


def _word(n: int) -> str:
    return format(int(n), "x").rjust(64, "0")


def _selector(sig: str) -> str:
    return keccak(text=sig)[:4].hex()


def _rpc(body: dict[str, Any]) -> dict[str, Any]:
    def result(r: Any) -> dict[str, Any]:
        return {"jsonrpc": "2.0", "id": body["id"], "result": r}

    if body["method"] == "eth_chainId":
        return result(hex(int(BASE["network"]["id"].split(":")[1])))
    if body["method"] == "eth_blockNumber":
        return result("0x64")
    data = body["params"][0]["data"]
    c = BASE["chain"]
    if data.startswith("0x" + _selector("delegationOf(address,address)")):
        words = [c["delegateMaxVoucherAmount"], 10_000_000, 0, 0, c["validUntil"], 0, 0]
    elif data.startswith("0x" + _selector("effectiveCapsOf(address,address)")):
        words = [c["maxVoucherAmount"], 10_000_000, c["delegateMaxVoucherAmount"], 10_000_000]
    else:
        words = [10**9, 0, 0, c["maxVoucherAmount"], 10_000_000, 0, 0, 0, 0, 0, 0, 0]
    return result("0x" + "".join(_word(int(w)) for w in words))


def tool_result(meta: dict[str, Any], **extra: Any) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": "ok"}], **extra, "_meta": meta}


def payment_required(requirement: Any = None, fix_url: str | None = None) -> dict[str, Any]:
    err: dict[str, Any] = {"code": "PAYMENT_REQUIRED", "message": "paid", "retryable": True}
    if fix_url:
        err["fixUrl"] = fix_url
    req = BASE["requirement"] if requirement is None else requirement
    return tool_result({"assay/error": err, "x402/paymentRequired": req}, isError=True)


def get_tool_answer() -> dict[str, Any]:
    return {
        "content": [{"type": "text", "text": ""}],
        "structuredContent": {"name": TOOL, "price": dict(BASE["quote"])},
    }


@dataclass
class Answer:
    body: Any
    status: int = 200
    headers: dict[str, str] = field(default_factory=dict)


@dataclass
class Seen:
    url: str
    method: str
    headers: dict[str, str]
    body: Any


McpHandler = Callable[[dict[str, Any], Seen], Any]
ApiHandler = Callable[[Seen], Answer | None]


class SpySigner:
    """An EVM signer that records each call; signs with the vectors' test key."""

    namespace = "eip155"

    def __init__(self) -> None:
        self._inner = evm_signer(ACCOUNT)
        self.address = ACCOUNT.address
        self.calls = 0

    def sign_typed_data(self, typed_data: dict[str, Any]) -> str:
        self.calls += 1
        return self._inner.sign_typed_data(typed_data)  # type: ignore[return-value]


@dataclass
class Fake:
    mcp: McpHandler | None = None
    api: ApiHandler | None = None
    # Answers a chain RPC request in place of the base context's view (None: the view).
    rpc: ApiHandler | None = None
    seen: list[Seen] = field(default_factory=list)
    sleeps: list[float] = field(default_factory=list)
    signer: SpySigner = field(default_factory=SpySigner)

    def handle(self, request: httpx.Request) -> httpx.Response:
        body: Any = json.loads(request.content) if request.content else None
        seen = Seen(str(request.url), request.method, {k.lower(): v for k, v in request.headers.items()}, body)
        self.seen.append(seen)
        date = formatdate(NOW, usegmt=True)

        def respond(a: Answer) -> httpx.Response:
            return httpx.Response(a.status, json=a.body, headers={"date": date, **a.headers})

        if seen.url.startswith("https://rpc"):
            custom = self.rpc(seen) if self.rpc else None
            return respond(custom if custom is not None else Answer(_rpc(body)))
        if seen.url.startswith(MCP):
            out = self.mcp(body["params"], seen) if self.mcp else {}
            if isinstance(out, Answer):
                return respond(out)
            return respond(Answer({"jsonrpc": "2.0", "id": body["id"], "result": {"resultType": "complete", **out}}))
        a = self.api(seen) if self.api else None
        if a is not None:
            return respond(a)
        return respond(Answer({"success": False, "error": {"code": "NOT_FOUND", "message": "no route"}}, 404))

    def calls(self) -> list[Seen]:
        return [s for s in self.seen if s.url == MCP and s.body["params"]["name"] == TOOL]

    def client(self, *, with_signer: bool = True, pinned: bool = True, **options: Any) -> Assay:
        kw: dict[str, Any] = {
            "api_key": "test-api-key-123",
            "mcp_url": MCP,
            "api_url": API,
            "web_url": WEB,
            "http_client": httpx.Client(transport=httpx.MockTransport(self.handle)),
            "sleep": self.sleeps.append,
            "now": lambda: NOW,
        }
        if pinned:
            kw["networks"] = NETWORKS
        if with_signer:
            kw["signer"] = self.signer
        kw.update(options)
        return Assay(**kw)

    def async_client(self, **options: Any) -> AsyncAssay:
        async def sleep(s: float) -> None:
            self.sleeps.append(s)

        kw: dict[str, Any] = {
            "api_key": "test-api-key-123",
            "mcp_url": MCP,
            "api_url": API,
            "web_url": WEB,
            "http_client": httpx.AsyncClient(transport=httpx.MockTransport(self.handle)),
            "sleep": sleep,
            "now": lambda: NOW,
            "networks": NETWORKS,
            "signer": self.signer,
        }
        kw.update(options)
        return AsyncAssay(**kw)


def meta_of(s: Seen) -> dict[str, Any]:
    return s.body["params"]["_meta"]  # type: ignore[no-any-return]
