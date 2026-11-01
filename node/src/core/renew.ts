/**
 * Channel-debt renew (API-W2 §1.3, §3.3): a buyer debt on a payment channel can only be settled by
 * the lane's own signer re-signing the exact `(cumulative, calls)` pair it already signed, with
 * fresh times. The web portal cannot (it does not hold the payment key), so the client does it.
 *
 * The I/O (the debt list, the lane record, the signer, the replacement request) is passed in, so
 * the SDK and the MCP proxy run the same steps:
 * - the debts come from `GET /escrow/debts`; only `CHANNEL` debts that are `OPEN` or `WRITTEN_OFF`
 *   are renewed, per-call debts are left to the person (signed in the portal);
 * - the debt names its lane (`channel.channelId`); the renew is signed only on that lane, only when
 *   it is the client's own lane of the same network, escrow, payer and key, and only for a pair the
 *   client signed there whose voucher was served or whose outcome is unknown ({@link renewTarget}):
 *   never a larger pair, never a pair the server refused, never another lane. A debt without a
 *   `channelId` is not renewed;
 * - a renew re-authorises only a total the escrow could already have settled for that lane, so no
 *   spend limit counts it;
 * - bounded: at most {@link MAX_RENEWS_PER_RUN} debts, one request each, no retry.
 */
import { buildChannelVoucher, ChannelBookError, renewLane, renewTarget, RENEW_LIFETIME_SECONDS } from "./channel.js";
import type { ChannelBook, ChannelNetwork, ChannelVoucherTypedData, WireChannelVoucher } from "./channel.js";
import { getAddress, type Address } from "./hex.js";
import { isObject } from "./meta.js";

/** The text an agent reads after a refused paid call whose channel debts are being collected. */
export const CHANNEL_DEBT_RENEWED_TEXT =
  "Assay is collecting an earlier payment your agent already signed. Paid calls usually resume within about 5 minutes. This call was not charged.";
/**
 * The text an agent reads when every debt is being collected and one of them is a per-call debt a
 * person settled in the portal (a per-call `REPLACING` debt, also one first paid on a channel):
 * the agent did not sign it, so the text does not say so.
 */
export const DEBT_COLLECTING_TEXT =
  "Assay is collecting an earlier payment. Paid calls usually resume within about 5 minutes. This call was not charged.";
/** The text an agent reads when its channel debts could not be renewed just now (no per-call debt). */
export const CHANNEL_DEBT_RETRY_TEXT =
  "Assay could not collect an earlier payment your agent signed yet. Call again in a minute or two. This call was not charged.";
/**
 * The text an agent reads when the debts left are another wallet's of the same organization (the
 * paid-call refusal is organization-wide): this agent has nothing to sign for them.
 */
export const OTHER_WALLET_DEBT_TEXT =
  "Another wallet in your organization owes an earlier payment. Paid calls resume once it is settled by that wallet's agent or in the Assay app. This call was not charged.";
/**
 * Renew refusals that will not pass on a later try (the lane, the pair, the signer or the voucher is
 * refused as such): the debt is settled in the portal instead. Any other code is retried later.
 */
export const PERMANENT_RENEW_CODES: ReadonlySet<string> = new Set([
  "CHANNEL_DESYNC",
  "CHANNEL_NOT_OFFERED",
  "CHANNEL_SIGNER_EXPIRING",
  "PAYMENT_VOUCHER_BINDING_MISMATCH",
  "PAYMENT_VOUCHER_SIGNATURE_INVALID",
  "PAYMENT_VOUCHER_MALFORMED",
  "PAYMENT_VOUCHER_DELEGATE_NOT_BOUND",
  "PAYMENT_VOUCHER_DELEGATE_INACTIVE",
]);
/** The most debts one run renews (one replacement request each). */
export const MAX_RENEWS_PER_RUN = 8;

