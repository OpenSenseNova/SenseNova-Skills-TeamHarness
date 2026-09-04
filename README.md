# AI-Native Collaboration

AI-Native Collaboration is a self-hosted workspace for people and local AI agents to work together on conversations, projects, work items, and artifacts. It is an MIT-licensed MVP intended for developers who want to run the service from source and adapt it to their own workflows.

[中文说明](README_CN.md) · [Product overview](docs/PRODUCT_OVERVIEW.md)

## MVP loop

Create a Workspace, add a Project or Conversation, configure an Agent and its local Runtime, then mention the Agent. The service records the request and inbox context; a Local Computer runs the selected agent locally and sends messages or Artifact updates back through the HTTP API. Artifacts use content-addressed storage and reviewable drafts.

## Quick start

Requirements: Node.js 24 and npm. The server is installed from source; Docker and npm publishing are not part of this MVP.

```bash
git clone https://github.com/lgl0980/ai_native_collaboration.git
cd ai_native_collaboration
cp .env.example .env
npm ci
npm run dev
```

Open the Web app at `http://localhost:5173`. For a production-style local run:

```bash
npm run build
NODE_ENV=production npm start
```

See [INSTALL.md](INSTALL.md) for environment, database, and Local Computer setup. The Local Computer is distributed as `anc-local-computer.tgz`; its command reference is in [local-computer/README.md](local-computer/README.md).

## Verify the public package

```bash
npm run verify:public
npm run build
```

The verification command checks the OpenAPI contract, SQLite schema baseline, TypeScript, core API and Web flows, public documentation links, dependency notices, and the Local Computer archive. The OpenAPI validator currently reports 519 style warnings and zero errors; warnings are recorded in [CHANGELOG.md](CHANGELOG.md) and do not block the MVP release.

## Repository map

- `src/`: Fastify API, services, runtime gateway, and SQLite access
- `web/`: Vite/React client
- `local-computer/`: independently packaged local execution client
- `schema/`: versioned SQLite schema baseline
- `tests/`: API, runtime, and persistence regression tests
- `docs/contracts/openapi.json`: HTTP contract used by clients and tooling

## Scope and limitations

This is an early self-hosted MVP. Review authentication, network exposure, secret storage, backups, and local-agent permissions before using it beyond a trusted development network. It does not provide a production deployment recipe, Docker image, native installer, npm registry package, or schema migration layer.

- [MVP scope and acceptance](docs/MVP.md)
- [Installation](INSTALL.md) · [安装](INSTALL_CN.md)
- [Contributing](CONTRIBUTING.md) · [贡献指南](CONTRIBUTING_CN.md)
- [Security](SECURITY.md) · [安全说明](SECURITY_CN.md)
- [OpenAPI contract](docs/contracts/openapi.json)
- [Changelog](CHANGELOG.md)

## License

[MIT](LICENSE)
