# Changelog

All notable changes to `goassay` are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package uses [Semantic Versioning](https://semver.org/); before 1.0 a minor version may change the API.

## 0.1.0 - 2026-10-22

First public release.

### Added

- `Assay` and `AsyncAssay` clients: API key from the `api_key` argument or `ASSAY_API_KEY`; Python 3.10 or newer, fully typed (`py.typed`).
- Tools over MCP: `tools.search`, `tools.get`, `tools.list`, `tools.call`, with the receipt of each call.
- MCP URLs: `mcp_url` takes a full URL or a path on `https://mcp.goassay.ai` (`/`, `/my/{slug}`, `/@{handle}/{slug}`, `/u/{token}`, `/c/{category}`, `/@{handle}`, with `?tools=`, `?category=`, `?free=1`, `?discovery=` filters), checked when the client is built; `assay.at()` returns a sibling client that shares the key, signers, limits and ledger. Link-only tokens are redacted in `repr` and logs.
- Paid calls signed by a signer you pass (`evm_signer(eth_account)` or your own object, for example KMS-backed); the SDK never stores keys.
- Local spend limits per signing key (defaults $0.50 per call, $5 per rolling 24 hours) and an `on_payment` hook that can refuse a payment before it is signed.
- Client-held network table (`networks`, `rpc_urls`): payments are checked against it, never against what the server says. The built-in table is empty until production values are released.
- Payment-key setup: `paid_calls.status`, `paid_calls.bind`, `paid_calls.wait_until_active`, including rebinding a new key that waits for approval.
- Receipts: `receipts.get`.
- Safe retries: every call carries an idempotency key (yours or generated), returned on every error as `err.idempotency_key`.
- Typed errors under `AssayError` (`AuthError`, `ScopeMissingError`, `McpUrlNotFoundError`, `PaymentRefusedError`, `PaymentNetworkUnknownError`, `DelegateAlreadyBoundError`, `DelegateBindConflictError`, `RateLimitError`, `TimeoutError` and others), each with `retryable`.
