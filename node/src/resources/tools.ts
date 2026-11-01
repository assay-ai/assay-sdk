import { randomUUID } from "node:crypto";
import { namespaceOf } from "../core/caip.js";
import {
  CALL_TOOL,
  DEBT_CODE,
  ERROR_META,
  GET_TOOL,
  IDEMPOTENCY_META,
  IN_PROGRESS_CODE,
  isIdempotencyKey,
  isObject,
  isToolName,
  PAYMENT_REQUIRED_CODE,
  PAYMENT_REQUIRED_META,
  PRICE_META,
  quoteOf,
  RECEIPT_META,
  REPLAYED_META,
  SEARCH_TOOLS,
  structuredOf,
  type PriceQuote,
} from "../core/meta.js";
import type { Money } from "../core/voucher.js";
import { channelDebtAnswer } from "../core/renew.js";
import {
  CHANNEL_CODES,
  CHANNEL_REQUIRED_META,
  channelFallbackOf,
  laneOutcomeOf,
  PAYMENT_SCHEMES_META,
} from "../core/channel.js";
import {
  AssayError,
  ConfigError,
  errorFromServer,
  PaymentError,
  PaymentNetworkUnknownError,
  PaymentRefusedError,
  PaymentRequiredError,
  PaymentSchemeUnsupportedError,
  ServerError,
} from "../errors.js";
import { MAX_RETRY_AFTER_MS } from "../http.js";
import type { PrepareInput } from "../schemes/types.js";
import type { ClientContext } from "./context.js";

/** `_meta["assay/receipt"]`: what a call cost (spec section 10.1). */
export interface CallReceipt {
  /** The payment intent; `null` for a free call, which has no intent and no receipt to fetch. */
  intentId: string | null;
  charged?: Money & { display?: string };
  held?: Money & { display?: string };
  status?: string;
  toolId?: string;
  providerId?: string;
  classification?: string;
  attempts?: number;
  fellBack?: boolean;
  [key: string]: unknown;
}

export interface ToolResult {
  content: unknown[];
  structuredContent?: Record<string, unknown>;
  /** The provider's own tool error. Assay refusals are thrown, never returned. */
  isError: boolean;
  receipt: CallReceipt | null;
  /** The stored result of an earlier attempt with the same idempotency key; not charged again. */
  replayed: boolean;
  /** The key this logical call used; pass it again to retry the same call safely. */
  idempotencyKey: string;
}

export interface CallOptions {
  /** Names one logical call. A UUID is created when it is not given. 1-128 printable ASCII. */
  idempotencyKey?: string;
}

export interface SearchOptions {
  limit?: number;
  category?: string;
  detail?: "names" | "summary" | "full";
  cursor?: string;
}

export interface ToolSummary {
  name: string;
  [key: string]: unknown;
}

export interface SearchResult {
  results: ToolSummary[];
  nextCursor: string | null;
}

export interface ListOptions {
  cursor?: string;
}

export interface ListResult {
  /** The tools this URL lists, as MCP describes them (`name`, `description`, `inputSchema`, `_meta` ...). */
  tools: ToolInfo[];
  nextCursor: string | null;
  /**
   * The list's `_meta`, as sent: `assay/toolsetVersion` (a tool set URL without `@n`),
   * `assay/sharingEnds`, `assay/renamed` (an old handle) and `assay/ignoredTools` (`?tools=` names
   * this URL does not serve).
   */
  meta: Record<string, unknown>;
}

export interface ToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  price?: Record<string, unknown>;
  [key: string]: unknown;
}

function assayErrorOf(result: Record<string, unknown>): Record<string, unknown> | null {
  const meta = isObject(result._meta) ? result._meta : null;
  return meta && isObject(meta[ERROR_META]) && typeof meta[ERROR_META].code === "string" ? meta[ERROR_META] : null;
}

function textOf(result: Record<string, unknown>): string | undefined {
  const c = Array.isArray(result.content) ? (result.content as unknown[]) : [];
  const t = c.find((x): x is { text: string } => isObject(x) && x.type === "text" && typeof x.text === "string");
  return t?.text;
}

