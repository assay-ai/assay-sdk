import type { PriceQuote } from "../core/meta.js";
import type { Money } from "../core/voucher.js";
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
}

export type Prepared =
  | {
      ok: true;
      details: PaymentDetails;
      /** Signs the checked voucher; returns the `assay/voucher` envelope. Call at most once. */
      sign(): Promise<Record<string, unknown>>;
      /** Gives back the spend reserved for this voucher, when it is not signed after all. */
      release(): void;
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
}
