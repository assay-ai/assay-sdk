import { isObject } from "./core/meta.js";
import { ServerError } from "./errors.js";
import type { Http } from "./http.js";
import { restError } from "./mcp.js";

/** A REST answer's `data` and its `Date` header. */
export interface RestAnswer {
  data: unknown;
  date: string | null;
}

/** The REST API (spec section 2.2): `{data}` on success, a typed error from `{error}` otherwise. */
export class RestClient {
  constructor(
    private readonly http: Http,
    private readonly base: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** GETs are retried; POSTs are not (a challenge or a bind is not resent blindly). */
  async get(path: string): Promise<RestAnswer> {
    return this.#send("GET", path, undefined);
  }

  async post(path: string, body: unknown): Promise<RestAnswer> {
    return this.#send("POST", path, body);
  }

  async #send(method: "GET" | "POST", path: string, body: unknown): Promise<RestAnswer> {
    const res = await this.http.request({
      url: `${this.base}${path}`,
      method,
      ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
      retry: method === "GET",
    });
    if (res.status < 200 || res.status > 299) {
      throw (
        restError(res.status, res.text, res.headers.get("retry-after"), this.now()) ??
        new ServerError(`HTTP_${res.status}`, `Assay answered HTTP ${res.status}`, { status: res.status })
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.text);
    } catch {
      parsed = undefined;
    }
    if (!isObject(parsed) || !("data" in parsed))
      throw new ServerError("API_BAD_ANSWER", "Assay sent an answer the SDK cannot read", { status: res.status });
    return { data: parsed.data, date: res.headers.get("date") };
  }
}
