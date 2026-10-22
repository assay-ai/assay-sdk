"""The ``eip155`` payment scheme: EIP-712 vouchers and the EIP-712 key binding.

Guards G1-G12 run on one frozen copy of the requirement, the voucher is built from that same
copy and the caller's own network entry, and only then signed.
"""

from __future__ import annotations

import copy
import math
import re
import threading
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

from eth_utils.address import to_checksum_address

from goassay import _ops
from goassay._binding import check_binding_challenge
from goassay._caip import eip155_chain_id, parse_caip10, parse_caip19_erc20
from goassay._chain import ChainNetwork, ChainReader, is_usable_rpc_url
from goassay._clock import corrected_now, date_header_offset
from goassay._errors import SignerRefusal
from goassay._guards import GuardResult, check_all, usd_to_atomic
from goassay._meta import voucher_envelope
from goassay._ops import Flow
from goassay._voucher import build_voucher
from goassay.errors import ConfigError, PaymentError
from goassay.signers import EvmSigner

DEFAULT_LIMITS = {"max_per_call": "0.50", "max_per_day": "5"}
_SIGNATURE = re.compile(r"0x[0-9a-fA-F]{130}")


@dataclass(frozen=True)
class NetworkEntry:
    id: str
    chain_id: int
    escrow: str
    escrow_caip10: str
    asset: str
    decimals: int
    rpc: tuple[str, ...] = ()


def eip155_networks(
    table: Mapping[str, Mapping[str, Any]], fail: Callable[[str], Exception] = ConfigError
) -> dict[str, NetworkEntry]:
    """Checks a network table ``{caip2: {chainId?, escrow, asset, decimals, rpcUrls}}``. ``fail`` makes the
    error: ``ConfigError`` for the caller's own table, a server error for the API's."""
    out: dict[str, NetworkEntry] = {}
    for nid, n in table.items():
        if not nid.startswith("eip155:"):
            continue
        chain_id = eip155_chain_id(nid)
        escrow = parse_caip10(n.get("escrow"))
        asset = parse_caip19_erc20(n.get("asset"))
        if chain_id is None:
            raise fail(f"networks: {nid} is not a CAIP-2 eip155 chain")
        given_id = n.get("chainId")
        if given_id is not None and (isinstance(given_id, bool) or given_id != chain_id):
            raise fail(f"networks[{nid!r}].chainId is not {chain_id}")
        if escrow is None or escrow[0] != chain_id:
            raise fail(f"networks[{nid!r}].escrow must be a checksummed CAIP-10 account on {nid}")
        if asset is None or asset[0] != chain_id:
            raise fail(f"networks[{nid!r}].asset must be a checksummed CAIP-19 erc20 asset on {nid}")
        decimals = n.get("decimals")
        if not isinstance(decimals, int) or isinstance(decimals, bool) or not 0 <= decimals <= 36:
            raise fail(f"networks[{nid!r}].decimals is invalid")
        rpc = n.get("rpcUrls")
        if (
            not isinstance(rpc, (list, tuple))
            or not rpc
            or not all(isinstance(u, str) and is_usable_rpc_url(u) for u in rpc)
        ):
            raise fail(f"networks[{nid!r}].rpcUrls must list at least one https RPC URL")
        out[nid] = NetworkEntry(nid, chain_id, escrow[1], n["escrow"], n["asset"], decimals, tuple(rpc))
    return out


def check_limits(limits: Mapping[str, str]) -> dict[str, str]:
    per_call = usd_to_atomic(limits.get("max_per_call"), 6)
    per_day = usd_to_atomic(limits.get("max_per_day"), 6)
    if not per_call:
        raise ConfigError('limits["max_per_call"] must be a positive dollar amount such as "0.50"')
    if not per_day:
        raise ConfigError('limits["max_per_day"] must be a positive dollar amount such as "5"')
    if per_call > per_day:
        raise ConfigError("max_per_call must not be above max_per_day")
    return {"max_per_call": limits["max_per_call"], "max_per_day": limits["max_per_day"]}


@dataclass(frozen=True)
class Guarded:
    ok: bool
    refusal: GuardResult | None = None
    wire: dict[str, Any] | None = None
    typed_data: dict[str, Any] | None = None


