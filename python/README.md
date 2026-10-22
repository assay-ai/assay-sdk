# goassay

The Python SDK for [Assay](https://goassay.ai): call tools over MCP, with free and paid calls signed by your own key.

**Status: pre-release.** This package is not published yet, and its API is not ready to use.

```sh
pip install goassay
```

Requires Python 3.10 or newer. Documentation: [docs.goassay.ai/developers](https://docs.goassay.ai/developers).

## Development

```sh
python -m venv .venv && . .venv/bin/activate
pip install -e '.[dev]'
ruff check . && ruff format --check .
mypy
pytest
```

The tests run the shared vectors in [`../vectors`](../vectors) (`vectors/eip155/`).

## License

MIT, see [LICENSE](LICENSE).
