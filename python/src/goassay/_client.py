from __future__ import annotations

import asyncio
import dataclasses
import inspect
import os
import platform
import re
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from typing import Any, TypeVar
from urllib.parse import urlsplit

import httpx

from goassay._chain import ChainReader
from goassay._context import Context
from goassay._eip155 import DEFAULT_LIMITS, Eip155Scheme, check_limits
from goassay._http import HttpConfig, Logger, origin_of
from goassay._mcp_url import DEFAULT_MCP_ORIGIN, redact_mcp_url, resolve_mcp_url
from goassay._networks import network_table
from goassay._ops import CallOp, Flow, HttpOp, HttpResult, SleepOp
from goassay._paid_calls import AsyncPaidCalls, PaidCalls
from goassay._receipts import AsyncReceipts, Receipts
from goassay._tools import AsyncTools, Tools
from goassay.errors import ConfigError, NetworkError, TimeoutError
from goassay.signers import EvmSigner, Signer

T = TypeVar("T")

DEFAULT_MCP_URL = "https://mcp.goassay.ai/"
DEFAULT_API_URL = "https://api.goassay.ai/api/v1"
# The web app, where a person approves a payment key.
DEFAULT_WEB_URL = "https://portal.goassay.ai"
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
    web_url: str,
    signer: Signer | None,
    signers: Sequence[Signer] | None,
    networks: Mapping[str, Mapping[str, Any]] | None,
    rpc_urls: Mapping[str, list[str]] | None,
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
    mcp_url = _check_url("mcp_url", resolve_mcp_url("mcp_url", mcp_url, DEFAULT_MCP_ORIGIN))
    api_url = _check_url("api_url", api_url).rstrip("/")
    web_origin = origin_of(_check_url("web_url", web_url))
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
    table = network_table(networks, rpc_urls)
    ctx = Context(
        http=http,
        mcp_url=mcp_url,
        api_url=api_url,
        signers=all_signers,
        networks=table,
        web_origin=web_origin,
        on_payment=on_payment,
        max_retries=max_retries,
        now=now,
    )
    if any(s.namespace == "eip155" for s in all_signers):
        ctx.schemes["eip155"] = Eip155Scheme(
            networks=table,
            limits=check_limits(limits or DEFAULT_LIMITS),
            chain=ChainReader(now),
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
        return f"{type(self).__name__}({redact_mcp_url(self._ctx.mcp_url)})"

    def _sibling_context(self, url_or_path: str) -> Context:
        """This client's context on another MCP URL: its own URL and quote cache, the rest shared."""
        origin = origin_of(self._ctx.mcp_url)
        url = resolve_mcp_url("url", url_or_path, origin)
        if origin_of(url) != origin:
            raise ConfigError("at() takes a path or a URL on this client's MCP origin; build a new client for another")
        return dataclasses.replace(self._ctx, mcp_url=url)


class Assay(_Base):
    """The Assay client (sync), for one MCP URL. Stateless over HTTP; use it as a context manager to
    close it.

    - ``tools.list / search / get / call`` over MCP;
    - ``receipts.get`` to see what a call cost;
    - ``paid_calls.status / bind / wait_until_active`` to set up a payment key;
    - ``at(url)`` for a client on another MCP URL that shares this one's key, signers and limits.

    ``mcp_url`` is a full URL or a path resolved against ``https://mcp.goassay.ai``, such as
    ``"/my/research"``, ``"/@acme/kit@3"`` or ``"/?tools=get_weather"``, checked against the URL
    shapes Assay serves. Paid calls go through whatever URL you choose.

    Every option has a default: the API key from ``ASSAY_API_KEY``, ``mcp.goassay.ai`` and
    ``api.goassay.ai``, ``portal.goassay.ai`` for the approval link, an ``httpx.Client``, 2 retries
    honouring ``Retry-After``, the system clock, and local limits of $0.50 a call and $5 per
    rolling 24 hours. ``networks=`` configures payment networks (chainId, escrow, asset, decimals,
    rpcUrls), merged over the SDK's built-in table: a new network is added, and an entry for a
    built-in network replaces it whole. ``rpc_urls=`` sets your own RPC URLs for a network.
    """

    def __init__(
        self,
        *,
        api_key: str | None = None,
        mcp_url: str = DEFAULT_MCP_URL,
        api_url: str = DEFAULT_API_URL,
        web_url: str = DEFAULT_WEB_URL,
        signer: Signer | None = None,
        signers: Sequence[Signer] | None = None,
        networks: Mapping[str, Mapping[str, Any]] | None = None,
        rpc_urls: Mapping[str, list[str]] | None = None,
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
            web_url=web_url,
            signer=signer,
            signers=signers,
            networks=networks,
            rpc_urls=rpc_urls,
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
        self.networks = self._ctx.networks
        """The payment network table in use: the built-in one with ``networks=`` merged, after ``rpc_urls=``."""
        self.tools = Tools(self)
        self.receipts = Receipts(self)
        self.paid_calls = PaidCalls(self)

    def at(self, url_or_path: str) -> Assay:
        """A client on another MCP URL: a full URL on this client's MCP origin, or a path resolved
        against it (``"/my/research"``, ``"/@acme/kit@3"``, ``"/?tools=get_weather"``). It shares
        this client's API key, HTTP client, logger, signers, spend limits and ledger, ``on_payment``
        and the in-flight calls by idempotency key, and has its own quote cache. Closing it does
        nothing; close the client it came from."""
        sibling = Assay.__new__(Assay)
        sibling._ctx = self._sibling_context(url_or_path)
        sibling._owns_client = False
        sibling._client = self._client
        sibling._sleep = self._sleep
        sibling.networks = self.networks
        sibling.tools = Tools(sibling, share=self.tools)
        sibling.receipts = Receipts(sibling)
        sibling.paid_calls = PaidCalls(sibling)
        return sibling

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
        web_url: str = DEFAULT_WEB_URL,
        signer: Signer | None = None,
        signers: Sequence[Signer] | None = None,
        networks: Mapping[str, Mapping[str, Any]] | None = None,
        rpc_urls: Mapping[str, list[str]] | None = None,
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
            web_url=web_url,
            signer=signer,
            signers=signers,
            networks=networks,
            rpc_urls=rpc_urls,
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
        self.networks = self._ctx.networks
        self.tools = AsyncTools(self)
        self.receipts = AsyncReceipts(self)
        self.paid_calls = AsyncPaidCalls(self)

    def at(self, url_or_path: str) -> AsyncAssay:
        """A client on another MCP URL, sharing everything but the URL and the quote cache; see
        :meth:`Assay.at`."""
        sibling = AsyncAssay.__new__(AsyncAssay)
        sibling._ctx = self._sibling_context(url_or_path)
        sibling._owns_client = False
        sibling._client = self._client
        sibling._sleep = self._sleep
        sibling.networks = self.networks
        sibling.tools = AsyncTools(sibling, share=self.tools)
        sibling.receipts = AsyncReceipts(sibling)
        sibling.paid_calls = AsyncPaidCalls(sibling)
        return sibling

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
