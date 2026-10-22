from __future__ import annotations

import math
from email.utils import parsedate_to_datetime

# The largest correction the HTTP ``Date`` header may apply to the local clock (spec section 7).
MAX_CLOCK_CORRECTION_SECONDS = 120


def date_header_offset(date_header: str | None, local_now: float) -> int:
    """The server's clock minus the local one, in whole seconds; 0 when the header is unreadable."""
    if not date_header:
        return 0
    try:
        server = parsedate_to_datetime(date_header).timestamp()
    except (TypeError, ValueError, IndexError, OverflowError):
        return 0
    return math.floor(server) - math.floor(local_now)


def corrected_now(local_now: float, offset: float) -> int:
    """Local time corrected by the offset, clamped to +-120 s."""
    if not math.isfinite(local_now) or local_now < 0:
        raise ValueError("the local clock is not a usable time")
    o = offset if math.isfinite(offset) else 0
    clamped = max(-MAX_CLOCK_CORRECTION_SECONDS, min(MAX_CLOCK_CORRECTION_SECONDS, o))
    return math.floor(local_now) + math.trunc(clamped)
