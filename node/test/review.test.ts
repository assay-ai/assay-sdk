/** Regression tests for the phase-1 review (I1-I8 and the minor findings fixed with them). */
import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import { beforeEach, describe, expect, it } from "vitest";
import {
  AssayError,
  BUILT_IN_NETWORKS,
  ConfigError,
  DEFAULT_WEB_URL,
  NetworkError,
  PaymentNetworkUnknownError,
  PaymentRefusedError,
  type Eip155Network,
  type PaymentDetails,
} from "../src/index.js";
import { networkTable } from "../src/networks.js";
import { resetSpendLedger } from "../src/schemes/eip155/index.js";
import { VERSION } from "../src/version.js";
import {
  BASE,
  BINDING,
  fakeClient,
  getToolAnswer,
  KEY,
  NETWORKS,
  NOW_MS,
  paymentRequired,
  RPC,
  TOOL,
  toolResult,
  type Seen,
} from "./fake.js";

const RECEIPT = { intentId: "2f1c0b7e-4a3d-4e5f-8a9b-0c1d2e3f4a5b" };
const metaOf = (s: Seen) => (s.body as { params: { _meta: Record<string, unknown> } }).params._meta;

function paidMcp(params: Record<string, unknown>) {
  if (params.name === "get_tool") return getToolAnswer();
  const meta = params._meta as Record<string, unknown>;
  return meta["assay/voucher"] ? toolResult({ "assay/receipt": RECEIPT }) : paymentRequired();
}

beforeEach(() => resetSpendLedger());

