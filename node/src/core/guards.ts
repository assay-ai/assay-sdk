import { parseCaip10 } from "./caip.js";
import { MAX_CLOCK_CORRECTION_SECONDS } from "./clock.js";
import { getAddress, isAddress } from "./hex.js";
import type { Confirmation, GuardContext, GuardId, GuardResult, RefusalCode } from "./guard-types.js";

/** What the SDK tells its caller to do in the G4 payer-changed reason (`{run}` in the vectors). */
export const RUN = "paidCalls.bind() and open";

/**
 * The local guards (spec section 9): the checks that run before the client signs a voucher. A
 * voucher is signed only when `checkAll` returns `{ok: true}`. Ported unchanged from `assay-mcp`;
 * `vectors/eip155/guards.json` and `seq.json` pin the order, codes and boundaries.
 *
 * - Pure: every input is in the context; no I/O, no clock, no state.
 * - Fail closed: a missing, malformed or unexpected value is a refusal, never a pass, and the
 *   function never throws.
 * - The guards run in the order G1..G12 and the first refusal is returned, so every
 *   implementation reports the same guard and code for the same context (`vectors/guards.json`).
 *   The G7 confirmation (`confirmAbove`) runs last of all: the user is asked only about a payment
 *   every other guard has already accepted.
 * - A reason never carries an address, an amount or a URL from the server.
 */

export const GUARD_ORDER: readonly GuardId[] = [
  "G1",
  "G2",
  "G3",
  "G4",
  "G5",
  "G6",
  "G7",
  "G8",
  "G9",
  "G10",
  "G11",
  "G12",
];

/**
 * G1: the oldest forwarded call a requirement may answer. A call may take up to the 120 s request
 * timeout (§7.6) before its `PAYMENT_REQUIRED` arrives.
 */
export const FORWARDED_CALL_MAX_AGE_SECONDS = 120;
/** G4: the chain is read before the first voucher and at most every 10 minutes (§7.8). */
export const CHAIN_READ_MAX_AGE_SECONDS = 600;
/** G4: how far in the future a read may be dated: the clock-skew clamp (§7.7, T20). */
export const CHAIN_READ_MAX_FUTURE_SECONDS = MAX_CLOCK_CORRECTION_SECONDS;
/** G7: the rolling window of `perDay`. */
export const SPEND_WINDOW_SECONDS = 86_400;
/** G9: a `seq` at or above this would let one voucher void every later one (T17). */
export const MAX_SEQ_EXCLUSIVE = 2n ** 53n;
/** G10 bounds. */
export const MAX_RESOURCE_LENGTH = 2048;
export const MAX_TIMEOUT_SECONDS = 300;
/** G12: the only resource a voucher may pay for is the forwarded tool's. */
export const TOOL_RESOURCE_PREFIX = "/mcp/tools/";

/** G4: the text the user sees when the server names a payer other than the recorded one. */
export const PAYER_CHANGED_REASON = `payer changed; run ${RUN} enable-paid`;

const MAX_UINT64 = 2n ** 64n - 1n;
const CANONICAL_UINT = /^(0|[1-9][0-9]*)$/;
const CAIP2_EIP155 = /^eip155:([1-9][0-9]*)$/;
const CAIP19_ERC20_ANY_CASE = /^eip155:([1-9][0-9]*)\/erc20:(0x[0-9a-fA-F]{40})$/;
const BARE_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const LOCAL_ADDRESS = /^(?:eip155:([1-9][0-9]*):)?(0x[0-9a-fA-F]{40})$/;
const REQUEST_HASH = /^sha256:[0-9a-fA-F]{64}$/;
const TOOL_CALL_RESOURCE = /^\/mcp\/tools\/[A-Za-z0-9_-]+$/;
const DEBT_OR_SEQ_ENDPOINT = /\/escrow\/(debts|next-seq)(\/|$)/;
const CONFIRMATION_KEYS = ["tool", "provider", "amount", "asset", "network", "payTo", "seq"] as const;

type Refusal = { ok: false; guard: GuardId; code: RefusalCode; reason: string };
type Req = Record<string, unknown>;
/** What earlier guards established, for the later ones. */
interface Checked {
  req: Req;
  tool: string;
  now: number;
  chainId: number;
  decimals: number;
  amount: bigint;
  payer: string;
}

