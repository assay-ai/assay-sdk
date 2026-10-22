/**
 * The `_meta` keys Assay reads and writes on MCP messages (spec section 3), and pure helpers.
 */

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

/** The meta tools every Assay MCP URL serves. */
export const SEARCH_TOOLS = "search_tools";
export const GET_TOOL = "get_tool";
export const CALL_TOOL = "call_tool";

const IDEMPOTENCY_KEY = /^[\x20-\x7e]{1,128}$/;
const UINT = /^(0|[1-9][0-9]*)$/;
const TOOL_NAME = /^[A-Za-z0-9_-]{1,128}$/;

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 1 to 128 printable ASCII characters (spec section 8). */
export function isIdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && IDEMPOTENCY_KEY.test(value);
}

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

/** The voucher envelope of the signed retry (spec section 6.4). */
export function voucherEnvelope(
  voucher: unknown,
  signature: string,
  providerId: string,
  contractVersion: unknown,
): Record<string, unknown> {
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
