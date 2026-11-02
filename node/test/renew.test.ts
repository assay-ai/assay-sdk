import { hashTypedData, recoverTypedDataAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";
import {
  advanceLane,
  allDebtsCollecting,
  buildChannelVoucher,
  CHANNEL_DEBT_RENEWED_TEXT,
  CHANNEL_DEBT_RETRY_TEXT,
  ChannelBookError,
  channelDebtAnswer,
  channelDebtNoRecordText,
  DEBT_COLLECTING_TEXT,
  emptyBook,
  OTHER_WALLET_DEBT_TEXT,
  finishLane,
  LANE_PAIRS_KEPT,
  laneOutcomeOf,
  parseBook,
  parseDebtList,
  pickLane,
  renewChannelDebts,
  renewLane,
  renewTarget,
  type ChannelBook,
  type ChannelLane,
  type RenewIo,
} from "../src/core/index.js";
import { ConfigError, memoryChannelStore, PaymentError } from "../src/index.js";
import { resetSpendLedger } from "../src/schemes/eip155/index.js";
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
  WEB,
  type Seen,
  useFreshHome,
} from "./fake.js";

const V = load("channel.json");
const R = V.renews;

afterEach(() => resetSpendLedger());

const asVector = (td: { message: Record<string, unknown> } & Record<string, unknown>) => ({
  ...td,
  message: Object.fromEntries(
    Object.entries(td.message).map(([k, v]) => [k, typeof v === "bigint" || typeof v === "number" ? String(v) : v]),
  ),
});

/** The vectors' base lane with a case's `lane` changes (a null value deletes the field). */
function caseLane(changes: Record<string, unknown> = {}): Record<string, unknown> {
  const l: Record<string, unknown> = { ...R.lane };
  for (const [k, v] of Object.entries(changes)) {
    if (v === null) delete l[k];
    else l[k] = v;
  }
  return l;
}

