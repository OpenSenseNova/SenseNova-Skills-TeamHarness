import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { SqliteDatabase } from '../src/storage/database.js';

describe('database foundation', () => {
  it('rejects mismatched Workspace relationships at the SQLite boundary', () => {
    const database = SqliteDatabase.open(':memory:', 'workspace');
    const sql = database.raw;

    try {
      database.transaction(() => {
        sql.prepare("INSERT INTO actors VALUES ('human-1', 'human', 1)").run();
        sql.prepare("INSERT INTO humans VALUES ('human-1', 'Human One', 'human-one@example.com', 'active', 1)").run();
        sql.prepare("INSERT INTO actors VALUES ('human-2', 'human', 1)").run();
        sql.prepare("INSERT INTO humans VALUES ('human-2', 'Human Two', 'human-two@example.com', 'active', 1)").run();
        sql.prepare("INSERT INTO workspaces VALUES ('workspace-1', 'One', 'human-1', 1, 1, 1, 1)").run();
        sql.prepare("INSERT INTO workspaces VALUES ('workspace-2', 'Two', 'human-1', 1, 1, 1, 1)").run();
        sql.prepare(
          "INSERT INTO workspace_memberships VALUES ('member-1', 'workspace-1', 'human-1', 'owner', 'active', 1, 1, 1, NULL)",
        ).run();
        sql.prepare(
          "INSERT INTO workspace_memberships VALUES ('member-2', 'workspace-1', 'human-2', 'member', 'active', 1, 1, 1, NULL)",
        ).run();
        sql.prepare(
          "INSERT INTO workspace_memberships VALUES ('member-3', 'workspace-2', 'human-1', 'owner', 'active', 1, 1, 1, NULL)",
        ).run();

        for (const agentId of ['agent-1', 'agent-2']) {
          sql.prepare('INSERT INTO actors VALUES (?, ?, ?)').run(agentId, 'agent', 1);
          sql.prepare(
            `INSERT INTO agents (
               actor_id, workspace_id, created_by_human_id, owner_membership_id,
               name, description, lifecycle_status, revision, created_at, updated_at
             ) VALUES (?, 'workspace-1', 'human-1', 'member-1', ?, NULL, 'active', 1, 1, 1)`,
          ).run(agentId, agentId);
          sql.prepare(
            "INSERT INTO workspace_memberships VALUES (?, 'workspace-1', ?, 'member', 'active', 1, 1, 1, NULL)",
          ).run(`${agentId}-membership`, agentId);
        }

        sql.prepare(
          `INSERT INTO conversations (
             id, workspace_id, project_id, scope_type, membership_mode,
             conversation_kind, visibility, title, created_by_membership_id,
             created_by_project_membership_id, context_version, timeline_frontier, created_at, updated_at
           ) VALUES ('conversation-1', 'workspace-1', NULL, 'direct_message', 'explicit',
             'dm', 'private', NULL, 'member-1', NULL, 3, 2, 1, 1)`,
        ).run();
        sql.prepare(
          `INSERT INTO conversations (
             id, workspace_id, project_id, scope_type, membership_mode,
             conversation_kind, visibility, title, created_by_membership_id,
             created_by_project_membership_id, context_version, timeline_frontier, created_at, updated_at
           ) VALUES ('conversation-2', 'workspace-1', NULL, 'direct_message', 'explicit',
             'dm', 'private', NULL, 'member-1', NULL, 1, 0, 1, 1)`,
        ).run();
        sql.prepare(
          `INSERT INTO messages (
             id, workspace_id, conversation_id, thread_id, author_actor_id,
             author_membership_id, body, conversation_version, scope_position, created_at
           ) VALUES ('root-1', 'workspace-1', 'conversation-1', NULL, 'human-1', 'member-1', 'root', 1, 1, 1)`,
        ).run();
        sql.prepare(
          "INSERT INTO threads VALUES ('thread-1', 'workspace-1', 'conversation-1', 'root-1', 1, 1)",
        ).run();
        sql.prepare(
          `INSERT INTO messages (
             id, workspace_id, conversation_id, thread_id, reply_to_message_id, author_actor_id,
             author_membership_id, body, conversation_version, scope_position, created_at
           ) VALUES ('reply-1', 'workspace-1', 'conversation-1', 'thread-1', 'root-1', 'human-1', 'member-1', 'reply', 2, 1, 1)`,
        ).run();
        sql.prepare(
          `INSERT INTO messages (
             id, workspace_id, conversation_id, thread_id, author_actor_id,
             author_membership_id, body, conversation_version, scope_position, created_at
           ) VALUES ('root-2', 'workspace-1', 'conversation-1', NULL, 'human-1', 'member-1', 'second root', 3, 2, 1)`,
        ).run();
      });

      expect(() =>
        sql.prepare(
          "INSERT INTO workspace_memberships VALUES ('cross-agent', 'workspace-2', 'agent-1', 'member', 'active', 1, 1, 1, NULL)",
        ).run(),
      ).toThrow(/owning workspace/);

      expect(() =>
        sql.prepare(
          `INSERT INTO messages (
             id, workspace_id, conversation_id, thread_id, author_actor_id,
             author_membership_id, body, conversation_version, scope_position, created_at
           ) VALUES ('wrong-thread', 'workspace-1', 'conversation-2', 'thread-1', 'human-1', 'member-1', 'body', 1, 1, 1)`,
        ).run(),
      ).toThrow(/FOREIGN KEY/);

      expect(() =>
        sql.prepare(
          `INSERT INTO messages (
             id, workspace_id, conversation_id, thread_id, reply_to_message_id, author_actor_id,
             author_membership_id, body, conversation_version, scope_position, created_at
           ) VALUES ('wrong-reply-target', 'workspace-1', 'conversation-2', NULL, 'root-1',
             'human-1', 'member-1', 'body', 1, 1, 1)`,
        ).run(),
      ).toThrow(/FOREIGN KEY/);

      expect(() =>
        sql.prepare(
          `INSERT INTO messages (
             id, workspace_id, conversation_id, thread_id, author_actor_id,
             author_membership_id, body, conversation_version, scope_position, created_at
           ) VALUES ('wrong-author', 'workspace-1', 'conversation-2', NULL, 'human-1', 'member-2', 'body', 1, 1, 1)`,
        ).run(),
      ).toThrow(/FOREIGN KEY/);

      expect(() =>
        sql.prepare(
          "INSERT INTO threads VALUES ('thread-2', 'workspace-1', 'conversation-1', 'reply-1', 0, 1)",
        ).run(),
      ).toThrow(/top-level/);

      database.transaction(() => {
        sql.prepare("INSERT INTO computers VALUES ('computer-1', 'human-1', 'Computer', 'active', 1, 1, 1)").run();
        sql.prepare(
          `INSERT INTO computer_runtime_capabilities (
             computer_id, runtime_id, availability, detected_version,
             configuration_json, configuration_digest,
             skills_json, skills_digest,
             unavailable_reason_code, unavailable_reason_message, checked_at
           ) VALUES (
             'computer-1', 'generic-acp', 'ready', NULL,
             '{"models":[],"defaultModelId":null,"reasoningEfforts":[],"defaultReasoningEffort":null,"modes":[],"defaultModeId":null}',
             '0000000000000000000000000000000000000000000000000000000000000000',
             '{"global":[],"workspace":[]}',
             '0000000000000000000000000000000000000000000000000000000000000000',
             NULL, NULL, 1
           )`,
        ).run();
        for (const [agentId, bindingId, policyId] of [
          ['agent-1', 'binding-1', 'policy-1'],
          ['agent-2', 'binding-2', 'policy-2'],
        ] as const) {
          sql.prepare(
            `INSERT INTO agent_runtime_bindings (
               id, workspace_id, agent_id, computer_id, runtime_id,
               requested_model, requested_reasoning_effort, requested_mode,
               runtime_catalog_revision, binding_revision, status, created_at, updated_at
             ) VALUES (?, 'workspace-1', ?, 'computer-1', 'generic-acp',
               NULL, NULL, NULL, 1, 1, 'active', 1, 1)`,
          ).run(bindingId, agentId);
          sql.prepare(
            `INSERT INTO agent_execution_policy_versions (
               id, workspace_id, agent_id, version, max_parallel_attempts, max_wall_time_ms,
               max_context_bytes, max_tool_calls, allowed_context_kinds_json,
               private_context_allowed, created_by_membership_id, created_at
             ) VALUES (?, 'workspace-1', ?, 1, 1, 1800000, 16777216, 200,
               '["message","conversation","document","change"]', 0, 'member-1', 1)`,
          ).run(policyId, agentId);
        }
        insertRequestedAgentRequest(database, {
          outcomeId: 'outcome-1',
          requestId: 'request-1',
          messageId: 'root-1',
          targetAgentId: 'agent-1',
        });
        insertRequestedAgentRequest(database, {
          outcomeId: 'outcome-2',
          requestId: 'request-2',
          messageId: 'root-2',
          targetAgentId: 'agent-1',
        });
      });

      expect(() =>
        sql.prepare(
          `INSERT INTO runs (
             id, workspace_id, agent_request_id, agent_id, agent_membership_id, binding_id,
             binding_revision, policy_version_id, effective_budget_json, status, deadline_at, created_at
           ) VALUES ('wrong-run', 'workspace-1', 'request-1', 'agent-2', 'agent-2-membership',
             'binding-2', 1, 'policy-2', '{"maxWallTimeMs":1800000,"maxContextBytes":16777216,"maxToolCalls":200}',
             'active', 1800001, 1)`,
        ).run(),
      ).toThrow(/FOREIGN KEY/);

      database.transaction(() => {
        sql.prepare(
          `INSERT INTO runs (
             id, workspace_id, agent_request_id, agent_id, agent_membership_id, binding_id,
             binding_revision, policy_version_id, effective_budget_json, status, deadline_at, created_at
           ) VALUES ('run-1', 'workspace-1', 'request-1', 'agent-1', 'agent-1-membership',
             'binding-1', 1, 'policy-1', '{"maxWallTimeMs":1800000,"maxContextBytes":16777216,"maxToolCalls":200}',
             'active', 1800001, 1)`,
        ).run();
        sql.prepare(
          `INSERT INTO runs (
             id, workspace_id, agent_request_id, agent_id, agent_membership_id, binding_id,
             binding_revision, policy_version_id, effective_budget_json, status, deadline_at, created_at
           ) VALUES ('run-2', 'workspace-1', 'request-2', 'agent-1', 'agent-1-membership',
             'binding-1', 1, 'policy-1', '{"maxWallTimeMs":1800000,"maxContextBytes":16777216,"maxToolCalls":200}',
             'active', 1800001, 1)`,
        ).run();
        sql.prepare(
          `INSERT INTO attempts (
             id, workspace_id, run_id, attempt_number, status, binding_revision,
             policy_version_id, effective_budget_json, deadline_at, created_at
           ) VALUES ('attempt-1', 'workspace-1', 'run-1', 1, 'running', 1, 'policy-1',
             '{"maxWallTimeMs":1800000,"maxContextBytes":16777216,"maxToolCalls":200}', 1800001, 1)`,
        ).run();
        sql.prepare(
          `INSERT INTO attempts (
             id, workspace_id, run_id, attempt_number, status, binding_revision,
             policy_version_id, effective_budget_json, deadline_at, created_at
           ) VALUES ('attempt-2', 'workspace-1', 'run-2', 1, 'running', 1, 'policy-1',
             '{"maxWallTimeMs":1800000,"maxContextBytes":16777216,"maxToolCalls":200}', 1800001, 1)`,
        ).run();
      });

      expect(() =>
        sql.prepare(
          `INSERT INTO attempts (
             id, workspace_id, run_id, attempt_number, status, binding_revision,
             policy_version_id, effective_budget_json, deadline_at, created_at
           ) VALUES ('attempt-3', 'workspace-1', 'run-1', 2, 'running', 1, 'policy-1',
             '{"maxWallTimeMs":1800000,"maxContextBytes":16777216,"maxToolCalls":200}', 1800001, 1)`,
        ).run(),
      ).toThrow(/UNIQUE/);
    } finally {
      database.close();
    }
  });

  it('reopens both database files with committed data and startup pragmas intact', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'anc-restart-'));
    const workspacePath = resolve(directory, 'workspace.sqlite');
    const localNodePath = resolve(directory, 'local-node.sqlite');

    try {
      const workspace = SqliteDatabase.open(workspacePath, 'workspace');
      const localNode = SqliteDatabase.open(localNodePath, 'local-node');
      workspace.transaction(() => {
        workspace.raw.prepare("INSERT INTO actors VALUES ('human-1', 'human', 1)").run();
        workspace.raw.prepare("INSERT INTO humans VALUES ('human-1', 'Human', 'human@example.com', 'active', 1)").run();
        workspace.raw.prepare("INSERT INTO workspaces VALUES ('workspace-1', 'Workspace', 'human-1', 1, 1, 1, 1)").run();
        workspace.raw.prepare(
          "INSERT INTO workspace_memberships VALUES ('member-1', 'workspace-1', 'human-1', 'owner', 'active', 1, 1, 1, NULL)",
        ).run();
      });
      localNode.transaction(() => {
        localNode.raw.prepare(
          `INSERT INTO local_runtime_executions (
             attempt_id, workspace_id, run_id, attempt_root, working_directory, execution_kind,
             phase, started_at
           ) VALUES (
             'attempt-1', 'workspace-1', 'run-1', '/tmp/attempt-1', '/tmp/attempt-1/work',
             'workspace_scratch', 'running', 1
           )`,
        ).run();
      });
      workspace.close();
      localNode.close();

      const reopenedWorkspace = SqliteDatabase.open(workspacePath, 'workspace');
      const reopenedLocalNode = SqliteDatabase.open(localNodePath, 'local-node');
      try {
        expect(reopenedWorkspace.raw.prepare("SELECT name FROM workspaces WHERE id = 'workspace-1'").get()).toEqual({
          name: 'Workspace',
        });
        expect(
          reopenedLocalNode.raw.prepare("SELECT phase FROM local_runtime_executions WHERE attempt_id = 'attempt-1'").get(),
        ).toEqual({ phase: 'running' });
        expect(reopenedWorkspace.raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 });
        expect(reopenedWorkspace.raw.prepare('PRAGMA application_id').get()).toEqual({ application_id: 1095648087 });
        expect(reopenedWorkspace.raw.prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'project_resource_links'",
        ).get()).toBeUndefined();
        expect(reopenedWorkspace.raw.prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'project_artifacts_v2'",
        ).get()).toEqual({ name: 'project_artifacts_v2' });
        expect(reopenedLocalNode.raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 });
        expect(reopenedLocalNode.raw.prepare('PRAGMA application_id').get()).toEqual({ application_id: 1095648076 });
        for (const database of [reopenedWorkspace, reopenedLocalNode]) {
          expect(database.raw.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
          expect(database.raw.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
          expect(database.raw.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
          expect(database.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
        }
      } finally {
        reopenedLocalNode.close();
        reopenedWorkspace.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects databases outside the v1 baseline even when current capabilities remain intact', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'anc-additive-schema-'));
    const workspacePath = resolve(directory, 'workspace.sqlite');
    try {
      const workspace = SqliteDatabase.open(workspacePath, 'workspace');
      workspace.close();
      const raw = new DatabaseSync(workspacePath);
      raw.exec('ALTER TABLE workspaces ADD COLUMN optional_note TEXT; PRAGMA user_version = 19;');
      raw.close();
      expect(() => SqliteDatabase.open(workspacePath, 'workspace')).toThrow(
        /schema version 19 is not the supported v1 baseline/,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects a database that is missing a capability required by the current build', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'anc-schema-drift-'));
    const localNodePath = resolve(directory, 'local-node.sqlite');
    try {
      const localNode = SqliteDatabase.open(localNodePath, 'local-node');
      localNode.close();
      const drifted = new DatabaseSync(localNodePath);
      drifted.exec('ALTER TABLE held_artifact_drafts RENAME COLUMN draft_key TO obsolete_target;');
      drifted.close();
      expect(() => SqliteDatabase.open(localNodePath, 'local-node')).toThrow(
        /missing or incompatible held_artifact_drafts\.draft_key/,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects the wrong database family and unversioned non-empty schemas', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'anc-schema-identity-'));
    const localNodePath = resolve(directory, 'local-node.sqlite');
    const unversionedPath = resolve(directory, 'unversioned.sqlite');
    try {
      const localNode = SqliteDatabase.open(localNodePath, 'local-node');
      localNode.close();
      expect(() => SqliteDatabase.open(localNodePath, 'workspace')).toThrow(/application id/);

      const unversioned = new DatabaseSync(unversionedPath);
      unversioned.exec('CREATE TABLE unexpected (id TEXT PRIMARY KEY) STRICT;');
      unversioned.close();
      expect(() => SqliteDatabase.open(unversionedPath, 'workspace')).toThrow(/schema objects but no supported schema version/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('locates schema files independently of the process working directory', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'anc-schema-path-'));
    const databasePath = resolve(directory, 'workspace.sqlite');
    const moduleUrl = pathToFileURL(resolve(process.cwd(), 'src/storage/database.ts')).href;
    const script = [
      `import { SqliteDatabase } from ${JSON.stringify(moduleUrl)};`,
      `const database = SqliteDatabase.open(${JSON.stringify(databasePath)}, 'workspace');`,
      "const version = database.raw.prepare('PRAGMA user_version').get().user_version;",
      'database.close();',
      "if (version !== 1) process.exit(2);",
    ].join('\n');

    try {
      const result = spawnSync(
        process.execPath,
        ['--import', import.meta.resolve('tsx'), '--input-type=module', '--eval', script],
        { cwd: directory, encoding: 'utf8' },
      );
      expect(result.status, result.stderr || result.stdout).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function insertRequestedAgentRequest(
  database: SqliteDatabase,
  input: { outcomeId: string; requestId: string; messageId: string; targetAgentId: string },
): void {
  database.raw.prepare(
    `INSERT INTO agent_mention_outcomes (
       id, workspace_id, message_id, target_reference, target_order,
       target_agent_id, outcome, reason_code, agent_request_id, created_at
     ) VALUES (?, 'workspace-1', ?, ?, 0, ?, 'requested', NULL, ?, 1)`,
  ).run(input.outcomeId, input.messageId, input.targetAgentId, input.targetAgentId, input.requestId);
  database.raw.prepare(
    `INSERT INTO agent_requests (
       id, workspace_id, mention_outcome_id, target_agent_id,
       result_conversation_id, result_thread_id, status, version,
       created_at, updated_at
     ) VALUES (?, 'workspace-1', ?, ?, 'conversation-1', NULL, 'pending', 1, 1, 1)`,
  ).run(input.requestId, input.outcomeId, input.targetAgentId);
}
