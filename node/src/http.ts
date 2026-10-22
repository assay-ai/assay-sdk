import { dateHeaderOffset } from "./core/clock.js";
import { NetworkError, TimeoutError } from "./errors.js";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Where the SDK writes what it does. Silent by default. Fields never carry keys or signatures. */
export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

export const silentLogger: Logger = { debug() {}, warn() {} };

/** Statuses retried with backoff (with `Retry-After` honoured). */
const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
/** JSON-RPC "rate limited" (spec section 2.1). */
export const RPC_RATE_LIMITED = -32029;
const BASE_DELAY_MS = 500;
const MAX_BACKOFF_MS = 8_000;
/** A server asking for a longer wait than this is not retried; the caller gets the error. */
export const MAX_RETRY_AFTER_MS = 60_000;

const SECRET_KEY = /authorization|api[-_]?key|signature|secret|private|token|voucher/i;
const LONG_HEX = /0x[0-9a-fA-F]{100,}/g;

/** A copy of `fields` with anything that looks secret removed. Applied to every log line. */
export function redact(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (SECRET_KEY.test(k)) out[k] = "[redacted]";
    else if (typeof v === "string") out[k] = v.replace(LONG_HEX, "[redacted]");
    else out[k] = v;
  }
  return out;
}

export interface HttpOptions {
  fetch: FetchLike;
  apiKey: string;
  /** The only origins the API key is sent to: the MCP and the API origin. */
  origins: readonly string[];
  timeoutMs: number;
  maxRetries: number;
  logger: Logger;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  userAgent: string;
}

export interface HttpRequest {
  url: string;
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  /** Retry connection failures and retryable statuses (safe: reads, and idempotent MCP calls). */
  retry: boolean;
}

export interface HttpResponse {
  status: number;
  headers: Headers;
  text: string;
}

/** `Retry-After` (seconds or an HTTP date) in milliseconds, or undefined. */
export function retryAfterMs(value: string | null, nowMs: number): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : undefined;
}

/** `data.retryAfterMs` of a JSON-RPC -32029 answer, or `undefined` when the body is not one. */
function rpcRateLimit(text: string): { retryAfterMs: number | undefined } | undefined {
  if (!text.includes(String(RPC_RATE_LIMITED))) return undefined;
  try {
    const msg = JSON.parse(text) as { error?: { code?: unknown; data?: { retryAfterMs?: unknown } } };
    if (msg?.error?.code !== RPC_RATE_LIMITED) return undefined;
    const ms = msg.error.data?.retryAfterMs;
    return { retryAfterMs: typeof ms === "number" && Number.isFinite(ms) && ms >= 0 ? ms : undefined };
  } catch {
    return undefined;
  }
}

/**
 * One origin-pinned HTTP client for the MCP and API hosts: the bearer goes only to the configured
 * origins, redirects are an error, every attempt has a timeout, and retries back off and honour
 * `Retry-After`. Every answer's `Date` header updates the clock offset (spec section 7).
 */
export class Http {
  readonly #o: HttpOptions;
  /** Server clock minus local clock, seconds, from the last answer. */
  dateOffset = 0;

  constructor(options: HttpOptions) {
    this.#o = options;
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    const url = new URL(req.url);
    if (!this.#o.origins.includes(url.origin))
      throw new NetworkError("refusing a request to an origin the client was not configured for");
    const attempts = req.retry ? this.#o.maxRetries + 1 : 1;
    for (let attempt = 0; ; attempt++) {
      const last = attempt + 1 >= attempts;
      const started = this.#o.now();
      let res: Response;
      let text: string;
      const signal = AbortSignal.timeout(this.#o.timeoutMs);
      try {
        res = await this.#o.fetch(req.url, {
          method: req.method,
          headers: {
            accept: "application/json",
            "user-agent": this.#o.userAgent,
            ...req.headers,
            authorization: `Bearer ${this.#o.apiKey}`,
          },
          ...(req.body !== undefined ? { body: req.body } : {}),
          redirect: "error",
          signal,
        });
        text = await res.text();
      } catch (err) {
        const timedOut = signal.aborted;
        this.#log(req, attempt, { error: timedOut ? "timeout" : "network" }, started);
        if (!last) {
          await this.#o.sleep(this.#backoff(attempt));
          continue;
        }
        throw timedOut ? new TimeoutError(undefined, err) : new NetworkError("could not reach Assay", err);
      }
      this.dateOffset = dateHeaderOffset(res.headers.get("date"), this.#o.now() / 1000);
      this.#log(req, attempt, { status: res.status }, started);
      if (!last) {
        const rpc = rpcRateLimit(text);
        if (RETRY_STATUSES.has(res.status) || rpc !== undefined) {
          const wait = retryAfterMs(res.headers.get("retry-after"), this.#o.now()) ?? rpc?.retryAfterMs;
          if (wait === undefined || wait <= MAX_RETRY_AFTER_MS) {
            await this.#o.sleep(wait ?? this.#backoff(attempt));
            continue;
          }
        }
      }
      return { status: res.status, headers: res.headers, text };
    }
  }

  #backoff(attempt: number): number {
    const base = Math.min(MAX_BACKOFF_MS, BASE_DELAY_MS * 2 ** attempt);
    return Math.round(base * (0.75 + Math.random() * 0.25));
  }

  #log(req: HttpRequest, attempt: number, extra: Record<string, unknown>, started: number): void {
    const path = new URL(req.url).pathname.split("/").slice(0, 4).join("/");
    this.#o.logger.debug(
      "assay request",
      redact({ method: req.method, path, attempt, ms: this.#o.now() - started, ...extra }),
    );
  }
}
