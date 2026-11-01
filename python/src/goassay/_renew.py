"""Channel-debt renew (API-W2 sections 1.3 and 3.3).

A buyer debt on a payment channel can only be settled by the lane's own signer re-signing the exact
``(cumulative, calls)`` pair it already signed, with fresh times; the web portal cannot (it does not
hold the payment key), so the client does it:

- the debts come from ``GET /escrow/debts``; only ``CHANNEL`` debts that are ``OPEN`` or
  ``WRITTEN_OFF`` are renewed, per-call debts are left to the person (signed in the portal);
- the debt names its lane (``channel.channelId``); the renew is signed only on that lane, only when it
  is the client's own lane of the same network, escrow, payer and key, and only for a pair the client
  signed there whose voucher was served or whose outcome is unknown (``renew_target``): never a larger
  pair, never a pair the server refused, never another lane. A debt without a ``channelId`` is not
  renewed;
- a renew re-authorises only a total the escrow could already have settled for that lane, so no spend
  limit counts it;
- bounded: at most ``MAX_RENEWS_PER_RUN`` requests per run, one per debt, at most one signature per
  lane, no retry; at most one renewing run per ``AUTO_RENEW_INTERVAL_SECONDS``.

Same steps, names and vectors as ``@goassay-ai/sdk/core`` (``core/renew.ts``).
"""

from __future__ import annotations

import math
import re
from collections.abc import Mapping
from dataclasses import dataclass, replace
from typing import Any, Literal

from eth_utils.address import to_checksum_address

from goassay import _ops
from goassay._channel import (
    RENEW_LIFETIME_SECONDS,
    ChannelBookError,
    build_channel_voucher,
    json_int,
    renew_lane,
    renew_target,
)
from goassay._clock import corrected_now
from goassay._context import Context
from goassay._eip155 import Eip155Scheme, normalize_signature
from goassay._ops import Flow
from goassay.errors import AssayError

CHANNEL_DEBT_RENEWED_TEXT = (
    "Assay is collecting an earlier payment your agent already signed. "
    "Paid calls usually resume within about 5 minutes. This call was not charged."
)
# Every debt is being collected and one is a per-call debt a person settled in the portal (a
# per-call ``REPLACING`` debt, also one first paid on a channel): the agent did not sign it.
DEBT_COLLECTING_TEXT = (
    "Assay is collecting an earlier payment. "
    "Paid calls usually resume within about 5 minutes. This call was not charged."
)
CHANNEL_DEBT_RETRY_TEXT = (
    "Assay could not collect an earlier payment your agent signed yet. "
    "Call again in a minute or two. This call was not charged."
)
# The debts left are another wallet's of the same organization (the paid-call refusal is
# organization-wide): this agent has nothing to sign for them.
OTHER_WALLET_DEBT_TEXT = (
    "Another wallet in your organization owes an earlier payment. Paid calls resume once it is "
    "settled by that wallet's agent or in the Assay app. This call was not charged."
)
# Renew refusals that will not pass on a later try (the lane, the pair, the signer or the voucher
# is refused as such): the debt is settled in the portal instead. Any other code is retried later.
PERMANENT_RENEW_CODES = frozenset(
    {
        "CHANNEL_DESYNC",
        "CHANNEL_NOT_OFFERED",
        "CHANNEL_SIGNER_EXPIRING",
        "PAYMENT_VOUCHER_BINDING_MISMATCH",
        "PAYMENT_VOUCHER_SIGNATURE_INVALID",
        "PAYMENT_VOUCHER_MALFORMED",
        "PAYMENT_VOUCHER_DELEGATE_NOT_BOUND",
        "PAYMENT_VOUCHER_DELEGATE_INACTIVE",
    }
)
MAX_RENEWS_PER_RUN = 8
# The most channel debts one run looks at (the rest come back ``rate_limited``).
MAX_DEBTS_PER_RUN = 64
# Channel debts are renewed at most this often (manual or after a refused paid call).
AUTO_RENEW_INTERVAL_SECONDS = 60.0
_UUID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
_UINT = re.compile(r"0|[1-9][0-9]*")
_CHANNEL_ID = re.compile(r"0x[0-9a-fA-F]{64}")
# The payer as the API spells it: any letter case (the address is checksummed here).
_ACCOUNT = re.compile(r"eip155:([1-9][0-9]{0,15}):(0x[0-9a-fA-F]{40})")

DebtRenewalStatus = Literal[
    "renewed",
    "pending",
    "per_call",
    "no_lane",
    "not_signed_here",
    "other_wallet",
    "rate_limited",
    "refused",
    "failed",
]


