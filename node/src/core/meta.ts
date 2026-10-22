/**
 * The `_meta` keys Assay reads and writes on MCP messages (spec section 3), and pure helpers.
 */
import { randomUUID } from "node:crypto";
import { getAddress, isAddress } from "./hex.js";

export const IDEMPOTENCY_META = "assay/idempotency-key";
export const RAIL_META = "assay/rail";
export const VOUCHER_META = "assay/voucher";
export const PAYMENT_REQUIRED_META = "x402/paymentRequired";
export const ERROR_META = "assay/error";
export const RECEIPT_META = "assay/receipt";
export const REPLAYED_META = "assay/replayed";
export const PRICE_META = "assay/price";

export const PAYMENT_REQUIRED_CODE = "PAYMENT_REQUIRED";
export const DELEGATE_INACTIVE_CODE = "PAYMENT_VOUCHER_DELEGATE_INACTIVE";
export const IN_PROGRESS_CODE = "IDEMPOTENCY_IN_PROGRESS";
export const DEBT_CODE = "PAYMENT_DEBT_OUTSTANDING";

/** The meta tools every Assay MCP URL serves. */
export const SEARCH_TOOLS = "search_tools";
export const GET_TOOL = "get_tool";
export const CALL_TOOL = "call_tool";

const IDEMPOTENCY_KEY = /^[\x20-\x7e]{1,128}$/;
const UINT = /^(0|[1-9][0-9]*)$/;
const TOOL_NAME = /^[A-Za-z0-9_-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_PROVIDER_ID_LENGTH = 256;

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 1 to 128 printable ASCII characters (spec section 8). */
export function isIdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && IDEMPOTENCY_KEY.test(value);
}

/**
 * A tool name as sent to the server, unchanged: a standard `verb_noun`, or a provider tool's
 * `{handle}__{tool}` (for example `acme__get_quote`). The server decides what it serves.
 */
export function isToolName(value: unknown): value is string {
  return typeof value === "string" && TOOL_NAME.test(value);
}

/** `assay/price` reduced to what G3 reads: `maxAmount` (atomic units) and its asset. */
export interface PriceQuote {
  maxAmount: string;
  asset: string;
}

export function quoteOf(price: unknown): PriceQuote | null {
  if (!isObject(price)) return null;
  const { maxAmount, asset } = price;
  if (typeof maxAmount !== "string" || !UINT.test(maxAmount) || maxAmount.length > 30) return null;
  if (typeof asset !== "string" || asset.length === 0 || asset.length > 200) return null;
  return { maxAmount, asset };
}

