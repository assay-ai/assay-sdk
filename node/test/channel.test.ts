import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getTypesForEIP712Domain,
  hashDomain,
  hashStruct,
  hashTypedData,
  keccak256,
  recoverTypedDataAddress,
  toBytes,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";
import {
  advanceLane,
  buildChannelVoucher,
  channelKey,
  checkChannelOffer,
  emptyBook,
  finishLane,
  laneCoversChain,
  laneOutcomeOf,
  parseBook,
  pickLane,
  pruneBook,
  recordCheck,
  unpackChannelState,
  type ChannelBook,
  type LanePool,
} from "../src/core/index.js";
import { fileChannelStore, memoryChannelStore, PaymentUnsettledLimitError, type ChannelStore } from "../src/index.js";
import { resetSpendLedger } from "../src/schemes/eip155/index.js";
import { defaultChannelStorePath, noFileSystemReason, takeChannelStoreLock } from "../src/channels.js";
import { Assay, ConfigError, evmSigner } from "../src/index.js";
import {
  BASE,
  fakeClient,
  getToolAnswer,
  KEY,
  load,
  NETWORKS,
  paymentRequired,
  TOOL,
  toolResult,
  type Seen,
  useFreshHome,
} from "./fake.js";

const V = load("channel.json");

type Path = (string | number)[];
function apply<T>(source: T, changes: { op: string; path: Path; value?: unknown }[]): T {
  let copy = structuredClone(source) as unknown;
  for (const { op, path, value } of changes) {
    if (path.length === 0) {
      copy = structuredClone(value);
      continue;
    }
    let node = copy as Record<string | number, unknown>;
    for (const key of path.slice(0, -1)) node = node[key] as Record<string | number, unknown>;
    const last = path[path.length - 1]!;
    if (op === "delete") delete node[last];
    else node[last] = structuredClone(value);
  }
  return copy as T;
}

const asVector = (td: { message: Record<string, unknown> } & Record<string, unknown>) => ({
  ...td,
  message: Object.fromEntries(
    Object.entries(td.message).map(([k, v]) => [k, typeof v === "bigint" || typeof v === "number" ? String(v) : v]),
  ),
});

describe("channel.json: typed data, hashes and the channel key", () => {
  const key = privateKeyToAccount(V.testKey.privateKey as Hex);

  it("the type string and its hash are the contract's", () => {
    expect(keccak256(toBytes(V.typeString))).toBe(V.typeHash);
  });

  for (const c of V.cases) {
    it(c.name, async () => {
      const net = { ...c.network };
      const lane = { network: net.id, escrow: net.escrow, payer: c.lane.payer, provider: c.lane.provider };
      const step = { ...c.step, channelId: c.lane.channelId, cumulative: BigInt(c.step.cumulative) };
      const { wire, typedData } = buildChannelVoucher(lane, step, net);
      expect(wire).toEqual(c.wire);
      expect(asVector(typedData as never)).toEqual(c.typedData);
      expect(
        hashDomain({
          domain: typedData.domain,
          types: { EIP712Domain: getTypesForEIP712Domain({ domain: typedData.domain }) },
        } as Parameters<typeof hashDomain>[0]),
      ).toBe(c.domainSeparator);
      expect(hashStruct({ data: typedData.message, primaryType: "ChannelVoucher", types: typedData.types })).toBe(
        c.structHash,
      );
      expect(hashTypedData(typedData)).toBe(c.digest);
      expect(await key.signTypedData(typedData)).toBe(c.signature);
      expect(await recoverTypedDataAddress({ ...typedData, signature: c.signature as Hex })).toBe(c.lane.signer);
      expect(channelKey(c.lane.payer, c.lane.signer, c.lane.provider, c.lane.channelId)).toBe(c.key);
      const decoded = unpackChannelState(BigInt(c.slot));
      expect({ settled: decoded.settled.toString(), calls: decoded.calls }).toEqual(c.slotDecoded);
    });
  }

  it("refuses values the contract would revert on", () => {
    const c = V.cases[0];
    const lane = { network: c.network.id, escrow: c.network.escrow, payer: c.lane.payer, provider: c.lane.provider };
    const ok = { ...c.step, channelId: c.lane.channelId, cumulative: BigInt(c.step.cumulative) };
    const bad = [
      { ...ok, cumulative: 0n },
      { ...ok, cumulative: 2n ** 56n },
      { ...ok, calls: 0 },
      { ...ok, calls: 2 ** 24 },
      { ...ok, expiresAt: ok.issuedAt },
      { ...ok, expiresAt: ok.issuedAt + 301 },
      { ...ok, channelId: c.lane.channelId.toUpperCase().replace("0X", "0x") },
    ];
    for (const step of bad) expect(() => buildChannelVoucher(lane, step, c.network)).toThrow(/refusing to sign/);
    expect(() => buildChannelVoucher({ ...lane, escrow: V.cases[1].network.escrow }, ok, c.network)).toThrow(
      /refusing to sign/,
    );
  });
});

