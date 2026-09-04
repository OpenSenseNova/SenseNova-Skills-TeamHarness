# Contributing

Thanks for helping improve this self-hosted MVP. Keep changes focused on public behavior and preserve the existing HTTP API, Runtime semantics, and SQLite schema baseline unless a separate compatibility decision is explicitly approved.

## Development

```bash
npm ci
npm run dev
npm run verify:public
```

Use Node.js 24. The OpenAPI document at `docs/contracts/openapi.json` is the public HTTP contract; after changing a route, run `npm run openapi` and review both the contract and generated Web client types. Validate schema changes with `npm run db:check`. Do not add private design notes, credentials, databases, logs, or generated build output to the repository.

Public documentation is intentionally small: README, installation, contribution, security, MVP, product overview, Local Computer reference, changelog, license, and the OpenAPI contract. Explain extension points in this file or its Chinese counterpart rather than adding internal architecture dossiers.

## Pull requests

Please include:

- the user-visible behavior and affected surface;
- exact validation commands and their result;
- known limitations, migration or rollout concerns, and security impact;
- documentation updates for changed public commands or API behavior.

Keep commits reviewable. Do not include unrelated formatting churn. A PR should not introduce Docker/Compose, npm publishing, a native installer, an API compatibility layer, or a database migration unless the project scope changes first.

## Release maintenance

The first public release is `v0.1.0`. GitHub Releases are the only distribution channel; the server remains source-installed and the Local Computer archive is the release asset. A maintainer creates a `v*.*.*` tag after the verification workflow passes. The workflow builds `anc-local-computer.tgz`, writes a SHA-256 file, and never runs `npm publish`.
