# Assay paid-call protocol, version 1 (draft)

Status: **draft**. This document can still change before the v1 freeze. Changes are listed in the repository history of this file.

This document describes how a client calls tools through Assay over MCP (Model Context Protocol) and pays for paid tools with a signed voucher. It is written so that a client can be built in any language from this text and the test vectors in [`../vectors`](../vectors).

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## 1. Conventions

- **Times** are Unix seconds (integers), UTC.
- **Integers that can exceed 2^53** (amounts, `seq`) are sent as canonical decimal strings: digits only, no sign, no leading zero (except `"0"`), no spaces.
- **Chains** are CAIP-2 ids. Only `eip155:<chainId>` is in scope for this version.
- **Accounts** are CAIP-10 (`eip155:<chainId>:<address>`), with an EIP-55 checksummed address, when they come from the server.
- **Assets** are CAIP-19 erc20 ids (`eip155:<chainId>/erc20:<checksummed address>`).
- **Money** is `{"amount": "<atomic units, decimal string>", "asset": "<CAIP-19>", "decimals": <integer>}`. A dollar value of `"0.50"` in an asset with 6 decimals is `"500000"`. Implementations MUST convert with exact integer arithmetic, never floating point.
- **Hex** byte strings are `0x`-prefixed. Digests and signatures in the vectors are lower case.

## 2. Hosts and authentication

| Purpose | Production origin |
|---|---|
| MCP endpoint | `https://mcp.goassay.ai/` |
| REST API | `https://api.goassay.ai/api/v1` |
| Web app (key approval) | `https://portal.goassay.ai` |

- Every request carries `Authorization: Bearer <API key>`. The API key is created in the Assay web app for one agent.
- Permissions live on the key as scopes. A request that needs a scope the key does not have is refused with HTTP `403`, error code `AUTH_SCOPE_MISSING` and `error.context.requiredScope` naming the scope, in the REST envelope (section 2.2). On the MCP endpoint this refusal is a plain HTTP `403` with that REST envelope, sent before any JSON-RPC is read: a client MUST read a non-JSON-RPC answer as a REST error.
- A key without the `payments` scope (free calls only) that calls a paid tool is refused on the paid path itself, before any payment requirement is offered and whether or not a voucher was sent: a tool result with `isError: true` and `_meta["assay/error"]` = `{ "code": "AUTH_SCOPE_MISSING", "requiredScope": "payments", "retryable": false }` (here `requiredScope` sits on `assay/error` itself). The client MUST surface it as a scope error and MUST NOT sign, re-sign or resend: only a new key with `payments` fixes it.
- A route that changes the controls over an agent (its spend policy, its keys, where its alerts go) is refused to every API key with HTTP `403` and `AUTH_HUMAN_SESSION_REQUIRED`: only a person signed in to the web app may do it.

  | Scope | Allows |
  |---|---|
  | `tools:call` | `tools/list` and `tools/call` over MCP |
  | `payments` | paid calls, and binding a payment key (section 5) |
  | `activity:read` | reading receipts, calls and spend |
  | `reports:write` | reporting a bad result |

- A client MUST send the API key only to the MCP and API origins of the environment it was configured for. It MUST NOT follow redirects with the key attached.

### 2.1 MCP transport

- `POST` of one JSON-RPC 2.0 request to the MCP endpoint; `Content-Type: application/json`; `Accept: application/json, text/event-stream`. The answer is one JSON-RPC response. No session and no server-sent events are needed.
- The client sends the MCP protocol revision it speaks in the `MCP-Protocol-Version` header.
- The methods a client needs are `tools/list` and `tools/call`. The meta tools `search_tools` and `get_tool` (find a tool, read its schemas and price) are called through `tools/call`.
- JSON-RPC error `-32029` means rate limited. Its `data` carries `code: "RATE_LIMITED"` and MAY carry `retryAfterMs`.

### 2.2 REST envelope