/** Runs the lane script of channel.json on a book; `ids` hands out the new channel ids in order. */
function runLaneScript(): void {
  const L = V.lanes;
  const pool = L.pool as LanePool;
  const ids = [...L.channelIds] as Hex[];
  let book: ChannelBook = emptyBook();
  for (const [i, s] of (L.steps as Record<string, unknown>[]).entries()) {
    const where = `step ${i} (${String(s.op)})`;
    if (s.op === "take") {
      const pick = pickLane(book, pool, BigInt(s.price as string), {
        maxLanes: L.maxLanes,
        rotateAt: BigInt(L.rotateAt),
        nowSeconds: s.now as number,
        newChannelId: () => ids.shift()!,
      });
      book = pick.book;
      const e = s.expect as Record<string, unknown>;
      if ("none" in e) {
        expect(pick.kind, where).toBe("none");
        continue;
      }
      expect(pick.kind, where).toBe("lane");
      if (pick.kind !== "lane") continue;
      expect(pick.lane.channelId, where).toBe(e.channelId);
      expect(pick.needsCheck, where).toBe(e.needsCheck);
      if (pick.needsCheck) continue;
      const step = advanceLane(
        book,
        pick.lane.channelId,
        BigInt(s.price as string),
        s.issuedAt as number,
        L.lifetimeSeconds,
        s.now as number,
      );
      book = step.book;
      expect(
        {
          channelId: step.channelId,
          cumulative: step.cumulative.toString(),
          calls: step.calls,
          increase: step.increase.toString(),
          issuedAt: step.issuedAt,
          expiresAt: step.expiresAt,
          needsCheck: false,
        },
        where,
      ).toEqual(e);
    } else if (s.op === "finish") {
      book = finishLane(book, s.channelId as string, s.outcome as never);
    } else if (s.op === "check") {
      const lane = book.lanes.find((l) => l.channelId === s.channelId)!;
      const chain = s.chain as { settled: string; calls: number };
      const covered = laneCoversChain(lane, { settled: BigInt(chain.settled), calls: chain.calls });
      expect(covered, where).toBe((s.expect as { covered: boolean }).covered);
      book = recordCheck(book, lane.channelId, covered, s.now as number);
    } else if (s.op === "state") {
      const e = s.expect as { channelId: string; retired: boolean; inFlightSince: null };
      const lane = pruneBook(book, s.now as number).lanes.find((l) => l.channelId === e.channelId)!;
      expect({ retired: lane.retired, inFlightSince: lane.inFlightSince }, where).toEqual({
        retired: e.retired,
        inFlightSince: e.inFlightSince,
      });
    } else {
      throw new Error(`unknown op ${String(s.op)}`);
    }
    // Every intermediate book survives a round trip through the persisted form.
    expect(parseBook(JSON.parse(JSON.stringify(book))), where).toEqual(book);
  }
}

describe("channel.json: lanes", () => {
  it("runs the lane script", () => runLaneScript());

  it("never signs a total its own record did not authorise: the increase is the price, or 0 on a reuse", () => {
    const pool = V.lanes.pool as LanePool;
    let book = emptyBook();
    let id = 0;
    const next = () => `0x${(++id).toString(16).padStart(64, "0")}` as Hex;
    let total = 0n;
    for (let n = 0; n < 50; n++) {
      const price = BigInt(1 + (n % 7)) * 1000n;
      const pick = pickLane(book, pool, price, {
        maxLanes: 8,
        rotateAt: 10n ** 12n,
        nowSeconds: 1000 + n,
        newChannelId: next,
      });
      if (pick.kind !== "lane") throw new Error("no lane");
      const before = BigInt(pick.lane.maxSigned);
      const step = advanceLane(pick.book, pick.lane.channelId, price, 1000 + n, 240, 1000 + n);
      expect(step.cumulative - before).toBe(step.increase);
      total += step.increase;
      book = finishLane(step.book, step.channelId, n % 5 === 0 ? "reuse" : "served");
    }
    const signed = book.lanes.reduce((s, l) => s + BigInt(l.maxSigned), 0n);
    expect(signed).toBe(total);
  });

  it("keeps at most 16 retired lanes per pool, dropping the oldest expired first", () => {
    const pool = V.lanes.pool as LanePool;
    const lane = (n: number, lastExpiresAt: number) => ({
      channelId: `0x${n.toString(16).padStart(64, "0")}` as Hex,
      ...pool,
      maxSigned: "1",
      callsSigned: 1,
      topIncrease: "1",
      lastIssuedAt: lastExpiresAt - 240,
      lastExpiresAt,
      reuseTop: false,
      inFlightSince: null,
      retired: true,
      checkedAt: null,
    });
    const now = 1_000_000;
    // 20 expired lanes (oldest first) and 2 not yet expired.
    const lanes = [
      ...Array.from({ length: 20 }, (_v, i) => lane(i + 1, now - 1000 + i)),
      lane(21, now + 100),
      lane(22, now + 200),
    ];
    const kept = pruneBook({ version: 1, lanes }, now).lanes.map((l) => Number(BigInt(l.channelId)));
    expect(kept).toHaveLength(16);
    expect(kept).toEqual([...Array.from({ length: 14 }, (_v, i) => i + 7), 21, 22]);
  });

  it("a damaged record is refused, never reset", () => {
    expect(() => parseBook({ version: 2, lanes: [] })).toThrow(/channel record/);
    expect(() => parseBook({ version: 1, lanes: [{ channelId: "0x00" }] })).toThrow(/channel record/);
    const lane = { ...emptyBook(), lanes: [] };
    expect(parseBook(lane)).toEqual(emptyBook());
    expect(parseBook(null)).toEqual(emptyBook());
  });

  it("outcomes: served frees, the not-stored refusals re-arm, anything else retires", () => {
    expect(laneOutcomeOf(null)).toBe("served");
    for (const c of ["PAYMENT_UNSETTLED_LIMIT", "CHANNEL_LIMIT", "CHANNEL_SIGNER_EXPIRING", "CHANNEL_NOT_OFFERED"])
      expect(laneOutcomeOf(c)).toBe("reuse");
    for (const c of ["CHANNEL_ROTATE", "CHANNEL_DESYNC", "PAYMENT_VOUCHER_EXPIRED", "SOMETHING_NEW"])
      expect(laneOutcomeOf(c)).toBe("retire");
  });

  it("outcomes: the pre-store spend-policy refusals re-arm, keyed on code and reason", () => {
    const V_LANES = V.lanes;
    const VEL = "MCP_VELOCITY_LIMIT_EXCEEDED";
    for (const r of ["DUPLICATE_REQUEST", "CALLS_PER_MINUTE", "CALLS_PER_HOUR", "SPEND_PER_HOUR"])
      expect(laneOutcomeOf(VEL, r)).toBe("reuse");
    for (const c of ["MCP_SPEND_LIMIT_EXCEEDED", "MCP_POLICY_AGENT_PAUSED", "MCP_APPROVAL_REQUIRED"]) {
      expect(laneOutcomeOf(c)).toBe("reuse");
      expect(laneOutcomeOf(c, "anything")).toBe("reuse");
    }
    // The spend lock may fail after the voucher was stored: never re-armed.
    expect(laneOutcomeOf(VEL, "UNAVAILABLE")).toBe("retire");
    for (const r of [undefined, null, "", "SOMETHING_NEW", "duplicate_request", 5])
      expect(laneOutcomeOf(VEL, r)).toBe("retire");
    // A reason never turns another code into a re-arm.
    expect(laneOutcomeOf("CHANNEL_ROTATE", "DUPLICATE_REQUEST")).toBe("retire");
    expect(laneOutcomeOf("toString")).toBe("retire");
    // A re-armed refusal drops the refused top pair from the renewable pairs, as any refusal does.
    for (const [c, r] of [
      [VEL, "DUPLICATE_REQUEST"],
      ["MCP_SPEND_LIMIT_EXCEEDED", undefined],
    ] as const) {
      const lane = {
        channelId: `0x${"1".padStart(64, "0")}` as Hex,
        ...(V_LANES.pool as LanePool),
        maxSigned: "200000",
        callsSigned: 2,
        topIncrease: "100000",
        lastIssuedAt: 1000,
        lastExpiresAt: 1240,
        reuseTop: false,
        inFlightSince: 1000,
        retired: false,
        checkedAt: null,
        renewable: [
          ["100000", 1],
          ["200000", 2],
        ] as [string, number][],
      };
      const done = finishLane({ ...emptyBook(), lanes: [lane] }, lane.channelId, laneOutcomeOf(c, r)).lanes[0]!;
      expect(done).toMatchObject({ reuseTop: true, retired: false, renewable: [["100000", 1]] });
    }
  });
});

