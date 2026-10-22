# Contributing

Thanks for helping. Issues and pull requests are welcome.

## Before you start

- Open an issue first for anything larger than a small fix, so we can agree on the approach.
- A change to the protocol goes into [`spec/protocol.md`](spec/protocol.md) and the [vectors](vectors) first, then into every language in the same pull request.
- Write in English, in code, comments, commits and docs.
- Never commit secrets, real keys or personal data. The keys in `vectors/` are public test keys.

## Checks

Node (in `node/`):

```sh
npm ci
npm run lint
npm run typecheck
npm test
```

Python (in `python/`):

```sh
pip install -e '.[dev]'
ruff check . && ruff format --check .
mypy
pytest
```

CI runs the same checks on every pull request.

## Vectors

Vector files are the contract between languages. Never change an expected value to make a test pass: a changed value is a protocol change. A new vector file fails the tests until every language lists it.

## Licence

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
