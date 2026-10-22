"""Tools over MCP: search, describe and call, with paid calls signed by the caller's signer."""

from __future__ import annotations

import asyncio
import concurrent.futures
import json
import math
import threading
import unicodedata
import uuid
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from goassay import _ops
from goassay._caip import namespace_of
from goassay._context import Context
from goassay._guards import GuardResult
from goassay._http import MAX_RETRY_AFTER_SECONDS
from goassay._meta import (
    CALL_TOOL,
    ERROR_META,
    GET_TOOL,
    IDEMPOTENCY_META,
    IN_PROGRESS_CODE,
    PAYMENT_REQUIRED_CODE,
    PAYMENT_REQUIRED_META,
    PRICE_META,
    RECEIPT_META,
    REPLAYED_META,
    SEARCH_TOOLS,
    VOUCHER_META,
    is_idempotency_key,
    is_tool_name,
    quote_of,
    structured_of,
)
from goassay._ops import Flow

if TYPE_CHECKING:
    from goassay._client import Assay, AsyncAssay
from goassay.errors import (
    AssayError,
    ConfigError,
    PaymentError,
    PaymentNetworkUnknownError,
    PaymentRefusedError,
    PaymentRequiredError,
    PaymentSchemeUnsupportedError,
    ServerError,
    error_from_server,
)


@dataclass(frozen=True)
class ToolResult:
    content: list[Any]
    structured_content: dict[str, Any] | None
    is_error: bool
    """The provider's own tool error. Assay refusals are raised, never returned."""
    receipt: dict[str, Any] | None
    """``_meta["assay/receipt"]``: what the call cost (``intentId``, ``charged``, ``status`` ...).
    ``intentId`` is ``None`` for a free call: it has no intent and no receipt to fetch."""
    replayed: bool
    """The stored result of an earlier attempt with the same idempotency key; not charged again."""
    idempotency_key: str
    """The key this logical call used; pass it again to retry the same call safely."""


@dataclass(frozen=True)
class SearchResult:
    results: list[dict[str, Any]]
    next_cursor: str | None


@dataclass(frozen=True)
class ToolList:
    tools: list[dict[str, Any]]
    """The tools this URL lists, as MCP describes them (``name``, ``inputSchema``, ``_meta`` ...)."""
    next_cursor: str | None
    meta: dict[str, Any]
    """The list's ``_meta``, as sent: ``assay/toolsetVersion`` (a tool set URL without ``@n``),
    ``assay/sharingEnds``, ``assay/renamed`` (an old handle) and ``assay/ignoredTools`` (``?tools=``
    names this URL does not serve)."""


_UNSAFE_HINT = frozenset({"Cc", "Cf", "Cs", "Co", "Zl", "Zp"})
"""Characters a hint may not carry: controls, format (bidi, zero-width), surrogates, private use,
line/paragraph separators."""


def _hint_of(value: object) -> str | None:
    """The server's `hint` on `assay/error`, without surrounding spaces, when it is a short
    single-line text (1-500 code points)."""
    if not isinstance(value, str):
        return None
    hint = value.strip(" \t")
    ok = 0 < len(hint) <= 500 and not any(unicodedata.category(ch) in _UNSAFE_HINT for ch in hint)
    return hint if ok else None


def _assay_error(result: dict[str, Any]) -> dict[str, Any] | None:
    meta = result.get("_meta")
    e = meta.get(ERROR_META) if isinstance(meta, dict) else None
    return e if isinstance(e, dict) and isinstance(e.get("code"), str) else None


def _text(result: dict[str, Any]) -> str | None:
    for c in result.get("content") or []:
        if isinstance(c, dict) and c.get("type") == "text" and isinstance(c.get("text"), str):
            return str(c["text"])
    return None


def _tool_error(e: dict[str, Any], result: dict[str, Any]) -> AssayError:
    code = str(e["code"])
    message = e["message"] if isinstance(e.get("message"), str) else (_text(result) or code)
    wait = None
    if isinstance(e.get("retryAfterMs"), (int, float)):
        wait = e["retryAfterMs"] / 1000
    elif isinstance(e.get("retryAfter"), (int, float)):
        wait = float(e["retryAfter"])
    details = dict(e["details"]) if isinstance(e.get("details"), dict) else {}
    if isinstance(e.get("intentId"), str):
        details["intentId"] = e["intentId"]
    # A scope refusal on a tool call names the scope on ``assay/error`` itself, not under ``details``.
    if isinstance(e.get("requiredScope"), str) and "requiredScope" not in details:
        details["requiredScope"] = e["requiredScope"]
    return error_from_server(
        code,
        message,
        retryable=e.get("retryable") is True,
        fix_url=e["fixUrl"] if isinstance(e.get("fixUrl"), str) else None,
        details=details or None,
        retry_after=wait,
    )


