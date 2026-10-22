/**
 * The `eip155` payment scheme: EIP-712 vouchers and the EIP-712 key binding, behind the
 * {@link PaymentScheme} interface. Guards G1-G12 run on one frozen copy of the requirement, the
 * voucher is built from that same copy and the caller's own network entry, and only then signed.
 */
import { eip155ChainId, parseCaip10, parseCaip19Erc20 } from "../../core/caip.js";
import { ChainReader, isUsableRpcUrl } from "../../core/chain.js";
import { correctedNow } from "../../core/clock.js";
import { SignerRefusal } from "../../core/errors.js";
import type { GuardContext, GuardResult, SignedVoucher } from "../../core/guard-types.js";
import { checkAll, usdToAtomic } from "../../core/guards.js";
import { getAddress, type Address } from "../../core/hex.js";
import { isObject, voucherEnvelope, type PriceQuote } from "../../core/meta.js";
import { buildVoucher, type VoucherRequirement, type VoucherTypedData, type WireVoucher } from "../../core/voucher.js";
import { ConfigError } from "../../errors.js";
import type { EvmSigner } from "../../signer.js";
import type { PaymentScheme, Prepared, PrepareInput } from "../types.js";

/** The caller's own entry for one EVM network. Never taken from the server. */
export interface Eip155Network {
  /** CAIP-10 of the escrow (the EIP-712 `verifyingContract`). */
  escrow: string;
  /** CAIP-19 erc20 asset. */
  asset: string;
  decimals: number;
  /** JSON-RPC URLs for the chain reads of G4/G6. Every one must agree. */
  rpc: string[];
}

export interface NetworkEntry {
  id: string;
  chainId: number;
  escrow: Address;
  escrowCaip10: string;
  asset: string;
  decimals: number;
  rpc: readonly string[];
}

/** Local limits in dollars, as decimal strings (G7). */
export interface Limits {
  maxPerCall: string;
  maxPerDay: string;
}

export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({ maxPerCall: "0.50", maxPerDay: "5" });

/** Checks and freezes the caller's network table. */
export function eip155Networks(table: Record<string, Eip155Network>): Map<string, NetworkEntry> {
  const out = new Map<string, NetworkEntry>();
  for (const [id, n] of Object.entries(table)) {
    if (!id.startsWith("eip155:")) continue;
    const chainId = eip155ChainId(id);
    const escrow = typeof n?.escrow === "string" ? parseCaip10(n.escrow) : null;
    const asset = typeof n?.asset === "string" ? parseCaip19Erc20(n.asset) : null;
    if (chainId === null) throw new ConfigError(`networks: ${id} is not a CAIP-2 eip155 chain`);
    if (!escrow || escrow.chainId !== chainId)
      throw new ConfigError(`networks.${id}.escrow must be a checksummed CAIP-10 account on ${id}`);
    if (!asset || asset.chainId !== chainId)
      throw new ConfigError(`networks.${id}.asset must be a checksummed CAIP-19 erc20 asset on ${id}`);
    if (!Number.isInteger(n.decimals) || n.decimals < 0 || n.decimals > 36)
      throw new ConfigError(`networks.${id}.decimals is invalid`);
    if (
      !Array.isArray(n.rpc) ||
      n.rpc.length === 0 ||
      !n.rpc.every((u) => typeof u === "string" && isUsableRpcUrl(u))
    ) {
      throw new ConfigError(`networks.${id}.rpc must list at least one https RPC URL`);
    }
    out.set(
      id,
      Object.freeze({
        id,
        chainId,
        escrow: escrow.address,
        escrowCaip10: n.escrow,
        asset: n.asset,
        decimals: n.decimals,
        rpc: Object.freeze([...n.rpc]),
      }),
    );
  }
  return out;
}

