"""Channel vouchers (``channel-v1``): one cumulative EIP-712 ``ChannelVoucher`` per lane instead of one
voucher per call. Pure: no I/O, no clock, no randomness; the caller passes them in.

The client's side of the trust model:

- The server never names a cumulative. A lane's next pair is the client's own persisted
  ``(maxSigned + price, callsSigned + 1)``, or, after a refusal that did not store the voucher, exactly
  its own top pair again (an increase of zero).
- Local spend guards count the increase only (``cumulative - maxSigned``), never the cumulative.
- Before a lane is continued, its record is checked against the escrow's own state for the channel
  key (``channelBooks``): a record that does not cover what the chain shows is retired.
- The domain is the client's own escrow (``"Assay Settlement"``, ``"2"``, chainId, escrow); the
  server's ``domain`` is checked against it and never used.

Same rules, names and vectors (``vectors/eip155/channel.json``) as ``@goassay-ai/sdk/core``.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, NoReturn

from eth_utils.address import is_checksum_address, to_checksum_address
from eth_utils.crypto import keccak

from goassay._caip import parse_caip10
from goassay._errors import SignerRefusal
from goassay._voucher import VOUCHER_DOMAIN_NAME, VOUCHER_DOMAIN_VERSION, VOUCHER_LIFETIME_SECONDS

CHANNEL_SCHEME = "channel-v1"
PAYMENT_SCHEMES_META = "assay/paymentSchemes"
CHANNEL_REQUIRED_META = "assay/channelRequired"
CHANNEL_VOUCHER_META = "assay/channelVoucher"

# The seven signed fields, in the contract's order (``Types.sol``, ``CHANNEL_VOUCHER_TYPEHASH``).
CHANNEL_VOUCHER_TYPES: dict[str, list[dict[str, str]]] = {
    "ChannelVoucher": [
        {"name": "payer", "type": "address"},
        {"name": "provider", "type": "address"},
        {"name": "channelId", "type": "bytes32"},
        {"name": "cumulative", "type": "uint64"},
        {"name": "calls", "type": "uint32"},
        {"name": "issuedAt", "type": "uint64"},
        {"name": "expiresAt", "type": "uint64"},
    ],
}

MAX_CHANNEL_CUMULATIVE = 2**56 - 1
CHANNEL_CALLS_LIMIT = 2**24
MAX_LANES = 8
CHANNEL_MIN_LIFE_SECONDS = 60
LANE_CHECK_MAX_AGE_SECONDS = 600
LANE_IN_FLIGHT_MAX_SECONDS = 600
# A retired lane is kept past the 30 days after which Assay writes off a buyer debt, so a channel debt
# on it can still be renewed; the per-pool cap below bounds the record all the same.
RETIRED_LANE_KEEP_SECONDS = 31 * 86_400
# Renewable pairs kept per lane (newest last), so a debt's exact pair can be renewed.
LANE_PAIRS_KEPT = 64
# Life of a renew voucher: within the server's 300 s, with room for its 60 s minimum.
RENEW_LIFETIME_SECONDS = 240
CHANNEL_BOOK_VERSION = 1
# A re-armed top pair is signed again (an increase of 0) only while its first signature could still be
# settled and was signed less than 24 h ago; past that the lane is retired instead.
REUSE_MAX_AFTER_EXPIRY_SECONDS = 7200
REUSE_MAX_AGE_SECONDS = 86_400
# Retired lanes kept per pool at most; the oldest expired ones are dropped first.
MAX_RETIRED_LANES_PER_POOL = 16

PAYMENT_UNSETTLED_LIMIT = "PAYMENT_UNSETTLED_LIMIT"
CHANNEL_ROTATE = "CHANNEL_ROTATE"
CHANNEL_LIMIT = "CHANNEL_LIMIT"
CHANNEL_DESYNC = "CHANNEL_DESYNC"
CHANNEL_SIGNER_EXPIRING = "CHANNEL_SIGNER_EXPIRING"
CHANNEL_NOT_OFFERED = "CHANNEL_NOT_OFFERED"
PAYMENT_DEBT_OUTSTANDING = "PAYMENT_DEBT_OUTSTANDING"

# A buyer debt refuses the call before anything is stored: the lane is re-armed too.
_NOT_STORED = {
    PAYMENT_UNSETTLED_LIMIT,
    PAYMENT_DEBT_OUTSTANDING,
    CHANNEL_LIMIT,
    CHANNEL_SIGNER_EXPIRING,
    CHANNEL_NOT_OFFERED,
}
_UINT = re.compile(r"0|[1-9][0-9]*")
_CHANNEL_ID = re.compile(r"0x[0-9a-f]{64}")
_CAIP2 = re.compile(r"eip155:[1-9][0-9]*")
_ADDRESS = re.compile(r"0x[0-9a-fA-F]{40}")

_LANE_KEYS = (
    "channelId",
    "network",
    "escrow",
    "payer",
    "signer",
    "provider",
    "maxSigned",
    "callsSigned",
    "topIncrease",
    "lastIssuedAt",
    "lastExpiresAt",
    "reuseTop",
    "inFlightSince",
    "retired",
    "checkedAt",
)


def lane_outcome_of(code: str | None) -> str:
    """``served`` (admitted or replayed), ``reuse`` (refused without storing the voucher: sign the
    same top pair again next time) or ``retire`` (``CHANNEL_ROTATE``, any other refusal). With no
    answer the caller reports ``unknown``: retired as well, but the pair may have been stored, so it
    stays renewable. Only ``served`` and ``unknown`` keep the top pair renewable: after an explicit
    refusal the server did not store the voucher, and a renew of it would authorise a call never
    served."""
    if code is None:
        return "served"
    return "reuse" if code in _NOT_STORED else "retire"


def channel_fallback_of(code: str) -> str:
    """After a refused channel voucher: ``rotate`` (another lane), ``per-call`` or ``stop``."""
    if code == CHANNEL_ROTATE:
        return "rotate"
    if code in (CHANNEL_LIMIT, CHANNEL_SIGNER_EXPIRING, CHANNEL_NOT_OFFERED):
        return "per-call"
    return "stop"


class ChannelBookError(Exception):
    """A channel record that is damaged, or a lane step that its record does not allow."""


def empty_book() -> dict[str, Any]:
    return {"version": CHANNEL_BOOK_VERSION, "lanes": []}


# The largest integer a JSON number keeps exactly in every client (JavaScript's safe range).
MAX_SAFE_JSON_INT = 2**53 - 1


def json_int(v: object) -> int | None:
    """An integer read from JSON, as the Node client reads it: ``3`` and ``3.0`` (or ``3e0``) are the
    same number; anything outside the safe range ``|v| <= 2**53 - 1``, a fraction or a bool is
    ``None``. Both clients then accept and refuse exactly the same server and stored values."""
    if isinstance(v, bool):
        return None
    if isinstance(v, float):
        if not v.is_integer():
            return None
        v = int(v)
    if not isinstance(v, int) or abs(v) > MAX_SAFE_JSON_INT:
        return None
    return v


def _seconds(v: object) -> bool:
    n = json_int(v)
    return n is not None and n >= 0


_LANE_INTS = ("callsSigned", "lastIssuedAt", "lastExpiresAt", "inFlightSince", "checkedAt", "renewedIssuedAt")


def _checksummed(v: object) -> bool:
    return isinstance(v, str) and bool(_ADDRESS.fullmatch(v)) and is_checksum_address(v)


def _uint_str(v: object) -> bool:
    return isinstance(v, str) and bool(_UINT.fullmatch(v))


def parse_book(raw: object) -> dict[str, Any]:
    """A persisted book, checked field by field. Raises ``ChannelBookError`` for anything else: a
    damaged record is never reset or repaired."""
    if raw is None:
        return empty_book()
    if (
        not isinstance(raw, dict)
        or raw.get("version") != CHANNEL_BOOK_VERSION
        or not isinstance(raw.get("lanes"), list)
    ):
        raise ChannelBookError("channel record: invalid record")
    lanes = []
    ids: set[str] = set()
    for lane in raw["lanes"]:
        ok = (
            isinstance(lane, dict)
            and isinstance(lane.get("channelId"), str)
            and bool(_CHANNEL_ID.fullmatch(lane["channelId"]))
            and isinstance(lane.get("network"), str)
            and bool(_CAIP2.fullmatch(lane["network"]))
            and all(_checksummed(lane.get(k)) for k in ("escrow", "payer", "signer", "provider"))
            and _uint_str(lane.get("maxSigned"))
            and int(lane["maxSigned"]) <= MAX_CHANNEL_CUMULATIVE
            and _uint_str(lane.get("topIncrease"))
            and int(lane["topIncrease"]) <= int(lane["maxSigned"])
            and _seconds(lane.get("callsSigned"))
            and lane["callsSigned"] < CHANNEL_CALLS_LIMIT
            and _seconds(lane.get("lastIssuedAt"))
            and _seconds(lane.get("lastExpiresAt"))
            and isinstance(lane.get("reuseTop"), bool)
            and (lane.get("inFlightSince") is None or _seconds(lane.get("inFlightSince")))
            and isinstance(lane.get("retired"), bool)
            and (lane.get("checkedAt") is None or _seconds(lane.get("checkedAt")))
            and "inFlightSince" in lane
            and "checkedAt" in lane
        )
        if not ok:
            raise ChannelBookError("channel record: invalid lane")
        assert isinstance(lane, dict)
        if "renewedIssuedAt" in lane and not _seconds(lane["renewedIssuedAt"]):
            raise ChannelBookError("channel record: invalid lane")
        pairs = None
        if "renewable" in lane:
            pairs = _parse_pairs(lane["renewable"], int(lane["maxSigned"]), json_int(lane["callsSigned"]) or 0)
            if pairs is None:
                raise ChannelBookError("channel record: invalid lane: renewable")
        if lane["channelId"] in ids:
            raise ChannelBookError("channel record: invalid lane: duplicate channelId")
        ids.add(lane["channelId"])
        out = {k: lane[k] for k in _LANE_KEYS}
        if "renewedIssuedAt" in lane:
            out["renewedIssuedAt"] = lane["renewedIssuedAt"]
        for k in _LANE_INTS:
            if out.get(k) is not None:
                out[k] = json_int(out[k])  # 3.0 is stored back as 3
        if pairs is not None:
            out["renewable"] = pairs
        lanes.append(out)
    return {"version": CHANNEL_BOOK_VERSION, "lanes": lanes}


def _parse_pairs(raw: object, max_signed: int, calls_signed: int) -> list[list[Any]] | None:
    """A lane's ``renewable`` pairs, checked: strictly rising, never above its top pair. ``None`` when invalid."""
    if not isinstance(raw, list) or len(raw) > LANE_PAIRS_KEPT:
        return None
    out: list[list[Any]] = []
    last_c, last_n = 0, 0
    for p in raw:
        if not isinstance(p, list) or len(p) != 2 or not _uint_str(p[0]) or not _seconds(p[1]):
            return None
        c, n = int(p[0]), json_int(p[1])
        assert n is not None
        if c <= last_c or n <= last_n or c > max_signed or n > calls_signed:
            return None
        out.append([p[0], n])
        last_c, last_n = c, n
    return out


