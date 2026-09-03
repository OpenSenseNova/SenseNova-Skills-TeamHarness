# Contributing

Thanks for helping improve AI-Native Collaboration. The repository is a small
self-hosted MVP: keep changes focused, preserve the explicit Workspace and
Project boundaries, and avoid adding compatibility layers for removed APIs.

## Development

Requirements:

- Node.js 24 or newer
- npm 10 or newer
- Git (only required for local development tooling)

```bash
cp .env.example .env
npm ci
npm run dev
```

The web client runs at `http://127.0.0.1:5173` and the API at
`http://127.0.0.1:3000`. Local data is written to `.data/`, which is ignored by
Git. Use a temporary `APP_DATA_DIR` when testing migrations or destructive
operations.

## Before opening a pull request

Run the same checks used by CI:

```bash
npm run check
npm run build
```

If the OpenAPI contract changes, regenerate it with `npm run openapi` and
include the generated contract and client changes in the same pull request.
Changes to the SQLite baseline must update both the SQL file and
`schema/manifest.json`, then pass `npm run db:check`.

## Pull requests

Describe the user-visible behavior, the verification you ran, and any known
limitations. Do not commit `.env`, SQLite files, content blobs, runtime logs,
or local Computer connection material.
