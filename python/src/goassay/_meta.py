"""The ``_meta`` keys Assay reads and writes on MCP messages (spec section 3), and pure helpers."""

from __future__ import annotations

import json
import re
from typing import Any

IDEMPOTENCY_META = "assay/idempotency-key"
VOUCHER_META = "assay/voucher"
PAYMENT_REQUIRED_META = "x402/paymentRequired"
ERROR_META = "assay/error"
RECEIPT_META = "assay/receipt"
REPLAYED_META = "assay/replayed"
PRICE_META = "assay/price"

PAYMENT_REQUIRED_CODE = "PAYMENT_REQUIRED"
DELEGATE_INACTIVE_CODE = "PAYMENT_VOUCHER_DELEGATE_INACTIVE"
IN_PROGRESS_CODE = "IDEMPOTENCY_IN_PROGRESS"

SEARCH_TOOLS = "search_tools"
GET_TOOL = "get_tool"
CALL_TOOL = "call_tool"

_IDEMPOTENCY_KEY = re.compile(r"[\x20-\x7e]{1,128}")
_UINT = re.compile(r"0|[1-9][0-9]*")
_TOOL_NAME = re.compile(r"[A-Za-z0-9_-]{1,128}")


def is_idempotency_key(value: object) -> bool:
    return isinstance(value, str) and _IDEMPOTENCY_KEY.fullmatch(value) is not None


def is_tool_name(value: object) -> bool:
    """A tool name as sent to the server, unchanged: a standard ``verb_noun``, or a provider tool's
    ``{handle}__{tool}`` (for example ``acme__get_quote``). The server decides what it serves."""
    return isinstance(value, str) and _TOOL_NAME.fullmatch(value) is not None


def quote_of(price: object) -> dict[str, str] | None:
    """``assay/price`` reduced to what G3 reads: ``maxAmount`` (atomic) and its asset."""
    if not isinstance(price, dict):
        return None
    max_amount, asset = price.get("maxAmount"), price.get("asset")
    if not isinstance(max_amount, str) or not _UINT.fullmatch(max_amount) or len(max_amount) > 30:
        return None
    if not isinstance(asset, str) or not 0 < len(asset) <= 200:
        return None
    return {"maxAmount": max_amount, "asset": asset}


def structured_of(result: object) -> dict[str, Any] | None:
    """The structured output of a meta tool result (``structuredContent``, else the JSON text)."""
    if not isinstance(result, dict) or result.get("isError") is True:
        return None
    sc = result.get("structuredContent")
    if isinstance(sc, dict):
        return sc
    content = result.get("content")
    first = content[0] if isinstance(content, list) and content else None
    if isinstance(first, dict) and first.get("type") == "text" and isinstance(first.get("text"), str):
        try:
            parsed = json.loads(first["text"])
        except ValueError:
            return None
        return parsed if isinstance(parsed, dict) else None
    return None


def voucher_envelope(voucher: Any, signature: str, provider_id: str, contract_version: object) -> dict[str, Any]:
    """The ``assay/voucher`` envelope of the signed retry (spec section 6.4)."""
    out: dict[str, Any] = {"voucher": voucher, "signature": signature, "providerId": provider_id}
    if isinstance(contract_version, int) and not isinstance(contract_version, bool) and contract_version >= 1:
        out["contractVersion"] = contract_version
    return out


def fingerprint(address: str) -> str:
    """The payment key as people compare it: the last 8 hex digits, upper case, in two groups."""
    tail = address[-8:].upper()
    return f"{tail[:4]} {tail[4:]}"
