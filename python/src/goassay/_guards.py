"""The local guards G1-G12 (spec section 9), a line-for-line port of the Node core.

Pure: every input is in the context; no I/O, no clock, no state. Fail closed: a missing or
malformed value is a refusal, and ``check_all`` never raises. The guards run in order and the
first refusal is returned; ``vectors/eip155/guards.json`` pins the order, codes and boundaries.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any
from urllib.parse import unquote

from eth_utils.address import to_checksum_address

from goassay._caip import parse_caip10
from goassay._clock import MAX_CLOCK_CORRECTION_SECONDS

# What the SDK tells its caller to do in the G4 payer-changed reason (``{run}`` in the vectors).
RUN = "paid_calls.bind() and open"

FORWARDED_CALL_MAX_AGE_SECONDS = 120
CHAIN_READ_MAX_AGE_SECONDS = 600
CHAIN_READ_MAX_FUTURE_SECONDS = MAX_CLOCK_CORRECTION_SECONDS
SPEND_WINDOW_SECONDS = 86_400
MAX_SEQ_EXCLUSIVE = 2**53
MAX_RESOURCE_LENGTH = 2048
MAX_TIMEOUT_SECONDS = 300
TOOL_RESOURCE_PREFIX = "/mcp/tools/"
PAYER_CHANGED_REASON = f"payer changed; run {RUN} enable-paid"

_MAX_UINT64 = 2**64 - 1
_CANONICAL_UINT = re.compile(r"0|[1-9][0-9]*")
_CAIP2_EIP155 = re.compile(r"eip155:([1-9][0-9]*)")
_CAIP19_ERC20_ANY_CASE = re.compile(r"eip155:([1-9][0-9]*)/erc20:(0x[0-9a-fA-F]{40})")
_BARE_ADDRESS = re.compile(r"0x[0-9a-fA-F]{40}")
_LOCAL_ADDRESS = re.compile(r"(?:eip155:([1-9][0-9]*):)?(0x[0-9a-fA-F]{40})")
_REQUEST_HASH = re.compile(r"sha256:[0-9a-fA-F]{64}")
_TOOL_CALL_RESOURCE = re.compile(r"/mcp/tools/[A-Za-z0-9_-]+")
_DEBT_OR_SEQ_ENDPOINT = re.compile(r"/escrow/(debts|next-seq)(/|$)")
_USD = re.compile(r"(?:([0-9]+)(?:\.([0-9]+))?|\.([0-9]+))")
_CONFIRMATION_KEYS = ("tool", "provider", "amount", "asset", "network", "payTo", "seq")


@dataclass(frozen=True)
class GuardResult:
    ok: bool
    guard: str | None = None
    code: str | None = None
    reason: str | None = None


OK = GuardResult(ok=True)

# A key that is absent, which the Node core sees as `undefined`: never the same as `null`.
_MISSING = object()


class _Refusal(Exception):
    def __init__(self, guard: str, code: str, reason: str) -> None:
        super().__init__(reason)
        self.result = GuardResult(ok=False, guard=guard, code=code, reason=reason)


def _refuse(guard: str, code: str, reason: str) -> _Refusal:
    return _Refusal(guard, code, reason)


def _is_int(v: object) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _uint(value: object, maximum: int | None, allow_number: bool = False) -> int | None:
    n: int
    if isinstance(value, str) and _CANONICAL_UINT.fullmatch(value):
        n = int(value)
    elif allow_number and isinstance(value, int) and not isinstance(value, bool) and 0 <= value < 2**53:
        n = value
    else:
        return None
    return None if maximum is not None and n > maximum else n


def _seconds(value: object) -> int | None:
    if isinstance(value, int) and not isinstance(value, bool) and 0 <= value < 2**53:
        return value
    return None


def _requirement_account(value: object, chain_id: int) -> str | None:
    parsed = parse_caip10(value)
    return parsed[1] if parsed is not None and parsed[0] == chain_id else None


def _local_account(value: object, chain_id: int) -> str | None:
    m = _LOCAL_ADDRESS.fullmatch(value) if isinstance(value, str) else None
    if m is None:
        return None
    if m.group(1) is not None and int(m.group(1)) != chain_id:
        return None
    return to_checksum_address(m.group(2))


def _checksummed_address(value: object) -> str | None:
    if not isinstance(value, str) or not _BARE_ADDRESS.fullmatch(value):
        return None
    return value if to_checksum_address(value) == value else None


def _erc20(value: object) -> tuple[str, str] | None:
    m = _CAIP19_ERC20_ANY_CASE.fullmatch(value) if isinstance(value, str) else None
    return (m.group(1), m.group(2).lower()) if m else None


def _same_asset(a: object, b: object) -> bool:
    return isinstance(a, str) and a == b and _erc20(a) is not None


def usd_to_atomic(value: object, decimals: int) -> int | None:
    """Dollars as a decimal string (``"0.50"``) in atomic units, in exact integer arithmetic."""
    if not isinstance(value, str) or not _is_int(decimals) or decimals < 0:
        return None
    m = _USD.fullmatch(value)
    if m is None:
        return None
    whole = m.group(1) or "0"
    fraction = m.group(2) or m.group(3) or ""
    if len(fraction) > decimals:
        return None
    scale: int = 10**decimals
    return int(whole) * scale + int(fraction.ljust(decimals, "0") or "0")


def confirmation_for(ctx: dict[str, Any]) -> dict[str, str] | None:
    req, call = ctx.get("requirement"), ctx.get("forwardedCall")
    if not isinstance(req, dict) or not isinstance(call, dict) or not isinstance(req.get("amount"), dict):
        return None
    values = {
        "tool": call.get("tool"),
        "provider": req.get("provider"),
        "amount": req["amount"].get("amount"),
        "asset": req["amount"].get("asset"),
        "network": req.get("network"),
        "payTo": req.get("payTo"),
        "seq": req.get("seq"),
    }
    if not all(isinstance(v, str) for v in values.values()):
        return None
    return {k: str(v) for k, v in values.items()}


def _run(ctx: dict[str, Any]) -> GuardResult:
    # G1
    req = ctx.get("requirement")
    if not isinstance(req, dict):
        raise _refuse("G1", "G1_NOT_A_REQUIREMENT", "the payment request is not a requirement")
    if req.get("rail") != "B":
        raise _refuse("G1", "G1_RAIL", "the payment request is not on rail B")
    if req.get("scheme") != "voucher":
        raise _refuse("G1", "G1_SCHEME", "the payment request is not a voucher")
    call = ctx.get("forwardedCall")
    at = _seconds(call.get("at")) if isinstance(call, dict) else None
    if not isinstance(call, dict) or not isinstance(call.get("tool"), str) or not call["tool"] or at is None:
        raise _refuse("G1", "G1_NOT_FORWARDED", "the payment request is not the answer to a forwarded tool call")
    now = _seconds(ctx.get("nowSeconds"))
    if now is None or at > now or now - at > FORWARDED_CALL_MAX_AGE_SECONDS:
        raise _refuse("G1", "G1_FORWARD_TOO_OLD", "the payment request does not answer a tool call forwarded just now")
    tool: str = call["tool"]

    # G2
    net = ctx.get("network")
    chain_m = _CAIP2_EIP155.fullmatch(net["id"]) if isinstance(net, dict) and isinstance(net.get("id"), str) else None
    if not isinstance(net, dict) or chain_m is None or req.get("network") != net["id"]:
        raise _refuse("G2", "G2_NETWORK", "the network is not in the built-in table")
    chain_id = int(chain_m.group(1))
    escrow = parse_caip10(net.get("escrow"))
    pay_to = _requirement_account(req.get("payTo"), chain_id)
    if escrow is None or escrow[0] != chain_id or pay_to is None or pay_to != to_checksum_address(escrow[1]):
        raise _refuse("G2", "G2_PAY_TO", "the payment is not to the built-in escrow")
    money = req.get("amount")
    if not isinstance(money, dict):
        raise _refuse("G2", "G2_AMOUNT", "the amount is missing")
    net_asset = _erc20(net.get("asset"))
    if not _same_asset(money.get("asset"), net.get("asset")) or net_asset is None or net_asset[0] != chain_m.group(1):
        raise _refuse("G2", "G2_ASSET", "the asset is not the built-in asset")
    decimals = net.get("decimals")
    if (
        not isinstance(decimals, int)
        or isinstance(decimals, bool)
        or not 0 <= decimals <= 36
        or isinstance(money.get("decimals"), bool)
        or money.get("decimals") != decimals
    ):
        raise _refuse("G2", "G2_DECIMALS", "the asset decimals are not the built-in decimals")
    amount = _uint(money.get("amount"), _MAX_UINT64)
    if amount is None or amount == 0:
        raise _refuse("G2", "G2_AMOUNT", "the amount is not a positive integer")

    # G3
    quote = ctx.get("quote")
    qmax = _uint(quote.get("maxAmount"), _MAX_UINT64) if isinstance(quote, dict) else None
    if not isinstance(quote, dict) or qmax is None:
        raise _refuse("G3", "G3_NO_QUOTE", "there is no price quote for this tool")
    if not _same_asset(quote.get("asset"), money.get("asset")):
        raise _refuse("G3", "G3_QUOTE_ASSET", "the price quote is in another asset")
    if amount > qmax:
        raise _refuse("G3", "G3_ABOVE_QUOTE", "the amount is above the quoted price")

    # G4
    payer = _requirement_account(req.get("payer"), chain_id)
    if payer is None:
        raise _refuse("G4", "G4_PAYER_INVALID", "the payer is not a valid account")
    recorded = ctx.get("recordedPayer", _MISSING)
    if recorded is not None and _local_account(recorded, chain_id) != payer:
        raise _refuse("G4", "G4_PAYER_CHANGED", PAYER_CHANGED_REASON)
    chain = ctx.get("chain")
    no_read = _refuse("G4", "G4_NO_CHAIN_READ", "the payment key's grant could not be read from the chain")
    if not isinstance(chain, dict):
        raise no_read
    valid_until = _uint(chain.get("validUntil"), _MAX_UINT64, True)
    chain_payer = _local_account(chain.get("payer"), chain_id)
    chain_delegate = _checksummed_address(chain.get("delegate"))
    read_at = _seconds(chain.get("readAt"))
    if (
        valid_until is None
        or chain_payer is None
        or chain_delegate is None
        or read_at is None
        or not isinstance(chain.get("active"), bool)
    ):
        raise no_read
    if read_at - now > CHAIN_READ_MAX_FUTURE_SECONDS or now - read_at > CHAIN_READ_MAX_AGE_SECONDS:
        raise _refuse("G4", "G4_STALE_READ", "the chain read is too old")
    local = _local_account(ctx.get("localKey"), chain_id)
    if local is not None and chain_delegate != local:
        raise _refuse("G4", "G4_OTHER_KEY", "the chain read is for another payment key")
    if chain_payer != payer:
        raise _refuse("G4", "G4_NOT_DELEGATED", "the payer has not authorised this payment key")
    if chain["active"] is not True:
        raise _refuse("G4", "G4_INACTIVE", "the payment key's grant is not active")
    if valid_until <= now:
        raise _refuse("G4", "G4_EXPIRED", "the payment key's grant has expired")

    # G5
    if local is None:
        raise _refuse("G5", "G5_LOCAL_KEY_INVALID", "the local payment key is not readable")
    signers = req.get("signers")
    if not isinstance(signers, list) or "delegate" not in signers:
        raise _refuse("G5", "G5_NO_DELEGATE_SIGNER", "the server does not accept a payment key signature")
    if _requirement_account(req.get("delegate"), chain_id) != local:
        raise _refuse("G5", "G5_DELEGATE_MISMATCH", "the bound payment key is not this computer's key")
    if local == payer:
        raise _refuse("G5", "G5_LOCAL_KEY_IS_PAYER", "the local key is the payer")

    # G6
    delegate_max = _uint(chain.get("delegateMaxVoucherAmount"), _MAX_UINT64)
    escrow_max = _uint(chain.get("maxVoucherAmount"), _MAX_UINT64)
    if delegate_max is None or escrow_max is None:
        raise _refuse("G6", "G6_CAPS_UNREADABLE", "the on-chain caps could not be read")
    if amount > delegate_max:
        raise _refuse("G6", "G6_DELEGATE_CAP", "the amount is above the payment key's on-chain cap")
    if amount > escrow_max:
        raise _refuse("G6", "G6_ESCROW_CAP", "the amount is above the escrow's on-chain cap")

    # G7
    limits = ctx.get("limits")
    unreadable = _refuse("G7", "G7_LIMITS_UNREADABLE", "the local limits are not readable")
    if not isinstance(limits, dict):
        raise unreadable
    per_call = usd_to_atomic(limits.get("perCall"), decimals)
    per_day = usd_to_atomic(limits.get("perDay"), decimals)
    confirm_above_raw = limits.get("confirmAbove", _MISSING)
    confirm_above = None if confirm_above_raw is None else usd_to_atomic(confirm_above_raw, decimals)
    if per_call is None or per_day is None or (confirm_above_raw is not None and confirm_above is None):
        raise unreadable
    if amount > per_call:
        raise _refuse("G7", "G7_PER_CALL", "the amount is above the local limit per call")
    signed = ctx.get("signed")
    state = _refuse("G7", "G7_STATE_UNREADABLE", "the record of signed payments is not readable")
    if not isinstance(signed, list):
        raise state
    spent = 0
    for entry in signed:
        e_at = _seconds(entry.get("at")) if isinstance(entry, dict) else None
        e_amount = _uint(entry.get("amount"), _MAX_UINT64) if isinstance(entry, dict) else None
        if e_at is None or e_amount is None:
            raise state
        if e_at > now - SPEND_WINDOW_SECONDS:
            spent += e_amount
    if spent + amount > per_day:
        raise _refuse("G7", "G7_PER_DAY", "the amount would pass the local limit per 24 hours")

    # G8
    provider = _requirement_account(req.get("provider"), chain_id)
    if provider is None:
        raise _refuse("G8", "G8_PROVIDER_INVALID", "the provider is not a valid account")
    providers = limits.get("providers", _MISSING)
    if providers is not None:
        if not isinstance(providers, list):
            raise _refuse("G8", "G8_PROVIDERS_UNREADABLE", "the provider allow-list is not readable")
        allowed = [_local_account(p, chain_id) for p in providers]
        if None in allowed:
            raise _refuse("G8", "G8_PROVIDERS_UNREADABLE", "the provider allow-list is not readable")
        if provider not in allowed:
            raise _refuse("G8", "G8_PROVIDER_NOT_ALLOWED", "the provider is not in the allow-list")

    # G9
    seq = req.get("seq")
    if not (isinstance(seq, str) and re.fullmatch(r"[1-9][0-9]*", seq) and int(seq) < MAX_SEQ_EXCLUSIVE):
        raise _refuse("G9", "G9_SEQ", "the sequence number is out of range")

    # G10
    request_hash, resource, timeout = req.get("requestHash"), req.get("resource"), req.get("maxTimeoutSeconds")
    if not isinstance(request_hash, str) or not _REQUEST_HASH.fullmatch(request_hash):
        raise _refuse("G10", "G10_REQUEST_HASH", "the request hash is malformed")
    length = _code_points(resource) if isinstance(resource, str) else 0
    if length < 1 or length > MAX_RESOURCE_LENGTH:
        raise _refuse("G10", "G10_RESOURCE", "the resource length is out of range")
    if not _is_number_int(timeout) or not 1 <= timeout <= MAX_TIMEOUT_SECONDS:  # type: ignore[operator]
        raise _refuse("G10", "G10_MAX_TIMEOUT", "the timeout is out of range")

    # G11 (a per-URL paid list) is app-only: the SDK has no such list, so paid calls go through
    # whatever MCP URL the client was built for (spec section 9).

    # G12
    assert isinstance(resource, str)
    try:
        decoded = unquote(resource, errors="strict")
    except UnicodeDecodeError:
        decoded = resource
    for r in (resource, decoded):
        path = re.split(r"[?#]", r.lower())[0]
        if _DEBT_OR_SEQ_ENDPOINT.search(path):
            raise _refuse("G12", "G12_DEBT_OR_SEQ_ENDPOINT", "the payment is for a debt or sequence endpoint")
    if not _TOOL_CALL_RESOURCE.fullmatch(resource):
        raise _refuse("G12", "G12_NOT_A_TOOL_CALL", "the payment is not for a tool call")
    if resource != TOOL_RESOURCE_PREFIX + tool:
        raise _refuse("G12", "G12_OTHER_TOOL", "the payment is for another tool than the one called")

    # The G7 confirmation, last of all.
    given = ctx.get("confirmation", _MISSING)
    if given is not None and not isinstance(given, dict):
        raise _refuse("G7", "G7_CONFIRMATION_MISMATCH", "the confirmation is not readable")
    if confirm_above is None or amount <= confirm_above:
        return OK
    if given is None:
        raise _refuse(
            "G7", "G7_CONFIRMATION_REQUIRED", "the amount is above the confirmation limit and was not confirmed"
        )
    expected = confirmation_for(ctx)
    same = (
        expected is not None
        and len(given) == len(_CONFIRMATION_KEYS)
        and all(k in given and given[k] == expected[k] for k in _CONFIRMATION_KEYS)
    )
    if not same:
        raise _refuse("G7", "G7_CONFIRMATION_MISMATCH", "the confirmation was for another payment")
    return OK


def _code_points(s: str) -> int:
    # Python strings are code points already, except lone surrogates count as one each, as in JS.
    return len(s)


def _is_number_int(v: object) -> bool:
    if isinstance(v, bool):
        return False
    if isinstance(v, int):
        return True
    return isinstance(v, float) and v.is_integer()


def check_all(ctx: dict[str, Any]) -> GuardResult:
    """Runs G1..G12 in order (G11 is app-only), then the G7 confirmation. ``ok`` only when all pass; never raises."""
    try:
        if not isinstance(ctx, dict):
            return GuardResult(False, "G1", "G1_NOT_A_REQUIREMENT", "there is no payment request")
        return _run(ctx)
    except _Refusal as r:
        return r.result
    except Exception:
        return GuardResult(False, "G1", "G1_NOT_A_REQUIREMENT", "the payment request could not be checked")