/** One entry of `GET /escrow/debts`, as far as a renew needs it. */
export interface DebtEntry {
  intentId: string;
  state: "OPEN" | "REPLACING" | "WRITTEN_OFF";
  format: "PER_CALL" | "CHANNEL";
  /** CAIP-2 of the payer account. */
  network: string;
  payer: Address;
  /**
   * A `CHANNEL` debt's stored pair and its lane (`channelId`, lower-case hex; `null` when the
   * server did not name it); `null` for a per-call debt.
   */
  channel: { cumulative: bigint; calls: number; channelId: string | null } | null;
  /**
   * `true` when the answer names the session's payer (`account`) and this debt is another wallet's
   * of the same organization (listed because the paid-call refusal is organization-wide).
   */
  otherWallet?: true;
}

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const CANONICAL_UINT = /^(0|[1-9][0-9]*)$/;
const CHANNEL_ID = /^0x[0-9a-fA-F]{64}$/;
/** The payer as the API spells it: any letter case (the address is checksummed here). */
const EIP155_ACCOUNT = /^eip155:([1-9][0-9]{0,15}):(0x[0-9a-fA-F]{40})$/;

/** The readable entries of a `GET /escrow/debts` answer (`data`); anything else is left out. */
export function parseDebtList(data: unknown): DebtEntry[] {
  const list = isObject(data) && Array.isArray(data.debts) ? (data.debts as unknown[]) : [];
  const account = isObject(data) && typeof data.account === "string" ? EIP155_ACCOUNT.exec(data.account) : null;
  const own = account === null ? null : account[2]!.toLowerCase();
  const out: DebtEntry[] = [];
  for (const d of list) {
    if (!isObject(d) || typeof d.intentId !== "string" || !UUID.test(d.intentId)) continue;
    if (d.state !== "OPEN" && d.state !== "REPLACING" && d.state !== "WRITTEN_OFF") continue;
    const payer = typeof d.payer === "string" ? EIP155_ACCOUNT.exec(d.payer) : null;
    if (payer === null) continue;
    const format = d.voucherFormat === "CHANNEL" ? "CHANNEL" : "PER_CALL";
    let channel: DebtEntry["channel"] = null;
    if (format === "CHANNEL") {
      const c = d.channel;
      if (
        !isObject(c) ||
        typeof c.cumulative !== "string" ||
        !CANONICAL_UINT.test(c.cumulative) ||
        typeof c.calls !== "number" ||
        !Number.isSafeInteger(c.calls) ||
        c.calls < 1
      )
        continue;
      const id = typeof c.channelId === "string" && CHANNEL_ID.test(c.channelId) ? c.channelId.toLowerCase() : null;
      channel = { cumulative: BigInt(c.cumulative), calls: c.calls, channelId: id };
    }
    out.push({
      intentId: d.intentId.toLowerCase(),
      state: d.state,
      format,
      network: `eip155:${payer[1]}`,
      payer: getAddress(payer[2]!),
      channel,
      ...(own !== null && payer[2]!.toLowerCase() !== own ? { otherWallet: true as const } : {}),
    });
  }
  return out;
}

/**
 * What a run did with one debt:
 * - `renewed`: the renew was accepted; Assay collects it from the escrow (paid calls resume once
 *   it is held on chain, usually within about 5 minutes);
 * - `pending`: a replacement is being collected already; nothing to do;
 * - `per_call`: a per-call debt: a person signs its replacement in the portal;
 * - `no_lane`: the debt names no lane (`channel.channelId` missing): nothing was signed;
 * - `not_signed_here`: the named lane is not this client's, or the pair is not renewable on it
 *   (another client, a lost record, or a voucher the server refused): nothing was signed;
 * - `other_wallet`: the debt is another wallet's of the same organization: nothing was signed;
 * - `rate_limited`: renewed on this lane a moment ago; try again after `retryAfterMs`;
 * - `refused`: Assay refused the renew (`code`); nothing moved;
 * - `failed`: no answer, or the signer or the record failed; nothing is known to have moved.
 */
export type DebtRenewalStatus =
  | "renewed"
  | "pending"
  | "per_call"
  | "no_lane"
  | "not_signed_here"
  | "other_wallet"
  | "rate_limited"
  | "refused"
  | "failed";

