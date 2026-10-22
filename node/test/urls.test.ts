/** One client per MCP URL: `mcpUrl` paths, `at()`, `tools.list()`, URL errors and link-token redaction. */
import { inspect } from "node:util";
import { beforeEach, describe, expect, it } from "vitest";
import { Assay, ConfigError, McpUrlNotFoundError, PaymentRefusedError } from "../src/index.js";
import { resolveMcpUrl } from "../src/mcp-url.js";
import { resetSpendLedger } from "../src/schemes/eip155/index.js";
import { BASE, fakeClient, getToolAnswer, MCP, paymentRequired, TOOL, toolResult, type Seen } from "./fake.js";

beforeEach(() => resetSpendLedger());

const ORIGIN = "https://mcp.example.test";
const TOKEN = "abcdefghij_klmnopqrs-tuvwxyz012";
const RECEIPT = { intentId: "2f1c0b7e-4a3d-4e5f-8a9b-0c1d2e3f4a5b", charged: { amount: "100000" } };
const nameOf = (s: Seen) => (s.body as { params: { name?: string } }).params.name;
const methodOf = (s: Seen) => (s.body as { method: string }).method;

/** A paid tool on every URL: PAYMENT_REQUIRED without a voucher, the result with one. */
const paid = (params: Record<string, unknown>) => {
  if (params.name === "get_tool") return getToolAnswer();
  const meta = params._meta as Record<string, unknown>;
  return meta["assay/voucher"] ? toolResult({ "assay/receipt": RECEIPT }) : paymentRequired();
};

describe("mcpUrl shapes", () => {
  const accepted = [
    "/",
    "/my/research",
    "/my/research@2",
    "/my/research/",
    "/@acme/twitter-kit",
    "/@acme/twitter-kit@3",
    "/%40acme/twitter-kit",
    `/u/${TOKEN}`,
    `/u/${TOKEN}@4`,
    "/c/weather",
    "/@acme",
    "/?tools=get_weather",
    "/?tools=get_weather@1,acme__get_quote",
    "/my/research?free=1",
    "/c/weather?category=maps,weather&discovery=full",
    "/?discovery=search&free=0",
    "/My/Research",
    "https://mcp.example.test",
    "https://mcp.example.test/@acme?tools=acme__get_quote",
    "http://localhost:8080/my/research",
  ];
  for (const url of accepted) {
    it(`accepts ${url}`, () => {
      expect(() => resolveMcpUrl("mcpUrl", url, ORIGIN)).not.toThrow();
    });
  }

  const rejected = [
    "",
    "my/research",
    "//evil.example/my/x",
    "/my",
    "/my/x",
    "/my/research@0",
    "/my/research@1234567",
    "/my/a/b",
    "/@ab",
    "/@acme/kit/extra",
    "/u/short",
    "/c/1weather",
    "/t/abc",
    "/docs",
    "/health",
    "/.well-known/oauth",
    "/my/../research",
    "/my//research",
    "/my/%72esearch",
    "/?tool=get_weather",
    "/?tools=Get Weather",
    "/?tools=x",
    "/?free=true",
    "/?discovery=all",
    `/?tools=${Array.from({ length: 51 }, (_, i) => `tool_${i}`).join(",")}`,
    "/my/research#frag",
    "https://mcp.example.test/my/./research",
    `/${"a".repeat(2050)}`,
  ];
  for (const url of rejected) {
    it(`rejects ${url.slice(0, 60)}`, () => {
      expect(() => resolveMcpUrl("mcpUrl", url, ORIGIN)).toThrow(ConfigError);
    });
  }

  it("resolves a path against https://mcp.goassay.ai and checks it at construction", () => {
    const client = new Assay({ apiKey: "k-123", mcpUrl: "/my/research@2" });
    expect(String(client)).toBe("Assay(https://mcp.goassay.ai/my/research@2)");
    expect(() => new Assay({ apiKey: "k-123", mcpUrl: "/my" })).toThrow(ConfigError);
  });

  it("judges another host's URL by its path shape only", () => {
    expect(() => new Assay({ apiKey: "k-123", mcpUrl: "https://mcp.my-deployment.example/c/weather" })).not.toThrow();
    expect(() => new Assay({ apiKey: "k-123", mcpUrl: "https://mcp.my-deployment.example/mcp" })).toThrow(ConfigError);
  });
});

