import { inspect } from "node:util";
import { ChainReader } from "./core/chain.js";
import { ConfigError } from "./errors.js";
import { Http, silentLogger, type FetchLike, type Logger } from "./http.js";
import { McpTransport } from "./mcp.js";
import { DEFAULT_MCP_ORIGIN, redactMcpUrl, resolveMcpUrl } from "./mcp-url.js";
import { networkTable } from "./networks.js";
import { PaidCalls } from "./resources/paid-calls.js";
import { QuoteCache, type ClientContext, type OnPayment } from "./resources/context.js";
import { Receipts } from "./resources/receipts.js";
import { Tools } from "./resources/tools.js";
import { RestClient } from "./rest.js";
import { checkLimits, DEFAULT_LIMITS, Eip155Scheme, type Eip155Network, type Limits } from "./schemes/eip155/index.js";
import type { NetworkEntry } from "./schemes/eip155/index.js";
import type { PaymentScheme } from "./schemes/types.js";
import { signerNamespace, type Signer } from "./signer.js";
import { VERSION } from "./version.js";

export const DEFAULT_MCP_URL = "https://mcp.goassay.ai/";
export const DEFAULT_API_URL = "https://api.goassay.ai/api/v1";
/** The web app, where a person approves a payment key. */
export const DEFAULT_WEB_URL = "https://portal.goassay.ai";

export interface AssayOptions {
  /** Your Assay API key. Default: the `ASSAY_API_KEY` environment variable. */
  apiKey?: string;
  /**
   * The MCP URL this client calls tools through: a full URL, or a path resolved against
   * `https://mcp.goassay.ai`, such as `"/my/research"`, `"/@acme/kit@3"` or `"/?tools=get_weather"`.
   * Checked against the URL shapes Assay serves. Default `https://mcp.goassay.ai/` (Everything).
   * Paid calls go through whatever URL you choose; use `at()` for another URL in the same program.
   */
  mcpUrl?: string;
  /** The REST API base. Default `https://api.goassay.ai/api/v1`. */
  apiUrl?: string;
  /** A signer for paid calls. Free calls need none. */
  signer?: Signer;
  /** Several signers; a payment uses the one whose namespace matches the requirement's network. */
  signers?: Signer[];
  /** The web app, for the payment-key approval link. Default `https://portal.goassay.ai`. */
  webUrl?: string;
  /**
   * Payment networks you configure, keyed by CAIP-2 (`eip155:<chainId>`): chainId, escrow, asset,
   * decimals and RPC URLs, for example a test chain or another deployment (with its own `mcpUrl`,
   * `apiUrl` and `webUrl`). Merged over the SDK's built-in table: a new network is added, and an
   * entry for a built-in network replaces it whole. Never read from the server.
   */
  networks?: Record<string, Eip155Network>;
  /** Your own RPC URLs for a network, replacing the table's public ones: `{"eip155:<id>": [url]}`. */
  rpcUrls?: Record<string, string[]>;
  /**
   * Local spend limits in dollars, checked before every signature (G7), per signing key and per
   * process. Default `{maxPerCall: "0.50", maxPerDay: "5"}` (rolling 24 hours).
   */
  limits?: Limits;
  /** Called before each voucher is signed, after every local check passed. Return `false` to refuse. */
  onPayment?: OnPayment;
  /** Default: the global `fetch`. */
  fetch?: FetchLike;
  /** Per attempt, in milliseconds. Default 120 000. */
  timeoutMs?: number;
  /** Retries of a failed request (network errors, 408/429/5xx, rate limits). Default 2. */
  maxRetries?: number;
  /** Default: silent. Lines never carry keys or signatures. */
  logger?: Logger;
  /** Milliseconds clock. Default `Date.now`; corrected by the server's `Date` for vouchers. */
  now?: () => number;
  /** How the client waits between retries. Default `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

function originOf(name: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${name} is not a URL`);
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!(url.protocol === "https:" || (url.protocol === "http:" && loopback)) || url.username || url.password) {
    throw new ConfigError(`${name} must be an https URL`);
  }
  return url.origin;
}

const CLIENT_INFO = { name: "goassay-node", version: VERSION } as const;
/** Builds a sibling client from a parent's context (`at()`); not reachable through the public options. */
const SIBLING = Symbol("assay.sibling");

/**
 * The Assay client, for one MCP URL. Stateless over HTTP: there is nothing to connect or close.
 *
 * - `tools.list / search / get / call` over MCP;
 * - `receipts.get` to see what a call cost;
 * - `paidCalls.status / bind / waitUntilActive` to set up a payment key;
 * - `at(url)` for a client on another MCP URL that shares this one's key, signers and limits.
 */
export class Assay {
  readonly tools: Tools;
  readonly receipts: Receipts;
  readonly paidCalls: PaidCalls;
  /** The payment network table in use: the built-in one with `networks` merged, after `rpcUrls`. */
  readonly networks: ReadonlyMap<string, NetworkEntry>;
  readonly #ctx: ClientContext;
  readonly #mcpOrigin: string;