describe("channel.json: the server's offer", () => {
  const O = V.offers;
  it("valid", () => {
    const r = checkChannelOffer(O.offer, O.requirement, O.network);
    expect(r).toEqual({
      ok: true,
      offer: { price: BigInt(O.valid.price), lifetimeSeconds: O.valid.lifetimeSeconds, maxLanes: O.valid.maxLanes },
    });
  });
  for (const c of O.invalid) {
    it(`refuses ${c.name}`, () => {
      expect(checkChannelOffer(apply(O.offer, c.changes), O.requirement, O.network).ok).toBe(false);
    });
  }
});

// ---- the client ----------------------------------------------------------------------------

const word = (n: bigint | number) => BigInt(n).toString(16).padStart(64, "0");
const CHANNEL_BOOKS = keccak256(toBytes("channelBooks(bytes32,address)")).slice(2, 10);
const NET = BASE.network;
const CHANNEL_NETWORKS = { [NET.id]: { ...NETWORKS[NET.id]!, channels: true } };

function offer(): Record<string, unknown> {
  const r = BASE.requirement;
  return {
    scheme: "channel-v1",
    network: r.network,
    payer: r.payer,
    provider: r.provider,
    providerId: r.providerId,
    price: { ...r.amount },
    contractVersion: 3,
    domain: { name: "Assay Settlement", version: "2", chainId: 31337, verifyingContract: NET.escrow.split(":")[2] },
    primaryType: "ChannelVoucher",
    minLifeSeconds: 60,
    maxLifeSeconds: 300,
    maxOpenChannels: 16,
    signers: ["payer", "delegate"],
    delegate: r.delegate,
  };
}

const metaOf = (s: Seen) => (s.body as { params: { _meta: Record<string, unknown> } }).params._meta;
type Envelope = {
  voucher: { channelId: string; cumulative: string; calls: number; issuedAt: number; expiresAt: number };
  signature: Hex;
};

/**
 * A paid tool that offers a channel. `answer(envelope, n)` answers the n-th channel voucher; a
 * per-call voucher is served. The server keeps no state: the client must bring its own totals.
 */
function channelTool(
  o: {
    answer?: (env: Envelope, n: number) => unknown;
    offer?: () => unknown;
  } = {},
) {
  let n = 0;
  return (params: Record<string, unknown>) => {
    if (params.name === "get_tool") return getToolAnswer();
    const meta = params._meta as Record<string, unknown>;
    if (meta["assay/channelVoucher"]) {
      return (
        o.answer?.(meta["assay/channelVoucher"] as Envelope, n++) ??
        toolResult({ "assay/receipt": { intentId: `i${n}` } })
      );
    }
    if (meta["assay/voucher"]) return toolResult({ "assay/receipt": { intentId: "per-call" } });
    const r = paymentRequired() as { _meta: Record<string, unknown> };
    if (Array.isArray(meta["assay/paymentSchemes"])) r._meta["assay/channelRequired"] = o.offer ? o.offer() : offer();
    return r;
  };
}

const refusal = (code: string, extra: Record<string, unknown> = {}) =>
  toolResult({ "assay/error": { code, message: code, retryable: true, ...extra } }, { isError: true });

/** An RPC answering `channelBooks` with `state(key)`, the grant views otherwise. */
const chainWith = (state: (key: string) => bigint) => (req: Seen) => {
  const body = req.body as { id: number; method: string; params: { data: string }[] };
  if (body.method !== "eth_call" || !body.params[0]!.data.startsWith(`0x${CHANNEL_BOOKS}`)) return undefined;
  const key = `0x${body.params[0]!.data.slice(10, 74)}`;
  return { body: { jsonrpc: "2.0", id: body.id, result: `0x${word(state(key))}${word(0)}${word(0)}${word(0)}` } };
};

