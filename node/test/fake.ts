/**
 * A fake transport for the unit tests: one `fetch` that answers the MCP endpoint, the REST API and
 * a chain RPC from the guard vectors' base context. Nothing leaves the process.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { keccak256, toBytes, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { vi } from "vitest";
import { Assay, evmSigner, type AssayOptions } from "../src/index.js";

const DIR = fileURLToPath(new URL("../../vectors/eip155/", import.meta.url));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const load = (name: string): any => JSON.parse(readFileSync(`${DIR}${name}`, "utf8"));

export const GUARDS = load("guards.json");
export const BASE = GUARDS.base;
export const BINDING = load("binding.json");
export const KEY = privateKeyToAccount(load("vouchers.json").testKey.privateKey as Hex);
export const NOW_MS = BASE.nowSeconds * 1000;
export const MCP = "https://mcp.example.test/";
export const API = "https://api.example.test/api/v1";
export const RPC = "https://rpc.example.test/";
export const WEB = "https://app.example.test";
export const TOOL = "weather_forecast";

export const NETWORKS = {
  [BASE.network.id]: {
    escrow: BASE.network.escrow,
    asset: BASE.network.asset,
    decimals: BASE.network.decimals,
    rpcUrls: [RPC],
  },
};

export interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export type Answer = { status?: number; headers?: Record<string, string>; body: unknown };
export type Handler = (req: Seen) => Answer | undefined;

const word = (n: bigint | number) => BigInt(n).toString(16).padStart(64, "0");
const selector = (sig: string) => keccak256(toBytes(sig)).slice(2, 10);

/** The escrow views, answering the base context's grant and caps. */
function rpcAnswer(body: { id: number; method: string; params: unknown[] }): unknown {
  const result = (r: unknown) => ({ jsonrpc: "2.0", id: body.id, result: r });
  if (body.method === "eth_chainId") return result(`0x${Number(BASE.network.id.split(":")[1]).toString(16)}`);
  if (body.method === "eth_blockNumber") return result("0x64");
  const data = String((body.params[0] as { data: string }).data);
  const c = BASE.chain;
  if (data.startsWith(`0x${selector("delegationOf(address,address)")}`)) {
    return result(`0x${[c.delegateMaxVoucherAmount, 10_000_000, 0, 0, c.validUntil, 0, 0].map(word).join("")}`);
  }
  if (data.startsWith(`0x${selector("effectiveCapsOf(address,address)")}`)) {
    return result(`0x${[c.maxVoucherAmount, 10_000_000, c.delegateMaxVoucherAmount, 10_000_000].map(word).join("")}`);
  }
  return result(`0x${[10n ** 9n, 0, 0, c.maxVoucherAmount, 10_000_000, 0, 0, 0, 0, 0, 0, 0].map(word).join("")}`);
}

export const rpcResult = (id: unknown, result: unknown) => ({
  jsonrpc: "2.0",
  id,
  result: { resultType: "complete", ...(result as object) },
});

/** A tool result with `_meta`. */
export const toolResult = (meta: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  content: [{ type: "text", text: "ok" }],
  ...extra,
  _meta: meta,
});

export const paymentRequired = (requirement: unknown = BASE.requirement, fixUrl?: string) =>
  toolResult(
    {
      "assay/error": { code: "PAYMENT_REQUIRED", message: "paid", retryable: true, ...(fixUrl ? { fixUrl } : {}) },
      "x402/paymentRequired": requirement,
    },
    { isError: true },
  );

export const getToolAnswer = () => ({
  content: [{ type: "text", text: "" }],
  structuredContent: { name: TOOL, price: { maxAmount: BASE.quote.maxAmount, asset: BASE.quote.asset } },
});

/**
 * A client on a fake fetch. `mcp` answers each `tools/call` / meta call by its params; `api`
 * answers REST paths. Requests are recorded in `seen`.
 */
export function fakeClient(o: {
  mcp?: (params: Record<string, unknown>, req: Seen) => Answer | unknown;
  api?: Handler;
  options?: Partial<AssayOptions>;
  signer?: boolean;
  /** Pass the vectors' network table as `networks` (default), or use the built-in (empty) table. */
  pinned?: boolean;
}) {
  const seen: Seen[] = [];
  const signTypedData = vi.fn((td: never) => KEY.signTypedData(td));
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const req: Seen = { url, method: String(init.method), headers, body };
    seen.push(req);
    const date = new Date(NOW_MS).toUTCString();
    const respond = (a: Answer) =>
      new Response(JSON.stringify(a.body), {
        status: a.status ?? 200,
        headers: { "content-type": "application/json", date, ...a.headers },
      });
    if (url.startsWith("https://rpc")) return respond({ body: rpcAnswer(body) });
    if (url === MCP) {
      const out = o.mcp?.(body.params, req);
      if (out && typeof out === "object" && "body" in out) return respond(out as Answer);
      return respond({ body: rpcResult(body.id, out ?? {}) });
    }
    const a = o.api?.(req);
    if (a) return respond(a);
    return respond({
      status: 404,
      body: { success: false, error: { code: "NOT_FOUND", message: "no route", statusCode: 404 } },
    });
  });
  const sleep = vi.fn(async (_ms: number) => {});
  const signer = { ...evmSigner(KEY), signTypedData };
  const client = new Assay({
    apiKey: "test-api-key-123",
    mcpUrl: MCP,
    apiUrl: API,
    fetch,
    sleep,
    now: () => NOW_MS,
    webUrl: WEB,
    ...(o.pinned === false ? {} : { networks: NETWORKS }),
    ...(o.signer === false ? {} : { signer }),
    ...o.options,
  });
  const calls = () =>
    seen.filter((s) => s.url === MCP && (s.body as { params: { name: string } }).params.name === TOOL);
  return { client, seen, calls, fetch, sleep, signTypedData };
}