- A success answer is `{"data": <value>}`.
- A failure answer is `{"success": false, "error": {"code": "<CODE>", "message": "<text>", "statusCode": <status>, ...}}`. Clients branch on `error.code`, never on the message.

### 2.3 MCP URLs

The MCP host serves the same transport on every URL below; the URL chooses which tools a connection sees. One API key works on every URL.

| Path | Serves |
|---|---|
| `/` | Everything: the whole listed catalogue (lists `search_tools`, `get_tool`, `call_tool` and a few tools) |
| `/my/{slug}`, `/my/{slug}@{n}` | Your organisation's tool set: the live Draft, or published version `n` |
| `/@{handle}/{slug}`, `/@{handle}/{slug}@{n}` | A public tool set: the latest public version, or version `n` |
| `/u/{token}`, `/u/{token}@{n}` | A link-only tool set. The token is a secret: a client MUST NOT print or log it |
| `/c/{category}` | Every listed tool in one topic |
| `/@{handle}` | Every listed tool of one maker (`{handle}__{tool}` names only) |

Grammar: `slug` `[a-z0-9-]{2,64}`, `handle` `[a-z][a-z0-9-]{2,23}`, `category` `[a-z][a-z0-9-]{1,63}`, `token` `[a-z0-9_-]{22,64}`, `n` `[1-9][0-9]{0,5}`. The path is read lowercased, `%40` as `@`, one trailing slash dropped; `//`, `.`, `..` and other percent-escapes are refused, and the URL is at most 2,048 characters.

Query filters, on any path, only narrow what the URL serves: `tools=a,b` (at most 50 names; `name@N` pins a contract major; one name gives a single-tool URL), `category=x,y`, `free=0|1` (`free=1` keeps only free tools and never charges a call), `discovery=auto|full|search`.