function channelClient(o: {
  store?: ChannelStore;
  mcp?: ReturnType<typeof channelTool>;
  rpc?: (req: Seen) => unknown;
  limits?: { maxPerCall: string; maxPerDay: string };
  channels?: boolean;
  now?: () => number;
}) {
  return fakeClient({
    mcp: o.mcp ?? channelTool(),
    ...(o.rpc ? { rpc: o.rpc as never } : {}),
    options: {
      networks: o.channels === false ? NETWORKS : CHANNEL_NETWORKS,
      channels: { store: o.store ?? memoryChannelStore() },
      ...(o.limits ? { limits: o.limits } : {}),
      ...(o.now ? { now: o.now } : {}),
    },
  });
}

const channelSent = (calls: () => Seen[]) =>
  calls()
    .map((s) => metaOf(s)["assay/channelVoucher"] as Envelope | undefined)
    .filter((e): e is Envelope => e !== undefined);

afterEach(() => resetSpendLedger());

describe("client: channel lane", () => {
  it("offers channel-v1 always (the built-in mainnet entry has the door); signs one only on a channel network", async () => {
    useFreshHome();
    const plain = fakeClient({ mcp: channelTool() });
    await plain.client.tools.call(TOOL, {});
    expect(metaOf(plain.calls()[0]!)["assay/paymentSchemes"]).toEqual(["channel-v1", "voucher"]);
    expect(channelSent(plain.calls)).toEqual([]);

    // The built-in mainnet entry has the channel door, so a client with a store offers channel-v1;
    // on a network whose own entry does not say `channels: true` it still signs per call only.
    const notCapable = channelClient({ channels: false });
    await notCapable.client.tools.call(TOOL, {});
    expect(metaOf(notCapable.calls()[0]!)["assay/paymentSchemes"]).toEqual(["channel-v1", "voucher"]);
    expect(channelSent(notCapable.calls)).toEqual([]);
    expect(notCapable.calls().some((s) => metaOf(s)["assay/voucher"] !== undefined)).toBe(true);

    const on = channelClient({});
    await on.client.tools.call(TOOL, {});
    expect(metaOf(on.calls()[0]!)["assay/paymentSchemes"]).toEqual(["channel-v1", "voucher"]);
    expect(channelSent(on.calls)).toHaveLength(1);
  });

  it("without the channels option keeps lanes in the default file under the home folder (0600)", async () => {
    const home = useFreshHome();
    const c = fakeClient({ mcp: channelTool(), options: { networks: CHANNEL_NETWORKS } });
    await c.client.tools.call(TOOL, {});
    expect(channelSent(c.calls)).toHaveLength(1);
    const path = defaultChannelStorePath(KEY.address, home);
    expect(path.startsWith(home)).toBe(true);
    expect(
      path.endsWith(
        `goassay${process.platform === "win32" ? "\\" : "/"}channels${process.platform === "win32" ? "\\" : "/"}${KEY.address.toLowerCase()}.json`,
      ),
    ).toBe(true);
    const book = JSON.parse(readFileSync(path, "utf8")) as { lanes: unknown[] };
    expect(book.lanes).toHaveLength(1);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("signs the contract's ChannelVoucher from its own record: price, then total + price", async () => {
    const seenDetails: unknown[] = [];
    const { client, calls, signTypedData } = fakeClient({
      mcp: channelTool(),
      options: {
        networks: CHANNEL_NETWORKS,
        channels: { store: memoryChannelStore() },
        onPayment: (d) => void seenDetails.push(d),
      },
    });
    await client.tools.call(TOOL, {});
    await client.tools.call(TOOL, {});
    const [a, b] = channelSent(calls);
    expect(a!.voucher).toMatchObject({ cumulative: "100000", calls: 1 });
    expect(b!.voucher).toMatchObject({ cumulative: "200000", calls: 2, channelId: a!.voucher.channelId });
    expect(signTypedData).toHaveBeenCalledTimes(2);
    const escrow = NET.escrow.split(":")[2] as Hex;
    const td = buildChannelVoucher(
      { network: NET.id, escrow, payer: BASE.chain.payer, provider: BASE.requirement.provider.split(":")[2] },
      { ...b!.voucher, channelId: b!.voucher.channelId as Hex, cumulative: BigInt(b!.voucher.cumulative) },
      { id: NET.id, chainId: 31337, escrow, asset: NET.asset, decimals: 6 },
    ).typedData;
    expect(await recoverTypedDataAddress({ ...td, signature: b!.signature })).toBe(KEY.address);
    // The hook sees the price of the call, and the lane's total next to it.
    expect(seenDetails[1]).toMatchObject({
      amount: BASE.requirement.amount,
      channel: { cumulative: "200000", calls: 2, increase: "100000" },
    });
  });

  it("ignores any cumulative the server names", async () => {
    const evil = () => ({ ...offer(), cumulative: "4000000", calls: 40, lastAccepted: "3900000" });
    const { client, calls } = channelClient({ mcp: channelTool({ offer: evil }) });
    await client.tools.call(TOOL, {});
    expect(channelSent(calls)[0]!.voucher).toMatchObject({ cumulative: "100000", calls: 1 });
  });

  it("an offer for another escrow is never signed: the call is paid per call", async () => {
    const other = () => ({
      ...offer(),
      domain: { ...(offer().domain as object), verifyingContract: "0x1111111111111111111111111111111111111111" },
    });
    const { client, calls } = channelClient({ mcp: channelTool({ offer: other }) });
    const r = await client.tools.call(TOOL, {});
    expect(channelSent(calls)).toEqual([]);
    expect(r.receipt?.intentId).toBe("per-call");
  });

  it("the 24 h limit counts increases only: a re-signed total adds nothing", async () => {
    // $0.25 a day, $0.10 a call: two increases fit, a third does not.
    let first = true;
    const { client, calls } = channelClient({
      limits: { maxPerCall: "0.10", maxPerDay: "0.25" },
      mcp: channelTool({
        answer: () => {
          if (!first) return undefined;
          first = false;
          return refusal("PAYMENT_UNSETTLED_LIMIT", { retryAfter: 600 });
        },
      }),
    });
    await expect(client.tools.call(TOOL, {})).rejects.toBeInstanceOf(PaymentUnsettledLimitError);
    // The same pair again: no increase, so the second and third calls still fit.
    await client.tools.call(TOOL, {});
    await client.tools.call(TOOL, {});
    const sent = channelSent(calls).map((e) => [e.voucher.cumulative, e.voucher.calls]);
    expect(sent).toEqual([
      ["100000", 1],
      ["100000", 1],
      ["200000", 2],
    ]);
    await expect(client.tools.call(TOOL, {})).rejects.toMatchObject({ code: "G7_PER_DAY" });
  });

  it("PAYMENT_UNSETTLED_LIMIT: a long wait is thrown with retryAfterMs, nothing resent; a short one is resent as is", async () => {
    const long = channelClient({
      mcp: channelTool({ answer: () => refusal("PAYMENT_UNSETTLED_LIMIT", { retryAfter: 900 }) }),
    });
    const err = await long.client.tools.call(TOOL, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaymentUnsettledLimitError);
    expect((err as PaymentUnsettledLimitError).retryAfterMs).toBe(900_000);
    expect((err as PaymentUnsettledLimitError).retryable).toBe(true);
    expect(channelSent(long.calls)).toHaveLength(1);

    const short = channelClient({
      mcp: channelTool({
        answer: (_e, n) => (n === 0 ? refusal("PAYMENT_UNSETTLED_LIMIT", { retryAfter: 5 }) : undefined),
      }),
    });
    await short.client.tools.call(TOOL, {});
    const sent = channelSent(short.calls);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    expect(short.sleep).toHaveBeenCalledWith(5000);
  });

  it("CHANNEL_ROTATE: one voucher for the call, a retryable error; the next call opens a new lane", async () => {
    const { client, calls, signTypedData } = channelClient({
      mcp: channelTool({ answer: (_e, n) => (n === 1 ? refusal("CHANNEL_ROTATE", { retryable: true }) : undefined) }),
    });
    await client.tools.call(TOOL, {});
    const err = await client.tools.call(TOOL, {}).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "CHANNEL_ROTATE", retryable: true });
    expect(signTypedData).toHaveBeenCalledTimes(2);
    await client.tools.call(TOOL, {});
    const sent = channelSent(calls);
    expect(sent.map((e) => [e.voucher.cumulative, e.voucher.calls])).toEqual([
      ["100000", 1],
      ["200000", 2],
      ["100000", 1],
    ]);
    expect(sent[2]!.voucher.channelId).not.toBe(sent[0]!.voucher.channelId);
    expect(calls().filter((s) => metaOf(s)["assay/voucher"] !== undefined)).toHaveLength(0);
  });

  it("five rotations within an hour stop channel offers for an hour", async () => {
    const { client, calls } = channelClient({
      mcp: channelTool({ answer: () => refusal("CHANNEL_ROTATE", { retryable: true }) }),
    });
    for (let i = 0; i < 5; i++)
      await expect(client.tools.call(TOOL, {})).rejects.toMatchObject({ code: "CHANNEL_ROTATE" });
    const r = await client.tools.call(TOOL, {});
    expect(r.receipt?.intentId).toBe("per-call");
    expect(metaOf(calls().at(-1)!)["assay/paymentSchemes"]).toBeUndefined();
    expect(channelSent(calls)).toHaveLength(5);
  });

  it("CHANNEL_LIMIT: a retryable error, no second voucher; channels pause for an hour, then the lane is re-armed", async () => {
    let now = BASE.nowSeconds * 1000;
    const { client, calls, signTypedData } = channelClient({
      now: () => now,
      rpc: chainWith(() => 0n),
      mcp: channelTool({ answer: (_e, n) => (n === 0 ? refusal("CHANNEL_LIMIT", { retryAfter: 60 }) : undefined) }),
    });
    await expect(client.tools.call(TOOL, {})).rejects.toMatchObject({ code: "CHANNEL_LIMIT", retryable: true });
    expect(signTypedData).toHaveBeenCalledTimes(1);
    // Paused: the next call offers no channel and is paid per call.
    expect((await client.tools.call(TOOL, {})).receipt?.intentId).toBe("per-call");
    expect(metaOf(calls().at(-1)!)["assay/paymentSchemes"]).toBeUndefined();
    now += 3_601_000;
    await client.tools.call(TOOL, {});
    const sent = channelSent(calls);
    expect(sent.map((e) => [e.voucher.cumulative, e.voucher.calls])).toEqual([
      ["100000", 1],
      ["100000", 1],
    ]);
    expect(sent[1]!.voucher.channelId).toBe(sent[0]!.voucher.channelId);
  });

  it("a re-armed pair is not re-signed for free once its first signature can no longer settle", async () => {
    let now = BASE.nowSeconds * 1000;
    const { client, calls } = channelClient({
      now: () => now,
      rpc: chainWith(() => 0n),
      limits: { maxPerCall: "0.10", maxPerDay: "5" },
      mcp: channelTool({
        answer: (_e, n) => (n === 0 ? refusal("PAYMENT_UNSETTLED_LIMIT", { retryAfter: 900 }) : undefined),
      }),
    });
    await expect(client.tools.call(TOOL, {})).rejects.toBeInstanceOf(PaymentUnsettledLimitError);
    now += (240 + 7201) * 1000;
    await client.tools.call(TOOL, {});
    const sent = channelSent(calls);
    expect(sent[1]!.voucher.channelId).not.toBe(sent[0]!.voucher.channelId);
    expect(sent[1]!.voucher).toMatchObject({ cumulative: "100000", calls: 1 });
  });

  it("a DUPLICATE_REQUEST refusal re-arms the lane: the retry signs the same pair on the same lane", async () => {
    const { client, calls } = channelClient({
      mcp: channelTool({
        answer: (_e, n) =>
          n === 1 ? refusal("MCP_VELOCITY_LIMIT_EXCEEDED", { reason: "DUPLICATE_REQUEST", retryAfter: 19 }) : undefined,
      }),
    });
    await client.tools.call(TOOL, {});
    await expect(client.tools.call(TOOL, {})).rejects.toMatchObject({ code: "MCP_VELOCITY_LIMIT_EXCEEDED" });
    await client.tools.call(TOOL, {});
    const sent = channelSent(calls);
    expect(sent.map((e) => [e.voucher.channelId, e.voucher.cumulative, e.voucher.calls])).toEqual([
      [sent[0]!.voucher.channelId, "100000", 1],
      [sent[0]!.voucher.channelId, "200000", 2],
      [sent[0]!.voucher.channelId, "200000", 2],
    ]);
  });

  it("a velocity refusal with reason UNAVAILABLE retires the lane (it may come after the store)", async () => {
    const { client, calls } = channelClient({
      mcp: channelTool({
        answer: (_e, n) =>
          n === 0 ? refusal("MCP_VELOCITY_LIMIT_EXCEEDED", { reason: "UNAVAILABLE", retryAfter: 1 }) : undefined,
      }),
    });
    await expect(client.tools.call(TOOL, {})).rejects.toMatchObject({ code: "MCP_VELOCITY_LIMIT_EXCEEDED" });
    await client.tools.call(TOOL, {});
    const sent = channelSent(calls);
    expect(sent[1]!.voucher.channelId).not.toBe(sent[0]!.voucher.channelId);
    expect(sent[1]!.voucher).toMatchObject({ cumulative: "100000", calls: 1 });
  });

  it("any other refusal retires the lane and is thrown", async () => {
    const { client, calls } = channelClient({
      mcp: channelTool({ answer: (_e, n) => (n === 0 ? refusal("CHANNEL_DESYNC", { retryable: false }) : undefined) }),
    });
    await expect(client.tools.call(TOOL, {})).rejects.toMatchObject({ code: "CHANNEL_DESYNC" });
    await client.tools.call(TOOL, {});
    const sent = channelSent(calls);
    expect(sent[1]!.voucher).toMatchObject({ cumulative: "100000", calls: 1 });
    expect(sent[1]!.voucher.channelId).not.toBe(sent[0]!.voucher.channelId);
  });

  it("a refused onPayment retires the advanced lane: no total is signed that the spend record did not count", async () => {
    let refuse = true;
    const { client, calls } = fakeClient({
      mcp: channelTool(),
      options: {
        networks: CHANNEL_NETWORKS,
        channels: { store: memoryChannelStore() },
        onPayment: () => (refuse ? ((refuse = false), false) : true),
      },
    });
    await expect(client.tools.call(TOOL, {})).rejects.toMatchObject({ code: "PAYMENT_REFUSED_BY_CALLER" });
    await client.tools.call(TOOL, {});
    expect(channelSent(calls)[0]!.voucher).toMatchObject({ cumulative: "100000", calls: 1 });
  });
});

