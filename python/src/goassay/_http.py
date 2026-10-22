from __future__ import annotations

import json
import random
import re
import time
from dataclasses import dataclass, field
from email.utils import parsedate_to_datetime
from typing import Any, Protocol
from urllib.parse import urlsplit

from goassay import _ops
from goassay._clock import date_header_offset
from goassay._ops import Flow, HttpOp, HttpResult
from goassay.errors import NetworkError

RETRY_STATUSES = {408, 429, 500, 502, 503, 504}
RPC_RATE_LIMITED = -32029
MAX_RETRY_AFTER_SECONDS = 60.0
_BASE_DELAY = 0.5
_MAX_BACKOFF = 8.0

_SECRET_KEY = re.compile(r"authorization|api[-_]?key|signature|secret|private|token|voucher", re.I)
_LONG_HEX = re.compile(r"0x[0-9a-fA-F]{100,}")


class Logger(Protocol):
    def debug(self, msg: str, *args: Any, **kwargs: Any) -> None: ...
    def warning(self, msg: str, *args: Any, **kwargs: Any) -> None: ...


def redact(fields: dict[str, Any]) -> dict[str, Any]:
    """A copy of ``fields`` with anything that looks secret removed. Applied to every log line."""
    out: dict[str, Any] = {}
    for k, v in fields.items():
        if _SECRET_KEY.search(k):
            out[k] = "[redacted]"
        elif isinstance(v, str):
            out[k] = _LONG_HEX.sub("[redacted]", v)
        else:
            out[k] = v
    return out


def retry_after_seconds(value: str | None, now: float) -> float | None:
    """``Retry-After`` (seconds or an HTTP date) in seconds, or ``None``."""
    if value is None or not value.strip():
        return None
    v = value.strip()
    if re.fullmatch(r"[0-9]+", v):
        return float(v)
    try:
        return max(0.0, parsedate_to_datetime(v).timestamp() - now)
    except (TypeError, ValueError, IndexError, OverflowError):
        return None


def _rpc_rate_limit(text: str) -> tuple[bool, float | None]:
    if str(RPC_RATE_LIMITED) not in text:
        return False, None
    try:
        msg = json.loads(text)
    except ValueError:
        return False, None
    err = msg.get("error") if isinstance(msg, dict) else None
    if not isinstance(err, dict) or err.get("code") != RPC_RATE_LIMITED:
        return False, None
    data = err.get("data")
    ms = data.get("retryAfterMs") if isinstance(data, dict) else None
    ok = isinstance(ms, (int, float)) and not isinstance(ms, bool) and ms >= 0
    return True, (ms / 1000 if ok else None)  # type: ignore[operator]


@dataclass
class HttpConfig:
    api_key: str = field(repr=False)
    origins: tuple[str, ...]
    timeout: float
    max_retries: int
    user_agent: str
    logger: Logger | None
    now: Any = time.time
    date_offset: int = field(default=0)


def origin_of(url: str) -> str:
    p = urlsplit(url)
    return f"{p.scheme}://{p.netloc}"


def request(
    cfg: HttpConfig,
    method: str,
    url: str,
    *,
    headers: dict[str, str] | None = None,
    body: bytes | None = None,
    retry: bool,
) -> Flow[HttpResult]:
    """One origin-pinned request: the bearer goes only to the configured origins, redirects are
    refused, and retries back off and honour ``Retry-After``. Updates the clock offset."""
    if origin_of(url) not in cfg.origins:
        raise NetworkError("refusing a request to an origin the client was not configured for")
    attempts = cfg.max_retries + 1 if retry else 1
    all_headers = {
        "accept": "application/json",
        "user-agent": cfg.user_agent,
        **(headers or {}),
        "authorization": f"Bearer {cfg.api_key}",
    }
    attempt = 0
    while True:
        last = attempt + 1 >= attempts
        started = cfg.now()
        try:
            res = yield from _ops.http(HttpOp(method, url, all_headers, body, cfg.timeout))
        except NetworkError as err:
            _log(cfg, method, url, attempt, started, error=err.code)
            if last:
                raise
            yield from _ops.sleep(_backoff(attempt))
            attempt += 1
            continue
        _log(cfg, method, url, attempt, started, status=res.status)
        if 300 <= res.status < 400:
            raise NetworkError("refusing to follow a redirect")
        cfg.date_offset = date_header_offset(res.headers.get("date"), cfg.now())
        if not last:
            is_rpc_limit, rpc_wait = _rpc_rate_limit(res.text)
            if res.status in RETRY_STATUSES or is_rpc_limit:
                wait = retry_after_seconds(res.headers.get("retry-after"), cfg.now())
                wait = wait if wait is not None else rpc_wait
                if wait is None or wait <= MAX_RETRY_AFTER_SECONDS:
                    yield from _ops.sleep(wait if wait is not None else _backoff(attempt))
                    attempt += 1
                    continue
        return res


def _backoff(attempt: int) -> float:
    base: float = min(_MAX_BACKOFF, _BASE_DELAY * 2**attempt)
    return base * (0.75 + random.random() * 0.25)


def _log(cfg: HttpConfig, method: str, url: str, attempt: int, started: float, **extra: Any) -> None:
    if cfg.logger is None:
        return
    path = "/".join(urlsplit(url).path.split("/")[:4])
    fields = redact(
        {"method": method, "path": path, "attempt": attempt, "ms": round((cfg.now() - started) * 1000), **extra}
    )
    cfg.logger.debug("assay request %s", fields)