/** The structured output of a meta tool result (`structuredContent`, else the JSON text block). */
export function structuredOf(result: unknown): Record<string, unknown> | null {
  if (!isObject(result) || result.isError === true) return null;
  if (isObject(result.structuredContent)) return result.structuredContent;
  const first = Array.isArray(result.content) ? (result.content as unknown[])[0] : undefined;
  if (isObject(first) && first.type === "text" && typeof first.text === "string" && first.text.length <= 1_000_000) {
    try {
      const parsed: unknown = JSON.parse(first.text);
      return isObject(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** The voucher sent in `_meta["assay/voucher"]` on the paid retry. */
export type VoucherEnvelope = {
  voucher: unknown;
  signature: string;
  providerId: string;
  contractVersion?: number;
};

/** The voucher envelope of the signed retry (spec section 6.4). */
export function voucherEnvelope(
  voucher: unknown,
  signature: string,
  providerId: string,
  contractVersion: unknown,
): VoucherEnvelope {
  return {
    voucher,
    signature,
    providerId,
    ...(typeof contractVersion === "number" && Number.isSafeInteger(contractVersion) && contractVersion >= 1
      ? { contractVersion }
      : {}),
  };
}

/** The payment key as people compare it: the last 8 hex digits, upper case, in two groups. */
export function fingerprint(address: string): string {
  const tail = address.slice(-8).toUpperCase();
  return `${tail.slice(0, 4)} ${tail.slice(4)}`;
}

// ---- for tools built on the protocol (ported from assay-mcp) --------------------------------

/**
 * The params to forward for a host `tools/call`. A host-supplied `assay/voucher` and `assay/rail`
 * are removed (only the caller signs); `assay/idempotency-key` is kept when the host sent one the
 * server accepts, else a UUIDv4 is added. Other keys are kept. Returns a new object; the input is
 * not changed.
 */
export function prepareCallParams(params: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const meta: Record<string, unknown> = isObject(params._meta) ? { ...params._meta } : {};
  delete meta[VOUCHER_META];
  delete meta[RAIL_META];
  if (!isIdempotencyKey(meta[IDEMPOTENCY_META])) meta[IDEMPOTENCY_META] = randomUUID();
  return { ...params, _meta: meta };
}

/** The requirement's `providerId` when it is usable (1-256 characters), else `null`. */
export function providerIdOf(requirement: Readonly<Record<string, unknown>>): string | null {
  const id = requirement.providerId;
  return typeof id === "string" && id.length > 0 && id.length <= MAX_PROVIDER_ID_LENGTH ? id : null;
}

/** The same params with the voucher added (and nothing else changed, the idempotency key included). */
export function withVoucher(
  params: Readonly<Record<string, unknown>>,
  envelope: VoucherEnvelope,
): Record<string, unknown> {
  const meta: Record<string, unknown> = isObject(params._meta) ? { ...params._meta } : {};
  meta[VOUCHER_META] = envelope;
  return { ...params, _meta: meta };
}

/** What a `tools/call` result says about payment. */
export type PaymentState =
  | { kind: "none" }
  | { kind: "debt" }
  | { kind: "payment-required"; requirement: unknown }
  | { kind: "error"; code: string };

/** Sorts a `tools/call` result by its `_meta`. A requirement under another error code is never paid. */
export function paymentState(result: unknown): PaymentState {
  if (!isObject(result) || !isObject(result._meta)) return { kind: "none" };
  const meta = result._meta;
  const error = isObject(meta[ERROR_META]) ? meta[ERROR_META] : null;
  const code = error && typeof error.code === "string" ? error.code : null;
  if (code === DEBT_CODE) return { kind: "debt" };
  if (
    Object.hasOwn(meta, PAYMENT_REQUIRED_META) &&
    meta[PAYMENT_REQUIRED_META] !== undefined &&
    meta[PAYMENT_REQUIRED_META] !== null
  ) {
    if (code === null || code === PAYMENT_REQUIRED_CODE)
      return { kind: "payment-required", requirement: meta[PAYMENT_REQUIRED_META] };
  }
  return code !== null ? { kind: "error", code } : { kind: "none" };
}

/** `[name, quote]` pairs from a remote `tools/list` result (`tools[]._meta["assay/price"]`). */
export function quotesFromList(result: unknown): [string, PriceQuote][] {
  if (!isObject(result) || !Array.isArray(result.tools)) return [];
  const out: [string, PriceQuote][] = [];
  for (const tool of result.tools as unknown[]) {
    if (!isObject(tool) || !isToolName(tool.name)) continue;
    const quote = isObject(tool._meta) ? quoteOf(tool._meta[PRICE_META]) : null;
    if (quote) out.push([tool.name, quote]);
  }
  return out;
}

/** `[name, quote]` pairs from a `search_tools` result (`results[].{name, assayPrice}`). */
export function quotesFromSearch(result: unknown): [string, PriceQuote][] {
  const out = structuredOf(result);
  if (!out || !Array.isArray(out.results)) return [];
  const pairs: [string, PriceQuote][] = [];
  for (const r of out.results as unknown[]) {
    if (!isObject(r) || !isToolName(r.name)) continue;
    const quote = quoteOf(r.assayPrice);
    if (quote) pairs.push([r.name, quote]);
  }
  return pairs;
}

/** The `[name, quote]` of a `get_tool` result (`{name, price}`), when readable. */
export function quoteFromGetTool(result: unknown): [string, PriceQuote] | null {
  const out = structuredOf(result);
  if (!out || !isToolName(out.name)) return null;
  const quote = quoteOf(out.price);
  return quote ? [out.name, quote] : null;
}

/**
 * The tool a `tools/call` pays for: the call's own name, or on `call_tool` the inner
 * `arguments.name`. `null` when the inner name is not readable.
 */
export function paidToolOf(tool: string, params: Readonly<Record<string, unknown>>): string | null {
  if (tool !== CALL_TOOL) return tool;
  const args = params.arguments;
  return isObject(args) && isToolName(args.name) ? args.name : null;
}

/**
 * `{web}/agents/enable-paid?credential={id}#key={address}`: only from an http(s) web origin
 * without user info, a UUID credential id and a checked address; `null` otherwise.
 */
export function enablePaidLink(web: string, credentialId: string, address: string): string | null {
  let base: URL;
  try {
    base = new URL(web);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(base.protocol) || base.username || base.password) return null;
  if (!UUID.test(credentialId)) return null;
  if (!isAddress(address)) return null;
  return `${base.origin}/agents/enable-paid?credential=${credentialId}#key=${getAddress(address)}`;
}

/**
 * The server's `approvalUrl` from the bind answer, only when it is safe to open: http(s), no user
 * info, the same origin as the configured web app (`web`), and a `#key=` fragment naming this
 * payment key. `null` otherwise; the caller then uses {@link enablePaidLink}.
 */
export function serverApprovalLink(web: string, approvalUrl: string | null, address: string): string | null {
  if (approvalUrl === null) return null;
  let base: URL;
  let url: URL;
  try {
    base = new URL(web);
    url = new URL(approvalUrl);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
  if (url.origin !== base.origin) return null;
  const key = new URLSearchParams(url.hash.slice(1)).get("key");
  if (key === null || !isAddress(key) || !isAddress(address)) return null;
  if (getAddress(key) !== getAddress(address)) return null;
  return url.href;
}