@dataclass(frozen=True)
class DebtRenewal:
    """What a run did with one debt.

    ``status``: ``renewed`` (accepted; Assay collects it, paid calls resume once it is held on chain,
    usually within about 5 minutes), ``pending`` (being collected already), ``per_call`` (a person
    signs it in the portal), ``no_lane`` (the debt names no lane; nothing was signed),
    ``not_signed_here`` (the named lane is not this client's, or the pair is not renewable on it:
    another client, a lost record, or a voucher the server refused; nothing was signed),
    ``other_wallet`` (another wallet's debt of the same organization; nothing was signed),
    ``rate_limited`` (renewed a moment ago; see ``retry_after``), ``refused`` (``code``; nothing
    moved) or ``failed`` (no answer, or the signer or the record failed)."""

    intent_id: str
    status: DebtRenewalStatus
    channel_id: str | None = None
    cumulative: str | None = None
    calls: int | None = None
    code: str | None = None
    retry_after: float | None = None
    """Seconds, for ``rate_limited``."""
    format: Literal["PER_CALL"] | None = None
    """``"PER_CALL"`` on a ``pending`` per-call debt: a person signed its replacement, not this agent."""


def parse_debt_list(data: object) -> list[dict[str, Any]]:
    """The readable entries of a ``GET /escrow/debts`` answer (``data``); anything else is left out.
    A ``CHANNEL`` entry's ``channel`` holds ``cumulative`` (int), ``calls`` and ``channelId``
    (lower-case hex, or ``None`` when the server did not name it). ``otherWallet`` is ``True`` when
    the answer names the session's payer (``account``) and the debt is another wallet's of the same
    organization (listed because the paid-call refusal is organization-wide)."""
    raw = data.get("debts") if isinstance(data, dict) else None
    account_raw = data.get("account") if isinstance(data, dict) else None
    account = _ACCOUNT.fullmatch(account_raw) if isinstance(account_raw, str) else None
    own = account.group(2).lower() if account is not None else None
    out: list[dict[str, Any]] = []
    for d in raw if isinstance(raw, list) else []:
        if not isinstance(d, dict) or not isinstance(d.get("intentId"), str) or not _UUID.fullmatch(d["intentId"]):
            continue
        if d.get("state") not in ("OPEN", "REPLACING", "WRITTEN_OFF"):
            continue
        payer = _ACCOUNT.fullmatch(d["payer"]) if isinstance(d.get("payer"), str) else None
        if payer is None:
            continue
        fmt = "CHANNEL" if d.get("voucherFormat") == "CHANNEL" else "PER_CALL"
        channel = None
        if fmt == "CHANNEL":
            c = d.get("channel")
            calls = json_int(c.get("calls")) if isinstance(c, dict) else None
            if (
                not isinstance(c, dict)
                or not isinstance(c.get("cumulative"), str)
                or not _UINT.fullmatch(c["cumulative"])
                or calls is None
                or calls < 1
            ):
                continue
            lane = c.get("channelId")
            lane_id = lane.lower() if isinstance(lane, str) and _CHANNEL_ID.fullmatch(lane) else None
            channel = {"cumulative": int(c["cumulative"]), "calls": calls, "channelId": lane_id}
        entry: dict[str, Any] = {
            "intentId": d["intentId"].lower(),
            "state": d["state"],
            "format": fmt,
            "network": f"eip155:{payer.group(1)}",
            "payer": to_checksum_address(payer.group(2)),
            "channel": channel,
        }
        if own is not None and payer.group(2).lower() != own:
            entry["otherWallet"] = True
        out.append(entry)
    return out


def all_debts_collecting(results: list[DebtRenewal]) -> bool:
    """Whether every debt in ``results`` is being collected already (renewed now or before)."""
    return bool(results) and all(r.status in ("renewed", "pending") for r in results)


def _refused_for_good(r: DebtRenewal) -> bool:
    return r.status == "refused" and r.code in PERMANENT_RENEW_CODES


def some_debt_unrenewable(results: list[DebtRenewal]) -> bool:
    """Whether some debt can no longer be renewed by this client (``not_signed_here``, ``no_lane``,
    or ``refused`` with a ``PERMANENT_RENEW_CODES`` code)."""
    return any(r.status in ("not_signed_here", "no_lane") or _refused_for_good(r) for r in results)


def channel_debt_no_record_text(web: str) -> str:
    """The text an agent reads when a channel debt can no longer be renewed by this client."""
    return (
        "Your agent no longer has the payment record for an earlier channel payment. "
        f"Settle it in the Assay app at {web.rstrip('/')}/funding once it is offered there."
    )