export interface DebtRenewal {
  intentId: string;
  status: DebtRenewalStatus;
  /** The lane renewed (or tried). */
  channelId?: string;
  /** The debt's pair, in atomic units. */
  cumulative?: string;
  calls?: number;
  /** The server's code, for `refused` and `rate_limited`. */
  code?: string;
  retryAfterMs?: number;
  /** `"PER_CALL"` on a `pending` per-call debt: a person signed its replacement, not this agent. */
  format?: "PER_CALL";
}

/** The answer to `POST /escrow/debts/{intentId}/voucher`. */
export type RenewAnswer = { ok: true } | { ok: false; code: string | null; retryAfterMs?: number };

export interface RenewIo {
  /** `GET /escrow/debts` (its `data`). Throws when there is no answer. */
  listDebts(): Promise<unknown>;
  /**
   * Runs `fn` on the lane record under the client's lane lock, and saves the book it returns
   * (when not `null`) before it resolves. Never holds the lock across the network.
   */
  withBook<T>(fn: (book: ChannelBook) => { book: ChannelBook | null; value: T }): Promise<T>;
  /** The client's own network entry for a CAIP-2 id, or `null`. */
  network(id: string): ChannelNetwork | null;
  /** The local payment key, checksummed. */
  signer: Address;
  /** Signs the EIP-712 typed data with that key: a 65-byte hex signature. */
  sign(typedData: ChannelVoucherTypedData): Promise<string>;
  /** `POST /escrow/debts/{intentId}/voucher` with `{ channelVoucher }`. */
  post(
    intentId: string,
    body: { channelVoucher: { voucher: WireChannelVoucher; signature: string } },
  ): Promise<RenewAnswer>;
  /** Unix seconds, local clock, and the server-corrected `issuedAt` for that moment. */
  nowSeconds(): number;
  issuedAt(nowSeconds: number): number;
}

/** Whether every debt in `results` is being collected already (renewed now or before). */
export function allDebtsCollecting(results: readonly DebtRenewal[]): boolean {
  return results.length > 0 && results.every((r) => r.status === "renewed" || r.status === "pending");
}

/**
 * Whether some debt in `results` can no longer be renewed by this client (`not_signed_here`,
 * `no_lane`, or `refused` with a {@link PERMANENT_RENEW_CODES} code): a person settles it in the
 * portal once the portal offers it.
 */
export function someDebtUnrenewable(results: readonly DebtRenewal[]): boolean {
  return results.some(
    (r) =>
      r.status === "not_signed_here" ||
      r.status === "no_lane" ||
      (r.status === "refused" && r.code !== undefined && PERMANENT_RENEW_CODES.has(r.code)),
  );
}

/** The text an agent reads when a channel debt can no longer be renewed by this client. */
export function channelDebtNoRecordText(web: string): string {
  return `Your agent no longer has the payment record for an earlier channel payment. Settle it in the Assay app at ${web.replace(/\/+$/, "")}/funding once it is offered there.`;
}

/**
 * What the agent reads after a paid call refused for a debt, given the renew results:
 * - every debt is being collected: {@link CHANNEL_DEBT_RENEWED_TEXT}, or {@link DEBT_COLLECTING_TEXT}
 *   when one of them is a per-call debt a person settled in the portal (retryable);
 * - a channel debt this client can no longer renew (or one refused for good): {@link channelDebtNoRecordText};
 * - a per-call debt (a person signs it in the portal), or no results: `null` (the caller's own text);
 * - a channel debt of another wallet of the organization: {@link OTHER_WALLET_DEBT_TEXT};
 * - only channel debts that could not be renewed just now: {@link CHANNEL_DEBT_RETRY_TEXT} (retryable).
 */
export function channelDebtAnswer(
  results: readonly DebtRenewal[] | null,
  web: string,
): { text: string; retryable: boolean } | null {
  if (results === null || results.length === 0) return null;
  if (allDebtsCollecting(results)) {
    const byPerson = results.some((r) => r.status === "pending" && r.format === "PER_CALL");
    return { text: byPerson ? DEBT_COLLECTING_TEXT : CHANNEL_DEBT_RENEWED_TEXT, retryable: true };
  }
  if (someDebtUnrenewable(results)) return { text: channelDebtNoRecordText(web), retryable: false };
  if (results.some((r) => r.status === "per_call")) return null;
  if (results.some((r) => r.status === "other_wallet")) return { text: OTHER_WALLET_DEBT_TEXT, retryable: false };
  return { text: CHANNEL_DEBT_RETRY_TEXT, retryable: true };
}

