import { keccak_256 } from "@noble/hashes/sha3";

/** A `0x`-prefixed hex string. */
export type Hex = `0x${string}`;
/** A `0x`-prefixed 20-byte address. */
export type Address = `0x${string}`;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const encoder = new TextEncoder();

function toHex(bytes: Uint8Array): Hex {
  let out = "0x";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out as Hex;
}

/** `keccak256` of raw bytes, lower-case hex. */
export function keccak256(bytes: Uint8Array): Hex {
  return toHex(keccak_256(bytes));
}

/** `keccak256` of the UTF-8 bytes of a string, even when it starts with `0x`. */
export function keccakUtf8(text: string): Hex {
  return keccak256(encoder.encode(text));
}

/** The EIP-55 checksummed spelling of a 20-byte hex address (any case in). */
function checksum(address: string): Address {
  const lower = address.slice(2).toLowerCase();
  const hash = keccak_256(encoder.encode(lower));
  let out = "0x";
  for (let i = 0; i < 40; i++) {
    const nibble = (hash[i >> 1]! >> (i % 2 === 0 ? 4 : 0)) & 0xf;
    out += nibble >= 8 ? lower[i]!.toUpperCase() : lower[i]!;
  }
  return out as Address;
}

/** A `0x` address of 40 hex digits, in any case. */
export function isAddress(value: unknown): value is string {
  return typeof value === "string" && ADDRESS.test(value);
}

/** A `0x` address that is already in its EIP-55 spelling. */
export function isChecksummed(value: unknown): value is Address {
  return isAddress(value) && checksum(value) === value;
}

/** The EIP-55 spelling of an address; throws on anything that is not one. */
export function getAddress(value: string): Address {
  if (!isAddress(value)) throw new TypeError("not an address");
  return checksum(value);
}
