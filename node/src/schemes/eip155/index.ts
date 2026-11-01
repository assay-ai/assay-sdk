/**
 * The `eip155` payment scheme: EIP-712 vouchers and the EIP-712 key binding, behind the
 * {@link PaymentScheme} interface. Guards G1-G12 run on one frozen copy of the requirement, the
 * voucher is built from that same copy and the caller's own network entry, and only then signed.
 */
import { eip155ChainId, parseCaip10, parseCaip19Erc20 } from "../../core/caip.js";
import { ChainReader, isUsableRpcUrl } from "../../core/chain.js";
import { correctedNow } from "../../core/clock.js";
import { SignerRefusal } from "../../core/errors.js";
import type { GuardContext, GuardOptions, GuardResult, SignedVoucher } from "../../core/guard-types.js";
import { checkAll, usdToAtomic } from "../../core/guards.js";
import { getAddress, type Address, type Hex } from "../../core/hex.js";
import { isObject, VOUCHER_META, voucherEnvelope } from "../../core/meta.js";
import {
  advanceLane,
  buildChannelVoucher,
  CHANNEL_CODES,
  CHANNEL_SCHEME,
  CHANNEL_VOUCHER_META,
  channelKey,
  channelVoucherEnvelope,
  checkChannelOffer,
  finishLane,
  forgetChecks,
  laneCoversChain,
  parseBook,
  pickLane,
  recordCheck,
  unpackChannelState,
  type ChannelBook,
  type ChannelLane,
  type ChannelNetwork,
  type LanePool,
} from "../../core/channel.js";
import type { ChannelStore } from "../../channels.js";
import { renewChannelDebts, type DebtRenewal, type RenewAnswer } from "../../core/renew.js";
import type { RestClient } from "../../rest.js";
import { buildVoucher, type VoucherRequirement, type VoucherTypedData, type WireVoucher } from "../../core/voucher.js";
import { AssayError, ConfigError } from "../../errors.js";
import type { EvmSigner } from "../../signer.js";
import type { ChannelOutcome, PaymentScheme, Prepared, PrepareInput } from "../types.js";

/** One EVM network: built into the SDK, or configured by the caller. */
export interface Eip155Network {
  /** The chain id; when given it must be the one in the CAIP-2 key. */
  chainId?: number;
  /** CAIP-10 of the escrow (the EIP-712 `verifyingContract`). */
  escrow: string;
  /** CAIP-19 erc20 asset. */
  asset: string;
  decimals: number;
  /** JSON-RPC URLs for the chain reads of G4/G6. Every one must agree. */
  rpcUrls: string[];
  /**
   * The escrow has the channel door (`channel-v1`). Only then does the client offer channel
   * vouchers on this network, and only when it was given a channel store. Default `false`.
   */
  channels?: boolean;
}

export interface NetworkEntry {
  id: string;
  chainId: number;
  escrow: Address;
  escrowCaip10: string;
  asset: string;
  decimals: number;
  rpc: readonly string[];
  /** The escrow has the channel door. Absent is `false`. */
  channels?: boolean;
}

/** Local limits in dollars, as decimal strings (G7). */
export interface Limits {
  maxPerCall: string;
  maxPerDay: string;
}

export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({ maxPerCall: "0.50", maxPerDay: "5" });

function networkEntry(id: string, n: Eip155Network, fail: (message: string) => Error): NetworkEntry {
  const chainId = eip155ChainId(id);
  const escrow = typeof n?.escrow === "string" ? parseCaip10(n.escrow) : null;
  const asset = typeof n?.asset === "string" ? parseCaip19Erc20(n.asset) : null;
  if (chainId === null) throw fail(`networks: ${id} is not a CAIP-2 eip155 chain`);
  if (n?.chainId !== undefined && n.chainId !== chainId) throw fail(`networks.${id}.chainId is not ${chainId}`);
  if (!escrow || escrow.chainId !== chainId)
    throw fail(`networks.${id}.escrow must be a checksummed CAIP-10 account on ${id}`);
  if (!asset || asset.chainId !== chainId)
    throw fail(`networks.${id}.asset must be a checksummed CAIP-19 erc20 asset on ${id}`);
  if (!Number.isInteger(n.decimals) || n.decimals < 0 || n.decimals > 36)
    throw fail(`networks.${id}.decimals is invalid`);
  const rpc = n.rpcUrls;
  if (!Array.isArray(rpc) || rpc.length === 0 || !rpc.every((u) => typeof u === "string" && isUsableRpcUrl(u))) {
    throw fail(`networks.${id}.rpcUrls must list at least one https RPC URL`);
  }
  if (n.channels !== undefined && typeof n.channels !== "boolean")
    throw fail(`networks.${id}.channels must be a boolean`);
  return Object.freeze({
    id,
    chainId,
    escrow: escrow.address,
    escrowCaip10: n.escrow,
    asset: n.asset,
    decimals: n.decimals,
    rpc: Object.freeze([...rpc]),
    channels: n.channels === true,
  });
}

