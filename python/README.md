# goassay

The Python SDK for [Assay](https://goassay.ai): call tools over MCP, with free calls and paid calls signed by a key you hold.

**Status: early release (0.x).** The API can still change before 1.0; see the [changelog](https://github.com/assay-ai/assay-sdk/blob/main/python/CHANGELOG.md).

```sh
pip install goassay
```

Requires Python 3.10 or newer. Typed (`py.typed`). Documentation: [docs.goassay.ai/developers](https://docs.goassay.ai/developers).

The client reads your API key from `api_key=` or the `ASSAY_API_KEY` environment variable. What the key may do is set on the key, as scopes: `tools:call` for calls, `payments` for paid calls and binding a key, `activity:read` for receipts.

There is a sync client, `Assay`, and an async one, `AsyncAssay`, with the same methods.

## Free call

```python
from goassay import Assay

with Assay() as assay:  # ASSAY_API_KEY
    found = assay.tools.search("weather forecast", limit=5)
    tool = assay.tools.get("weather_forecast")  # schemas, price
    res = assay.tools.call("weather_forecast", {"city": "Lisbon"})

    res.structured_content  # the tool's output
    res.is_error  # True only for the provider's own tool error
    res.receipt  # what the call cost
```

## Choose a URL

A client calls tools through one MCP URL. `mcp_url` takes a full URL or a path on `https://mcp.goassay.ai`; the path is checked against the shapes Assay serves when the client is built, so a typo is a `ConfigError` at once. `assay.at(url_or_path)` (also on `AsyncAssay`) returns a client for another URL that shares this one's API key, signers, spend limits and ledger, `on_payment`, HTTP client and logger, and keeps its own quote cache. Close the client it came from; closing a sibling does nothing.

```python
from goassay import Assay

everything = Assay()  # "/": the whole catalogue, found with tools.search
research = Assay(mcp_url="/my/research")  # your tool set (Draft; "/my/research@2" for version 2)
weather = Assay(mcp_url="/?tools=get_weather")  # a single tool

# Two URLs in one program: one key, one set of limits.
kit = everything.at("/@acme/twitter-kit@3")  # a public tool set, version 3
listed = kit.tools.list()  # tools/list: the set's tools, with prices
kit.tools.call("acme__get_profile", {"user": "x"})  # a provider tool: {handle}__{tool}, sent unchanged
everything.tools.call("get_weather", {"city": "Lisbon"})
```

| Path | Serves |
|---|---|
| `/` | Everything (default) |
| `/my/{slug}`, `/my/{slug}@{n}` | your tool set: the Draft, or version `n` |
| `/@{handle}/{slug}`, `/@{handle}/{slug}@{n}` | a public tool set |
| `/u/{token}`, `/u/{token}@{n}` | a link-only tool set; the token is a secret, shown as `/u/…` in `repr` and logs |
| `/c/{category}`, `/@{handle}` | one topic, one maker |

Filters on any path: `?tools=a,b` (one name gives a single-tool URL; `name@1` pins a contract major), `?category=x`, `?free=1`, `?discovery=auto|full|search`. A URL the server does not serve to your key raises `McpUrlNotFoundError`.

Paid calls go through whatever URL you choose: the SDK keeps no per-URL paid list. To keep a client free-only, use a key without the `payments` scope, add `?free=1` to its URL, or refuse in `on_payment`. A tool set grant that allows its tools only through its own URL needs that URL; on `/` those tools are `TOOL_NOT_ALLOWED`.

## Paid call with a local key

The SDK never stores or creates keys. You pass a signer; for a local key, wrap an eth-account account:

```python
import os

from eth_account import Account
from goassay import Assay, evm_signer

assay = Assay(
    signer=evm_signer(Account.from_key(os.environ["PAYMENT_KEY"])),
    limits={"max_per_call": "0.50", "max_per_day": "5"},  # dollars; see "Spend limits"
    on_payment=lambda p: int(p["amount"]["amount"]) <= 100_000,  # your own rule; False refuses
)

res = assay.tools.call("weather_forecast", {"city": "Lisbon"})
```

On a paid tool the server answers `PAYMENT_REQUIRED`. The SDK then checks the requirement with its local guards (G1 to G12, including the chain reads of your key's grant), calls `on_payment`, signs one voucher, and sends the same call again with the same idempotency key. Network retries resend the same request; a voucher is never signed twice for one logical call, even when two threads or tasks start the same call at once.

A signer is any object with `namespace = "eip155"`, `address` and `sign_typed_data(typed_data)`, so a KMS or HSM key works the same way. With `AsyncAssay`, `sign_typed_data` and `on_payment` may be async. The object `evm_signer()` returns cannot be changed in place; to wrap signing (for logging or counting), build a new signer object that calls it:

```python
class LoggingSigner:
    namespace = "eip155"

    def __init__(self, base):
        self.base, self.address = base, base.address

    def sign_typed_data(self, typed_data):
        print("signing", typed_data["primaryType"])
        return self.base.sign_typed_data(typed_data)
```

### Retrying safely

Every call has an idempotency key: yours (`idempotency_key=`) or one the SDK creates. Every `AssayError` raised by `tools.call` carries it as `err.idempotency_key`. Calling again with that key is safe: Assay replays a call it already served and does not charge twice.

```python
from goassay import errors

try:
    res = assay.tools.call("weather_forecast", {"city": "Lisbon"})
except errors.AssayError as e:
    if not (e.retryable and e.idempotency_key):
        raise
    res = assay.tools.call("weather_forecast", {"city": "Lisbon"}, idempotency_key=e.idempotency_key)
```

For work you may redo after a restart, pass your own key (for example `f"order-{order_id}-weather"`).

### Spend limits

With a signer, every voucher is checked against local limits before it is signed:

- **Defaults: $0.50 per call and $5 per rolling 24 hours**, per signing key.
- Change them with `limits={"max_per_call": ..., "max_per_day": ...}` (dollars, as strings). The keys are snake_case in Python; the Node SDK spells them `maxPerCall` and `maxPerDay`.
- The record is in memory, per process, and safe across threads: a restart starts again at zero, and several processes each have their own. The on-chain caps that the payer set when approving the key bound it across processes.

`on_payment(details)` sees each payment (tool, network, amount, provider, payer, idempotency key) after every check passed and before it is signed. Use it for your own rules, for example an allow-list of providers:

```python
allowed = {"eip155:<chainId>:<provider address>"}
assay = Assay(signer=signer, on_payment=lambda p: p["provider"] in allowed)
```

Answer quickly: the voucher's lifetime (at most 240 s) starts before the hook runs.

### Networks

Payments are checked against a network table the client holds (escrow, asset, decimals and RPC URLs per network), never against what the server says, so a compromised API cannot redirect a payment.

- The SDK ships a built-in table, pinned in the release; an address change ships as a new SDK release. It holds Robinhood Chain testnet (`eip155:46630`), the network Assay's production runs on today: the USDG escrow `0x2723…Ce18`, 6 decimals, and two public RPCs from different operators. A paid call or a bind on a network that is in no table is refused with `PaymentNetworkUnknownError`, which names the network.
- `networks=` configures any chain yourself: a test chain, or another deployment together with its own `mcp_url`, `api_url` and `web_url`. Your entries are merged over the built-in table. A new network is added; an entry for a built-in network replaces it whole, so fields are never mixed from two deployments.
- `rpc_urls={"eip155:<chainId>": ["https://your-rpc"]}` replaces only a network's RPC URLs, for example with your private RPC.

Addresses must be checksummed CAIP-10 / CAIP-19 ids on the network's chain. RPC URLs must be https (plain http only to localhost).

```python
assay = Assay(
    mcp_url="https://mcp.your-deployment.example/",
    api_url="https://api.your-deployment.example/api/v1",
    web_url="https://portal.your-deployment.example",
    signer=signer,
    networks={
        "eip155:<chainId>": {
            # "chainId": optional; when given it must be the id in the key
            "escrow": "eip155:<chainId>:<escrow contract address>",
            "asset": "eip155:<chainId>/erc20:<token address>",
            "decimals": 6,
            "rpcUrls": ["https://<rpc 1>", "https://<rpc 2>"],
        }
    },
)
```

### Binding the key (once)

```python
status = assay.paid_calls.status()
if status.state != "active":
    setup = assay.paid_calls.bind()  # challenge, field check, sign, bind
    print(f"Approve at {setup.approval_url}; the page must show {setup.fingerprint}")
    assay.paid_calls.wait_until_active(timeout=15 * 60)
```

If another key is already bound to the API key, `bind()` answers `bind_status == "PENDING_APPROVAL"`: the old key stays `delegate` and keeps signing, this key is `pending_delegate`, and it replaces the old one only when the person approves it. `wait_until_active()` returns once `delegate` is this client's key and its paid calls are on. A key that is bound to another API key is refused with `DelegateAlreadyBoundError` (409). If another key wins a first bind at the same moment, `bind()` raises `DelegateBindConflictError` (409, `retryable`): nothing was bound, and calling `bind()` once more parks this key as `pending_delegate` (`bind_status == "PENDING_APPROVAL"`) for the person to approve.

The approval link is built on the web app's origin (`web_url`, default `https://portal.goassay.ai`). A link the server sends is used only when it is on that same origin. The key's address travels only in the URL fragment. The approval cannot be automated: a person opens the link and compares the fingerprint.

## Reading a receipt

Only a paid call has a receipt to fetch. A free call's `res.receipt["intentId"]` is `None`: it has no intent, and `res.receipt` already says it cost nothing.

```python
intent_id = res.receipt.get("intentId") if res.receipt else None
if intent_id:
    receipt = assay.receipts.get(intent_id)
    receipt["chargedPrice"]  # {"amount": "100000", "asset": "eip155:...", "decimals": 6}
```

## Handling errors

Every error is an `AssayError` with a stable `code`. Branch on the class or the code, never on the message. A missing scope is a `ScopeMissingError` naming `required_scope`, on the MCP host and on the API alike; a key without `payments` that calls a paid tool gets a `ScopeMissingError` naming `payments`, and nothing is signed or sent again; a route only a signed-in person may use is a `HumanSessionRequiredError` (an `AuthError`).

```python
from goassay import errors

try:
    assay.tools.call("weather_forecast", {"city": "Lisbon"})
except errors.ScopeMissingError as e:
    print(f"the API key needs the {e.required_scope} scope")
except errors.HumanSessionRequiredError:
    print("only a signed-in person can do this")
except errors.McpUrlNotFoundError:
    print("this MCP URL is not served to this key")
except errors.PaymentRequiredError:
    print("paid tool: pass a signer")
except errors.PaymentNetworkUnknownError as e:
    print(f"network {e.network} is not supported yet")
except errors.PaymentRefusedError as e:
    print(f"refused before signing by {e.guard}: {e.code}")
except errors.RateLimitError as e:
    print(f"retry in {e.retry_after} s")
except errors.AssayError as e:
    print(e.code, e.message)
```

A `PaymentRequiredError` carries the server's `hint` (what to do next, for example open an escrow) when the server sent one; it is also at the end of the message.

## Options

| Option | Default |
|---|---|
| `api_key` | `ASSAY_API_KEY` |
| `mcp_url`, `api_url`, `web_url` | `https://mcp.goassay.ai/` (a URL or a path; see "Choose a URL"), `https://api.goassay.ai/api/v1`, `https://portal.goassay.ai` |
| `signer` / `signers` | none (free calls only) |
| `limits` | `{"max_per_call": "0.50", "max_per_day": "5"}` |
| `rpc_urls` | the table's public RPC URLs |
| `networks` | the built-in table; yours are merged over it |
| `on_payment` | none |
| `http_client` | a new `httpx.Client` (`httpx.AsyncClient` for `AsyncAssay`) |
| `timeout` | 120 s per attempt (httpx applies it to each of connect, read, write and pool) |
| `max_retries` | 2, with backoff, honouring `Retry-After` |
| `logger` | none; never logs keys, headers, bodies or signatures |
| `now`, `sleep` | the system clock (corrected by the server's `Date` for vouchers), `time.sleep` / `asyncio.sleep` |

## Development

```sh
python -m venv .venv && . .venv/bin/activate
pip install -e '.[dev]'
ruff check . && ruff format --check .
mypy
pytest
```

The tests run the shared vectors in [`vectors/`](https://github.com/assay-ai/assay-sdk/tree/main/vectors) (`vectors/eip155/`) and unit tests on a fake transport.

## License

MIT, see [LICENSE](https://github.com/assay-ai/assay-sdk/blob/main/python/LICENSE).
