"""Receipts: what a call cost."""

from __future__ import annotations

import re
from typing import Any

from goassay._context import Context
from goassay._ops import Flow
from goassay.errors import ConfigError, ServerError

_UUID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")


def get(c: Context, intent_id: str) -> Flow[dict[str, Any]]:
    """``GET /receipts/{intentId}``: ``intentId``, ``status``, ``listedPrice``, ``chargedPrice``,
    ``withheld`` (Money: atomic ``amount``, ``asset``, ``decimals``) and more. Needs ``activity:read``."""
    if not isinstance(intent_id, str) or not _UUID.fullmatch(intent_id):
        raise ConfigError("intent_id must be a UUID")
    data, _ = yield from c.rest("GET", f"/receipts/{intent_id}")
    if not isinstance(data, dict) or not isinstance(data.get("intentId"), str):
        raise ServerError("API_BAD_ANSWER", "the receipt answer is not readable")
    return data
