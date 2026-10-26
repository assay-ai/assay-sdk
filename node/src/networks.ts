/**
 * The payment network table, pinned in the SDK: per CAIP-2 network, the escrow, the asset, its
 * decimals and default public RPC URLs. Payments are checked against this table only, never
 * against the server, so a compromised API cannot redirect them. Changing an address means a new
 * SDK release.
 *
 * The built-in table holds the network Assay's production runs on, Robinhood Chain mainnet
 * (`eip155:4663`), with two RPC hosts from different operators. A paid call or a bind on a
 * network that is not in the table is refused with `PaymentNetworkUnknownError`.
 *
 * The `networks` option configures any chain from outside (Robinhood Chain testnet for Assay's
 * dev deployment, another deployment): its
 * entries are merged over the built-in table, adding networks, and an entry for a network the
 * table has replaces that entry whole (fields are never mixed from two deployments). `rpcUrls`
 * replaces only a network's RPC URLs.
 */
import { eip155ChainId } from "./core/caip.js";
import { isUsableRpcUrl } from "./core/chain.js";
import { ConfigError } from "./errors.js";
import { eip155Networks, type Eip155Network, type NetworkEntry } from "./schemes/eip155/index.js";

/** The built-in production table. */
export const BUILT_IN_NETWORKS: Readonly<Record<string, Eip155Network>> = Object.freeze({
  "eip155:4663": Object.freeze({
    chainId: 4663,
    escrow: "eip155:4663:0xe54E0142b1D0d34226498D563A16074C81Bc9A5e",
    asset: "eip155:4663/erc20:0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    decimals: 6,
    rpcUrls: Object.freeze([
      "https://rpc.mainnet.chain.robinhood.com",
      "https://robinhood-rpc.publicnode.com",
    ]) as unknown as string[],
  }),
});

/** The checked table: the built-in one with `networks` merged over it, then `rpcUrls` applied. */
export function networkTable(
  networks: Record<string, Eip155Network> | undefined,
  rpcUrls: Record<string, string[]> | undefined,
  builtIn: Readonly<Record<string, Eip155Network>> = BUILT_IN_NETWORKS,
): ReadonlyMap<string, NetworkEntry> {
  const table = { ...builtIn, ...networks };
  for (const [id, urls] of Object.entries(rpcUrls ?? {})) {
    const ok = Array.isArray(urls) && urls.length > 0 && urls.every((u) => typeof u === "string" && isUsableRpcUrl(u));
    if (eip155ChainId(id) === null || !ok) {
      throw new ConfigError(`rpcUrls.${id} must be a non-empty list of https URLs for an eip155 network`);
    }
  }
  const merged: Record<string, Eip155Network> = {};
  for (const [id, n] of Object.entries(table)) merged[id] = { ...n, rpcUrls: rpcUrls?.[id] ?? n.rpcUrls };
  return eip155Networks(merged);
}
