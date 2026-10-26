/**
 * The chain reader's agreement and retry rules: one pinned block, every RPC, identical bytes; a
 * transient failure reruns the whole read (3 attempts), a disagreement never does.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChainReader,
  MAX_BLOCK_SPREAD,
  READ_ATTEMPTS,
  RETRY_DELAYS_MS,
  RETRY_WINDOW_MS,
  type ChainNetwork,
} from "../src/core/chain.js";
import { keccakUtf8, type Address } from "../src/core/hex.js";
import { PaymentRefusedError } from "../src/index.js";
import { resetSpendLedger } from "../src/schemes/eip155/index.js";
import { fakeClient, getToolAnswer, paymentRequired, TOOL, toolResult } from "./fake.js";

// Public anvil default accounts (test only).
const PAYER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const DELEGATE = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;
const ESCROW = "0x1eDb0E45747cfEf778bDB4f4418319efc0DD814f" as Address;
const A = "https://rpc-a.example.test/";
const B = "https://rpc-b.example.test/";
const NET: ChainNetwork = { id: "eip155:46630", chainId: 46630, escrow: ESCROW, rpc: [A, B] };

const selector = (signature: string) => keccakUtf8(signature).slice(2, 10);
const word = (n: bigint | number) => BigInt(n).toString(16).padStart(64, "0");
const DELEGATION = `0x${[500_000, 5_000_000, 0, 0, 1_788_591_800, 0, 0].map(word).join("")}`;
const CAPS = `0x${[1_000_000, 10_000_000, 500_000, 5_000_000].map(word).join("")}`;
const ESCROW_VIEW = `0x${[50_000_000, 3, 1, 1_000_000, 10_000_000, 0, 0, 0, 0, 0, 0, 50_000_000].map(word).join("")}`;

interface Rpc {
  height: bigint;
  chainId: number;
  /** The next this many requests answer HTTP 503. */
  failNext: number;
  /** Override of the delegate's per-call cap word (a disagreeing RPC). */
  delegateCap?: bigint;
  calls: { method: string; block?: string }[];
}

const rpcs = new Map<string, Rpc>();
const fresh = (): Rpc => ({ height: 1000n, chainId: 46630, failNext: 0, calls: [] });

function reader() {
  rpcs.set(A, fresh());
  rpcs.set(B, fresh());
  const slept: number[] = [];
  const hooks = { onSleep: () => {} };
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const r = rpcs.get(url)!;
    const msg = JSON.parse(String(init.body)) as { id: number; method: string; params: unknown[] };
    const block = msg.method === "eth_call" ? String(msg.params[1]) : undefined;
    r.calls.push({ method: msg.method, ...(block === undefined ? {} : { block }) });
    if (r.failNext > 0) {
      r.failNext--;
      return new Response("{}", { status: 503 });
    }
    let result: string;
    if (msg.method === "eth_chainId") result = `0x${r.chainId.toString(16)}`;
    else if (msg.method === "eth_blockNumber") result = `0x${r.height.toString(16)}`;
    else {
      const data = String((msg.params[0] as { data: string }).data);
      if (data.startsWith(`0x${selector("escrowOf(address)")}`)) result = ESCROW_VIEW;
      else if (data.startsWith(`0x${selector("effectiveCapsOf(address,address)")}`))
        result =
          r.delegateCap === undefined
            ? CAPS
            : `0x${[1_000_000, 10_000_000, r.delegateCap, 5_000_000].map(word).join("")}`;
      else result = DELEGATION;
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }), { status: 200 });
  };
  const chain = new ChainReader({
    fetch,
    now: () => 1_000_000,
    sleep: async (ms) => {
      slept.push(ms);
      hooks.onSleep();
    },
  });
  return { chain, slept, hooks, a: rpcs.get(A)!, b: rpcs.get(B)! };
}

const rounds = (r: Rpc) => r.calls.filter((c) => c.method === "eth_blockNumber").length;
const blocks = (r: Rpc) => [...new Set(r.calls.filter((c) => c.method === "eth_call").map((c) => c.block))];
const read = (chain: ChainReader) => chain.read(NET, PAYER, DELEGATE);

afterEach(() => vi.restoreAllMocks());