def _no(guard: str, code: str, reason: str) -> Guarded:
    return Guarded(False, GuardResult(False, guard, code, reason))


def guard_and_build(ctx: dict[str, Any], issued_at: int, networks: Mapping[str, NetworkEntry]) -> Guarded:
    """The one path from a requirement to a voucher: guards and builder see the same copy, and
    the network the guards check is the caller's own entry for ``requirement.network``."""
    try:
        requirement = copy.deepcopy(ctx.get("requirement"))
    except Exception:
        return _no("G1", "G1_NOT_A_REQUIREMENT", "the payment request could not be copied")
    nid = requirement.get("network") if isinstance(requirement, dict) else None
    entry = networks.get(nid) if isinstance(nid, str) else None
    network = (
        {"id": entry.id, "escrow": entry.escrow_caip10, "asset": entry.asset, "decimals": entry.decimals}
        if entry
        else None
    )
    result = check_all({**ctx, "requirement": requirement, "network": network})
    if not result.ok:
        return Guarded(False, result)
    assert entry is not None and isinstance(requirement, dict)
    try:
        built = build_voucher(
            requirement,
            issued_at,
            {"caip2": entry.id, "escrow": entry.escrow_caip10, "asset": entry.asset, "decimals": entry.decimals},
        )
    except SignerRefusal as err:
        return _no("G1", "G1_NOT_A_REQUIREMENT", str(err))
    m = built.typed_data["message"]
    payer, provider = parse_caip10(requirement["payer"]), parse_caip10(requirement["provider"])
    same = (
        payer is not None
        and provider is not None
        and m["amount"] == int(requirement["amount"]["amount"])
        and m["seq"] == int(requirement["seq"])
        and m["payer"] == payer[1]
        and m["provider"] == provider[1]
        and built.typed_data["domain"]["verifyingContract"] == to_checksum_address(entry.escrow)
        and built.typed_data["domain"]["chainId"] == entry.chain_id
    )
    if not same:
        return _no("G1", "G1_NOT_A_REQUIREMENT", "the voucher differs from the checked requirement")
    return Guarded(True, wire=built.wire, typed_data=built.typed_data)


_SPEND_WINDOW = 86_400
# Vouchers signed in this process, by key: every client using one key shares one 24 h cap. One
# list per key, only ever changed in place and under the lock, so a reservation is always released
# from the list the guards read, and threads cannot both pass the cap. Per process only: not
# shared across processes or restarts; the on-chain caps are the bound across processes.
_LEDGER: dict[str, list[dict[str, Any]]] = {}
_LEDGER_LOCK = threading.Lock()


def _spent_by(address: str, now: int) -> list[dict[str, Any]]:
    """The key's ledger list, trimmed to the window. Call with ``_LEDGER_LOCK`` held."""
    entries = _LEDGER.setdefault(address.lower(), [])
    entries[:] = [e for e in entries if e["at"] > now - _SPEND_WINDOW]
    return entries


def reset_spend_ledger() -> None:
    """Tests only: forget every signed voucher of this process."""
    with _LEDGER_LOCK:
        _LEDGER.clear()


def _account_on(value: object, chain_id: int) -> str | None:
    p = parse_caip10(value)
    return p[1] if p is not None and p[0] == chain_id else None


def normalize_signature(value: object) -> str:
    sig = "0x" + value.hex() if isinstance(value, (bytes, bytearray)) else value
    if not isinstance(sig, str):
        raise PaymentError("SIGNER_FAILED", "the signer did not return a signature")
    if not sig.startswith("0x"):
        sig = "0x" + sig
    if not _SIGNATURE.fullmatch(sig):
        raise PaymentError("SIGNER_FAILED", "the signer did not return a 65-byte signature")
    return sig


