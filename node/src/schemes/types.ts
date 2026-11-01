import type { PriceQuote } from "../core/meta.js";
import type { Money } from "../core/voucher.js";
import type { DebtRenewal } from "../core/renew.js";
import type { RestClient } from "../rest.js";
import type { Signer } from "../signer.js";

/** What a caller's `onPayment` hook sees before anything is signed. */
export interface PaymentDetails {
  /** The tool being paid for. */
  tool: string;
  /** CAIP-2. */
  network: string;
  /** The exact amount, in atomic units of `amount.asset`. */
  amount: Money;
  /** CAIP-10 of the provider paid. */
  provider: string;
  /** CAIP-10 of the payer (the escrow owner). */
  payer: string;
  /** The idempotency key of this logical call. */
  idempotencyKey: string;
  /**
   * Set when the call is paid on a channel lane. `amount` above is still the price of this one
   * call (the increase the voucher adds), never the lane's cumulative total.
   */
  channel?: {
    /** The lane, 32 bytes of hex. */
    channelId: string;
    /** The lane's total after this call, in atomic units: what the voucher signs. */
    cumulative: string;
    /** The lane's call counter after this call. */
    calls: number;
    /** What this voucher adds, in atomic units: the price, or "0" when it signs the same total again. */
    increase: string;
  };
}

export interface PrepareInput {
  /** `_meta["x402/paymentRequired"]` as received. Untrusted. */
  requirement: unknown;
  /** The tool the call was for. */
  tool: string;
  /** When the unsigned attempt was sent, Unix seconds (local clock). */
  calledAt: number;
  signer: Signer;
  idempotencyKey: string;
  /** The quote for a tool (G3) on the calling client's URL: cached from list/search/get, or a fresh `get_tool`. */
  quote: (tool: string) => Promise<PriceQuote | null>;
  /** `_meta["assay/channelRequired"]` of the same answer, when there was one. Untrusted. */
  channelOffer?: unknown;
}

/** What the caller reports about a channel voucher once the server answered (or did not). */
export type ChannelOutcome = "served" | "reuse" | "retire" | "unknown";

export type Prepared =
  | {
      ok: true;
      details: PaymentDetails;
      /** Signs the checked voucher; returns the `assay/voucher` envelope. Call at most once. */
      sign(): Promise<Record<string, unknown>>;
      /** Gives back the spend reserved for this voucher, when it is not signed after all. */
      release(): void;
      /** The request `_meta` key the envelope goes under (`assay/voucher` or `assay/channelVoucher`). */
      metaKey: string;
      /** Set on a channel voucher: report the server's answer, so the lane is freed or retired. */
      finish?: (outcome: ChannelOutcome) => Promise<void>;
    }
  | { ok: false; guard: string; code: string; reason: string };

/**
 * One payment scheme per CAIP-2 namespace. `call()` only sees this interface, so a new chain is a
 * new scheme module (plus its vectors and signer variant), with no change to `call()`.
 */
export interface PaymentScheme {
  readonly namespace: string;
  /** Runs every local guard and builds the voucher. Nothing is signed here. */
  prepare(input: PrepareInput): Promise<Prepared>;
  /** Told about a server refusal of a signed voucher (for example a revoked key). */
  onRefused(code: string, input: PrepareInput): Promise<void>;
  /** `_meta["assay/paymentSchemes"]` to send, or `null` to send none (per-call vouchers only). */
  paymentSchemes(): readonly string[] | null;
  /**
   * The server refused a channel voucher with `CHANNEL_ROTATE`, `CHANNEL_LIMIT`,
   * `CHANNEL_SIGNER_EXPIRING` or `CHANNEL_NOT_OFFERED`. The last three stop channel offers for an
   * hour; so do `CHANNEL_ROTATE_PAUSE_COUNT` rotations within an hour.
   */
  channelRefused?(code: string): void;
  /**
   * Renews the payer's channel debts this client signed (throttled: once a minute renews, the
   * rest only lists); `null` when it keeps no lanes. See `Eip155Scheme.renewChannelDebts`.
   */
  renewChannelDebts?(api: RestClient, signer: Signer): Promise<DebtRenewal[] | null>;
}
