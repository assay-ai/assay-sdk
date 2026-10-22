import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  getTypesForEIP712Domain,
  hashDomain,
  hashStruct,
  hashTypedData,
  recoverTypedDataAddress,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import {
  buildVoucher,
  checkAll,
  checkBindingChallenge,
  guardAndBuild,
  RUN,
  SignerRefusal,
  type Eip155NetworkEntry,
  type GuardContext,
  type NetworkEntry,
  type VoucherRequirement,
} from "../src/core/index.js";
import { evmSigner } from "../src/index.js";
import { bindEvmKey } from "../src/schemes/eip155/bind.js";
import type { RestClient } from "../src/rest.js";

const VECTORS_DIR = fileURLToPath(new URL("../../vectors/eip155/", import.meta.url));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const load = (name: string): any => JSON.parse(readFileSync(`${VECTORS_DIR}${name}`, "utf8"));

/** Every file in vectors/eip155/ is run here; a new file fails until it is listed. */
const RUN_FILES = ["binding.json", "guards.json", "seq.json", "vouchers.json"];

type Path = (string | number)[];
interface Change {
  op: string;
  path: Path;
  value?: unknown;
}

function apply<T>(source: T, changes: Change[]): T {
  const copy = structuredClone(source) as Record<string | number, unknown>;
  for (const { op, path, value } of changes) {
    let node = copy;
    for (const key of path.slice(0, -1)) node = node[key] as Record<string | number, unknown>;
    const last = path[path.length - 1]!;
    if (op === "delete") delete node[last];
    else if (op === "set") node[last] = structuredClone(value);
    else throw new Error(`unknown op ${op}`);
  }
  return copy as T;
}

/** The typed data with integers as decimal strings, as the vectors write it. */
function asVector(td: { message: Record<string, unknown> } & Record<string, unknown>) {
  const message = Object.fromEntries(
    Object.entries(td.message).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]),
  );
  return { ...td, message };
}

describe("every vector file is listed", () => {
  it("lists each file in vectors/eip155/", () => {
    const files = readdirSync(VECTORS_DIR)
      .filter((f) => f.endsWith(".json"))
      .sort();
    expect(files).toEqual(RUN_FILES);
  });
});

describe("vouchers.json", () => {
  const v = load("vouchers.json");
  const key = privateKeyToAccount(v.testKey.privateKey as Hex);
  const signer = evmSigner(key);

  for (const c of v.cases) {
    it(c.name, async () => {
      const { wire, typedData } = buildVoucher(
        c.requirement as VoucherRequirement,
        c.issuedAt as number,
        c.network as NetworkEntry,
      );
      expect(wire).toEqual(c.wire);
      expect(asVector(typedData as never)).toEqual(c.typedData);
      expect(
        hashDomain({
          domain: typedData.domain,
          types: { EIP712Domain: getTypesForEIP712Domain({ domain: typedData.domain }) },
        } as Parameters<typeof hashDomain>[0]),
      ).toBe(c.domainSeparator);
      expect(hashStruct({ data: typedData.message, primaryType: "Voucher", types: typedData.types })).toBe(
        c.structHash,
      );
      expect(hashTypedData(typedData)).toBe(c.digest);
      expect(await signer.signTypedData(typedData as never)).toBe(c.signature);
      expect(await recoverTypedDataAddress({ ...typedData, signature: c.signature as Hex })).toBe(v.testKey.address);
    });
  }
});

