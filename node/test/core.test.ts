import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  checkAll,
  CODES,
  enablePaidLink,
  GUARD_ORDER,
  GUARD_ORDER_ALL,
  guardAndBuild,
  networkEntriesFrom,
  paidToolOf,
  paymentState,
  prepareCallParams,
  providerIdOf,
  quoteFromGetTool,
  quotesFromList,
  quotesFromSearch,
  serverApprovalLink,
  SignerRefusal,
  withVoucher,
  type Eip155NetworkEntry,
  type GuardContext,
} from "../src/core/index.js";
import { BUILT_IN_NETWORKS } from "../src/networks.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CREDENTIAL_ID = "7b0c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d";

describe("meta helpers", () => {
  it("prepareCallParams strips voucher and rail, keeps or adds the idempotency key, keeps the rest", () => {
    const host = {
      name: "t",
      arguments: { a: 1 },
      _meta: { "assay/voucher": {}, "assay/rail": "A", "assay/idempotency-key": "k1", progressToken: 3 },
    };
    const p = prepareCallParams(host);
    expect(p._meta).toEqual({ "assay/idempotency-key": "k1", progressToken: 3 });
    expect(host._meta["assay/voucher"]).toEqual({}); // input unchanged
    expect((prepareCallParams({ name: "t" })._meta as Record<string, string>)["assay/idempotency-key"]).toMatch(
      UUID_RE,
    );
    // A host key the server would refuse (over 128 characters, control characters, not a string) is replaced.
    for (const bad of ["k".repeat(129), "a\nb", "", 7]) {
      const key = (
        prepareCallParams({ name: "t", _meta: { "assay/idempotency-key": bad } })._meta as Record<string, unknown>
      )["assay/idempotency-key"];
      expect(key).toMatch(UUID_RE);
    }
    const long = prepareCallParams({ name: "t", _meta: { "assay/idempotency-key": "k".repeat(128) } });
    expect((long._meta as Record<string, unknown>)["assay/idempotency-key"]).toBe("k".repeat(128));
  });

  it("prepareCallParams strips every host key in the assay/ and x402/ namespaces, keeps other keys", () => {
    const p = prepareCallParams({
      name: "t",
      _meta: {
        "assay/voucher": {},
        "assay/rail": "A",
        "assay/anything": 1,
        "assay/receipt": {},
        "x402/payment": "0x00",
        "x402/paymentRequired": {},
        "assay/idempotency-key": "k1",
        progressToken: "p1",
        "vendor/x": true,
        "assayx/keep": 2,
        "x402-keep": 3,
      },
    });
    expect(p._meta).toEqual({
      "assay/idempotency-key": "k1",
      progressToken: "p1",
      "vendor/x": true,
      "assayx/keep": 2,
      "x402-keep": 3,
    });
  });

  it("withVoucher adds the voucher and changes nothing else", () => {
    const params = { name: "t", _meta: { "assay/idempotency-key": "k1" } };
    const envelope = { voucher: { seq: "1" }, signature: "0x00", providerId: "p" };
    expect(withVoucher(params, envelope)).toEqual({
      name: "t",
      _meta: { "assay/idempotency-key": "k1", "assay/voucher": envelope },
    });
    expect(params._meta).toEqual({ "assay/idempotency-key": "k1" });
  });

  it("providerIdOf takes 1 to 256 characters", () => {
    expect(providerIdOf({ providerId: "p" })).toBe("p");
    expect(providerIdOf({ providerId: "p".repeat(256) })).toBe("p".repeat(256));
    for (const bad of ["", "p".repeat(257), 7, undefined]) expect(providerIdOf({ providerId: bad })).toBeNull();
  });

  it("payment state", () => {
    expect(paymentState({ _meta: { "assay/error": { code: "PAYMENT_DEBT_OUTSTANDING" } } }).kind).toBe("debt");
    expect(
      paymentState({ _meta: { "assay/error": { code: "PAYMENT_REQUIRED" }, "x402/paymentRequired": { rail: "B" } } })
        .kind,
    ).toBe("payment-required");
    // A requirement under another error code is never paid.
    expect(
      paymentState({ _meta: { "assay/error": { code: "TOOL_NOT_ALLOWED" }, "x402/paymentRequired": { rail: "B" } } })
        .kind,
    ).toBe("error");
    expect(paymentState({ content: [] }).kind).toBe("none");
  });

  it("quotes from tools/list, search_tools and get_tool", () => {
    const price = { amount: "1", maxAmount: "2", asset: "eip155:1/erc20:0x0", display: "$" };
    const quote = { maxAmount: "2", asset: price.asset };
    expect(
      quotesFromList({
        tools: [
          { name: "a", _meta: { "assay/price": price } },
          { name: "b" },
          { name: "bad name", _meta: { "assay/price": price } },
        ],
      }),
    ).toEqual([["a", quote]]);
    expect(
      quotesFromSearch({
        structuredContent: {
          results: [
            { name: "s", assayPrice: price },
            { name: "t", assayPrice: null },
          ],
        },
      }),
    ).toEqual([["s", quote]]);
    expect(quoteFromGetTool({ content: [{ type: "text", text: JSON.stringify({ name: "g", price }) }] })).toEqual([
      "g",
      quote,
    ]);
    expect(quoteFromGetTool({ structuredContent: { name: "g", price: { ...price, maxAmount: "1.5" } } })).toBeNull();
    expect(quoteFromGetTool({ isError: true, structuredContent: { name: "g", price } })).toBeNull();
  });

  it("paidToolOf is the call's name, or call_tool's inner name", () => {
    expect(paidToolOf("weather", {})).toBe("weather");
    expect(paidToolOf("call_tool", { arguments: { name: "acme__get_quote" } })).toBe("acme__get_quote");
    expect(paidToolOf("call_tool", { arguments: { name: "bad name" } })).toBeNull();
    expect(paidToolOf("call_tool", {})).toBeNull();
  });

  it("the enable-paid link is built only from the web origin, a UUID and an address", () => {
    const a = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
    expect(enablePaidLink("http://localhost:4000", CREDENTIAL_ID, a.toLowerCase())).toBe(
      `http://localhost:4000/agents/enable-paid?credential=${CREDENTIAL_ID}#key=${a}`,
    );
    expect(enablePaidLink("http://localhost:4000", "../x", a)).toBeNull();
    expect(enablePaidLink("<WEB from ops config>", CREDENTIAL_ID, a)).toBeNull();
    expect(enablePaidLink("http://localhost:4000", CREDENTIAL_ID, "0x123")).toBeNull();
    expect(enablePaidLink("https://user:pw@portal.goassay.ai", CREDENTIAL_ID, a)).toBeNull();
    expect(enablePaidLink("ftp://portal.goassay.ai", CREDENTIAL_ID, a)).toBeNull();
  });

  it("the enable-paid link keeps the web app's path, without a trailing slash, query or fragment", () => {
    const a = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
    const link = (base: string) => `${base}/agents/enable-paid?credential=${CREDENTIAL_ID}#key=${a}`;
    expect(enablePaidLink("https://host.example/app", CREDENTIAL_ID, a)).toBe(link("https://host.example/app"));
    expect(enablePaidLink("https://host.example/app/", CREDENTIAL_ID, a)).toBe(link("https://host.example/app"));
    expect(enablePaidLink("https://host.example/a/b//", CREDENTIAL_ID, a)).toBe(link("https://host.example/a/b"));
    expect(enablePaidLink("https://host.example/", CREDENTIAL_ID, a)).toBe(link("https://host.example"));
    expect(enablePaidLink("https://host.example/app?x=1#y", CREDENTIAL_ID, a)).toBe(link("https://host.example/app"));
    expect(enablePaidLink("https://host.example/app/../x", CREDENTIAL_ID, a)).toBe(link("https://host.example/x"));
  });

  it("the server approvalUrl is used only on the configured web origin and only for this key", () => {
    const WEB = "https://portal.goassay.ai";
    const KEY = "0x5555555555555555555555555555555555555555";
    const url = (origin: string, key = KEY) => `${origin}/agents/enable-paid?credential=${CREDENTIAL_ID}#key=${key}`;
    expect(serverApprovalLink(WEB, url(WEB), KEY)).toBe(url(WEB));
    expect(serverApprovalLink(WEB, url(WEB, KEY.toLowerCase()), KEY)).toBe(url(WEB, KEY.toLowerCase()));
    expect(serverApprovalLink(WEB, null, KEY)).toBeNull();
    expect(serverApprovalLink(WEB, url("https://portal.goassay.ai.evil.example"), KEY)).toBeNull();
    expect(serverApprovalLink(WEB, url("http://portal.goassay.ai"), KEY)).toBeNull();
    expect(serverApprovalLink(WEB, url("https://app.goassay.ai"), KEY)).toBeNull();
    expect(serverApprovalLink(WEB, url("https://user:pw@portal.goassay.ai"), KEY)).toBeNull();
    expect(serverApprovalLink(WEB, url(WEB, "0x6666666666666666666666666666666666666666"), KEY)).toBeNull();
    expect(serverApprovalLink(WEB, `${WEB}/agents/enable-paid?credential=${CREDENTIAL_ID}`, KEY)).toBeNull();
    expect(serverApprovalLink(WEB, "javascript:alert(1)", KEY)).toBeNull();
    expect(serverApprovalLink(WEB, "not a url", KEY)).toBeNull();
    // The fallback the caller builds itself.
    expect(enablePaidLink(WEB, CREDENTIAL_ID, KEY)).toBe(url(WEB));
  });

  it("CODES is frozen", () => {
    expect(Object.isFrozen(CODES)).toBe(true);
    expect(CODES.PAYMENT_DEBT_OUTSTANDING).toBe("PAYMENT_DEBT_OUTSTANDING");
    expect(Object.keys(CODES)).toHaveLength(8);
  });
});