def _with_pair(pairs: list[list[Any]] | None, cumulative: int, calls: int) -> list[list[Any]]:
    """``renewable`` with ``[cumulative, calls]`` added at the end (once), the oldest dropped past the cap."""
    out = [list(p) for p in (pairs or [])]
    if not out or int(out[-1][0]) != cumulative or out[-1][1] != calls:
        out.append([str(cumulative), calls])
    return out[-LANE_PAIRS_KEPT:]


def _word(hex_value: str) -> bytes:
    return bytes.fromhex(hex_value[2:].rjust(64, "0"))


def channel_key(payer: str, signer: str, provider: str, channel_id: str) -> str:
    """The contract's channel key: ``keccak256(abi.encode(payer, signer, provider, channelId))``."""
    if not all(isinstance(a, str) and _ADDRESS.fullmatch(a) for a in (payer, signer, provider)) or not re.fullmatch(
        r"0x[0-9a-fA-F]{64}", channel_id
    ):
        raise ValueError("channel_key: bad input")
    return "0x" + keccak(_word(payer) + _word(signer) + _word(provider) + _word(channel_id)).hex()


def unpack_channel_state(state: int) -> tuple[int, int]:
    """``(settled, calls)`` of a packed channel slot (``ChannelDoor.unpack``)."""
    return state & MAX_CHANNEL_CUMULATIVE, (state >> 56) & (CHANNEL_CALLS_LIMIT - 1)


