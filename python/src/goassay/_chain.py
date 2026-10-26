"""Read-only chain reads of the payment key's grant and caps (G4, G6).

Three escrow views at one pinned block on every RPC the caller listed; every RPC must answer
the same chain id and the same bytes, or there is no read (the guards then refuse).

The pinned block is ``min(heights) - 1``, so RPCs some blocks apart still agree; heights more than
``MAX_BLOCK_SPREAD`` apart refuse. A transient failure (an RPC error or timeout, or heights too
far apart) runs the whole read again, at most ``READ_ATTEMPTS`` times in all, after
``RETRY_DELAYS``; no new attempt starts once ``RETRY_WINDOW`` seconds have passed. Each attempt
pins its own block and needs every RPC again. A disagreement at the pinned block is never retried:
two RPCs serving different bytes for the same block is a real conflict, and a later attempt that
happens to agree would hide it. Another chain id, no block to pin and a malformed answer are final
too. Failures are not cached.
"""

from __future__ import annotations

import itertools
import json
import math
import re
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

from eth_utils.crypto import keccak

from goassay import _ops
from goassay._ops import Flow, HttpOp

CHAIN_CACHE_SECONDS = 600.0
# About 20 s on Robinhood Chain (~6 blocks/s), whose public RPCs are often 10 to 40 blocks apart.
# It only bounds how stale the pinned block can be; agreement comes from one explicit block.
MAX_BLOCK_SPREAD = 120
# Attempts of the whole read, including the first; the waits before the second and the third;
# and the time after which no new attempt starts (seconds).
READ_ATTEMPTS = 3
RETRY_DELAYS = (0.3, 1.0)
RETRY_WINDOW = 5.0
_MAX_RESPONSE_CHARS = 16 * 1024
_RPC_TIMEOUT = 5.0
_LOOPBACK = {"127.0.0.1", "localhost", "[::1]", "::1"}
_QUANTITY = re.compile(r"0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,15})")
_ids = itertools.count(1)
# An attempt that failed in a way another attempt may not (an RPC error, heights apart).
_TRANSIENT = object()


def _selector(signature: str) -> str:
    return keccak(text=signature)[:4].hex()


_DELEGATION_OF = _selector("delegationOf(address,address)")
_EFFECTIVE_CAPS_OF = _selector("effectiveCapsOf(address,address)")
_ESCROW_OF = _selector("escrowOf(address)")
_DELEGATION_WIDTHS = (64, 64, 64, 64, 64, 32, 1)
_CAPS_WIDTHS = (64, 64, 64, 64)
_ESCROW_WIDTHS = (128, 64, 64, 64, 64, 64, 64, 64, 64, 128, 128, 128)


def is_usable_rpc_url(value: str) -> bool:
    """https, or http to a loopback host; no credentials, query or fragment."""
    try:
        u = urlsplit(value)
    except ValueError:
        return False
    if u.username or u.password or u.query or u.fragment:
        return False
    return u.scheme == "https" or (u.scheme == "http" and (u.hostname or "") in _LOOPBACK)


@dataclass(frozen=True)
class ChainNetwork:
    id: str
    chain_id: int
    escrow: str
    rpc: tuple[str, ...]


def _word(address: str) -> str:
    return address[2:].lower().rjust(64, "0")


def _words(data: object, widths: tuple[int, ...]) -> list[int] | None:
    if not isinstance(data, str) or not re.fullmatch(r"0x[0-9a-f]*", data) or len(data) != 2 + 64 * len(widths):
        return None
    out = []
    for i, w in enumerate(widths):
        n = int(data[2 + i * 64 : 2 + (i + 1) * 64], 16)
        if n >> w:
            return None
        out.append(n)
    return out


def _quantity(value: object) -> int | None:
    return int(value, 16) if isinstance(value, str) and _QUANTITY.fullmatch(value) else None