- A URL the host does not serve, or does not serve to this key, is HTTP `404` with `MCP_URL_NOT_FOUND` in the REST envelope (section 2.2), before any JSON-RPC is read.
- The `tools/list` result's `_meta` MAY carry `assay/toolsetVersion`, `assay/sharingEnds`, `assay/renamed` and `assay/ignoredTools` (`tools=` names this URL does not serve).
- The same tool can quote a different `assay/price` on two URLs (a tool set's entry rules apply), so a client keeps its quotes per URL.
- Tool names are standard `verb_noun` names, or a provider tool's `{handle}__{tool}` (at most 48 characters; the first `__` separates the handle). A client sends names unchanged. A handle rename renames its tools, so read names from `tools/list` or `search_tools` rather than hard-coding them.

## 3. Calling a tool

A tool call is an MCP `tools/call` request. Assay reads and writes extra fields in `params._meta` (request) and `result._meta` (answer).

| `_meta` key | Where | Meaning |
|---|---|---|
| `assay/idempotency-key` | request | Names one logical call (section 8) |
| `assay/rail` | request | `"B"` asks for a voucher requirement on a chain that also offers another rail |
| `assay/voucher` | request | The signed voucher envelope (section 6.4) |
| `x402/paymentRequired` | result | The payment requirement (section 4) |
| `assay/error` | result | A machine-readable refusal (section 10.2) |
| `assay/receipt` | result | What the call cost (section 10.1) |
| `assay/replayed` | result | `true` when the result is a stored replay (section 8) |
| `assay/price` | `tools/list` item | The quoted price of a tool |

### 3.1 Free call

1. The client sends `tools/call` with `name`, `arguments` and, SHOULD, an `assay/idempotency-key`.
2. The server answers with the tool result and an `assay/receipt` whose `charged` amount is zero.

### 3.2 Paid call (rail B, voucher)

1. The client sends `tools/call` with an `assay/idempotency-key` and, optionally, `assay/rail: "B"`. It sends no voucher.
2. The server answers with `isError: true`, `_meta["assay/error"].code = "PAYMENT_REQUIRED"` and the requirement in `_meta["x402/paymentRequired"]`. Nothing is charged, and the idempotency key is released for the next step.
3. The client checks the requirement (section 9), builds the voucher (section 6) from the requirement and its own corrected clock (section 7), and signs it with its payment key. The payment key MUST already be bound (section 5).
4. The client sends the **same** `tools/call` again: the same `name`, the same `arguments` and the same `assay/idempotency-key`, plus `assay/voucher`.
5. The server checks the voucher, serves the call and answers with the tool result and an `assay/receipt`.

A client MUST sign at most one voucher per logical call. If the signed retry fails on the network, the client resends the same envelope; it MUST NOT sign again for that attempt (section 8).

A client MUST remove any `assay/voucher` or `assay/rail` it did not build itself before sending a request (for example when forwarding a request from another program).

## 4. The payment requirement

`_meta["x402/paymentRequired"]` on a rail-B refusal:

| Field | Type | Meaning |
|---|---|---|
| `rail` | `"B"` | Voucher rail |
| `scheme` | `"voucher"` | |
| `network` | CAIP-2 | Chain the voucher is for |
| `payer` | CAIP-10 | The agent's escrow owner, who pays |
| `payTo` | CAIP-10 | The escrow contract. It is the EIP-712 `verifyingContract` |
| `provider` | CAIP-10 | The provider account paid by this voucher |
| `providerId` | string, 1 to 256 characters | Echoed in the envelope so the retry reaches the same provider |
| `amount` | Money | The exact price. A voucher is signed for exactly this amount |
| `contractVersion` | positive integer, optional | Echoed in the envelope; the retry is served at this version or refused |
| `resource` | string | The resource paid for: `/mcp/tools/<tool name>` |
| `requestHash` | `sha256:<64 hex>` | The server's hash of this call. Clients sign it as given and do not recompute it |
| `seq` | decimal string | A sequence number the server allocated for this voucher |
| `maxTimeoutSeconds` | integer, 1 to 300 | The longest voucher window the server accepts |
| `signers` | array of `"payer"`, `"delegate"` | Who may sign. A bound payment key signs as `"delegate"` |
| `delegate` | CAIP-10 or `null` | The payment key bound to this API key's credential |

## 5. Binding a payment key

A payment key ("delegate") is an EVM key the client holds. The payer authorises it on chain, inside the payer's caps. Before its first paid call, the key is bound to the API key's credential by proving possession, then a person approves it in the Assay web app.

### 5.1 Challenge

`POST {api}/agents/me/delegate/challenge` with body `{"delegate": "<0x address>"}` answers:

```json
{
  "data": {
    "challengeId": "<uuid>",
    "delegate": "eip155:<chainId>:<address>",
    "expiresAt": "<ISO 8601>",
    "typedData": {
      "domain": { "name": "GoAssay Agent Binding", "version": "1", "chainId": "<chainId>" },
      "types": {
        "DelegateBinding": [
          { "name": "delegate", "type": "address" },
          { "name": "credentialId", "type": "string" },
          { "name": "nonce", "type": "string" },
          { "name": "expiresAt", "type": "uint64" }
        ]
      },
      "primaryType": "DelegateBinding",
      "message": { "delegate": "<address>", "credentialId": "<uuid>", "nonce": "<string>", "expiresAt": "<unix seconds>" }
    }
  }
}
```

Integers in the challenge MAY be JSON numbers or decimal strings.

### 5.2 Checks before signing

The client MUST NOT sign the server's typed data as received. It checks every field, then signs typed data it rebuilt from its own constants. The first failing field is reported:

- `domain` has exactly the keys `name`, `version`, `chainId`: `name` is `"GoAssay Agent Binding"`, `version` is `"1"`, `chainId` is the chain id of the network the client is configured for. No `verifyingContract`, no `salt`.
- `primaryType` is `"DelegateBinding"`. `types` has only `DelegateBinding` (no `EIP712Domain`), with exactly the four fields above, in that order, each with only `name` and `type`.
- `message` has exactly the keys `delegate`, `credentialId`, `nonce`, `expiresAt`.
- `message.delegate` is the client's own key address (compared after checksumming).
- `message.credentialId` is the client's credential id.
- `message.nonce` is a string of 1 to 256 characters.
- `message.expiresAt` is a uint64 with `now < expiresAt <= now + 300`, where `now` is the corrected clock (section 7). On a failure of this check only, the client MAY ask for one fresh challenge and try once more.
- `challengeId` is a UUID.

The EIP-712 domain type is `EIP712Domain(string name,string version,uint256 chainId)`. The struct type is `DelegateBinding(address delegate,string credentialId,string nonce,uint64 expiresAt)`.

### 5.3 Bind

`POST {api}/agents/me/delegate` with body `{"challengeId": "<uuid>", "signature": "<0x 65-byte signature>"}` answers:

```json
{
  "data": {
    "credentialId": "<uuid>",
    "status": "ACTIVE | PENDING_APPROVAL",
    "delegate": "eip155:<chainId>:<address> | null",
    "boundAt": "<ISO 8601> | null",
    "pendingDelegate": "eip155:<chainId>:<address> | null",
    "pendingSince": "<ISO 8601> | null",
    "approvalUrl": "<url> | null"
  }
}
```

- `ACTIVE`: no other key was bound; the client's key is `delegate` now. `data.delegate` MUST name the client's key (CAIP-10 on the configured chain).
- `PENDING_APPROVAL`: another key is bound and stays bound: it keeps signing, and `delegate` still names it. The client's key waits as `pendingDelegate`, which MUST name the client's key. It replaces `delegate` in one step when the person's on-chain approval (section 5.4) lands. A new key never silently replaces a bound one.
- Any other answer: the client treats the bind as failed.
- A `409` with code `ACCOUNT_DELEGATE_ALREADY_BOUND` means the key is bound (or pending) on another live credential; nothing was bound.
- A `409` with code `ACCOUNT_DELEGATE_BIND_CONFLICT` means another key was bound to this credential at the same moment (two first binds raced); nothing was bound. It is retryable once: a new challenge and bind then answer `PENDING_APPROVAL`, with the client's key as `pendingDelegate`. A client does not retry it on its own.

Binding needs the `payments` scope.

`GET {api}/agents/me/delegate` reads the current binding with the same fields (without `status`), plus `paidCalls` (the bound key's on-chain status: `NONE`, `ACTIVE` or `EXPIRED`, and its caps) and `paidCallsUnknown` (the chain could not be read just now). Paid calls are on for the client's key when `delegate` names it and `paidCalls.status` is `ACTIVE`. A client waiting for approval polls this route until then; while its key is `pendingDelegate`, the old key's `ACTIVE` status is not its own.

### 5.4 Approval

A person approves the bound key (or the pending key, when one waits) in the Assay web app, at:

```
{web origin}/agents/enable-paid?credential=<credential id>#key=<checksummed address>
```

`{web origin}` is the web app origin the client is configured with. A client builds this link itself; it MAY use a link the server sends only when that link is on the same origin and names the same credential. The address travels only in the URL fragment. The page shows the key's **fingerprint**, which the person compares with the one the client shows: the last 8 hex digits of the address, upper case, in two groups of 4 (for example `1A2B 9F3C`). The approval cannot be automated.

## 6. The voucher

### 6.1 EIP-712 domain

```
EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)
name              = "Assay Settlement"
version           = "2"
chainId           = the chain id of requirement.network
verifyingContract = the address of requirement.payTo (the escrow)
```

The client MUST take the chain id, escrow and asset from its own network table, never from the server, and MUST refuse a requirement whose `network` is not in that table or whose `payTo`, `amount.asset` or `amount.decimals` differ from it.

The network table is held by the client:

- the reference SDKs ship a built-in table pinned in each release (today: Robinhood Chain testnet, `eip155:46630`);
- the caller can configure further networks in code, for a test chain or another deployment. A configured entry for a network the built-in table has replaces that entry whole, so escrow and asset never come from two deployments;
- the caller can replace only a network's RPC URLs.

### 6.2 Struct

```
Voucher(address payer,address provider,uint64 amount,bytes32 resourceHash,bytes32 requestHash,uint64 seq,uint64 issuedAt,uint64 expiresAt)
```

The field order is part of the type hash and MUST NOT change.

| Field | Value |
|---|---|
| `payer` | address of `requirement.payer` |
| `provider` | address of `requirement.provider` |
| `amount` | `requirement.amount.amount` |
| `resourceHash` | `keccak256(utf8(requirement.resource))`; the resource is always hashed as a UTF-8 string, even when it starts with `0x` |
| `requestHash` | the 32 bytes of `requirement.requestHash` without `sha256:`; upper and lower case hex are the same bytes |
| `seq` | `requirement.seq` |
| `issuedAt` | the corrected clock (section 7) |
| `expiresAt` | `issuedAt + min(240, requirement.maxTimeoutSeconds)` |

`payer`, `payTo` and `provider` MUST be CAIP-10 accounts on `requirement.network`. `amount` and `seq` MUST fit uint64.

The digest is `keccak256(0x19 0x01 || domainSeparator || structHash)`, as in EIP-712. The signature is the 65-byte `r || s || v` secp256k1 signature of the digest, `v` in `{27, 28}`, hex encoded.

### 6.3 Wire voucher

The voucher as sent, built only from checked fields:

```json
{
  "payer": "<requirement.payer>",
  "payTo": "<requirement.payTo>",
  "provider": "<requirement.provider>",
  "amount": { "amount": "<atomic>", "asset": "<CAIP-19>", "decimals": 6 },
  "resource": "<requirement.resource>",
  "requestHash": "<requirement.requestHash, unchanged>",
  "seq": "<requirement.seq>",
  "issuedAt": 1785999800,
  "expiresAt": 1786000040
}
```

### 6.4 Envelope

`params._meta["assay/voucher"]` on the signed retry:

```json
{
  "voucher": { "...": "the wire voucher" },
  "signature": "0x...",
  "providerId": "<requirement.providerId>",
  "contractVersion": 3
}
```

`contractVersion` is present only when the requirement had one (a positive integer).

### 6.5 Server checks

For diagnosis, the server refuses a voucher when, among others: `expiresAt <= issuedAt`; `expiresAt - issuedAt > 300`; `issuedAt > server now + 120`; `expiresAt <= server now`; any field differs from the requirement it issued; the signature does not recover to the payer or to the bound delegate.

## 7. Clock correction

The client corrects its clock from the HTTP `Date` header of a server answer:

```
offset   = floor(Date header as Unix seconds) - floor(local now)     (0 when the header is missing or unreadable)
clamped  = max(-120, min(120, offset))
issuedAt = floor(local now) + trunc(clamped)
```

A server can therefore move the client's clock by at most 120 seconds either way. The same corrected time is used for the binding check (section 5.2).

## 8. Idempotency

- `assay/idempotency-key` is a string of 1 to 128 printable ASCII characters (`0x20` to `0x7E`). Anything else is refused with `MCP_IDEMPOTENCY_KEY_INVALID` before the call runs.
- One key names one **logical** call. The client either uses the key its caller supplied, or creates one UUIDv4 per logical call. It sends that same key on the unsigned attempt, the signed retry and every network retry.
- A client runs at most one call per key at a time: a second call with a key whose call is still running waits for it (or is refused when its tool or arguments differ), so it never signs a second voucher for one logical call.
- A client gives the key back to its caller on failure too (the reference SDKs put it on every error), so the caller can retry the same logical call safely.
- Without a key, every request is a new call. The server never derives a key from the arguments.
- The key is scoped to the agent and bound to the tool and the arguments. The same key with another tool or other arguments is refused with `IDEMPOTENCY_KEY_REUSED`, and nothing is charged.
- **Replay.** A key whose call returned a result answers with the stored result, marked `_meta["assay/replayed"] = true`, and charges nothing again. The receipt status is read again and can have moved on. Results are kept for 900 seconds by default (at most 3,600).
- **In flight.** While the first attempt still runs, a retry gets `IDEMPOTENCY_IN_PROGRESS` with `retryable: true` and `retryAfter` (seconds).
- **Released.** A call that failed without a charge (refused, not served, or a rail-B `PAYMENT_REQUIRED`) releases the key; the next request with it runs as a fresh attempt. This is what lets the two steps of section 3.2 share one key.
- **Unavailable.** For a paid call whose stored result is gone, the payment record still holds the key, so nothing is charged twice; the server answers `IDEMPOTENCY_RESULT_UNAVAILABLE` (with the `intentId`) or `IDEMPOTENCY_ATTEMPT_STALLED`.
- **Expired voucher on retry.** If the signed envelope expires before a retry gets through, the client stops with an error. A new request with the same key then either replays the result or gets a fresh requirement, which is checked and signed as a new voucher.

## 9. Client guards

Before it signs, a client checks the requirement locally. The reference implementations run the guards in order and stop at the first refusal; nothing is signed after a refusal. `vectors/eip155/guards.json` and `vectors/eip155/seq.json` pin the exact order, codes and boundaries.

| Guard | Checks |
|---|---|
| G1 | The requirement is a rail-B voucher requirement and answers a tool call this client sent at most 120 s ago |
| G2 | `network`, `payTo` (escrow), `amount.asset` and `amount.decimals` equal the client's network table (section 6.1); `amount` is a positive uint64 |
| G3 | A price quote (`assay/price.maxAmount`) for the tool exists, in the same asset, and the amount is not above it |
| G4 | A chain read of the payment key's grant, at most 600 s old: the grant is for this key, from this payer, active and not expired. A change of payer is refused |
| G5 | The requirement accepts a `"delegate"` signer, names this client's key as `delegate`, and the key is not the payer |
| G6 | The amount is within the key's and the escrow's on-chain caps |
| G7 | The amount is within the local limits per call and per rolling 24 hours (all signed vouchers count, including future-dated ones); above an optional confirmation threshold, only an exact confirmation of this payment passes (checked last of all) |
| G8 | The provider is in the local allow-list, when one is set |
| G9 | `1 <= seq < 2^53`, as a canonical decimal string |
| G10 | `requestHash` is `sha256:<64 hex>`; `resource` is 1 to 2,048 Unicode code points; `maxTimeoutSeconds` is 1 to 300 |
| G11 | Only in an app that keeps a per-URL paid list (the local `assay-mcp` app): paid calls are switched on for the MCP URL in use. The `Assay` clients have no such list and skip G11; `@goassay-ai/sdk/core` runs it when given `paidUrlPolicy` |
| G12 | `resource` is exactly `/mcp/tools/<the tool called>`, and is not a debt or sequence endpoint |

The minimum for an Assay-compatible client is G2, G5, G7 and G12. All the others are strongly recommended, G11 only for a client that keeps a per-URL paid list.

**No per-URL paid list in the SDKs.** An SDK client makes paid calls through whatever MCP URL the developer built it for, within the local limits (G7). To keep a client, or one URL, free-only:

- use an API key without the `payments` scope (a paid tool is then `AUTH_SCOPE_MISSING`, nothing is signed);
- or add `?free=1` to the URL (paid-only tools are not served, and no call is charged);
- or refuse in the `onPayment` / `on_payment` hook, which sees every payment before it is signed.

## 10. Results

### 10.1 Receipt

`_meta["assay/receipt"]`:

| Field | Meaning |
|---|---|
| `intentId` | The id of the payment intent; use it to read the receipt later or to report a result |
| `charged` | Money plus `display`: what was charged |
| `held` | Money plus `display`: what is reserved until verification ends |
| `status` | The intent's status, for example `VERIFYING` or `SETTLED` |
| `toolId`, `providerId` | Which tool and provider served the call |
| `classification` | The verification outcome class |
| `attempts` | How many provider attempts were made |
| `fellBack` | `true` when the call fell back to another provider |

### 10.2 Errors

`_meta["assay/error"]` on a result with `isError: true`:

| Field | Meaning |
|---|---|
| `code` | A stable code. Clients branch on it |
| `message` | Text for people |
| `retryable` | Whether the same call can succeed later |
| `retryAfter` / `retryAfterMs` | When to retry, when given |
| `fixUrl` | A page that fixes the cause, when there is one |
| `intentId` | The payment intent, when there is one |
| `details` | Extra structured data, when given |

A tool result with `isError: true` and **no** `assay/error` is the provider's own tool error, not an Assay refusal.

Codes a client must know for this flow:

| Code | Meaning | Retry |
|---|---|---|
| `PAYMENT_REQUIRED` | Sign the requirement and call again | yes, with a voucher |
| `PAYMENT_DEBT_OUTSTANDING` | The payer owes a debt; settle it first | no |
| `PAYMENT_VOUCHER_DELEGATE_INACTIVE` | The key's grant is revoked or expired | no |
| `PAYMENT_VOUCHER_EXPIRED` | The voucher window passed | new call with the same key |
| `PAYMENT_VOUCHER_SEQ_STALE` | A parallel call took the seq; nothing charged | yes |
| `PAYMENT_VOUCHER_ADMISSION_PAUSED` | A cap change is landing; nothing charged | yes, after `retryAfter` |
| `MCP_IDEMPOTENCY_KEY_INVALID` | The key is not 1 to 128 printable ASCII | no |
| `IDEMPOTENCY_IN_PROGRESS` | The first attempt is still running | yes, after `retryAfter` |
| `IDEMPOTENCY_KEY_REUSED` | The key was used for another tool or other arguments | no |
| `IDEMPOTENCY_RESULT_UNAVAILABLE`, `IDEMPOTENCY_ATTEMPT_STALLED` | The stored result is gone; nothing charged twice | no |
| `MCP_QUOTA_EXCEEDED` | The free quota is used up | yes, later |
| `MCP_VELOCITY_LIMIT_EXCEEDED` | Too many calls in a short window | yes, later |
| `RATE_LIMITED` | Request rate limit; carries `retryAfterMs` | yes, after `retryAfterMs` |
| `MCP_URL_NOT_FOUND` | The MCP host serves no such URL for this key (HTTP 404, section 2.3) | no |
| `AUTH_SCOPE_MISSING` | The API key lacks a scope (HTTP 403); `context.requiredScope` names it (on a tool call, `assay/error.requiredScope`) | no |
| `AUTH_HUMAN_SESSION_REQUIRED` | Only a signed-in person may do this, never an API key (HTTP 403) | no |
| `ACCOUNT_DELEGATE_ALREADY_BOUND` | The payment key is bound to another live credential (HTTP 409) | no |
| `ACCOUNT_DELEGATE_BIND_CONFLICT` | Another key won a first bind at the same moment; nothing bound (HTTP 409) | once: bind again, the key then waits as pending |

A full, machine-readable code catalog will be published as `spec/errors.json`.

## 11. Conformance

A client conforms to this version when it passes `vectors/eip155/vouchers.json` and `vectors/eip155/binding.json`. Passing `vectors/eip155/guards.json` and `vectors/eip155/seq.json` is strongly recommended. See [`../vectors/README.md`](../vectors/README.md).

## 12. Versions

| Axis | Version |
|---|---|
| This protocol | 1 (draft) |
| Voucher EIP-712 domain | `Assay Settlement`, version `2` |
| Binding EIP-712 domain | `GoAssay Agent Binding`, version `1` |
| REST API | `/api/v1` |
