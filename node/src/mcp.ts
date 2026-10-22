import { isObject } from "./core/meta.js";
import { AssayError, errorFromServer, RateLimitError, ServerError } from "./errors.js";
import { RPC_RATE_LIMITED, retryAfterMs, type Http } from "./http.js";

/** The MCP protocol revision this release speaks: per-request envelope, no handshake. */
export const MCP_PROTOCOL_VERSION = "2026-07-28";

/**
 * A minimal MCP client over HTTP (spec section 2.1): one JSON-RPC request per POST, no session,
 * no handshake. The protocol revision rides each request in `_meta` and in headers.
 */
export class McpTransport {
  #id = 1;

  constructor(
    private readonly http: Http,
    private readonly url: string,
    private readonly clientInfo: { name: string; version: string },
  ) {}

  /** Sends one request and returns its `result`. Network retries resend the same bytes. */
  async request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const meta = isObject(params._meta) ? params._meta : {};
    const body = {
      jsonrpc: "2.0",
      id: this.#id++,
      method,
      params: {
        ...params,
        _meta: {
          ...meta,
          "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": this.clientInfo,
        },
      },
    };
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
      "mcp-method": method,
    };
    if (typeof params.name === "string") headers["mcp-name"] = params.name;
    const res = await this.http.request({
      url: this.url,
      method: "POST",
      headers,
      body: JSON.stringify(body),
      retry: true,
    });
    const msg = parseMessage(res.text, res.headers.get("content-type"));
    if (!isObject(msg) || msg.jsonrpc !== "2.0") {
      throw (
        restError(res.status, res.text, res.headers.get("retry-after")) ??
        new ServerError("MCP_BAD_ANSWER", "Assay sent an answer the SDK cannot read", { status: res.status })
      );
    }
    if (isObject(msg.error)) throw rpcError(msg.error, res.status, res.headers.get("retry-after"));
    if (!isObject(msg.result)) {
      throw (
        restError(res.status, res.text, res.headers.get("retry-after")) ??
        new ServerError("MCP_BAD_ANSWER", "Assay sent an answer the SDK cannot read", { status: res.status })
      );
    }
    return msg.result;
  }
}

function parseMessage(text: string, contentType: string | null): unknown {
  try {
    if (contentType?.includes("text/event-stream")) {
      for (const line of text.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const m: unknown = JSON.parse(line.slice(5).trim());
        if (isObject(m) && ("result" in m || "error" in m)) return m;
      }
      return null;
    }
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function rpcError(error: Record<string, unknown>, status: number, retryAfter: string | null): AssayError {
  const message = typeof error.message === "string" ? error.message : "the MCP request failed";
  const data = isObject(error.data) ? error.data : {};
  if (error.code === RPC_RATE_LIMITED) {
    const ms = typeof data.retryAfterMs === "number" ? data.retryAfterMs : retryAfterMs(retryAfter, Date.now());
    return new RateLimitError("RATE_LIMITED", message, { status, ...(ms !== undefined ? { retryAfterMs: ms } : {}) });
  }
  const code = typeof data.code === "string" ? data.code : `MCP_RPC_${String(error.code)}`;
  return errorFromServer(code, message, { status, details: { rpcCode: error.code } });
}

/** The platform's REST error envelope (spec section 2.2) on a non-JSON-RPC answer, or `null`. */
export function restError(status: number, text: string, retryAfter: string | null): AssayError | null {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  const e = isObject(body) && isObject(body.error) ? body.error : null;
  if (e === null && status >= 200 && status < 300) return null;
  const code = e && typeof e.code === "string" ? e.code : undefined;
  const message = e && typeof e.message === "string" ? e.message : `Assay answered HTTP ${status}`;
  const details = e && isObject(e.context) ? e.context : undefined;
  const wait = retryAfterMs(retryAfter, Date.now());
  return errorFromServer(code, message, {
    status,
    ...(details ? { details } : {}),
    ...(wait !== undefined ? { retryAfterMs: wait } : {}),
  });
}