describe("I1 one voucher per idempotency key, even for concurrent calls", () => {
  it("a second call with the same key waits for the first and signs nothing", async () => {
    const { client, signTypedData } = fakeClient({ mcp: paidMcp });
    const [a, b] = await Promise.all([
      client.tools.call(TOOL, {}, { idempotencyKey: "order-1" }),
      client.tools.call(TOOL, {}, { idempotencyKey: "order-1" }),
    ]);
    expect(signTypedData).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it("the same key for other arguments while in flight is refused", async () => {
    const { client, signTypedData } = fakeClient({ mcp: paidMcp });
    const results = await Promise.allSettled([
      client.tools.call(TOOL, { a: 1 }, { idempotencyKey: "order-2" }),
      client.tools.call(TOOL, { a: 2 }, { idempotencyKey: "order-2" }),
    ]);
    expect(results[0].status).toBe("fulfilled");
    expect(results[1].status === "rejected" && (results[1].reason as AssayError).code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(signTypedData).toHaveBeenCalledTimes(1);
  });
});

describe("I2 the idempotency key is on every error out of call()", () => {
  it("a network failure on the signed retry carries the key, and retrying with it reuses it", async () => {
    let failSigned = true;
    const { client, fetch, calls } = fakeClient({ mcp: paidMcp });
    const real = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (url: string, init: RequestInit) => {
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      if (failSigned && body?.params?._meta?.["assay/voucher"]) throw new TypeError("fetch failed");
      return real(url, init);
    });
    const err = (await client.tools.call(TOOL, {}).catch((e: unknown) => e)) as NetworkError;
    expect(err).toBeInstanceOf(NetworkError);
    expect(err.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    failSigned = false;
    const r = await client.tools.call(TOOL, {}, { idempotencyKey: err.idempotencyKey! });
    expect(r.idempotencyKey).toBe(err.idempotencyKey);
    expect(new Set(calls().map((s) => metaOf(s)["assay/idempotency-key"]))).toEqual(new Set([err.idempotencyKey]));
  });

  it("a local refusal carries the key too", async () => {
    const { client } = fakeClient({ mcp: paidMcp, options: { onPayment: () => false } });
    const err = (await client.tools.call(TOOL, {}, { idempotencyKey: "k-1" }).catch((e: unknown) => e)) as AssayError;
    expect(err).toBeInstanceOf(PaymentRefusedError);
    expect(err.idempotencyKey).toBe("k-1");
  });
});

describe("I3 the 24 h ledger: a released reservation is really released", () => {
  it("a release after another call reserved still frees its amount", async () => {
    let releaseA: (v: boolean) => void = () => {};
    const gateA = new Promise<boolean>((r) => (releaseA = r));
    let bReserved: () => void = () => {};
    const bSeen = new Promise<void>((r) => (bReserved = r));
    const onPayment = (d: PaymentDetails) => {
      if (d.idempotencyKey === "a") return gateA;
      if (d.idempotencyKey === "b") bReserved();
      return true;
    };
    const { client, signTypedData } = fakeClient({
      mcp: paidMcp,
      options: { onPayment, limits: { maxPerCall: "0.10", maxPerDay: "0.20" } },
    });
    const a = client.tools.call(TOOL, {}, { idempotencyKey: "a" }).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 10));
    const b = client.tools.call(TOOL, {}, { idempotencyKey: "b" });
    await bSeen;
    await b;
    releaseA(false);
    expect(await a).toBeInstanceOf(PaymentRefusedError);
    // A's 0.10 was released: B (0.10) + C (0.10) fit the 0.20 day.
    await client.tools.call(TOOL, {}, { idempotencyKey: "c" });
    expect(signTypedData).toHaveBeenCalledTimes(2);
    const d = (await client.tools
      .call(TOOL, {}, { idempotencyKey: "d" })
      .catch((e: unknown) => e)) as PaymentRefusedError;
    expect(d.code).toBe("G7_PER_DAY");
  });
});

describe("I4 no secret in inspect, toJSON or errors", () => {
  it("client, resources and errors never show the API key or a signature", async () => {
    const { client } = fakeClient({
      mcp: (p) =>
        p.name === "get_tool"
          ? getToolAnswer()
          : (p._meta as Record<string, unknown>)["assay/voucher"]
            ? toolResult({ "assay/error": { code: "PAYMENT_VOUCHER_EXPIRED", message: "late" } }, { isError: true })
            : paymentRequired(),
    });
    const err = await client.tools.call(TOOL, {}).catch((e: unknown) => e);
    const shown = [
      inspect(client, { depth: Infinity, showHidden: true }),
      inspect(client.tools, { depth: Infinity }),
      inspect(client.paidCalls, { depth: Infinity }),
      JSON.stringify(client),
      String(client),
      inspect(err, { depth: Infinity }),
      JSON.stringify(err),
    ].join("\n");
    expect(shown).not.toContain("test-api-key-123");
    expect(shown).not.toMatch(/0x[0-9a-fA-F]{130}/);
  });
});

describe("I5 approval link from webUrl", () => {
  it("defaults to the portal origin", () => {
    expect(DEFAULT_WEB_URL).toBe("https://portal.goassay.ai");
  });

  it("is built on the default web origin when no webUrl is given", async () => {
    const credentialId = BINDING.context.credentialId as string;
    const { client } = fakeClient({
      options: { webUrl: DEFAULT_WEB_URL },
      api: () => ({ body: { data: { credentialId, delegate: null, pendingDelegate: null, paidCalls: null } } }),
    });
    expect((await client.paidCalls.status()).approvalUrl).toBe(
      `https://portal.goassay.ai/agents/enable-paid?credential=${credentialId}#key=${KEY.address}`,
    );
  });
});

describe("networks: pinned in the SDK, never read from the server", () => {
  it("the built-in table is empty until production values are released", () => {
    expect(Object.keys(BUILT_IN_NETWORKS)).toEqual([]);
  });

  it("a paid call on a network not in the table is PaymentNetworkUnknownError; nothing is signed or read", async () => {
    const { client, seen, signTypedData } = fakeClient({ pinned: false, mcp: paidMcp });
    const err = (await client.tools.call(TOOL, {}).catch((e: unknown) => e)) as PaymentNetworkUnknownError;
    expect(err).toBeInstanceOf(PaymentNetworkUnknownError);
    expect(err).toBeInstanceOf(PaymentRefusedError);
    expect(err.network).toBe(BASE.network.id);
    expect(err.code).toBe("G2_NETWORK");
    expect(signTypedData).not.toHaveBeenCalled();
    expect(seen.some((s) => s.url.startsWith("https://rpc"))).toBe(false);
    expect(seen.some((s) => s.url.includes("/networks"))).toBe(false);
  });

  it("bind with no network in the table is PaymentNetworkUnknownError", async () => {
    const ctx = BINDING.context;
    const { client, signTypedData } = fakeClient({
      pinned: false,
      api: () => ({
        body: { data: { credentialId: ctx.credentialId, delegate: null, pendingDelegate: null, paidCalls: null } },
      }),
    });
    await expect(client.paidCalls.bind()).rejects.toBeInstanceOf(PaymentNetworkUnknownError);
    expect(signTypedData).not.toHaveBeenCalled();
  });

  it("rpcUrls replaces a network's RPCs with the caller's own", async () => {
    const mine = "https://rpc-private.example.test/";
    const { client, seen } = fakeClient({ mcp: paidMcp, options: { rpcUrls: { [BASE.network.id]: [mine] } } });
    await client.tools.call(TOOL, {});
    expect(new Set(seen.filter((s) => s.url.startsWith("https://rpc")).map((s) => s.url))).toEqual(new Set([mine]));
    expect(client.networks.get(BASE.network.id)!.rpc).toEqual([mine]);
  });

  it.each([
    ["escrow not checksummed", (n: Record<string, unknown>) => (n.escrow = String(n.escrow).toLowerCase())],
    ["plain-http RPC", (n: Record<string, unknown>) => (n.rpcUrls = ["http://rpc.example.test/"])],
    [
      "asset on another chain",
      (n: Record<string, unknown>) => (n.asset = String(n.asset).replace(/eip155:\d+/, "eip155:1")),
    ],
  ])("an invalid networks option is a ConfigError (%s)", (_, change) => {
    const table = structuredClone(NETWORKS) as Record<string, Record<string, unknown>>;
    change(table[BASE.network.id]!);
    expect(() => fakeClient({ options: { networks: table as never } })).toThrow(ConfigError);
  });

  describe("merge over the built-in table", () => {
    const id = BASE.network.id as string;
    const builtIn = { [id]: { ...(NETWORKS as Record<string, Eip155Network>)[id]!, decimals: 6 } };
    const otherId = "eip155:8453";
    const other = {
      chainId: 8453,
      escrow: "eip155:8453:0xE5c0e5C0e5C0e5C0E5c0E5c0E5C0E5C0E5C0E5C0",
      asset: "eip155:8453/erc20:0xA55E7a55E7A55E7a55e7A55e7a55e7A55e7a55E7",
      decimals: 18,
      rpcUrls: ["http://localhost:8545"],
    };

    it("a new network is added beside the built-in ones (localhost http RPC allowed)", () => {
      const t = networkTable({ [otherId]: other }, undefined, builtIn);
      expect([...t.keys()].sort()).toEqual([id, otherId].sort());
      expect(t.get(otherId)!.rpc).toEqual(["http://localhost:8545"]);
    });

    it("an entry for a built-in network replaces it whole", () => {
      const mine = {
        escrow: other.escrow.replace("8453", id.split(":")[1]!),
        asset: BASE.network.asset,
        decimals: 18,
        rpcUrls: ["https://rpc-mine.example.test/"],
      };
      const t = networkTable({ [id]: mine }, undefined, builtIn);
      const e = t.get(id)!;
      expect([e.escrowCaip10, e.decimals, e.rpc]).toEqual([mine.escrow, 18, mine.rpcUrls]);
    });

    it("rpcUrls replaces only the RPCs", () => {
      const e = networkTable(undefined, { [id]: ["https://rpc-x.example.test/"] }, builtIn).get(id)!;
      expect([e.escrowCaip10, e.rpc]).toEqual([builtIn[id]!.escrow, ["https://rpc-x.example.test/"]]);
    });

    it("a chainId that is not the key's is refused", () => {
      expect(() => networkTable({ [otherId]: { ...other, chainId: 1 } }, undefined, builtIn)).toThrow(ConfigError);
    });
  });

  it("an invalid rpcUrls override is a ConfigError", () => {
    expect(() => fakeClient({ options: { rpcUrls: { [BASE.network.id]: ["http://rpc.example.test/"] } } })).toThrow(
      ConfigError,
    );
  });
});

describe("minor findings", () => {
  it("M1 a key that is not the bound delegate is refused before any chain read", async () => {
    const { client, seen } = fakeClient({
      mcp: (p) => (p.name === "get_tool" ? getToolAnswer() : paymentRequired({ ...BASE.requirement, delegate: null })),
    });
    const err = (await client.tools.call(TOOL, {}).catch((e: unknown) => e)) as PaymentRefusedError;
    expect(err.code).toBe("G5_DELEGATE_MISMATCH");
    expect(err.message).toContain("paidCalls.bind()");
    expect(seen.some((s) => s.url === RPC)).toBe(false);
  });

  it("M4 a redirect an injected fetch followed is refused and not retried", async () => {
    let n = 0;
    const { client } = fakeClient({
      options: {
        fetch: async () => {
          n++;
          const res = new Response("{}", { status: 200 });
          Object.defineProperty(res, "redirected", { value: true });
          return res;
        },
      },
    });
    const err = (await client.tools.call(TOOL, {}).catch((e: unknown) => e)) as NetworkError;
    expect(err.code).toBe("REDIRECT_REFUSED");
    expect(n).toBe(1);
  });

  it("M6 a RATE_LIMITED tool result is retried after retryAfterMs", async () => {
    let n = 0;
    const { client, sleep } = fakeClient({
      mcp: () =>
        n++ === 0
          ? toolResult(
              { "assay/error": { code: "RATE_LIMITED", retryable: true, retryAfterMs: 700 } },
              { isError: true },
            )
          : toolResult({}),
    });
    await client.tools.call(TOOL, {});
    expect(sleep).toHaveBeenCalledWith(700);
  });

  it("M7 an unreadable grant reads as unknown", async () => {
    const ctx = BINDING.context;
    const { client } = fakeClient({
      api: () => ({
        body: {
          data: {
            credentialId: ctx.credentialId,
            delegate: `${ctx.network}:${KEY.address}`,
            pendingDelegate: null,
            paidCalls: null,
            paidCallsUnknown: true,
          },
        },
      }),
    });
    expect((await client.paidCalls.status()).state).toBe("unknown");
  });

  it("M10 bind refuses a malformed signature", async () => {
    const ctx = BINDING.context;
    const { client, seen } = fakeClient({
      options: { signer: { namespace: "eip155", address: KEY.address, signTypedData: () => "0x1234" } },
      api: (req) => {
        if (req.method === "GET")
          return {
            body: { data: { credentialId: ctx.credentialId, delegate: null, pendingDelegate: null, paidCalls: null } },
          };
        return { body: { data: BINDING.valid[0].challenge } };
      },
    });
    await expect(client.paidCalls.bind()).rejects.toMatchObject({ code: "SIGNER_FAILED" });
    expect(seen.filter((s) => s.method === "POST")).toHaveLength(1);
  });

  it("M11 VERSION matches package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });

  it("the clock used by the tests is the vectors' clock", () => expect(NOW_MS).toBe(BASE.nowSeconds * 1000));
});
