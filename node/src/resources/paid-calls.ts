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
  /** The bound key's `0x` address, or null. While a new key waits for approval, still the old key. */
  delegate: string | null;
  /** When `delegate` was bound (ISO 8601), or null. */
  boundAt: string | null;
  /** A key waiting for approval to replace `delegate`, or null. */
  pendingDelegate: string | null;
  /** When `pendingDelegate` was proved (ISO 8601), or null. */
  pendingSince: string | null;
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
  /** The key was already bound (or already waiting for approval): nothing was signed. */
  alreadyBound: boolean;
  /**
   * - `ACTIVE`: this key is the bound key (`delegate`); a person still approves its caps on chain;
   * - `PENDING_APPROVAL`: another key stays bound and keeps signing; this key is `pendingDelegate`
   *   and replaces it once a person approves it at `approvalUrl`.
   */
  bindStatus: "ACTIVE" | "PENDING_APPROVAL";
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
      boundAt: str(data.boundAt),
      pendingDelegate: pending,
      pendingSince: str(data.pendingSince),
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
   * when the key is already bound or already waiting. When another key is bound, this key waits as
   * `pendingDelegate` (`bindStatus: "PENDING_APPROVAL"`) and the old key keeps signing until a
   * person approves the new one at `approvalUrl`, comparing the fingerprint. Needs the `payments`
   * scope. A key bound to another API key is refused with `DelegateAlreadyBoundError` (409).
   * When another key wins a first bind at the same moment, this is `DelegateBindConflictError`
   * (409, retryable): nothing was bound, and calling `bind()` once more parks this key as pending.
   */
  async bind(options: { network?: string } = {}): Promise<BindResult> {
    const signer = this.#signer();
    if (signer === null) throw new ConfigError("bind() needs an eip155 signer");
    const mine = getAddress(signer.address);
    const current = await this.status();
    if (current.delegate === mine) return { ...current, alreadyBound: true, bindStatus: "ACTIVE" };
    if (current.pendingDelegate === mine) return { ...current, alreadyBound: true, bindStatus: "PENDING_APPROVAL" };
    const evm = [...this.#c.networks.keys()].filter((n) => n.startsWith("eip155:"));
    const network = options.network ?? (evm.length === 1 ? evm[0] : undefined);
    const chainId = network === undefined || !this.#c.networks.has(network) ? null : eip155ChainId(network);
    if (chainId === null) {
      if (network === undefined && evm.length > 1)
        throw new ConfigError("bind() needs `network` naming one of the eip155 networks");
      throw new PaymentNetworkUnknownError(network ?? "eip155");
    }
    const answer = await bindEvmKey({
      signer,
      chainId,
      credentialId: current.credentialId,
      api: this.#c.api,
      now: this.#c.now,
    });
    const bindStatus = answer.status === "PENDING_APPROVAL" ? "PENDING_APPROVAL" : "ACTIVE";
    return { ...(await this.status()), alreadyBound: false, bindStatus };
  }

  /**
   * Polls until a person approved this client's key: `delegate` is this key and its paid calls are
   * on. A key waiting to replace another one becomes `delegate` only when the approval lands.
   * Every 5 s for 2 minutes, then every 15 s.
   */
  async waitUntilActive(options: WaitOptions = {}): Promise<PaidCallsStatus> {
    const signer = this.#signer();
    const mine = signer ? getAddress(signer.address) : null;
    const started = this.#c.now();
    const until = started + (options.timeoutMs ?? 15 * 60_000);
    for (;;) {
      if (options.signal?.aborted) throw new AssayError("ABORTED", "the wait was aborted");
      try {
        const s = await this.status();
        if (s.state === "active" && (mine === null || s.delegate === mine)) return s;
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