/** The typed error for `_meta["assay/error"]`. */
function toolError(e: Record<string, unknown>, result: Record<string, unknown>): AssayError {
  const code = e.code as string;
  const message = typeof e.message === "string" ? e.message : (textOf(result) ?? code);
  const secs = typeof e.retryAfter === "number" ? e.retryAfter * 1000 : undefined;
  const wait = typeof e.retryAfterMs === "number" ? e.retryAfterMs : secs;
  const details: Record<string, unknown> = isObject(e.details) ? { ...e.details } : {};
  if (typeof e.intentId === "string") details.intentId = e.intentId;
  // A scope refusal on a tool call names the scope on `assay/error` itself, not under `details`.
  if (typeof e.requiredScope === "string" && details.requiredScope === undefined)
    details.requiredScope = e.requiredScope;
  return errorFromServer(code, message, {
    retryable: e.retryable === true,
    ...(typeof e.fixUrl === "string" ? { fixUrl: e.fixUrl } : {}),
    ...(Object.keys(details).length > 0 ? { details } : {}),
    ...(wait !== undefined ? { retryAfterMs: wait } : {}),
  });
}

/** Characters a hint may not carry: controls, format (bidi, zero-width), surrogates, private use, line/paragraph separators. */
const UNSAFE_HINT = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/u;

/** The server's `hint` on `assay/error`, without surrounding spaces, when it is a short single-line text (1–500 code points). */
function hintOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const hint = value.replace(/^[ \t]+|[ \t]+$/g, "");
  const length = [...hint].length;
  return length > 0 && length <= 500 && !UNSAFE_HINT.test(hint) ? hint : null;
}

function withKey(err: AssayError, key: string): AssayError {
  err.idempotencyKey ??= key;
  return err;
}

function toResult(result: Record<string, unknown>, idempotencyKey: string): ToolResult {
  const meta = isObject(result._meta) ? result._meta : {};
  const receipt = isObject(meta[RECEIPT_META]) ? (meta[RECEIPT_META] as CallReceipt) : null;
  return {
    content: Array.isArray(result.content) ? (result.content as unknown[]) : [],
    ...(isObject(result.structuredContent) ? { structuredContent: result.structuredContent } : {}),
    isError: result.isError === true,
    receipt,
    replayed: meta[REPLAYED_META] === true,
    idempotencyKey,
  };
}

/** Tools over MCP: search, describe and call, with paid calls signed by the caller's signer. */
export class Tools {
  readonly #c: ClientContext;

  constructor(context: ClientContext) {
    this.#c = context;
  }

  /** `search_tools`: tools this URL can run, by what they do. Free. */
  async search(query: string, options: SearchOptions = {}): Promise<SearchResult> {
    const out = await this.#meta(SEARCH_TOOLS, { query, ...options });
    const results = Array.isArray(out.results)
      ? (out.results as unknown[]).filter((r): r is ToolSummary => isObject(r) && isToolName(r.name))
      : [];
    for (const r of results) this.#remember(r.name, quoteOf(r.assayPrice));
    return { results, nextCursor: typeof out.nextCursor === "string" ? out.nextCursor : null };
  }

  /**
   * `tools/list`: the tools this URL lists. A tool set, topic, maker or `?tools=` URL lists its
   * tools; Everything (`/`) lists only a few, plus `search_tools`, `get_tool` and `call_tool`.
   * Free. Each tool's `_meta["assay/price"]` is kept as its quote for paid calls (G3).
   */
  async list(options: ListOptions = {}): Promise<ListResult> {
    const out = await this.#c.mcp.request("tools/list", options.cursor !== undefined ? { cursor: options.cursor } : {});
    const tools = Array.isArray(out.tools)
      ? (out.tools as unknown[]).filter((t): t is ToolInfo => isObject(t) && isToolName(t.name))
      : [];
    for (const t of tools) this.#remember(t.name, quoteOf(isObject(t._meta) ? t._meta[PRICE_META] : undefined));
    return {
      tools,
      nextCursor: typeof out.nextCursor === "string" ? out.nextCursor : null,
      meta: isObject(out._meta) ? { ...out._meta } : {},
    };
  }

  /** `get_tool`: one tool's description, schemas, price and version. Free. */
  async get(name: string): Promise<ToolInfo> {
    const out = await this.#meta(GET_TOOL, { name });
    if (typeof out.name !== "string") throw new ServerError("MCP_BAD_ANSWER", "get_tool answered without a tool name");
    this.#remember(out.name, quoteOf(out.price));
    return out as ToolInfo;
  }

