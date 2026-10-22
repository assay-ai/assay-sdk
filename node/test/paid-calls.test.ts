import { recoverTypedDataAddress, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { AssayError, ConfigError } from "../src/index.js";
import { checkBindingChallenge } from "../src/core/binding.js";
import { BINDING, fakeClient, KEY, NOW_MS, type Seen } from "./fake.js";

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
    const setup = await client.paidCalls.bind();
    expect(setup.alreadyBound).toBe(false);
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
    await client.paidCalls.bind();
    const again = await client.paidCalls.bind();
    expect(again.alreadyBound).toBe(true);
    expect(signTypedData).toHaveBeenCalledTimes(1);
  });

  it("approvalUrl is null when the server sends none (no web origin is built in)", async () => {
    const { client } = fakeClient({ api: delegateApi(2, null) });
    expect((await client.paidCalls.bind()).approvalUrl).toBeNull();
  });

  it("a link for another credential is not used", async () => {
    const { client } = fakeClient({
      api: delegateApi(2, "https://app.example.test/agents/enable-paid?credential=other"),
    });
    expect((await client.paidCalls.status()).approvalUrl).toBeNull();
  });

  it("waitUntilActive stops at its timeout", async () => {
    let t = NOW_MS;
    let ticking = false;
    const { client } = fakeClient({ api: delegateApi(1_000), options: { now: () => (ticking ? (t += 60_000) : t) } });
    await client.paidCalls.bind();
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
    await expect(client.paidCalls.bind()).rejects.toBeInstanceOf(ConfigError);
  });
});
