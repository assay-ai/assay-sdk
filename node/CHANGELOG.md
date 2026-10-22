# Changelog

All notable changes to `@goassay-ai/sdk` are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package uses [Semantic Versioning](https://semver.org/); before 1.0 a minor version may change the API.

## 0.2.0 - 2026-10-23

Additive: nothing changes for code written against 0.1.0.

### Added

- `@goassay-ai/sdk/core` surface for tools built on the protocol (assay-mcp):
  - `checkAll(ctx, opts?)` and `guardAndBuild(ctx, issuedAt, networks, opts?)` take `GuardOptions`: `paidUrlPolicy` runs G11 (`G11_URL_NOT_PAID`) after G10, `payerChangedReason` replaces the G4 payer-changed text, `signerRefusal: "throw"` rethrows a `SignerRefusal` instead of returning a G1 refusal. `guardAndBuild` now checks `issuedAt` before the guards. `GUARD_ORDER_ALL` lists G1 to G12.
  - `eip155Networks` and `networkEntriesFrom(table, { skip })`, which builds a network table entry by entry and can leave out entries such as placeholders.
  - Pure `_meta` helpers: `paymentState`, `DEBT_CODE`, `prepareCallParams`, `withVoucher`, `providerIdOf`, `quotesFromList`, `quotesFromSearch`, `quoteFromGetTool`, `paidToolOf`, `enablePaidLink`, `serverApprovalLink`, and the `VoucherEnvelope` type.
  - `CODES`: the server error codes such a tool reacts to.
- The shared test vectors ship in the package as `@goassay-ai/sdk/vectors/*`, with the `backend-cast-golden` voucher case restored (Robinhood Chain testnet, cross-checked with foundry cast and the backend's verifier).

### Fixed

- `PaymentRequiredError` keeps the server's `hint` (what to do next, for example open an escrow) as `err.hint` and at the end of the message, instead of dropping it.

## 0.1.0 - 2026-10-22

First public release.

### Added

- `Assay` client: API key from the `apiKey` option or `ASSAY_API_KEY`; ESM only, Node 22 or newer.
- Tools over MCP: `tools.search`, `tools.get`, `tools.list`, `tools.call`, with the receipt of each call.
- MCP URLs: `mcpUrl` takes a full URL or a path on `https://mcp.goassay.ai` (`/`, `/my/{slug}`, `/@{handle}/{slug}`, `/u/{token}`, `/c/{category}`, `/@{handle}`, with `?tools=`, `?category=`, `?free=1`, `?discovery=` filters), checked when the client is built; `assay.at()` returns a sibling client that shares the key, signers, limits and ledger. Link-only tokens are redacted in `toString`, `toJSON` and logs.
- Paid calls signed by a signer you pass (`evmSigner(viemAccount)` or your own object, for example KMS-backed); the SDK never stores keys.
- Local spend limits per signing key (defaults $0.50 per call, $5 per rolling 24 hours) and an `onPayment` hook that can refuse a payment before it is signed.
- Client-held network table (`networks`, `rpcUrls`): payments are checked against it, never against what the server says. The built-in table pins Robinhood Chain testnet (`eip155:46630`).
- Payment-key setup: `paidCalls.status`, `paidCalls.bind`, `paidCalls.waitUntilActive`, including rebinding a new key that waits for approval.
- Receipts: `receipts.get`.
- Safe retries: every call carries an idempotency key (yours or generated), returned on every error as `err.idempotencyKey`.
- Typed errors under `AssayError` (`AuthError`, `ScopeMissingError`, `McpUrlNotFoundError`, `PaymentRefusedError`, `PaymentNetworkUnknownError`, `DelegateAlreadyBoundError`, `DelegateBindConflictError`, `RateLimitError`, `TimeoutError` and others), each with `retryable`.
- `@goassay-ai/sdk/core` subpath with the protocol building blocks, tested against the shared vectors in `vectors/`.
