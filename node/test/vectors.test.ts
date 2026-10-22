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
import { describe, expect, it } from "vitest";
import { bindingTypedData, buildVoucher, type NetworkEntry, type VoucherRequirement } from "../src/index.js";

const VECTORS_DIR = fileURLToPath(new URL("../../vectors/eip155/", import.meta.url));
const load = (name: string) => JSON.parse(readFileSync(`${VECTORS_DIR}${name}`, "utf8"));

/** Files this test runs, and files a later milestone runs (with the reason). */
const RUN = ["binding.json", "vouchers.json"];
const PENDING: Record<string, string> = {
  "guards.json": "the guards land with the paid-call client",
  "seq.json": "the guards land with the paid-call client",
};

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
    expect(files).toEqual([...RUN, ...Object.keys(PENDING)].sort());
  });
});

describe("vouchers.json", () => {
  const v = load("vouchers.json");
  const key = privateKeyToAccount(v.testKey.privateKey as Hex);

  it("uses the test key", () => {
    expect(key.address).toBe(v.testKey.address);
  });

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
      expect(await key.signTypedData(typedData)).toBe(c.signature);
      expect(await recoverTypedDataAddress({ ...typedData, signature: c.signature as Hex })).toBe(v.testKey.address);
    });
  }
});

describe("binding.json", () => {
  const v = load("binding.json");
  const key = privateKeyToAccount(v.testKey.privateKey as Hex);

  for (const c of v.valid) {
    it(c.name, async () => {
      const m = c.typedData.message;
      const typedData = bindingTypedData(c.typedData.domain.chainId as number, {
        delegate: m.delegate as Hex,
        credentialId: m.credentialId as string,
        nonce: m.nonce as string,
        expiresAt: BigInt(m.expiresAt as string),
      });
      expect(asVector(typedData as never)).toEqual(c.typedData);
      expect(hashTypedData(typedData)).toBe(c.digest);
      expect(await key.signTypedData(typedData)).toBe(c.signature);
      expect(await recoverTypedDataAddress({ ...typedData, signature: c.signature as Hex })).toBe(v.testKey.address);
    });
  }
});
