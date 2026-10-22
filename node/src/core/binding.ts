import { SignerRefusal } from "./errors.js";
import { getAddress, isAddress, type Address } from "./hex.js";

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

/** The typed data for checked values. */
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

export interface BindingContext {
  /** The client's own payment key address. */
  localAddress: string;
  /** The credential id of the API key. */
  credentialId: string;
  /** The chain id of the network the client is configured for, from its own table. */
  chainId: number;
  /** The corrected clock, Unix seconds (spec section 7). */
  nowSeconds: number;
}

const DOMAIN_KEYS = ["name", "version", "chainId"];
const MESSAGE_KEYS = ["delegate", "credentialId", "nonce", "expiresAt"];
const MAX_UINT64 = 2n ** 64n - 1n;
const MAX_NONCE_LENGTH = 256;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function refuse(field: string, reason: string): never {
  throw new SignerRefusal("the binding challenge", field, reason);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A non-negative integer given as a JSON number or a decimal string. */
function toInteger(value: unknown): bigint | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) return BigInt(value);
  return null;
}

/**
 * Checks the server's `DelegateBinding` challenge (the `data` of the challenge answer) field by
 * field (spec section 5.2) and returns the typed data to sign, rebuilt from the client's own
 * constants. Throws `SignerRefusal` naming the first field that fails.
 */
export function checkBindingChallenge(challenge: unknown, ctx: BindingContext): DelegateBindingTypedData {
  if (!Number.isSafeInteger(ctx.chainId) || ctx.chainId < 1) refuse("context.chainId", "is not a chain id");
  if (!Number.isFinite(ctx.nowSeconds) || ctx.nowSeconds < 0) refuse("context.nowSeconds", "is not a usable time");
  if (!isAddress(ctx.localAddress)) refuse("context.localAddress", "is not an address");
  if (typeof ctx.credentialId !== "string" || ctx.credentialId.length === 0) refuse("context.credentialId", "is empty");
  if (!isRecord(challenge)) refuse("challenge", "is not an object");
  const t = challenge.typedData;
  if (!isRecord(t)) refuse("typedData", "is not an object");

  const domain = t.domain;
  if (!isRecord(domain)) refuse("domain", "is not an object");
  for (const key of Object.keys(domain)) {
    if (!DOMAIN_KEYS.includes(key)) refuse(`domain.${key}`, "must not be present");
  }
  if (domain.name !== DELEGATE_BINDING_DOMAIN_NAME) refuse("domain.name", `must be "${DELEGATE_BINDING_DOMAIN_NAME}"`);
  if (domain.version !== DELEGATE_BINDING_DOMAIN_VERSION) {
    refuse("domain.version", `must be "${DELEGATE_BINDING_DOMAIN_VERSION}"`);
  }
  const chainId = toInteger(domain.chainId);
  if (chainId === null || chainId !== BigInt(ctx.chainId)) refuse("domain.chainId", `must be ${ctx.chainId}`);

  if (t.primaryType !== "DelegateBinding") refuse("primaryType", 'must be "DelegateBinding"');
  const types = t.types;
  if (!isRecord(types)) refuse("types", "is not an object");
  for (const key of Object.keys(types)) {
    if (key !== "DelegateBinding") refuse(`types.${key}`, "must not be present");
  }
  const fields = types.DelegateBinding;
  const expected = DELEGATE_BINDING_TYPES.DelegateBinding;
  const fieldsMatch =
    Array.isArray(fields) &&
    fields.length === expected.length &&
    fields.every(
      (f, i) =>
        isRecord(f) && Object.keys(f).length === 2 && f.name === expected[i]!.name && f.type === expected[i]!.type,
    );
  if (!fieldsMatch) {
    refuse(
      "types.DelegateBinding",
      "must be exactly delegate:address, credentialId:string, nonce:string, expiresAt:uint64",
    );
  }

  const message = t.message;
  if (!isRecord(message)) refuse("message", "is not an object");
  for (const key of Object.keys(message)) {
    if (!MESSAGE_KEYS.includes(key)) refuse(`message.${key}`, "must not be present");
  }
  const delegate = message.delegate;
  if (!isAddress(delegate)) refuse("message.delegate", "is not an address");
  if (getAddress(delegate) !== getAddress(ctx.localAddress)) refuse("message.delegate", "is not the local key");
  if (message.credentialId !== ctx.credentialId) refuse("message.credentialId", "is not this key's credential");
  const nonce = message.nonce;
  if (typeof nonce !== "string" || nonce.length === 0 || nonce.length > MAX_NONCE_LENGTH) {
    refuse("message.nonce", "is not a usable nonce");
  }
  const expiresAt = toInteger(message.expiresAt);
  if (expiresAt === null || expiresAt > MAX_UINT64) refuse("message.expiresAt", "is not a uint64");
  const now = BigInt(Math.floor(ctx.nowSeconds));
  if (expiresAt <= now) refuse("message.expiresAt", "is not in the future");
  if (expiresAt > now + BigInt(MAX_BINDING_CHALLENGE_SECONDS)) {
    refuse("message.expiresAt", `is more than ${MAX_BINDING_CHALLENGE_SECONDS}s away`);
  }
  if (typeof challenge.challengeId !== "string" || !UUID.test(challenge.challengeId)) {
    refuse("challengeId", "is not a UUID");
  }

  return bindingTypedData(ctx.chainId, {
    delegate: getAddress(delegate),
    credentialId: ctx.credentialId,
    nonce,
    expiresAt,
  });
}