function refuse(guard: GuardId, code: RefusalCode, reason: string): Refusal {
  return { ok: false, guard, code, reason };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A canonical non-negative decimal integer string (or, where allowed, a safe integer). */
function uint(value: unknown, max: bigint | null, allowNumber = false): bigint | null {
  let n: bigint;
  if (typeof value === "string" && CANONICAL_UINT.test(value)) n = BigInt(value);
  else if (allowNumber && typeof value === "number" && Number.isSafeInteger(value) && value >= 0) n = BigInt(value);
  else return null;
  return max !== null && n > max ? null : n;
}

/** Unix seconds: a non-negative safe integer. */
function seconds(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** A value from the server's requirement: a checksummed CAIP-10 account on `chainId`. */
function requirementAccount(value: unknown, chainId: number): string | null {
  const parsed = typeof value === "string" ? parseCaip10(value) : null;
  if (!parsed || parsed.chainId !== chainId) return null;
  return getAddress(parsed.address);
}

/** A value the client holds itself: a `0x` address in any case, or a CAIP-10 account on `chainId`. */
function localAccount(value: unknown, chainId: number): string | null {
  const m = typeof value === "string" ? LOCAL_ADDRESS.exec(value) : null;
  if (!m || !isAddress(m[2])) return null;
  if (m[1] !== undefined && Number(m[1]) !== chainId) return null;
  return getAddress(m[2]!);
}

/** A bare `0x` address that is already checksummed, as the chain module returns it. */
function checksummedAddress(value: unknown): string | null {
  if (typeof value !== "string" || !BARE_ADDRESS.test(value) || !isAddress(value)) return null;
  return getAddress(value) === value ? value : null;
}

/** A CAIP-19 erc20 asset as `{chainId, lower-case address}`, or null. */
function erc20(value: unknown): { chain: string; address: string } | null {
  const m = typeof value === "string" ? CAIP19_ERC20_ANY_CASE.exec(value) : null;
  return m ? { chain: m[1]!, address: m[2]!.toLowerCase() } : null;
}

/**
 * The same asset, as the signer compares it: the exact CAIP-19 string (checksummed address), and
 * a readable erc20 id. Never looser than the signer, so a payment the guards accept is never
 * refused at signing time (after the user was asked to confirm it).
 */
function sameAsset(a: unknown, b: unknown): boolean {
  return typeof a === "string" && a === b && erc20(a) !== null;
}

/**
 * Dollars (a plain decimal string such as "0.50", "5" or ".5") as atomic units of an asset with
 * `decimals` places, in exact integer arithmetic. `null` for anything else, including more places
 * than the asset has.
 */
export function usdToAtomic(value: string, decimals: number): bigint | null {
  if (typeof value !== "string" || !Number.isInteger(decimals) || decimals < 0) return null;
  const m = /^(?:([0-9]+)(?:\.([0-9]+))?|\.([0-9]+))$/.exec(value);
  if (!m) return null;
  const whole = m[1] ?? "0";
  const fraction = m[2] ?? m[3] ?? "";
  if (fraction.length > decimals) return null;
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}

/**
 * What the user must approve when `confirmAbove` applies: the values shown in the prompt. The
 * caller shows these, and passes the same object back as `confirmation` once the user approves.
 * `null` when the context has no readable requirement or forwarded call.
 */
export function confirmationFor(ctx: Pick<GuardContext, "requirement" | "forwardedCall">): Confirmation | null {
  const req = ctx.requirement;
  const call = ctx.forwardedCall;
  if (!isPlainObject(req) || !isPlainObject(call) || !isPlainObject(req.amount)) return null;
  const values = {
    tool: call.tool,
    provider: req.provider,
    amount: req.amount.amount,
    asset: req.amount.asset,
    network: req.network,
    payTo: req.payTo,
    seq: req.seq,
  };
  return Object.values(values).every((v) => typeof v === "string") ? (values as Confirmation) : null;
}

function g1(ctx: GuardContext): Refusal | { tool: string; now: number } {
  const req = ctx.requirement;
  if (!isPlainObject(req)) return refuse("G1", "G1_NOT_A_REQUIREMENT", "the payment request is not a requirement");
  if (req.rail !== "B") return refuse("G1", "G1_RAIL", "the payment request is not on rail B");
  if (req.scheme !== "voucher") return refuse("G1", "G1_SCHEME", "the payment request is not a voucher");
  const call = ctx.forwardedCall;
  const at = isPlainObject(call) ? seconds(call.at) : null;
  if (!isPlainObject(call) || typeof call.tool !== "string" || call.tool.length === 0 || at === null) {
    return refuse("G1", "G1_NOT_FORWARDED", "the payment request is not the answer to a forwarded tool call");
  }
  const now = seconds(ctx.nowSeconds);
  if (now === null || at > now || now - at > FORWARDED_CALL_MAX_AGE_SECONDS) {
    return refuse("G1", "G1_FORWARD_TOO_OLD", "the payment request does not answer a tool call forwarded just now");
  }
  return { tool: call.tool, now };
}

function g2(ctx: GuardContext, req: Req): Refusal | Pick<Checked, "chainId" | "decimals" | "amount"> {
  const net = ctx.network;
  const chain = isPlainObject(net) && typeof net.id === "string" ? CAIP2_EIP155.exec(net.id) : null;
  if (!isPlainObject(net) || !chain || req.network !== net.id) {
    return refuse("G2", "G2_NETWORK", "the network is not in the built-in table");
  }
  const chainId = Number(chain[1]);
  const escrow = typeof net.escrow === "string" ? parseCaip10(net.escrow) : null;
  const payTo = requirementAccount(req.payTo, chainId);
  if (!escrow || escrow.chainId !== chainId || payTo === null || payTo !== getAddress(escrow.address)) {
    return refuse("G2", "G2_PAY_TO", "the payment is not to the built-in escrow");
  }
  const money = req.amount;
  if (!isPlainObject(money)) return refuse("G2", "G2_AMOUNT", "the amount is missing");
  if (!sameAsset(money.asset, net.asset) || erc20(net.asset)!.chain !== chain[1]) {
    return refuse("G2", "G2_ASSET", "the asset is not the built-in asset");
  }
  // The signer's bound on built-in decimals (`network.internal.ts`).
  if (!Number.isInteger(net.decimals) || net.decimals < 0 || net.decimals > 36 || money.decimals !== net.decimals) {
    return refuse("G2", "G2_DECIMALS", "the asset decimals are not the built-in decimals");
  }
  const amount = uint(money.amount, MAX_UINT64);
  if (amount === null || amount === 0n) return refuse("G2", "G2_AMOUNT", "the amount is not a positive integer");
  return { chainId, decimals: net.decimals, amount };
}

function g3(ctx: GuardContext, c: Omit<Checked, "payer">): Refusal | null {
  const quote = ctx.quote;
  const max = isPlainObject(quote) ? uint(quote.maxAmount, MAX_UINT64) : null;
  if (!isPlainObject(quote) || max === null)
    return refuse("G3", "G3_NO_QUOTE", "there is no price quote for this tool");
  if (!sameAsset(quote.asset, (c.req.amount as Req).asset)) {
    return refuse("G3", "G3_QUOTE_ASSET", "the price quote is in another asset");
  }
  if (c.amount > max) return refuse("G3", "G3_ABOVE_QUOTE", "the amount is above the quoted price");
  return null;
}

function g4(ctx: GuardContext, c: Omit<Checked, "payer">): Refusal | string {
  const payer = requirementAccount(c.req.payer, c.chainId);
  if (payer === null) return refuse("G4", "G4_PAYER_INVALID", "the payer is not a valid account");
  if (ctx.recordedPayer !== null && localAccount(ctx.recordedPayer, c.chainId) !== payer) {
    return refuse("G4", "G4_PAYER_CHANGED", PAYER_CHANGED_REASON);
  }
  const chain = ctx.chain;
  if (!isPlainObject(chain)) {
    return refuse("G4", "G4_NO_CHAIN_READ", "the payment key's grant could not be read from the chain");
  }
  const validUntil = uint(chain.validUntil, MAX_UINT64, true);
  const chainPayer = localAccount(chain.payer, c.chainId);
  const chainDelegate = checksummedAddress(chain.delegate);
  const readAt = seconds(chain.readAt);
  if (
    validUntil === null ||
    chainPayer === null ||
    chainDelegate === null ||
    readAt === null ||
    typeof chain.active !== "boolean"
  ) {
    return refuse("G4", "G4_NO_CHAIN_READ", "the payment key's grant could not be read from the chain");
  }
  if (readAt - c.now > CHAIN_READ_MAX_FUTURE_SECONDS || c.now - readAt > CHAIN_READ_MAX_AGE_SECONDS) {
    return refuse("G4", "G4_STALE_READ", "the chain read is too old");
  }
  // An unreadable local key is G5's refusal; here only a readable, different key refuses.
  const local = localAccount(ctx.localKey, c.chainId);
  if (local !== null && chainDelegate !== local) {
    return refuse("G4", "G4_OTHER_KEY", "the chain read is for another payment key");
  }
  if (chainPayer !== payer) return refuse("G4", "G4_NOT_DELEGATED", "the payer has not authorised this payment key");
  if (chain.active !== true) return refuse("G4", "G4_INACTIVE", "the payment key's grant is not active");
  if (validUntil <= BigInt(c.now)) return refuse("G4", "G4_EXPIRED", "the payment key's grant has expired");
  return payer;
}

function g5(ctx: GuardContext, c: Checked): Refusal | null {
  const local = localAccount(ctx.localKey, c.chainId);
  if (local === null) return refuse("G5", "G5_LOCAL_KEY_INVALID", "the local payment key is not readable");
  const signers = c.req.signers;
  if (!Array.isArray(signers) || !signers.includes("delegate")) {
    return refuse("G5", "G5_NO_DELEGATE_SIGNER", "the server does not accept a payment key signature");
  }
  if (requirementAccount(c.req.delegate, c.chainId) !== local) {
    return refuse("G5", "G5_DELEGATE_MISMATCH", "the bound payment key is not this computer's key");
  }
  if (local === c.payer) return refuse("G5", "G5_LOCAL_KEY_IS_PAYER", "the local key is the payer");
  return null;
}

function g6(ctx: GuardContext, c: Checked): Refusal | null {
  const chain = ctx.chain as unknown as Record<string, unknown>;
  const delegateMax = uint(chain.delegateMaxVoucherAmount, MAX_UINT64);
  const escrowMax = uint(chain.maxVoucherAmount, MAX_UINT64);
  if (delegateMax === null || escrowMax === null) {
    return refuse("G6", "G6_CAPS_UNREADABLE", "the on-chain caps could not be read");
  }
  if (c.amount > delegateMax)
    return refuse("G6", "G6_DELEGATE_CAP", "the amount is above the payment key's on-chain cap");
  if (c.amount > escrowMax) return refuse("G6", "G6_ESCROW_CAP", "the amount is above the escrow's on-chain cap");
  return null;
}

/** G7 caps. Returns the `confirmAbove` threshold (atomic) for the last step, or a refusal. */
function g7(ctx: GuardContext, c: Checked): Refusal | { confirmAbove: bigint | null } {
  const limits = ctx.limits;
  if (!isPlainObject(limits)) return refuse("G7", "G7_LIMITS_UNREADABLE", "the local limits are not readable");
  const perCall = usdToAtomic(limits.perCall as string, c.decimals);
  const perDay = usdToAtomic(limits.perDay as string, c.decimals);
  const confirmAbove = limits.confirmAbove === null ? null : usdToAtomic(limits.confirmAbove as string, c.decimals);
  if (perCall === null || perDay === null || (limits.confirmAbove !== null && confirmAbove === null)) {
    return refuse("G7", "G7_LIMITS_UNREADABLE", "the local limits are not readable");
  }
  if (c.amount > perCall) return refuse("G7", "G7_PER_CALL", "the amount is above the local limit per call");
  if (!Array.isArray(ctx.signed))
    return refuse("G7", "G7_STATE_UNREADABLE", "the record of signed payments is not readable");
  let spent = 0n;
  for (const entry of ctx.signed as unknown[]) {
    const at = isPlainObject(entry) ? seconds(entry.at) : null;
    const amount = isPlainObject(entry) ? uint(entry.amount, MAX_UINT64) : null;
    if (at === null || amount === null) {
      return refuse("G7", "G7_STATE_UNREADABLE", "the record of signed payments is not readable");
    }
    // Inside the window, and anything dated in the future (a clock moved back) still counts.
    if (at > c.now - SPEND_WINDOW_SECONDS) spent += amount;
  }
  if (spent + c.amount > perDay)
    return refuse("G7", "G7_PER_DAY", "the amount would pass the local limit per 24 hours");
  return { confirmAbove };
}

function g8(ctx: GuardContext, c: Checked): Refusal | null {
  const provider = requirementAccount(c.req.provider, c.chainId);
  if (provider === null) return refuse("G8", "G8_PROVIDER_INVALID", "the provider is not a valid account");
  const providers = (ctx.limits as unknown as Record<string, unknown>).providers;
  if (providers === null) return null;
  if (!Array.isArray(providers))
    return refuse("G8", "G8_PROVIDERS_UNREADABLE", "the provider allow-list is not readable");
  const allowed = providers.map((p) => localAccount(p, c.chainId));
  if (allowed.includes(null)) return refuse("G8", "G8_PROVIDERS_UNREADABLE", "the provider allow-list is not readable");
  if (!allowed.includes(provider))
    return refuse("G8", "G8_PROVIDER_NOT_ALLOWED", "the provider is not in the allow-list");
  return null;
}

function g9(c: Checked): Refusal | null {
  const seq = c.req.seq;
  const ok = typeof seq === "string" && /^[1-9][0-9]*$/.test(seq) && BigInt(seq) < MAX_SEQ_EXCLUSIVE;
  return ok ? null : refuse("G9", "G9_SEQ", "the sequence number is out of range");
}

function g10(c: Checked): Refusal | null {
  const { requestHash, resource, maxTimeoutSeconds: t } = c.req;
  if (typeof requestHash !== "string" || !REQUEST_HASH.test(requestHash)) {
    return refuse("G10", "G10_REQUEST_HASH", "the request hash is malformed");
  }
  // Length in Unicode code points, so every implementation counts the same.
  const length = typeof resource === "string" ? [...resource].length : 0;
  if (length < 1 || length > MAX_RESOURCE_LENGTH)
    return refuse("G10", "G10_RESOURCE", "the resource length is out of range");
  if (typeof t !== "number" || !Number.isInteger(t) || t < 1 || t > MAX_TIMEOUT_SECONDS) {
    return refuse("G10", "G10_MAX_TIMEOUT", "the timeout is out of range");
  }
  return null;
}

function g11(ctx: GuardContext): Refusal | null {
  const ok =
    typeof ctx.canonicalUrl === "string" && Array.isArray(ctx.paidUrls) && ctx.paidUrls.includes(ctx.canonicalUrl);
  return ok ? null : refuse("G11", "G11_URL_NOT_PAID", "paid calls through this server are off");
}

function g12(c: Checked): Refusal | null {
  const resource = c.req.resource as string;
  let decoded = resource;
  try {
    decoded = decodeURIComponent(resource);
  } catch {
    // Not decodable: the raw form is checked, and it cannot be a tool call either.
  }
  if ([resource, decoded].some((r) => DEBT_OR_SEQ_ENDPOINT.test(r.toLowerCase().split(/[?#]/)[0]!))) {
    return refuse("G12", "G12_DEBT_OR_SEQ_ENDPOINT", "the payment is for a debt or sequence endpoint");
  }
  if (!TOOL_CALL_RESOURCE.test(resource))
    return refuse("G12", "G12_NOT_A_TOOL_CALL", "the payment is not for a tool call");
  if (resource !== TOOL_RESOURCE_PREFIX + c.tool) {
    return refuse("G12", "G12_OTHER_TOOL", "the payment is for another tool than the one called");
  }
  return null;
}

/** The last step: above `confirmAbove`, only a confirmation of exactly this payment passes. */
function confirm(ctx: GuardContext, c: Checked, confirmAbove: bigint | null): Refusal | null {
  const given = ctx.confirmation;
  if (given !== null && !isPlainObject(given)) {
    return refuse("G7", "G7_CONFIRMATION_MISMATCH", "the confirmation is not readable");
  }
  if (confirmAbove === null || c.amount <= confirmAbove) return null;
  if (given === null) {
    return refuse("G7", "G7_CONFIRMATION_REQUIRED", "the amount is above the confirmation limit and was not confirmed");
  }
  const expected = confirmationFor(ctx);
  const keys = Object.keys(given);
  const same =
    expected !== null &&
    keys.length === CONFIRMATION_KEYS.length &&
    CONFIRMATION_KEYS.every((k) => Object.hasOwn(given, k) && given[k] === expected[k]);
  return same ? null : refuse("G7", "G7_CONFIRMATION_MISMATCH", "the confirmation was for another payment");
}

function run(ctx: GuardContext): GuardResult {
  if (!isPlainObject(ctx)) return refuse("G1", "G1_NOT_A_REQUIREMENT", "there is no payment request");
  const call = g1(ctx);
  if ("ok" in call) return call;
  const req = ctx.requirement as Req;
  const net = g2(ctx, req);
  if ("ok" in net) return net;
  const base = { req, ...call, ...net };
  const quote = g3(ctx, base);
  if (quote) return quote;
  const payer = g4(ctx, base);
  if (typeof payer !== "string") return payer;
  const c: Checked = { ...base, payer };
  const early = g5(ctx, c) ?? g6(ctx, c);
  if (early) return early;
  const caps = g7(ctx, c);
  if ("ok" in caps) return caps;
  return g8(ctx, c) ?? g9(c) ?? g10(c) ?? g11(ctx) ?? g12(c) ?? confirm(ctx, c, caps.confirmAbove) ?? { ok: true };
}

/** Runs G1..G12 in order, then the G7 confirmation. `{ok: true}` only when all pass; never throws. */
export function checkAll(ctx: GuardContext): GuardResult {
  try {
    return run(ctx);
  } catch {
    // An unexpected shape is a refusal, never a pass. G1 is the guard that owns "not a request".
    return refuse("G1", "G1_NOT_A_REQUIREMENT", "the payment request could not be checked");
  }
}
