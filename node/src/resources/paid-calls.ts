import { eip155ChainId, parseCaip10 } from "../core/caip.js";
import { getAddress } from "../core/hex.js";
import { fingerprint, isObject } from "../core/meta.js";
import { AssayError, ConfigError, PaymentNetworkUnknownError, ServerError } from "../errors.js";
import { bindEvmKey } from "../schemes/eip155/bind.js";
import type { EvmSigner } from "../signer.js";
import type { ClientContext } from "./context.js";

export type PaidCallsState = "unbound" | "pending_approval" | "active" | "expired" | "bound_to_other_key" | "unknown";

export interface PaidCallsStatus {
  /**
   * - `unbound`: no payment key is bound to this API key;
   * - `pending_approval`: this key is bound (or waits) and a person has not approved it yet;
   * - `active`: paid calls are on for this key;
   * - `expired`: the approval lapsed; approve it again;
   * - `bound_to_other_key`: another key is bound; `bind()` this one;
   * - `unknown`: Assay could not read the key's grant from the chain just now; ask again.
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
  /**
   * Where a person approves this client's key: `{webUrl}/agents/enable-paid?credential=...#key=...`.
   * The key travels only in the fragment. Null without a signer.
   */
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

function addressOf(caip10: unknown): string | null {
  const p = typeof caip10 === "string" ? parseCaip10(caip10) : null;
  return p ? p.address : null;
}

/**
 * The approval link, with this key only in the fragment (browsers never send it to a server). A
 * link the server sent is used only when it is on the configured web origin and names this
 * credential; otherwise the link is built from the web origin.
 */
export function approvalLink(
  webOrigin: string,
  server: unknown,
  credentialId: string,
  address: string | null,
): string | null {
  if (address === null) return null;
  let url: URL | null = null;
  if (typeof server === "string") {
    try {
      const u = new URL(server);
      if (u.origin === webOrigin && !u.username && !u.password && u.searchParams.get("credential") === credentialId)
        url = u;
    } catch {
      url = null;
    }
  }
  url ??= new URL(`${webOrigin}/agents/enable-paid?credential=${encodeURIComponent(credentialId)}`);
  url.hash = `key=${address}`;
  return url.toString();
}

/** Binding a payment key for server-side integrators (spec section 5). */
export class PaidCalls {
  readonly #c: ClientContext;

  constructor(context: ClientContext) {
    this.#c = context;
  }

  #signer(): EvmSigner | null {
    return this.#c.signers.find((s): s is EvmSigner => s.namespace === "eip155") ?? null;
  }

  /** Where paid calls stand for this API key and this client's signer. */
  async status(): Promise<PaidCallsStatus> {
    const { data } = await this.#c.api.get("/agents/me/delegate");
    if (!isObject(data) || typeof data.credentialId !== "string" || !UUID.test(data.credentialId)) {
      throw new ServerError("API_BAD_ANSWER", "the paid-call status is not readable");
    }
    const signer = this.#signer();
    const mine = signer ? getAddress(signer.address) : null;
    const delegate = addressOf(data.delegate);
    const pending = addressOf(data.pendingDelegate);
    const paid = isObject(data.paidCalls) ? data.paidCalls : null;
    let state: PaidCallsState;
    if (data.paidCallsUnknown === true && delegate !== null && (mine === null || delegate === mine)) state = "unknown";
    else if (mine !== null && pending === mine) state = "pending_approval";
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
      approvalUrl: approvalLink(this.#c.webOrigin, data.approvalUrl, data.credentialId, mine),
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
    const evm = [...this.#c.networks.keys()].filter((n) => n.startsWith("eip155:"));
    const network = options.network ?? (evm.length === 1 ? evm[0] : undefined);
    const chainId = network === undefined || !this.#c.networks.has(network) ? null : eip155ChainId(network);
    if (chainId === null) {
      if (network === undefined && evm.length > 1)
        throw new ConfigError("bind() needs `network` naming one of the eip155 networks");
      throw new PaymentNetworkUnknownError(network ?? "eip155");
    }
    await bindEvmKey({ signer, chainId, credentialId: current.credentialId, api: this.#c.api, now: this.#c.now });
    return { ...(await this.status()), alreadyBound: false };
  }

  /** Polls until a person approved the key: every 5 s for 2 minutes, then every 15 s. */
  async waitUntilActive(options: WaitOptions = {}): Promise<PaidCallsStatus> {
    const started = this.#c.now();
    const until = started + (options.timeoutMs ?? 15 * 60_000);
    for (;;) {
      if (options.signal?.aborted) throw new AssayError("ABORTED", "the wait was aborted");
      try {
        const s = await this.status();
        if (s.state === "active") return s;
      } catch (err) {
        if (!(err instanceof AssayError) || !err.retryable) throw err;
      }
      const now = this.#c.now();
      if (now >= until)
        throw new AssayError("WAIT_TIMEOUT", "paid calls were not approved in time", { retryable: true });
      await this.#c.sleep(Math.min(until - now, now - started < 120_000 ? 5_000 : 15_000));
    }
  }
}