describe("at()", () => {
  it("sends to its own URL; a path resolves against the parent's MCP origin", async () => {
    const { client, seen } = fakeClient({ mcp: () => toolResult({}) });
    const kit = client.at("/@acme/kit@3");
    expect(String(kit)).toBe(`Assay(${ORIGIN}/@acme/kit@3)`);
    await kit.tools.call("acme__get_profile", { user: "x" });
    await client.tools.call("get_weather", {});
    expect(seen.map((s) => [s.url, nameOf(s)])).toEqual([
      [`${ORIGIN}/@acme/kit@3`, "acme__get_profile"],
      [MCP, "get_weather"],
    ]);
  });

  it("refuses a bad path and another origin", () => {
    const { client } = fakeClient({});
    expect(() => client.at("/nope/x")).toThrow(ConfigError);
    expect(() => client.at("https://mcp.goassay.ai/my/research")).toThrow(ConfigError);
    expect(() => client.at(`${ORIGIN}/my/research`)).not.toThrow();
  });

  it("shares the spend ledger and limits with its parent", async () => {
    const { client, signTypedData } = fakeClient({
      mcp: paid,
      options: { limits: { maxPerCall: "0.15", maxPerDay: "0.15" } },
    });
    const kit = client.at("/my/research");
    await client.tools.call(TOOL, {});
    const err = await kit.tools.call(TOOL, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaymentRefusedError);
    expect((err as PaymentRefusedError).code).toBe("G7_PER_DAY");
    expect(signTypedData).toHaveBeenCalledTimes(1);
  });

  it("shares the in-flight calls by idempotency key with its parent", async () => {
    const { client, seen } = fakeClient({ mcp: () => toolResult({}) });
    const kit = client.at("/my/research");
    const [a, b] = await Promise.all([
      client.tools.call("get_weather", { city: "Oslo" }, { idempotencyKey: "same-key" }),
      kit.tools.call("get_weather", { city: "Oslo" }, { idempotencyKey: "same-key" }),
    ]);
    expect(a).toBe(b);
    expect(seen).toHaveLength(1);
    const first = client.tools.call("get_weather", { city: "Oslo" }, { idempotencyKey: "other-key" });
    await expect(kit.tools.call("get_weather", { city: "Rome" }, { idempotencyKey: "other-key" })).rejects.toThrow(
      /in use for another call/,
    );
    await first;
  });

  it("keeps its own quote cache: a quote seen on one URL is not used on another", async () => {
    const { client, seen, signTypedData } = fakeClient({ mcp: paid });
    const kit = client.at("/my/research");
    await client.tools.get(TOOL);
    await client.tools.call(TOOL, {});
    await kit.tools.call(TOOL, {});
    const gets = seen.filter((s) => nameOf(s) === "get_tool").map((s) => s.url);
    expect(gets).toEqual([MCP, `${ORIGIN}/my/research`]);
    expect(signTypedData).toHaveBeenCalledTimes(2);
  });
});

describe("paid call on a tool set URL", () => {
  it("is checked, signed once and sent to that URL (no per-URL paid list)", async () => {
    const { client, seen, signTypedData } = fakeClient({ mcp: paid, options: { mcpUrl: `${ORIGIN}/my/research@2` } });
    const r = await client.tools.call(TOOL, {});
    expect(r.receipt?.intentId).toBe(RECEIPT.intentId);
    expect(signTypedData).toHaveBeenCalledTimes(1);
    const calls = seen.filter((s) => nameOf(s) === TOOL);
    expect(calls.map((s) => s.url)).toEqual([`${ORIGIN}/my/research@2`, `${ORIGIN}/my/research@2`]);
  });
});

