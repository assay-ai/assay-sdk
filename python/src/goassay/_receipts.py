"""Receipts: what a call cost."""

from __future__ import annotations

import re
from typing import TYPE_CHECKING, Any

from goassay._context import Context
from goassay._ops import Flow
from goassay.errors import ConfigError, ServerError

if TYPE_CHECKING:
    from goassay._client import Assay, AsyncAssay

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


class Receipts:
    def __init__(self, client: Assay) -> None:
        self._c = client

    def get(self, intent_id: str) -> dict[str, Any]:
        """The receipt of a call, by ``result.receipt["intentId"]``. Needs ``activity:read``."""
        return self._c._run(get(self._c._ctx, intent_id))


class AsyncReceipts:
    def __init__(self, client: AsyncAssay) -> None:
        self._c = client

    async def get(self, intent_id: str) -> dict[str, Any]:
        return await self._c._run(get(self._c._ctx, intent_id))
