/**
 * Read-only chain reads of the payment key's grant and caps (G4, G6): three escrow views at one
 * pinned block, on every RPC the caller listed for the network. Every RPC must answer the same
 * chain id and the same bytes, or there is no read (the guards then refuse: fail closed).
 *
 * `delegationOf(payer, delegate)`, `effectiveCapsOf(payer, delegate)` and `escrowOf(payer)`. Each
 * cap is the lower of the effective envelope and the current value: strictest wins.
 *
 * All reads run at one pinned block `B = min(heights) - 1`, so RPCs some blocks apart still agree;
 * heights more than `MAX_BLOCK_SPREAD` apart refuse. A transient failure (an RPC error or timeout,
 * or heights too far apart) runs the whole read again, at most `READ_ATTEMPTS` times in all, after
 * `RETRY_DELAYS_MS`; no new attempt starts once `RETRY_WINDOW_MS` has passed. Each attempt pins its
 * own block and needs every RPC again. A disagreement at the pinned block is never retried: two
 * RPCs serving different bytes for the same block is a real conflict, and a later attempt that
 * happens to agree would hide it. Another chain id, no block to pin and a malformed answer are
 * final too. Failures are not cached.
 */
import type { ChainState } from "./guard-types.js";
import { getAddress, keccakUtf8, type Address } from "./hex.js";

/** How long an agreed read stands (G4 accepts a read at most 600 s old). */
export const CHAIN_CACHE_MS = 10 * 60 * 1000;
/**
 * The most two RPCs' latest heights may differ before the read refuses. About 20 s on Robinhood
 * Chain (~6 blocks/s), whose public RPCs are often 10 to 40 blocks apart. It only bounds how stale
 * the pinned block can be; agreement comes from reading one explicit block.
 */
export const MAX_BLOCK_SPREAD = 120n;
/** Attempts of the whole read, including the first, when an attempt fails transiently. */
export const READ_ATTEMPTS = 3;
/** The wait before the second and the third attempt. */
export const RETRY_DELAYS_MS: readonly number[] = [300, 1000];
/** No new attempt starts once this long has passed since the first one started. */
export const RETRY_WINDOW_MS = 5_000;
const MAX_RESPONSE_CHARS = 16 * 1024;
const RPC_TIMEOUT_MS = 5_000;

const selector = (signature: string): string => keccakUtf8(signature).slice(2, 10);
const DELEGATION_OF = selector("delegationOf(address,address)");
const EFFECTIVE_CAPS_OF = selector("effectiveCapsOf(address,address)");
const ESCROW_OF = selector("escrowOf(address)");

export type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

export interface ChainReaderOptions {
  fetch: FetchFn;
  /** Milliseconds clock. */
  now: () => number;
  /** The wait between attempts. Default `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

/** An attempt that failed in a way another attempt may not (an RPC error, heights apart). */
const TRANSIENT = Symbol("transient");

export interface ChainNetwork {
  /** CAIP-2, `eip155:<id>`. */
  id: string;
  chainId: number;
  escrow: Address;
  rpc: readonly string[];
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** https, or http to a loopback host; no credentials, query or fragment. */
export function isUsableRpcUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password || url.search || url.hash) return false;
  return url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname));
}

const word = (address: string): string => address.slice(2).toLowerCase().padStart(64, "0");

/** Splits canonical ABI return data into words, checking each word's bit width. */
function words(data: string, widths: readonly number[]): bigint[] | null {
  if (!/^0x[0-9a-f]*$/.test(data) || data.length !== 2 + widths.length * 64) return null;
  const out: bigint[] = [];
  for (let i = 0; i < widths.length; i++) {
    const n = BigInt(`0x${data.slice(2 + i * 64, 2 + (i + 1) * 64)}`);
    if (n >> BigInt(widths[i]!) !== 0n) return null;
    out.push(n);
  }
  return out;
}

const DELEGATION_WIDTHS = [64, 64, 64, 64, 64, 32, 1];
const CAPS_WIDTHS = [64, 64, 64, 64];
const ESCROW_WIDTHS = [128, 64, 64, 64, 64, 64, 64, 64, 64, 128, 128, 128];

const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);

export class ChainReader {
  readonly #fetch: FetchFn;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #cache = new Map<string, { at: number; value: ChainState }>();
  #id = 1;