class ChainReader:
    def __init__(self, now: Any, monotonic: Any = time.monotonic) -> None:
        self._now = now
        self._monotonic = monotonic
        self._cache: dict[tuple[str, str, str], tuple[float, dict[str, Any]]] = {}

    def read(self, net: ChainNetwork, payer: str, delegate: str) -> Flow[dict[str, Any] | None]:
        key = (net.id, payer, delegate)
        t = self._now()
        hit = self._cache.get(key)
        if hit and 0 <= t - hit[0] < CHAIN_CACHE_SECONDS:
            return hit[1]
        self._cache.pop(key, None)
        value = yield from self._read_with_retry(net, payer, delegate, math.floor(t))
        if value is not None:
            self._cache[key] = (t, value)
        return value

    def invalidate(self, net: str, payer: str, delegate: str) -> None:
        self._cache.pop((net, payer, delegate), None)

    def _read_with_retry(
        self, net: ChainNetwork, payer: str, delegate: str, read_at: int
    ) -> Flow[dict[str, Any] | None]:
        """The whole read, run again on a transient failure (see the module docstring)."""
        started = self._monotonic()
        attempt = 1
        while True:
            try:
                value = yield from self._read_once(net, payer, delegate, read_at)
            except Exception:
                value = _TRANSIENT
            if value is not _TRANSIENT:
                return value  # type: ignore[no-any-return]
            delay = RETRY_DELAYS[attempt - 1] if attempt - 1 < len(RETRY_DELAYS) else 0.0
            if attempt >= READ_ATTEMPTS or self._monotonic() - started + delay > RETRY_WINDOW:
                return None
            yield from _ops.sleep(delay)
            attempt += 1

    def _read_once(self, net: ChainNetwork, payer: str, delegate: str, read_at: int) -> Flow[Any]:
        """One attempt: the read, ``None`` (final) or ``_TRANSIENT``; an RPC that fails raises."""
        rpcs = net.rpc
        if not rpcs or len(set(rpcs)) != len(rpcs) or not all(is_usable_rpc_url(u) for u in rpcs):
            return None
        heights = []
        for url in rpcs:
            chain_id = _quantity((yield from self._call(url, "eth_chainId", [])))
            height = _quantity((yield from self._call(url, "eth_blockNumber", [])))
            if chain_id is None or height is None or chain_id != net.chain_id:
                return None
            heights.append(height)
        low, high = min(heights), max(heights)
        if high - low > MAX_BLOCK_SPREAD:
            return _TRANSIENT
        if low < 1:
            return None
        block = hex(low - 1)
        calls = [
            f"0x{_DELEGATION_OF}{_word(payer)}{_word(delegate)}",
            f"0x{_EFFECTIVE_CAPS_OF}{_word(payer)}{_word(delegate)}",
            f"0x{_ESCROW_OF}{_word(payer)}",
        ]
        answers = []
        for url in rpcs:
            row = []
            for data in calls:
                r = yield from self._call(url, "eth_call", [{"to": net.escrow, "data": data}, block])
                row.append(str(r).lower())
            answers.append(row)
        # A disagreement at the pinned block is final (no retry).
        if any(a != answers[0] for a in answers):
            return None
        d = _words(answers[0][0], _DELEGATION_WIDTHS)
        caps = _words(answers[0][1], _CAPS_WIDTHS)
        e = _words(answers[0][2], _ESCROW_WIDTHS)
        if d is None or caps is None or e is None:
            return None
        valid_until = d[4]
        return {
            "payer": payer,
            "delegate": delegate,
            "readAt": read_at,
            "active": valid_until != 0 and d[6] == 0,
            "validUntil": str(valid_until),
            "maxVoucherAmount": str(min(caps[0], e[3])),
            "delegateMaxVoucherAmount": str(min(caps[2], d[0])),
        }

    def _call(self, url: str, method: str, params: list[Any]) -> Flow[Any]:
        rid = next(_ids)
        body = json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params}).encode()
        headers = {"content-type": "application/json", "accept": "application/json"}
        res = yield from _ops.http(HttpOp("POST", url, headers, body, _RPC_TIMEOUT))
        if res.status != 200 or len(res.text) > _MAX_RESPONSE_CHARS:
            raise ValueError("rpc failed")
        msg = json.loads(res.text)
        if not isinstance(msg, dict) or msg.get("jsonrpc") != "2.0" or msg.get("id") != rid or "error" in msg:
            raise ValueError("rpc failed")
        if "result" not in msg:
            raise ValueError("rpc failed")
        return msg["result"]
