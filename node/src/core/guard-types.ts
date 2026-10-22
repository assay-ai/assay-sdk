/**
 * Inputs and results of the local guards (spec section 9). Every value the guards read is passed in:
 * the guards do no I/O, read no clock and keep no state, so the same vectors (`vectors/guards.json`)
 * can drive every implementation.
 *
 * Integers that can exceed 2^53 (amounts, caps, spend) are decimal strings. Addresses the client
 * holds itself (`localKey`, `recordedPayer`, `chain.payer`, `limits.providers`) may be a bare
 * `0x` address in any case or a CAIP-10 account; values from the server's requirement must be
 * checksummed CAIP-10 accounts on the requirement's network.
 */

/** The guard that refused. */
export type GuardId = "G1" | "G2" | "G3" | "G4" | "G5" | "G6" | "G7" | "G8" | "G9" | "G10" | "G11" | "G12";

/**
 * Stable refusal codes, shared with every implementation through the vectors. Each code names
 * one check; never rename or reuse one.
 */
export const REFUSAL_CODES = {
  G1_NOT_A_REQUIREMENT: "G1",
  G1_RAIL: "G1",
  G1_SCHEME: "G1",
  G1_NOT_FORWARDED: "G1",
  G1_FORWARD_TOO_OLD: "G1",
  G2_NETWORK: "G2",
  G2_PAY_TO: "G2",
  G2_ASSET: "G2",
  G2_DECIMALS: "G2",
  G2_AMOUNT: "G2",
  G3_NO_QUOTE: "G3",
  G3_QUOTE_ASSET: "G3",
  G3_ABOVE_QUOTE: "G3",
  G4_NO_CHAIN_READ: "G4",
  G4_PAYER_INVALID: "G4",
  G4_PAYER_CHANGED: "G4",
  G4_NOT_DELEGATED: "G4",
  G4_OTHER_KEY: "G4",
  G4_STALE_READ: "G4",
  G4_INACTIVE: "G4",
  G4_EXPIRED: "G4",
  G5_LOCAL_KEY_INVALID: "G5",
  G5_NO_DELEGATE_SIGNER: "G5",
  G5_DELEGATE_MISMATCH: "G5",
  G5_LOCAL_KEY_IS_PAYER: "G5",
  G6_CAPS_UNREADABLE: "G6",
  G6_DELEGATE_CAP: "G6",
  G6_ESCROW_CAP: "G6",
  G7_LIMITS_UNREADABLE: "G7",
  G7_PER_CALL: "G7",
  G7_STATE_UNREADABLE: "G7",
  G7_PER_DAY: "G7",
  G7_CONFIRMATION_REQUIRED: "G7",
  G7_CONFIRMATION_MISMATCH: "G7",
  G8_PROVIDER_INVALID: "G8",
  G8_PROVIDERS_UNREADABLE: "G8",
  G8_PROVIDER_NOT_ALLOWED: "G8",
  G9_SEQ: "G9",
  G10_REQUEST_HASH: "G10",
  G10_RESOURCE: "G10",
  G10_MAX_TIMEOUT: "G10",
  G11_URL_NOT_PAID: "G11",
  G12_DEBT_OR_SEQ_ENDPOINT: "G12",
  G12_NOT_A_TOOL_CALL: "G12",
  G12_OTHER_TOOL: "G12",
} as const satisfies Record<string, GuardId>;

export type RefusalCode = keyof typeof REFUSAL_CODES;

/** The client's own entry for a network (never from the server), with its CAIP-2 id. */
export interface BuiltInNetwork {
  id: string;
  escrow: string;
  asset: string;
  decimals: number;
}

/**
 * `assay/price` for the forwarded tool (`forwardedCall.tool`, never a name taken from the
 * requirement) in the same exchange (G3). `maxAmount` is in atomic units of `asset`.
 */
export interface Quote {
  maxAmount: string;
  /** CAIP-19; must be the requirement's asset. */
  asset: string;
}

/** The agreed chain read of the payment key's grant and caps (G4, G6). */
export interface ChainState {
  /** The payer the grant was read for. */
  payer: string;
  /** The key the grant was read for; must be the local key. */
  delegate: string;
  /** When the read was made, Unix seconds on the same clock as `nowSeconds`; at most 600 s old. */
  readAt: number;
  delegateMaxVoucherAmount: string;
  maxVoucherAmount: string;
  /** The grant exists and is not revoked. */
  active: boolean;
  /** `delegationOf(...).validUntil`, Unix seconds. */
  validUntil: string | number;
}

/** The local limits (G7, G8). Dollar values are decimal strings. */
export interface LocalLimits {
  /** Dollars per call, e.g. "0.50". */
  perCall: string;
  /** Dollars per rolling 24 h, e.g. "5". */
  perDay: string;
  /** Dollars; above this the user must confirm. `null` is off. */
  confirmAbove: string | null;
  /** Provider allow-list (G8). `null` is off (any provider). */
  providers: string[] | null;
}

/** The default local limits (G7): $0.50 a call, $5 per rolling 24 h. */
export const DEFAULT_LIMITS: Readonly<LocalLimits> = Object.freeze({
  perCall: "0.50",
  perDay: "5",
  confirmAbove: null,
  providers: null,
});

/**
 * The `tools/call` this process forwarded, whose answer carried the requirement (G1, G12).
 * `tool` is the original tool name the call reached (after alias mapping; on `call_tool`, the
 * inner `name`).
 */
export interface ForwardedCall {
  tool: string;
  /** When the call was forwarded, Unix seconds on the same clock as `nowSeconds`. */
  at: number;
}

/** One signed voucher: when it was signed and its atomic amount. */
export interface SignedVoucher {
  at: number;
  amount: string;
}

/**
 * What the user was shown and approved through MCP elicitation (G7 `confirmAbove`). It approves
 * only a requirement with exactly these values; build it with `confirmationFor`.
 */
export interface Confirmation {
  tool: string;
  provider: string;
  amount: string;
  asset: string;
  network: string;
  payTo: string;
  seq: string;
}

export interface GuardContext {
  /** `_meta["x402/paymentRequired"]` as received; untrusted, so not typed. */
  requirement: unknown;
  /** The call this requirement answers, or `null` when there is none (G1). */
  forwardedCall: ForwardedCall | null;
  /** The built-in entry for `requirement.network`, or `null` when the table has none (G2). */
  network: BuiltInNetwork | null;
  /** The quote for this tool (cached ≤ 60 s, or a fresh `get_tool`), or `null` (G3). */
  quote: Quote | null;
  /** The agreed chain read, or `null` when there is none or the RPCs disagree (G4, G6). */
  chain: ChainState | null;
  /** The local delegate key's address (G5). */
  localKey: string;
  /** The payer recorded after a chain-confirmed first voucher, or `null` (G4). */
  recordedPayer: string | null;
  limits: LocalLimits;
  /**
   * Every voucher this key signed (G7). Each one signed after
   * `nowSeconds - 86400` counts, including any dated in the future.
   */
  signed: SignedVoucher[];
  /** The user's approval of this exact payment, or `null` (G7 `confirmAbove`). */
  confirmation: Confirmation | null;
  /** The MCP URL in use (G11). */
  canonicalUrl: string;
  /** The MCP URLs paid calls may go through (G11). */
  paidUrls: string[];
  /**
   * Unix seconds from the local clock, never the `Date`-corrected one, for G1, G4 and the G7
   * window. (The `Date` correction applies only to the voucher's `issuedAt`.)
   */
  nowSeconds: number;
}

export type GuardResult = { ok: true } | { ok: false; guard: GuardId; code: RefusalCode; reason: string };