def _to_result(result: dict[str, Any], key: str) -> ToolResult:
    meta = result.get("_meta") if isinstance(result.get("_meta"), dict) else {}
    assert isinstance(meta, dict)
    receipt = meta.get(RECEIPT_META)
    sc = result.get("structuredContent")
    return ToolResult(
        content=list(result.get("content") or []),
        structured_content=sc if isinstance(sc, dict) else None,
        is_error=result.get("isError") is True,
        receipt=receipt if isinstance(receipt, dict) else None,
        replayed=meta.get(REPLAYED_META) is True,
        idempotency_key=key,
    )


def _send(c: Context, params: dict[str, Any]) -> Flow[dict[str, Any]]:
    """One ``tools/call``; ``IDEMPOTENCY_IN_PROGRESS`` waits and sends the same request again."""
    attempt = 0
    while True:
        result = yield from c.mcp("tools/call", params)
        e = _assay_error(result)
        # The first attempt still runs, or a refusal-rate limit: wait and send the same bytes again.
        if e is None or e.get("code") not in (IN_PROGRESS_CODE, "RATE_LIMITED") or attempt >= c.max_retries:
            return result
        if isinstance(e.get("retryAfterMs"), (int, float)):
            wait = e["retryAfterMs"] / 1000
        elif isinstance(e.get("retryAfter"), (int, float)):
            wait = float(e["retryAfter"])
        else:
            wait = 1.0
        if wait > MAX_RETRY_AFTER_SECONDS:
            return result
        yield from _ops.sleep(wait)
        attempt += 1


def _meta_tool(c: Context, tool: str, args: dict[str, Any]) -> Flow[dict[str, Any]]:
    result = yield from _send(c, {"name": tool, "arguments": args})
    e = _assay_error(result)
    if e is not None:
        raise _tool_error(e, result)
    out = structured_of(result)
    if out is None:
        raise AssayError("TOOL_ERROR", _text(result) or f"{tool} failed")
    return out


def search(c: Context, query: str, options: dict[str, Any]) -> Flow[SearchResult]:
    args = {"query": query, **{k: v for k, v in options.items() if v is not None}}
    out = yield from _meta_tool(c, SEARCH_TOOLS, args)
    raw = out.get("results")
    results = (
        [r for r in raw if isinstance(r, dict) and isinstance(r.get("name"), str)] if isinstance(raw, list) else []
    )
    for r in results:
        q = quote_of(r.get("assayPrice"))
        if q:
            c.quotes.set(r["name"], q)
    cursor = out.get("nextCursor")
    return SearchResult(results, cursor if isinstance(cursor, str) else None)


def list_tools(c: Context, cursor: str | None) -> Flow[ToolList]:
    out = yield from c.mcp("tools/list", {} if cursor is None else {"cursor": cursor})
    raw = out.get("tools")
    tools = [t for t in raw if isinstance(t, dict) and is_tool_name(t.get("name"))] if isinstance(raw, list) else []
    for t in tools:
        meta = t.get("_meta")
        q = quote_of(meta.get(PRICE_META)) if isinstance(meta, dict) else None
        if q:
            c.quotes.set(t["name"], q)
    nxt, meta = out.get("nextCursor"), out.get("_meta")
    return ToolList(tools, nxt if isinstance(nxt, str) else None, dict(meta) if isinstance(meta, dict) else {})


def get(c: Context, name: str) -> Flow[dict[str, Any]]:
    out = yield from _meta_tool(c, GET_TOOL, {"name": name})
    if not isinstance(out.get("name"), str):
        raise ServerError("MCP_BAD_ANSWER", "get_tool answered without a tool name")
    q = quote_of(out.get("price"))
    if q:
        c.quotes.set(out["name"], q)
    return out


def quote_for(c: Context, tool: str) -> Flow[dict[str, str] | None]:
    """G3: the cached quote, or a fresh ``get_tool`` just before signing."""
    cached = c.quotes.get(tool)
    if cached:
        return cached
    try:
        info = yield from get(c, tool)
    except AssayError:
        return None
    return c.quotes.get(tool) if info.get("name") == tool else None


