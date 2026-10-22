from __future__ import annotations

import asyncio
import inspect
import os
import platform
import re
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from typing import Any, TypeVar
from urllib.parse import urlsplit

import httpx

from goassay import _paid_calls, _receipts, _tools
from goassay._chain import ChainReader
from goassay._context import Context
from goassay._eip155 import DEFAULT_LIMITS, Eip155Scheme, check_limits, eip155_networks
from goassay._http import HttpConfig, Logger, origin_of
from goassay._ops import CallOp, Flow, HttpOp, HttpResult, SleepOp
from goassay._paid_calls import PaidCallsStatus
from goassay._tools import SearchResult, ToolResult
from goassay.errors import ConfigError, NetworkError, TimeoutError
from goassay.signers import EvmSigner, Signer

T = TypeVar("T")

DEFAULT_MCP_URL = "https://mcp.goassay.ai/"
DEFAULT_API_URL = "https://api.goassay.ai/api/v1"
_LOOPBACK = {"localhost", "127.0.0.1", "::1"}


def _check_url(name: str, value: str) -> str:
    u = urlsplit(value)
    if (
        not (u.scheme == "https" or (u.scheme == "http" and (u.hostname or "") in _LOOPBACK))
        or u.username
        or u.password
    ):
        raise ConfigError(f"{name} must be an https URL")
    return value


def _build_context(
    *,
    api_key: str | None,
    mcp_url: str,
    api_url: str,
    signer: Signer | None,
    signers: Sequence[Signer] | None,
    networks: Mapping[str, Mapping[str, Any]] | None,
    limits: Mapping[str, str] | None,
    on_payment: Callable[[dict[str, Any]], Any] | None,
    timeout: float,
    max_retries: int,
    logger: Logger | None,
    now: Callable[[], float],
) -> Context:
    key = (api_key if api_key is not None else os.environ.get("ASSAY_API_KEY", "")).strip()
    if not key:
        raise ConfigError("an API key is required: pass api_key or set ASSAY_API_KEY")
    if not re.fullmatch(r"[\x21-\x7e]+", key):
        raise ConfigError("api_key is not valid")
    _check_url("mcp_url", mcp_url)
    api_url = _check_url("api_url", api_url).rstrip("/")
    all_signers = tuple(([signer] if signer is not None else []) + list(signers or []))
    for s in all_signers:
        if not isinstance(s, EvmSigner):
            raise ConfigError("a signer needs namespace, address and sign_typed_data")
    if len({s.namespace for s in all_signers}) != len(all_signers):
        raise ConfigError("give one signer per namespace")
    if not isinstance(max_retries, int) or not 0 <= max_retries <= 10:
        raise ConfigError("max_retries must be 0 to 10")
    if timeout <= 0:
        raise ConfigError("timeout must be positive")
    from goassay import __version__

    http = HttpConfig(
        api_key=key,
        origins=(origin_of(mcp_url), origin_of(api_url)),
        timeout=timeout,
        max_retries=max_retries,
        user_agent=f"goassay-python/{__version__} python/{platform.python_version()}",
        logger=logger,
        now=now,
    )
    table = eip155_networks(networks or {})
    ctx = Context(
        http=http,
        mcp_url=mcp_url,
        api_url=api_url,
        signers=all_signers,
        networks=table,
        on_payment=on_payment,
        max_retries=max_retries,
        now=now,
    )
    if any(s.namespace == "eip155" for s in all_signers):
        ctx.schemes["eip155"] = Eip155Scheme(
            networks=table,
            limits=check_limits(limits or DEFAULT_LIMITS),
            chain=ChainReader(now),
            quote=lambda tool: _tools.quote_for(ctx, tool),
            mcp_url=mcp_url,
            now=now,
            date_offset=lambda: http.date_offset,
        )
    return ctx


def _result(resp: httpx.Response) -> HttpResult:
    return HttpResult(resp.status_code, {k.lower(): v for k, v in resp.headers.items()}, resp.text)


def _http_error(err: httpx.HTTPError) -> NetworkError:
    if isinstance(err, httpx.TimeoutException):
        return TimeoutError()
    return NetworkError("could not reach Assay")


class _Base:
    _ctx: Context

    def __repr__(self) -> str:
        return f"{type(self).__name__}({self._ctx.mcp_url})"


