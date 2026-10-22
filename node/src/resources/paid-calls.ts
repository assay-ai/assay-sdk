import { eip155ChainId, parseCaip10 } from "../core/caip.js";
import { getAddress } from "../core/hex.js";
import { fingerprint, isObject } from "../core/meta.js";
import { AssayError, ConfigError, ServerError } from "../errors.js";
import { bindEvmKey } from "../schemes/eip155/bind.js";
import type { EvmSigner } from "../signer.js";
import type { ClientContext } from "./context.js";

export type PaidCallsState = "unbound" | "pending_approval" | "active" | "expired" | "bound_to_other_key";

export interface PaidCallsStatus {
  /**
   * - `unbound`: no payment key is bound to this API key;
   * - `pending_approval`: this key is bound (or waits) and a person has not approved it yet;
   * - `active`: paid calls are on for this key;
   * - `expired`: the approval lapsed; approve it again;
   * - `bound_to_other_key`: another key is bound; `bind()` this one.
   */
  state: PaidCallsState;
  credentialId: string;
  /** The bound key's `0x` address, or null. */
  delegate: string | null;
  /** A key waiting for approval to replace `delegate`, or null. */
  pendingDelegate: string | null;
  /** The on-chain caps of the bound key, in atomic units, when the server read them. */
  caps: {
    maxVoucherAmount: string | null;
    maxPerWindow: string | null;
    spentInWindow: string | null;
    validUntil: string | null;
  } | null;
  /** Where a person approves this client's key, from the server; null when it sent none. */
  approvalUrl: string | null;
  /** This client's key as the approval page shows it (`1A2B 9F3C`); null without a signer. */
  fingerprint: string | null;
}

export interface BindResult extends PaidCallsStatus {
  /** The key was already bound: nothing was signed. */
  alreadyBound: boolean;
}

export interface WaitOptions {
  /** Default 15 minutes. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

function addressOf(caip10: unknown): string | null {
  const p = typeof caip10 === "string" ? parseCaip10(caip10) : null;
  return p ? p.address : null;
}

/**
 * The server's approval link with this key in the fragment (never sent to a server), or null.
 * Only an http(s) link for this credential is used.
 */
function approvalLink(raw: unknown, credentialId: string, address: string | null): string | null {
  if (typeof raw !== "string" || address === null) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const okScheme = url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname));
  if (!okScheme || url.username || url.password || url.searchParams.get("credential") !== credentialId) return null;
  url.hash = `key=${address}`;
  return url.toString();
}

/** Binding a payment key for server-side integrators (spec section 5). */
export class PaidCalls {
  constructor(private readonly c: ClientContext) {}

  #signer(): EvmSigner | null {
    return this.c.signers.find((s): s is EvmSigner => s.namespace === "eip155") ?? null;
  }

  /** Where paid calls stand for this API key and this client's signer. */
  async status(): Promise<PaidCallsStatus> {
    const { data } = await this.c.api.get("/agents/me/delegate");
    if (!isObject(data) || typeof data.credentialId !== "string" || !UUID.test(data.credentialId)) {
      throw new ServerError("API_BAD_ANSWER", "the paid-call status is not readable");
    }
    const signer = this.#signer();
    const mine = signer ? getAddress(signer.address) : null;
    const delegate = addressOf(data.delegate);
    const pending = addressOf(data.pendingDelegate);
    const paid = isObject(data.paidCalls) ? data.paidCalls : null;
    let state: PaidCallsState;
    if (mine !== null && pending === mine) state = "pending_approval";
    else if (delegate === null) state = "unbound";
    else if (mine !== null && delegate !== mine) state = "bound_to_other_key";
    else if (paid?.status === "ACTIVE") state = "active";
    else if (paid?.status === "EXPIRED") state = "expired";
    else state = "pending_approval";
    const str = (v: unknown) => (typeof v === "string" ? v : null);
    return {
      state,
      credentialId: data.credentialId,
      delegate,
      pendingDelegate: pending,
      caps: paid
        ? {
            maxVoucherAmount: str(paid.maxVoucherAmount),
            maxPerWindow: str(paid.maxPerWindow),
            spentInWindow: str(paid.spentInWindow),
            validUntil: str(paid.validUntil),
          }
        : null,
      approvalUrl: approvalLink(data.approvalUrl, data.credentialId, mine),
      fingerprint: mine ? fingerprint(mine) : null,
    };
  }

  /**
   * Binds this client's EVM signer to the API key: challenge, field check, sign, bind. A no-op
   * when the key is already bound. A person then approves the key at `approvalUrl`, comparing the
   * fingerprint. Needs the `payments` scope.
   */
  async bind(options: { network?: string } = {}): Promise<BindResult> {
    const signer = this.#signer();
    if (signer === null) throw new ConfigError("bind() needs an eip155 signer");
    const current = await this.status();
    if (current.delegate === getAddress(signer.address) || current.pendingDelegate === getAddress(signer.address)) {
      return { ...current, alreadyBound: true };
    }
    const evm = [...this.c.networks.keys()].filter((n) => n.startsWith("eip155:"));
    const network = options.network ?? (evm.length === 1 ? evm[0] : undefined);
    const chainId = network === undefined ? null : eip155ChainId(network);
    if (chainId === null || (network !== undefined && !this.c.networks.has(network))) {
      throw new ConfigError("bind() needs one eip155 network in `networks`, or `network` naming one of them");
    }
    const answer = await bindEvmKey({
      signer,
      chainId,
      credentialId: current.credentialId,
      api: this.c.api,
      now: this.c.now,
    });
    const after = await this.status();
    return {
      ...after,
      approvalUrl:
        after.approvalUrl ?? approvalLink(answer.approvalUrl, after.credentialId, getAddress(signer.address)),
      alreadyBound: false,
    };
  }

  /** Polls until a person approved the key: every 5 s for 2 minutes, then every 15 s. */
  async waitUntilActive(options: WaitOptions = {}): Promise<PaidCallsStatus> {
    const started = this.c.now();
    const until = started + (options.timeoutMs ?? 15 * 60_000);
    for (;;) {
      if (options.signal?.aborted) throw new AssayError("ABORTED", "the wait was aborted");
      try {
        const s = await this.status();
        if (s.state === "active") return s;
      } catch (err) {
        if (!(err instanceof AssayError) || !err.retryable) throw err;
      }
      const now = this.c.now();
      if (now >= until)
        throw new AssayError("WAIT_TIMEOUT", "paid calls were not approved in time", { retryable: true });
      await this.c.sleep(Math.min(until - now, now - started < 120_000 ? 5_000 : 15_000));
    }
  }
}