def call(c: Context, name: str, args: dict[str, Any], idempotency_key: str) -> Flow[ToolResult]:
    """``_call``, with the call's idempotency key put on any ``AssayError`` it raises."""
    try:
        return (yield from _call(c, name, args, idempotency_key))
    except AssayError as err:
        if err.idempotency_key is None:
            err.idempotency_key = idempotency_key
        raise


def _call(c: Context, name: str, args: dict[str, Any], idempotency_key: str) -> Flow[ToolResult]:
    """Calls a tool. A paid tool's ``PAYMENT_REQUIRED`` is checked by every local guard, offered
    to ``on_payment``, signed once, and the same call is sent again with the voucher and the same
    idempotency key. Network retries resend the same request; nothing is signed twice."""
    if not is_tool_name(name):
        raise ConfigError("name is not a tool name")
    if not isinstance(args, dict):
        raise ConfigError("arguments must be a dict")
    key = idempotency_key
    if not is_idempotency_key(key):
        raise ConfigError("idempotency_key must be 1 to 128 printable ASCII characters")
    params: dict[str, Any] = {"name": name, "arguments": args, "_meta": {IDEMPOTENCY_META: key}}
    called_at = math.floor(c.now())
    first = yield from _send(c, params)
    refusal = _assay_error(first)
    if refusal is None:
        return _to_result(first, key)
    requirement = first["_meta"].get(PAYMENT_REQUIRED_META)
    if refusal["code"] != PAYMENT_REQUIRED_CODE or requirement is None:
        raise _tool_error(refusal, first)

    fix_url = refusal["fixUrl"] if isinstance(refusal.get("fixUrl"), str) else None
    if not c.signers:
        raise PaymentRequiredError(
            f"{name} is a paid tool and this client has no signer",
            requirement,
            fix_url=fix_url,
            hint=_hint_of(refusal.get("hint")),
        )
    network = requirement.get("network") if isinstance(requirement, dict) else None
    network = network if isinstance(network, str) else "unknown"
    ns = namespace_of(network)
    signer = next((s for s in c.signers if s.namespace == ns), None)
    scheme = c.schemes.get(ns) if ns else None
    if signer is None or scheme is None:
        raise PaymentSchemeUnsupportedError(network)

    tool = args.get("name") if name == CALL_TOOL else name
    if not is_tool_name(tool):
        raise PaymentRefusedError("G1", "G1_NOT_FORWARDED", "the paid tool's name is not readable")
    assert isinstance(tool, str)
    prepared = yield from scheme.prepare(
        requirement=requirement,
        tool=tool,
        called_at=called_at,
        signer=signer,
        idempotency_key=key,
        quote=lambda t: quote_for(c, t),
    )
    if isinstance(prepared, GuardResult):
        if prepared.code == "G2_NETWORK":
            raise PaymentNetworkUnknownError(network)
        raise PaymentRefusedError(
            prepared.guard or "G1", prepared.code or "G1_NOT_A_REQUIREMENT", prepared.reason or "", fix_url=fix_url
        )
    if c.on_payment is not None:
        try:
            verdict = yield from _ops.call(c.on_payment, dict(prepared.details))
        except BaseException:
            prepared.release()
            raise
        if verdict is False:
            prepared.release()
            raise PaymentRefusedError("on_payment", "PAYMENT_REFUSED_BY_CALLER", "the on_payment hook refused it")
    try:
        envelope = yield from prepared.sign()
    except AssayError:
        prepared.release()
        raise
    except Exception as err:
        prepared.release()
        raise PaymentError("SIGNER_FAILED", "the signer did not sign the voucher") from err
    paid = yield from _send(c, {**params, "_meta": {**params["_meta"], VOUCHER_META: envelope}})
    after = _assay_error(paid)
    if after is None:
        return _to_result(paid, key)
    scheme.on_refused(str(after["code"]), requirement, signer)
    raise _tool_error(after, paid)


# --- the sync and async faces ---------------------------------------------------------------


def _fingerprint(name: str, args: dict[str, Any]) -> str:
    return json.dumps([name, args], sort_keys=True, default=str)


def _reused(key: str) -> AssayError:
    err = AssayError("IDEMPOTENCY_KEY_REUSED", "this idempotency key is in use for another call")
    err.idempotency_key = key
    return err


