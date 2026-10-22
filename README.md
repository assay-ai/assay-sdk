# assay-sdk

The official SDKs for [Assay](https://goassay.ai): call tools over MCP from your own code, with free calls and paid calls signed by a key you hold.

**Status: pre-release.** Nothing is published yet, and the APIs can still change.

Both packages cover the same phase-1 surface:

| Area | Node | Python |
|---|---|---|
| Tools over MCP | `tools.search`, `tools.get`, `tools.call` | `tools.search`, `tools.get`, `tools.call` |
| What a call cost | `receipts.get` | `receipts.get` |
| Payment-key setup | `paidCalls.status`, `bind`, `waitUntilActive` | `paid_calls.status`, `bind`, `wait_until_active` |

Paid calls are signed by a signer you pass (`evmSigner(viemAccount)` / `evm_signer(eth_account)`, or your own KMS-backed object); the SDK never stores keys. See the package READMEs for quickstarts.

| Language | Package | Folder |
|---|---|---|
| Node.js (22 or newer) | `@goassay-ai/sdk` | [`node/`](node) |
| Python (3.10 or newer) | `goassay` | [`python/`](python) |
| Go | later | |

```sh
npm install @goassay-ai/sdk
pip install goassay
```

The client takes your Assay API key at start-up, as the `apiKey` option or the `ASSAY_API_KEY` environment variable. What a key may do is set on the key itself, as scopes.

Documentation: [docs.goassay.ai/developers](https://docs.goassay.ai/developers).

## Repository layout

| Folder | Contents |
|---|---|
| [`spec/`](spec) | The paid-call protocol, precise enough to write a client in any language |
| [`vectors/`](vectors) | Language-neutral test vectors that every implementation runs, per CAIP-2 namespace (`eip155/`) |
| [`conformance/`](conformance) | Shared HTTP scenarios (planned) |
| [`node/`](node), [`python/`](python) | The SDK packages |

Another language: read [`spec/protocol.md`](spec/protocol.md) and pass the vectors.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities privately, as described in [SECURITY.md](SECURITY.md).

## License

MIT, see [LICENSE](LICENSE).