/**
 * Checks and freezes a network table. `fail` makes the error: a `ConfigError` for the caller's
 * own table, a server error for one the API sent. Non-eip155 entries are skipped.
 */
export function eip155Networks(
  table: Record<string, Eip155Network>,
  fail: (message: string) => Error = (m) => new ConfigError(m),
): Map<string, NetworkEntry> {
  const out = new Map<string, NetworkEntry>();
  for (const [id, n] of Object.entries(table)) {
    if (id.startsWith("eip155:")) out.set(id, networkEntry(id, n, fail));
  }
  return out;
}

/**
 * Like {@link eip155Networks}, entry by entry: an entry `skip` returns true for (for example one
 * whose escrow is still a placeholder) is left out instead of failing the whole table. Every other
 * eip155 entry must be valid, or this throws a `ConfigError` naming it.
 */
export function networkEntriesFrom(
  table: Record<string, Eip155Network>,
  options: { skip?: (id: string, network: Eip155Network) => boolean } = {},
): Map<string, NetworkEntry> {
  const out = new Map<string, NetworkEntry>();
  for (const [id, n] of Object.entries(table)) {
    if (!id.startsWith("eip155:") || options.skip?.(id, n) === true) continue;
    out.set(
      id,
      networkEntry(id, n, (m) => new ConfigError(m)),
    );
  }
  return out;
}