def lane_covers_chain(lane: Mapping[str, Any], settled: int, calls: int) -> bool:
    """Whether the lane's record covers the chain's state for its key: never settled above it."""
    return settled <= int(lane["maxSigned"]) and calls <= lane["callsSigned"]


def _in_pool(lane: Mapping[str, Any], pool: Mapping[str, str]) -> bool:
    return all(lane[k] == pool[k] for k in ("network", "escrow", "payer", "signer", "provider"))


def prune_book(book: Mapping[str, Any], now: int) -> dict[str, Any]:
    """A lane in flight for more than ``LANE_IN_FLIGHT_MAX_SECONDS`` is retired; a retired lane is
    dropped ``RETIRED_LANE_KEEP_SECONDS`` after its last voucher expired; at most
    ``MAX_RETIRED_LANES_PER_POOL`` retired lanes are kept per pool (the oldest expired ones go first)."""
    lanes = []
    for lane in book["lanes"]:
        if lane["inFlightSince"] is not None and now - lane["inFlightSince"] > LANE_IN_FLIGHT_MAX_SECONDS:
            lane = {**lane, "inFlightSince": None, "retired": True}
        if (
            lane["retired"]
            and lane["inFlightSince"] is None
            and now > lane["lastExpiresAt"] + RETIRED_LANE_KEEP_SECONDS
        ):
            continue
        lanes.append(lane)
    by_pool: dict[tuple[str, ...], list[dict[str, Any]]] = {}
    for lane in lanes:
        if lane["retired"] and lane["inFlightSince"] is None:
            key = tuple(lane[k] for k in ("network", "escrow", "payer", "signer", "provider"))
            by_pool.setdefault(key, []).append(lane)
    drop: set[str] = set()
    for retired in by_pool.values():
        expired = sorted((x for x in retired if now > x["lastExpiresAt"]), key=lambda x: x["lastExpiresAt"])
        over = len(retired) - MAX_RETIRED_LANES_PER_POOL
        for x in expired[: max(0, over)]:
            drop.add(x["channelId"])
    return {"version": CHANNEL_BOOK_VERSION, "lanes": [x for x in lanes if x["channelId"] not in drop]}