const guards = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../vectors/eip155/guards.json", import.meta.url)), "utf8"),
) as { base: GuardContext };
const base = guards.base;

function tableOf(ctx: GuardContext): Map<string, Eip155NetworkEntry> {
  const n = ctx.network!;
  const entry = {
    id: n.id,
    chainId: Number(n.id.split(":")[1]),
    escrow: n.escrow.split(":")[2] as `0x${string}`,
    escrowCaip10: n.escrow,
    asset: n.asset,
    decimals: n.decimals,
    rpc: [],
  };
  return new Map([[n.id, entry]]);
}

describe("guard options", () => {
  const { network: _n, ...rest } = base;
  void _n;

  it("orders", () => {
    expect(GUARD_ORDER).not.toContain("G11");
    expect(GUARD_ORDER_ALL).toEqual(["G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8", "G9", "G10", "G11", "G12"]);
  });

  it("G11 runs only with a paid-URL policy", () => {
    const off = {
      paidUrlPolicy: { canonicalUrl: "https://mcp.goassay.ai/c/x", paidUrls: ["https://mcp.goassay.ai/"] },
    };
    expect(checkAll(base)).toEqual({ ok: true });
    expect(checkAll(base, off)).toMatchObject({ ok: false, guard: "G11", code: "G11_URL_NOT_PAID" });
    expect(guardAndBuild(rest, base.nowSeconds, tableOf(base), off)).toMatchObject({ ok: false, guard: "G11" });
  });

  it("payerChangedReason replaces the G4 text", () => {
    const ctx = { ...base, recordedPayer: "0x90F79bf6EB2c4f870365E785982E1f101E93b906" };
    expect(checkAll(ctx, { payerChangedReason: "run x" })).toMatchObject({ code: "G4_PAYER_CHANGED", reason: "run x" });
  });

  it("an issuedAt that is not a positive integer is refused before the guards, or thrown", () => {
    const table = tableOf(base);
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      // Even when a guard would refuse too: the issuedAt check runs first.
      expect(guardAndBuild({ ...rest, quote: null }, bad, table)).toMatchObject({
        ok: false,
        guard: "G1",
        code: "G1_NOT_A_REQUIREMENT",
      });
      expect(() => guardAndBuild(rest, bad, table, { signerRefusal: "throw" })).toThrow(SignerRefusal);
    }
    expect(guardAndBuild(rest, base.nowSeconds, table, { signerRefusal: "throw" }).ok).toBe(true);
  });

  it("a guard refusal is returned, never thrown, with signerRefusal throw", () => {
    expect(
      guardAndBuild({ ...rest, quote: null }, base.nowSeconds, tableOf(base), { signerRefusal: "throw" }),
    ).toMatchObject({
      ok: false,
      guard: "G3",
    });
  });
});

describe("networkEntriesFrom", () => {
  const good = BUILT_IN_NETWORKS["eip155:46630"]!;
  const placeholder = { ...good, chainId: 1, escrow: "eip155:1:<ESCROW>", asset: "eip155:1/erc20:<ASSET>" };

  it("skips the entries the caller names, and builds the rest", () => {
    const table = networkEntriesFrom(
      { "eip155:46630": good, "eip155:1": placeholder, "solana:x": good },
      { skip: (_id, n) => n.escrow.includes("<") },
    );
    expect([...table.keys()]).toEqual(["eip155:46630"]);
    expect(table.get("eip155:46630")!.escrow).toBe("0x2723AD1fEC053Fe05305e4D0c874B0402959Ce18");
  });

  it("an invalid entry it does not skip fails, naming it", () => {
    expect(() => networkEntriesFrom({ "eip155:1": placeholder })).toThrow(/networks\.eip155:1\.escrow/);
  });
});