describe("tools.list()", () => {
  it("sends tools/list to the client's URL and returns the tools and the list _meta", async () => {
    const meta = { "assay/toolsetVersion": 3, "assay/ignoredTools": ["nope"] };
    const { client, seen } = fakeClient({
      mcp: (_p, req) =>
        methodOf(req) === "tools/list"
          ? {
              tools: [{ name: "acme__get_quote", inputSchema: { type: "object" }, _meta: {} }, { name: "bad name!" }],
              _meta: meta,
            }
          : {},
    });
    const list = await client.at("/@acme/kit").tools.list();
    expect(list.tools.map((t) => t.name)).toEqual(["acme__get_quote"]);
    expect(list.meta).toEqual(meta);
    expect(list.nextCursor).toBeNull();
    expect(seen.map((s) => [s.url, methodOf(s)])).toEqual([[`${ORIGIN}/@acme/kit`, "tools/list"]]);
  });

  it("keeps each tool's assay/price as its quote, so a paid call needs no get_tool", async () => {
    const price = { "assay/price": { maxAmount: BASE.quote.maxAmount, asset: BASE.quote.asset } };
    const { client, seen, signTypedData } = fakeClient({
      mcp: (p, req) => (methodOf(req) === "tools/list" ? { tools: [{ name: TOOL, _meta: price }] } : paid(p)),
    });
    await client.tools.list();
    await client.tools.call(TOOL, {});
    expect(seen.filter((s) => nameOf(s) === "get_tool")).toHaveLength(0);
    expect(signTypedData).toHaveBeenCalledTimes(1);
  });
});

describe("McpUrlNotFoundError", () => {
  it("MCP_URL_NOT_FOUND (a REST 404 from the MCP host) is typed and not retried", async () => {
    const { client, seen } = fakeClient({
      mcp: () => ({
        status: 404,
        body: { success: false, error: { code: "MCP_URL_NOT_FOUND", message: "no such server", statusCode: 404 } },
      }),
    });
    const err = await client
      .at("/my/gone")
      .tools.list()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpUrlNotFoundError);
    expect((err as McpUrlNotFoundError).code).toBe("MCP_URL_NOT_FOUND");
    expect((err as McpUrlNotFoundError).status).toBe(404);
    expect(seen).toHaveLength(1);
  });

  it("a bare 404 from the MCP host is McpUrlNotFoundError too", async () => {
    const { client } = fakeClient({ mcp: () => ({ status: 404, body: "not found" }) });
    await expect(client.tools.call("get_weather", {})).rejects.toBeInstanceOf(McpUrlNotFoundError);
  });
});

describe("link-only tokens", () => {
  it("are shown as /u/… in toString, toJSON, inspect and the debug log", async () => {
    const lines: unknown[] = [];
    const logger = { debug: (...a: unknown[]) => lines.push(a), warn: (...a: unknown[]) => lines.push(a) };
    const { client } = fakeClient({ mcp: () => toolResult({}), options: { logger } });
    const shared = client.at(`/u/${TOKEN}@2?tools=get_weather`);
    await shared.tools.call("get_weather", {});
    const direct = fakeClient({ options: { mcpUrl: `${ORIGIN}/u/${TOKEN}` } }).client;
    for (const c of [shared, direct]) {
      for (const text of [String(c), JSON.stringify(c), inspect(c), `${c}`]) {
        expect(text).not.toContain(TOKEN);
        expect(text).toContain("/u/…");
      }
    }
    expect(String(shared)).toBe(`Assay(${ORIGIN}/u/…@2?tools=get_weather)`);
    expect(lines.length).toBeGreaterThan(0);
    expect(JSON.stringify(lines)).not.toContain(TOKEN);
    expect(JSON.stringify(lines)).toContain("/u/…");
  });

  it("never appear in a ConfigError message", () => {
    const err = (() => {
      try {
        new Assay({ apiKey: "k-123", mcpUrl: `/u/${TOKEN}/extra` });
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err).toBeInstanceOf(ConfigError);
    expect(err?.message).not.toContain(TOKEN);
  });
});