describe("client: channel lanes survive a restart, checked against the chain", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("a new client on the same file continues the lane after the chain confirms the record", async () => {
    dir = mkdtempSync(join(tmpdir(), "assay-channels-"));
    const path = join(dir, "lanes.json");
    let now = BASE.nowSeconds * 1000;
    const settled = new Map<string, bigint>();
    const rpc = chainWith((key) => settled.get(key) ?? 0n);
    const first = channelClient({ store: fileChannelStore(path), rpc, now: () => now });
    await first.client.tools.call(TOOL, {});
    await first.client.tools.call(TOOL, {});
    const book = parseBook(JSON.parse(readFileSync(path, "utf8")));
    expect(book.lanes).toHaveLength(1);
    expect(book.lanes[0]).toMatchObject({ maxSigned: "200000", callsSigned: 2, inFlightSince: null });

    // The same process (one lock per process), a fresh client: the lane's record is read back.
    const lane = book.lanes[0]!;
    const key = channelKey(lane.payer, lane.signer, lane.provider, lane.channelId);
    settled.set(key, 100000n | (1n << 56n));
    now += 30_000;
    const second = channelClient({ store: fileChannelStore(path), rpc, now: () => now });
    await second.client.tools.call(TOOL, {});
    const sent = channelSent(second.calls);
    expect(sent[0]!.voucher).toMatchObject({ channelId: lane.channelId, cumulative: "300000", calls: 3 });
    // The check read channelBooks for exactly this key.
    const read = second.seen.find((s) => JSON.stringify(s.body).includes(CHANNEL_BOOKS));
    expect(JSON.stringify(read?.body)).toContain(key.slice(2));
  });

  it("a record the chain shows more than is retired: a new lane, never a lower total on the old one", async () => {
    dir = mkdtempSync(join(tmpdir(), "assay-channels-"));
    const path = join(dir, "lanes.json");
    const first = channelClient({ store: fileChannelStore(path) });
    await first.client.tools.call(TOOL, {});
    const lane = parseBook(JSON.parse(readFileSync(path, "utf8"))).lanes[0]!;
    // A restored older copy of the file, while the chain already settled further.
    const rpc = chainWith(() => 500000n | (5n << 56n));
    const second = channelClient({ store: fileChannelStore(path), rpc });
    await second.client.tools.call(TOOL, {});
    const sent = channelSent(second.calls)[0]!;
    expect(sent.voucher.channelId).not.toBe(lane.channelId);
    expect(sent.voucher).toMatchObject({ cumulative: "100000", calls: 1 });
    const after = parseBook(JSON.parse(readFileSync(path, "utf8")));
    expect(after.lanes.find((l) => l.channelId === lane.channelId)?.retired).toBe(true);
  });

  it("the chain check runs outside the lane lock: a slow RPC does not stall the store", async () => {
    dir = mkdtempSync(join(tmpdir(), "assay-channels-"));
    const path = join(dir, "lanes.json");
    const first = channelClient({ store: fileChannelStore(path) });
    await first.client.tools.call(TOOL, {});
    const lane = parseBook(JSON.parse(readFileSync(path, "utf8"))).lanes[0]!;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let reading = false;
    const chain = chainWith(() => 100000n | (1n << 56n));
    const rpc = async (req: Seen) => {
      const answer = chain(req);
      if (answer !== undefined) {
        reading = true;
        await gate;
      }
      return answer;
    };
    const store = fileChannelStore(path);
    const second = channelClient({ store, rpc });
    const call = second.client.tools.call(TOOL, {});
    while (!reading) await new Promise((r) => setTimeout(r, 5));
    // While the chain read hangs, the store's queue is free.
    const free = await Promise.race([
      store.exclusive!(async () => "free"),
      new Promise((r) => setTimeout(() => r("blocked"), 500)),
    ]);
    release();
    await call;
    expect(free).toBe("free");
    // Then the lane goes on from its own record: one signature, the next pair, persisted.
    const sent = channelSent(second.calls);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.voucher).toMatchObject({ channelId: lane.channelId, cumulative: "200000", calls: 2 });
    expect(parseBook(JSON.parse(readFileSync(path, "utf8"))).lanes[0]).toMatchObject({
      maxSigned: "200000",
      callsSigned: 2,
      inFlightSince: null,
    });
  });

  it("a lane changed while its chain check was in flight is not recorded as checked", async () => {
    dir = mkdtempSync(join(tmpdir(), "assay-channels-"));
    const path = join(dir, "lanes.json");
    const first = channelClient({ store: fileChannelStore(path) });
    await first.client.tools.call(TOOL, {});
    const lane = parseBook(JSON.parse(readFileSync(path, "utf8"))).lanes[0]!;
    const store = fileChannelStore(path);
    const chain = chainWith(() => 100000n | (1n << 56n));
    let reads = 0;
    const rpc = async (req: Seen) => {
      const answer = chain(req);
      if (answer !== undefined && reads++ === 0) {
        // Another writer retires the lane meanwhile (compare-and-set must see it).
        await store.exclusive!(async () => {
          const book = parseBook(await store.load());
          await store.save(finishLane(book, lane.channelId, "retire"));
        });
      }
      return answer;
    };
    const second = channelClient({ store, rpc });
    await second.client.tools.call(TOOL, {});
    const sent = channelSent(second.calls);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.voucher.channelId).not.toBe(lane.channelId);
    expect(sent[0]!.voucher).toMatchObject({ cumulative: "100000", calls: 1 });
    const old = parseBook(JSON.parse(readFileSync(path, "utf8"))).lanes.find((l) => l.channelId === lane.channelId)!;
    expect(old).toMatchObject({ retired: true, maxSigned: "100000", callsSigned: 1 });
  });

  it("no agreed chain read: the lane is left alone and the call is paid per call", async () => {
    dir = mkdtempSync(join(tmpdir(), "assay-channels-"));
    const path = join(dir, "lanes.json");
    const first = channelClient({ store: fileChannelStore(path) });
    await first.client.tools.call(TOOL, {});
    const failing = (req: Seen) =>
      JSON.stringify(req.body).includes(CHANNEL_BOOKS) ? { status: 500, body: {} } : undefined;
    const second = channelClient({ store: fileChannelStore(path), rpc: failing });
    const r = await second.client.tools.call(TOOL, {});
    expect(r.receipt?.intentId).toBe("per-call");
    expect(parseBook(JSON.parse(readFileSync(path, "utf8"))).lanes[0]).toMatchObject({
      retired: false,
      maxSigned: "100000",
    });
  });

  it("a damaged file is never reset: channel signing stops, per-call goes on", async () => {
    dir = mkdtempSync(join(tmpdir(), "assay-channels-"));
    const path = join(dir, "lanes.json");
    writeFileSync(path, '{"version":1,"lanes":[{"channelId":"0xzz"}]}');
    const { client, calls } = channelClient({ store: fileChannelStore(path) });
    const r = await client.tools.call(TOOL, {});
    expect(r.receipt?.intentId).toBe("per-call");
    expect(channelSent(calls)).toEqual([]);
    expect(readFileSync(path, "utf8")).toContain("0xzz");
  });

  it("two clients in one process on the same file never sign conflicting totals", async () => {
    dir = mkdtempSync(join(tmpdir(), "assay-channels-"));
    const path = join(dir, "lanes.json");
    const a = channelClient({ store: fileChannelStore(path) });
    const b = channelClient({ store: fileChannelStore(path) });
    await Promise.all([1, 2, 3, 4].flatMap(() => [a.client.tools.call(TOOL, {}), b.client.tools.call(TOOL, {})]));
    const all = [...channelSent(a.calls), ...channelSent(b.calls)];
    expect(all).toHaveLength(8);
    expect(new Set(all.map((e) => `${e.voucher.channelId}:${e.voucher.cumulative}`)).size).toBe(8);
    for (const lane of parseBook(JSON.parse(readFileSync(path, "utf8"))).lanes) {
      const mine = all.filter((e) => e.voucher.channelId === lane.channelId).map((e) => e.voucher.calls);
      expect(mine.sort((x, y) => x - y)).toEqual(Array.from({ length: lane.callsSigned }, (_v, i) => i + 1));
    }
  });

  it("two spellings of one file (a symlinked folder) share one queue: no two calls plan the same pair", async () => {
    dir = mkdtempSync(join(tmpdir(), "assay-channels-"));
    const real = join(dir, "real");
    const a = fileChannelStore(join(real, "lanes.json"));
    await a.load(); // creates the folder and takes the lock
    symlinkSync(real, join(dir, "link"));
    const b = fileChannelStore(join(dir, "link", "lanes.json"));
    const pool: LanePool = {
      network: "eip155:31337",
      escrow: "0xE5c0e5C0e5C0e5C0E5c0E5c0E5C0E5C0E5C0E5C0",
      payer: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      signer: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      provider: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
    };
    const t = 1786000000;
    const lane0 = `0x${"11".repeat(32)}`;
    // The read-modify-write the scheme runs under `exclusive`, with an await in the middle.
    const plan = (store: ChannelStore, id: string) =>
      store.exclusive!(async () => {
        const pick = pickLane(parseBook(await store.load()), pool, 100000n, {
          maxLanes: 8,
          rotateAt: 10n ** 12n,
          nowSeconds: t,
          newChannelId: () => id as `0x${string}`,
        });
        if (pick.kind === "none") throw new Error(pick.reason);
        await new Promise((r) => setTimeout(r, 20));
        const step = advanceLane(pick.book, pick.lane.channelId, 100000n, t, 240, t);
        await store.save(step.book);
        return `${step.channelId}:${step.cumulative}:${step.calls}`;
      });
    await plan(a, lane0);
    await a.save(recordCheck(finishLane(parseBook(await a.load()), lane0, "served"), lane0, true, t));
    const [x, y] = await Promise.all([plan(a, `0x${"22".repeat(32)}`), plan(b, `0x${"33".repeat(32)}`)]);
    expect(x).not.toBe(y);
  });

  it("a lock left by a dead process is taken over; a fresh lock moved by mistake is put back", () => {
    dir = mkdtempSync(join(tmpdir(), "assay-channels-"));
    const lock = join(dir, "lanes.json.lock");
    writeFileSync(lock, "99999999"); // above every pid_max: no such process
    takeChannelStoreLock(lock);
    expect(readFileSync(lock, "utf8")).toBe(String(process.pid));

    // Another process cleared the same stale lock and took a fresh one between our look and our move.
    writeFileSync(lock, "99999999");
    expect(() =>
      takeChannelStoreLock(lock, () => {
        rmSync(lock);
        writeFileSync(lock, "1"); // pid 1 is always alive
      }),
    ).toThrow(/another process/);
    expect(readFileSync(lock, "utf8")).toBe("1");
    expect(readdirSync(dir)).toEqual(["lanes.json.lock"]);
  });

  it("the file is private and a second process is kept off it by the lock", () => {
    dir = mkdtempSync(join(tmpdir(), "assay-channels-"));
    const path = join(dir, "lanes.json");
    writeFileSync(`${path}.lock`, "1"); // pid 1 is always alive
    const store = fileChannelStore(path);
    return expect(store.load()).rejects.toThrow(/another process/);
  });
});

