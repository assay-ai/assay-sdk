import { getAddress, isAddress } from "viem";

const CAIP10 = /^eip155:([1-9][0-9]*):(0x[0-9a-fA-F]{40})$/;
const CAIP19_ERC20 = /^eip155:([1-9][0-9]*)\/erc20:(0x[0-9a-fA-F]{40})$/;

function checksummed(address: string): boolean {
  return isAddress(address, { strict: false }) && getAddress(address) === address;
}

/** A CAIP-10 account on eip155 with a checksummed address, or `null`. */
export function parseCaip10(value: string): { chainId: number; address: string } | null {
  const m = CAIP10.exec(value);
  if (!m || !checksummed(m[2]!)) return null;
  return { chainId: Number(m[1]), address: m[2]! };
}

/** A CAIP-19 erc20 asset on eip155 with a checksummed address, or `null`. */
export function parseCaip19Erc20(value: string): { chainId: number; address: string } | null {
  const m = CAIP19_ERC20.exec(value);
  if (!m || !checksummed(m[2]!)) return null;
  return { chainId: Number(m[1]), address: m[2]! };
}