@dataclass
class Prepared:
    details: dict[str, Any]
    typed_data: dict[str, Any]
    wire: dict[str, Any]
    provider_id: str
    contract_version: object
    signer: EvmSigner
    payer: str
    _signed: list[dict[str, Any]] = field(repr=False, default_factory=list)
    _reserved: dict[str, Any] = field(repr=False, default_factory=dict)
    _scheme: Eip155Scheme | None = field(repr=False, default=None)
    _used: bool = False

    def sign(self) -> Flow[dict[str, Any]]:
        """Signs the checked voucher, once; returns the ``assay/voucher`` envelope."""
        if self._used:
            raise RuntimeError("a voucher is signed at most once")
        self._used = True
        raw = yield from _ops.call(self.signer.sign_typed_data, self.typed_data)
        signature = normalize_signature(raw)
        if self._scheme is not None and self._scheme.recorded_payer is None:
            self._scheme.recorded_payer = self.payer
        return voucher_envelope(self.wire, signature, self.provider_id, self.contract_version)

    def release(self) -> None:
        with _LEDGER_LOCK:
            for i, e in enumerate(self._signed):
                if e is self._reserved:
                    del self._signed[i]
                    return


class Eip155Scheme:
    namespace = "eip155"

    def __init__(
        self,
        *,
        networks: Mapping[str, NetworkEntry],
        limits: Mapping[str, str],
        chain: ChainReader,
        quote: Callable[[str], Flow[dict[str, str] | None]],
        mcp_url: str,
        now: Callable[[], float],
        date_offset: Callable[[], int],
    ) -> None:
        self.networks = networks
        self.limits = limits
        self.chain = chain
        self.quote = quote
        self.mcp_url = mcp_url
        self.now = now
        self.date_offset = date_offset
        self.recorded_payer: str | None = None

    def prepare(
        self, *, requirement: Any, tool: str, called_at: int, signer: EvmSigner, idempotency_key: str
    ) -> Flow[Prepared | GuardResult]:
        try:
            local_key = to_checksum_address(signer.address)
        except (TypeError, ValueError):
            return GuardResult(False, "G5", "G5_LOCAL_KEY_INVALID", "the signer's address is not readable")
        networks = self.networks
        req = requirement if isinstance(requirement, dict) else None
        nid = req.get("network") if req else None
        entry = networks.get(nid) if isinstance(nid, str) else None
        payer = _account_on(req.get("payer"), entry.chain_id) if entry and req else None
        # Before any chain read, as the reference does: these refusals say what to do.
        if entry and req and payer == local_key:
            return GuardResult(
                False, "G5", "G5_LOCAL_KEY_IS_PAYER", "the signer is the payer; use a dedicated payment key"
            )
        if entry and req and _account_on(req.get("delegate"), entry.chain_id) != local_key:
            return GuardResult(
                False,
                "G5",
                "G5_DELEGATE_MISMATCH",
                "this signer is not the payment key bound to this API key; call paid_calls.bind() and approve it",
            )
        chain = None
        if entry and payer:
            net = ChainNetwork(entry.id, entry.chain_id, entry.escrow, entry.rpc)
            chain = yield from self.chain.read(net, payer, local_key)
        quote = yield from self.quote(tool)

        # No I/O from here to the spend record, and the ledger lock held throughout, so two calls in
        # flight (or two threads) cannot both pass the cap.
        with _LEDGER_LOCK:
            return self._guard_and_reserve(
                requirement,
                req,
                entry,
                payer,
                chain,
                quote,
                tool,
                called_at,
                signer,
                local_key,
                idempotency_key,
                networks,
            )

    def _guard_and_reserve(
        self,
        requirement: Any,
        req: dict[str, Any] | None,
        entry: NetworkEntry | None,
        payer: str | None,
        chain: dict[str, Any] | None,
        quote: dict[str, str] | None,
        tool: str,
        called_at: int,
        signer: EvmSigner,
        local_key: str,
        idempotency_key: str,
        networks: Mapping[str, NetworkEntry],
    ) -> Prepared | GuardResult:
        now = math.floor(self.now())
        signed = _spent_by(local_key, now)
        ctx = {
            "requirement": requirement,
            "forwardedCall": {"tool": tool, "at": called_at},
            "quote": quote,
            "chain": chain,
            "localKey": local_key,
            "recordedPayer": self.recorded_payer,
            "limits": {
                "perCall": self.limits["max_per_call"],
                "perDay": self.limits["max_per_day"],
                "confirmAbove": None,
                "providers": None,
            },
            "signed": signed,
            "confirmation": None,
            "canonicalUrl": self.mcp_url,
            "paidUrls": [self.mcp_url],
            "nowSeconds": now,
        }
        built = guard_and_build(ctx, corrected_now(now, self.date_offset()), networks)
        if not built.ok:
            assert built.refusal is not None
            if built.refusal.guard in ("G4", "G6") and entry and payer:
                self.chain.invalidate(entry.id, payer, local_key)
            return built.refusal
        assert req is not None and built.typed_data is not None and built.wire is not None
        provider_id = req.get("providerId")
        if not isinstance(provider_id, str) or not 0 < len(provider_id) <= 256:
            return GuardResult(False, "G1", "G1_NOT_A_REQUIREMENT", "the payment request names no provider")
        reserved = {"at": now, "amount": str(built.typed_data["message"]["amount"])}
        signed.append(reserved)
        return Prepared(
            details={
                "tool": tool,
                "network": req["network"],
                "amount": dict(built.wire["amount"]),
                "provider": req["provider"],
                "payer": req["payer"],
                "idempotency_key": idempotency_key,
            },
            typed_data=built.typed_data,
            wire=built.wire,
            provider_id=provider_id,
            contract_version=req.get("contractVersion"),
            signer=signer,
            payer=to_checksum_address(payer) if payer else "",
            _signed=signed,
            _reserved=reserved,
            _scheme=self,
        )

    def on_refused(self, code: str, requirement: Any, signer: EvmSigner) -> None:
        if code != "PAYMENT_VOUCHER_DELEGATE_INACTIVE" or not isinstance(requirement, dict):
            return
        networks = self.networks
        nid = requirement.get("network")
        entry = networks.get(nid) if isinstance(nid, str) else None
        payer = _account_on(requirement.get("payer"), entry.chain_id) if entry else None
        if entry and payer:
            self.chain.invalidate(entry.id, payer, to_checksum_address(signer.address))


