/**
 * Channel vouchers (`channel-v1`): one cumulative EIP-712 `ChannelVoucher` per lane instead of one
 * voucher per call. Pure: no I/O, no clock, no randomness; the caller passes all of them in.
 *
 * Trust model (the client's side of it):
 * - The server never names a cumulative. A lane's next pair is the client's own persisted
 *   `(maxSigned + price, callsSigned + 1)`, or, after a refusal that did not store the voucher,
 *   exactly its own top pair again (an increase of zero).
 * - Local spend guards count the increase only (`cumulative - maxSigned`), never the cumulative.
 * - Before a lane is continued, its record is checked against the escrow's own state for the
 *   channel key (`channelBooks`): a record that does not cover what the chain shows is retired.
 * - The domain is the client's own escrow (`"Assay Settlement"`, `"2"`, chainId, escrow); the
 *   server's `domain` is checked against it and never used.
 */
import { parseCaip10 } from "./caip.js";
import { getAddress, isAddress, keccak256, type Address, type Hex } from "./hex.js";
import { DEBT_CODE, isObject } from "./meta.js";
import { SignerRefusal } from "./errors.js";
import { VOUCHER_DOMAIN_NAME, VOUCHER_DOMAIN_VERSION, VOUCHER_LIFETIME_SECONDS } from "./voucher.js";

/** The scheme name a client offers and the server answers with. */
export const CHANNEL_SCHEME = "channel-v1";
/** Request `_meta`: the payment schemes the client accepts, in its order of preference. */
export const PAYMENT_SCHEMES_META = "assay/paymentSchemes";
/** Result `_meta` on `PAYMENT_REQUIRED`: the channel offer, next to the per-call requirement. */
export const CHANNEL_REQUIRED_META = "assay/channelRequired";
/** Request `_meta` on the paid retry: the signed channel voucher envelope. */
export const CHANNEL_VOUCHER_META = "assay/channelVoucher";

