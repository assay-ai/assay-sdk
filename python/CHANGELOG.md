# Changelog

All notable changes to `goassay` are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package uses [Semantic Versioning](https://semver.org/); before 1.0 a minor version may change the API.

## Unreleased

### Fixed

- Chain reads of the payment key's grant (G4, G6) accept RPCs up to 120 blocks apart (`MAX_BLOCK_SPREAD`, was 5; about 20 s on Robinhood Chain). The two public RPCs are often 10 to 40 blocks apart, so about half of the reads failed and paid calls were refused right after a grant. Reads still run at one explicit pinned block, `min(heights) - 1`, on every RPC, and the answers must be byte-identical.
- A transient chain-read failure (an RPC error or timeout, or heights too far apart) runs the whole read again: 3 attempts in all, after 300 ms and 1 s, and no new attempt starts 5 s after the first. A disagreement at the pinned block is final and is not retried. Failures are still not cached.
- The `G4_NO_CHAIN_READ` refusal now says to try again in a minute.

## 0.1.2 - 2026-10-25

### Fixed

- The built-in `eip155:46630` network now names the redeployed production escrow `0xE68A6E2810027dB5da48c2110bd3993eD8177115`. The previous release pinned the escrow of the first production deployment, which is no longer used, so paid calls on the built-in table were refused.

## 0.1.1 - 2026-10-23

### Fixed

- `PaymentRequiredError` keeps the server's `hint` (what to do next, for example open an escrow) as `err.hint` and at the end of the message, instead of dropping it.

### Changed

- `vectors/eip155/vouchers.json` has the `backend-cast-golden` case again (Robinhood Chain testnet, cross-checked with foundry cast and the backend's verifier); the Python tests run it.

## 0.1.0 - 2026-10-22

First public release.

### Added

- `Assay` and `AsyncAssay` clients: API key from the `api_key` argument or `ASSAY_API_KEY`; Python 3.10 or newer, fully typed (`py.typed`).
- Tools over MCP: `tools.search`, `tools.get`, `tools.list`, `tools.call`, with the receipt of each call.
- MCP URLs: `mcp_url` takes a full URL or a path on `https://mcp.goassay.ai` (`/`, `/my/{slug}`, `/@{handle}/{slug}`, `/u/{token}`, `/c/{category}`, `/@{handle}`, with `?tools=`, `?category=`, `?free=1`, `?discovery=` filters), checked when the client is built; `assay.at()` returns a sibling client that shares the key, signers, limits and ledger. Link-only tokens are redacted in `repr` and logs.
- Paid calls signed by a signer you pass (`evm_signer(eth_account)` or your own object, for example KMS-backed); the SDK never stores keys.
- Local spend limits per signing key (defaults $0.50 per call, $5 per rolling 24 hours) and an `on_payment` hook that can refuse a payment before it is signed.
- Client-held network table (`networks`, `rpc_urls`): payments are checked against it, never against what the server says. The built-in table pins Robinhood Chain testnet (`eip155:46630`).
- Payment-key setup: `paid_calls.status`, `paid_calls.bind`, `paid_calls.wait_until_active`, including rebinding a new key that waits for approval.
- Receipts: `receipts.get`.
- Safe retries: every call carries an idempotency key (yours or generated), returned on every error as `err.idempotency_key`.
- Typed errors under `AssayError` (`AuthError`, `ScopeMissingError`, `McpUrlNotFoundError`, `PaymentRefusedError`, `PaymentNetworkUnknownError`, `DelegateAlreadyBoundError`, `DelegateBindConflictError`, `RateLimitError`, `TimeoutError` and others), each with `retryable`.
