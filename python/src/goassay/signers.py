"""Signers. The SDK never holds, stores or creates a key: the caller passes a signer, and the SDK
hands it only typed data the SDK built itself after every local check passed.

``Signer`` is keyed by CAIP-2 namespace, so other chains can be added as new kinds of signer
without changing the existing ones. Only ``eip155`` exists in this release.
"""

from __future__ import annotations

from collections.abc import Awaitable
from typing import Any, Literal, Protocol, runtime_checkable

# The domain fields EIP-712 hashes, in order, for the domains the SDK builds.
_DOMAIN_FIELDS = (
    ("name", "string"),
    ("version", "string"),
    ("chainId", "uint256"),
    ("verifyingContract", "address"),
)


@runtime_checkable
class EvmSigner(Protocol):
    """An EVM key: an address and an EIP-712 signer (a local key, a KMS, an HSM).

    ``sign_typed_data`` gets ``{domain, types, primaryType, message}`` (integers as ``int``,
    ``bytes32`` as ``bytes``, no ``EIP712Domain`` entry) and returns the 65-byte ``r || s || v``
    signature as ``0x`` hex or bytes. With ``AsyncAssay`` it may be a coroutine function.
    """

    @property
    def namespace(self) -> Literal["eip155"]: ...

    @property
    def address(self) -> str: ...

    def sign_typed_data(self, typed_data: dict[str, Any]) -> str | bytes | Awaitable[str | bytes]: ...


Signer = EvmSigner


def full_message(typed_data: dict[str, Any]) -> dict[str, Any]:
    """The typed data with its ``EIP712Domain`` type, as eth-account's ``full_message`` takes it."""
    domain = [{"name": n, "type": t} for n, t in _DOMAIN_FIELDS if n in typed_data["domain"]]
    return {**typed_data, "types": {"EIP712Domain": domain, **typed_data["types"]}}


class _LocalEvmSigner:
    __slots__ = ("_account", "address")
    namespace: Literal["eip155"] = "eip155"

    def __init__(self, account: Any) -> None:
        self._account = account
        self.address: str = account.address

    def sign_typed_data(self, typed_data: dict[str, Any]) -> str:
        signed = self._account.sign_typed_data(full_message=full_message(typed_data))
        return "0x" + bytes(signed.signature).hex()

    def __repr__(self) -> str:
        return f"EvmSigner({self.address})"


def evm_signer(account: Any) -> EvmSigner:
    """Wraps an eth-account ``LocalAccount`` (``Account.from_key(...)``) as an :class:`EvmSigner`.

    The wrapper exposes only the address and the signing method; its ``repr`` shows the address.
    """
    if not hasattr(account, "address") or not hasattr(account, "sign_typed_data"):
        raise TypeError("evm_signer needs an eth-account LocalAccount")
    return _LocalEvmSigner(account)
