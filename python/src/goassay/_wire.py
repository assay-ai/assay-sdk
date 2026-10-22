"""The MCP transport (spec section 2.1) and the REST envelope (spec section 2.2), as flows."""

from __future__ import annotations

import itertools
import json
from typing import Any

from goassay import _http
from goassay._http import HttpConfig, retry_after_seconds
from goassay._ops import Flow
from goassay.errors import AssayError, RateLimitError, ServerError, error_from_server

MCP_PROTOCOL_VERSION = "2026-07-28"
_ids = itertools.count(1)


def _parse(text: str, content_type: str | None) -> Any:
    try:
        if content_type and "text/event-stream" in content_type:
            for line in text.splitlines():
                if line.startswith("data:"):
                    m = json.loads(line[5:].strip())
                    if isinstance(m, dict) and ("result" in m or "error" in m):
                        return m
            return None
        return json.loads(text)
    except ValueError:
        return None


def rest_error(status: int, text: str, retry_after: str | None, now: float) -> AssayError | None:
    """The platform's REST error envelope on a non-JSON-RPC answer, or ``None`` on a 2xx."""
    try:
        body = json.loads(text)
    except ValueError:
        body = None
    e = body.get("error") if isinstance(body, dict) and isinstance(body.get("error"), dict) else None
    if e is None and 200 <= status < 300:
        return None
    code = e.get("code") if e and isinstance(e.get("code"), str) else None
    message = e["message"] if e and isinstance(e.get("message"), str) else f"Assay answered HTTP {status}"
    details = e.get("context") if e and isinstance(e.get("context"), dict) else None
    return error_from_server(
        code, message, status=status, details=details, retry_after=retry_after_seconds(retry_after, now)
    )


def _rpc_error(error: dict[str, Any], status: int, retry_after: str | None, now: float) -> AssayError:
    message = error["message"] if isinstance(error.get("message"), str) else "the MCP request failed"
    data = error.get("data") if isinstance(error.get("data"), dict) else {}
    assert isinstance(data, dict)
    if error.get("code") == _http.RPC_RATE_LIMITED:
        ms = data.get("retryAfterMs")
        wait = ms / 1000 if isinstance(ms, (int, float)) else retry_after_seconds(retry_after, now)
        return RateLimitError("RATE_LIMITED", message, status=status, retry_after=wait)
    code = data["code"] if isinstance(data.get("code"), str) else f"MCP_RPC_{error.get('code')}"
    return error_from_server(code, message, status=status, details={"rpcCode": error.get("code")})


def mcp_request(cfg: HttpConfig, url: str, method: str, params: dict[str, Any]) -> Flow[dict[str, Any]]:
    """One JSON-RPC request per POST: no session, no handshake. Retries resend the same bytes."""
    meta = params.get("_meta") if isinstance(params.get("_meta"), dict) else {}
    body = {
        "jsonrpc": "2.0",
        "id": next(_ids),
        "method": method,
        "params": {
            **params,
            "_meta": {
                **(meta or {}),
                "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
                "io.modelcontextprotocol/clientCapabilities": {},
                "io.modelcontextprotocol/clientInfo": {"name": "goassay-python", "version": _version()},
            },
        },
    }
    headers = {
        "content-type": "application/json",
        "accept": "application/json, text/event-stream",
        "mcp-protocol-version": MCP_PROTOCOL_VERSION,
        "mcp-method": method,
    }
    if isinstance(params.get("name"), str):
        headers["mcp-name"] = params["name"]
    res = yield from _http.request(cfg, "POST", url, headers=headers, body=json.dumps(body).encode(), retry=True)
    msg = _parse(res.text, res.headers.get("content-type"))
    bad = ServerError("MCP_BAD_ANSWER", "Assay sent an answer the SDK cannot read", status=res.status)
    if not isinstance(msg, dict) or msg.get("jsonrpc") != "2.0":
        raise rest_error(res.status, res.text, res.headers.get("retry-after"), cfg.now()) or bad
    if isinstance(msg.get("error"), dict):
        raise _rpc_error(msg["error"], res.status, res.headers.get("retry-after"), cfg.now())
    result = msg.get("result")
    if not isinstance(result, dict):
        raise rest_error(res.status, res.text, res.headers.get("retry-after"), cfg.now()) or bad
    return result


def rest(cfg: HttpConfig, base: str, method: str, path: str, body: Any = None) -> Flow[tuple[Any, str | None]]:
    """``{data}`` and the ``Date`` header; a typed error from ``{error}`` otherwise. GETs retry."""
    headers = {"content-type": "application/json"} if body is not None else None
    res = yield from _http.request(
        cfg,
        method,
        f"{base}{path}",
        headers=headers,
        body=json.dumps(body).encode() if body is not None else None,
        retry=method == "GET",
    )
    if not 200 <= res.status < 300:
        raise rest_error(res.status, res.text, res.headers.get("retry-after"), cfg.now()) or ServerError(
            f"HTTP_{res.status}", f"Assay answered HTTP {res.status}", status=res.status
        )
    try:
        parsed = json.loads(res.text)
    except ValueError:
        parsed = None
    if not isinstance(parsed, dict) or "data" not in parsed:
        raise ServerError("API_BAD_ANSWER", "Assay sent an answer the SDK cannot read", status=res.status)
    return parsed["data"], res.headers.get("date")


def _version() -> str:
    from goassay import __version__

    return __version__
