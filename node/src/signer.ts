/**
 * Signers. The SDK never holds, stores or creates a key: the caller passes a signer, and the SDK
 * hands it only typed data the SDK built itself after every local check passed.
 *
 * `Signer` is a tagged union keyed by CAIP-2 namespace, so other chains can be added as new
 * variants without changing the existing ones.
 */

/** EIP-712 typed data, as viem and eth-account take it. Integers may be bigints. */
export interface TypedData {
  domain: Record<string, unknown>;
  types: Record<string, readonly { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

/** An EVM key: any object with an address and an EIP-712 signer (a viem account, a KMS, an HSM). */
export interface EvmSigner {
  readonly namespace: "eip155";
  /** The key's `0x` address. */
  readonly address: string;
  /** Signs EIP-712 typed data; returns the 65-byte `r || s || v` signature as `0x` hex. */
  signTypedData(typedData: TypedData): Promise<string> | string;
}

/** A signer for one CAIP-2 namespace. Only `eip155` exists in this release. */
export type Signer = EvmSigner;

/** The parts of a viem `Account` (`privateKeyToAccount`, `toAccount`) that `evmSigner` uses. */
export interface ViemLikeAccount {
  readonly address: string;
  signTypedData(typedData: never): Promise<string>;
}

/**
 * Wraps a viem account as an {@link EvmSigner}. The returned object has only the address and the
 * signing function: no key, and nothing else of the account, is reachable through it.
 */
export function evmSigner(account: ViemLikeAccount): EvmSigner {
  const address = account.address;
  return Object.freeze({
    namespace: "eip155" as const,
    address,
    signTypedData: (typedData: TypedData) => account.signTypedData(typedData as never),
    toJSON: () => ({ namespace: "eip155", address }),
  });
}

/** The namespace a signer is for, or `null` when it is not a signer. */
export function signerNamespace(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const s = value as Record<string, unknown>;
  return typeof s.namespace === "string" && typeof s.address === "string" && typeof s.signTypedData === "function"
    ? s.namespace
    : null;
}
