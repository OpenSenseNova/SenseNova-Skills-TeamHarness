# Installation

AI-Native Collaboration is run from source with Node.js 24 and npm. Use a trusted development network until you have added the identity, secret rotation, backup, monitoring, and rate-limit controls required by your deployment.

## Server

```bash
git clone https://github.com/lgl0980/ai_native_collaboration.git
cd ai_native_collaboration
cp .env.example .env
npm ci
npm run dev
```

The API listens on the configured server port and the Vite development client runs at `http://localhost:5173`. Set the values in `.env` before starting. Never commit `.env`; it may contain session, database, or runtime secrets.

For a local production-style process:

```bash
npm run build
NODE_ENV=production npm start
```

The production process serves the built Web assets and exposes `/health` and `/openapi.json`. The default SQLite data directory is controlled by the environment configuration; back it up before experiments.

## Local Computer

Build the release archive locally with:

```bash
npm run package:local-computer
npm install --global ./web/public/downloads/anc-local-computer.tgz
anc-computer --help
anc-computer connect --server 'http://localhost:3000' --token '<computer-token>'
anc-computer service install
```

The archive contains only the executable distribution, schema, package metadata, README, and MIT license. It does not contain a database, `.env`, logs, work directories, or tokens. See [local-computer/README.md](local-computer/README.md) for command reference and service lifecycle.

## Verification and troubleshooting

```bash
npm run verify:public
npm run build
```

If a port is already in use, change the corresponding value in `.env`. If a Local Computer cannot connect, check the server URL, token scope, HTTPS/proxy settings, and `anc-computer service logs`. Do not paste tokens or private workspace data into an issue; use the process in [SECURITY.md](SECURITY.md).