describe("binding.json", () => {
  const v = load("binding.json");
  const ctx = v.context;
  const chainId = Number(String(ctx.network).split(":")[1]);
  const key = privateKeyToAccount(v.testKey.privateKey as Hex);
  const check = (challenge: unknown) =>
    checkBindingChallenge(challenge, {
      localAddress: ctx.localAddress,
      credentialId: ctx.credentialId,
      chainId,
      nowSeconds: ctx.nowSeconds,
    });

  /** The bind flow with a stub API answering `challenge`, and a spy on the signer. */
  function bindWith(challenge: unknown) {
    const signTypedData = vi.fn((td: never) => key.signTypedData(td));
    const post = vi.fn(async (path: string) =>
      path.endsWith("/challenge")
        ? { data: challenge, date: new Date(ctx.nowSeconds * 1000).toUTCString() }
        : {
            data: { credentialId: ctx.credentialId, status: "ACTIVE", delegate: `${ctx.network}:${key.address}` },
            date: null,
          },
    );
    const run = bindEvmKey({
      signer: { namespace: "eip155", address: key.address, signTypedData },
      chainId,
      credentialId: ctx.credentialId,
      api: { post } as unknown as RestClient,
      now: () => ctx.nowSeconds * 1000,
    });
    return { run, signTypedData, post };
  }

  for (const c of v.valid) {
    it(`valid ${c.name}`, async () => {
      const typedData = check(c.challenge);
      expect(asVector(typedData as never)).toEqual(c.typedData);
      expect(hashTypedData(typedData)).toBe(c.digest);
      const { run, signTypedData } = bindWith(c.challenge);
      await run;
      expect(await signTypedData.mock.results[0]!.value).toBe(c.signature);
    });
  }

  for (const c of v.invalid) {
    it(`invalid ${c.name}: refused naming ${c.field}, nothing signed`, async () => {
      const challenge = apply(v.valid[0].challenge, [{ op: c.op, path: c.path, value: c.value }]);
      expect(() => check(challenge)).toThrow(SignerRefusal);
      try {
        check(challenge);
      } catch (err) {
        expect((err as SignerRefusal).field).toBe(c.field);
      }
      const { run, signTypedData, post } = bindWith(challenge);
      await expect(run).rejects.toThrow();
      expect(signTypedData).not.toHaveBeenCalled();
      expect(post.mock.calls.every(([path]) => path.endsWith("/challenge"))).toBe(true);
    });
  }
});

const guards = load("guards.json");
const base = guards.base as GuardContext;

/** The vector's network as the caller's own table, built leniently so that a bad entry reaches the guards. */
function table(ctx: GuardContext): Map<string, Eip155NetworkEntry> {
  const n = ctx.network as unknown as Record<string, unknown> | null;
  if (n === null || typeof n !== "object" || typeof n.id !== "string") return new Map();
  const escrow = String(n.escrow);
  const entry = {
    id: n.id,
    chainId: Number(n.id.split(":")[1]),
    escrow: escrow.split(":")[2] as Hex,
    escrowCaip10: escrow,
    asset: n.asset as string,
    decimals: n.decimals as number,
    rpc: [],
  };
  return new Map([[n.id, entry]]);
}

/** Through the scheme's guard step (`guardAndBuild`), as a paid call runs it. */
function viaScheme(ctx: GuardContext) {
  const { network: _n, ...rest } = ctx;
  void _n;
  const r = guardAndBuild(rest, ctx.nowSeconds, table(ctx));
  return r.ok ? { ok: true } : { ok: false, guard: r.guard, code: r.code, reason: r.reason };
}

describe("guards.json", () => {
  for (const c of guards.cases) {
    it(`${c.guard} ${c.name}`, () => {
      const ctx = apply(base, c.changes);
      for (const result of [checkAll(ctx), viaScheme(ctx)]) {
        if (c.expect.ok) {
          expect(result).toEqual({ ok: true });
          continue;
        }
        const r = result as { ok: false; guard: string; code: string; reason: string };
        expect({ ok: r.ok, guard: r.guard, code: r.code }).toEqual({
          ok: false,
          guard: c.expect.guard,
          code: c.expect.code,
        });
        if (c.expect.reason !== undefined) expect(r.reason).toBe(c.expect.reason.replace("{run}", RUN));
      }
    });
  }
});

describe("seq.json", () => {
  for (const c of load("seq.json").cases) {
    it(`seq ${c.seq}`, () => {
      const result = viaScheme(apply(base, [{ op: "set", path: ["requirement", "seq"], value: c.seq }]));
      expect(result.ok ? { ok: true } : { ok: false, guard: result.guard, code: result.code }).toEqual(
        c.ok ? { ok: true } : { ok: false, guard: "G9", code: "G9_SEQ" },
      );
    });
  }
});