describe("channel.json: renews", () => {
  const key = privateKeyToAccount(V.testKey.privateKey as Hex);
  const pool = () => ({
    channelId: R.lane.channelId,
    network: R.network.id,
    escrow: R.lane.escrow,
    payer: R.lane.payer,
    signer: R.lane.signer,
  });

  for (const c of R.valid) {
    it(`renews ${c.name}`, async () => {
      const before = parseBook({ version: 1, lanes: [caseLane(c.lane)] });
      expect(renewTarget(before, { ...pool(), cumulative: BigInt(c.cumulative), calls: c.calls })).not.toBeNull();
      const r = renewLane(before, R.lane.channelId, BigInt(c.cumulative), c.calls, c.issuedAt, R.lifetimeSeconds);
      const built = buildChannelVoucher(R.lane, r.step, R.network);
      expect(built.wire).toEqual(c.expect.wire);
      expect(asVector(built.typedData as never)).toEqual(c.expect.typedData);
      expect(hashTypedData(built.typedData as never)).toBe(c.expect.digest);
      expect(await key.signTypedData(built.typedData as never)).toBe(c.expect.signature);
      // Nothing on the lane moves but renewedIssuedAt.
      expect(r.book.lanes[0]).toEqual({ ...before.lanes[0], renewedIssuedAt: c.expect.renewedIssuedAt });
      expect(parseBook(JSON.parse(JSON.stringify(r.book)))).toEqual(r.book);
    });
  }

  for (const c of R.invalid) {
    it(`refuses ${c.name}`, () => {
      const b = parseBook({ version: 1, lanes: [caseLane(c.lane)] });
      expect(() => renewLane(b, R.lane.channelId, BigInt(c.cumulative), c.calls, 1786007200, 240)).toThrow(
        ChannelBookError,
      );
      expect(renewTarget(b, { ...pool(), cumulative: BigInt(c.cumulative), calls: c.calls })).toBeNull();
    });
  }

  it("only the lane the debt names: another or a malformed channelId, payer, key or escrow is no target", () => {
    const b = parseBook({ version: 1, lanes: [R.lane] });
    const ok = { ...pool(), cumulative: 250_000n, calls: 2 };
    expect(renewTarget(b, ok)?.channelId).toBe(R.lane.channelId);
    for (const bad of [
      { channelId: `0x${"ab".repeat(32)}` },
      { channelId: R.lane.channelId.toUpperCase() },
      { payer: "0x1111111111111111111111111111111111111111" },
      { signer: "0x2222222222222222222222222222222222222222" },
      { escrow: "0x3333333333333333333333333333333333333333" },
      { network: "eip155:1" },
    ])
      expect(renewTarget(b, { ...ok, ...bad } as never)).toBeNull();
  });

  it("a refused pair leaves the renewable set; served and unknown keep it; a re-signed reuse comes back", () => {
    const p = {
      network: "eip155:31337",
      escrow: R.lane.escrow,
      payer: R.lane.payer,
      signer: R.lane.signer,
      provider: R.lane.provider,
    };
    const take = (book: ChannelBook, now: number) => {
      const pick = pickLane(book, p, 100_000n, {
        maxLanes: 1,
        rotateAt: 10n ** 9n,
        nowSeconds: now,
        newChannelId: () => R.lane.channelId,
      });
      if (pick.kind !== "lane") throw new Error("no lane");
      return advanceLane(pick.book, pick.lane.channelId, 100_000n, now, 240, now).book;
    };
    const id = R.lane.channelId;
    let book = finishLane(take(emptyBook(), 1786000000), id, "served");
    book = finishLane(take(book, 1786000001), id, "reuse"); // PAYMENT_UNSETTLED_LIMIT: not stored
    expect(book.lanes[0]!.renewable).toEqual([["100000", 1]]);
    book = finishLane(take(book, 1786000002), id, "served"); // the same pair again, stored now
    expect(book.lanes[0]!.renewable).toEqual([
      ["100000", 1],
      ["200000", 2],
    ]);
    const refused = finishLane(take(book, 1786000003), id, "retire"); // CHANNEL_DESYNC
    expect(refused.lanes[0]!.renewable).toEqual([
      ["100000", 1],
      ["200000", 2],
    ]);
    expect(refused.lanes[0]).toMatchObject({ retired: true, maxSigned: "300000" });
    expect(() => renewLane(refused, id, 300_000n, 3, 1786000100, 240)).toThrow(ChannelBookError);
    const unknown = finishLane(take(book, 1786000003), id, "unknown"); // no answer
    expect(unknown.lanes[0]!.renewable!.at(-1)).toEqual(["300000", 3]);
    expect(unknown.lanes[0]!.retired).toBe(true);
    // Outcomes: no answer is the caller's "unknown"; every coded refusal drops the pair.
    for (const c of ["CHANNEL_ROTATE", "CHANNEL_DESYNC", "PAYMENT_UNSETTLED_LIMIT", "SOMETHING_NEW"])
      expect(["reuse", "retire"]).toContain(laneOutcomeOf(c));
    expect(laneOutcomeOf("PAYMENT_DEBT_OUTSTANDING")).toBe("reuse");
  });

  it("a later voucher on the lane never goes below the renew's issuedAt", () => {
    const live = parseBook({ version: 1, lanes: [{ ...R.lane, retired: false, checkedAt: 1786007000 }] });
    const r = renewLane(live, R.lane.channelId, 250_000n, 2, 1786007200, 240);
    const step = advanceLane(r.book, R.lane.channelId, 50_000n, 1786007100, 240, 1786007100);
    expect(step.issuedAt).toBe(1786007200);
    expect(step.cumulative).toBe(350_000n);
    expect(step.book.lanes[0]!.renewable!.at(-1)).toEqual(["350000", 4]);
  });

  it("parseBook refuses a damaged renewable list; an old 'pairs' field is not trusted", () => {
    const bad = [
      [
        ["300000", 3],
        ["250000", 2],
      ],
      [["400000", 4]],
      [["250000", 4]],
      [[250000, 2]],
      Array.from({ length: LANE_PAIRS_KEPT + 1 }, (_, i) => [String(i + 1), i + 1]),
    ];
    for (const renewable of bad)
      expect(() => parseBook({ version: 1, lanes: [{ ...R.lane, renewable }] })).toThrow(/channel record/);
    const old = caseLane({ renewable: null, pairs: R.lane.renewable, retired: false });
    const lane0 = parseBook({ version: 1, lanes: [old] }).lanes[0]!;
    expect(lane0).not.toHaveProperty("renewable");
    expect(lane0).not.toHaveProperty("pairs");
  });

  it("keeps the last LANE_PAIRS_KEPT renewable pairs", () => {
    const p = {
      network: "eip155:31337",
      escrow: R.lane.escrow,
      payer: R.lane.payer,
      signer: R.lane.signer,
      provider: R.lane.provider,
    };
    let book = emptyBook();
    for (let i = 0; i < LANE_PAIRS_KEPT + 5; i++) {
      const pick = pickLane(book, p, 1n, {
        maxLanes: 1,
        rotateAt: 10n ** 9n,
        nowSeconds: 1786000000,
        newChannelId: () => R.lane.channelId,
      });
      if (pick.kind !== "lane") throw new Error("no lane");
      const step = advanceLane(pick.book, pick.lane.channelId, 1n, 1786000000, 240, 1786000000);
      book = finishLane(step.book, pick.lane.channelId, "served");
      book = { version: 1, lanes: book.lanes.map((l) => ({ ...l, checkedAt: 1786000000 })) };
    }
    const pairs = book.lanes[0]!.renewable!;
    expect(pairs).toHaveLength(LANE_PAIRS_KEPT);
    expect(pairs[0]).toEqual(["6", 6]);
    expect(pairs.at(-1)).toEqual([String(LANE_PAIRS_KEPT + 5), LANE_PAIRS_KEPT + 5]);
  });
});

// ---- the orchestration, with fake I/O ------------------------------------------------------------

const PAYER = BASE.chain.payer as Hex;
const PAYER_CAIP = BASE.requirement.payer as string;
const ESCROW = BASE.network.escrow.split(":")[2] as Hex;
const NET = { id: BASE.network.id, chainId: 31337, escrow: ESCROW, asset: BASE.network.asset, decimals: 6 };
const LID = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

