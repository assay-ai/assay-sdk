# goassay

The Python SDK for [Assay](https://goassay.ai): call tools over MCP, with free calls and paid calls signed by a key you hold.

**Status: pre-release.** This package is not published yet, and its API can still change.

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
    res.is_error            # True only for the provider's own tool error
    res.receipt             # what the call cost
```

## Paid call with a local key

The SDK never stores or creates keys. You pass a signer; for a local key, wrap an eth-account account:

```python
import os

from eth_account import Account
from goassay import Assay, evm_signer

assay = Assay(
    signer=evm_signer(Account.from_key(os.environ["PAYMENT_KEY"])),
    # Your own table of payment networks. Paid calls are checked against it, never against the server.
    networks={
        "eip155:<chainId>": {
            "escrow": "eip155:<chainId>:<escrow address>",
            "asset": "eip155:<chainId>/erc20:<token address>",
            "decimals": 6,
            "rpc": ["https://<rpc 1>", "https://<rpc 2>"],
        }
    },
    limits={"max_per_call": "0.50", "max_per_day": "5"},  # dollars; these are the defaults
    on_payment=lambda p: int(p["amount"]["amount"]) <= 100_000,  # your own rule; False refuses
)

res = assay.tools.call("weather_forecast", {"city": "Lisbon"}, idempotency_key=f"order-{order_id}-weather")
```

On a paid tool the server answers `PAYMENT_REQUIRED`. The SDK then checks the requirement with its local guards (G1 to G12, including the chain reads of your key's grant), calls `on_payment`, signs one voucher, and sends the same call again with the same idempotency key. Network retries resend the same request; a voucher is never signed twice for one attempt. Calling again with the same `idempotency_key` is safe: Assay replays the stored result and does not charge twice.

A signer is any object with `namespace = "eip155"`, `address` and `sign_typed_data(typed_data)`, so a KMS or HSM key works the same way. With `AsyncAssay`, `sign_typed_data` and `on_payment` may be async.

### Binding the key (once)

```python
status = assay.paid_calls.status()
if status.state != "active":
    setup = assay.paid_calls.bind()  # challenge, field check, sign, bind
    print(f"Approve at {setup.approval_url}; the page must show {setup.fingerprint}")
    assay.paid_calls.wait_until_active(timeout=15 * 60)
```

The approval cannot be automated: a person opens the link and compares the fingerprint.

## Reading a receipt

```python
receipt = assay.receipts.get(res.receipt["intentId"])
receipt["chargedPrice"]  # {"amount": "100000", "asset": "eip155:...", "decimals": 6}
```

## Handling errors

Every error is an `AssayError` with a stable `code`. Branch on the class or the code, never on the message.

```python
from goassay import errors

try:
    assay.tools.call("weather_forecast", {"city": "Lisbon"})
except errors.ScopeMissingError as e:
    print(f"the API key needs the {e.required_scope} scope")
except errors.PaymentRequiredError:
    print("paid tool: pass a signer")
except errors.PaymentRefusedError as e:
    print(f"refused before signing by {e.guard}: {e.code}")
except errors.RateLimitError as e:
    print(f"retry in {e.retry_after} s")
except errors.AssayError as e:
    print(e.code, e.message)
```

## Options

| Option | Default |
|---|---|
| `api_key` | `ASSAY_API_KEY` |
| `mcp_url`, `api_url` | `https://mcp.goassay.ai/`, `https://api.goassay.ai/api/v1` |
| `signer` / `signers` | none (free calls only) |
| `networks` | none (needed for paid calls) |
| `limits` | `{"max_per_call": "0.50", "max_per_day": "5"}` |
| `on_payment` | none |
| `http_client` | a new `httpx.Client` (`httpx.AsyncClient` for `AsyncAssay`) |
| `timeout` | 120 s per attempt |
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

The tests run the shared vectors in [`../vectors`](../vectors) (`vectors/eip155/`) and unit tests on a fake transport.

## License

MIT, see [LICENSE](LICENSE).
