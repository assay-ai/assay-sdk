# Test vectors

Language-neutral test vectors for the [paid-call protocol](../spec/protocol.md). Every implementation in this repository runs them, and a client in another language can use them to prove it builds and signs the same bytes.

Implementations read these files and must not copy their values into code. A new file here fails the Node and Python tests until both list it.

## Layout

Vectors are grouped by CAIP-2 namespace, because the voucher scheme and the key binding are chain-specific:

| Folder | Namespace | Scheme |
|---|---|---|
| [`eip155/`](eip155) | EVM chains | EIP-712 `Voucher` and `DelegateBinding` |

A new namespace (for example `solana/`) gets its own folder with the same kinds of files.

## Files in `eip155/`

| File | Spec | Contents |
|---|---|---|
| `vouchers.json` | section 6 | Rail-B requirements plus `issuedAt` and a `network`, with the expected wire voucher, EIP-712 typed data, domain separator, struct hash, digest and signature |
| `binding.json` | section 5 | `DelegateBinding` challenges in the server's wire form: valid ones with the typed data to sign, its digest and signature, and invalid ones that must be refused naming a field |
| `guards.json` | section 9 | The local guards G1 to G12 (G11 app-only): a passing `base` context and cases that change it |
| `seq.json` | section 9, G9 | `seq` bounds: `1 <= seq < 2^53` as a canonical decimal string |

### vouchers.json

Each case has:

- `network`: the built-in table entry the client would hold (`caip2`, `escrow` as CAIP-10, `asset` as CAIP-19, `decimals`);
- `requirement` and `issuedAt`: the inputs;
- `wire`: the voucher as sent in `assay/voucher`;
- `typedData`: the EIP-712 typed data, integers as decimal strings;
- `domainSeparator`, `structHash`, `digest`: the EIP-712 hashes;
- `signature`: the test key's signature of `digest` (65 bytes, `v` in 27/28).

To verify a case: build the voucher from `requirement`, `issuedAt` and `network` (spec section 6), compare it with `wire` and `typedData`, hash it and compare the three hashes, then sign the digest with `testKey.privateKey` and compare with `signature` (secp256k1 signatures with RFC 6979 nonces are deterministic), and recover the signer address from it and compare with `testKey.address`.

Case notes: `placeholder-escrow` uses a second placeholder escrow `0x1111...` (its own `network` entry). `short-timeout-utf8-max-safe-seq` covers a short `maxTimeoutSeconds`, a non-ASCII resource hashed as UTF-8, `seq = 2^53 - 1` and an upper-case `requestHash`.

### binding.json

- `context`: the client's state (`localAddress`, `credentialId`, `network`, `nowSeconds`). The chain id the domain must name is the one of `network`.
- `valid[]`: a `challenge` (the `data` of the challenge answer) that passes every check of spec section 5.2, the `typedData` the client signs, its `digest` and the test key's `signature`.
- `invalid[]`: each applies one change to `valid[0].challenge`: `op: "set"` puts `value` at `path`, `op: "delete"` removes `path`. The client must refuse it, naming `field`.

### guards.json and seq.json

- `base` passes every guard. Each case applies `changes` (same `set` / `delete` operations, in order) to a copy of `base` and runs the guards in order G1 to G12. `expect` is `{ok: true}` or the first refusal `{ok: false, guard, code}`, plus the exact `reason` where the text is part of the contract.
- A `reason` may contain `{run}`. It stands for the command an implementation tells its user to run; each implementation substitutes its own.
- `seq.json` sets `requirement.seq` in the `base` of `guards.json`. `ok: false` means refused with `G9` / `G9_SEQ`.
- Conventions: amounts, caps and spend are atomic units as decimal strings (6 decimals); local limits are dollars as decimal strings; times are Unix seconds on the local clock; `resource` length counts Unicode code points; addresses from the server are checksummed CAIP-10, addresses the client holds itself may be bare `0x` addresses in any case.
- Codes are stable: never rename or reuse one.
- **G11 is app-only.** Its cases (`guard: "G11"`, and the `canonicalUrl` / `paidUrls` fields of `base`) are for an app that keeps a per-URL paid list, such as the local `assay-mcp` app. The SDKs in this repository have no such list: they ignore those fields and skip the G11 cases, naming the reason. Their expected values stay here for the apps that run them.

## Placeholders and provenance

The chain id (`31337`), the escrow (`0xE5c0e5C0...`, `0x1111...`) and the asset (`0xA55E7a55...`) in these files are **placeholders**, not a real deployment. A client takes the real chain parameters (chain id, escrow, asset, decimals) from its own deployment config for the environment it runs against, never from the server and never from these files. The placeholder addresses mix letters and digits so that checksum, lower-case and upper-case forms differ, which the guard vectors rely on. `eip155:1` appears in `guards.json` and `binding.json` only as "another chain".

Every digest and signature in `vouchers.json` and `binding.json` was computed with viem and reproduced byte for byte by an independent implementation on eth-account (the Python tests in this repository).

## Test keys

The signing key in `vouchers.json` and `binding.json` is the well-known public anvil/hardhat default account 0. The other addresses in `guards.json` are public anvil/hardhat default accounts. They are **test only**: never fund them or use them for anything real.
