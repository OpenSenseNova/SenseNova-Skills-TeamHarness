import { DomainError, invariant } from '../lib/errors.js';
import { canonicalJson, newId, nowMs } from '../lib/values.js';
import type { RuntimeContextEvent } from '../runtime/runtime-integration.js';
import type { AttemptExecutionInputView } from '../domain/types.js';
import { SqliteDatabase } from './database.js';

export interface LocalExecutionRow {
  attempt_id: string;
  workspace_id: string;
  run_id: string;
  attempt_root: string;
  working_directory: string;
  execution_kind: AttemptExecutionInputView['executionScope']['kind'];
  project_id: string | null;
  repository_id: string | null;
  repository_identity: string | null;
  phase: 'assembling' | 'running' | 'returning' | 'finished' | 'failed';
}

export class LocalExecutionStore {
  constructor(readonly database: SqliteDatabase) {}

  start(
    attemptId: string,
    workspaceId: string,
    runId: string,
    local?: {
      attemptRoot: string;
      workingDirectory: string;
      executionScope: AttemptExecutionInputView['executionScope'];
    },
  ): void {
    const timestamp = nowMs();
    this.database.transaction(() => {
      const existing = this.get(attemptId);
      if (existing) {
        if (
          local !== undefined
          && existing.attempt_root === attemptId
          && existing.working_directory === attemptId
          && existing.execution_kind === 'workspace_scratch'
        ) {
          this.database.raw.prepare(
            `UPDATE local_runtime_executions
             SET attempt_root = ?, working_directory = ?, execution_kind = ?,
                 project_id = ?, repository_id = ?, repository_identity = ?
             WHERE attempt_id = ?`,
          ).run(
            local.attemptRoot,
            local.workingDirectory,
            local.executionScope.kind,
            local.executionScope.kind === 'project_repository' ? local.executionScope.projectId : null,
            local.executionScope.kind === 'project_repository' ? local.executionScope.repositoryId : null,
            local.executionScope.kind === 'project_repository' ? local.executionScope.repositoryIdentity : null,
            attemptId,
          );
          return;
        }
        invariant(
          existing.workspace_id === workspaceId
          && existing.run_id === runId
          && (local === undefined || (
            existing.attempt_root === local.attemptRoot
            && existing.working_directory === local.workingDirectory
            && existing.execution_kind === local.executionScope.kind
          )),
          'LOCAL_EXECUTION_CONFLICT',
          'The attempt is already bound to a different local execution.',
          409,
        );
        return;
      }
      this.database.raw
        .prepare(
          `INSERT INTO local_runtime_executions (
             attempt_id, workspace_id, run_id, attempt_root, working_directory, execution_kind,
             project_id, repository_id, repository_identity,
             phase, started_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)`,
        )
        .run(
          attemptId,
          workspaceId,
          runId,
          local?.attemptRoot ?? attemptId,
          local?.workingDirectory ?? attemptId,
          local?.executionScope.kind ?? 'workspace_scratch',
          local?.executionScope.kind === 'project_repository' ? local.executionScope.projectId : null,
          local?.executionScope.kind === 'project_repository' ? local.executionScope.repositoryId : null,
          local?.executionScope.kind === 'project_repository' ? local.executionScope.repositoryIdentity : null,
          timestamp,
        );
    });
  }

  beginReturn(attemptId: string): void {
    this.database.transaction(() => {
      const row = this.require(attemptId);
      if (row.phase === 'returning' || row.phase === 'finished') return;
      invariant(row.phase === 'running', 'INVALID_EXECUTION_PHASE', 'Execution is not running.', 409);
      this.database.raw
        .prepare("UPDATE local_runtime_executions SET phase = 'returning', return_prepared_at = ? WHERE attempt_id = ?")
        .run(nowMs(), attemptId);
    });
  }

  recordContextEvent(event: RuntimeContextEvent): void {
    this.require(event.attemptId);
    this.database.raw
      .prepare(
        `INSERT INTO runtime_context_events (id, attempt_id, event_type, details_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(newId(), event.attemptId, event.type, canonicalJson(event.details), event.createdAt);
  }

  recordPrivateMaterial(
    attemptId: string,
    grantId: string,
    relativePath: string,
    contentDigest: string,
    byteLength: number,
  ): void {
    this.require(attemptId);
    this.database.raw
      .prepare(
        `INSERT OR IGNORE INTO local_private_materializations (
           attempt_id, grant_id, relative_path, content_digest, byte_length, materialized_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(attemptId, grantId, relativePath, contentDigest, byteLength, nowMs());
    const row = this.database.raw
      .prepare(
        `SELECT content_digest, byte_length FROM local_private_materializations
         WHERE attempt_id = ? AND grant_id = ? AND relative_path = ?`,
      )
      .get(attemptId, grantId, relativePath) as { content_digest: string; byte_length: number };
    invariant(row.content_digest === contentDigest && row.byte_length === byteLength,
      'LOCAL_PRIVATE_MATERIAL_CONFLICT', 'Private material path was reused with different content.', 409);
  }

  finish(attemptId: string): void {
    this.database.transaction(() => {
      const row = this.require(attemptId);
      if (row.phase === 'finished') return;
      invariant(row.phase === 'returning', 'INVALID_EXECUTION_PHASE', 'Execution has not entered returning.', 409);
      this.database.raw
        .prepare("UPDATE local_runtime_executions SET phase = 'finished', finished_at = ? WHERE attempt_id = ?")
        .run(nowMs(), attemptId);
    });
  }

  cancelIfPresent(attemptId: string): void {
    this.database.transaction(() => {
      this.database.raw
        .prepare(
          `UPDATE local_runtime_executions
           SET phase = 'failed', finished_at = ?
           WHERE attempt_id = ? AND phase NOT IN ('finished', 'failed')`,
        )
        .run(nowMs(), attemptId);
    });
  }

  get(attemptId: string): LocalExecutionRow | undefined {
    return this.database.raw
      .prepare('SELECT * FROM local_runtime_executions WHERE attempt_id = ?')
      .get(attemptId) as LocalExecutionRow | undefined;
  }

  private require(attemptId: string): LocalExecutionRow {
    const row = this.get(attemptId);
    if (!row) {
      throw new DomainError('LOCAL_EXECUTION_NOT_FOUND', 'Local execution does not exist.', 404);
    }
    return row;
  }
}