  constructor(options: AssayOptions = {}) {
    const sibling = (options as { [SIBLING]?: ClientContext })[SIBLING];
    const ctx = sibling ?? buildContext(options);
    this.#ctx = ctx;
    this.#mcpOrigin = new URL(ctx.mcpUrl).origin;
    this.tools = new Tools(ctx);
    this.receipts = new Receipts(ctx);
    this.paidCalls = new PaidCalls(ctx);
    this.networks = ctx.networks;
  }

  /**
   * A client on another MCP URL: a full URL on this client's MCP origin, or a path resolved
   * against it (`"/my/research"`, `"/@acme/kit@3"`, `"/?tools=get_weather"`). It shares this
   * client's API key, HTTP stack (fetch, retries, logger), signers, spend limits and ledger,
   * `onPayment` and the in-flight calls by idempotency key, and has its own quote cache. Cheap:
   * nothing is sent until it is used.
   */
  at(urlOrPath: string): Assay {
    const mcpUrl = resolveMcpUrl("url", urlOrPath, this.#mcpOrigin);
    if (new URL(mcpUrl).origin !== this.#mcpOrigin)
      throw new ConfigError("at() takes a path or a URL on this client's MCP origin; build a new Assay for another");
    const c = this.#ctx;
    const ctx: ClientContext = {
      ...c,
      mcpUrl,
      mcp: new McpTransport(c.http, mcpUrl, CLIENT_INFO, c.now),
      quotes: new QuoteCache(c.now),
    };
    return new Assay({ [SIBLING]: ctx } as AssayOptions);
  }

  toJSON(): Record<string, unknown> {
    return { mcpUrl: redactMcpUrl(this.#ctx.mcpUrl) };
  }

  toString(): string {
    return `Assay(${redactMcpUrl(this.#ctx.mcpUrl)})`;
  }

  [inspect.custom](): string {
    return this.toString();
  }
}

function buildContext(options: AssayOptions): ClientContext {
  const apiKey = (options.apiKey ?? process.env.ASSAY_API_KEY ?? "").trim();
  if (apiKey === "") throw new ConfigError("an API key is required: pass apiKey or set ASSAY_API_KEY");
  if (!/^[\x21-\x7e]+$/.test(apiKey)) throw new ConfigError("apiKey is not valid");
  const mcpUrl = resolveMcpUrl("mcpUrl", options.mcpUrl ?? DEFAULT_MCP_URL, DEFAULT_MCP_ORIGIN);
  const apiUrl = (options.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, "");
  const origins = [originOf("mcpUrl", mcpUrl), originOf("apiUrl", apiUrl)];
  const webOrigin = originOf("webUrl", options.webUrl ?? DEFAULT_WEB_URL);

  const signers = [...(options.signer ? [options.signer] : []), ...(options.signers ?? [])];
  for (const s of signers) {
    if (signerNamespace(s) === null) throw new ConfigError("a signer needs namespace, address and signTypedData");
  }
  if (new Set(signers.map((s) => s.namespace)).size !== signers.length)
    throw new ConfigError("give one signer per namespace");
  const maxRetries = options.maxRetries ?? 2;
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 10)
    throw new ConfigError("maxRetries must be 0 to 10");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new ConfigError("timeoutMs must be positive");

  const now = options.now ?? Date.now;
  const fetchFn = options.fetch ?? ((input: string, init: RequestInit) => fetch(input, init));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const http = new Http({
    fetch: fetchFn,
    apiKey,
    origins,
    timeoutMs,
    maxRetries,
    logger: options.logger ?? silentLogger,
    now,
    sleep,
    userAgent: `goassay-node/${VERSION} node/${process.versions.node}`,
  });
  const networks = networkTable(options.networks, options.rpcUrls);
  const schemes = new Map<string, PaymentScheme>();
  if (signers.some((s) => s.namespace === "eip155")) {
    schemes.set(
      "eip155",
      new Eip155Scheme({
        networks,
        limits: checkLimits(options.limits ?? DEFAULT_LIMITS),
        // Chain reads go to the caller's RPCs, without the API key.
        chain: new ChainReader({ fetch: fetchFn, now }),
        now,
        dateOffset: () => http.dateOffset,
      }),
    );
  }
  return {
    http,
    mcpUrl,
    mcp: new McpTransport(http, mcpUrl, CLIENT_INFO, now),
    api: new RestClient(http, apiUrl, now),
    signers: Object.freeze(signers),
    schemes,
    networks,
    webOrigin,
    inFlight: new Map(),
    quotes: new QuoteCache(now),
    onPayment: options.onPayment,
    maxRetries,
    now,
    sleep,
  };
}
