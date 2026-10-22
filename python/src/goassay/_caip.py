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
