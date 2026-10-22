import { recoverTypedDataAddress, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  AssayError,
  ConfigError,
  DelegateAlreadyBoundError,
  DelegateBindConflictError,
  PaymentNetworkUnknownError,
  ScopeMissingError,
} from "../src/index.js";
import { checkBindingChallenge } from "../src/core/binding.js";
import { BINDING, fakeClient, KEY, NOW_MS, WEB, type Seen } from "./fake.js";

/** The test chain; the built-in table adds a second eip155 network, so bind() names it. */
const NET = BINDING.context.network;

const ctx = BINDING.context;
const CREDENTIAL = ctx.credentialId as string;
const CAIP10 = `${ctx.network}:${KEY.address}`;
const APPROVAL = `https://app.example.test/agents/enable-paid?credential=${CREDENTIAL}`;

/** The delegate routes of one credential: unbound, then bound and waiting, then active after `activeAfter` reads. */
function delegateApi(activeAfter = 2, approvalUrl: string | null = APPROVAL) {
  let bound = false;
  let readsAfterBind = 0;
  return (req: Seen) => {
    if (req.method === "GET" && req.url.endsWith("/agents/me/delegate")) {
      if (bound) readsAfterBind++;
      const status = bound && readsAfterBind > activeAfter ? "ACTIVE" : "NONE";
      return {
        body: {
          data: {
            credentialId: CREDENTIAL,
            delegate: bound ? CAIP10 : null,
            pendingDelegate: null,
            paidCalls: bound
              ? { status, maxVoucherAmount: "500000", maxPerWindow: "5000000", spentInWindow: "0", validUntil: null }
              : null,
            ...(approvalUrl ? { approvalUrl } : {}),
          },
        },
      };
    }
    if (req.method === "POST" && req.url.endsWith("/agents/me/delegate/challenge"))
      return { body: { data: BINDING.valid[0].challenge } };
    if (req.method === "POST" && req.url.endsWith("/agents/me/delegate")) {
      bound = true;
      return { body: { data: { credentialId: CREDENTIAL, delegate: CAIP10, status: "ACTIVE" } } };
    }
    return undefined;
  };
}

const OTHER = "0x5555555555555555555555555555555555555555";
const OTHER10 = `${ctx.network}:${OTHER}`;

/**
 * A credential with another key bound: binding this key leaves it pending (the old key keeps
 * signing) until the approval lands after `promoteAfter` reads.
 */
function rebindApi(promoteAfter = 2, bindAnswer?: (req: Seen) => { status?: number; body: unknown }) {
  let pending = false;
  let reads = 0;
  return (req: Seen) => {
    if (req.method === "GET" && req.url.endsWith("/agents/me/delegate")) {
      if (pending) reads++;
      const promoted = pending && reads > promoteAfter;
      return {
        body: {
          data: {
            credentialId: CREDENTIAL,
            delegate: promoted ? CAIP10 : OTHER10,
            boundAt: promoted ? "2026-10-22T10:05:00.000Z" : "2026-10-01T00:00:00.000Z",
            pendingDelegate: pending && !promoted ? CAIP10 : null,
            pendingSince: pending && !promoted ? "2026-10-22T10:00:00.000Z" : null,
            paidCalls: {
              status: "ACTIVE",
              maxVoucherAmount: "1",
              maxPerWindow: "2",
              spentInWindow: "0",
              validUntil: null,
            },
            paidCallsUnknown: false,
            approvalUrl: `${APPROVAL}#key=${pending && !promoted ? KEY.address : OTHER}`,
          },
        },
      };
    }
    if (req.method === "POST" && req.url.endsWith("/agents/me/delegate/challenge"))
      return { body: { data: BINDING.valid[0].challenge } };
    if (req.method === "POST" && req.url.endsWith("/agents/me/delegate")) {
      if (bindAnswer) return bindAnswer(req);
      pending = true;
      return {
        status: 201,
        body: {
          data: {
            credentialId: CREDENTIAL,
            status: "PENDING_APPROVAL",
            delegate: OTHER10,
            boundAt: "2026-10-01T00:00:00.000Z",
            pendingDelegate: CAIP10,
            pendingSince: "2026-10-22T10:00:00.000Z",
            approvalUrl: `${APPROVAL}#key=${KEY.address}`,
          },
        },
      };
    }
    return undefined;
  };
}

