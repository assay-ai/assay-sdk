import { ConfigError } from "./errors.js";

/**
 * The MCP URL shapes the Assay MCP host serves (spec section 2.3), checked when a client is built
 * so a typo is a `ConfigError` at once, not a 404 on the first call. Only the shape is checked:
 * whether the tool set exists, or is shared with this key, is the server's answer.
 *
 * To support a new shape, add one line to `PATH_SHAPES` or `FILTERS`.
 */

/** The MCP origin a bare path (`"/my/research"`) resolves against. */
export const DEFAULT_MCP_ORIGIN = "https://mcp.goassay.ai";

const SLUG = "[a-z0-9-]{2,64}";
const HANDLE = "[a-z][a-z0-9-]{2,23}";
const CATEGORY = "[a-z][a-z0-9-]{1,63}";
/** A link-only token: a secret, never printed (see {@link redactMcpUrl}). */
const TOKEN = "[a-z0-9_-]{22,64}";
const VERSION = "(?:@[1-9][0-9]{0,5})?";

/** Paths, matched lowercased with `%40` read as `@` and one trailing slash removed. */
const PATH_SHAPES: readonly RegExp[] = [
  /^\/$/, // Everything
  new RegExp(`^/my/${SLUG}${VERSION}$`), // my tool set: Draft, or version n
  new RegExp(`^/@${HANDLE}/${SLUG}${VERSION}$`), // a public tool set
  new RegExp(`^/u/${TOKEN}${VERSION}$`), // a link-only tool set
  new RegExp(`^/c/${CATEGORY}$`), // a topic
  new RegExp(`^/@${HANDLE}$`), // one maker's tools
];

const TOOL_SELECTOR = /^[a-z][a-z0-9_-]{1,47}(?:@[1-9][0-9]{0,5})?$/;
const CATEGORY_RE = new RegExp(`^${CATEGORY}$`);
const MAX_TOOLS = 50;
const MAX_URL_LENGTH = 2048;
/** `scheme://authority` at the start of a full URL. */
const ORIGIN = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i;

/** A comma list, trimmed and lowercased, empty items dropped. */
const items = (v: string) =>
  v
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== "");

/** Query filters (they only narrow what a URL serves): name -> is this value accepted. */
const FILTERS: Readonly<Record<string, (value: string) => boolean>> = {
  tools: (v) => items(v).every((t) => TOOL_SELECTOR.test(t)),
  category: (v) => items(v).every((c) => CATEGORY_RE.test(c)),
  free: (v) => v.trim() === "0" || v.trim() === "1",
  discovery: (v) => ["auto", "full", "search"].includes(v.trim().toLowerCase()),
};

/** Throws `ConfigError` unless `pathAndQuery` (from the first `/`, no fragment) has a served shape. */
function checkShape(name: string, pathAndQuery: string): void {
  if (pathAndQuery.length > MAX_URL_LENGTH) throw new ConfigError(`${name} is too long`);
  const q = pathAndQuery.indexOf("?");
  const rawPath = q === -1 ? pathAndQuery : pathAndQuery.slice(0, q);
  const decoded = rawPath.replace(/%40/gi, "@");
  if (decoded.includes("%")) throw new ConfigError(`${name} has a percent-escape in its path`);
  let path = decoded.toLowerCase();
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  if (!PATH_SHAPES.some((shape) => shape.test(path)))
    throw new ConfigError(`${name} is not an MCP URL Assay serves (see "Choose a URL")`);

  const params = new URLSearchParams(q === -1 ? "" : pathAndQuery.slice(q + 1));
  const tools = new Set<string>();
  for (const [key, value] of params) {
    const accepts = Object.hasOwn(FILTERS, key) ? FILTERS[key] : undefined;
    if (!accepts) throw new ConfigError(`${name} has an unknown filter "${key.slice(0, 32)}"`);
    if (!accepts(value)) throw new ConfigError(`${name} has an invalid "${key}" filter`);
    if (key === "tools") for (const t of items(value)) tools.add(t);
  }
  if (tools.size > MAX_TOOLS) throw new ConfigError(`${name} names more than ${MAX_TOOLS} tools`);
}

/**
 * `value` (a full MCP URL, or a path such as `"/my/research"` resolved against `origin`) as the
 * URL to send to. Throws `ConfigError` for a path the MCP host does not serve. The URL is sent as
 * given: the server reads it into its canonical form.
 */
export function resolveMcpUrl(name: string, value: string, origin: string): string {
  if (typeof value !== "string" || value.trim() !== value || value === "")
    throw new ConfigError(`${name} is not a URL`);
  if (value.includes("#")) throw new ConfigError(`${name} must not have a fragment`);
  if (value.startsWith("/")) {
    if (value.startsWith("//")) throw new ConfigError(`${name} is not a URL`);
    checkShape(name, value);
    return origin + value;
  }
  // The raw text after the origin: `URL` would quietly resolve `.` and `..`, which the host refuses.
  const rest = value.replace(ORIGIN, "");
  checkShape(name, rest === "" ? "/" : rest.startsWith("?") ? `/${rest}` : rest);
  return value;
}

/** `url` with a link-only token shown as `/u/…`: for `toString`, `toJSON`, `inspect` and logs. */
export function redactMcpUrl(url: string): string {
  const origin = ORIGIN.exec(url)?.[0] ?? "";
  return origin + url.slice(origin.length).replace(/\/u\/[^/?#@]+/gi, "/u/…");
}
