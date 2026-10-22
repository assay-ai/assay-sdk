"""Binding a payment key for server-side integrators (spec section 5)."""

from __future__ import annotations

import re
from dataclasses import dataclass, replace
from typing import Any, Literal
from urllib.parse import parse_qs, urlsplit, urlunsplit

from eth_utils.address import to_checksum_address

from goassay import _ops
from goassay._caip import eip155_chain_id, parse_caip10
from goassay._context import Context
from goassay._eip155 import bind_evm_key
from goassay._meta import fingerprint
from goassay._ops import Flow
from goassay.errors import AssayError, ConfigError, ServerError
from goassay.signers import EvmSigner

PaidCallsState = Literal["unbound", "pending_approval", "active", "expired", "bound_to_other_key"]
_UUID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
_LOOPBACK = {"localhost", "127.0.0.1", "::1"}


@dataclass(frozen=True)
class PaidCallsStatus:
    state: PaidCallsState
    """``unbound``, ``pending_approval``, ``active``, ``expired`` or ``bound_to_other_key``."""
    credential_id: str
    delegate: str | None
    """The bound key's ``0x`` address."""
    pending_delegate: str | None
    caps: dict[str, str | None] | None
    """On-chain caps of the bound key in atomic units, when the server read them."""
    approval_url: str | None
    """Where a person approves this client's key, from the server; ``None`` when it sent none."""
    fingerprint: str | None
    """This client's key as the approval page shows it (``1A2B 9F3C``)."""
    already_bound: bool = False
    """From ``bind()``: the key was already bound and nothing was signed."""


def _address(caip10: object) -> str | None:
    p = parse_caip10(caip10)
    return p[1] if p else None


def _approval_link(raw: object, credential_id: str, address: str | None) -> str | None:
    """The server's link with this key in the fragment (never sent to a server), or ``None``."""
    if not isinstance(raw, str) or address is None:
        return None
    try:
        u = urlsplit(raw)
    except ValueError:
        return None
    ok_scheme = u.scheme == "https" or (u.scheme == "http" and (u.hostname or "") in _LOOPBACK)
    if not ok_scheme or u.username or u.password or parse_qs(u.query).get("credential") != [credential_id]:
        return None
    return urlunsplit((u.scheme, u.netloc, u.path, u.query, f"key={address}"))


def _signer(c: Context) -> EvmSigner | None:
    return next((s for s in c.signers if s.namespace == "eip155"), None)


def status(c: Context) -> Flow[PaidCallsStatus]:
    data, _ = yield from c.rest("GET", "/agents/me/delegate")
    if (
        not isinstance(data, dict)
        or not isinstance(data.get("credentialId"), str)
        or not _UUID.fullmatch(data["credentialId"])
    ):
        raise ServerError("API_BAD_ANSWER", "the paid-call status is not readable")
    signer = _signer(c)
    mine = to_checksum_address(signer.address) if signer else None
    delegate, pending = _address(data.get("delegate")), _address(data.get("pendingDelegate"))
    paid = data.get("paidCalls") if isinstance(data.get("paidCalls"), dict) else None
    state: PaidCallsState
    if mine is not None and pending == mine:
        state = "pending_approval"
    elif delegate is None:
        state = "unbound"
    elif mine is not None and delegate != mine:
        state = "bound_to_other_key"
    elif paid and paid.get("status") == "ACTIVE":
        state = "active"
    elif paid and paid.get("status") == "EXPIRED":
        state = "expired"
    else:
        state = "pending_approval"

    def s(v: Any) -> str | None:
        return v if isinstance(v, str) else None

    caps = (
        {k: s(paid.get(k)) for k in ("maxVoucherAmount", "maxPerWindow", "spentInWindow", "validUntil")}
        if paid
        else None
    )
    return PaidCallsStatus(
        state=state,
        credential_id=data["credentialId"],
        delegate=delegate,
        pending_delegate=pending,
        caps=caps,
        approval_url=_approval_link(data.get("approvalUrl"), data["credentialId"], mine),
        fingerprint=fingerprint(mine) if mine else None,
    )


def bind(c: Context, network: str | None) -> Flow[PaidCallsStatus]:
    signer = _signer(c)
    if signer is None:
        raise ConfigError("bind() needs an eip155 signer")
    current = yield from status(c)
    mine = to_checksum_address(signer.address)
    if mine in (current.delegate, current.pending_delegate):
        return replace(current, already_bound=True)
    evm = [n for n in c.networks if n.startswith("eip155:")]
    nid = network if network is not None else (evm[0] if len(evm) == 1 else None)
    chain_id = eip155_chain_id(nid) if nid is not None else None
    if chain_id is None or nid not in c.networks:
        raise ConfigError("bind() needs one eip155 network in `networks`, or `network` naming one of them")
    answer = yield from bind_evm_key(
        signer=signer, chain_id=chain_id, credential_id=current.credential_id, rest=c.rest, now=c.now
    )
    after = yield from status(c)
    url = after.approval_url or _approval_link(answer.get("approvalUrl"), after.credential_id, mine)
    return replace(after, approval_url=url)


def wait_until_active(c: Context, timeout: float) -> Flow[PaidCallsStatus]:
    """Polls until a person approved the key: every 5 s for 2 minutes, then every 15 s."""
    started = c.now()
    until = started + timeout
    while True:
        try:
            s = yield from status(c)
            if s.state == "active":
                return s
        except AssayError as err:
            if not err.retryable:
                raise
        now = c.now()
        if now >= until:
            raise AssayError("WAIT_TIMEOUT", "paid calls were not approved in time", retryable=True)
        yield from _ops.sleep(min(until - now, 5.0 if now - started < 120 else 15.0))
