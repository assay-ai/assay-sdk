"""The payment network table, pinned in the SDK.

Per CAIP-2 network: the escrow, the asset, its decimals and default public RPC URLs. Payments are
checked against this table only, never against the server, so a compromised API cannot redirect
them. Changing an address means a new SDK release.

The built-in table holds the network Assay's production runs on, Robinhood Chain mainnet
(``eip155:4663``), with two RPC hosts from different operators. A paid call or a bind on a network
that is not in the table is refused with ``PaymentNetworkUnknownError``.

``networks=`` configures any chain from outside (Robinhood Chain testnet for Assay's dev deployment,
another deployment): its entries are
merged over the built-in table, adding networks, and an entry for a network the table has replaces
that entry whole (fields are never mixed from two deployments). ``rpc_urls=`` replaces only a
network's RPC URLs.
"""

from __future__ import annotations

from collections.abc import Mapping
from types import MappingProxyType
from typing import Any

from goassay._caip import eip155_chain_id
from goassay._chain import is_usable_rpc_url
from goassay._eip155 import NetworkEntry, eip155_networks
from goassay.errors import ConfigError

# The built-in production table.
BUILT_IN_NETWORKS: Mapping[str, Mapping[str, Any]] = MappingProxyType(
    {
        "eip155:4663": MappingProxyType(
            {
                "chainId": 4663,
                "escrow": "eip155:4663:0xe54E0142b1D0d34226498D563A16074C81Bc9A5e",
                "asset": "eip155:4663/erc20:0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
                "decimals": 6,
                "rpcUrls": ["https://rpc.mainnet.chain.robinhood.com", "https://robinhood-rpc.publicnode.com"],
            }
        ),
    }
)


def network_table(
    networks: Mapping[str, Mapping[str, Any]] | None,
    rpc_urls: Mapping[str, list[str]] | None,
    built_in: Mapping[str, Mapping[str, Any]] = BUILT_IN_NETWORKS,
) -> dict[str, NetworkEntry]:
    """The checked table: the built-in one with ``networks`` merged over it, then ``rpc_urls``."""
    table = {**built_in, **(networks or {})}
    overrides = dict(rpc_urls or {})
    for nid, urls in overrides.items():
        ok = isinstance(urls, list) and bool(urls) and all(isinstance(u, str) and is_usable_rpc_url(u) for u in urls)
        if eip155_chain_id(nid) is None or not ok:
            raise ConfigError(f"rpc_urls[{nid!r}] must be a non-empty list of https URLs for an eip155 network")
    merged = {nid: {**n, "rpcUrls": overrides.get(nid, n.get("rpcUrls"))} for nid, n in table.items()}
    return eip155_networks(merged)
