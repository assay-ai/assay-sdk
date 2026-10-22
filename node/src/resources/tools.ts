import { randomUUID } from "node:crypto";
import { namespaceOf } from "../core/caip.js";
import {
  CALL_TOOL,
  ERROR_META,
  GET_TOOL,
  IDEMPOTENCY_META,
  IN_PROGRESS_CODE,
  isIdempotencyKey,
  isObject,
  isToolName,
  PAYMENT_REQUIRED_CODE,
  PAYMENT_REQUIRED_META,
  quoteOf,
  RECEIPT_META,
  REPLAYED_META,
  SEARCH_TOOLS,
  structuredOf,
  VOUCHER_META,
  type PriceQuote,
} from "../core/meta.js";
import type { Money } from "../core/voucher.js";
import {
  AssayError,
  ConfigError,
  errorFromServer,
  PaymentError,
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
  intentId: string;
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
  return errorFromServer(code, message, {
    retryable: e.retryable === true,
    ...(typeof e.fixUrl === "string" ? { fixUrl: e.fixUrl } : {}),
    ...(Object.keys(details).length > 0 ? { details } : {}),
    ...(wait !== undefined ? { retryAfterMs: wait } : {}),
  });
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
  constructor(private readonly c: ClientContext) {}

  /** `search_tools`: tools this URL can run, by what they do. Free. */
  async search(query: string, options: SearchOptions = {}): Promise<SearchResult> {
    const out = await this.#meta(SEARCH_TOOLS, { query, ...options });
    const results = Array.isArray(out.results)
      ? (out.results as unknown[]).filter((r): r is ToolSummary => isObject(r) && typeof r.name === "string")
      : [];
    for (const r of results) this.#remember(r.name, quoteOf(r.assayPrice));
    return { results, nextCursor: typeof out.nextCursor === "string" ? out.nextCursor : null };
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
    const params = { name, arguments: args, _meta: { [IDEMPOTENCY_META]: key } };
    const calledAt = Math.floor(this.c.now() / 1000);
    const first = await this.#send(params);
    const refusal = assayErrorOf(first);
    if (refusal === null) return toResult(first, key);
    const meta = first._meta as Record<string, unknown>;
    const requirement = meta[PAYMENT_REQUIRED_META];
    if (refusal.code !== PAYMENT_REQUIRED_CODE || requirement === undefined || requirement === null)
      throw toolError(refusal, first);

    const fixUrl = typeof refusal.fixUrl === "string" ? { fixUrl: refusal.fixUrl } : {};
    if (this.c.signers.length === 0) {
      throw new PaymentRequiredError(`${name} is a paid tool and this client has no signer`, requirement, fixUrl);
    }
    const network = isObject(requirement) && typeof requirement.network === "string" ? requirement.network : "unknown";
    const ns = namespaceOf(network);
    const signer = this.c.signers.find((s) => s.namespace === ns);
    const scheme = ns === null ? undefined : this.c.schemes.get(ns);
    if (!signer || !scheme) throw new PaymentSchemeUnsupportedError(network);

    const tool = name === CALL_TOOL ? args.name : name;
    if (!isToolName(tool))
      throw new PaymentRefusedError("G1", "G1_NOT_FORWARDED", "the paid tool's name is not readable");
    const input: PrepareInput = { requirement, tool, calledAt, signer, idempotencyKey: key };
    const prepared = await scheme.prepare(input);
    if (!prepared.ok) throw new PaymentRefusedError(prepared.guard, prepared.code, prepared.reason, fixUrl);

    if (this.c.onPayment) {
      let verdict: boolean | void;
      try {
        verdict = await this.c.onPayment(Object.freeze({ ...prepared.details }));
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
    const paid = await this.#send({ ...params, _meta: { ...params._meta, [VOUCHER_META]: envelope } });
    const after = assayErrorOf(paid);
    if (after === null) return toResult(paid, key);
    scheme.onRefused(after.code as string, input);
    throw toolError(after, paid);
  }

  /** One `tools/call`; an `IDEMPOTENCY_IN_PROGRESS` answer waits and sends the same request again. */
  async #send(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    for (let attempt = 0; ; attempt++) {
      const result = await this.c.mcp.request("tools/call", params);
      const e = assayErrorOf(result);
      if (e?.code !== IN_PROGRESS_CODE || attempt >= this.c.maxRetries) return result;
      const wait =
        typeof e.retryAfterMs === "number"
          ? e.retryAfterMs
          : typeof e.retryAfter === "number"
            ? e.retryAfter * 1000
            : 1000;
      if (wait > MAX_RETRY_AFTER_MS) return result;
      await this.c.sleep(wait);
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
    if (quote) this.c.quotes.set(name, quote);
  }

  /** G3: the cached quote, or a fresh `get_tool` just before signing. */
  async quoteFor(tool: string): Promise<PriceQuote | null> {
    const cached = this.c.quotes.get(tool);
    if (cached) return cached;
    try {
      const info = await this.get(tool);
      return info.name === tool ? this.c.quotes.get(tool) : null;
    } catch {
      return null;
    }
  }
}
