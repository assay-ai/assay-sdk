import type { Address } from "viem";

/** The binding proof's own EIP-712 domain (spec section 5). Not the escrow's. */
export const DELEGATE_BINDING_DOMAIN_NAME = "GoAssay Agent Binding";
export const DELEGATE_BINDING_DOMAIN_VERSION = "1";

/** The longest challenge life a client accepts: the server's challenge TTL. */
export const MAX_BINDING_CHALLENGE_SECONDS = 300;

/** Exactly these fields, in this order. The order is part of the type hash. */
export const DELEGATE_BINDING_TYPES = {
  DelegateBinding: [
    { name: "delegate", type: "address" },
    { name: "credentialId", type: "string" },
    { name: "nonce", type: "string" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const;

/** What a client signs: rebuilt from its own constants after every challenge field was checked. */
export interface DelegateBindingTypedData {
  domain: { name: string; version: string; chainId: number };
  types: typeof DELEGATE_BINDING_TYPES;
  primaryType: "DelegateBinding";
  message: { delegate: Address; credentialId: string; nonce: string; expiresAt: bigint };
}

/** The typed data for checked values. The field-by-field challenge check lands with the client. */
export function bindingTypedData(
  chainId: number,
  message: DelegateBindingTypedData["message"],
): DelegateBindingTypedData {
  return {
    domain: { name: DELEGATE_BINDING_DOMAIN_NAME, version: DELEGATE_BINDING_DOMAIN_VERSION, chainId },
    types: DELEGATE_BINDING_TYPES,
    primaryType: "DelegateBinding",
    message,
  };
}