export function checkLimits(limits: Limits): Limits {
  const perCall = typeof limits?.maxPerCall === "string" ? usdToAtomic(limits.maxPerCall, 6) : null;
  const perDay = typeof limits?.maxPerDay === "string" ? usdToAtomic(limits.maxPerDay, 6) : null;
  if (perCall === null || perCall === 0n)
    throw new ConfigError('limits.maxPerCall must be a positive dollar amount such as "0.50"');
  if (perDay === null || perDay === 0n)
    throw new ConfigError('limits.maxPerDay must be a positive dollar amount such as "5"');
  if (perCall > perDay) throw new ConfigError("limits.maxPerCall must not be above limits.maxPerDay");
  return Object.freeze({ maxPerCall: limits.maxPerCall, maxPerDay: limits.maxPerDay });
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

export type GuardedVoucher = { ok: true; wire: WireVoucher; typedData: VoucherTypedData };

/**
 * The one path from a requirement to a voucher: the guards and the builder see the same frozen
 * copy, and the network the guards check is the caller's own entry for `requirement.network`.
 * Returns the first refusal, or the voucher to sign.
 *
 * `networks` is trusted as given: this function and `buildVoucher` check the requirement against
 * it, never against the server, so the caller owns the trust root (build it from a pinned table,
 * for example with `eip155Networks` or `networkEntriesFrom`, never from what an API returned).
 *
 * `opts` passes {@link GuardOptions} to the guards; with `signerRefusal: "throw"`, a signer
 * refusal (a bad `issuedAt`, or a voucher that differs from the checked requirement) is thrown as
 * a `SignerRefusal` instead of returned as a G1 refusal.
 */
export function guardAndBuild(
  ctx: Omit<GuardContext, "network">,
  issuedAt: number,
  networks: ReadonlyMap<string, NetworkEntry>,
  opts: GuardOptions = {},
): GuardedVoucher | Exclude<GuardResult, { ok: true }> {
  const signerRefused = (err: SignerRefusal): Exclude<GuardResult, { ok: true }> => {
    if (opts.signerRefusal === "throw") throw err;
    return { ok: false, guard: "G1", code: "G1_NOT_A_REQUIREMENT", reason: err.message };
  };
  // Checked before the guards, so a payment the signer would refuse never reaches a prompt.
  if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0) {
    return signerRefused(new SignerRefusal("the voucher", "issuedAt", "is not a positive integer"));
  }
  let requirement: unknown;
  try {
    requirement = deepFreeze(structuredClone(ctx.requirement));
  } catch {
    return { ok: false, guard: "G1", code: "G1_NOT_A_REQUIREMENT", reason: "the payment request could not be copied" };
  }
  const id = isObject(requirement) && typeof requirement.network === "string" ? requirement.network : null;
  const entry = id !== null ? networks.get(id) : undefined;
  const network = entry
    ? { id: entry.id, escrow: entry.escrowCaip10, asset: entry.asset, decimals: entry.decimals }
    : null;
  const result = checkAll({ ...ctx, requirement, network }, opts);
  if (!result.ok) return result;
  const req = requirement as VoucherRequirement;
  try {
    const built = buildVoucher(req, issuedAt, {
      caip2: entry!.id,
      escrow: entry!.escrowCaip10,
      asset: entry!.asset,
      decimals: entry!.decimals,
    });
    const m = built.typedData.message;
    const same =
      m.amount === BigInt(req.amount.amount) &&
      m.seq === BigInt(req.seq) &&
      m.payer === getAddress(parseCaip10(req.payer)!.address) &&
      m.provider === getAddress(parseCaip10(req.provider)!.address) &&
      built.typedData.domain.verifyingContract === entry!.escrow &&
      built.typedData.domain.chainId === entry!.chainId;
    if (!same) {
      if (opts.signerRefusal === "throw")
        throw new SignerRefusal("the voucher", "message", "differs from the guarded requirement");
      return {
        ok: false,
        guard: "G1",
        code: "G1_NOT_A_REQUIREMENT",
        reason: "the voucher differs from the checked requirement",
      };
    }
    return { ok: true, ...built };
  } catch (err) {
    if (err instanceof SignerRefusal) return signerRefused(err);
    throw err;
  }
}

const SPEND_WINDOW_SECONDS = 86_400;
/** How long channels are not offered after `CHANNEL_LIMIT`, `CHANNEL_SIGNER_EXPIRING`, `CHANNEL_NOT_OFFERED` or a burst of rotations. */
export const CHANNEL_PAUSE_MS = 60 * 60 * 1000;
/** This many `CHANNEL_ROTATE` within `CHANNEL_PAUSE_MS` pause channels as well. */
export const CHANNEL_ROTATE_PAUSE_COUNT = 5;
/** After a paid call refused for a debt, channel debts are renewed at most this often by themselves. */
export const AUTO_RENEW_INTERVAL_MS = 60_000;
/**
 * Vouchers signed in this process, by key: every client using one key shares one 24 h cap. One
 * array per key, only ever changed in place, so a reservation is always released from the list
 * the guards read. Per process only: not shared across worker threads or restarts; the
 * on-chain caps are the bound across processes.
 */
const LEDGER = new Map<string, SignedVoucher[]>();

function spentBy(address: string, nowSeconds: number): SignedVoucher[] {
  const key = address.toLowerCase();
  let list = LEDGER.get(key);
  if (list === undefined) {
    list = [];
    LEDGER.set(key, list);
  }
  for (let i = list.length - 1; i >= 0; i--) if (list[i]!.at <= nowSeconds - SPEND_WINDOW_SECONDS) list.splice(i, 1);
  return list;
}

/** Tests only: forget every signed voucher of this process. */
export function resetSpendLedger(): void {
  LEDGER.clear();
}