export function checkLimits(limits: Limits): Limits {
  const perCall = typeof limits?.maxPerCall === "string" ? usdToAtomic(limits.maxPerCall, 6) : null;
  const perDay = typeof limits?.maxPerDay === "string" ? usdToAtomic(limits.maxPerDay, 6) : null;
  if (perCall === null || perCall === 0n)
    throw new ConfigError('limits.maxPerCall must be a positive dollar amount such as "0.50"');
  if (perDay === null || perDay === 0n)
    throw new ConfigError('limits.maxPerDay must be a positive dollar amount such as "5"');
  if (perCall > perDay) throw new ConfigError("limits.maxPerCall must not be above limits.maxPerDay");
  return Object.freeze({ maxPerCall: limits.maxPerCall, maxPerDay: limits.maxPerDay });
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

export type GuardedVoucher = { ok: true; wire: WireVoucher; typedData: VoucherTypedData };

/**
 * The one path from a requirement to a voucher: the guards and the builder see the same frozen
 * copy, and the network the guards check is the caller's own entry for `requirement.network`.
 * Returns the first refusal, or the voucher to sign.
 */
export function guardAndBuild(
  ctx: Omit<GuardContext, "network">,
  issuedAt: number,
  networks: ReadonlyMap<string, NetworkEntry>,
): GuardedVoucher | Exclude<GuardResult, { ok: true }> {
  let requirement: unknown;
  try {
    requirement = deepFreeze(structuredClone(ctx.requirement));
  } catch {
    return { ok: false, guard: "G1", code: "G1_NOT_A_REQUIREMENT", reason: "the payment request could not be copied" };
  }
  const id = isObject(requirement) && typeof requirement.network === "string" ? requirement.network : null;
  const entry = id !== null ? networks.get(id) : undefined;
  const network = entry
    ? { id: entry.id, escrow: entry.escrowCaip10, asset: entry.asset, decimals: entry.decimals }
    : null;
  const result = checkAll({ ...ctx, requirement, network });
  if (!result.ok) return result;
  const req = requirement as VoucherRequirement;
  try {
    const built = buildVoucher(req, issuedAt, {
      caip2: entry!.id,
      escrow: entry!.escrowCaip10,
      asset: entry!.asset,
      decimals: entry!.decimals,
    });
    const m = built.typedData.message;
    const same =
      m.amount === BigInt(req.amount.amount) &&
      m.seq === BigInt(req.seq) &&
      m.payer === getAddress(parseCaip10(req.payer)!.address) &&
      m.provider === getAddress(parseCaip10(req.provider)!.address) &&
      built.typedData.domain.verifyingContract === entry!.escrow &&
      built.typedData.domain.chainId === entry!.chainId;
    if (!same)
      return {
        ok: false,
        guard: "G1",
        code: "G1_NOT_A_REQUIREMENT",
        reason: "the voucher differs from the checked requirement",
      };
    return { ok: true, ...built };
  } catch (err) {
    if (err instanceof SignerRefusal)
      return { ok: false, guard: "G1", code: "G1_NOT_A_REQUIREMENT", reason: err.message };
    throw err;
  }
}

const SPEND_WINDOW_SECONDS = 86_400;
/** Vouchers signed in this process, by key: every client using one key shares one 24 h cap. */
const LEDGER = new Map<string, SignedVoucher[]>();

function spentBy(address: string, nowSeconds: number): SignedVoucher[] {
  const key = address.toLowerCase();
  const kept = (LEDGER.get(key) ?? []).filter((e) => e.at > nowSeconds - SPEND_WINDOW_SECONDS);
  LEDGER.set(key, kept);
  return kept;
}

export interface Eip155SchemeOptions {
  networks: ReadonlyMap<string, NetworkEntry>;
  limits: Limits;
  chain: ChainReader;
  /** The quote for a tool (G3): cached from search/get, or a fresh `get_tool`. */
  quote: (tool: string) => Promise<PriceQuote | null>;
  mcpUrl: string;
  /** Milliseconds clock. */
  now: () => number;
  /** Server minus local clock, seconds (spec section 7). */
  dateOffset: () => number;
}

function accountOn(value: unknown, chainId: number): Address | null {
  const parsed = typeof value === "string" ? parseCaip10(value) : null;
  return parsed && parsed.chainId === chainId ? parsed.address : null;
}

export class Eip155Scheme implements PaymentScheme {
  readonly namespace = "eip155";
  /** The payer of the first voucher this client signed (G4): a different one later is refused. */
  #recordedPayer: string | null = null;

  constructor(private readonly o: Eip155SchemeOptions) {}

  async prepare(input: PrepareInput): Promise<Prepared> {
    const signer = input.signer as EvmSigner;
    let localKey: Address;
    try {
      localKey = getAddress(signer.address);
    } catch {
      return { ok: false, guard: "G5", code: "G5_LOCAL_KEY_INVALID", reason: "the signer's address is not readable" };
    }
    const req = isObject(input.requirement) ? input.requirement : null;
    const entry = req && typeof req.network === "string" ? this.o.networks.get(req.network) : undefined;
    const payer = entry ? accountOn(req?.payer, entry.chainId) : null;
    const chain = entry && payer ? await this.o.chain.read(entry, payer, localKey) : null;
    const quote = await this.o.quote(input.tool);

    // No await from here to the spend record, so two calls in flight cannot both pass the cap.
    const nowSeconds = Math.floor(this.o.now() / 1000);
    const signed = spentBy(localKey, nowSeconds);
    const ctx: Omit<GuardContext, "network"> = {
      requirement: input.requirement,
      forwardedCall: { tool: input.tool, at: input.calledAt },
      quote,
      chain,
      localKey,
      recordedPayer: this.#recordedPayer,
      limits: {
        perCall: this.o.limits.maxPerCall,
        perDay: this.o.limits.maxPerDay,
        confirmAbove: null,
        providers: null,
      },
      signed,
      confirmation: null,
      canonicalUrl: this.o.mcpUrl,
      paidUrls: [this.o.mcpUrl],
      nowSeconds,
    };
    const built = guardAndBuild(ctx, correctedNow(nowSeconds, this.o.dateOffset()), this.o.networks);
    if (!built.ok) {
      if ((built.guard === "G4" || built.guard === "G6") && entry && payer)
        this.o.chain.invalidate(entry.id, payer, localKey);
      return built;
    }
    const r = req as unknown as VoucherRequirement;
    const providerId = r.providerId;
    if (typeof providerId !== "string" || providerId.length === 0 || providerId.length > 256) {
      return { ok: false, guard: "G1", code: "G1_NOT_A_REQUIREMENT", reason: "the payment request names no provider" };
    }
    const reserved: SignedVoucher = { at: nowSeconds, amount: built.typedData.message.amount.toString() };
    signed.push(reserved);
    let used = false;
    return {
      ok: true,
      details: {
        tool: input.tool,
        network: r.network,
        amount: { ...built.wire.amount },
        provider: r.provider,
        payer: r.payer,
        idempotencyKey: input.idempotencyKey,
      },
      sign: async () => {
        if (used) throw new Error("a voucher is signed at most once");
        used = true;
        const signature = await signer.signTypedData(built.typedData as never);
        if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature))
          throw new Error("the signer did not return a 65-byte signature");
        this.#recordedPayer ??= getAddress(parseCaip10(r.payer)!.address);
        return voucherEnvelope(built.wire, signature, providerId, r.contractVersion);
      },
      release: () => {
        const i = signed.indexOf(reserved);
        if (i !== -1) signed.splice(i, 1);
      },
    };
  }

  onRefused(code: string, input: PrepareInput): void {
    if (code !== "PAYMENT_VOUCHER_DELEGATE_INACTIVE") return;
    const req = isObject(input.requirement) ? input.requirement : null;
    const entry = req && typeof req.network === "string" ? this.o.networks.get(req.network) : undefined;
    const payer = entry ? accountOn(req?.payer, entry.chainId) : null;
    if (entry && payer) this.o.chain.invalidate(entry.id, payer, getAddress(input.signer.address));
  }
}