def reuse_is_fresh(lane: Mapping[str, Any], now: int) -> bool:
    """Whether the lane's re-armed top pair may still be signed again as an increase of 0 at ``now``."""
    expires: int = lane["lastExpiresAt"]
    issued: int = lane["lastIssuedAt"]
    return now <= expires + REUSE_MAX_AFTER_EXPIRY_SECONDS and now - issued <= REUSE_MAX_AGE_SECONDS


def forget_checks(book: Mapping[str, Any]) -> dict[str, Any]:
    """Every lane marked unchecked: for the first read of a stored record in a process."""
    return {"version": CHANNEL_BOOK_VERSION, "lanes": [{**lane, "checkedAt": None} for lane in book["lanes"]]}


def _can_carry(lane: Mapping[str, Any], price: int, rotate_at: int, now: int) -> bool:
    if lane["reuseTop"]:
        # A stale re-armed pair is never re-signed for free: the lane is retired instead.
        return int(lane["topIncrease"]) == price and reuse_is_fresh(lane, now)
    nxt = int(lane["maxSigned"]) + price
    return nxt <= rotate_at and nxt <= MAX_CHANNEL_CUMULATIVE and lane["callsSigned"] + 1 < CHANNEL_CALLS_LIMIT


@dataclass(frozen=True)
class LanePick:
    book: dict[str, Any]
    lane: dict[str, Any] | None
    needs_check: bool = False
    reason: str = ""


