"""Binding a payment key for server-side integrators (spec section 5)."""

from __future__ import annotations

import re
from dataclasses import dataclass, replace
from typing import TYPE_CHECKING, Any, Literal
from urllib.parse import parse_qs, urlencode, urlsplit, urlunsplit

from eth_utils.address import to_checksum_address

from goassay import _ops
from goassay._caip import eip155_chain_id, parse_caip10
from goassay._context import Context
from goassay._eip155 import bind_evm_key
from goassay._meta import fingerprint
from goassay._ops import Flow
from goassay.errors import AssayError, ConfigError, PaymentNetworkUnknownError, ServerError
from goassay.signers import EvmSigner

if TYPE_CHECKING:
    from goassay._client import Assay, AsyncAssay

PaidCallsState = Literal["unbound", "pending_approval", "active", "expired", "bound_to_other_key", "unknown"]
_UUID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
_LOOPBACK = {"localhost", "127.0.0.1", "::1"}


@dataclass(frozen=True)
class PaidCallsStatus:
    state: PaidCallsState
    """``unbound``, ``pending_approval``, ``active``, ``expired``, ``bound_to_other_key``, or
    ``unknown`` (Assay could not read the key's grant from the chain just now; ask again)."""
    credential_id: str
    delegate: str | None
    """The bound key's ``0x`` address. While a new key waits for approval, still the old key."""
    pending_delegate: str | None
    """A key waiting for approval to replace ``delegate``."""
    caps: dict[str, str | None] | None
    """On-chain caps of the bound key in atomic units, when the server read them."""
    approval_url: str | None
    """Where a person approves this client's key: ``{web_url}/agents/enable-paid?credential=...#key=...``.
    The key travels only in the fragment. ``None`` without a signer."""
    fingerprint: str | None
    """This client's key as the approval page shows it (``1A2B 9F3C``)."""
    bound_at: str | None = None
    """When ``delegate`` was bound (ISO 8601)."""
    pending_since: str | None = None
    """When ``pending_delegate`` was proved (ISO 8601)."""
    already_bound: bool = False
    """From ``bind()``: the key was already bound (or already waiting) and nothing was signed."""
    bind_status: Literal["ACTIVE", "PENDING_APPROVAL"] | None = None
    """From ``bind()``: ``ACTIVE`` when this key is the bound key (a person still approves its caps
    on chain); ``PENDING_APPROVAL`` when another key stays bound and keeps signing until a person
    approves this one at ``approval_url``. ``None`` from ``status()``."""


def _address(caip10: object) -> str | None:
    p = parse_caip10(caip10)
    return p[1] if p else None


def approval_link(web_origin: str, server: object, credential_id: str, address: str | None) -> str | None:
    """The approval link, with this key only in the fragment (browsers never send it to a server).

    A link the server sent is used only when it is on the configured web origin and names this
    credential; otherwise the link is built from the web origin.
    """
    if address is None:
        return None
    base: tuple[str, str, str, str] | None = None
    if isinstance(server, str):
        try:
            u = urlsplit(server)
            same_origin = f"{u.scheme}://{u.netloc}" == web_origin and "@" not in u.netloc
            if same_origin and parse_qs(u.query).get("credential") == [credential_id]:
                base = (u.scheme, u.netloc, u.path, u.query)
        except ValueError:
            base = None
    if base is None:
        w = urlsplit(web_origin)
        base = (w.scheme, w.netloc, "/agents/enable-paid", urlencode({"credential": credential_id}))
    return urlunsplit((*base, f"key={address}"))


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
    if data.get("paidCallsUnknown") is True and delegate is not None and mine in (None, delegate):
        state = "unknown"
    elif mine is not None and pending == mine:
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
        bound_at=s(data.get("boundAt")),
        pending_since=s(data.get("pendingSince")),
        caps=caps,
        approval_url=approval_link(c.web_origin, data.get("approvalUrl"), data["credentialId"], mine),
        fingerprint=fingerprint(mine) if mine else None,
    )


def bind(c: Context, network: str | None) -> Flow[PaidCallsStatus]:
    signer = _signer(c)
    if signer is None:
        raise ConfigError("bind() needs an eip155 signer")
    current = yield from status(c)
    mine = to_checksum_address(signer.address)
    if current.delegate == mine:
        return replace(current, already_bound=True, bind_status="ACTIVE")
    if current.pending_delegate == mine:
        return replace(current, already_bound=True, bind_status="PENDING_APPROVAL")
    evm = [n for n in c.networks if n.startswith("eip155:")]
    nid = network if network is not None else (evm[0] if len(evm) == 1 else None)
    chain_id = eip155_chain_id(nid) if nid is not None and nid in c.networks else None
    if chain_id is None:
        if nid is None and len(evm) > 1:
            raise ConfigError("bind() needs `network` naming one of the eip155 networks")
        raise PaymentNetworkUnknownError(nid or "eip155")
    answer = yield from bind_evm_key(
        signer=signer, chain_id=chain_id, credential_id=current.credential_id, rest=c.rest, now=c.now
    )
    after = yield from status(c)
    pending = answer.get("status") == "PENDING_APPROVAL"
    return replace(after, bind_status="PENDING_APPROVAL" if pending else "ACTIVE")


def wait_until_active(c: Context, timeout: float) -> Flow[PaidCallsStatus]:
    """Polls until a person approved this client's key: ``delegate`` is this key and its paid calls
    are on. A key waiting to replace another one becomes ``delegate`` only when the approval lands.
    Every 5 s for 2 minutes, then every 15 s."""
    signer = _signer(c)
    mine = to_checksum_address(signer.address) if signer else None
    started = c.now()
    until = started + timeout
    while True:
        try:
            s = yield from status(c)
            if s.state == "active" and mine in (None, s.delegate):
                return s
        except AssayError as err:
            if not err.retryable:
                raise
        now = c.now()
        if now >= until:
            raise AssayError("WAIT_TIMEOUT", "paid calls were not approved in time", retryable=True)
        yield from _ops.sleep(min(until - now, 5.0 if now - started < 120 else 15.0))


class PaidCalls:
    def __init__(self, client: Assay) -> None:
        self._c = client

    def status(self) -> PaidCallsStatus:
        """Where paid calls stand for this API key and this client's signer."""
        return self._c._run(status(self._c._ctx))

    def bind(self, *, network: str | None = None) -> PaidCallsStatus:
        """Binds this client's EVM signer to the API key; a no-op when it is bound or waiting already.

        When another key is bound, this key waits as ``pending_delegate`` (``bind_status ==
        "PENDING_APPROVAL"``) and the old key keeps signing until a person approves the new one at
        ``approval_url``, comparing the fingerprint. Needs the ``payments`` scope. A key bound to
        another API key is refused with ``DelegateAlreadyBoundError`` (409)."""
        return self._c._run(bind(self._c._ctx, network))

    def wait_until_active(self, *, timeout: float = 900.0) -> PaidCallsStatus:
        """Polls until a person approved the key, for up to ``timeout`` seconds."""
        return self._c._run(wait_until_active(self._c._ctx, timeout))


class AsyncPaidCalls:
    def __init__(self, client: AsyncAssay) -> None:
        self._c = client

    async def status(self) -> PaidCallsStatus:
        return await self._c._run(status(self._c._ctx))

    async def bind(self, *, network: str | None = None) -> PaidCallsStatus:
        return await self._c._run(bind(self._c._ctx, network))

    async def wait_until_active(self, *, timeout: float = 900.0) -> PaidCallsStatus:
        return await self._c._run(wait_until_active(self._c._ctx, timeout))