export interface RenewRunOptions {
  /**
   * `false`: only list the debts (the client renewed a moment ago): nothing is signed; an open
   * channel debt comes back as it did in `previous` (`renewed` as `pending`; `no_lane`,
   * `not_signed_here` and a permanent `refused` as they were), any other as `rate_limited` with
   * `retryAfterMs`. Default `true`.
   */
  renew?: boolean;
  retryAfterMs?: number;
  /** The results of the client's last renewing run, by `intentId` (used when `renew` is `false`). */
  previous?: ReadonlyMap<string, DebtRenewal>;
}

/** The most channel debts one run looks at (the rest come back `rate_limited`). */
const MAX_DEBTS_PER_RUN = 64;

/**
 * Lists the payer's debts and renews every `CHANNEL` debt this client signed, one request per
 * debt and at most one signature per lane; returns one result per debt it saw (per-call debts as
 * `per_call`). At most {@link MAX_RENEWS_PER_RUN} requests per run; a debt that signs nothing
 * (`no_lane`, `not_signed_here`) does not count. Never throws for a single debt: its result says
 * what happened. Throws only when the debt list cannot be read.
 */
export async function renewChannelDebts(io: RenewIo, options: RenewRunOptions = {}): Promise<DebtRenewal[]> {
  const results = new Map<string, DebtRenewal>();
  const pairOf = (d: DebtEntry) => ({
    cumulative: d.channel!.cumulative.toString(),
    calls: d.channel!.calls,
    ...(d.channel!.channelId !== null ? { channelId: d.channel!.channelId } : {}),
  });
  const later = (d: DebtEntry): DebtRenewal => {
    const prev = options.renew === false ? options.previous?.get(d.intentId) : undefined;
    if (prev?.status === "renewed" || prev?.status === "pending")
      return { intentId: d.intentId, status: "pending", ...pairOf(d) };
    if (prev?.status === "no_lane" || prev?.status === "not_signed_here")
      return { intentId: d.intentId, status: prev.status, ...pairOf(d) };
    if (prev?.status === "refused" && prev.code !== undefined && PERMANENT_RENEW_CODES.has(prev.code))
      return { intentId: d.intentId, status: "refused", code: prev.code, ...pairOf(d) };
    if (d.otherWallet) return { intentId: d.intentId, status: "other_wallet", ...pairOf(d) };
    return {
      intentId: d.intentId,
      status: "rate_limited",
      ...pairOf(d),
      ...(options.retryAfterMs !== undefined ? { retryAfterMs: options.retryAfterMs } : {}),
    };
  };
  const signedLanes = new Set<string>();
  let posts = 0;
  let looked = 0;
  let entries = parseDebtList(await io.listDebts());
  for (;;) {
    for (const d of entries) {
      if (results.has(d.intentId)) continue;
      if (d.state === "REPLACING") {
        results.set(d.intentId, {
          intentId: d.intentId,
          status: "pending",
          ...(d.channel ? pairOf(d) : { format: "PER_CALL" as const }),
        });
      } else if (d.format === "PER_CALL") {
        results.set(d.intentId, { intentId: d.intentId, status: "per_call" });
      } else if (d.otherWallet) {
        // Another wallet's lane: never signed here (its own agent renews it).
        results.set(d.intentId, { intentId: d.intentId, status: "other_wallet", ...pairOf(d) });
      }
    }
    if (options.renew === false || posts >= MAX_RENEWS_PER_RUN || looked >= MAX_DEBTS_PER_RUN) break;
    const next = entries
      .filter((d) => d.format === "CHANNEL" && !results.has(d.intentId))
      .sort((a, b) =>
        a.channel!.cumulative < b.channel!.cumulative ? 1 : a.channel!.cumulative > b.channel!.cumulative ? -1 : 0,
      );
    const debt = next[0];
    if (debt === undefined) break;
    looked++;
    const lane = debt.channel!.channelId;
    // At most one signature per lane per run: a second debt on a lane already signed waits.
    if (lane !== null && signedLanes.has(lane)) {
      results.set(debt.intentId, later(debt));
      continue;
    }
    const { result, signed, posted } = await renewOne(io, debt);
    if (signed && lane !== null) signedLanes.add(lane);
    results.set(debt.intentId, result);
    if (posted) {
      posts++;
      // Listed again after each request: one renew settles every lapsed call of its lane up to the
      // pair, so lower debts on that lane show as REPLACING now.
      try {
        entries = parseDebtList(await io.listDebts());
      } catch {
        break;
      }
    }
  }
  // Channel debts not reached in this run (throttled, or past the per-run caps): later.
  for (const d of entries) if (!results.has(d.intentId) && d.format === "CHANNEL") results.set(d.intentId, later(d));
  return [...results.values()];
}