function lane(id: number, over: Partial<ChannelLane> = {}): ChannelLane {
  return {
    channelId: LID(id) as Hex,
    network: NET.id,
    escrow: ESCROW,
    payer: PAYER,
    signer: KEY.address,
    provider: BASE.requirement.provider.split(":")[2] as Hex,
    maxSigned: "300000",
    callsSigned: 3,
    topIncrease: "100000",
    lastIssuedAt: 1786000000,
    lastExpiresAt: 1786000240,
    reuseTop: false,
    inFlightSince: null,
    retired: false,
    checkedAt: null,
    renewable: [
      ["100000", 1],
      ["200000", 2],
      ["300000", 3],
    ],
    ...over,
  };
}

const debt = (id: string, over: Record<string, unknown> = {}, channelId: string | null = LID(1)) => ({
  intentId: id,
  payer: PAYER_CAIP,
  amount: BASE.requirement.amount,
  state: "OPEN",
  voucherFormat: "CHANNEL",
  channel: { cumulative: "200000", calls: 2, ...(channelId !== null ? { channelId } : {}) },
  ...over,
});

const ID = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
type Body = Parameters<RenewIo["post"]>[1];

function fakeIo(o: {
  lanes: ChannelLane[];
  debts: () => unknown[];
  post?: (id: string, body: Body) => Awaited<ReturnType<RenewIo["post"]>>;
}) {
  let book: ChannelBook = { version: 1, lanes: o.lanes };
  const posts: { id: string; body: Body }[] = [];
  let signatures = 0;
  const io: RenewIo = {
    listDebts: async () => ({ account: PAYER_CAIP, debts: o.debts() }),
    withBook: async (fn) => {
      const out = fn(parseBook(JSON.parse(JSON.stringify(book))));
      if (out.book !== null) book = out.book;
      return out.value;
    },
    network: (id) => (id === NET.id ? NET : null),
    signer: KEY.address,
    sign: (td) => {
      signatures++;
      return KEY.signTypedData(td as never);
    },
    post: async (id, body) => {
      posts.push({ id, body });
      return o.post?.(id, body) ?? { ok: true };
    },
    nowSeconds: () => 1786007000,
    issuedAt: (n) => n + 3,
  };
  return { io, posts, book: () => book, signatures: () => signatures };
}