  constructor(options: ChainReaderOptions) {
    this.#fetch = options.fetch;
    this.#now = options.now;
    this.#sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  }

  /** The agreed read for `payer` and `delegate` (checksummed), or `null` (fail closed). */
  async read(net: ChainNetwork, payer: Address, delegate: Address): Promise<ChainState | null> {
    const key = JSON.stringify([net.id, payer, delegate]);
    const hit = this.#cache.get(key);
    const t = this.#now();
    if (hit && t >= hit.at && t - hit.at < CHAIN_CACHE_MS) return hit.value;
    this.#cache.delete(key);
    const value = await this.#readWithRetry(net, payer, delegate, Math.floor(t / 1000));
    if (value !== null) this.#cache.set(key, { at: t, value });
    return value;
  }

  /** Drops a cached read, so the next payment reads the chain again (after a revocation). */
  invalidate(net: string, payer: string, delegate: string): void {
    this.#cache.delete(JSON.stringify([net, payer, delegate]));
  }

  /** The whole read, run again on a transient failure (see the module comment). */
  async #readWithRetry(
    net: ChainNetwork,
    payer: Address,
    delegate: Address,
    readAt: number,
  ): Promise<ChainState | null> {
    const started = performance.now();
    for (let attempt = 1; ; attempt++) {
      let value: ChainState | null | typeof TRANSIENT;
      try {
        value = await this.#readOnce(net, payer, delegate, readAt);
      } catch {
        value = TRANSIENT;
      }
      if (value !== TRANSIENT) return value;
      const delay = RETRY_DELAYS_MS[attempt - 1] ?? 0;
      if (attempt >= READ_ATTEMPTS || performance.now() - started + delay > RETRY_WINDOW_MS) return null;
      await this.#sleep(delay);
    }
  }

  /** One attempt; an RPC that fails throws (transient). */
  async #readOnce(
    net: ChainNetwork,
    payer: Address,
    delegate: Address,
    readAt: number,
  ): Promise<ChainState | null | typeof TRANSIENT> {
    const rpcs = net.rpc;
    if (rpcs.length < 1 || new Set(rpcs).size !== rpcs.length || !rpcs.every(isUsableRpcUrl)) return null;
    const heads = await Promise.all(
      rpcs.map(async (url) => {
        const [id, height] = await Promise.all([
          this.#call(url, "eth_chainId", []),
          this.#call(url, "eth_blockNumber", []),
        ]);
        return { id: quantity(id), height: quantity(height) };
      }),
    );
    if (heads.some((h) => h.id === null || h.height === null || h.id !== BigInt(net.chainId))) return null;
    const heights = heads.map((h) => h.height!);
    const low = heights.reduce((x, y) => (y < x ? y : x));
    const high = heights.reduce((x, y) => (y > x ? y : x));
    if (high - low > MAX_BLOCK_SPREAD) return TRANSIENT;
    if (low < 1n) return null;
    // One block behind the lowest head, so every RPC has it.
    const block = `0x${(low - 1n).toString(16)}`;
    const calls = [
      `0x${DELEGATION_OF}${word(payer)}${word(delegate)}`,
      `0x${EFFECTIVE_CAPS_OF}${word(payer)}${word(delegate)}`,
      `0x${ESCROW_OF}${word(payer)}`,
    ];
    const answers = await Promise.all(
      rpcs.map((url) =>
        Promise.all(
          calls.map(async (data) =>
            String(await this.#call(url, "eth_call", [{ to: net.escrow, data }, block])).toLowerCase(),
          ),
        ),
      ),
    );
    // A disagreement at the pinned block is final (no retry).
    const first = answers[0]!;
    if (answers.some((a) => a.some((x, i) => x !== first[i]))) return null;
    const d = words(first[0]!, DELEGATION_WIDTHS);
    const caps = words(first[1]!, CAPS_WIDTHS);
    const e = words(first[2]!, ESCROW_WIDTHS);
    if (!d || !caps || !e) return null;
    const [dMax, , , , validUntil, , revoked] = d as [bigint, bigint, bigint, bigint, bigint, bigint, bigint];
    return {
      payer: getAddress(payer),
      delegate: getAddress(delegate),
      readAt,
      active: validUntil !== 0n && revoked === 0n,
      validUntil: validUntil.toString(),
      maxVoucherAmount: min(caps[0]!, e[3]!).toString(),
      delegateMaxVoucherAmount: min(caps[2]!, dMax).toString(),
    };
  }

  async #call(url: string, method: string, params: unknown[]): Promise<unknown> {
    const id = this.#id++;
    const signal = AbortSignal.timeout(RPC_TIMEOUT_MS);
    const res = await this.#fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      redirect: "error",
      signal,
    });
    const text = await res.text();
    if (res.status !== 200 || text.length > MAX_RESPONSE_CHARS) throw new Error("rpc failed");
    const msg = JSON.parse(text) as Record<string, unknown>;
    if (
      msg === null ||
      typeof msg !== "object" ||
      msg.jsonrpc !== "2.0" ||
      msg.id !== id ||
      "error" in msg ||
      !("result" in msg)
    ) {
      throw new Error("rpc failed");
    }
    return msg.result;
  }
}

function quantity(value: unknown): bigint | null {
  return typeof value === "string" && /^0x(?:0|[1-9a-f][0-9a-f]{0,15})$/i.test(value) ? BigInt(value) : null;
}
