# @goassay-ai/sdk

The Node SDK for [Assay](https://goassay.ai): call tools over MCP, with free calls and paid calls signed by a key you hold.

**Status: early release (0.x).** The API can still change before 1.0; see the [changelog](https://github.com/assay-ai/assay-sdk/blob/main/node/CHANGELOG.md).

```sh
npm install @goassay-ai/sdk
```

Requires Node 22 or newer. ESM only. Documentation: [docs.goassay.ai/developers](https://docs.goassay.ai/developers).

The client reads your API key from the `apiKey` option or the `ASSAY_API_KEY` environment variable. What the key may do is set on the key, as scopes: `tools:call` for calls, `payments` for paid calls and binding a key, `activity:read` for receipts.

## Free call

```ts
import { Assay } from "@goassay-ai/sdk";

const assay = new Assay(); // ASSAY_API_KEY

const found = await assay.tools.search("weather forecast", { limit: 5 });
const tool = await assay.tools.get("weather_forecast"); // schemas, price
const res = await assay.tools.call("weather_forecast", { city: "Lisbon" });

res.structuredContent; // the tool's output
res.isError; // true only for the provider's own tool error
res.receipt; // what the call cost
```

## Choose a URL

A client calls tools through one MCP URL. `mcpUrl` takes a full URL or a path on `https://mcp.goassay.ai`; the path is checked against the shapes Assay serves when the client is built, so a typo is a `ConfigError` at once. `assay.at(urlOrPath)` returns a client for another URL that shares this one's API key, signers, spend limits and ledger, `onPayment`, `fetch` and logger, and keeps its own quote cache.

```ts
import { Assay } from "@goassay-ai/sdk";

const everything = new Assay(); // "/": the whole catalogue, found with tools.search
const research = new Assay({ mcpUrl: "/my/research" }); // your tool set (Draft; "/my/research@2" for version 2)
const weather = new Assay({ mcpUrl: "/?tools=get_weather" }); // a single tool

// Two URLs in one program: one key, one set of limits.
const kit = everything.at("/@acme/twitter-kit@3"); // a public tool set, version 3
const { tools } = await kit.tools.list(); // tools/list: the set's tools, with prices
await kit.tools.call("acme__get_profile", { user: "x" }); // a provider tool: {handle}__{tool}, sent unchanged
await everything.tools.call("get_weather", { city: "Lisbon" });
```

| Path                                         | Serves                                                                                        |
| -------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `/`                                          | Everything (default)                                                                          |
| `/my/{slug}`, `/my/{slug}@{n}`               | your tool set: the Draft, or version `n`                                                      |
| `/@{handle}/{slug}`, `/@{handle}/{slug}@{n}` | a public tool set                                                                             |
| `/u/{token}`, `/u/{token}@{n}`               | a link-only tool set; the token is a secret, shown as `/u/…` in `toString`, `toJSON` and logs |
| `/c/{category}`, `/@{handle}`                | one topic, one maker                                                                          |

Filters on any path: `?tools=a,b` (one name gives a single-tool URL; `name@1` pins a contract major), `?category=x`, `?free=1`, `?discovery=auto|full|search`. A URL the server does not serve to your key throws `McpUrlNotFoundError`.

Paid calls go through whatever URL you choose: the SDK keeps no per-URL paid list. To keep a client free-only, use a key without the `payments` scope, add `?free=1` to its URL, or refuse in `onPayment`. A tool set grant that allows its tools only through its own URL needs that URL; on `/` those tools are `TOOL_NOT_ALLOWED`.

## Paid call with a local key

The SDK never stores or creates keys. You pass a signer; for a local key, wrap a viem account:

```sh
npm install viem
```

```ts
import { Assay, evmSigner } from "@goassay-ai/sdk";
import { privateKeyToAccount } from "viem/accounts";

const assay = new Assay({
  signer: evmSigner(privateKeyToAccount(process.env.PAYMENT_KEY as `0x${string}`)),
  limits: { maxPerCall: "0.50", maxPerDay: "5" }, // dollars; see "Spend limits"
  onPayment: (p) => BigInt(p.amount.amount) <= 100_000n, // your own rule; false refuses
});

const res = await assay.tools.call("weather_forecast", { city: "Lisbon" });
```

`evmSigner()` returns a frozen object. To wrap signing (for logging or counting), build a new signer object around it instead of changing it in place:

```ts
import type { TypedData } from "@goassay-ai/sdk";

const base = evmSigner(account);
const signer = {
  namespace: base.namespace,
  address: base.address,
  signTypedData: async (typedData: TypedData) => {
    console.log("signing", typedData.primaryType);
    return base.signTypedData(typedData);
  },
};
```

On a paid tool the server answers `PAYMENT_REQUIRED`. The SDK then checks the requirement with its local guards (G1 to G12, including the chain reads of your key's grant), calls `onPayment`, signs one voucher, and sends the same call again with the same idempotency key. Network retries resend the same request; a voucher is never signed twice for one logical call, even when you start the same call twice at once.

### Retrying safely

Every call has an idempotency key: yours (`{ idempotencyKey }`) or one the SDK creates. Every error out of `tools.call` carries it as `err.idempotencyKey`. Calling again with that key is safe: Assay replays a call it already served and does not charge twice.

```ts
try {
  return await assay.tools.call("weather_forecast", { city: "Lisbon" });
} catch (e) {
  if (e instanceof AssayError && e.retryable && e.idempotencyKey) {
    return await assay.tools.call("weather_forecast", { city: "Lisbon" }, { idempotencyKey: e.idempotencyKey });
  }
  throw e;
}
```

For work you may redo after a restart, pass your own key (for example `order-${orderId}-weather`).

### Spend limits

With a signer, every voucher is checked against local limits before it is signed:

- **Defaults: $0.50 per call and $5 per rolling 24 hours**, per signing key.
- Change them with `limits: { maxPerCall, maxPerDay }` (dollars, as strings).
- The record is in memory, per process: a restart starts again at zero, and worker threads or several processes each have their own. The on-chain caps that the payer set when approving the key bound it across processes.

`onPayment(details)` sees each payment (tool, network, amount, provider, payer, idempotency key) after every check passed and before it is signed. Use it for your own rules, for example an allow-list of providers:

```ts
const allowed = new Set(["eip155:<chainId>:<provider address>"]);
const assay = new Assay({ signer, onPayment: (p) => allowed.has(p.provider) });
```

Answer quickly: the voucher's lifetime (at most 240 s) starts before the hook runs.

### Networks

Payments are checked against a network table the client holds (escrow, asset, decimals and RPC URLs per network), never against what the server says, so a compromised API cannot redirect a payment.

- The SDK ships a built-in table, pinned in the release; an address change ships as a new SDK release. It holds Robinhood Chain testnet (`eip155:46630`), the network Assay's production runs on today: the USDG escrow `0x2723…Ce18`, 6 decimals, and two public RPCs from different operators. A paid call or a bind on a network that is in no table is refused with `PaymentNetworkUnknownError`, which names the network.
- `networks` configures any chain yourself: a test chain, or another deployment together with its own `mcpUrl`, `apiUrl` and `webUrl`. Your entries are merged over the built-in table. A new network is added; an entry for a built-in network replaces it whole, so fields are never mixed from two deployments.
- `rpcUrls: { "eip155:<chainId>": ["https://your-rpc"] }` replaces only a network's RPC URLs, for example with your private RPC.

Addresses must be checksummed CAIP-10 / CAIP-19 ids on the network's chain. RPC URLs must be https (plain http only to localhost).

```ts
const assay = new Assay({
  mcpUrl: "https://mcp.your-deployment.example/",
  apiUrl: "https://api.your-deployment.example/api/v1",
  webUrl: "https://portal.your-deployment.example",
  signer,
  networks: {
    "eip155:<chainId>": {
      // chainId: optional; when given it must be the id in the key
      escrow: "eip155:<chainId>:<escrow contract address>",
      asset: "eip155:<chainId>/erc20:<token address>",
      decimals: 6,
      rpcUrls: ["https://<rpc 1>", "https://<rpc 2>"],
    },
  },
});
```

### Binding the key (once)

Before its first paid call, the key is bound to your API key and a person approves it:

```ts
const status = await assay.paidCalls.status();
if (status.state !== "active") {
  const setup = await assay.paidCalls.bind(); // challenge, field check, sign, bind
  console.log(`Approve at ${setup.approvalUrl}; the page must show ${setup.fingerprint}`);
  await assay.paidCalls.waitUntilActive({ timeoutMs: 15 * 60_000 });
}
```

If another key is already bound to the API key, `bind()` answers `bindStatus: "PENDING_APPROVAL"`: the old key stays `delegate` and keeps signing, this key is `pendingDelegate`, and it replaces the old one only when the person approves it. `waitUntilActive()` resolves once `delegate` is this client's key and its paid calls are on. A key that is bound to another API key is refused with `DelegateAlreadyBoundError` (409). If another key wins a first bind at the same moment, `bind()` raises `DelegateBindConflictError` (409, `retryable`): nothing was bound, and calling `bind()` once more parks this key as `pendingDelegate` (`bindStatus: "PENDING_APPROVAL"`) for the person to approve.

The approval link is built on the web app's origin (`webUrl`, default `https://portal.goassay.ai`). A link the server sends is used only when it is on that same origin. The key's address travels only in the URL fragment. The approval cannot be automated: a person opens the link and compares the fingerprint.

## Reading a receipt

Only a paid call has a receipt to fetch. A free call's `res.receipt.intentId` is `null`: it has no intent, and `res.receipt` already says it cost nothing.

```ts
const intentId = res.receipt?.intentId;
if (intentId) {
  const receipt = await assay.receipts.get(intentId);
  receipt.chargedPrice; // { amount: "100000", asset: "eip155:...", decimals: 6 }
}
```

## Handling errors

Every error is an `AssayError` with a stable `code`. Branch on the class or the code, never on the message. A missing scope is a `ScopeMissingError` naming `requiredScope`, on the MCP host and on the API alike; a key without `payments` that calls a paid tool gets a `ScopeMissingError` naming `payments`, and nothing is signed or sent again; a route only a signed-in person may use is a `HumanSessionRequiredError` (an `AuthError`).

```ts
import {
  AssayError,
  HumanSessionRequiredError,
  PaymentNetworkUnknownError,
  PaymentRefusedError,
  McpUrlNotFoundError,
  PaymentRequiredError,
  RateLimitError,
  ScopeMissingError,
} from "@goassay-ai/sdk";

try {
  await assay.tools.call("weather_forecast", { city: "Lisbon" });
} catch (e) {
  if (e instanceof ScopeMissingError) console.error(`the API key needs the ${e.requiredScope} scope`);
  else if (e instanceof HumanSessionRequiredError) console.error("only a signed-in person can do this");
  else if (e instanceof McpUrlNotFoundError) console.error("this MCP URL is not served to this key");
  else if (e instanceof PaymentRequiredError) console.error("paid tool: pass a signer");
  else if (e instanceof PaymentNetworkUnknownError) console.error(`network ${e.network} is not supported yet`);
  else if (e instanceof PaymentRefusedError) console.error(`refused before signing by ${e.guard}: ${e.code}`);
  else if (e instanceof RateLimitError) console.error(`retry in ${e.retryAfterMs} ms`);
  else if (e instanceof AssayError) console.error(e.code, e.message);
  else throw e;
}
```

## Options

| Option               | Default                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| `apiKey`             | `ASSAY_API_KEY`                                                                                  |
| `mcpUrl`, `apiUrl`   | `https://mcp.goassay.ai/` (a URL or a path; see "Choose a URL"), `https://api.goassay.ai/api/v1` |
| `signer` / `signers` | none (free calls only)                                                                           |
| `networks`           | none (needed for paid calls)                                                                     |
| `limits`             | `{ maxPerCall: "0.50", maxPerDay: "5" }`                                                         |
| `onPayment`          | none                                                                                             |
| `fetch`              | the global `fetch`                                                                               |
| `timeoutMs`          | 120 000 per attempt                                                                              |
| `maxRetries`         | 2, with backoff, honouring `Retry-After`                                                         |
| `logger`             | silent; never logs keys, headers, bodies or signatures                                           |
| `now`, `sleep`       | the system clock (corrected by the server's `Date` for vouchers), `setTimeout`                   |

The protocol core (EIP-712 voucher and binding, guards, clock) is at `@goassay-ai/sdk/core`.

## Development

```sh
npm ci
npm run lint
npm run typecheck
npm test
```

The tests run the shared vectors in [`vectors/`](https://github.com/assay-ai/assay-sdk/tree/main/vectors) (`vectors/eip155/`) and unit tests on a fake transport.

## License

MIT, see [LICENSE](https://github.com/assay-ai/assay-sdk/blob/main/node/LICENSE).
