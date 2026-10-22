import { parseCaip10, parseCaip19Erc20 } from "./caip.js";
import { getAddress, keccakUtf8, type Address, type Hex } from "./hex.js";
import { SignerRefusal } from "./errors.js";

/** The escrow's EIP-712 domain name and version (spec section 6.1). */
export const VOUCHER_DOMAIN_NAME = "Assay Settlement";
export const VOUCHER_DOMAIN_VERSION = "2";

/** The lifetime a client asks for: well inside the server's 300 s ceiling. */
export const VOUCHER_LIFETIME_SECONDS = 240;

/** The eight signed fields. The order is the type hash. */
export const VOUCHER_TYPES = {
  Voucher: [
    { name: "payer", type: "address" },
    { name: "provider", type: "address" },
    { name: "amount", type: "uint64" },
    { name: "resourceHash", type: "bytes32" },
    { name: "requestHash", type: "bytes32" },
    { name: "seq", type: "uint64" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const;

export interface Money {
  amount: string;
  asset: string;
  decimals: number;
}

/** `_meta["x402/paymentRequired"]` on rail B (spec section 4). */
export interface VoucherRequirement {
  rail: "B";
  scheme: "voucher";
  network: string;
  payer: string;
  payTo: string;
  provider: string;
  providerId: string;
  amount: Money;
  contractVersion?: number;
  resource: string;
  requestHash: string;
  seq: string;
  maxTimeoutSeconds: number;
  signers?: string[];
  delegate?: string | null;
}

/** The voucher as it goes on the wire in `_meta["assay/voucher"].voucher` (spec section 6.3). */
export interface WireVoucher {
  payer: string;
  payTo: string;
  provider: string;
  amount: Money;
  resource: string;
  requestHash: string;
  seq: string;
  issuedAt: number;
  expiresAt: number;
}

export interface VoucherTypedData {
  domain: { name: string; version: string; chainId: number; verifyingContract: Address };
  types: typeof VOUCHER_TYPES;
  primaryType: "Voucher";
  message: {
    payer: Address;
    provider: Address;
    amount: bigint;
    resourceHash: Hex;
    requestHash: Hex;
    seq: bigint;
    issuedAt: bigint;
    expiresAt: bigint;
  };
}

/** A network entry of the client's own built-in table. Never taken from the server. */
export interface NetworkEntry {
  /** CAIP-2, `eip155:<chainId>`. */
  caip2: string;
  /** CAIP-10 escrow account. */
  escrow: string;
  /** CAIP-19 erc20 asset. */
  asset: string;
  decimals: number;
}

const MAX_UINT64 = 2n ** 64n - 1n;
const CAIP2 = /^eip155:([1-9][0-9]*)$/;

function refuse(field: string, reason: string): never {
  throw new SignerRefusal("the voucher", field, reason);
}

function uint64(field: string, value: unknown): bigint {
  const ok =
    (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) ||
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
  if (!ok) refuse(field, "is not a non-negative integer");
  const n = BigInt(value as string | number);
  if (n > MAX_UINT64) refuse(field, "does not fit uint64");
  return n;
}

function account(field: string, value: unknown, chainId: number): Address {
  const parsed = typeof value === "string" ? parseCaip10(value) : null;
  if (!parsed) refuse(field, "is not a checksummed CAIP-10 account");
  if (parsed.chainId !== chainId) refuse(field, "is not on the requirement's network");
  return getAddress(parsed.address);
}

/** `sha256:<64 hex>` or bare 64 hex, as 32 bytes. */
function requestHashBytes(value: unknown): Hex {
  const hex = typeof value === "string" ? value.replace(/^sha256:/, "") : "";
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) refuse("requestHash", "is not 32 bytes of hex");
  return `0x${hex.toLowerCase()}`;
}

function resolve(net: NetworkEntry): { chainId: number; escrow: Address } {
  const chain = typeof net?.caip2 === "string" ? CAIP2.exec(net.caip2) : null;
  if (!chain) refuse("network", "is not an eip155 CAIP-2 chain id");
  const chainId = Number(chain[1]);
  const escrow = typeof net.escrow === "string" ? parseCaip10(net.escrow) : null;
  if (!escrow || escrow.chainId !== chainId)
    refuse("network.escrow", "is not a CAIP-10 account on the network's chain");
  const asset = typeof net.asset === "string" ? parseCaip19Erc20(net.asset) : null;
  if (!asset || asset.chainId !== chainId)
    refuse("network.asset", "is not a CAIP-19 erc20 asset on the network's chain");
  if (!Number.isInteger(net.decimals) || net.decimals < 0 || net.decimals > 36)
    refuse("network.decimals", "is invalid");
  return { chainId, escrow: getAddress(escrow.address) };
}

/**
 * Builds the wire voucher and the EIP-712 typed data the payment key signs (spec section 6),
 * from a rail-B requirement, a corrected `issuedAt` and the client's own network entry.
 *
 * - `resourceHash = keccak256(utf8(resource))`; `requestHash` is the requirement's 32 bytes
 *   without `sha256:`;
 * - `expiresAt = issuedAt + min(240, maxTimeoutSeconds)`;
 * - the domain is `{name: "Assay Settlement", version: "2", chainId, verifyingContract}`, from
 *   `net` only.
 *
 * Throws `SignerRefusal` for a requirement on another network, a `payTo` other than the escrow,
 * an amount in another asset or scale, and anything that cannot be encoded.
 */
export function buildVoucher(
  requirement: VoucherRequirement,
  issuedAtSeconds: number,
  net: NetworkEntry,
): { wire: WireVoucher; typedData: VoucherTypedData } {
  const { chainId, escrow: verifyingContract } = resolve(net);
  if (requirement.network !== net.caip2) refuse("network", "is not the client's network");

  const payTo = account("payTo", requirement.payTo, chainId);
  if (payTo !== verifyingContract) refuse("payTo", "is not the built-in escrow");
  const payer = account("payer", requirement.payer, chainId);
  const provider = account("provider", requirement.provider, chainId);

  const money = requirement.amount as unknown;
  if (typeof money !== "object" || money === null) refuse("amount", "is missing");
  const amount = uint64("amount", requirement.amount.amount);
  if (requirement.amount.asset !== net.asset) refuse("amount.asset", "is not the built-in asset");
  if (requirement.amount.decimals !== net.decimals) refuse("amount.decimals", "are not the built-in decimals");
  const seq = uint64("seq", requirement.seq);
  if (typeof requirement.resource !== "string" || requirement.resource.length === 0) refuse("resource", "is empty");
  const requestHash = requestHashBytes(requirement.requestHash);
  const maxTimeout = requirement.maxTimeoutSeconds;
  if (!Number.isSafeInteger(maxTimeout) || maxTimeout < 1) refuse("maxTimeoutSeconds", "is not a positive integer");
  if (!Number.isSafeInteger(issuedAtSeconds) || issuedAtSeconds <= 0) refuse("issuedAt", "is not a positive integer");

  const issuedAt = issuedAtSeconds;
  const expiresAt = issuedAt + Math.min(VOUCHER_LIFETIME_SECONDS, maxTimeout);

  // Built fresh: nothing the server sent beyond the checked fields reaches the wire.
  const wire: WireVoucher = {
    payer: requirement.payer,
    payTo: requirement.payTo,
    provider: requirement.provider,
    amount: { amount: amount.toString(), asset: net.asset, decimals: net.decimals },
    resource: requirement.resource,
    requestHash: requirement.requestHash,
    seq: seq.toString(),
    issuedAt,
    expiresAt,
  };
  const typedData: VoucherTypedData = {
    domain: { name: VOUCHER_DOMAIN_NAME, version: VOUCHER_DOMAIN_VERSION, chainId, verifyingContract },
    types: VOUCHER_TYPES,
    primaryType: "Voucher",
    message: {
      payer,
      provider,
      amount,
      // The UTF-8 bytes: a resource starting with `0x` is still a string.
      resourceHash: keccakUtf8(requirement.resource),
      requestHash,
      seq,
      issuedAt: BigInt(issuedAt),
      expiresAt: BigInt(expiresAt),
    },
  };
  return { wire, typedData };
}