class Assay(_Base):
    """The Assay client (sync). Stateless over HTTP; use it as a context manager to close it.

    - ``tools.search / get / call`` over MCP;
    - ``receipts.get`` to see what a call cost;
    - ``paid_calls.status / bind / wait_until_active`` to set up a payment key.

    Every option has a default: the API key from ``ASSAY_API_KEY``, ``mcp.goassay.ai`` and
    ``api.goassay.ai``, an ``httpx.Client``, 2 retries honouring ``Retry-After``, the system clock.
    """

    def __init__(
        self,
        *,
        api_key: str | None = None,
        mcp_url: str = DEFAULT_MCP_URL,
        api_url: str = DEFAULT_API_URL,
        signer: Signer | None = None,
        signers: Sequence[Signer] | None = None,
        networks: Mapping[str, Mapping[str, Any]] | None = None,
        limits: Mapping[str, str] | None = None,
        on_payment: Callable[[dict[str, Any]], bool | None] | None = None,
        http_client: httpx.Client | None = None,
        timeout: float = 120.0,
        max_retries: int = 2,
        logger: Logger | None = None,
        now: Callable[[], float] = time.time,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self._ctx = _build_context(
            api_key=api_key,
            mcp_url=mcp_url,
            api_url=api_url,
            signer=signer,
            signers=signers,
            networks=networks,
            limits=limits,
            on_payment=on_payment,
            timeout=timeout,
            max_retries=max_retries,
            logger=logger,
            now=now,
        )
        self._owns_client = http_client is None
        self._client = http_client or httpx.Client()
        self._sleep = sleep
        self.tools = Tools(self)
        self.receipts = Receipts(self)
        self.paid_calls = PaidCalls(self)

    def _run(self, flow: Flow[T]) -> T:
        value: Any = None
        exc: BaseException | None = None
        while True:
            try:
                op = flow.throw(exc) if exc is not None else flow.send(value)
            except StopIteration as stop:
                return stop.value  # type: ignore[no-any-return]
            value, exc = None, None
            try:
                value = self._do(op)
            except Exception as err:
                exc = err

    def _do(self, op: Any) -> Any:
        if isinstance(op, HttpOp):
            try:
                resp = self._client.request(
                    op.method, op.url, headers=op.headers, content=op.body, timeout=op.timeout, follow_redirects=False
                )
            except httpx.HTTPError as err:
                raise _http_error(err) from None
            return _result(resp)
        if isinstance(op, SleepOp):
            self._sleep(op.seconds)
            return None
        assert isinstance(op, CallOp)
        out = op.fn(*op.args)
        if inspect.isawaitable(out):
            if inspect.iscoroutine(out):
                out.close()
            raise ConfigError("an async signer or hook needs AsyncAssay")
        return out

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def __enter__(self) -> Assay:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()


class AsyncAssay(_Base):
    """The Assay client (async). Same API as :class:`Assay`; signers and hooks may be async."""

    def __init__(
        self,
        *,
        api_key: str | None = None,
        mcp_url: str = DEFAULT_MCP_URL,
        api_url: str = DEFAULT_API_URL,
        signer: Signer | None = None,
        signers: Sequence[Signer] | None = None,
        networks: Mapping[str, Mapping[str, Any]] | None = None,
        limits: Mapping[str, str] | None = None,
        on_payment: Callable[[dict[str, Any]], bool | None | Awaitable[bool | None]] | None = None,
        http_client: httpx.AsyncClient | None = None,
        timeout: float = 120.0,
        max_retries: int = 2,
        logger: Logger | None = None,
        now: Callable[[], float] = time.time,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self._ctx = _build_context(
            api_key=api_key,
            mcp_url=mcp_url,
            api_url=api_url,
            signer=signer,
            signers=signers,
            networks=networks,
            limits=limits,
            on_payment=on_payment,
            timeout=timeout,
            max_retries=max_retries,
            logger=logger,
            now=now,
        )
        self._owns_client = http_client is None
        self._client = http_client or httpx.AsyncClient()
        self._sleep = sleep
        self.tools = AsyncTools(self)
        self.receipts = AsyncReceipts(self)
        self.paid_calls = AsyncPaidCalls(self)

    async def _run(self, flow: Flow[T]) -> T:
        value: Any = None
        exc: BaseException | None = None
        while True:
            try:
                op = flow.throw(exc) if exc is not None else flow.send(value)
            except StopIteration as stop:
                return stop.value  # type: ignore[no-any-return]
            value, exc = None, None
            try:
                value = await self._do(op)
            except Exception as err:
                exc = err

    async def _do(self, op: Any) -> Any:
        if isinstance(op, HttpOp):
            try:
                resp = await self._client.request(
                    op.method, op.url, headers=op.headers, content=op.body, timeout=op.timeout, follow_redirects=False
                )
            except httpx.HTTPError as err:
                raise _http_error(err) from None
            return _result(resp)
        if isinstance(op, SleepOp):
            await self._sleep(op.seconds)
            return None
        assert isinstance(op, CallOp)
        out = op.fn(*op.args)
        return (await out) if inspect.isawaitable(out) else out

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def __aenter__(self) -> AsyncAssay:
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.aclose()


# --- resources: one module of flows per area, a thin sync and async face each ---------------


class Tools:
    def __init__(self, client: Assay) -> None:
        self._c = client

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
        return self._c._run(_tools.search(self._c._ctx, query, opts))

    def get(self, name: str) -> dict[str, Any]:
        """``get_tool``: one tool's description, schemas, price and version. Free."""
        return self._c._run(_tools.get(self._c._ctx, name))

    def call(
        self, name: str, arguments: dict[str, Any] | None = None, *, idempotency_key: str | None = None
    ) -> ToolResult:
        """Calls a tool; a paid tool is checked, signed once and retried with the same key."""
        return self._c._run(_tools.call(self._c._ctx, name, arguments or {}, idempotency_key))


class AsyncTools:
    def __init__(self, client: AsyncAssay) -> None:
        self._c = client

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
        return await self._c._run(_tools.search(self._c._ctx, query, opts))

    async def get(self, name: str) -> dict[str, Any]:
        return await self._c._run(_tools.get(self._c._ctx, name))

    async def call(
        self, name: str, arguments: dict[str, Any] | None = None, *, idempotency_key: str | None = None
    ) -> ToolResult:
        return await self._c._run(_tools.call(self._c._ctx, name, arguments or {}, idempotency_key))


class Receipts:
    def __init__(self, client: Assay) -> None:
        self._c = client

    def get(self, intent_id: str) -> dict[str, Any]:
        """The receipt of a call, by ``result.receipt["intentId"]``. Needs ``activity:read``."""
        return self._c._run(_receipts.get(self._c._ctx, intent_id))


class AsyncReceipts:
    def __init__(self, client: AsyncAssay) -> None:
        self._c = client

    async def get(self, intent_id: str) -> dict[str, Any]:
        return await self._c._run(_receipts.get(self._c._ctx, intent_id))


class PaidCalls:
    def __init__(self, client: Assay) -> None:
        self._c = client

    def status(self) -> PaidCallsStatus:
        """Where paid calls stand for this API key and this client's signer."""
        return self._c._run(_paid_calls.status(self._c._ctx))

    def bind(self, *, network: str | None = None) -> PaidCallsStatus:
        """Binds this client's EVM signer to the API key; a no-op when it is bound already.
        A person then approves the key at ``approval_url``, comparing the fingerprint."""
        return self._c._run(_paid_calls.bind(self._c._ctx, network))

    def wait_until_active(self, *, timeout: float = 900.0) -> PaidCallsStatus:
        """Polls until a person approved the key, for up to ``timeout`` seconds."""
        return self._c._run(_paid_calls.wait_until_active(self._c._ctx, timeout))


class AsyncPaidCalls:
    def __init__(self, client: AsyncAssay) -> None:
        self._c = client

    async def status(self) -> PaidCallsStatus:
        return await self._c._run(_paid_calls.status(self._c._ctx))

    async def bind(self, *, network: str | None = None) -> PaidCallsStatus:
        return await self._c._run(_paid_calls.bind(self._c._ctx, network))

    async def wait_until_active(self, *, timeout: float = 900.0) -> PaidCallsStatus:
        return await self._c._run(_paid_calls.wait_until_active(self._c._ctx, timeout))
