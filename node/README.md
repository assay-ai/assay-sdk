# @goassay-ai/sdk

The Node SDK for [Assay](https://goassay.ai): call tools over MCP, with free calls and paid calls signed by a key you hold.

**Status: pre-release.** This package is not published yet, and its API can still change.

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
  // Your own table of payment networks. Paid calls are checked against it, never against the server.
  networks: {
    "eip155:<chainId>": {
      escrow: "eip155:<chainId>:<escrow address>",
      asset: "eip155:<chainId>/erc20:<token address>",
      decimals: 6,
      rpc: ["https://<rpc 1>", "https://<rpc 2>"],
    },
  },
  limits: { maxPerCall: "0.50", maxPerDay: "5" }, // dollars; these are the defaults
  onPayment: (p) => BigInt(p.amount.amount) <= 100_000n, // your own rule; false refuses
});

const res = await assay.tools.call(
  "weather_forecast",
  { city: "Lisbon" },
  { idempotencyKey: `order-${orderId}-weather` },
);
```

On a paid tool the server answers `PAYMENT_REQUIRED`. The SDK then checks the requirement with its local guards (G1 to G12, including the chain reads of your key's grant), calls `onPayment`, signs one voucher, and sends the same call again with the same idempotency key. Network retries resend the same request; a voucher is never signed twice for one attempt. Calling again with the same `idempotencyKey` is safe: Assay replays the stored result and does not charge twice.

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

The approval cannot be automated: a person opens the link and compares the fingerprint.

## Reading a receipt

```ts
const receipt = await assay.receipts.get(res.receipt!.intentId);
receipt.chargedPrice; // { amount: "100000", asset: "eip155:...", decimals: 6 }
```

## Handling errors

Every error is an `AssayError` with a stable `code`. Branch on the class or the code, never on the message.

```ts
import {
  AssayError,
  PaymentRefusedError,
  PaymentRequiredError,
  RateLimitError,
  ScopeMissingError,
} from "@goassay-ai/sdk";

try {
  await assay.tools.call("weather_forecast", { city: "Lisbon" });
} catch (e) {
  if (e instanceof ScopeMissingError) console.error(`the API key needs the ${e.requiredScope} scope`);
  else if (e instanceof PaymentRequiredError) console.error("paid tool: pass a signer");
  else if (e instanceof PaymentRefusedError) console.error(`refused before signing by ${e.guard}: ${e.code}`);
  else if (e instanceof RateLimitError) console.error(`retry in ${e.retryAfterMs} ms`);
  else if (e instanceof AssayError) console.error(e.code, e.message);
  else throw e;
}
```

## Options

| Option               | Default                                                                        |
| -------------------- | ------------------------------------------------------------------------------ |
| `apiKey`             | `ASSAY_API_KEY`                                                                |
| `mcpUrl`, `apiUrl`   | `https://mcp.goassay.ai/`, `https://api.goassay.ai/api/v1`                     |
| `signer` / `signers` | none (free calls only)                                                         |
| `networks`           | none (needed for paid calls)                                                   |
| `limits`             | `{ maxPerCall: "0.50", maxPerDay: "5" }`                                       |
| `onPayment`          | none                                                                           |
| `fetch`              | the global `fetch`                                                             |
| `timeoutMs`          | 120 000 per attempt                                                            |
| `maxRetries`         | 2, with backoff, honouring `Retry-After`                                       |
| `logger`             | silent; never logs keys, headers, bodies or signatures                         |
| `now`, `sleep`       | the system clock (corrected by the server's `Date` for vouchers), `setTimeout` |

The protocol core (EIP-712 voucher and binding, guards, clock) is at `@goassay-ai/sdk/core`.

## Development

```sh
npm ci
npm run lint
npm run typecheck
npm test
```

The tests run the shared vectors in [`../vectors`](../vectors) (`vectors/eip155/`) and unit tests on a fake transport.

## License

MIT, see [LICENSE](LICENSE).