describe("renewChannelDebts (core)", () => {
  it("re-signs the debt's exact pair on the lane it names; the lane's totals do not move", async () => {
    const f = fakeIo({ lanes: [lane(1), lane(2)], debts: () => [debt(ID(1))] });
    const out = await renewChannelDebts(f.io);
    expect(out).toEqual([{ intentId: ID(1), status: "renewed", channelId: LID(1), cumulative: "200000", calls: 2 }]);
    expect(f.posts).toHaveLength(1);
    const v = f.posts[0]!.body.channelVoucher;
    expect(v.voucher).toEqual({
      payer: PAYER,
      provider: lane(1).provider,
      channelId: LID(1),
      cumulative: "200000",
      calls: 2,
      issuedAt: 1786007003,
      expiresAt: 1786007243,
    });
    const td = buildChannelVoucher(lane(1), { ...v.voucher, cumulative: 200_000n }, NET).typedData;
    expect(await recoverTypedDataAddress({ ...(td as object), signature: v.signature } as never)).toBe(KEY.address);
    expect(f.book().lanes[0]).toMatchObject({ maxSigned: "300000", callsSigned: 3, renewedIssuedAt: 1786007003 });
  });

  it("a missing channelId is no_lane; another lane, a refused, larger or unsigned pair is not_signed_here", async () => {
    const f0 = fakeIo({ lanes: [lane(1)], debts: () => [debt(ID(1), {}, null)] });
    expect((await renewChannelDebts(f0.io))[0]).toMatchObject({ status: "no_lane" });
    expect(f0.signatures()).toBe(0);
    for (const [l, d] of [
      [lane(1), debt(ID(1), {}, LID(9))],
      [
        lane(1, {
          renewable: [
            ["100000", 1],
            ["300000", 3],
          ],
        }),
        debt(ID(1)),
      ],
      [lane(1), debt(ID(1), { channel: { cumulative: "400000", calls: 4, channelId: LID(1) } })],
      [lane(1), debt(ID(1), { channel: { cumulative: "150000", calls: 2, channelId: LID(1) } })],
      [lane(1, { payer: "0x1111111111111111111111111111111111111111" }), debt(ID(1))],
      [lane(1, { inFlightSince: 1786006990 }), debt(ID(1))],
    ] as const) {
      const f = fakeIo({ lanes: [l as ChannelLane], debts: () => [d] });
      expect((await renewChannelDebts(f.io))[0]).toMatchObject({ status: "not_signed_here" });
      expect(f.signatures()).toBe(0);
      expect(f.posts).toEqual([]);
    }
  });

  it("adversarial list: 20 fake debts sign once, only on the one real lane and pair", async () => {
    const lanes = [1, 2, 3, 4, 5].map((i) => lane(i, i === 1 ? {} : { renewable: [["100000", 1]], retired: true }));
    const fake = [
      ...[2, 3, 4, 5].flatMap((i) => [
        debt(ID(i * 10), {}, LID(i)), // a pair refused on those lanes
        debt(ID(i * 10 + 1), { channel: { cumulative: "300000", calls: 3, channelId: LID(i) } }), // their refused top
      ]),
      ...Array.from({ length: 6 }, (_, i) => debt(ID(100 + i), {}, LID(50 + i))), // lanes it never had
      ...Array.from({ length: 4 }, (_, i) => debt(ID(200 + i), {}, null)), // no lane named
      debt(ID(300), { channel: { cumulative: "100000", calls: 1, channelId: LID(1) } }), // a second debt on lane 1
      debt(ID(1)), // the real one
    ];
    expect(fake).toHaveLength(20);
    const f = fakeIo({ lanes, debts: () => fake });
    const out = await renewChannelDebts(f.io);
    expect(f.signatures()).toBe(1);
    expect(
      f.posts.map((p) => [p.body.channelVoucher.voucher.channelId, p.body.channelVoucher.voucher.cumulative]),
    ).toEqual([[LID(1), "200000"]]);
    expect(out.find((r) => r.intentId === ID(300))).toMatchObject({ status: "rate_limited" });
  });

  it("per-call debts are left to the person; REPLACING ones are pending (and collecting)", async () => {
    const f = fakeIo({
      lanes: [lane(1)],
      debts: () => [debt(ID(1), { voucherFormat: "PER_CALL", channel: null }), debt(ID(2), { state: "REPLACING" })],
    });
    const out = await renewChannelDebts(f.io);
    expect(out.map((r) => r.status).sort()).toEqual(["pending", "per_call"]);
    expect(f.posts).toEqual([]);
    expect(allDebtsCollecting(out)).toBe(false);
    expect(allDebtsCollecting([{ intentId: ID(2), status: "pending" }])).toBe(true);
  });

  it("one renew per lane: lower debts the renew covered show as pending on the next list", async () => {
    let renewed = false;
    const f = fakeIo({
      lanes: [lane(1)],
      debts: () => [
        debt(ID(1), {
          channel: { cumulative: "100000", calls: 1, channelId: LID(1) },
          ...(renewed ? { state: "REPLACING" } : {}),
        }),
        debt(ID(2), { ...(renewed ? { state: "REPLACING" } : {}) }),
      ],
      post: () => {
        renewed = true;
        return { ok: true };
      },
    });
    const out = await renewChannelDebts(f.io);
    expect(f.posts.map((p) => p.body.channelVoucher.voucher.cumulative)).toEqual(["200000"]);
    expect(out).toEqual([
      expect.objectContaining({ intentId: ID(2), status: "renewed" }),
      expect.objectContaining({ intentId: ID(1), status: "pending" }),
    ]);
    expect(allDebtsCollecting(out)).toBe(true);
  });

  it("bounded: a refusal, a rate limit or no answer ends that debt; at most 8 requests per run", async () => {
    const answers: Awaited<ReturnType<RenewIo["post"]>>[] = [
      { ok: false, code: "PAYMENT_UNSETTLED_LIMIT", retryAfterMs: 50_000 },
      { ok: false, code: "CHANNEL_DESYNC" },
      { ok: false, code: null },
    ];
    const lanes = Array.from({ length: 12 }, (_, i) => lane(i + 1));
    const debts = Array.from({ length: 12 }, (_, i) => debt(ID(i + 1), {}, LID(i + 1)));
    for (const a of answers) {
      const f = fakeIo({ lanes, debts: () => debts, post: () => a });
      const out = await renewChannelDebts(f.io);
      expect(f.posts).toHaveLength(8);
      expect(out).toHaveLength(12);
    }
    const f = fakeIo({ lanes: [lane(1)], debts: () => [debt(ID(1))], post: () => answers[0]! });
    expect((await renewChannelDebts(f.io))[0]).toMatchObject({ status: "rate_limited", retryAfterMs: 50_000 });
  });

  it("list only (throttled): nothing is signed, open channel debts are rate_limited", async () => {
    const f = fakeIo({ lanes: [lane(1)], debts: () => [debt(ID(1)), debt(ID(2), { state: "REPLACING" })] });
    const out = await renewChannelDebts(f.io, { renew: false, retryAfterMs: 30_000 });
    expect(f.signatures()).toBe(0);
    expect(out.map((r) => [r.intentId, r.status])).toEqual([
      [ID(2), "pending"],
      [ID(1), "rate_limited"],
    ]);
  });

  it("debt list entries the client cannot read are left out; channelId is lower-cased or null", () => {
    const parsed = parseDebtList({
      debts: [
        debt("not-a-uuid"),
        debt(ID(1), { channel: { cumulative: "01", calls: 1 } }),
        debt(ID(2), { payer: "solana:abc:xyz" }),
        debt(ID(3), { state: "SETTLED" }),
        debt(ID(4), { payer: PAYER_CAIP.toLowerCase() }, LID(255).toUpperCase().replace("0X", "0x")),
        debt(ID(5), {}, "0x1234"),
      ],
    });
    expect(parsed.map((d) => [d.intentId, d.payer, d.channel?.channelId])).toEqual([
      [ID(4), PAYER, LID(255)],
      [ID(5), PAYER, null],
    ]);
  });

  it("R-6: a debt whose payer is not the session's account is another wallet's (any letter case is the same wallet)", () => {
    const other = "eip155:31337:0x976EA74026E726554dB657fA54763abd0C3a0aa9";
    const parsed = parseDebtList({
      account: PAYER_CAIP.toUpperCase().replace("EIP155", "eip155").replace("0X", "0x"),
      debts: [debt(ID(1)), debt(ID(2), { payer: other })],
    });
    expect(parsed.map((d) => d.otherWallet)).toEqual([undefined, true]);
    // Without a readable account nothing is marked (the old answer).
    expect(parseDebtList({ debts: [debt(ID(2), { payer: other })] })[0]!.otherWallet).toBeUndefined();
  });

  it("R-6: another wallet's channel debt is never signed, even on a lane id this client knows", async () => {
    const other = "eip155:31337:0x976EA74026E726554dB657fA54763abd0C3a0aa9";
    const f = fakeIo({ lanes: [lane(1)], debts: () => [debt(ID(1), { payer: other })] });
    const out = await renewChannelDebts(f.io);
    expect(out).toEqual([expect.objectContaining({ intentId: ID(1), status: "other_wallet" })]);
    expect(f.signatures()).toBe(0);
    expect(f.posts).toEqual([]);
  });
});