def bind_evm_key(
    *,
    signer: EvmSigner,
    chain_id: int,
    credential_id: str,
    rest: Callable[[str, str, Any], Flow[tuple[Any, str | None]]],
    now: Callable[[], float],
) -> Flow[dict[str, Any]]:
    """Binds an EVM key to the API key's credential (spec section 5): challenge, field check,
    signature over typed data rebuilt from the SDK's constants, bind, and a check that the answer
    names this key (as ``delegate`` when ``ACTIVE``, as ``pendingDelegate`` when ``PENDING_APPROVAL``)."""
    address = to_checksum_address(signer.address)
    for attempt in range(2):
        data, date = yield from rest("POST", "/agents/me/delegate/challenge", {"delegate": address})
        local = now()
        now_seconds = corrected_now(local, date_header_offset(date, local))
        try:
            typed_data = check_binding_challenge(
                data, local_address=address, credential_id=credential_id, chain_id=chain_id, now_seconds=now_seconds
            )
        except SignerRefusal as err:
            if err.field == "message.expiresAt":
                if attempt == 0:
                    continue
                raise PaymentError(
                    "BINDING_CLOCK", "the binding challenge expired twice; check this machine's clock"
                ) from None
            raise PaymentError(
                "BINDING_CHALLENGE_REFUSED",
                f"the binding challenge failed its check ({err.field}); nothing was signed",
                details={"field": err.field},
            ) from None
        raw = yield from _ops.call(signer.sign_typed_data, typed_data)
        signature = normalize_signature(raw)
        bound, _ = yield from rest(
            "POST", "/agents/me/delegate", {"challengeId": data["challengeId"], "signature": signature}
        )
        bound = bound if isinstance(bound, dict) else {}

        def names(v: object) -> bool:
            p = parse_caip10(v)
            return p is not None and p[0] == chain_id and p[1] == address

        # ACTIVE: this key is the delegate now. PENDING_APPROVAL: another key stays bound and keeps
        # signing; this one waits as ``pendingDelegate`` until a person approves it.
        accepted = (bound.get("status") == "ACTIVE" and names(bound.get("delegate"))) or (
            bound.get("status") == "PENDING_APPROVAL" and names(bound.get("pendingDelegate"))
        )
        if not accepted:
            raise PaymentError("BINDING_NOT_ACCEPTED", "Assay did not confirm the binding of this key")
        return bound
    raise PaymentError("BINDING_CLOCK", "the binding challenge expired twice; check this machine's clock")