def channel_debt_answer(results: list[DebtRenewal] | None, web: str) -> tuple[str, bool] | None:
    """What the agent reads after a paid call refused for a debt, ``(text, retryable)``: every debt
    being collected, ``CHANNEL_DEBT_RENEWED_TEXT`` (``DEBT_COLLECTING_TEXT`` when one of them is a
    per-call debt a person settled in the portal); a channel debt this client can no longer renew,
    (or one refused for good), ``channel_debt_no_record_text``; a per-call debt or no results,
    ``None`` (the server's refusal); a channel debt of another wallet of the organization,
    ``OTHER_WALLET_DEBT_TEXT``; only channel debts not renewed just now, ``CHANNEL_DEBT_RETRY_TEXT``."""
    if not results:
        return None
    if all_debts_collecting(results):
        by_person = any(r.status == "pending" and r.format == "PER_CALL" for r in results)
        return (DEBT_COLLECTING_TEXT if by_person else CHANNEL_DEBT_RENEWED_TEXT), True
    if some_debt_unrenewable(results):
        return channel_debt_no_record_text(web), False
    if any(r.status == "per_call" for r in results):
        return None
    if any(r.status == "other_wallet" for r in results):
        return OTHER_WALLET_DEBT_TEXT, False
    return CHANNEL_DEBT_RETRY_TEXT, True


def _pair_of(d: Mapping[str, Any]) -> dict[str, Any]:
    ch = d["channel"]
    return {"cumulative": str(ch["cumulative"]), "calls": ch["calls"], "channel_id": ch["channelId"]}


def renew_channel_debts(c: Context) -> Flow[list[DebtRenewal] | None]:
    """Lists the payer's debts and renews every ``CHANNEL`` debt this client signed, one request per
    debt and at most one signature per lane; one result per debt seen. At most one renewing run per
    ``AUTO_RENEW_INTERVAL_SECONDS`` (manual or automatic): within it the debts are only listed,
    nothing is signed, and an open channel debt comes back as the last run left it (``renewed`` as
    ``pending``; ``no_lane``, ``not_signed_here``, a permanent ``refused``) or ``rate_limited``.
    ``None`` when the client keeps no lanes or has no eip155 signer. Raises only when the debt list cannot be read."""
    scheme = c.schemes.get("eip155")
    signer = next((s for s in c.signers if s.namespace == "eip155"), None)
    if scheme is None or signer is None or scheme.channel_store is None:
        return None
    now = c.now()
    throttled = now < scheme.auto_renew_not_before
    retry_after = scheme.auto_renew_not_before - now if throttled else None
    previous: dict[str, Any] = scheme.last_renewals if throttled else {}
    if not throttled:
        scheme.auto_renew_not_before = now + AUTO_RENEW_INTERVAL_SECONDS
    local_key = to_checksum_address(signer.address)
    results: dict[str, DebtRenewal] = {}

    def later(d: Mapping[str, Any]) -> DebtRenewal:
        prev = previous.get(d["intentId"])
        status = prev.status if isinstance(prev, DebtRenewal) else None
        if status in ("renewed", "pending"):
            return DebtRenewal(d["intentId"], "pending", **_pair_of(d))
        if status in ("no_lane", "not_signed_here"):
            return DebtRenewal(d["intentId"], status, **_pair_of(d))
        if isinstance(prev, DebtRenewal) and _refused_for_good(prev):
            return DebtRenewal(d["intentId"], "refused", code=prev.code, **_pair_of(d))
        if d.get("otherWallet"):
            return DebtRenewal(d["intentId"], "other_wallet", **_pair_of(d))
        return DebtRenewal(d["intentId"], "rate_limited", retry_after=retry_after, **_pair_of(d))

    signed_lanes: set[str] = set()
    posts = looked = 0
    data, _ = yield from c.rest("GET", "/escrow/debts")
    entries = parse_debt_list(data)
    while True:
        for d in entries:
            if d["intentId"] in results:
                continue
            if d["state"] == "REPLACING":
                extra = _pair_of(d) if d["channel"] else {"format": "PER_CALL"}
                results[d["intentId"]] = DebtRenewal(d["intentId"], "pending", **extra)
            elif d["format"] == "PER_CALL":
                results[d["intentId"]] = DebtRenewal(d["intentId"], "per_call")
            elif d.get("otherWallet"):
                # Another wallet's lane: never signed here (its own agent renews it).
                results[d["intentId"]] = DebtRenewal(d["intentId"], "other_wallet", **_pair_of(d))
        if throttled or posts >= MAX_RENEWS_PER_RUN or looked >= MAX_DEBTS_PER_RUN:
            break
        todo = [d for d in entries if d["format"] == "CHANNEL" and d["intentId"] not in results]
        if not todo:
            break
        debt = max(todo, key=lambda d: d["channel"]["cumulative"])
        looked += 1
        lane = debt["channel"]["channelId"]
        # At most one signature per lane per run: a second debt on a lane already signed waits.
        if lane is not None and lane in signed_lanes:
            results[debt["intentId"]] = later(debt)
            continue
        result, signed, posted = yield from _renew_one(c, scheme, signer, local_key, debt)
        if signed and lane is not None:
            signed_lanes.add(lane)
        results[debt["intentId"]] = result
        if posted:
            posts += 1
            # Listed again after each request: one renew settles every lapsed call of its lane up to
            # the pair, so lower debts on that lane show as REPLACING now.
            try:
                data, _ = yield from c.rest("GET", "/escrow/debts")
            except Exception:
                break
            entries = parse_debt_list(data)
    # Channel debts not reached in this run (throttled, or past the per-run caps): later.
    for d in entries:
        if d["intentId"] not in results and d["format"] == "CHANNEL":
            results[d["intentId"]] = later(d)
    out = list(results.values())
    if not throttled:
        scheme.last_renewals = {r.intent_id: r for r in out}
    return out