export interface Eip155SchemeOptions {
  /** The network table: built into the SDK, or the caller's for non-production environments. */
  networks: ReadonlyMap<string, NetworkEntry>;
  limits: Limits;
  chain: ChainReader;
  /** Milliseconds clock. */
  now: () => number;
  /** Server minus local clock, seconds (spec section 7). */
  dateOffset: () => number;
  /**
   * Channel vouchers: where the lanes are kept. Without it the scheme signs per-call vouchers
   * only and never offers `channel-v1`.
   */
  channels?: { store: ChannelStore; randomChannelId: () => Hex };
}

function accountOn(value: unknown, chainId: number): Address | null {
  const parsed = typeof value === "string" ? parseCaip10(value) : null;
  return parsed && parsed.chainId === chainId ? parsed.address : null;
}

/** What one channel voucher needs once its lane step is persisted. */
interface ChannelPlan {
  typedData: ReturnType<typeof buildChannelVoucher>["typedData"];
  wire: ReturnType<typeof buildChannelVoucher>["wire"];
  channelId: string;
  increase: bigint;
  cumulative: bigint;
  calls: number;
}

export class Eip155Scheme implements PaymentScheme {
  readonly namespace = "eip155";
  /** The payer of the first voucher this client signed (G4): a different one later is refused. */
  #recordedPayer: string | null = null;
  /** Serialises every read-modify-write of the channel store in this process. */
  #lanes: Promise<unknown> = Promise.resolve();
  /** Whether this process has read the stored record yet (its chain checks are not this process's). */
  #loaded = false;

  constructor(private readonly o: Eip155SchemeOptions) {}

  /** Until when (ms) channels are not offered, after a refusal a channel cannot fix soon. */
  #pausedUntil = 0;

  /** When the server rotated a lane, ms; a burst of rotations pauses channels too. */
  #rotations: number[] = [];

  /** Before when (ms) a refused paid call does not renew channel debts again by itself. */
  #autoRenewNotBefore = 0;
  /** The results of the last renewing run, by intent (what a throttled run reports). */
  #lastRenewals = new Map<string, DebtRenewal>();

  /** Whether this client keeps channel lanes (and so can renew a channel debt). */
  get keepsLanes(): boolean {
    return this.o.channels !== undefined;
  }