/** The seven signed fields, in the contract's order (`Types.sol`, `CHANNEL_VOUCHER_TYPEHASH`). */
export const CHANNEL_VOUCHER_TYPES = {
  ChannelVoucher: [
    { name: "payer", type: "address" },
    { name: "provider", type: "address" },
    { name: "channelId", type: "bytes32" },
    { name: "cumulative", type: "uint64" },
    { name: "calls", type: "uint32" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const;

/** The contract keeps `settled` in 56 bits. */
export const MAX_CHANNEL_CUMULATIVE = 2n ** 56n - 1n;
/** `calls` must stay below this (24 bits). */
export const CHANNEL_CALLS_LIMIT = 2 ** 24;
/** The most lanes a client opens per (network, escrow, payer, signer, provider). */
export const MAX_LANES = 8;
/** The server needs at least this much voucher life left at admission. */
export const CHANNEL_MIN_LIFE_SECONDS = 60;
/** A lane is checked against the chain again when its last check is older than this. */
export const LANE_CHECK_MAX_AGE_SECONDS = 600;
/** A lane marked in flight for longer than this (a crash, a lost answer) is retired. */
export const LANE_IN_FLIGHT_MAX_SECONDS = 600;
/**
 * A retired lane's record is kept this long after its last voucher expired: past the 30 days after
 * which Assay writes off a buyer debt, so a channel debt on the lane can still be renewed
 * ({@link renewLane}). The per-pool cap below bounds the record all the same.
 */
export const RETIRED_LANE_KEEP_SECONDS = 31 * 86_400;
/** Renewable pairs kept per lane (newest last), so a debt's exact pair can be renewed. */
export const LANE_PAIRS_KEPT = 64;
/** Life of a renew voucher: within the server's 300 s, with room for its 60 s minimum. */
export const RENEW_LIFETIME_SECONDS = 240;
/**
 * A re-armed top pair may be signed again (as an increase of 0) only while its first signature
 * could still be settled (`expiresAt + REDEEM_GRACE`) and was signed less than 24 h ago, so the
 * spend window still holds its price. Past that the lane is retired instead.
 */
export const REUSE_MAX_AFTER_EXPIRY_SECONDS = 7200;
export const REUSE_MAX_AGE_SECONDS = 86_400;
/** Retired lanes kept per pool at most; the oldest expired ones are dropped first. */
export const MAX_RETIRED_LANES_PER_POOL = 16;
/** The persisted record's format. */
export const CHANNEL_BOOK_VERSION = 1;

/** Server codes of the channel lane (API-W2 §2). */
export const CHANNEL_CODES = Object.freeze({
  CHANNEL_ROTATE: "CHANNEL_ROTATE",
  CHANNEL_LIMIT: "CHANNEL_LIMIT",
  CHANNEL_DESYNC: "CHANNEL_DESYNC",
  CHANNEL_SIGNER_EXPIRING: "CHANNEL_SIGNER_EXPIRING",
  CHANNEL_NOT_OFFERED: "CHANNEL_NOT_OFFERED",
  PAYMENT_UNSETTLED_LIMIT: "PAYMENT_UNSETTLED_LIMIT",
} as const);

/**
 * What to do with a lane after the server answered a channel voucher:
 * - `served`: admitted (or replayed); the lane is free again;
 * - `reuse`: refused without storing the voucher (`PAYMENT_UNSETTLED_LIMIT`, `PAYMENT_DEBT_OUTSTANDING`,
 *   `CHANNEL_LIMIT`, `CHANNEL_SIGNER_EXPIRING`, `CHANNEL_NOT_OFFERED`): the lane is free, and its next voucher signs
 *   the same top pair again (no increase);
 * - `retire`: `CHANNEL_ROTATE` or any other refusal: the lane is never used again;
 * - `unknown`: no answer (or the lane was never reported): retired as well, but the pair may have
 *   been stored, so it stays renewable.
 *
 * Only `served` and `unknown` keep the top pair renewable (`renewable`): after an explicit refusal
 * the server did not store the voucher, and a renew of it would authorise a call never served.
 */
export type LaneOutcome = "served" | "reuse" | "retire" | "unknown";

/** The outcome for a server answer to a channel voucher: `null` error code is served. */
export function laneOutcomeOf(code: string | null): LaneOutcome {
  if (code === null) return "served";
  if (
    code === CHANNEL_CODES.PAYMENT_UNSETTLED_LIMIT ||
    // A buyer debt refuses the call before anything is stored: the lane is re-armed.
    code === DEBT_CODE ||
    code === CHANNEL_CODES.CHANNEL_LIMIT ||
    code === CHANNEL_CODES.CHANNEL_SIGNER_EXPIRING ||
    code === CHANNEL_CODES.CHANNEL_NOT_OFFERED
  ) {
    return "reuse";
  }
  return "retire";
}

/**
 * After a refused channel voucher: `rotate` (sign again on another lane), `per-call` (sign the
 * per-call requirement of the same answer instead), or `stop` (surface the refusal).
 */
export function channelFallbackOf(code: string): "rotate" | "per-call" | "stop" {
  if (code === CHANNEL_CODES.CHANNEL_ROTATE) return "rotate";
  if (
    code === CHANNEL_CODES.CHANNEL_LIMIT ||
    code === CHANNEL_CODES.CHANNEL_SIGNER_EXPIRING ||
    code === CHANNEL_CODES.CHANNEL_NOT_OFFERED
  ) {
    return "per-call";
  }
  return "stop";
}

/** One lane of a pool. Integers that can pass 2^53 are decimal strings. */
export interface ChannelLane {
  /** 32 random bytes, lower-case hex. */
  channelId: Hex;
  /** CAIP-2. */
  network: string;
  /** Checksummed addresses. `signer` is the local payment key. */
  escrow: Address;
  payer: Address;
  signer: Address;
  provider: Address;
  /** The highest cumulative this client signed on the lane (atomic units). */
  maxSigned: string;
  /** The calls counter of that voucher. */
  callsSigned: number;
  /** The increase of the top pair (its price), so a reuse signs it only for the same price. */
  topIncrease: string;
  lastIssuedAt: number;
  lastExpiresAt: number;
  /** The top pair was refused without being stored: the next voucher signs it again. */
  reuseTop: boolean;
  /** Unix seconds a voucher on the lane went out, or `null` when the lane is free. */
  inFlightSince: number | null;
  retired: boolean;
  /** When the record was last checked against the chain, or `null`. */
  checkedAt: number | null;
  /**
   * The renewable pairs of the lane, `[cumulative, calls]`, oldest first, at most
   * {@link LANE_PAIRS_KEPT}: pairs this client signed whose voucher was served (stored) or whose
   * outcome is unknown (no answer). A pair the server explicitly refused is removed. Absent on a
   * record written before renew existed: then only the top pair of a lane that is neither retired
   * nor re-armed is renewable. A renew re-signs only a pair listed here.
   */
  renewable?: [string, number][];
  /** `issuedAt` of the last renew voucher: later vouchers on the lane never go below it. */
  renewedIssuedAt?: number;
}

/** Every lane this client keeps, persisted before every signature (write-ahead). */
export interface ChannelBook {
  version: typeof CHANNEL_BOOK_VERSION;
  lanes: ChannelLane[];
}

/** The five values a pool is keyed by; addresses checksummed. */
export interface LanePool {
  network: string;
  escrow: Address;
  payer: Address;
  signer: Address;
  provider: Address;
}

export class ChannelBookError extends Error {
  override name = "ChannelBookError";
}

export function emptyBook(): ChannelBook {
  return { version: CHANNEL_BOOK_VERSION, lanes: [] };
}

const CANONICAL_UINT = /^(0|[1-9][0-9]*)$/;
const CHANNEL_ID = /^0x[0-9a-f]{64}$/;
const CAIP2 = /^eip155:([1-9][0-9]*)$/;

function seconds(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

function checksummed(v: unknown): v is Address {
  return isAddress(v) && getAddress(v) === v;
}

/**
 * A persisted book, checked field by field. Throws `ChannelBookError` for anything else: a
 * damaged record is never reset or repaired, because a lane forgotten here could be signed again
 * from a lower total.
 */
export function parseBook(raw: unknown): ChannelBook {
  const bad = (what: string) => new ChannelBookError(`channel record: invalid ${what}`);
  if (raw === null || raw === undefined) return emptyBook();
  if (!isObject(raw) || raw.version !== CHANNEL_BOOK_VERSION || !Array.isArray(raw.lanes)) throw bad("record");
  const ids = new Set<string>();
  const lanes = raw.lanes.map((l: unknown): ChannelLane => {
    if (!isObject(l)) throw bad("lane");
    const ok =
      typeof l.channelId === "string" &&
      CHANNEL_ID.test(l.channelId) &&
      typeof l.network === "string" &&
      CAIP2.test(l.network) &&
      checksummed(l.escrow) &&
      checksummed(l.payer) &&
      checksummed(l.signer) &&
      checksummed(l.provider) &&
      typeof l.maxSigned === "string" &&
      CANONICAL_UINT.test(l.maxSigned) &&
      BigInt(l.maxSigned) <= MAX_CHANNEL_CUMULATIVE &&
      typeof l.topIncrease === "string" &&
      CANONICAL_UINT.test(l.topIncrease) &&
      BigInt(l.topIncrease) <= BigInt(l.maxSigned) &&
      seconds(l.callsSigned) &&
      l.callsSigned < CHANNEL_CALLS_LIMIT &&
      seconds(l.lastIssuedAt) &&
      seconds(l.lastExpiresAt) &&
      typeof l.reuseTop === "boolean" &&
      (l.inFlightSince === null || seconds(l.inFlightSince)) &&
      typeof l.retired === "boolean" &&
      (l.checkedAt === null || seconds(l.checkedAt));
    if (!ok) throw bad("lane");
    if (l.renewedIssuedAt !== undefined && !seconds(l.renewedIssuedAt)) throw bad("lane");
    const pairs =
      l.renewable === undefined
        ? undefined
        : parsePairs(l.renewable, BigInt(l.maxSigned as string), l.callsSigned as number);
    if (pairs === null) throw bad("lane: renewable");
    if (ids.has(l.channelId as string)) throw bad("lane: duplicate channelId");
    ids.add(l.channelId as string);
    return {
      channelId: l.channelId as Hex,
      network: l.network as string,
      escrow: l.escrow as Address,
      payer: l.payer as Address,
      signer: l.signer as Address,
      provider: l.provider as Address,
      maxSigned: l.maxSigned as string,
      callsSigned: l.callsSigned as number,
      topIncrease: l.topIncrease as string,
      lastIssuedAt: l.lastIssuedAt as number,
      lastExpiresAt: l.lastExpiresAt as number,
      reuseTop: l.reuseTop as boolean,
      inFlightSince: l.inFlightSince as number | null,
      retired: l.retired as boolean,
      checkedAt: l.checkedAt as number | null,
      ...(pairs !== undefined ? { renewable: pairs } : {}),
      ...(l.renewedIssuedAt !== undefined ? { renewedIssuedAt: l.renewedIssuedAt as number } : {}),
    };
  });
  return { version: CHANNEL_BOOK_VERSION, lanes };
}

/** A lane's `renewable` pairs, checked: strictly rising, never above its top pair. `null` when invalid. */
function parsePairs(raw: unknown, maxSigned: bigint, callsSigned: number): [string, number][] | null {
  if (!Array.isArray(raw) || raw.length > LANE_PAIRS_KEPT) return null;
  const out: [string, number][] = [];
  let lastC = 0n;
  let lastN = 0;
  for (const p of raw) {
    if (!Array.isArray(p) || p.length !== 2) return null;
    const [c, n] = p as unknown[];
    if (typeof c !== "string" || !CANONICAL_UINT.test(c) || !seconds(n)) return null;
    const cum = BigInt(c);
    if (cum <= lastC || n <= lastN || cum > maxSigned || n > callsSigned) return null;
    out.push([c, n]);
    lastC = cum;
    lastN = n;
  }
  return out;
}

/** `renewable` with `[cumulative, calls]` added at the end (once), the oldest dropped past the cap. */
function withPair(pairs: [string, number][] | undefined, cumulative: bigint, calls: number): [string, number][] {
  const list = [...(pairs ?? [])];
  const last = list[list.length - 1];
  if (!last || BigInt(last[0]) !== cumulative || last[1] !== calls) list.push([cumulative.toString(), calls]);
  return list.slice(-LANE_PAIRS_KEPT);
}

const word = (hex: string): string => hex.slice(2).toLowerCase().padStart(64, "0");

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** The contract's channel key: `keccak256(abi.encode(payer, signer, provider, channelId))`. */
export function channelKey(payer: string, signer: string, provider: string, channelId: string): Hex {
  if (![payer, signer, provider].every(isAddress) || !/^0x[0-9a-fA-F]{64}$/.test(channelId)) {
    throw new TypeError("channelKey: bad input");
  }
  return keccak256(hexBytes(word(payer) + word(signer) + word(provider) + word(channelId)));
}

/** `settled` (bits 0..55) and `calls` (bits 56..79) of a packed channel slot (`ChannelDoor.unpack`). */
export function unpackChannelState(state: bigint): { settled: bigint; calls: number } {
  return { settled: state & MAX_CHANNEL_CUMULATIVE, calls: Number((state >> 56n) & BigInt(CHANNEL_CALLS_LIMIT - 1)) };
}

/** Whether the lane's record covers the chain's state for its key (A5): never settled above it. */
export function laneCoversChain(lane: ChannelLane, chain: { settled: bigint; calls: number }): boolean {
  return chain.settled <= BigInt(lane.maxSigned) && chain.calls <= lane.callsSigned;
}

function inPool(l: ChannelLane, p: LanePool): boolean {
  return (
    l.network === p.network &&
    l.escrow === p.escrow &&
    l.payer === p.payer &&
    l.signer === p.signer &&
    l.provider === p.provider
  );
}

/**
 * Housekeeping at `now`: a lane in flight for longer than `LANE_IN_FLIGHT_MAX_SECONDS` is retired
 * (its outcome is unknown); a retired lane is dropped `RETIRED_LANE_KEEP_SECONDS` after its last
 * voucher expired.
 */
export function pruneBook(book: ChannelBook, nowSeconds: number): ChannelBook {
  let lanes = book.lanes
    .map((l) =>
      l.inFlightSince !== null && nowSeconds - l.inFlightSince > LANE_IN_FLIGHT_MAX_SECONDS
        ? { ...l, inFlightSince: null, retired: true }
        : l,
    )
    .filter(
      (l) => !(l.retired && l.inFlightSince === null && nowSeconds > l.lastExpiresAt + RETIRED_LANE_KEEP_SECONDS),
    );
  // At most MAX_RETIRED_LANES_PER_POOL retired lanes per pool: the oldest expired ones go first; a
  // retired lane whose last voucher has not expired yet is always kept.
  const poolOf = (l: ChannelLane) => [l.network, l.escrow, l.payer, l.signer, l.provider].join("|");
  const drop = new Set<string>();
  const byPool = new Map<string, ChannelLane[]>();
  for (const l of lanes)
    if (l.retired && l.inFlightSince === null) byPool.set(poolOf(l), [...(byPool.get(poolOf(l)) ?? []), l]);
  for (const retired of byPool.values()) {
    const expired = retired
      .filter((l) => nowSeconds > l.lastExpiresAt)
      .sort((a, b) => a.lastExpiresAt - b.lastExpiresAt);
    for (let over = retired.length - MAX_RETIRED_LANES_PER_POOL; over > 0 && expired.length > 0; over--) {
      drop.add(expired.shift()!.channelId);
    }
  }
  if (drop.size > 0) lanes = lanes.filter((l) => !drop.has(l.channelId));
  return { version: CHANNEL_BOOK_VERSION, lanes };
}

/** Whether the lane's re-armed top pair may still be signed again as an increase of 0 at `now`. */
export function reuseIsFresh(lane: ChannelLane, nowSeconds: number): boolean {
  return (
    nowSeconds <= lane.lastExpiresAt + REUSE_MAX_AFTER_EXPIRY_SECONDS &&
    nowSeconds - lane.lastIssuedAt <= REUSE_MAX_AGE_SECONDS
  );
}

export interface PickOptions {
  /** `min(MAX_LANES, the server's maxOpenChannels)`. */
  maxLanes: number;
  /**
   * The highest cumulative a lane may reach before it rotates: the lower of the local per-day
   * limit and the signer's on-chain window cap, in atomic units.
   */
  rotateAt: bigint;
  nowSeconds: number;
  /** 32 CSPRNG bytes as lower-case hex, for a new lane. */
  newChannelId: () => Hex;
}

export type LanePick =
  | { kind: "lane"; book: ChannelBook; lane: ChannelLane; needsCheck: boolean }
  | { kind: "none"; book: ChannelBook; reason: string };

/** Whether `lane` can carry one more call of `price`: by reuse of its top pair, or by an advance. */
function canCarry(lane: ChannelLane, price: bigint, rotateAt: bigint, nowSeconds: number): boolean {
  // A stale re-armed pair is never re-signed for free: the lane is retired instead.
  if (lane.reuseTop) return BigInt(lane.topIncrease) === price && reuseIsFresh(lane, nowSeconds);
  const next = BigInt(lane.maxSigned) + price;
  return next <= rotateAt && next <= MAX_CHANNEL_CUMULATIVE && lane.callsSigned + 1 < CHANNEL_CALLS_LIMIT;
}

/**
 * A free lane of `pool` for one call of `price`, or a new one when the pool has room. A lane that
 * can no longer carry the call (rotation limit, a reuse for another price) is retired on the way.
 * Nothing is advanced here; `needsCheck` says the lane must be checked against the chain first.
 */
export function pickLane(book: ChannelBook, pool: LanePool, price: bigint, o: PickOptions): LanePick {
  if (price <= 0n) return { kind: "none", book, reason: "the price is not positive" };
  const pruned = pruneBook(book, o.nowSeconds);
  const lanes = pruned.lanes.map((l) =>
    inPool(l, pool) && !l.retired && l.inFlightSince === null && !canCarry(l, price, o.rotateAt, o.nowSeconds)
      ? { ...l, retired: true }
      : l,
  );
  const next: ChannelBook = { version: CHANNEL_BOOK_VERSION, lanes };
  const live = lanes.filter((l) => inPool(l, pool) && !l.retired);
  const free = live.find((l) => l.inFlightSince === null);
  if (free) {
    const stale =
      free.callsSigned > 0 &&
      (free.checkedAt === null ||
        o.nowSeconds - free.checkedAt > LANE_CHECK_MAX_AGE_SECONDS ||
        free.checkedAt > o.nowSeconds + 120);
    return { kind: "lane", book: next, lane: free, needsCheck: stale };
  }
  if (live.length >= Math.min(MAX_LANES, o.maxLanes)) return { kind: "none", book: next, reason: "every lane is busy" };
  if (price > o.rotateAt || price > MAX_CHANNEL_CUMULATIVE)
    return { kind: "none", book: next, reason: "the price is above the lane limit" };
  const channelId = o.newChannelId();
  if (!CHANNEL_ID.test(channelId) || lanes.some((l) => l.channelId === channelId)) {
    return { kind: "none", book: next, reason: "no new channel id" };
  }
  const lane: ChannelLane = {
    channelId,
    ...pool,
    maxSigned: "0",
    callsSigned: 0,
    topIncrease: "0",
    lastIssuedAt: 0,
    lastExpiresAt: 0,
    reuseTop: false,
    inFlightSince: null,
    retired: false,
    checkedAt: o.nowSeconds,
    renewable: [],
  };
  return { kind: "lane", book: { version: CHANNEL_BOOK_VERSION, lanes: [...lanes, lane] }, lane, needsCheck: false };
}

function replaceLane(book: ChannelBook, channelId: string, change: (l: ChannelLane) => ChannelLane): ChannelBook {
  let found = false;
  const lanes = book.lanes.map((l) => {
    if (l.channelId !== channelId) return l;
    found = true;
    return change(l);
  });
  if (!found) throw new ChannelBookError("channel record: the lane is gone");
  return { version: CHANNEL_BOOK_VERSION, lanes };
}

/**
 * The book with every lane marked unchecked: call it on the first read of a stored record in a
 * process, so a lane continued after a restart (or from a copy of the file) is checked against
 * the chain before its next voucher.
 */
export function forgetChecks(book: ChannelBook): ChannelBook {
  return { version: CHANNEL_BOOK_VERSION, lanes: book.lanes.map((l) => ({ ...l, checkedAt: null })) };
}

/** The lane after a chain check: `covered` marks it checked, otherwise it is retired. */
export function recordCheck(book: ChannelBook, channelId: string, covered: boolean, nowSeconds: number): ChannelBook {
  return replaceLane(book, channelId, (l) => (covered ? { ...l, checkedAt: nowSeconds } : { ...l, retired: true }));
}

export interface LaneStep {
  book: ChannelBook;
  channelId: Hex;
  cumulative: bigint;
  calls: number;
  /** What this voucher adds to the lane: `price`, or `0n` for a reuse of the top pair. */
  increase: bigint;
  issuedAt: number;
  expiresAt: number;
}

/**
 * Takes the lane for one call: the next pair from the lane's own record only, the lane marked in
 * flight. Persist the returned book before signing. `issuedAt` never goes below the lane's last
 * one (the server checks `issuedAt >= previous issuedAt`).
 */
export function advanceLane(
  book: ChannelBook,
  channelId: string,
  price: bigint,
  issuedAt: number,
  lifetimeSeconds: number,
  nowSeconds: number,
): LaneStep {
  const lane = book.lanes.find((l) => l.channelId === channelId);
  if (!lane || lane.retired || lane.inFlightSince !== null)
    throw new ChannelBookError("channel record: the lane is not free");
  if (price <= 0n) throw new ChannelBookError("channel record: the price is not positive");
  const previous = BigInt(lane.maxSigned);
  const reuse =
    lane.reuseTop && BigInt(lane.topIncrease) === price && lane.callsSigned > 0 && reuseIsFresh(lane, nowSeconds);
  if (lane.reuseTop && !reuse)
    throw new ChannelBookError("channel record: a reuse is only for the same price, while the pair is fresh");
  const cumulative = reuse ? previous : previous + price;
  const calls = reuse ? lane.callsSigned : lane.callsSigned + 1;
  const increase = cumulative - previous;
  if (cumulative > MAX_CHANNEL_CUMULATIVE || calls >= CHANNEL_CALLS_LIMIT || calls < 1) {
    throw new ChannelBookError("channel record: the lane is full");
  }
  if (increase !== (reuse ? 0n : price)) throw new ChannelBookError("channel record: the increase is not the price");
  const issued = Math.max(issuedAt, lane.lastIssuedAt, lane.renewedIssuedAt ?? 0);
  const expiresAt = issued + lifetimeSeconds;
  const next = replaceLane(book, channelId, (l) => ({
    ...l,
    // Write-ahead: renewable until the answer says otherwise (no answer keeps it: unknown).
    renewable: withPair(l.renewable, cumulative, calls),
    maxSigned: cumulative.toString(),
    callsSigned: calls,
    topIncrease: price.toString(),
    lastIssuedAt: issued,
    lastExpiresAt: Math.max(l.lastExpiresAt, expiresAt),
    reuseTop: false,
    inFlightSince: nowSeconds,
  }));
  return { book: next, channelId: lane.channelId, cumulative, calls, increase, issuedAt: issued, expiresAt };
}

/** One buyer debt on a channel, as `GET /escrow/debts` names it, with the client's own pool values. */
export interface ChannelDebtPair {
  /** The lane the debt names (`channel.channelId` of `GET /escrow/debts`), lower-case hex. */
  channelId: string;
  network: string;
  escrow: Address;
  payer: Address;
  signer: Address;
  cumulative: bigint;
  calls: number;
}

/**
 * Whether `(cumulative, calls)` is renewable on `lane`: a pair this client signed there whose
 * voucher was served or whose outcome is unknown ({@link ChannelLane.renewable}); for a record
 * without that list, only the top pair of a lane neither retired nor re-armed.
 */
export function laneSignedPair(lane: ChannelLane, cumulative: bigint, calls: number): boolean {
  if (cumulative <= 0n || calls < 1 || cumulative > BigInt(lane.maxSigned) || calls > lane.callsSigned) return false;
  if (lane.renewable === undefined)
    return !lane.retired && !lane.reuseTop && BigInt(lane.maxSigned) === cumulative && lane.callsSigned === calls;
  return lane.renewable.some(([c, n]) => BigInt(c) === cumulative && n === calls);
}

/**
 * The one lane a debt can be renewed on: the lane it names (`channelId`), only when it is this
 * client's lane of the same network, escrow, payer and signing key, not in flight (retired lanes
 * too: a debt often outlives its lane), and the pair is renewable on it. `null` otherwise: no other
 * lane is ever tried.
 */
export function renewTarget(book: ChannelBook, debt: ChannelDebtPair): ChannelLane | null {
  const l = book.lanes.find((x) => x.channelId === debt.channelId);
  return l !== undefined &&
    l.network === debt.network &&
    l.escrow === debt.escrow &&
    l.payer === debt.payer &&
    l.signer === debt.signer &&
    l.inFlightSince === null &&
    laneSignedPair(l, debt.cumulative, debt.calls)
    ? l
    : null;
}

/**
 * A renew (buyer-debt replacement, API-W2 §3.3): a renewable pair `(cumulative, calls)` of this
 * lane (signed here, and served or of unknown outcome), with fresh times. Nothing on the lane
 * advances: `maxSigned`, `callsSigned` and the re-arm flag stay; only `renewedIssuedAt` is kept so
 * a later voucher's `issuedAt` never goes below it. It authorises nothing above that pair, never a
 * pair the server refused, so it is not counted as a new spend.
 * Throws `ChannelBookError` for a pair not renewable on the lane, a lane in flight, or a bad life.
 * Persist the returned book before signing.
 */
export function renewLane(
  book: ChannelBook,
  channelId: string,
  cumulative: bigint,
  calls: number,
  issuedAt: number,
  lifetimeSeconds: number,
): { book: ChannelBook; step: Pick<LaneStep, "channelId" | "cumulative" | "calls" | "issuedAt" | "expiresAt"> } {
  const lane = book.lanes.find((l) => l.channelId === channelId);
  if (!lane || lane.inFlightSince !== null) throw new ChannelBookError("channel record: the lane is not free");
  if (!laneSignedPair(lane, cumulative, calls))
    throw new ChannelBookError("channel record: this pair is not renewable on the lane");
  if (!Number.isSafeInteger(lifetimeSeconds) || lifetimeSeconds < 1 || lifetimeSeconds > 300)
    throw new ChannelBookError("channel record: the renew life is out of range");
  const issued = Math.max(issuedAt, lane.lastIssuedAt, lane.renewedIssuedAt ?? 0);
  const step = { channelId: lane.channelId, cumulative, calls, issuedAt: issued, expiresAt: issued + lifetimeSeconds };
  return { book: replaceLane(book, channelId, (l) => ({ ...l, renewedIssuedAt: issued })), step };
}

/** Frees, re-arms or retires the lane after the server's answer (see {@link LaneOutcome}). */
export function finishLane(book: ChannelBook, channelId: string, outcome: LaneOutcome): ChannelBook {
  return replaceLane(book, channelId, (l) => {
    // An explicit refusal: the server did not store the top pair, so it is not renewable.
    const refused = outcome === "reuse" || outcome === "retire";
    const renewable =
      refused && l.renewable !== undefined
        ? l.renewable.filter(([c, n]) => !(c === l.maxSigned && n === l.callsSigned))
        : l.renewable;
    return {
      ...l,
      inFlightSince: null,
      reuseTop: outcome === "reuse",
      retired: l.retired || outcome === "retire" || outcome === "unknown",
      ...(renewable !== undefined ? { renewable } : {}),
    };
  });
}

/** The channel offer, after {@link checkChannelOffer}. */
export interface ChannelOffer {
  price: bigint;
  /** `min(240, maxLifeSeconds)`. */
  lifetimeSeconds: number;
  /** `min(8, maxOpenChannels)`. */
  maxLanes: number;
}

export type OfferCheck = { ok: true; offer: ChannelOffer } | { ok: false; reason: string };

/** The client's own network entry for an offer check. */
export interface ChannelNetwork {
  id: string;
  chainId: number;
  escrow: Address;
  asset: string;
  decimals: number;
}

function sameAccount(a: unknown, b: unknown, chainId: number): boolean {
  const pa = typeof a === "string" ? parseCaip10(a) : null;
  const pb = typeof b === "string" ? parseCaip10(b) : null;
  return pa !== null && pb !== null && pa.chainId === chainId && pb.chainId === chainId && pa.address === pb.address;
}

/**
 * Checks the server's channel offer (`_meta["assay/channelRequired"]`) against the per-call
 * requirement of the same answer, which the guards G1-G12 already passed, and against the
 * client's own network entry. Every value the client signs comes from the requirement or the
 * entry; the offer only has to agree with them. Its `domain` must be exactly the client's escrow
 * domain: an offer for another contract is refused, never signed.
 */
export function checkChannelOffer(raw: unknown, requirement: Record<string, unknown>, net: ChannelNetwork): OfferCheck {
  const no = (reason: string): OfferCheck => ({ ok: false, reason });
  if (!isObject(raw)) return no("the channel offer is not an object");
  if (raw.scheme !== CHANNEL_SCHEME) return no("the channel offer is not channel-v1");
  if (raw.network !== net.id || requirement.network !== net.id) return no("the channel offer is for another network");
  const d = raw.domain;
  if (
    !isObject(d) ||
    Object.keys(d).length !== 4 ||
    d.name !== VOUCHER_DOMAIN_NAME ||
    d.version !== VOUCHER_DOMAIN_VERSION ||
    d.chainId !== net.chainId ||
    !isAddress(d.verifyingContract) ||
    getAddress(d.verifyingContract) !== net.escrow
  ) {
    return no("the channel offer is not for the built-in escrow");
  }
  if (raw.primaryType !== undefined && raw.primaryType !== "ChannelVoucher")
    return no("the channel offer is not a ChannelVoucher");
  if (!sameAccount(raw.payer, requirement.payer, net.chainId)) return no("the channel offer names another payer");
  if (!sameAccount(raw.provider, requirement.provider, net.chainId))
    return no("the channel offer names another provider");
  if (
    raw.delegate !== undefined &&
    raw.delegate !== null &&
    !sameAccount(raw.delegate, requirement.delegate, net.chainId)
  )
    return no("the channel offer names another payment key");
  if (raw.providerId !== requirement.providerId) return no("the channel offer names another provider id");
  if (!Array.isArray(raw.signers) || !raw.signers.includes("delegate"))
    return no("the channel offer does not accept a payment key signature");
  const price = raw.price;
  const amount = requirement.amount;
  if (
    !isObject(price) ||
    !isObject(amount) ||
    typeof price.amount !== "string" ||
    !CANONICAL_UINT.test(price.amount) ||
    price.amount !== amount.amount ||
    price.asset !== net.asset ||
    price.asset !== amount.asset ||
    price.decimals !== net.decimals ||
    price.decimals !== amount.decimals
  ) {
    return no("the channel price is not the checked price");
  }
  const p = BigInt(price.amount);
  if (p <= 0n || p > MAX_CHANNEL_CUMULATIVE) return no("the channel price is out of range");
  // Absent means the default; a present null is refused (as the Python client does).
  const maxLife = raw.maxLifeSeconds === undefined ? 300 : raw.maxLifeSeconds;
  const minLife = raw.minLifeSeconds === undefined ? CHANNEL_MIN_LIFE_SECONDS : raw.minLifeSeconds;
  if (!seconds(maxLife) || !seconds(minLife) || maxLife > 300 || maxLife < 1)
    return no("the channel voucher life is out of range");
  const lifetimeSeconds = Math.min(VOUCHER_LIFETIME_SECONDS, maxLife);
  if (lifetimeSeconds < Math.max(minLife, CHANNEL_MIN_LIFE_SECONDS) + 30)
    return no("the channel voucher life is too short");
  const cap = raw.maxOpenChannels === undefined ? MAX_LANES : raw.maxOpenChannels;
  if (!seconds(cap) || cap < 1) return no("the open-channel cap is not readable");
  return { ok: true, offer: { price: p, lifetimeSeconds, maxLanes: Math.min(MAX_LANES, cap) } };
}

/** The channel voucher as sent in `_meta["assay/channelVoucher"].voucher` (API-W2 §1.3). */
export interface WireChannelVoucher {
  payer: Address;
  provider: Address;
  channelId: Hex;
  cumulative: string;
  calls: number;
  issuedAt: number;
  expiresAt: number;
}

export interface ChannelVoucherTypedData {
  domain: { name: string; version: string; chainId: number; verifyingContract: Address };
  types: typeof CHANNEL_VOUCHER_TYPES;
  primaryType: "ChannelVoucher";
  message: {
    payer: Address;
    provider: Address;
    channelId: Hex;
    cumulative: bigint;
    calls: number;
    issuedAt: bigint;
    expiresAt: bigint;
  };
}

function refuse(field: string, reason: string): never {
  throw new SignerRefusal("the channel voucher", field, reason);
}

/**
 * The wire voucher and the typed data for one lane step. Every value comes from the lane (the
 * client's own record) and the client's network entry; the domain is the built-in escrow's.
 */
export function buildChannelVoucher(
  lane: Pick<ChannelLane, "payer" | "provider" | "escrow" | "network">,
  step: Pick<LaneStep, "channelId" | "cumulative" | "calls" | "issuedAt" | "expiresAt">,
  net: ChannelNetwork,
): { wire: WireChannelVoucher; typedData: ChannelVoucherTypedData } {
  if (lane.network !== net.id || lane.escrow !== net.escrow) refuse("network", "is not the client's network");
  if (!checksummed(lane.payer) || !checksummed(lane.provider)) refuse("payer", "is not an address");
  if (!CHANNEL_ID.test(step.channelId)) refuse("channelId", "is not 32 bytes of lower-case hex");
  if (step.cumulative <= 0n || step.cumulative > MAX_CHANNEL_CUMULATIVE) refuse("cumulative", "is out of range");
  if (!Number.isSafeInteger(step.calls) || step.calls < 1 || step.calls >= CHANNEL_CALLS_LIMIT)
    refuse("calls", "is out of range");
  if (!seconds(step.issuedAt) || step.issuedAt <= 0) refuse("issuedAt", "is not a positive integer");
  const life = step.expiresAt - step.issuedAt;
  if (!seconds(step.expiresAt) || life <= 0 || life > 300) refuse("expiresAt", "is out of range");
  const wire: WireChannelVoucher = {
    payer: lane.payer,
    provider: lane.provider,
    channelId: step.channelId,
    cumulative: step.cumulative.toString(),
    calls: step.calls,
    issuedAt: step.issuedAt,
    expiresAt: step.expiresAt,
  };
  const typedData: ChannelVoucherTypedData = {
    domain: {
      name: VOUCHER_DOMAIN_NAME,
      version: VOUCHER_DOMAIN_VERSION,
      chainId: net.chainId,
      verifyingContract: net.escrow,
    },
    types: CHANNEL_VOUCHER_TYPES,
    primaryType: "ChannelVoucher",
    message: {
      payer: lane.payer,
      provider: lane.provider,
      channelId: step.channelId,
      cumulative: step.cumulative,
      calls: step.calls,
      issuedAt: BigInt(step.issuedAt),
      expiresAt: BigInt(step.expiresAt),
    },
  };
  return { wire, typedData };
}

/** `_meta["assay/channelVoucher"]` (API-W2 §1.3). */
export interface ChannelVoucherEnvelope {
  voucher: WireChannelVoucher;
  signature: string;
  providerId: string;
  contractVersion?: number;
}

export function channelVoucherEnvelope(
  voucher: WireChannelVoucher,
  signature: string,
  providerId: string,
  contractVersion: unknown,
): ChannelVoucherEnvelope {
  return {
    voucher,
    signature,
    providerId,
    ...(typeof contractVersion === "number" && Number.isSafeInteger(contractVersion) && contractVersion >= 1
      ? { contractVersion }
      : {}),
  };
}

/** The payer of a requirement as a checksummed address on `chainId`, or `null`. */
export function accountOf(value: unknown, chainId: number): Address | null {
  const parsed = typeof value === "string" ? parseCaip10(value) : null;
  return parsed && parsed.chainId === chainId ? getAddress(parsed.address) : null;
}