class Tools:
    """Tools over MCP. One logical call per idempotency key in a client: a second call with a key
    while the first runs (another thread) waits for it, so at most one voucher is signed for it."""

    def __init__(self, client: Assay, share: Tools | None = None) -> None:
        self._c = client
        # A sibling client (``at()``) shares its parent's in-flight calls, so one key is one call.
        self._lock: threading.Lock = share._lock if share else threading.Lock()
        self._in_flight: dict[str, tuple[str, concurrent.futures.Future[ToolResult]]] = (
            share._in_flight if share else {}
        )

    def list(self, *, cursor: str | None = None) -> ToolList:
        """``tools/list``: the tools this URL lists. A tool set, topic, maker or ``?tools=`` URL lists
        its tools; Everything (``/``) lists only a few, plus ``search_tools``, ``get_tool`` and
        ``call_tool``. Free. Each tool's ``_meta["assay/price"]`` is kept as its quote (G3)."""
        return self._c._run(list_tools(self._c._ctx, cursor))

    def search(
        self,
        query: str,
        *,
        limit: int | None = None,
        category: str | None = None,
        detail: str | None = None,
        cursor: str | None = None,
    ) -> SearchResult:
        """``search_tools``: tools this URL can run, by what they do. Free."""
        opts = {"limit": limit, "category": category, "detail": detail, "cursor": cursor}
        return self._c._run(search(self._c._ctx, query, opts))

    def get(self, name: str) -> dict[str, Any]:
        """``get_tool``: one tool's description, schemas, price and version. Free."""
        return self._c._run(get(self._c._ctx, name))

    def call(
        self, name: str, arguments: dict[str, Any] | None = None, *, idempotency_key: str | None = None
    ) -> ToolResult:
        """Calls a tool; a paid tool is checked, signed once and retried with the same key. Any
        ``AssayError`` it raises carries ``idempotency_key``: pass it again to retry safely."""
        args = arguments or {}
        key = idempotency_key if idempotency_key is not None else str(uuid.uuid4())
        fp = _fingerprint(name, args)
        with self._lock:
            running = self._in_flight.get(key)
            if running is None:
                future: concurrent.futures.Future[ToolResult] = concurrent.futures.Future()
                self._in_flight[key] = (fp, future)
        if running is not None:
            if running[0] != fp:
                raise _reused(key)
            return running[1].result()
        try:
            result = self._c._run(call(self._c._ctx, name, args, key))
        except BaseException as err:
            future.set_exception(err)
            raise
        else:
            future.set_result(result)
            return result
        finally:
            with self._lock:
                self._in_flight.pop(key, None)


class AsyncTools:
    def __init__(self, client: AsyncAssay, share: AsyncTools | None = None) -> None:
        self._c = client
        self._in_flight: dict[str, tuple[str, asyncio.Future[ToolResult]]] = share._in_flight if share else {}

    async def list(self, *, cursor: str | None = None) -> ToolList:
        return await self._c._run(list_tools(self._c._ctx, cursor))

    async def search(
        self,
        query: str,
        *,
        limit: int | None = None,
        category: str | None = None,
        detail: str | None = None,
        cursor: str | None = None,
    ) -> SearchResult:
        opts = {"limit": limit, "category": category, "detail": detail, "cursor": cursor}
        return await self._c._run(search(self._c._ctx, query, opts))

    async def get(self, name: str) -> dict[str, Any]:
        return await self._c._run(get(self._c._ctx, name))

    async def call(
        self, name: str, arguments: dict[str, Any] | None = None, *, idempotency_key: str | None = None
    ) -> ToolResult:
        args = arguments or {}
        key = idempotency_key if idempotency_key is not None else str(uuid.uuid4())
        fp = _fingerprint(name, args)
        running = self._in_flight.get(key)
        if running is not None:
            if running[0] != fp:
                raise _reused(key)
            return await asyncio.shield(running[1])
        future: asyncio.Future[ToolResult] = asyncio.get_running_loop().create_future()
        self._in_flight[key] = (fp, future)
        try:
            result = await self._c._run(call(self._c._ctx, name, args, key))
        except BaseException as err:
            future.set_exception(err)
            future.exception()  # marks it retrieved when nobody else waits
            raise
        else:
            future.set_result(result)
            return result
        finally:
            self._in_flight.pop(key, None)
