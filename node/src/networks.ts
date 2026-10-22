/**
 * The payment network table, pinned in the SDK: per CAIP-2 network, the escrow, the asset, its
 * decimals and default public RPC URLs. Payments are checked against this table only, never
 * against the server, so a compromised API cannot redirect them. Changing an address means a new
 * SDK release.
 *
 * The built-in table holds the network Assay's production runs on today, Robinhood Chain testnet
 * (`eip155:46630`), with two RPC hosts from different operators. A paid call or a bind on a
 * network that is not in the table is refused with `PaymentNetworkUnknownError`.
 *
 * The `networks` option configures any chain from outside (a testnet, another deployment): its
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
  "eip155:46630": Object.freeze({
    chainId: 46630,
    escrow: "eip155:46630:0x2723AD1fEC053Fe05305e4D0c874B0402959Ce18",
    asset: "eip155:46630/erc20:0xDbbC156dD414f43f2c952C1Be0f16A0B9a826Cd3",
    decimals: 6,
    rpcUrls: Object.freeze([
      "https://rpc.testnet.chain.robinhood.com",
      "https://robinhood-sepolia-rpc.publicnode.com",
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