  /**
   * Renews the payer's channel debts this client signed (see `core/renew.ts`): the renewable pair
   * of the lane each debt names, fresh times, one `POST /escrow/debts/{intentId}/voucher` per debt,
   * at most one signature per lane. Not counted as a new spend; never above the lane's signed top,
   * never a pair the server refused. At most one renewing run per {@link AUTO_RENEW_INTERVAL_MS}
   * (manual or after a refused call): within it the debts are only listed, nothing is signed, and
   * an open channel debt comes back as the last run left it (`renewed` as `pending`, `no_lane`,
   * `not_signed_here`) or `rate_limited`. `null` without a lane store.
   */
  async renewChannelDebts(api: RestClient, signer: EvmSigner): Promise<DebtRenewal[] | null> {
    if (this.o.channels === undefined) return null;
    const now = this.o.now();
    const throttled = now < this.#autoRenewNotBefore;
    const options = throttled
      ? { renew: false, retryAfterMs: this.#autoRenewNotBefore - now, previous: this.#lastRenewals }
      : {};
    if (!throttled) this.#autoRenewNotBefore = now + AUTO_RENEW_INTERVAL_MS;
    const localKey = getAddress(signer.address);
    const out = await renewChannelDebts(
      {
        listDebts: async () => (await api.get("/escrow/debts")).data,
        withBook: (fn) => this.#withBook(async (book) => fn(book)),
        network: (id) => {
          const e = this.o.networks.get(id);
          return e ? { id: e.id, chainId: e.chainId, escrow: e.escrow, asset: e.asset, decimals: e.decimals } : null;
        },
        signer: localKey,
        sign: async (typedData) => signer.signTypedData(typedData as never),
        post: async (intentId, body): Promise<RenewAnswer> => {
          try {
            await api.post(`/escrow/debts/${encodeURIComponent(intentId)}/voucher`, body);
            return { ok: true };
          } catch (err) {
            // No answer at all: what the server did is unknown (the renew moves nothing either way).
            if (!(err instanceof AssayError) || err.status === undefined) throw err;
            const wait = (err as { retryAfterMs?: unknown }).retryAfterMs;
            const secs = err.details?.retryAfter;
            const retryAfterMs = typeof wait === "number" ? wait : typeof secs === "number" ? secs * 1000 : undefined;
            return { ok: false, code: err.code, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
          }
        },
        nowSeconds: () => Math.floor(this.o.now() / 1000),
        issuedAt: (nowSeconds) => correctedNow(nowSeconds, this.o.dateOffset()),
      },
      options,
    );
    if (!throttled) this.#lastRenewals = new Map(out.map((r) => [r.intentId, r]));
    return out;
  }

  channelRefused(code: string): void {
    const now = this.o.now();
    if (code === CHANNEL_CODES.CHANNEL_ROTATE) {
      this.#rotations = [...this.#rotations.filter((t) => now - t < CHANNEL_PAUSE_MS), now];
      if (this.#rotations.length < CHANNEL_ROTATE_PAUSE_COUNT) return;
      this.#rotations = [];
    }
    this.#pausedUntil = now + CHANNEL_PAUSE_MS;
  }

  paymentSchemes(): readonly string[] | null {
    if (this.o.channels === undefined || this.o.now() < this.#pausedUntil) return null;
    return [...this.o.networks.values()].some((n) => n.channels === true) ? [CHANNEL_SCHEME, "voucher"] : null;
  }

  /** Runs `fn` on the channel book with this process's lane lock held; saves what it returns. */
  #withBook<T>(fn: (book: ChannelBook) => Promise<{ book: ChannelBook | null; value: T }>): Promise<T> {
    const store = this.o.channels!.store;
    const body = async () => {
      let book = parseBook(await store.load());
      // Until this process has written the record, its chain checks were made by someone else.
      if (!this.#loaded) book = forgetChecks(book);
      const out = await fn(book);
      if (out.book !== null) {
        await store.save(out.book);
        this.#loaded = true;
      }
      return out.value;
    };
    // The store's own queue when it has one (shared by every client on the record), else this client's.
    const run = store.exclusive ? this.#lanes.then(() => store.exclusive!(body)) : this.#lanes.then(body);
    this.#lanes = run.catch(() => undefined);
    return run;
  }

  /**
   * The channel step for a requirement the guards passed: the offer checked against it and the
   * client's own entry, a free lane (checked against the chain when its record is not fresh), the
   * next pair from the lane's record only, persisted before anything is signed. `null` when the
   * call should be paid per call instead (no channel, no lane, no agreed chain read, a store that
   * cannot be read or written).
   */
  async #planChannel(
    input: PrepareInput,
    entry: NetworkEntry,
    req: VoucherRequirement,
    localKey: Address,
    rotateAt: bigint,
  ): Promise<ChannelPlan | null> {
    const channels = this.o.channels;
    if (
      channels === undefined ||
      entry.channels !== true ||
      input.channelOffer === undefined ||
      input.channelOffer === null
    )
      return null;
    const net: ChannelNetwork = {
      id: entry.id,
      chainId: entry.chainId,
      escrow: entry.escrow,
      asset: entry.asset,
      decimals: entry.decimals,
    };
    const checked = checkChannelOffer(input.channelOffer, req as unknown as Record<string, unknown>, net);
    if (!checked.ok) return null;
    const offer = checked.offer;
    const pool: LanePool = {
      network: entry.id,
      escrow: entry.escrow,
      payer: getAddress(parseCaip10(req.payer)!.address),
      signer: localKey,
      provider: getAddress(parseCaip10(req.provider)!.address),
    };
    type Pick =
      { kind: "plan"; plan: ChannelPlan } | { kind: "none" } | { kind: "check"; lane: ChannelLane; nowSeconds: number };
    try {
      // At most one chain check per lane of the pool, then a new lane.
      for (let round = 0; round < 10; round++) {
        const picked = await this.#withBook<Pick>(async (book) => {
          const nowSeconds = Math.floor(this.o.now() / 1000);
          const pick = pickLane(book, pool, offer.price, {
            maxLanes: offer.maxLanes,
            rotateAt,
            nowSeconds,
            newChannelId: channels.randomChannelId,
          });
          if (pick.kind === "none") return { book: pick.book, value: { kind: "none" } };
          const lane = pick.lane;
          if (pick.needsCheck) return { book: pick.book, value: { kind: "check", lane, nowSeconds } };
          const issuedAt = correctedNow(nowSeconds, this.o.dateOffset());
          const step = advanceLane(pick.book, lane.channelId, offer.price, issuedAt, offer.lifetimeSeconds, nowSeconds);
          const built = buildChannelVoucher(lane, step, net);
          // Persisted (write-ahead) by #withBook before the plan is returned and signed.
          return {
            book: step.book,
            value: {
              kind: "plan",
              plan: {
                ...built,
                channelId: step.channelId,
                increase: step.increase,
                cumulative: step.cumulative,
                calls: step.calls,
              },
            },
          };
        });
        if (picked.kind === "none") return null;
        if (picked.kind === "plan") return picked.plan;
        // The chain check, outside the lane lock (a slow RPC must not stall every paid call); the
        // lane is re-read under the lock before the result is recorded.
        const { lane, nowSeconds } = picked;
        const key = channelKey(lane.payer, lane.signer, lane.provider, lane.channelId);
        const read = await this.o.chain.readChannel(entry, key, lane.payer);
        // No agreed read: the record cannot be confirmed now; pay per call this time.
        if (read === null) return null;
        const chainState = unpackChannelState(read.state);
        await this.#withBook(async (book) => {
          const current = book.lanes.find((l) => l.channelId === lane.channelId);
          // Compare-and-set: the result is recorded only for the lane as it was read.
          if (
            current === undefined ||
            current.retired ||
            current.inFlightSince !== null ||
            current.maxSigned !== lane.maxSigned ||
            current.callsSigned !== lane.callsSigned
          )
            return { book: null, value: undefined };
          return {
            book: recordCheck(book, lane.channelId, laneCoversChain(current, chainState), nowSeconds),
            value: undefined,
          };
        });
      }
      return null;
    } catch {
      // An unreadable or unwritable record: never sign a channel voucher from it.
      return null;
    }
  }

  #finish(channelId: string, outcome: ChannelOutcome): Promise<void> {
    return this.#withBook(async (book) => ({ book: finishLane(book, channelId, outcome), value: undefined }));
  }

  async prepare(input: PrepareInput): Promise<Prepared> {
    const signer = input.signer as EvmSigner;
    let localKey: Address;
    try {
      localKey = getAddress(signer.address);
    } catch {
      return { ok: false, guard: "G5", code: "G5_LOCAL_KEY_INVALID", reason: "the signer's address is not readable" };
    }
    const networks = this.o.networks;
    const req = isObject(input.requirement) ? input.requirement : null;
    const entry = req && typeof req.network === "string" ? networks.get(req.network) : undefined;
    const payer = entry ? accountOn(req?.payer, entry.chainId) : null;
    // Before any chain read, as the reference does: these refusals say what to do.
    if (entry && payer === localKey) {
      return {
        ok: false,
        guard: "G5",
        code: "G5_LOCAL_KEY_IS_PAYER",
        reason: "the signer is the payer; use a dedicated payment key",
      };
    }
    if (entry && accountOn(req?.delegate, entry.chainId) !== localKey) {
      return {
        ok: false,
        guard: "G5",
        code: "G5_DELEGATE_MISMATCH",
        reason: "this signer is not the payment key bound to this API key; call paidCalls.bind() and approve it",
      };
    }
    const chain = entry && payer ? await this.o.chain.read(entry, payer, localKey) : null;
    const quote = await input.quote(input.tool);

    // No await from here to the spend record, so two calls in flight cannot both pass the cap.
    const nowSeconds = Math.floor(this.o.now() / 1000);
    const signed = spentBy(localKey, nowSeconds);
    const ctx: Omit<GuardContext, "network"> = {
      requirement: input.requirement,
      forwardedCall: { tool: input.tool, at: input.calledAt },
      quote,
      chain,
      localKey,
      recordedPayer: this.#recordedPayer,
      limits: {
        perCall: this.o.limits.maxPerCall,
        perDay: this.o.limits.maxPerDay,
        confirmAbove: null,
        providers: null,
      },
      signed,
      confirmation: null,
      nowSeconds,
    };
    const built = guardAndBuild(ctx, correctedNow(nowSeconds, this.o.dateOffset()), networks);
    if (!built.ok) {
      if ((built.guard === "G4" || built.guard === "G6") && entry && payer)
        this.o.chain.invalidate(entry.id, payer, localKey);
      return built;
    }
    const r = req as unknown as VoucherRequirement;
    const providerId = r.providerId;
    if (typeof providerId !== "string" || providerId.length === 0 || providerId.length > 256) {
      return { ok: false, guard: "G1", code: "G1_NOT_A_REQUIREMENT", reason: "the payment request names no provider" };
    }
    // The price passed every guard, G7 included, against the spend recorded so far. Reserved now,
    // before the channel step awaits, so a parallel call sees it; a channel reuse gives it back.
    const reserved: SignedVoucher = { at: nowSeconds, amount: built.typedData.message.amount.toString() };
    signed.push(reserved);
    const release = () => {
      const list = spentBy(localKey, Math.floor(this.o.now() / 1000));
      const i = list.indexOf(reserved);
      if (i !== -1) list.splice(i, 1);
    };
    const details = {
      tool: input.tool,
      network: r.network,
      amount: { ...built.wire.amount },
      provider: r.provider,
      payer: r.payer,
      idempotencyKey: input.idempotencyKey,
    };

    const perDay = usdToAtomic(this.o.limits.maxPerDay, entry!.decimals) ?? 0n;
    const window = chain?.delegateMaxPerWindow !== undefined ? BigInt(chain.delegateMaxPerWindow) : perDay;
    const plan = await this.#planChannel(input, entry!, r, localKey, window < perDay ? window : perDay);
    if (plan !== null) {
      // Only the increase counts toward the 24 h limit: a voucher that signs the same total
      // again adds nothing the server could take.
      reserved.amount = plan.increase.toString();
      let used = false;
      let finished = false;
      const finish = async (outcome: ChannelOutcome) => {
        if (finished) return;
        finished = true;
        await this.#finish(plan.channelId, outcome);
      };
      return {
        ok: true,
        metaKey: CHANNEL_VOUCHER_META,
        details: {
          ...details,
          channel: {
            channelId: plan.channelId,
            cumulative: plan.cumulative.toString(),
            calls: plan.calls,
            increase: plan.increase.toString(),
          },
        },
        sign: async () => {
          if (used) throw new Error("a voucher is signed at most once");
          used = true;
          const signature = await signer.signTypedData(plan.typedData as never);
          if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature))
            throw new Error("the signer did not return a 65-byte signature");
          this.#recordedPayer ??= getAddress(parseCaip10(r.payer)!.address);
          return channelVoucherEnvelope(plan.wire, signature, providerId, r.contractVersion) as unknown as Record<
            string,
            unknown
          >;
        },
        release: () => {
          release();
          // Never signed: the advanced pair is dropped with its lane, so no total is ever signed
          // that the spend record did not count.
          void finish("retire").catch(() => undefined);
        },
        finish,
      };
    }

    let used = false;
    return {
      ok: true,
      metaKey: VOUCHER_META,
      details,
      sign: async () => {
        if (used) throw new Error("a voucher is signed at most once");
        used = true;
        const signature = await signer.signTypedData(built.typedData as never);
        if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature))
          throw new Error("the signer did not return a 65-byte signature");
        this.#recordedPayer ??= getAddress(parseCaip10(r.payer)!.address);
        return voucherEnvelope(built.wire, signature, providerId, r.contractVersion);
      },
      release,
    };
  }

  async onRefused(code: string, input: PrepareInput): Promise<void> {
    if (code !== "PAYMENT_VOUCHER_DELEGATE_INACTIVE") return;
    const req = isObject(input.requirement) ? input.requirement : null;
    const networks = this.o.networks;
    const entry = req && typeof req.network === "string" ? networks.get(req.network) : undefined;
    const payer = entry ? accountOn(req?.payer, entry.chainId) : null;
    if (entry && payer) this.o.chain.invalidate(entry.id, payer, getAddress(input.signer.address));
  }
}