// ---- the client ----------------------------------------------------------------------------

const CHANNEL_NETWORKS = { [BASE.network.id]: { ...NETWORKS[BASE.network.id]!, channels: true } };

function offer(): Record<string, unknown> {
  const r = BASE.requirement;
  return {
    scheme: "channel-v1",
    network: r.network,
    payer: r.payer,
    provider: r.provider,
    providerId: r.providerId,
    price: { ...r.amount },
    domain: { name: "Assay Settlement", version: "2", chainId: 31337, verifyingContract: ESCROW },
    minLifeSeconds: 60,
    maxLifeSeconds: 300,
    maxOpenChannels: 16,
    signers: ["payer", "delegate"],
    delegate: r.delegate,
  };
}

const DEBT_REFUSAL = toolResult(
  {
    "assay/error": {
      code: "PAYMENT_DEBT_OUTSTANDING",
      message: "This payer owes for 1 served call(s)",
      retryable: false,
      details: { count: 1 },
    },
  },
  { isError: true },
);

/** A server with a debt switch: while `owes`, paid calls are refused before any requirement. */
function server(
  o: { debts?: (lane: string) => unknown[]; post?: (req: Seen) => { status?: number; body: unknown } } = {},
) {
  const store = memoryChannelStore();
  const state = {
    owes: false,
    lane: "",
    debts: o.debts ?? ((l: string) => [debt(ID(1), {}, l)]),
  };
  const mcp = (params: Record<string, unknown>) => {
    if (params.name === "get_tool") return getToolAnswer();
    if (state.owes) return DEBT_REFUSAL;
    const meta = params._meta as Record<string, unknown>;
    const env = meta["assay/channelVoucher"] as { voucher: { channelId: string } } | undefined;
    if (env) state.lane = env.voucher.channelId;
    if (env || meta["assay/voucher"]) return toolResult({ "assay/receipt": { intentId: ID(9) } });
    const r = paymentRequired() as { _meta: Record<string, unknown> };
    if (Array.isArray(meta["assay/paymentSchemes"])) r._meta["assay/channelRequired"] = offer();
    return r;
  };
  const api = (req: Seen) => {
    if (req.method === "GET" && req.url.endsWith("/escrow/debts"))
      return { body: { success: true, data: { account: PAYER_CAIP, debts: state.debts(state.lane) } } };
    if (req.method === "POST" && /\/escrow\/debts\/[0-9a-f-]+\/voucher$/.test(req.url))
      return (
        o.post?.(req) ?? { status: 201, body: { success: true, data: { status: "REPLACING", remainingDebts: 0 } } }
      );
    return undefined;
  };
  return { state, mcp, api, store };
}

function client(
  s: ReturnType<typeof server>,
  o: { limits?: { maxPerCall: string; maxPerDay: string }; channels?: boolean; clock?: { t: number } } = {},
) {
  return fakeClient({
    mcp: s.mcp,
    api: s.api,
    options: {
      networks: CHANNEL_NETWORKS,
      ...(o.channels === false ? {} : { channels: { store: s.store } }),
      ...(o.limits ? { limits: o.limits } : {}),
      ...(o.clock ? { now: () => o.clock!.t } : {}),
    },
  });
}

const posts = (seen: Seen[]) => seen.filter((x) => x.method === "POST" && x.url.includes("/escrow/debts/"));
const lists = (seen: Seen[]) => seen.filter((x) => x.method === "GET" && x.url.endsWith("/escrow/debts"));
const threeCalls = async (c: ReturnType<typeof client>) => {
  for (let i = 0; i < 3; i++) await c.client.tools.call(TOOL, {});
};