def pick_lane(
    book: Mapping[str, Any],
    pool: Mapping[str, str],
    price: int,
    *,
    max_lanes: int,
    rotate_at: int,
    now: int,
    new_channel_id: Callable[[], str],
) -> LanePick:
    """A free lane of ``pool`` for one call of ``price``, or a new one when the pool has room. A lane
    that can no longer carry the call is retired on the way. Nothing is advanced here."""
    if price <= 0:
        return LanePick(dict(book), None, reason="the price is not positive")
    pruned = prune_book(book, now)
    lanes = [
        {**lane, "retired": True}
        if _in_pool(lane, pool)
        and not lane["retired"]
        and lane["inFlightSince"] is None
        and not _can_carry(lane, price, rotate_at, now)
        else lane
        for lane in pruned["lanes"]
    ]
    nxt = {"version": CHANNEL_BOOK_VERSION, "lanes": lanes}
    live = [lane for lane in lanes if _in_pool(lane, pool) and not lane["retired"]]
    free = next((lane for lane in live if lane["inFlightSince"] is None), None)
    if free is not None:
        checked = free["checkedAt"]
        stale = free["callsSigned"] > 0 and (
            checked is None or now - checked > LANE_CHECK_MAX_AGE_SECONDS or checked > now + 120
        )
        return LanePick(nxt, free, needs_check=stale)
    if len(live) >= min(MAX_LANES, max_lanes):
        return LanePick(nxt, None, reason="every lane is busy")
    if price > rotate_at or price > MAX_CHANNEL_CUMULATIVE:
        return LanePick(nxt, None, reason="the price is above the lane limit")
    channel_id = new_channel_id()
    if (
        not isinstance(channel_id, str)
        or not _CHANNEL_ID.fullmatch(channel_id)
        or any(lane["channelId"] == channel_id for lane in lanes)
    ):
        return LanePick(nxt, None, reason="no new channel id")
    lane: dict[str, Any] = {
        "channelId": channel_id,
        **{k: pool[k] for k in ("network", "escrow", "payer", "signer", "provider")},
        "maxSigned": "0",
        "callsSigned": 0,
        "topIncrease": "0",
        "lastIssuedAt": 0,
        "lastExpiresAt": 0,
        "reuseTop": False,
        "inFlightSince": None,
        "retired": False,
        "checkedAt": now,
        "renewable": [],
    }
    return LanePick({"version": CHANNEL_BOOK_VERSION, "lanes": [*lanes, lane]}, lane)


def _replace(
    book: Mapping[str, Any], channel_id: str, change: Callable[[dict[str, Any]], dict[str, Any]]
) -> dict[str, Any]:
    found = False
    lanes = []
    for lane in book["lanes"]:
        if lane["channelId"] == channel_id:
            found = True
            lane = change(dict(lane))
        lanes.append(lane)
    if not found:
        raise ChannelBookError("channel record: the lane is gone")
    return {"version": CHANNEL_BOOK_VERSION, "lanes": lanes}


def record_check(book: Mapping[str, Any], channel_id: str, covered: bool, now: int) -> dict[str, Any]:
    """The lane after a chain check: ``covered`` marks it checked, otherwise it is retired."""
    return _replace(book, channel_id, lambda lane: {**lane, "checkedAt": now} if covered else {**lane, "retired": True})


@dataclass(frozen=True)
class LaneStep:
    book: dict[str, Any]
    channel_id: str
    cumulative: int
    calls: int
    increase: int
    issued_at: int
    expires_at: int


def advance_lane(
    book: Mapping[str, Any], channel_id: str, price: int, issued_at: int, lifetime: int, now: int
) -> LaneStep:
    """Takes the lane for one call: the next pair from the lane's own record only, the lane marked
    in flight. Persist the returned book before signing."""
    lane = next((x for x in book["lanes"] if x["channelId"] == channel_id), None)
    if lane is None or lane["retired"] or lane["inFlightSince"] is not None:
        raise ChannelBookError("channel record: the lane is not free")
    if price <= 0:
        raise ChannelBookError("channel record: the price is not positive")
    previous = int(lane["maxSigned"])
    reuse = (
        lane["reuseTop"] and int(lane["topIncrease"]) == price and lane["callsSigned"] > 0 and reuse_is_fresh(lane, now)
    )
    if lane["reuseTop"] and not reuse:
        raise ChannelBookError("channel record: a reuse is only for the same price, while the pair is fresh")
    cumulative = previous if reuse else previous + price
    calls = lane["callsSigned"] if reuse else lane["callsSigned"] + 1
    increase = cumulative - previous
    if cumulative > MAX_CHANNEL_CUMULATIVE or calls >= CHANNEL_CALLS_LIMIT or calls < 1:
        raise ChannelBookError("channel record: the lane is full")
    if increase != (0 if reuse else price):
        raise ChannelBookError("channel record: the increase is not the price")
    issued = max(issued_at, lane["lastIssuedAt"], lane.get("renewedIssuedAt", 0))
    expires = issued + lifetime
    nxt = _replace(
        book,
        channel_id,
        lambda x: {
            **x,
            # Write-ahead: renewable until the answer says otherwise (no answer keeps it: unknown).
            "renewable": _with_pair(x.get("renewable"), cumulative, calls),
            "maxSigned": str(cumulative),
            "callsSigned": calls,
            "topIncrease": str(price),
            "lastIssuedAt": issued,
            "lastExpiresAt": max(x["lastExpiresAt"], expires),
            "reuseTop": False,
            "inFlightSince": now,
        },
    )
    return LaneStep(nxt, lane["channelId"], cumulative, calls, increase, issued, expires)


