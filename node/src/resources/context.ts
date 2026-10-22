import type { NetworkEntry } from "../schemes/eip155/index.js";
import type { PaymentDetails, PaymentScheme } from "../schemes/types.js";
import type { Http } from "../http.js";
import type { McpTransport } from "../mcp.js";
import type { RestClient } from "../rest.js";
import type { Signer } from "../signer.js";
import type { PriceQuote } from "../core/meta.js";

/** The caller's hook before a voucher is signed. Return `false` to refuse; nothing is signed. */
export type OnPayment = (details: PaymentDetails) => boolean | void | Promise<boolean | void>;

/**
 * What every resource module shares. One resource area = one module that takes this. A sibling
 * client (`assay.at(url)`) gets a copy with its own `mcpUrl`, `mcp` and `quotes`; every other
 * field is the same object, so the HTTP stack, signers, schemes (spend limits and ledger),
 * `onPayment` and the in-flight map are shared.
 */
export interface ClientContext {
  readonly http: Http;
  /** The MCP URL this client sends to. May hold a link-only token: never print it unredacted. */
  readonly mcpUrl: string;
  readonly mcp: McpTransport;
  readonly api: RestClient;
  readonly signers: readonly Signer[];
  readonly schemes: ReadonlyMap<string, PaymentScheme>;
  readonly networks: ReadonlyMap<string, NetworkEntry>;
  /** The web app origin, where a person approves a payment key. */
  readonly webOrigin: string;
  /** Logical calls in flight, by idempotency key (one voucher per logical call). */
  readonly inFlight: Map<string, { fingerprint: string; promise: Promise<unknown> }>;
  readonly quotes: QuoteCache;
  readonly onPayment: OnPayment | undefined;
  readonly maxRetries: number;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

/**
 * G3's quotes, as seen in `tools/list`, `search_tools` and `get_tool` results, kept 60 s per tool.
 * One cache per MCP URL: the same tool can quote differently on two URLs (entry rules).
 */
export class QuoteCache {
  readonly #entries = new Map<string, { quote: PriceQuote; at: number }>();
  constructor(private readonly now: () => number) {}

  set(tool: string, quote: PriceQuote): void {
    this.#entries.delete(tool);
    this.#entries.set(tool, { quote: { ...quote }, at: this.now() });
    if (this.#entries.size > 2048) this.#entries.delete(this.#entries.keys().next().value!);
  }

  get(tool: string): PriceQuote | null {
    const e = this.#entries.get(tool);
    if (!e) return null;
    const age = this.now() - e.at;
    if (age < 0 || age > 60_000) {
      this.#entries.delete(tool);
      return null;
    }
    return { ...e.quote };
  }
}
