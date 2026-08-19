# Database migration layout

V1 is the only baseline in this repository, so it has no migration scripts.

Future schema changes are isolated first by database and then by affected table:

```text
schema/migrations/
  workspace/
    1-to-2/
      001-agent-inbox-items.sql
      002-agent-inbox-indexes.sql
  local-node/
    1-to-2/
      001-runtime-sessions.sql
```

Rules:

1. Bump only the database family whose schema changed.
2. Use one `<from>-to-<to>` directory for each consecutive version step.
3. Name scripts `NNN-<affected-table-or-index>.sql`; execution order is lexical.
4. Keep each script limited to the named table, its indexes, triggers, and directly required constraints.
5. Never rebuild or copy unrelated tables to implement a local feature change.
6. Do not add compatibility views, dual writes, or runtime schema guessing after migration.
7. The application runs every script for one step in a single transaction, performs `foreign_key_check`, and advances `PRAGMA user_version` only after all scripts succeed.
