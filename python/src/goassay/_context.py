from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from goassay import _wire
from goassay._eip155 import Eip155Scheme, NetworkEntry
from goassay._http import HttpConfig
from goassay._ops import Flow
from goassay.signers import EvmSigner


class QuoteCache:
    """G3's quotes, seen in ``search_tools`` and ``get_tool`` results, kept 60 s per tool."""

    def __init__(self, now: Callable[[], float]) -> None:
        self._now = now
        self._entries: dict[str, tuple[dict[str, str], float]] = {}

    def set(self, tool: str, quote: dict[str, str]) -> None:
        self._entries.pop(tool, None)
        self._entries[tool] = (dict(quote), self._now())
        if len(self._entries) > 2048:
            self._entries.pop(next(iter(self._entries)))

    def get(self, tool: str) -> dict[str, str] | None:
        e = self._entries.get(tool)
        if e is None:
            return None
        age = self._now() - e[1]
        if age < 0 or age > 60:
            self._entries.pop(tool, None)
            return None
        return dict(e[0])


@dataclass
class Context:
    """What every resource module shares. One resource area = one module that takes this."""

    http: HttpConfig
    mcp_url: str
    api_url: str
    signers: tuple[EvmSigner, ...]
    networks: dict[str, NetworkEntry]
    on_payment: Callable[[dict[str, Any]], Any] | None
    max_retries: int
    now: Callable[[], float] = time.time
    schemes: dict[str, Eip155Scheme] = field(default_factory=dict)
    quotes: QuoteCache = field(init=False)

    def __post_init__(self) -> None:
        self.quotes = QuoteCache(self.now)

    def mcp(self, method: str, params: dict[str, Any]) -> Flow[dict[str, Any]]:
        return _wire.mcp_request(self.http, self.mcp_url, method, params)

    def rest(self, method: str, path: str, body: Any = None) -> Flow[tuple[Any, str | None]]:
        return _wire.rest(self.http, self.api_url, method, path, body)