describe("client: paidCalls.renewChannelDebts", () => {
  it("renews the exact pair it signed on the lane the debt names, with the payment key", async () => {
    const s = server();
    const c = client(s);
    await threeCalls(c);
    const out = await c.client.paidCalls.renewChannelDebts();
    expect(out).toEqual([
      expect.objectContaining({
        intentId: ID(1),
        status: "renewed",
        cumulative: "200000",
        calls: 2,
        channelId: s.state.lane,
      }),
    ]);
    const [p] = posts(c.seen);
    expect(p!.url).toBe(`https://api.example.test/api/v1/escrow/debts/${ID(1)}/voucher`);
    const body = p!.body as { channelVoucher: { voucher: Record<string, unknown>; signature: Hex } };
    expect(Object.keys(body)).toEqual(["channelVoucher"]);
    expect(body.channelVoucher.voucher).toMatchObject({
      cumulative: "200000",
      calls: 2,
      payer: PAYER,
      channelId: s.state.lane,
    });
    const v = body.channelVoucher.voucher as { issuedAt: number; expiresAt: number };
    expect(v.expiresAt - v.issuedAt).toBe(240);
    expect(Math.abs(v.issuedAt - BASE.nowSeconds)).toBeLessThanOrEqual(1);
    expect(parseBook(await s.store.load()).lanes[0]!.renewable).toEqual([
      ["100000", 1],
      ["200000", 2],
      ["300000", 3],
    ]);
  });

  it("refuses a larger or unsigned pair, a debt naming no lane or another lane", async () => {
    for (const d of [
      (l: string) => [debt(ID(1), { channel: { cumulative: "400000", calls: 4, channelId: l } })],
      (l: string) => [debt(ID(1), { channel: { cumulative: "150000", calls: 2, channelId: l } })],
      () => [debt(ID(1), {}, null)],
      () => [debt(ID(1), {}, LID(7))],
    ]) {
      const s = server({ debts: d });
      const c = client(s);
      await threeCalls(c);
      const before = c.signTypedData.mock.calls.length;
      const [r] = await c.client.paidCalls.renewChannelDebts();
      expect(["not_signed_here", "no_lane"]).toContain(r!.status);
      expect(c.signTypedData.mock.calls.length).toBe(before);
      expect(posts(c.seen)).toEqual([]);
    }
  });

  it("a pair the server refused is never renewed", async () => {
    const s = server({ debts: (l) => [debt(ID(1), { channel: { cumulative: "300000", calls: 3, channelId: l } })] });
    let n = 0;
    const mcp = s.mcp;
    const c = fakeClient({
      mcp: (params: Record<string, unknown>) => {
        const meta = params._meta as Record<string, unknown> | undefined;
        if (meta?.["assay/channelVoucher"] && ++n === 3) {
          mcp(params);
          return toolResult({ "assay/error": { code: "CHANNEL_DESYNC", message: "x" } }, { isError: true });
        }
        return mcp(params);
      },
      api: s.api,
      options: { networks: CHANNEL_NETWORKS, channels: { store: s.store } },
    });
    await c.client.tools.call(TOOL, {});
    await c.client.tools.call(TOOL, {});
    await expect(c.client.tools.call(TOOL, {})).rejects.toMatchObject({ code: "CHANNEL_DESYNC" });
    const before = c.signTypedData.mock.calls.length;
    expect((await c.client.paidCalls.renewChannelDebts())[0]).toMatchObject({ status: "not_signed_here" });
    expect(c.signTypedData.mock.calls.length).toBe(before);
  });

  it("is not a new spend: it works at the daily limit and gives nothing back to it", async () => {
    const s = server();
    const c = client(s, { limits: { maxPerCall: "0.10", maxPerDay: "0.30" } });
    await threeCalls(c);
    expect((await c.client.paidCalls.renewChannelDebts())[0]).toMatchObject({ status: "renewed" });
    await expect(c.client.tools.call(TOOL, {})).rejects.toMatchObject({ code: "G7_PER_DAY" });
  });

  it("manual runs are throttled like the automatic one: within a minute only a list, nothing signed", async () => {
    const code = "PAYMENT_VOUCHER_ADMISSION_PAUSED";
    const s = server({
      post: () => ({ status: 503, body: { success: false, error: { code, message: "x" } } }),
    });
    const c = client(s);
    await threeCalls(c);
    expect((await c.client.paidCalls.renewChannelDebts())[0]).toMatchObject({ status: "refused", code });
    const signed = c.signTypedData.mock.calls.length;
    expect((await c.client.paidCalls.renewChannelDebts())[0]).toMatchObject({ status: "rate_limited" });
    expect(c.signTypedData.mock.calls.length).toBe(signed);
    expect(posts(c.seen)).toHaveLength(1);
  });

  it("needs a signer; without the channels option the default lane file is used", async () => {
    const s = server();
    useFreshHome();
    await expect(client(s, { channels: false }).client.paidCalls.renewChannelDebts()).resolves.toEqual(
      expect.any(Array),
    );
    await expect(
      fakeClient({
        api: s.api,
        signer: false,
        options: { channels: { store: memoryChannelStore() } },
      }).client.paidCalls.renewChannelDebts(),
    ).rejects.toBeInstanceOf(ConfigError);
  });
});

