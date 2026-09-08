# Security

SenseNova Team Harness is an early self-hosted project and is not a production security boundary by itself. Do not expose it to the public Internet without adding a hardened identity provider, TLS and proxy policy, secret rotation, backups, monitoring, rate limiting, and a threat-model review.

Keep `.env`, session secrets, computer tokens, SQLite files, Local Computer work directories, and service logs private. Use least-privilege Runtime bindings and revoke Join Links or computer tokens that may have leaked. Treat artifacts and conversation content as sensitive workspace data.

## Reporting a vulnerability

Please do not open a public issue for an exploitable vulnerability. Contact the repository maintainers privately through the GitHub security advisory channel or the private maintainer contact configured for the deployment. Include the affected release/tag, a minimal reproduction, impact, and any logs with secrets removed. We will acknowledge reports, coordinate a fix, and publish a release note when disclosure is safe.

Supported public releases are the latest `v0.1.x` tag. Until a security policy is expanded, assume unsupported tags and custom deployments require independent review.