interface RenewStep {
  result: DebtRenewal;
  /** A signature was made (whatever happened next). */
  signed: boolean;
  /** The replacement request was sent. */
  posted: boolean;
}

async function renewOne(io: RenewIo, debt: DebtEntry): Promise<RenewStep> {
  const local = (result: DebtRenewal): RenewStep => ({ result, signed: false, posted: false });
  const sent = (result: DebtRenewal): RenewStep => ({ result, signed: true, posted: true });
  const pair = debt.channel!;
  const base = { intentId: debt.intentId, cumulative: pair.cumulative.toString(), calls: pair.calls };
  if (pair.channelId === null) return local({ ...base, status: "no_lane" });
  const at = { ...base, channelId: pair.channelId };
  const net = io.network(debt.network);
  if (net === null) return local({ ...at, status: "not_signed_here" });
  const target = {
    channelId: pair.channelId,
    network: net.id,
    escrow: net.escrow,
    payer: debt.payer,
    signer: io.signer,
    cumulative: pair.cumulative,
    calls: pair.calls,
  };
  let built;
  try {
    const issuedAt = io.issuedAt(io.nowSeconds());
    // Write-ahead: the renew's issuedAt is on record before it is signed.
    const found = await io.withBook((book) => {
      const lane = renewTarget(book, target);
      if (lane === null) return { book: null, value: null };
      const r = renewLane(book, lane.channelId, pair.cumulative, pair.calls, issuedAt, RENEW_LIFETIME_SECONDS);
      return { book: r.book, value: { lane, step: r.step } };
    });
    if (found === null) return local({ ...at, status: "not_signed_here" });
    // The server takes issuedAt up to 60 s ahead of its clock; a lane ahead of that cannot renew now.
    if (found.step.issuedAt > issuedAt + 60) return local({ ...at, status: "failed" });
    built = buildChannelVoucher(found.lane, found.step, net);
  } catch (err) {
    if (err instanceof ChannelBookError) return local({ ...at, status: "not_signed_here" });
    return local({ ...at, status: "failed" });
  }
  let signature: string;
  try {
    signature = await io.sign(built.typedData);
  } catch {
    return { result: { ...at, status: "failed" }, signed: true, posted: false };
  }
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature))
    return { result: { ...at, status: "failed" }, signed: true, posted: false };
  let answer: RenewAnswer;
  try {
    answer = await io.post(debt.intentId, { channelVoucher: { voucher: built.wire, signature } });
  } catch {
    return sent({ ...at, status: "failed" });
  }
  if (answer.ok) return sent({ ...at, status: "renewed" });
  if (answer.code === "PAYMENT_DEBT_REPLACEMENT_PENDING") return sent({ ...at, status: "pending" });
  if (answer.code === "PAYMENT_UNSETTLED_LIMIT")
    return sent({
      ...at,
      status: "rate_limited",
      code: answer.code,
      ...(answer.retryAfterMs !== undefined ? { retryAfterMs: answer.retryAfterMs } : {}),
    });
  return sent(answer.code === null ? { ...at, status: "failed" } : { ...at, status: "refused", code: answer.code });
}
