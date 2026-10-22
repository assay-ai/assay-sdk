import { isChecksummed, type Address } from "./hex.js";

const CAIP2_EIP155 = /^eip155:([1-9][0-9]*)$/;
const CAIP10 = /^eip155:([1-9][0-9]*):(0x[0-9a-fA-F]{40})$/;
const CAIP19_ERC20 = /^eip155:([1-9][0-9]*)\/erc20:(0x[0-9a-fA-F]{40})$/;

/** The namespace of a CAIP-2 chain id (`eip155` of `eip155:1`), or `null`. */
export function namespaceOf(caip2: unknown): string | null {
  const m = typeof caip2 === "string" ? /^([-a-z0-9]{3,8}):[-_a-zA-Z0-9]{1,32}$/.exec(caip2) : null;
  return m ? m[1]! : null;
}

/** The chain id of an `eip155:<id>` CAIP-2 chain, or `null`. */
export function eip155ChainId(caip2: unknown): number | null {
  const m = typeof caip2 === "string" ? CAIP2_EIP155.exec(caip2) : null;
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isSafeInteger(id) ? id : null;
}

/** A CAIP-10 account on eip155 with a checksummed address, or `null`. */
export function parseCaip10(value: string): { chainId: number; address: Address } | null {
  const m = CAIP10.exec(value);
  if (!m || !isChecksummed(m[2])) return null;
  return { chainId: Number(m[1]), address: m[2] };
}

/** A CAIP-19 erc20 asset on eip155 with a checksummed address, or `null`. */
export function parseCaip19Erc20(value: string): { chainId: number; address: Address } | null {
  const m = CAIP19_ERC20.exec(value);
  if (!m || !isChecksummed(m[2])) return null;
  return { chainId: Number(m[1]), address: m[2] };
}
