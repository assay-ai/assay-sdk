# @goassay-ai/sdk

The Node SDK for [Assay](https://goassay.ai): call tools over MCP, with free and paid calls signed by your own key.

**Status: pre-release.** This package is not published yet, and its API is not ready to use.

```sh
npm install @goassay-ai/sdk
```

Requires Node 22 or newer. Documentation: [docs.goassay.ai/developers](https://docs.goassay.ai/developers).

## Development

```sh
npm ci
npm run lint
npm run typecheck
npm test
```

The tests run the shared vectors in [`../vectors`](../vectors) (`vectors/eip155/`).

## License

MIT, see [LICENSE](LICENSE).
