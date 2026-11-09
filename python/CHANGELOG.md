# Changelog

All notable changes to `goassay` are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package uses [Semantic Versioning](https://semver.org/); before 1.0 a minor version may change the API.

## Unreleased

### Added

- `providers=` option: a provider allow-list (guard G8). Only vouchers that pay one of the listed provider payout addresses are signed. Default unchanged: any staked provider.

### Fixed

- The internal client context no longer prints the MCP URL's link token (`/u/{token}`) in its `repr`, for example in tracebacks that capture local variables.

## 1.2.0 - 2026-11-02

Channels are now used by default; a lane file is created at `~/Library/Application Support/goassay/channels/<address>.json` (macOS), `~/.config/goassay/channels/<address>.json` (Linux and other systems) or `%USERPROFILE%\AppData\Roaming\goassay\channels\<address>.json` (Windows), one file per signing key (`<address>` in lower case, mode 0600, with a `.lock` file next to it). The same file and lock are used by the Node and Python clients.

### Changed

- **Channel vouchers always on.** Every client with an eip155 signer now offers `assay/paymentSchemes: ["channel-v1", "voucher"]` and signs a channel voucher when the server offers a channel on a network whose entry says `channels: true`. There is no option to turn channels off. `channels=` now only chooses where the lanes are kept; without it the default lane file above is used (`default_channel_store_path(address)` / `default_channel_store(address)`). Pyodide (no durable file system) must pass `channels=`: the client raises `ConfigError` at construction otherwise.
- **Built-in mainnet entry has the channel door.** The built-in `eip155:4663` entry now says `channels: true`. An entry of your own (`networks=`, for example Robinhood Chain testnet, which is not built in) replaces the built-in one whole and must say `channels: true` itself to use channels.
- One process per lane file: a second process on the same signing key cannot take the lock and pays per call; give it its own store with `channels=` to use channels there too.
- A call still pays per call when no channel can be used: the server offers none, channels are paused for an hour after `CHANNEL_LIMIT`, `CHANNEL_SIGNER_EXPIRING`, `CHANNEL_NOT_OFFERED` or a burst of `CHANNEL_ROTATE`, the offer does not match the requirement or the client's own entry, the lane record cannot be read or written, or the chain read of a lane is not agreed.

## 1.1.0 - 2026-11-02

Additive and off by default: nothing changes for code written against 1.0.0. Channel vouchers are used only on a network entry that says `channels: true` (none of the built-in ones in this release) and only when the server offers a channel.

### Added

- **Channel vouchers (`channel-v1`, preview).** `channels=` option, `FileChannelStore(path)` and `MemoryChannelStore()`. The client then offers `assay/paymentSchemes: ["channel-v1", "voucher"]` and, when the server answers with a channel offer (`assay/channelRequired`) on a network whose entry says `channels: true`, signs the contract's `ChannelVoucher(address payer,address provider,bytes32 channelId,uint64 cumulative,uint32 calls,uint64 issuedAt,uint64 expiresAt)` under the escrow domain, sent as `assay/channelVoucher`. No built-in network has `channels: true` yet, so the built-in table still pays per call only.
  - Every guard G1-G12 runs on the per-call requirement of the same answer first; the offer must then match it (payer, provider, provider id, payment key, price) and name exactly the client's own escrow domain. Any other offer is never signed: the call is paid per call.
  - The next total on a lane is the client's own persisted `maxSigned + price` (never a server value), written to the store before the signature. The 24 h limit counts only what each voucher adds.
  - Before a lane is continued after a restart or 10 minutes, its record is checked against `channelBooks(key, payer)` on every RPC at one pinned block; a record behind the chain is retired and a new lane opened. Without an agreed read the call is paid per call.
  - At most one voucher per logical call. `CHANNEL_ROTATE`: the lane is retired and a retryable `PaymentError` (`CHANNEL_ROTATE`) is raised; the next call opens a new lane; five rotations within an hour stop channel offers for an hour. `CHANNEL_LIMIT`, `CHANNEL_SIGNER_EXPIRING`, `CHANNEL_NOT_OFFERED`: a retryable `PaymentError` with that code, the lane is re-armed, and channels are not offered for an hour (calls are paid per call meanwhile). Any other refusal, or no answer, retires the lane.
  - A re-armed pair is re-signed (an increase of 0) only while its first signature could still settle and is under 24 h old; otherwise the lane is retired and a new one opened and counted. At most 16 retired lanes are kept per pool.
  - Integers in the server's offer, the debt list and the lane record are read as the Node client reads them: an integral float (`240.0`, `3e0`) is the integer; a fraction, a bool, or anything above 2^53 - 1 is refused. Both clients accept and refuse the same values.
  - The lane file's lock appears with its content at once (hard link of a temporary file); a lock of a dead process is taken over by one atomic rename and verified, so two processes clearing the same stale lock cannot both hold it. The folder is fsynced after each write. A forked child never inherits the parent's lock.
- **Channel-debt renew.** `paid_calls.renew_channel_debts()` (sync and async): for each `CHANNEL` debt of `GET /escrow/debts` (`OPEN` or `WRITTEN_OFF`), re-signs the debt's `(cumulative, calls)` pair with fresh times (240 s life) on the lane the debt names (`channel.channelId`) and sends it to `POST /escrow/debts/{intentId}/voucher` as `{ channelVoucher }`; one `DebtRenewal` per debt (`renewed`, `pending`, `per_call`, `no_lane`, `not_signed_here`, `rate_limited`, `refused`, `failed`). Signed only when that lane is the client's own (same network, escrow, payer and key) and the pair is renewable on it: signed there and served, or with no answer. Never a larger pair, a pair the server explicitly refused, or another lane; a debt without `channelId` is not renewed (`no_lane`). Not counted again toward the limits (it re-authorises a total already signed on that lane). At most one signature per lane and 8 requests per run; at most one renewing run a minute, manual or automatic (within it the debts are only listed). `tools.call` runs it after a paid call refused with `PAYMENT_DEBT_OUTSTANDING` (the call is not sent again) and raises a `PaymentError` (`PAYMENT_DEBT_OUTSTANDING`) saying what to do: being collected ("Assay is collecting an earlier payment your agent already signed. Paid calls usually resume within about 5 minutes. This call was not charged.", retryable), no payment record here ("Your agent no longer has the payment record for an earlier channel payment. Settle it in the Assay app at {WEB}/funding once it is offered there."), or only channel debts not renewed just now (retryable). With a per-call debt it is the server's refusal, as before. When one of the debts being collected is a per-call debt a person settled in the portal (a per-call `REPLACING` debt, also a channel debt moved to a per-call replacement), the text is the neutral "Assay is collecting an earlier payment. Paid calls usually resume within about 5 minutes. This call was not charged." (`DEBT_COLLECTING_TEXT`; such a `pending` result carries `format="PER_CALL"`). `DebtRenewal` is exported from `goassay`.
  - The lane record keeps the last 64 renewable pairs per lane (`renewable`: added when signed, removed when the server explicitly refuses the voucher; a record without it can renew only the top pair of a lane neither retired nor re-armed) and `renewedIssuedAt` (later vouchers never go below it). Retired lanes are kept 31 days after their last voucher expired (was 3 hours), so a debt can outlive its lane; still at most 16 per pool. A memory store cannot renew a debt after its process ended.
  - `PAYMENT_DEBT_OUTSTANDING` on a channel voucher re-arms the lane (nothing was stored) instead of retiring it.
  - A spend-policy refusal of a channel voucher made before the server stores it re-arms the lane (the retry signs the same pair on the same lane) instead of retiring it: `MCP_VELOCITY_LIMIT_EXCEEDED` with `reason` `DUPLICATE_REQUEST`, `CALLS_PER_MINUTE`, `CALLS_PER_HOUR` or `SPEND_PER_HOUR`, `MCP_SPEND_LIMIT_EXCEEDED`, `MCP_POLICY_AGENT_PAUSED` and `MCP_APPROVAL_REQUIRED`. Keyed on code and reason: `UNAVAILABLE` (may come after the store), another or no reason still retires the lane. The refused pair is not renewable, as for any refusal. Node and Python behave the same.
  - A `CHANNEL` debt of another wallet of the same organization (its `payer` is not the list's `account`; the paid-call refusal is organization-wide) is never signed (`other_wallet`), and the agent reads "Another wallet in your organization owes an earlier payment. Paid calls resume once it is settled by that wallet's agent or in the Assay app. This call was not charged." A renew refused for good (`CHANNEL_DESYNC`, `CHANNEL_NOT_OFFERED`, `CHANNEL_SIGNER_EXPIRING`, voucher binding/signature/malformed/delegate codes) gives the portal text instead of "Call again in a minute or two".
- `PaymentUnsettledLimitError` for `PAYMENT_UNSETTLED_LIMIT` (retryable, `retry_after`). A wait of up to 60 s is resent as is; nothing was charged.
- Chain reads also return the payment key's window cap (`delegateMaxPerWindow`), used to rotate a lane before one settlement could pass it.
- Network entries accept `channels` (boolean, default `false`).
- `vectors/eip155/channel.json`: the `ChannelVoucher` typed data, hashes and channel key computed from the contract, the lane arithmetic and the offer checks; `spec/protocol.md` section 12.

## 1.0.0 - 2026-10-27

### Changed

- **Production moved to Robinhood Chain mainnet.** The built-in network table now holds `eip155:4663` only: the AssayEscrow `0xe54E0142b1D0d34226498D563A16074C81Bc9A5e`, USDG `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (6 decimals) and two public RPCs from different operators (`https://rpc.mainnet.chain.robinhood.com`, `https://robinhood-rpc.publicnode.com`). Robinhood Chain testnet (`eip155:46630`) is no longer built in: a paid call or a bind against a testnet deployment needs a `networks=` entry for it. Earlier releases are testnet builds.

### Added

- The `robinhood-mainnet-escrow` voucher vector, signed for the mainnet escrow; its domain separator equals the escrow's on-chain `DOMAIN_SEPARATOR()`.

## 0.1.3 - 2026-10-26

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
