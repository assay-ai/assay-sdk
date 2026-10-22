/**
 * The SDK's errors. Every error the SDK raises is an {@link AssayError} with a stable `code`;
 * branch on the class or on `code`, never on the message. A server code this release does not
 * know still arrives, as the nearest class (or `AssayError` itself).
 *
 * ```text
 * AssayError
 * ├─ ConfigError                      local setup (missing API key, bad option)
 * ├─ AuthError                        401, or an AUTH_* refusal
 * │   ├─ ScopeMissingError            403 AUTH_SCOPE_MISSING (.requiredScope)
 * │   └─ HumanSessionRequiredError    403 AUTH_HUMAN_SESSION_REQUIRED: only a signed-in person may do this
 * ├─ McpUrlNotFoundError              404 MCP_URL_NOT_FOUND: the MCP host serves no such URL for this key
 * ├─ DelegateAlreadyBoundError        409 ACCOUNT_DELEGATE_ALREADY_BOUND: the key is bound to another API key
 * ├─ DelegateBindConflictError        409 ACCOUNT_DELEGATE_BIND_CONFLICT: another key won a first bind; retry once
 * ├─ PaymentError                     a PAYMENT_* refusal from the server
 * │   ├─ PaymentRequiredError         the tool is paid and no signer was given (.requirement)
 * │   ├─ PaymentSchemeUnsupportedError no signer for the requirement's network (.network)
 * │   └─ PaymentRefusedError          refused locally before signing (.guard); nothing signed
 * │       └─ PaymentNetworkUnknownError the network is not in the SDK's network table (.network)
 * ├─ RateLimitError                   429, RATE_LIMITED, quota or velocity limits (.retryAfterMs)
 * ├─ NetworkError                     no answer: connection failure
 * │   └─ TimeoutError
 * └─ ServerError                      5xx or an answer the SDK cannot read
 * ```
 */

export interface AssayErrorInit {
  retryable?: boolean;
  status?: number;
  fixUrl?: string;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class AssayError extends Error {
  override name = "AssayError";
  /** A stable code, from the server (`assay/error.code`, REST `error.code`) or the SDK. */
  readonly code: string;
  /** Whether the same call can succeed later. */
  readonly retryable: boolean;
  /** The HTTP status, when the error came with one. */
  readonly status: number | undefined;
  /** A page that fixes the cause, when the server named one. */
  readonly fixUrl: string | undefined;
  /** Extra structured data the server sent (never a key or a signature). */
  readonly details: Record<string, unknown> | undefined;
  /**
   * On an error out of `tools.call`: the idempotency key of that logical call. Call again with
   * `{ idempotencyKey: err.idempotencyKey }` to retry safely: Assay replays a served call instead
   * of charging it twice.
   */
  idempotencyKey: string | undefined;

  constructor(code: string, message: string, init: AssayErrorInit = {}) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.code = code;
    this.retryable = init.retryable ?? false;
    this.status = init.status;
    this.fixUrl = init.fixUrl;
    this.details = init.details;
    this.idempotencyKey = undefined;
  }
}

export class ConfigError extends AssayError {
  override name = "ConfigError";
  constructor(message: string) {
    super("CONFIG_INVALID", message);
  }
}

export class AuthError extends AssayError {
  override name = "AuthError";
}

export class ScopeMissingError extends AuthError {
  override name = "ScopeMissingError";
  /** The scope the API key lacks, for example `payments`, when the server named it. */
  readonly requiredScope: string | undefined;
  constructor(message: string, init: AssayErrorInit & { requiredScope?: string } = {}) {
    super("AUTH_SCOPE_MISSING", message, { ...init, status: init.status ?? 403 });
    this.requiredScope = init.requiredScope;
  }
}

export class HumanSessionRequiredError extends AuthError {
  override name = "HumanSessionRequiredError";
  constructor(message: string, init: AssayErrorInit = {}) {
    super("AUTH_HUMAN_SESSION_REQUIRED", message, { ...init, status: init.status ?? 403 });
  }
}

export const MCP_URL_NOT_FOUND = "MCP_URL_NOT_FOUND";

/**
 * The MCP host serves no such URL for this API key (`MCP_URL_NOT_FOUND`, or any 404 from it): the
 * tool set, version, topic or maker does not exist, is not shared with you, or no longer serves.
 * Not retried.
 */
export class McpUrlNotFoundError extends AssayError {
  override name = "McpUrlNotFoundError";
  constructor(message = "the MCP host serves no such URL for this API key", init: AssayErrorInit = {}) {
    super(MCP_URL_NOT_FOUND, message, { ...init, status: init.status ?? 404 });
  }
}

/**
 * The payment key is already bound (or waiting for approval) on another live API key; nothing was
 * bound. Use a key of this agent's own, or revoke the other API key first.
 */
export class DelegateAlreadyBoundError extends AssayError {
  override name = "DelegateAlreadyBoundError";
  constructor(message: string, init: AssayErrorInit = {}) {
    super("ACCOUNT_DELEGATE_ALREADY_BOUND", message, { ...init, status: init.status ?? 409 });
  }
}

