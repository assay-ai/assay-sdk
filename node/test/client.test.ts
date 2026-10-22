import { hashTypedData, recoverTypedDataAddress, type Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import {
  AssayError,
  AuthError,
  ConfigError,
  HumanSessionRequiredError,
  PaymentRefusedError,
  PaymentRequiredError,
  PaymentSchemeUnsupportedError,
  RateLimitError,
  ScopeMissingError,
} from "../src/index.js";
import { buildVoucher } from "../src/core/voucher.js";
import {
  BASE,
  fakeClient,
  getToolAnswer,
  GUARDS,
  KEY,
  MCP,
  paymentRequired,
  TOOL,
  toolResult,
  type Seen,
} from "./fake.js";

const RECEIPT = {
  intentId: "2f1c0b7e-4a3d-4e5f-8a9b-0c1d2e3f4a5b",
  charged: { amount: "100000", asset: BASE.quote.asset, decimals: 6 },
};
const metaOf = (s: Seen) => (s.body as { params: { _meta: Record<string, unknown> } }).params._meta;

/** MCP answers for a paid tool: PAYMENT_REQUIRED without a voucher, the result with one. */
function paidTool(
  after: (params: Record<string, unknown>, n: number) => unknown = () => toolResult({ "assay/receipt": RECEIPT }),
) {
  let paidAttempts = 0;
  return (params: Record<string, unknown>) => {
    if (params.name === "get_tool") return getToolAnswer();
    const meta = params._meta as Record<string, unknown>;
    if (!meta["assay/voucher"]) return paymentRequired();
    return after(params, paidAttempts++);
  };
}

describe("free call", () => {
  it("a free call's receipt has a null intentId (no intent, no receipt to fetch)", async () => {
    const { client } = fakeClient({
      mcp: () =>
        toolResult({ "assay/receipt": { ...RECEIPT, intentId: null, charged: { ...RECEIPT.charged, amount: "0" } } }),
    });
    const r = await client.tools.call("get_weather", {});
    const intentId: string | null = r.receipt?.intentId ?? null;
    expect(intentId).toBeNull();
  });

  it("sends the tool, an idempotency key and the protocol headers; returns the receipt", async () => {
    const { client, seen } = fakeClient({
      signer: false,
      mcp: () =>
        toolResult(
          { "assay/receipt": { ...RECEIPT, charged: { ...RECEIPT.charged, amount: "0" } } },
          { structuredContent: { t: 21 } },
        ),
    });
    const r = await client.tools.call(TOOL, { city: "Lisbon" });
    expect(r.isError).toBe(false);
    expect(r.structuredContent).toEqual({ t: 21 });
    expect(r.receipt?.intentId).toBe(RECEIPT.intentId);
    expect(r.replayed).toBe(false);
    const req = seen[0]!;
    expect(req.url).toBe(MCP);
    expect(req.headers.authorization).toBe("Bearer test-api-key-123");
    expect(req.headers["mcp-protocol-version"]).toBe("2026-07-28");
    expect(req.headers["mcp-method"]).toBe("tools/call");
    expect(req.headers["mcp-name"]).toBe(TOOL);
    const meta = metaOf(req);
    expect(meta["assay/idempotency-key"]).toBe(r.idempotencyKey);
    expect(meta["io.modelcontextprotocol/protocolVersion"]).toBe("2026-07-28");
    expect(meta["assay/voucher"]).toBeUndefined();
  });

  it("uses the caller's idempotency key and returns a provider tool error as a value", async () => {
    const { client, seen } = fakeClient({ mcp: () => toolResult({}, { isError: true }) });
    const r = await client.tools.call(TOOL, {}, { idempotencyKey: "order-42-weather" });
    expect(r.isError).toBe(true);
    expect(metaOf(seen[0]!)["assay/idempotency-key"]).toBe("order-42-weather");
  });

  it("refuses an invalid idempotency key before sending anything", async () => {
    const { client, seen } = fakeClient({ mcp: () => toolResult({}) });
    await expect(client.tools.call(TOOL, {}, { idempotencyKey: "é" })).rejects.toBeInstanceOf(ConfigError);
    expect(seen).toHaveLength(0);
  });
});

describe("paid call", () => {
  it("checks, signs once and retries with the same key and the voucher", async () => {
    const onPayment = vi.fn(() => true);
    const { client, calls, signTypedData } = fakeClient({ mcp: paidTool(), options: { onPayment } });
    const r = await client.tools.call(TOOL, { city: "Lisbon" });
    expect(r.receipt?.intentId).toBe(RECEIPT.intentId);
    expect(signTypedData).toHaveBeenCalledTimes(1);
    const [unsigned, signed] = calls();
    expect(metaOf(unsigned!)["assay/idempotency-key"]).toBe(metaOf(signed!)["assay/idempotency-key"]);
    const envelope = metaOf(signed!)["assay/voucher"] as {
      voucher: { issuedAt: number };
      signature: Hex;
      providerId: string;
      contractVersion: number;
    };
    expect(envelope.providerId).toBe(BASE.requirement.providerId);
    expect(envelope.contractVersion).toBe(3);
    const { typedData } = buildVoucher(BASE.requirement, envelope.voucher.issuedAt, {
      caip2: BASE.network.id,
      escrow: BASE.network.escrow,
      asset: BASE.network.asset,
      decimals: BASE.network.decimals,
    });
    expect(envelope.voucher).toEqual(
      buildVoucher(BASE.requirement, envelope.voucher.issuedAt, {
        caip2: BASE.network.id,
        escrow: BASE.network.escrow,
        asset: BASE.network.asset,
        decimals: 6,
      }).wire,
    );
    expect(await recoverTypedDataAddress({ ...typedData, signature: envelope.signature })).toBe(KEY.address);
    expect(hashTypedData(typedData)).toMatch(/^0x/);
    expect(onPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: TOOL,
        network: BASE.network.id,
        amount: BASE.requirement.amount,
        provider: BASE.requirement.provider,
        idempotencyKey: r.idempotencyKey,
      }),
    );
  });

  it("a network retry of the signed request resends the same envelope and never signs again", async () => {
    const { client, calls, signTypedData, sleep } = fakeClient({
      mcp: paidTool((_p, n) =>
        n === 0
          ? { status: 503, body: { success: false, error: { code: "UNAVAILABLE", message: "down" } } }
          : toolResult({ "assay/receipt": RECEIPT }),
      ),
    });
    const r = await client.tools.call(TOOL, {});
    expect(r.receipt?.intentId).toBe(RECEIPT.intentId);
    expect(signTypedData).toHaveBeenCalledTimes(1);
    const sent = calls();
    expect(sent).toHaveLength(3);
    expect(new Set(sent.map((s) => metaOf(s)["assay/idempotency-key"])).size).toBe(1);
    expect(metaOf(sent[1]!)["assay/voucher"]).toEqual(metaOf(sent[2]!)["assay/voucher"]);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("IDEMPOTENCY_IN_PROGRESS waits retryAfter and resends the same signed request", async () => {
    const inProgress = toolResult(
      { "assay/error": { code: "IDEMPOTENCY_IN_PROGRESS", retryable: true, retryAfter: 2 } },
      { isError: true },
    );
    const { client, calls, signTypedData, sleep } = fakeClient({
      mcp: paidTool((_p, n) => (n === 0 ? inProgress : toolResult({ "assay/receipt": RECEIPT }))),
    });
    await client.tools.call(TOOL, {});
    expect(signTypedData).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(metaOf(calls()[1]!)["assay/voucher"]).toEqual(metaOf(calls()[2]!)["assay/voucher"]);
  });

  it("a server refusal of the signed voucher is thrown, and nothing is signed again", async () => {
    const refused = toolResult(
      { "assay/error": { code: "PAYMENT_VOUCHER_DELEGATE_INACTIVE", message: "revoked" } },
      { isError: true },
    );
    const { client, signTypedData } = fakeClient({ mcp: paidTool(() => refused) });
    await expect(client.tools.call(TOOL, {})).rejects.toMatchObject({
      name: "PaymentError",
      code: "PAYMENT_VOUCHER_DELEGATE_INACTIVE",
    });
    expect(signTypedData).toHaveBeenCalledTimes(1);
  });

  // A free-calls-only key (no `payments` scope): the paid path refuses it with AUTH_SCOPE_MISSING
  // on `assay/error`, naming the scope at the top level, with or without a voucher.
  const noPayments = toolResult(
    { "assay/error": { requiredScope: "payments", code: "AUTH_SCOPE_MISSING", retryable: false } },
    {
      isError: true,
      content: [
        { type: "text", text: "This key does not have the payments scope. Create a key with that scope to use this" },
      ],
    },
  );

  it("a free-calls-only key on a paid tool is ScopeMissingError(payments): nothing signed, not resent", async () => {
    const { client, calls, signTypedData, sleep } = fakeClient({
      mcp: (params) => (params.name === "get_tool" ? getToolAnswer() : noPayments),
    });
    const err = await client.tools.call(TOOL, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScopeMissingError);
    expect((err as ScopeMissingError).requiredScope).toBe("payments");
    expect((err as ScopeMissingError).retryable).toBe(false);
    expect((err as ScopeMissingError).status).toBe(403);
    expect((err as ScopeMissingError).message).toMatch(/payments scope/);
    expect(signTypedData).not.toHaveBeenCalled();
    expect(calls()).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("AUTH_SCOPE_MISSING(payments) on the signed request is thrown; nothing is signed or sent again", async () => {
    const { client, calls, signTypedData, sleep } = fakeClient({ mcp: paidTool(() => noPayments) });
    const err = await client.tools.call(TOOL, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScopeMissingError);
    expect((err as ScopeMissingError).requiredScope).toBe("payments");
    expect((err as ScopeMissingError).idempotencyKey).toBeDefined();
    expect(signTypedData).toHaveBeenCalledTimes(1);
    expect(calls()).toHaveLength(2);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("PAYMENT_REQUIRED without a signer is PaymentRequiredError with the requirement and fixUrl", async () => {
    const { client } = fakeClient({
      signer: false,
      mcp: () => paymentRequired(BASE.requirement, "https://app.example.test/agents/enable-paid?credential=x"),
    });
    const err = await client.tools.call(TOOL, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaymentRequiredError);
    expect((err as PaymentRequiredError).requirement).toEqual(BASE.requirement);
    expect((err as PaymentRequiredError).fixUrl).toContain("enable-paid");
  });

  it("PaymentRequiredError keeps the server's hint, and only that server text", async () => {
    const hint = " Add funds to open it, then call again: https://app.example.test/funding";
    const answer = (h: unknown) => () => {
      const r = paymentRequired(BASE.requirement);
      Object.assign(r._meta["assay/error"] as object, { hint: h, message: "SECRET server text" });
      r.content = [{ type: "text", text: "SECRET server text" }];
      return r;
    };
    const err = (await fakeClient({ signer: false, mcp: answer(hint) })
      .client.tools.call(TOOL, {})
      .catch((e: unknown) => e)) as PaymentRequiredError;
    expect(err).toBeInstanceOf(PaymentRequiredError);
    expect(err.hint).toBe(hint.trim());
    expect(err.message.endsWith(hint.trim())).toBe(true);
    expect(err.message).not.toContain("SECRET");
    for (const bad of [7, "", "a\nb", "x".repeat(501)]) {
      const e = (await fakeClient({ signer: false, mcp: answer(bad) })
        .client.tools.call(TOOL, {})
        .catch((x: unknown) => x)) as PaymentRequiredError;
      expect(e.hint).toBeNull();
    }
  });

  it("a requirement for a network no signer serves is PaymentSchemeUnsupportedError naming it", async () => {
    const network = "solana:placeholder";
    const { client, signTypedData } = fakeClient({ mcp: () => paymentRequired({ ...BASE.requirement, network }) });
    const err = await client.tools.call(TOOL, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaymentSchemeUnsupportedError);
    expect((err as PaymentSchemeUnsupportedError).network).toBe(network);
    expect((err as Error).message).toContain(network);
    expect(signTypedData).not.toHaveBeenCalled();
  });

  it("onPayment returning false refuses: nothing is signed or sent", async () => {
    const { client, calls, signTypedData } = fakeClient({ mcp: paidTool(), options: { onPayment: () => false } });
    const err = await client.tools.call(TOOL, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaymentRefusedError);
    expect((err as PaymentRefusedError).guard).toBe("onPayment");
    expect(signTypedData).not.toHaveBeenCalled();
    expect(calls()).toHaveLength(1);
  });

  /** guards.json cases that change only the requirement and are refused by a guard the client's own context does not decide. */
  const requirementCases = (
    GUARDS.cases as {
      name: string;
      guard: string;
      changes: { path: string[] }[];
      expect: { ok: boolean; guard?: string; code?: string };
    }[]
  ).filter(
    (c) =>
      !c.expect.ok &&
      c.changes.length > 0 &&
      c.changes.every((ch) => ch.path[0] === "requirement" && ch.path.length > 1) &&
      !["G1", "G4"].includes(c.expect.guard!),
  );
  it.each(requirementCases.map((c) => [`${c.expect.code} ${c.name}`, c] as const))(
    "guard refusal from guards.json: %s",
    async (_, c) => {
      const requirement = structuredClone(BASE.requirement);
      for (const ch of c.changes as { op: string; path: string[]; value?: unknown }[]) {
        let node = requirement;
        for (const k of ch.path.slice(1, -1)) node = node[k];
        const last = ch.path[ch.path.length - 1]!;
        if (ch.op === "delete") delete node[last];
        else node[last] = structuredClone(ch.value);
      }
      const { client, signTypedData, calls } = fakeClient({
        mcp: (p) => (p.name === "get_tool" ? getToolAnswer() : paymentRequired(requirement)),
      });
      const err = await client.tools.call(TOOL, {}).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PaymentRefusedError);
      expect({ guard: (err as PaymentRefusedError).guard, code: (err as PaymentRefusedError).code }).toEqual({
        guard: c.expect.guard,
        code: c.expect.code,
      });
      expect(signTypedData).not.toHaveBeenCalled();
      expect(calls()).toHaveLength(1);
    },
  );

  it("the guard refusal list is not empty", () => expect(requirementCases.length).toBeGreaterThan(20));
});

describe("errors", () => {
  const scope = {
    status: 403,
    body: {
      success: false,
      error: {
        code: "AUTH_SCOPE_MISSING",
        message: "This key does not have the tools:call scope.",
        statusCode: 403,
        context: { requiredScope: "tools:call" },
      },
    },
  };

  it("AUTH_SCOPE_MISSING over MCP is ScopeMissingError naming the scope", async () => {
    const { client } = fakeClient({ mcp: () => scope });
    const err = await client.tools.call(TOOL, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScopeMissingError);
    expect((err as ScopeMissingError).requiredScope).toBe("tools:call");
    expect((err as ScopeMissingError).status).toBe(403);
  });

  it("the MCP host's plain HTTP 403 is ScopeMissingError on every MCP method, not retried", async () => {
    const { client, seen } = fakeClient({ mcp: () => scope });
    for (const run of [() => client.tools.search("weather"), () => client.tools.get(TOOL)]) {
      const err = await run().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ScopeMissingError);
      expect((err as ScopeMissingError).requiredScope).toBe("tools:call");
    }
    expect(seen.filter((s) => s.url === MCP)).toHaveLength(2);
  });

  it("AUTH_HUMAN_SESSION_REQUIRED is HumanSessionRequiredError, an AuthError", async () => {
    const { client } = fakeClient({
      api: () => ({
        status: 403,
        body: {
          success: false,
          error: { code: "AUTH_HUMAN_SESSION_REQUIRED", message: "needs a signed-in user", statusCode: 403 },
        },
      }),
    });
    const err = await client.receipts.get(RECEIPT.intentId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HumanSessionRequiredError);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).code).toBe("AUTH_HUMAN_SESSION_REQUIRED");
    expect((err as AuthError).status).toBe(403);
  });

  it("AUTH_SCOPE_MISSING on the API is ScopeMissingError", async () => {
    const { client } = fakeClient({
      api: () => ({
        ...scope,
        body: { ...scope.body, error: { ...scope.body.error, context: { requiredScope: "activity:read" } } },
      }),
    });
    const err = await client.receipts.get(RECEIPT.intentId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScopeMissingError);
    expect((err as ScopeMissingError).requiredScope).toBe("activity:read");
  });

  it("an unknown code still surfaces as AssayError with that code", async () => {
    const { client } = fakeClient({
      mcp: () => toolResult({ "assay/error": { code: "SOMETHING_NEW", message: "new" } }, { isError: true }),
    });
    const err = await client.tools.call(TOOL, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AssayError);
    expect((err as AssayError).constructor).toBe(AssayError);
    expect((err as AssayError).code).toBe("SOMETHING_NEW");
  });

  it("needs an API key", () => {
    const saved = process.env.ASSAY_API_KEY;
    delete process.env.ASSAY_API_KEY;
    try {
      expect(() => fakeClient({ options: { apiKey: "" } })).toThrow(ConfigError);
    } finally {
      if (saved !== undefined) process.env.ASSAY_API_KEY = saved;
    }
  });
});

describe("Retry-After", () => {
  const limited = (headers: Record<string, string>) => ({
    status: 429,
    headers,
    body: { success: false, error: { code: "RATE_LIMITED", message: "slow down" } },
  });

  it("waits the Retry-After seconds, then succeeds", async () => {
    let n = 0;
    const { client, sleep } = fakeClient({ mcp: () => (n++ === 0 ? limited({ "retry-after": "3" }) : toolResult({})) });
    await client.tools.call(TOOL, {});
    expect(sleep).toHaveBeenCalledWith(3000);
  });

  it("honours JSON-RPC -32029 retryAfterMs", async () => {
    let n = 0;
    const { client, sleep } = fakeClient({
      mcp: (_p, req) =>
        n++ === 0
          ? {
              body: {
                jsonrpc: "2.0",
                id: (req.body as { id: number }).id,
                error: { code: -32029, message: "limited", data: { code: "RATE_LIMITED", retryAfterMs: 1500 } },
              },
            }
          : toolResult({}),
    });
    await client.tools.call(TOOL, {});
    expect(sleep).toHaveBeenCalledWith(1500);
  });

  it("after maxRetries it throws RateLimitError with retryAfterMs", async () => {
    const { client, sleep, seen } = fakeClient({ mcp: () => limited({ "retry-after": "1" }) });
    const err = await client.tools.call(TOOL, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfterMs).toBe(1000);
    expect(seen).toHaveLength(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("a wait longer than the cap is not retried", async () => {
    const { client, seen } = fakeClient({ mcp: () => limited({ "retry-after": "3600" }) });
    await expect(client.tools.call(TOOL, {})).rejects.toBeInstanceOf(RateLimitError);
    expect(seen).toHaveLength(1);
  });
});

describe("receipts", () => {
  it("reads one receipt", async () => {
    const { client, seen } = fakeClient({
      api: (req) =>
        req.url.endsWith(`/receipts/${RECEIPT.intentId}`)
          ? { body: { data: { intentId: RECEIPT.intentId, chargedPrice: RECEIPT.charged } } }
          : undefined,
    });
    const r = await client.receipts.get(RECEIPT.intentId);
    expect(r.chargedPrice.amount).toBe("100000");
    expect(seen[0]!.headers.authorization).toBe("Bearer test-api-key-123");
  });
});

describe("secrets", () => {
  it("never shows the API key", () => {
    const lines: unknown[] = [];
    const { client } = fakeClient({
      options: { logger: { debug: (...a) => lines.push(a), warn: (...a) => lines.push(a) } },
    });
    expect(JSON.stringify(client)).not.toContain("test-api-key");
    expect(String(client)).not.toContain("test-api-key");
  });
});