def lane_signed_pair(lane: Mapping[str, Any], cumulative: int, calls: int) -> bool:
    """Whether ``(cumulative, calls)`` is renewable on ``lane``: a pair this client signed there whose
    voucher was served or whose outcome is unknown (``renewable``); for a record without that list,
    only the top pair of a lane neither retired nor re-armed."""
    if cumulative <= 0 or calls < 1 or cumulative > int(lane["maxSigned"]) or calls > lane["callsSigned"]:
        return False
    if "renewable" not in lane:
        return (
            not lane["retired"]
            and not lane["reuseTop"]
            and int(lane["maxSigned"]) == cumulative
            and lane["callsSigned"] == calls
        )
    return any(int(c) == cumulative and n == calls for c, n in lane["renewable"])


def renew_target(book: Mapping[str, Any], debt: Mapping[str, Any]) -> dict[str, Any] | None:
    """The one lane a debt can be renewed on: the lane it names (``channelId``), only when it is this
    client's lane of the same network, escrow, payer and signing key, not in flight (retired lanes
    too: a debt often outlives its lane), and the pair is renewable on it. ``None`` otherwise: no
    other lane is ever tried. ``debt`` holds ``channelId``, ``network``, ``escrow``, ``payer``,
    ``signer``, ``cumulative`` (int) and ``calls``."""
    lane = next((x for x in book["lanes"] if x["channelId"] == debt["channelId"]), None)
    if (
        lane is not None
        and lane["network"] == debt["network"]
        and lane["escrow"] == debt["escrow"]
        and lane["payer"] == debt["payer"]
        and lane["signer"] == debt["signer"]
        and lane["inFlightSince"] is None
        and lane_signed_pair(lane, debt["cumulative"], debt["calls"])
    ):
        return dict(lane)
    return None


@dataclass(frozen=True)
class RenewStep:
    book: dict[str, Any]
    channel_id: str
    cumulative: int
    calls: int
    issued_at: int
    expires_at: int


def renew_lane(
    book: Mapping[str, Any], channel_id: str, cumulative: int, calls: int, issued_at: int, lifetime: int
) -> RenewStep:
    """A renew (buyer-debt replacement): a renewable pair of this lane (signed here, and served or of
    unknown outcome), with fresh times. Nothing on the lane advances; only ``renewedIssuedAt`` is kept
    so a later voucher's ``issuedAt`` never goes below it. It authorises nothing above that pair,
    never a pair the server refused, so it is not counted as a new spend. Raises
    ``ChannelBookError`` for a pair not renewable on the lane, a lane in flight, or a bad life.
    Persist the returned book before signing."""
    lane = next((x for x in book["lanes"] if x["channelId"] == channel_id), None)
    if lane is None or lane["inFlightSince"] is not None:
        raise ChannelBookError("channel record: the lane is not free")
    if not lane_signed_pair(lane, cumulative, calls):
        raise ChannelBookError("channel record: this pair is not renewable on the lane")
    if not isinstance(lifetime, int) or not 1 <= lifetime <= 300:
        raise ChannelBookError("channel record: the renew life is out of range")
    issued = max(issued_at, lane["lastIssuedAt"], lane.get("renewedIssuedAt", 0))
    nxt = _replace(book, channel_id, lambda x: {**x, "renewedIssuedAt": issued})
    return RenewStep(nxt, lane["channelId"], cumulative, calls, issued, issued + lifetime)