/**
 * Another payment key was bound to this API key at the same moment (two first binds raced);
 * nothing was bound. Retryable once: a second `bind()` asks for a new challenge and parks this key
 * as `pendingDelegate` (`bindStatus: "PENDING_APPROVAL"`) until a person approves it.
 */
export class DelegateBindConflictError extends AssayError {
  override name = "DelegateBindConflictError";
  constructor(message: string, init: AssayErrorInit = {}) {
    super("ACCOUNT_DELEGATE_BIND_CONFLICT", message, { ...init, retryable: true, status: init.status ?? 409 });
  }
}

export class PaymentError extends AssayError {
  override name = "PaymentError";
}

export class PaymentRequiredError extends PaymentError {
  override name = "PaymentRequiredError";
  /** `_meta["x402/paymentRequired"]` as the server sent it. Untrusted. */
  readonly requirement: unknown;
  constructor(message: string, requirement: unknown, init: AssayErrorInit = {}) {
    super("PAYMENT_REQUIRED", message, init);
    this.requirement = requirement;
  }
}

export class PaymentSchemeUnsupportedError extends PaymentError {
  override name = "PaymentSchemeUnsupportedError";
  /** The CAIP-2 network the requirement is for. */
  readonly network: string;
  constructor(network: string) {
    super("PAYMENT_SCHEME_UNSUPPORTED", `no signer for network ${network}; pass a signer for this network`);
    this.network = network;
  }
}

export class PaymentRefusedError extends PaymentError {
  override name = "PaymentRefusedError";
  /** The local guard that refused (`G1`..`G12`), or `onPayment` for the caller's hook. */
  readonly guard: string;
  constructor(guard: string, code: string, reason: string, init: AssayErrorInit = {}) {
    super(code, `payment refused before signing: ${reason}`, init);
    this.guard = guard;
  }
}

export class PaymentNetworkUnknownError extends PaymentRefusedError {
  override name = "PaymentNetworkUnknownError";
  /** The CAIP-2 network asked for. */
  readonly network: string;
  constructor(network: string, message?: string) {
    super(
      "G2",
      "G2_NETWORK",
      message ??
        `the network ${network} is not in this SDK's network table (pass networks for another environment or chain)`,
    );
    this.network = network;
  }
}

export class RateLimitError extends AssayError {
  override name = "RateLimitError";
  /** How long to wait before trying again, when the server said. */
  readonly retryAfterMs: number | undefined;
  constructor(code: string, message: string, init: AssayErrorInit & { retryAfterMs?: number } = {}) {
    super(code, message, { retryable: true, ...init });
    this.retryAfterMs = init.retryAfterMs;
  }
}

export class NetworkError extends AssayError {
  override name = "NetworkError";
  constructor(message: string, cause?: unknown, code = "NETWORK_ERROR") {
    super(code, message, { retryable: true, cause });
  }
}

export class TimeoutError extends NetworkError {
  override name = "TimeoutError";
  constructor(message = "the request timed out", cause?: unknown) {
    super(message, cause, "TIMEOUT");
  }
}

export class ServerError extends AssayError {
  override name = "ServerError";
}

const RATE_LIMIT_CODES = new Set([
  "RATE_LIMITED",
  "TOO_MANY_REQUESTS",
  "MCP_QUOTA_EXCEEDED",
  "MCP_VELOCITY_LIMIT_EXCEEDED",
]);

export interface ServerErrorFields extends AssayErrorInit {
  retryAfterMs?: number;
}

/** The typed error for a server refusal, chosen by code first, then by HTTP status. */
export function errorFromServer(code: string | undefined, message: string, f: ServerErrorFields = {}): AssayError {
  const c = code ?? (f.status !== undefined ? `HTTP_${f.status}` : "UNKNOWN");
  if (c === "AUTH_SCOPE_MISSING") {
    const scope = f.details?.requiredScope;
    return new ScopeMissingError(message, { ...f, ...(typeof scope === "string" ? { requiredScope: scope } : {}) });
  }
  if (c === MCP_URL_NOT_FOUND) return new McpUrlNotFoundError(message, f);
  if (c === "AUTH_HUMAN_SESSION_REQUIRED") return new HumanSessionRequiredError(message, f);
  if (c === "ACCOUNT_DELEGATE_ALREADY_BOUND") return new DelegateAlreadyBoundError(message, f);
  if (c === "ACCOUNT_DELEGATE_BIND_CONFLICT") return new DelegateBindConflictError(message, f);
  if (RATE_LIMIT_CODES.has(c) || f.status === 429) return new RateLimitError(c, message, f);
  if (c.startsWith("AUTH_") || f.status === 401) return new AuthError(c, message, f);
  if (c.startsWith("PAYMENT_")) return new PaymentError(c, message, f);
  if (f.status !== undefined && f.status >= 500) return new ServerError(c, message, { retryable: true, ...f });
  return new AssayError(c, message, f);
}