describe("client: a paid call refused for a channel debt", () => {
  it("renews once, says so, does not send the call again; within the minute still says it is being collected", async () => {
    const s = server();
    const c = client(s);
    await threeCalls(c);
    s.state.owes = true;
    const sent = c.calls().length;
    const err = await c.client.tools.call(TOOL, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaymentError);
    expect(err).toMatchObject({
      code: "PAYMENT_DEBT_OUTSTANDING",
      retryable: true,
      message: CHANNEL_DEBT_RENEWED_TEXT,
    });
    expect((err as PaymentError).details?.renewals).toEqual([expect.objectContaining({ status: "renewed" })]);
    expect(c.calls().length).toBe(sent + 1);
    expect(posts(c.seen)).toHaveLength(1);
    // The debt is REPLACING now: the next refusal (within the minute) lists only, and says the same.
    s.state.debts = (l) => [debt(ID(1), { state: "REPLACING" }, l)];
    const again = await c.client.tools.call(TOOL, {}).catch((e: unknown) => e);
    expect(again).toMatchObject({
      code: "PAYMENT_DEBT_OUTSTANDING",
      retryable: true,
      message: CHANNEL_DEBT_RENEWED_TEXT,
    });
    expect(posts(c.seen)).toHaveLength(1);
    expect(lists(c.seen)).toHaveLength(3);
  });

  it("a debt a person settled in the portal (per-call REPLACING): the neutral collecting text", async () => {
    const s = server();
    const c = client(s);
    await threeCalls(c);
    s.state.owes = true;
    s.state.debts = () => [debt(ID(1), { state: "REPLACING", voucherFormat: "PER_CALL", channel: null })];
    const err = await c.client.tools.call(TOOL, {}).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "PAYMENT_DEBT_OUTSTANDING", retryable: true, message: DEBT_COLLECTING_TEXT });
    expect(DEBT_COLLECTING_TEXT).not.toContain("already signed");
    expect(posts(c.seen)).toEqual([]);
  });

  it("the collecting text is neutral whenever a pending debt is per-call", () => {
    const renewed = { intentId: ID(1), status: "renewed" as const, channelId: LID(1), cumulative: "100", calls: 1 };
    const byPerson = { intentId: ID(2), status: "pending" as const, format: "PER_CALL" as const };
    expect(channelDebtAnswer([renewed], WEB)).toEqual({ text: CHANNEL_DEBT_RENEWED_TEXT, retryable: true });
    expect(channelDebtAnswer([renewed, byPerson], WEB)).toEqual({ text: DEBT_COLLECTING_TEXT, retryable: true });
    expect(channelDebtAnswer([byPerson], WEB)).toEqual({ text: DEBT_COLLECTING_TEXT, retryable: true });
  });

  it("a channel debt this client cannot renew: the portal text", async () => {
    const s = server({ debts: () => [debt(ID(1), {}, LID(7))] });
    const c = client(s);
    await threeCalls(c);
    s.state.owes = true;
    const err = await c.client.tools.call(TOOL, {}).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: "PAYMENT_DEBT_OUTSTANDING",
      retryable: false,
      message: channelDebtNoRecordText(WEB),
    });
    expect(posts(c.seen)).toEqual([]);
    // Within the minute (list only): the same text, never the funding page for a per-call debt.
    const again = await c.client.tools.call(TOOL, {}).catch((e: unknown) => e);
    expect(again).toMatchObject({ retryable: false, message: channelDebtNoRecordText(WEB) });
    expect(lists(c.seen)).toHaveLength(2);
  });

  it("only channel debts not renewed just now: retryable, never the funding text; within the minute too", async () => {
    const s = server({
      post: () => ({
        status: 409,
        body: { success: false, error: { code: "PAYMENT_VOUCHER_ESCROW_LIMIT_EXCEEDED", message: "x" } },
      }),
    });
    const c = client(s);
    await threeCalls(c);
    s.state.owes = true;
    for (let i = 0; i < 2; i++) {
      const err = await c.client.tools.call(TOOL, {}).catch((e: unknown) => e);
      expect(err).toMatchObject({
        code: "PAYMENT_DEBT_OUTSTANDING",
        retryable: true,
        message: CHANNEL_DEBT_RETRY_TEXT,
      });
    }
    expect(posts(c.seen)).toHaveLength(1);
  });

  it("R-7c: a renew refused for good (CHANNEL_DESYNC): the portal text, never 'call again'; within the minute too", async () => {
    const s = server({
      post: () => ({ status: 409, body: { success: false, error: { code: "CHANNEL_DESYNC", message: "x" } } }),
    });
    const c = client(s);
    await threeCalls(c);
    s.state.owes = true;
    for (let i = 0; i < 2; i++) {
      const err = await c.client.tools.call(TOOL, {}).catch((e: unknown) => e);
      expect(err).toMatchObject({
        code: "PAYMENT_DEBT_OUTSTANDING",
        retryable: false,
        message: channelDebtNoRecordText(WEB),
      });
    }
    expect(posts(c.seen)).toHaveLength(1);
  });

  it("R-6: another wallet's channel debt of the organization: its own text, nothing signed; never the no-record text", async () => {
    const other = "eip155:31337:0x976EA74026E726554dB657fA54763abd0C3a0aa9";
    const s = server({ debts: (l) => [debt(ID(1), { payer: other }, l)] });
    const c = client(s);
    await threeCalls(c);
    s.state.owes = true;
    for (let i = 0; i < 2; i++) {
      const err = await c.client.tools.call(TOOL, {}).catch((e: unknown) => e);
      expect(err).toMatchObject({
        code: "PAYMENT_DEBT_OUTSTANDING",
        retryable: false,
        message: OTHER_WALLET_DEBT_TEXT,
      });
    }
    expect(posts(c.seen)).toEqual([]);
  });

  it("R-6: the answer is per payer: own unrenewable wins, own retry and another wallet's give the other-wallet text", () => {
    const mine = { intentId: ID(1), status: "not_signed_here" as const };
    const otherW = { intentId: ID(2), status: "other_wallet" as const };
    const retry = { intentId: ID(3), status: "rate_limited" as const };
    const renewed = { intentId: ID(4), status: "renewed" as const };
    expect(channelDebtAnswer([mine, otherW], WEB)).toEqual({ text: channelDebtNoRecordText(WEB), retryable: false });
    expect(channelDebtAnswer([renewed, otherW], WEB)).toEqual({ text: OTHER_WALLET_DEBT_TEXT, retryable: false });
    expect(channelDebtAnswer([retry, otherW], WEB)).toEqual({ text: OTHER_WALLET_DEBT_TEXT, retryable: false });
    expect(channelDebtAnswer([otherW], WEB)!.text).not.toContain("no longer has");
    // A refusal code that passes later keeps the retry text; one that does not, the portal text.
    const refused = (code: string) => ({ intentId: ID(5), status: "refused" as const, code });
    expect(channelDebtAnswer([refused("PAYMENT_DEBT_NOT_YET_REPLACEABLE")], WEB)).toEqual({
      text: CHANNEL_DEBT_RETRY_TEXT,
      retryable: true,
    });
    expect(channelDebtAnswer([refused("PAYMENT_VOUCHER_SIGNATURE_INVALID")], WEB)!.retryable).toBe(false);
  });

  it("within the minute, a debt renewed a moment ago and still listed OPEN is reported as being collected", async () => {
    const s = server();
    const c = client(s);
    await threeCalls(c);
    s.state.owes = true;
    await expect(c.client.tools.call(TOOL, {})).rejects.toMatchObject({ message: CHANNEL_DEBT_RENEWED_TEXT });
    const again = await c.client.tools.call(TOOL, {}).catch((e: unknown) => e);
    expect(again).toMatchObject({ retryable: true, message: CHANNEL_DEBT_RENEWED_TEXT });
    expect((again as PaymentError).details?.renewals).toEqual([expect.objectContaining({ status: "pending" })]);
    expect(posts(c.seen)).toHaveLength(1);
  });

  it("per-call debts keep their behaviour: nothing is signed, the server's refusal is thrown", async () => {
    const s = server({ debts: () => [debt(ID(1), { voucherFormat: "PER_CALL", channel: null })] });
    const c = client(s);
    await c.client.tools.call(TOOL, {});
    s.state.owes = true;
    const before = c.signTypedData.mock.calls.length;
    const err = await c.client.tools.call(TOOL, {}).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: "PAYMENT_DEBT_OUTSTANDING",
      retryable: false,
      message: "This payer owes for 1 served call(s)",
    });
    expect(c.signTypedData.mock.calls.length).toBe(before);
    expect(posts(c.seen)).toEqual([]);
  });

  it("a channel debt next to a per-call one: the channel debt is renewed, the refusal stays the server's", async () => {
    const s = server({ debts: (l) => [debt(ID(1), {}, l), debt(ID(2), { voucherFormat: "PER_CALL", channel: null })] });
    const c = client(s);
    await threeCalls(c);
    s.state.owes = true;
    const err = await c.client.tools.call(TOOL, {}).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "PAYMENT_DEBT_OUTSTANDING", retryable: false });
    expect(posts(c.seen)).toHaveLength(1);
  });

  it("without the channels option a fresh default lane file signs nothing for a debt", async () => {
    const s = server();
    useFreshHome();
    const c = client(s, { channels: false });
    s.state.owes = true;
    await expect(c.client.tools.call(TOOL, {})).rejects.toMatchObject({ code: "PAYMENT_DEBT_OUTSTANDING" });
    expect(posts(c.seen)).toEqual([]);
  });

  it("a renew that fails (no debt list) leaves the server's refusal", async () => {
    const s = server();
    const c = fakeClient({
      mcp: s.mcp,
      api: () => ({ status: 500, body: { success: false, error: { code: "INTERNAL", message: "x" } } }),
      options: { networks: CHANNEL_NETWORKS, channels: { store: memoryChannelStore() } },
    });
    s.state.owes = true;
    await expect(c.client.tools.call(TOOL, {})).rejects.toMatchObject({
      code: "PAYMENT_DEBT_OUTSTANDING",
      retryable: false,
    });
  });
});