def _renew_one(
    c: Context, scheme: Eip155Scheme, signer: Any, local_key: str, debt: dict[str, Any]
) -> Flow[tuple[DebtRenewal, bool, bool]]:
    """One debt: ``(result, signed, posted)``."""
    pair = debt["channel"]
    cumulative, calls, lane_id = pair["cumulative"], pair["calls"], pair["channelId"]
    intent = debt["intentId"]
    base = DebtRenewal(intent, "failed", cumulative=str(cumulative), calls=calls)
    if lane_id is None:
        return replace(base, status="no_lane"), False, False
    at = replace(base, channel_id=lane_id)
    entry = scheme.networks.get(debt["network"])
    if entry is None:
        return replace(at, status="not_signed_here"), False, False
    net = {
        "id": entry.id,
        "chainId": entry.chain_id,
        "escrow": to_checksum_address(entry.escrow),
        "asset": entry.asset,
        "decimals": entry.decimals,
    }
    want = {
        "channelId": lane_id,
        "network": entry.id,
        "escrow": net["escrow"],
        "payer": debt["payer"],
        "signer": local_key,
        "cumulative": cumulative,
        "calls": calls,
    }
    issued_at = corrected_now(math.floor(c.now()), scheme.date_offset())
    try:
        # Write-ahead: the renew's issuedAt is on record before it is signed.
        with scheme._book_lock:
            lane = renew_target(scheme._load_book(), want)
            if lane is None:
                return replace(at, status="not_signed_here"), False, False
            step = renew_lane(
                scheme._load_book(), lane["channelId"], cumulative, calls, issued_at, RENEW_LIFETIME_SECONDS
            )
            scheme._save_book(step.book)
        # The server takes issuedAt up to 60 s ahead of its clock; a lane ahead of that cannot renew now.
        if step.issued_at > issued_at + 60:
            return at, False, False
        built = build_channel_voucher(
            lane, step.channel_id, step.cumulative, step.calls, step.issued_at, step.expires_at, net
        )
    except ChannelBookError:
        return replace(at, status="not_signed_here"), False, False
    except Exception:
        return at, False, False
    try:
        raw = yield from _ops.call(signer.sign_typed_data, built.typed_data)
        signature = normalize_signature(raw)
    except Exception:
        return at, True, False
    body = {"channelVoucher": {"voucher": built.wire, "signature": signature}}
    try:
        yield from c.rest("POST", f"/escrow/debts/{intent}/voucher", body)
    except AssayError as err:
        if err.status is None:
            return at, True, True
        if err.code == "PAYMENT_DEBT_REPLACEMENT_PENDING":
            return replace(at, status="pending"), True, True
        if err.code == "PAYMENT_UNSETTLED_LIMIT":
            wait = getattr(err, "retry_after", None)
            secs = (err.details or {}).get("retryAfter")
            if wait is None and isinstance(secs, (int, float)) and not isinstance(secs, bool):
                wait = float(secs)
            return replace(at, status="rate_limited", code=err.code, retry_after=wait), True, True
        return replace(at, status="refused", code=err.code), True, True
    except Exception:
        return at, True, True
    return replace(at, status="renewed"), True, True