  /**
   * Calls a tool. A paid tool's `PAYMENT_REQUIRED` is checked by every local guard, offered to
   * `onPayment`, signed once, and the same call is sent again with the voucher and the same
   * idempotency key. Network retries resend the same request; nothing is ever signed twice for
   * one attempt. Assay refusals are thrown as typed errors.
   */
  async call(name: string, args: Record<string, unknown> = {}, options: CallOptions = {}): Promise<ToolResult> {
    if (!isToolName(name)) throw new ConfigError("name is not a tool name");
    if (!isObject(args)) throw new ConfigError("arguments must be an object");
    const key = options.idempotencyKey ?? randomUUID();
    if (!isIdempotencyKey(key)) throw new ConfigError("idempotencyKey must be 1 to 128 printable ASCII characters");
    // One logical call per key in this client: a second call with the key while the first runs
    // waits for it, so at most one voucher is ever signed for it.
    const fingerprint = JSON.stringify([name, args]);
    const running = this.#c.inFlight.get(key);
    if (running) {
      if (running.fingerprint !== fingerprint) {
        throw withKey(new AssayError("IDEMPOTENCY_KEY_REUSED", "this idempotency key is in use for another call"), key);
      }
      return running.promise as Promise<ToolResult>;
    }
    const promise = this.#call(name, args, key).catch((err: unknown) => {
      throw err instanceof AssayError ? withKey(err, key) : err;
    });
    this.#c.inFlight.set(key, { fingerprint, promise });
    try {
      return await promise;
    } finally {
      this.#c.inFlight.delete(key);
    }
  }

  /** `assay/paymentSchemes` to offer: set only when a scheme can sign channel vouchers. */
  #paymentSchemes(): readonly string[] | null {
    for (const scheme of this.#c.schemes.values()) {
      const offered = scheme.paymentSchemes();
      if (offered !== null) return offered;
    }
    return null;
  }

  async #call(name: string, args: Record<string, unknown>, key: string): Promise<ToolResult> {
    const offered = this.#paymentSchemes();
    const params = {
      name,
      arguments: args,
      _meta: { [IDEMPOTENCY_META]: key, ...(offered !== null ? { [PAYMENT_SCHEMES_META]: [...offered] } : {}) },
    };
    const calledAt = Math.floor(this.#c.now() / 1000);
    const first = await this.#send(params);
    const refusal = assayErrorOf(first);
    if (refusal === null) return toResult(first, key);
    const meta = first._meta as Record<string, unknown>;
    const requirement = meta[PAYMENT_REQUIRED_META];
    if (refusal.code === DEBT_CODE) throw await this.#debtError(refusal, first);
    if (refusal.code !== PAYMENT_REQUIRED_CODE || requirement === undefined || requirement === null)
      throw toolError(refusal, first);

    const fixUrl = typeof refusal.fixUrl === "string" ? { fixUrl: refusal.fixUrl } : {};
    if (this.#c.signers.length === 0) {
      throw new PaymentRequiredError(
        `${name} is a paid tool and this client has no signer`,
        requirement,
        fixUrl,
        hintOf(refusal.hint),
      );
    }
    const network = isObject(requirement) && typeof requirement.network === "string" ? requirement.network : "unknown";
    const ns = namespaceOf(network);
    const signer = this.#c.signers.find((s) => s.namespace === ns);
    const scheme = ns === null ? undefined : this.#c.schemes.get(ns);
    if (!signer || !scheme) throw new PaymentSchemeUnsupportedError(network);

    const tool = name === CALL_TOOL ? args.name : name;
    if (!isToolName(tool))
      throw new PaymentRefusedError("G1", "G1_NOT_FORWARDED", "the paid tool's name is not readable");
    const input: PrepareInput = {
      requirement,
      tool,
      calledAt,
      signer,
      idempotencyKey: key,
      quote: (t) => this.quoteFor(t),
      ...(offered !== null && meta[CHANNEL_REQUIRED_META] !== undefined
        ? { channelOffer: meta[CHANNEL_REQUIRED_META] }
        : {}),
    };
    const prepared = await scheme.prepare(input);
    if (!prepared.ok) {
      if (prepared.code === "G2_NETWORK") throw new PaymentNetworkUnknownError(network);
      throw new PaymentRefusedError(prepared.guard, prepared.code, prepared.reason, fixUrl);
    }

    if (this.#c.onPayment) {
      let verdict: boolean | void;
      try {
        verdict = await this.#c.onPayment(Object.freeze({ ...prepared.details }));
      } catch (err) {
        prepared.release();
        throw err;
      }
      if (verdict === false) {
        prepared.release();
        throw new PaymentRefusedError("onPayment", "PAYMENT_REFUSED_BY_CALLER", "the onPayment hook refused it");
      }
    }
    let envelope: Record<string, unknown>;
    try {
      envelope = await prepared.sign();
    } catch (err) {
      prepared.release();
      if (err instanceof AssayError) throw err;
      throw new PaymentError("SIGNER_FAILED", "the signer did not sign the voucher", { cause: err });
    }
    let paid: Record<string, unknown>;
    try {
      paid = await this.#send({ ...params, _meta: { ...params._meta, [prepared.metaKey]: envelope } });
    } catch (err) {
      // No answer: what the server did with the voucher is unknown, so the lane is never reused (its
      // pair stays renewable). A 4xx refusal of the request was not stored: the pair is dropped too.
      const refused = err instanceof AssayError && err.status !== undefined && err.status >= 400 && err.status < 500;
      await prepared.finish?.(refused ? "retire" : "unknown").catch(() => undefined);
      throw err;
    }
    const after = assayErrorOf(paid);
    const code = after === null ? null : (after.code as string);
    if (prepared.finish) {
      await prepared.finish(laneOutcomeOf(code, after?.reason)).catch(() => undefined);
      // One voucher per logical call: a channel refusal the next call recovers from by itself (a new
      // lane after CHANNEL_ROTATE; per call while channels pause after CHANNEL_LIMIT and the like) is
      // thrown as retryable, never signed again in this call.
      if (code !== null && channelFallbackOf(code) !== "stop") {
        scheme.channelRefused?.(code);
        throw new PaymentError(
          code,
          "the payment channel could not take this payment; call again (nothing was charged)",
          {
            retryable: true,
            ...(typeof after?.fixUrl === "string" ? { fixUrl: after.fixUrl } : {}),
          },
        );
      }
    }
    if (after === null) return toResult(paid, key);
    await scheme.onRefused(code!, input);
    if (code === DEBT_CODE) throw await this.#debtError(after, paid);
    throw toolError(after, paid);
  }

  /**
   * A paid call refused for a buyer debt (`PAYMENT_DEBT_OUTSTANDING`). When this client keeps
   * channel lanes, the channel debts it signed are renewed once (`paidCalls.renewChannelDebts`,
   * at most once a minute; within the minute the debts are only listed; the call is not sent
   * again). The error then says what to do (`channelDebtAnswer`): being collected (retryable), a
   * channel debt this client can no longer renew (settle in the app once offered), or only
   * channel debts not renewed just now (retryable). With a per-call debt (a person signs it in
   * the portal) it is the server's refusal.
   */
  async #debtError(e: Record<string, unknown>, result: Record<string, unknown>): Promise<AssayError> {
    const refusal = toolError(e, result);
    const signer = this.#c.signers.find((s) => s.namespace === "eip155");
    const scheme = this.#c.schemes.get("eip155");
    if (!signer || !scheme?.renewChannelDebts) return refusal;
    let renewals;
    try {
      renewals = await scheme.renewChannelDebts(this.#c.api, signer);
    } catch {
      return refusal;
    }
    const details = { ...(refusal.details ?? {}), renewals: renewals ?? [] };
    const answer = channelDebtAnswer(renewals, this.#c.webOrigin);
    if (answer === null) return refusal;
    return new PaymentError(DEBT_CODE, answer.text, { retryable: answer.retryable, details });
  }

  /** One `tools/call`; an `IDEMPOTENCY_IN_PROGRESS` answer waits and sends the same request again. */
  async #send(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    for (let attempt = 0; ; attempt++) {
      const result = await this.#c.mcp.request("tools/call", params);
      const e = assayErrorOf(result);
      // The first attempt still runs, or a refusal-rate limit: wait and send the same bytes again.
      // A refusal only because earlier payments still settle (nothing charged, nothing stored) is
      // sent again as is too, when the wait is short; a longer one is the caller's to wait for.
      const again =
        e?.code === IN_PROGRESS_CODE || e?.code === "RATE_LIMITED" || e?.code === CHANNEL_CODES.PAYMENT_UNSETTLED_LIMIT;
      if (!again || attempt >= this.#c.maxRetries) return result;
      const wait =
        typeof e.retryAfterMs === "number"
          ? e.retryAfterMs
          : typeof e.retryAfter === "number"
            ? e.retryAfter * 1000
            : 1000;
      if (wait > MAX_RETRY_AFTER_MS) return result;
      await this.#c.sleep(wait);
    }
  }

  async #meta(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = await this.#send({ name: tool, arguments: args });
    const e = assayErrorOf(result);
    if (e) throw toolError(e, result);
    const out = structuredOf(result);
    if (out === null) throw new AssayError("TOOL_ERROR", textOf(result) ?? `${tool} failed`);
    return out;
  }

  #remember(name: string, quote: PriceQuote | null): void {
    if (quote) this.#c.quotes.set(name, quote);
  }

  /** G3: the cached quote, or a fresh `get_tool` just before signing. */
  async quoteFor(tool: string): Promise<PriceQuote | null> {
    const cached = this.#c.quotes.get(tool);
    if (cached) return cached;
    try {
      const info = await this.get(tool);
      return info.name === tool ? this.#c.quotes.get(tool) : null;
    } catch {
      return null;
    }
  }
}