describe("paidCalls: replacing a bound key", () => {
  it("status: another key is bound", async () => {
    const { client } = fakeClient({ api: rebindApi() });
    const s = await client.paidCalls.status();
    expect(s.state).toBe("bound_to_other_key");
    expect(s.delegate).toBe(OTHER);
    expect(s.boundAt).toBe("2026-10-01T00:00:00.000Z");
    expect(s.pendingDelegate).toBeNull();
    // The server's link names the old key; this client's key replaces it in the fragment.
    expect(s.approvalUrl).toBe(`${APPROVAL}#key=${KEY.address}`);
  });

  it("bind -> PENDING_APPROVAL with the old key still bound -> waitUntilActive once promoted", async () => {
    const { client, signTypedData } = fakeClient({ api: rebindApi() });
    const setup = await client.paidCalls.bind({ network: NET });
    expect(setup.alreadyBound).toBe(false);
    expect(setup.bindStatus).toBe("PENDING_APPROVAL");
    expect(setup.state).toBe("pending_approval");
    expect(setup.delegate).toBe(OTHER);
    expect(setup.pendingDelegate).toBe(KEY.address);
    expect(setup.pendingSince).toBe("2026-10-22T10:00:00.000Z");
    expect(setup.approvalUrl).toBe(`${APPROVAL}#key=${KEY.address}`);
    expect(signTypedData).toHaveBeenCalledTimes(1);

    // The old key's paid calls are ACTIVE, but this key is not the delegate yet: keep waiting.
    const active = await client.paidCalls.waitUntilActive();
    expect(active.state).toBe("active");
    expect(active.delegate).toBe(KEY.address);
    expect(active.pendingDelegate).toBeNull();
  });

  it("bind again while pending is a no-op: nothing is signed", async () => {
    const { client, signTypedData } = fakeClient({ api: rebindApi(1_000) });
    await client.paidCalls.bind({ network: NET });
    const again = await client.paidCalls.bind({ network: NET });
    expect(again.alreadyBound).toBe(true);
    expect(again.bindStatus).toBe("PENDING_APPROVAL");
    expect(signTypedData).toHaveBeenCalledTimes(1);
  });

  it("PENDING_APPROVAL naming another pending key is not accepted", async () => {
    const api = rebindApi(2, () => ({
      body: {
        data: { credentialId: CREDENTIAL, status: "PENDING_APPROVAL", delegate: OTHER10, pendingDelegate: OTHER10 },
      },
    }));
    const { client } = fakeClient({ api });
    await expect(client.paidCalls.bind({ network: NET })).rejects.toMatchObject({ code: "BINDING_NOT_ACCEPTED" });
  });

  it("ACTIVE naming only the old key is not accepted", async () => {
    const api = rebindApi(2, () => ({
      body: { data: { credentialId: CREDENTIAL, status: "ACTIVE", delegate: OTHER10, pendingDelegate: CAIP10 } },
    }));
    const { client } = fakeClient({ api });
    await expect(client.paidCalls.bind({ network: NET })).rejects.toMatchObject({ code: "BINDING_NOT_ACCEPTED" });
  });

  it("409 ACCOUNT_DELEGATE_ALREADY_BOUND is DelegateAlreadyBoundError", async () => {
    const api = rebindApi(2, () => ({
      status: 409,
      body: {
        success: false,
        error: { code: "ACCOUNT_DELEGATE_ALREADY_BOUND", message: "bound to another credential", statusCode: 409 },
      },
    }));
    const { client } = fakeClient({ api });
    const err = await client.paidCalls.bind({ network: NET }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DelegateAlreadyBoundError);
    expect((err as DelegateAlreadyBoundError).code).toBe("ACCOUNT_DELEGATE_ALREADY_BOUND");
    expect((err as DelegateAlreadyBoundError).status).toBe(409);
  });

  it("409 ACCOUNT_DELEGATE_BIND_CONFLICT is DelegateBindConflictError; one more bind() parks the key", async () => {
    const parks = rebindApi(1_000);
    let binds = 0;
    const api = (req: Seen) => {
      if (req.method === "POST" && req.url.endsWith("/agents/me/delegate") && binds++ === 0) {
        return {
          status: 409,
          body: {
            success: false,
            error: { code: "ACCOUNT_DELEGATE_BIND_CONFLICT", message: "bound at the same moment", statusCode: 409 },
          },
        };
      }
      return parks(req);
    };
    const { client, seen, signTypedData } = fakeClient({ api });
    const err = await client.paidCalls.bind({ network: NET }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DelegateBindConflictError);
    expect((err as DelegateBindConflictError).code).toBe("ACCOUNT_DELEGATE_BIND_CONFLICT");
    expect((err as DelegateBindConflictError).status).toBe(409);
    expect((err as DelegateBindConflictError).retryable).toBe(true);
    // Not retried by the SDK: one bind request, one signature.
    expect(seen.filter((s) => s.method === "POST" && s.url.endsWith("/agents/me/delegate"))).toHaveLength(1);
    expect(signTypedData).toHaveBeenCalledTimes(1);

    const again = await client.paidCalls.bind({ network: NET });
    expect(again.alreadyBound).toBe(false);
    expect(again.bindStatus).toBe("PENDING_APPROVAL");
    expect(again.pendingDelegate).toBe(KEY.address);
    expect(seen.filter((s) => s.url.endsWith("/agents/me/delegate/challenge"))).toHaveLength(2);
    expect(signTypedData).toHaveBeenCalledTimes(2);
  });

  it("bind on a network that is not in the table names it and `networks`", async () => {
    const { client, signTypedData } = fakeClient({ api: delegateApi(), pinned: false });
    const err = await client.paidCalls.bind({ network: NET }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaymentNetworkUnknownError);
    expect((err as PaymentNetworkUnknownError).guard).toBe("G2");
    expect((err as PaymentNetworkUnknownError).network).toBe(NET);
    expect((err as PaymentNetworkUnknownError).message).toMatch(/networks/);
    expect(signTypedData).not.toHaveBeenCalled();
  });

  it("bind without the payments scope is ScopeMissingError", async () => {
    const api = (req: Seen) =>
      req.url.endsWith("/agents/me/delegate/challenge")
        ? {
            status: 403,
            body: {
              success: false,
              error: {
                code: "AUTH_SCOPE_MISSING",
                message: "no",
                statusCode: 403,
                context: { requiredScope: "payments" },
              },
            },
          }
        : rebindApi()(req);
    const { client } = fakeClient({ api });
    const err = await client.paidCalls.bind({ network: NET }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScopeMissingError);
    expect((err as ScopeMissingError).requiredScope).toBe("payments");
  });
});