def finish_lane(book: Mapping[str, Any], channel_id: str, outcome: str) -> dict[str, Any]:
    """Frees, re-arms or retires the lane after the server's answer (``served``, ``reuse``,
    ``retire``, ``unknown``; see ``lane_outcome_of``)."""

    def done(lane: dict[str, Any]) -> dict[str, Any]:
        out = {
            **lane,
            "inFlightSince": None,
            "reuseTop": outcome == "reuse",
            "retired": lane["retired"] or outcome in ("retire", "unknown"),
        }
        # An explicit refusal: the server did not store the top pair, so it is not renewable.
        if outcome in ("reuse", "retire") and "renewable" in lane:
            top = (lane["maxSigned"], lane["callsSigned"])
            out["renewable"] = [list(p) for p in lane["renewable"] if (p[0], p[1]) != top]
        return out

    return _replace(book, channel_id, done)


@dataclass(frozen=True)
class ChannelOffer:
    price: int
    lifetime_seconds: int
    max_lanes: int


def _same_account(a: object, b: object, chain_id: int) -> bool:
    pa, pb = parse_caip10(a), parse_caip10(b)
    return pa is not None and pb is not None and pa[0] == chain_id and pb[0] == chain_id and pa[1] == pb[1]


def check_channel_offer(raw: object, requirement: Mapping[str, Any], net: Mapping[str, Any]) -> ChannelOffer | str:
    """Checks the server's channel offer (``_meta["assay/channelRequired"]``) against the per-call
    requirement of the same answer (already through G1-G12) and the client's own network entry
    (``id``, ``chainId``, ``escrow``, ``asset``, ``decimals``). Returns the offer, or the reason it
    is refused. An offer for another contract is refused, never signed."""
    if not isinstance(raw, dict):
        return "the channel offer is not an object"
    if raw.get("scheme") != CHANNEL_SCHEME:
        return "the channel offer is not channel-v1"
    if raw.get("network") != net["id"] or requirement.get("network") != net["id"]:
        return "the channel offer is for another network"
    d = raw.get("domain")
    if (
        not isinstance(d, dict)
        or len(d) != 4
        or d.get("name") != VOUCHER_DOMAIN_NAME
        or d.get("version") != VOUCHER_DOMAIN_VERSION
        or d.get("chainId") != net["chainId"]
        or isinstance(d.get("chainId"), bool)
        or not isinstance(d.get("verifyingContract"), str)
        or not _ADDRESS.fullmatch(d["verifyingContract"])
        or to_checksum_address(d["verifyingContract"]) != net["escrow"]
    ):
        return "the channel offer is not for the built-in escrow"
    if "primaryType" in raw and raw["primaryType"] != "ChannelVoucher":
        return "the channel offer is not a ChannelVoucher"
    chain_id = net["chainId"]
    if not _same_account(raw.get("payer"), requirement.get("payer"), chain_id):
        return "the channel offer names another payer"
    if not _same_account(raw.get("provider"), requirement.get("provider"), chain_id):
        return "the channel offer names another provider"
    if raw.get("delegate") is not None and not _same_account(
        raw.get("delegate"), requirement.get("delegate"), chain_id
    ):
        return "the channel offer names another payment key"
    if raw.get("providerId") != requirement.get("providerId"):
        return "the channel offer names another provider id"
    signers = raw.get("signers")
    if not isinstance(signers, list) or "delegate" not in signers:
        return "the channel offer does not accept a payment key signature"
    price, amount = raw.get("price"), requirement.get("amount")
    if (
        not isinstance(price, dict)
        or not isinstance(amount, dict)
        or not _uint_str(price.get("amount"))
        or price.get("amount") != amount.get("amount")
        or price.get("asset") != net["asset"]
        or price.get("asset") != amount.get("asset")
        or price.get("decimals") != net["decimals"]
        or price.get("decimals") != amount.get("decimals")
        or isinstance(price.get("decimals"), bool)
    ):
        return "the channel price is not the checked price"
    p = int(price["amount"])
    if p <= 0 or p > MAX_CHANNEL_CUMULATIVE:
        return "the channel price is out of range"
    max_life = raw.get("maxLifeSeconds", 300)
    min_life = raw.get("minLifeSeconds", CHANNEL_MIN_LIFE_SECONDS)
    if not _seconds(max_life) or not _seconds(min_life):
        return "the channel voucher life is out of range"
    max_life, min_life = json_int(max_life), json_int(min_life)
    assert max_life is not None and min_life is not None
    if not 1 <= max_life <= 300:
        return "the channel voucher life is out of range"
    lifetime = min(VOUCHER_LIFETIME_SECONDS, max_life)
    if lifetime < max(min_life, CHANNEL_MIN_LIFE_SECONDS) + 30:
        return "the channel voucher life is too short"
    cap = raw.get("maxOpenChannels", MAX_LANES)
    cap = json_int(cap)
    if cap is None or cap < 1:
        return "the open-channel cap is not readable"
    return ChannelOffer(p, lifetime, min(MAX_LANES, cap))