describe("ChainReader", () => {
  it("the limits: 120 blocks, 3 attempts after 300 ms and 1 s, a 5 s window", () => {
    expect(MAX_BLOCK_SPREAD).toBe(120n);
    expect(READ_ATTEMPTS).toBe(3);
    expect(RETRY_DELAYS_MS).toEqual([300, 1000]);
    expect(RETRY_WINDOW_MS).toBe(5000);
  });

  it("agreeing RPCs → the read, at min(heights) - 1", async () => {
    const { chain, a, b, slept } = reader();
    expect(await read(chain)).toMatchObject({
      active: true,
      validUntil: "1788591800",
      delegateMaxVoucherAmount: "500000",
    });
    for (const r of [a, b]) expect(blocks(r)).toEqual([`0x${(999).toString(16)}`]);
    expect(slept).toEqual([]);
  });

  it("RPCs 100 blocks apart still read, at min(heights) - 1", async () => {
    const { chain, a, b } = reader();
    a.height = 1100n;
    expect(await read(chain)).not.toBeNull();
    for (const r of [a, b]) expect(blocks(r)).toEqual([`0x${(999).toString(16)}`]);
  });

  it("RPCs 121 blocks apart → null after every attempt, with no eth_call", async () => {
    const { chain, a, b, slept } = reader();
    a.height = 1121n;
    expect(await read(chain)).toBeNull();
    for (const r of [a, b]) expect(blocks(r)).toEqual([]);
    expect(rounds(a)).toBe(3);
    expect(slept).toEqual([300, 1000]);
  });

  it("heights too far apart on attempt 1 that catch up → a read at the new pinned block", async () => {
    const { chain, a, b, hooks, slept } = reader();
    a.height = 1200n;
    hooks.onSleep = () => {
      b.height = 1150n;
    };
    expect(await read(chain)).not.toBeNull();
    expect(slept).toEqual([300]);
    for (const r of [a, b]) expect(blocks(r)).toEqual([`0x${(1149).toString(16)}`]);
  });

  it("an RPC failing on attempt 1 and answering on attempt 2 → the read", async () => {
    const { chain, a, b, slept } = reader();
    b.failNext = 1;
    expect(await read(chain)).not.toBeNull();
    expect(slept).toEqual([300]);
    expect(rounds(a)).toBe(2);
    expect(rounds(b)).toBe(2);
  });

  it("an RPC failing on every attempt → null after 3 attempts; the failure is not cached", async () => {
    const { chain, a, b, slept } = reader();
    b.failNext = 100;
    expect(await read(chain)).toBeNull();
    expect(slept).toEqual([300, 1000]);
    expect(rounds(a)).toBe(3);
    b.failNext = 0;
    expect(await read(chain)).not.toBeNull();
  });

  it("a disagreement at the pinned block is final: no retry", async () => {
    const { chain, a, b, slept } = reader();
    b.delegateCap = 900_000n;
    expect(await read(chain)).toBeNull();
    for (const r of [a, b]) expect(blocks(r)).toEqual([`0x${(999).toString(16)}`]);
    expect(slept).toEqual([]);
    expect(rounds(a)).toBe(1);
    expect(rounds(b)).toBe(1);
  });

  it("an RPC on another chain is final: no retry", async () => {
    const { chain, b, slept } = reader();
    b.chainId = 1;
    expect(await read(chain)).toBeNull();
    expect(slept).toEqual([]);
  });

  it("no new attempt starts once the retry window has passed", async () => {
    const { chain, b, slept } = reader();
    b.failNext = 100;
    let t = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (t += RETRY_WINDOW_MS));
    expect(await read(chain)).toBeNull();
    expect(slept).toEqual([]);
  });
});

describe("a paid call with no chain read", () => {
  function paidMcp(params: Record<string, unknown>) {
    if (params.name === "get_tool") return getToolAnswer();
    const meta = params._meta as Record<string, unknown>;
    return meta["assay/voucher"] ? toolResult({ "assay/receipt": { intentId: "r" } }) : paymentRequired();
  }

  it("every attempt failing → G4 refused, saying to try again in a minute", async () => {
    resetSpendLedger();
    const { client, sleep, signTypedData } = fakeClient({ mcp: paidMcp, rpc: () => ({ status: 503, body: {} }) });
    const err = (await client.tools.call(TOOL, {}).catch((e: unknown) => e)) as PaymentRefusedError;
    expect(err).toBeInstanceOf(PaymentRefusedError);
    expect({ guard: err.guard, code: err.code }).toEqual({ guard: "G4", code: "G4_NO_CHAIN_READ" });
    expect(err.message).toBe(
      "payment refused before signing: the payment key's grant could not be read from the chain; try again in a minute",
    );
    expect(sleep.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining([300, 1000]));
    expect(signTypedData).not.toHaveBeenCalled();
  });
});