describe("paidCalls", () => {
  it("status: unbound, with the server's approval link and this key's fingerprint", async () => {
    const { client } = fakeClient({ api: delegateApi() });
    const s = await client.paidCalls.status();
    expect(s.state).toBe("unbound");
    expect(s.credentialId).toBe(CREDENTIAL);
    expect(s.fingerprint).toBe(`${KEY.address.slice(-8, -4).toUpperCase()} ${KEY.address.slice(-4).toUpperCase()}`);
    expect(s.approvalUrl).toBe(`${APPROVAL}#key=${KEY.address}`);
  });

  it("bind -> approval link and fingerprint -> waitUntilActive", async () => {
    const { client, seen, signTypedData, sleep } = fakeClient({ api: delegateApi() });
    const setup = await client.paidCalls.bind({ network: NET });
    expect(setup.alreadyBound).toBe(false);
    expect(setup.bindStatus).toBe("ACTIVE");
    expect(setup.state).toBe("pending_approval");
    expect(setup.delegate).toBe(KEY.address);
    expect(setup.approvalUrl).toBe(`${APPROVAL}#key=${KEY.address}`);
    expect(signTypedData).toHaveBeenCalledTimes(1);

    const bindReq = seen.find((s) => s.method === "POST" && s.url.endsWith("/agents/me/delegate"))!;
    const body = bindReq.body as { challengeId: string; signature: Hex };
    expect(body.challengeId).toBe(BINDING.valid[0].challenge.challengeId);
    const typedData = checkBindingChallenge(BINDING.valid[0].challenge, {
      localAddress: KEY.address,
      credentialId: CREDENTIAL,
      chainId: 31337,
      nowSeconds: ctx.nowSeconds,
    });
    expect(await recoverTypedDataAddress({ ...typedData, signature: body.signature })).toBe(KEY.address);
    expect(body.signature).toBe(BINDING.valid[0].signature);

    const active = await client.paidCalls.waitUntilActive();
    expect(active.state).toBe("active");
    expect(active.caps?.maxVoucherAmount).toBe("500000");
    expect(sleep).toHaveBeenCalledWith(5000);
  });

  it("bind is a no-op when the key is already bound: nothing is signed", async () => {
    const api = delegateApi(0);
    const { client, signTypedData } = fakeClient({ api });
    await client.paidCalls.bind({ network: NET });
    const again = await client.paidCalls.bind({ network: NET });
    expect(again.alreadyBound).toBe(true);
    expect(signTypedData).toHaveBeenCalledTimes(1);
  });

  const built = `${WEB}/agents/enable-paid?credential=${CREDENTIAL}#key=${KEY.address}`;

  it("approvalUrl is built from webUrl when the server sends none", async () => {
    const { client } = fakeClient({ api: delegateApi(2, null) });
    expect((await client.paidCalls.bind({ network: NET })).approvalUrl).toBe(built);
  });

  it("a server link for another credential is not used", async () => {
    const { client } = fakeClient({ api: delegateApi(2, `${WEB}/agents/enable-paid?credential=other`) });
    expect((await client.paidCalls.status()).approvalUrl).toBe(built);
  });

  it("a server link on another origin is not used", async () => {
    const link = `https://look-alike.example.test/agents/enable-paid?credential=${CREDENTIAL}`;
    const { client } = fakeClient({ api: delegateApi(2, link) });
    expect((await client.paidCalls.status()).approvalUrl).toBe(built);
  });

  it("waitUntilActive stops at its timeout", async () => {
    let t = NOW_MS;
    let ticking = false;
    const { client } = fakeClient({ api: delegateApi(1_000), options: { now: () => (ticking ? (t += 60_000) : t) } });
    await client.paidCalls.bind({ network: NET });
    ticking = true;
    await expect(client.paidCalls.waitUntilActive({ timeoutMs: 300_000 })).rejects.toMatchObject({
      code: "WAIT_TIMEOUT",
    });
  });

  it("waitUntilActive honours an aborted signal", async () => {
    const { client } = fakeClient({ api: delegateApi(1_000) });
    const err = await client.paidCalls.waitUntilActive({ signal: AbortSignal.abort() }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AssayError);
    expect((err as AssayError).code).toBe("ABORTED");
  });

  it("bind needs a signer", async () => {
    const { client } = fakeClient({ signer: false, api: delegateApi() });
    await expect(client.paidCalls.bind({ network: NET })).rejects.toBeInstanceOf(ConfigError);
  });
});