describe("default lane store", () => {
  it("is a per-key file in the platform's config folder", () => {
    const a = "0x00000000000000000000000000000000000000Ab";
    expect(defaultChannelStorePath(a, "/home/u", "linux")).toBe(
      "/home/u/.config/goassay/channels/0x00000000000000000000000000000000000000ab.json",
    );
    expect(defaultChannelStorePath(a, "/Users/u", "darwin")).toBe(
      "/Users/u/Library/Application Support/goassay/channels/0x00000000000000000000000000000000000000ab.json",
    );
    expect(defaultChannelStorePath(a, "C:\\Users\\u", "win32")).toBe(
      "C:\\Users\\u\\AppData\\Roaming\\goassay\\channels\\0x00000000000000000000000000000000000000ab.json",
    );
    expect(() => defaultChannelStorePath("not-an-address", "/home/u", "linux")).toThrow(ConfigError);
  });

  it("names the runtimes without a durable file system", () => {
    expect(noFileSystemReason()).toBeNull();
    expect(noFileSystemReason({ navigator: { userAgent: "Cloudflare-Workers" }, process })).toBe("a Cloudflare Worker");
    expect(noFileSystemReason({ EdgeRuntime: "edge-runtime", process })).toBe("an edge runtime");
    expect(noFileSystemReason({ window: {}, document: {} })).toBe("a browser");
    expect(noFileSystemReason({})).not.toBeNull();
  });

  it("on a Worker, a client with a signer and no channels option is refused at construction; a store is accepted", () => {
    const nav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Cloudflare-Workers" }, configurable: true });
    try {
      const base = {
        apiKey: "ak_test",
        signer: evmSigner(KEY),
        fetch: (() => Promise.reject(new Error("no"))) as never,
      };
      expect(() => new Assay(base)).toThrow(/pass channels: \{ store \}/);
      expect(() => new Assay({ ...base, channels: { store: memoryChannelStore() } })).not.toThrow();
      // No signer: nothing is paid, nothing is stored.
      expect(() => new Assay({ apiKey: "ak_test" })).not.toThrow();
    } finally {
      if (nav) Object.defineProperty(globalThis, "navigator", nav);
      else delete (globalThis as { navigator?: unknown }).navigator;
    }
  });
});
