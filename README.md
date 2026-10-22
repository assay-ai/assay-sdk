# assay-sdk

The official SDKs for [Assay](https://goassay.ai): call tools over MCP from your own code, with free calls and paid calls signed by a key you hold.

**Status: early release (0.x).** The APIs can still change before 1.0; see the changelogs in [`node/`](node/CHANGELOG.md) and [`python/`](python/CHANGELOG.md).

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

## Release checklist

For maintainers. Each package is released on its own by a signed tag; [`.github/workflows/release.yml`](.github/workflows/release.yml) runs lint, typecheck and tests, checks that the tag equals the package version, and publishes with trusted publishing (OIDC), so no registry token is stored anywhere.

One-time setup:

1. GitHub: the default branch is `main`.
2. GitHub environments `npm` and `pypi`, each with a required reviewer.
3. A tag ruleset on `node/v*` and `python/v*` that requires signed tags (and restricts who may create them).
4. PyPI: add a pending trusted publisher for project `goassay`: owner `assay-ai`, repository `assay-sdk`, workflow `release.yml`, environment `pypi`.
5. npm: a trusted publisher can only be added to a package that exists. Publish `0.1.0` of `@goassay-ai/sdk` once by hand from `node/` (`npm ci && npm run build && npm publish --access public --provenance=false`; provenance needs CI), then add the trusted publisher on npmjs.com: owner `assay-ai`, repository `assay-sdk`, workflow `release.yml`, environment `npm`. The `node/v0.1.0` tag then skips the version already on npm.

Each release:

1. Bump the version in both places for the package (`node/package.json` and `node/src/version.ts`, or `python/pyproject.toml` and `python/src/goassay/__init__.py`) and add its `CHANGELOG.md` entry.
2. Merge to `main` and pull it.
3. Tag and push: `git tag -s node/v0.1.0 -m "node 0.1.0"` and `git tag -s python/v0.1.0 -m "python 0.1.0"`, then `git push origin node/v0.1.0 python/v0.1.0`.
4. Approve the `npm` and `pypi` jobs in the Actions run.
5. Verify: `npm view @goassay-ai/sdk version` shows the version with a provenance badge on npmjs.com; `pip index versions goassay` lists it; a clean `npm install @goassay-ai/sdk` and `pip install goassay` import.

## License

MIT, see [LICENSE](LICENSE).
