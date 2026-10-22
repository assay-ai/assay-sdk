from __future__ import annotations

import re

from eth_utils.address import is_checksum_address

_CAIP10 = re.compile(r"eip155:([1-9][0-9]*):(0x[0-9a-fA-F]{40})")
_CAIP19_ERC20 = re.compile(r"eip155:([1-9][0-9]*)/erc20:(0x[0-9a-fA-F]{40})")


def _parse(pattern: re.Pattern[str], value: object) -> tuple[int, str] | None:
    m = pattern.fullmatch(value) if isinstance(value, str) else None
    if m is None or not is_checksum_address(m.group(2)):
        return None
    return int(m.group(1)), m.group(2)


def parse_caip10(value: object) -> tuple[int, str] | None:
    """A CAIP-10 account on eip155 with a checksummed address, as ``(chain_id, address)``."""
    return _parse(_CAIP10, value)


def parse_caip19_erc20(value: object) -> tuple[int, str] | None:
    """A CAIP-19 erc20 asset on eip155 with a checksummed address, as ``(chain_id, address)``."""
    return _parse(_CAIP19_ERC20, value)


_CAIP2 = re.compile(r"([-a-z0-9]{3,8}):[-_a-zA-Z0-9]{1,32}")
_CAIP2_EIP155 = re.compile(r"eip155:([1-9][0-9]*)")


def namespace_of(caip2: object) -> str | None:
    """The namespace of a CAIP-2 chain id (``eip155`` of ``eip155:1``), or ``None``."""
    m = _CAIP2.fullmatch(caip2) if isinstance(caip2, str) else None
    return m.group(1) if m else None


def eip155_chain_id(caip2: object) -> int | None:
    """The chain id of an ``eip155:<id>`` chain, or ``None``."""
    m = _CAIP2_EIP155.fullmatch(caip2) if isinstance(caip2, str) else None
    return int(m.group(1)) if m else None