def _refuse(field: str, reason: str) -> NoReturn:
    raise SignerRefusal("the channel voucher", field, reason)


@dataclass(frozen=True)
class BuiltChannelVoucher:
    wire: dict[str, Any]
    typed_data: dict[str, Any]


def build_channel_voucher(
    lane: Mapping[str, Any],
    channel_id: str,
    cumulative: int,
    calls: int,
    issued_at: int,
    expires_at: int,
    net: Mapping[str, Any],
) -> BuiltChannelVoucher:
    """The wire voucher and the typed data for one lane step. Every value comes from the lane (the
    client's own record) and the client's network entry; the domain is the built-in escrow's."""
    if lane.get("network") != net["id"] or lane.get("escrow") != net["escrow"]:
        _refuse("network", "is not the client's network")
    if not _checksummed(lane.get("payer")) or not _checksummed(lane.get("provider")):
        _refuse("payer", "is not an address")
    if not isinstance(channel_id, str) or not _CHANNEL_ID.fullmatch(channel_id):
        _refuse("channelId", "is not 32 bytes of lower-case hex")
    if not isinstance(cumulative, int) or not 0 < cumulative <= MAX_CHANNEL_CUMULATIVE:
        _refuse("cumulative", "is out of range")
    if not isinstance(calls, int) or isinstance(calls, bool) or not 1 <= calls < CHANNEL_CALLS_LIMIT:
        _refuse("calls", "is out of range")
    if not _seconds(issued_at) or issued_at <= 0:
        _refuse("issuedAt", "is not a positive integer")
    if not _seconds(expires_at) or not 0 < expires_at - issued_at <= 300:
        _refuse("expiresAt", "is out of range")
    wire = {
        "payer": lane["payer"],
        "provider": lane["provider"],
        "channelId": channel_id,
        "cumulative": str(cumulative),
        "calls": calls,
        "issuedAt": issued_at,
        "expiresAt": expires_at,
    }
    typed_data = {
        "domain": {
            "name": VOUCHER_DOMAIN_NAME,
            "version": VOUCHER_DOMAIN_VERSION,
            "chainId": net["chainId"],
            "verifyingContract": net["escrow"],
        },
        "types": CHANNEL_VOUCHER_TYPES,
        "primaryType": "ChannelVoucher",
        "message": {
            "payer": lane["payer"],
            "provider": lane["provider"],
            "channelId": bytes.fromhex(channel_id[2:]),
            "cumulative": cumulative,
            "calls": calls,
            "issuedAt": issued_at,
            "expiresAt": expires_at,
        },
    }
    return BuiltChannelVoucher(wire, typed_data)


def channel_voucher_envelope(
    voucher: dict[str, Any], signature: str, provider_id: str, contract_version: object
) -> dict[str, Any]:
    """``_meta["assay/channelVoucher"]`` (API-W2 section 1.3)."""
    out: dict[str, Any] = {"voucher": voucher, "signature": signature, "providerId": provider_id}
    if isinstance(contract_version, int) and not isinstance(contract_version, bool) and contract_version >= 1:
        out["contractVersion"] = contract_version
    return out
