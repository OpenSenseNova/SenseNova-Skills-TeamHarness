import { invariant } from '../lib/errors.js';
import { newId, nowMs, sha256 } from '../lib/values.js';
import { SqliteDatabase } from './database.js';

export type HeldDraftStatus = 'pending' | 'held' | 'published' | 'discarded' | 'fenced';
export type HeldDraftPendingMode = 'check' | 'override' | 'discard';

export interface HeldDraftRow {
  id: string;
  workspace_id: string;
  agent_id: string;
  binding_revision: number;
  session_kind: 'mention' | 'work_item';
  session_key: string;
  target: string;
  receipt: string;
  body: string;
  body_hash: string;
  artifact_ids_json: string;
  mentioned_actor_ids_json: string;
  work_item_ids_json: string;
  based_on_position: number;
  reviewed_through_position: number;
  rehold_count: number;
  status: HeldDraftStatus;
  pending_mode: HeldDraftPendingMode;
  idempotency_key: string;
  created_at: number;
  updated_at: number;
}

interface CandidateInput {
  workspaceId: string;
  agentId: string;
  bindingRevision: number;
  sessionKind: HeldDraftRow['session_kind'];
  sessionKey: string;
  target: string;
  receipt: string;
  body: string;
  artifactIds?: string[];
  mentionedActorIds?: string[];
  workItemIds?: string[];
  basedOnPosition: number;
}

/** Durable local custody for unpublished Agent Message bodies. */
export class HeldDraftStore {
  constructor(private readonly database: SqliteDatabase) {}

  getActive(
    workspaceId: string,
    agentId: string,
    bindingRevision: number,
    sessionKind: HeldDraftRow['session_kind'],
    sessionKey: string,
    target: string,
  ): HeldDraftRow | undefined {
    return this.database.raw.prepare(
      `SELECT * FROM held_drafts
       WHERE workspace_id = ? AND agent_id = ? AND binding_revision = ?
         AND session_kind = ? AND session_key = ? AND target = ?
         AND status IN ('pending', 'held')`,
    ).get(workspaceId, agentId, bindingRevision, sessionKind, sessionKey, target) as HeldDraftRow | undefined;
  }

  listActive(
    workspaceId: string,
    agentId: string,
    bindingRevision: number,
    sessionKind: HeldDraftRow['session_kind'],
    sessionKey: string,
  ): HeldDraftRow[] {
    return this.database.raw.prepare(
      `SELECT * FROM held_drafts
       WHERE workspace_id = ? AND agent_id = ? AND binding_revision = ?
         AND session_kind = ? AND session_key = ?
         AND status IN ('pending', 'held')
       ORDER BY updated_at, id`,
    ).all(workspaceId, agentId, bindingRevision, sessionKind, sessionKey) as unknown as HeldDraftRow[];
  }

  artifactIds(draft: HeldDraftRow): string[] {
    const parsed = JSON.parse(draft.artifact_ids_json) as unknown;
    invariant(Array.isArray(parsed) && parsed.every((artifactId) => typeof artifactId === 'string'),
      'INVALID_HELD_DRAFT', 'Held draft Artifact references are invalid.', 409);
    return parsed;
  }

  mentionedActorIds(draft: HeldDraftRow): string[] {
    return this.stringArrayJson(draft.mentioned_actor_ids_json, 'Agent mention');
  }

  workItemIds(draft: HeldDraftRow): string[] {
    return this.stringArrayJson(draft.work_item_ids_json, 'WorkItem');
  }

  private stringArrayJson(value: string, label: string): string[] {
    const parsed = JSON.parse(value) as unknown;
    invariant(Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string'),
      'INVALID_HELD_DRAFT', `Held draft ${label} references are invalid.`, 409);
    return parsed;
  }

  listPendingSessions(): Array<{ agent_id: string; session_kind: HeldDraftRow['session_kind']; session_key: string }> {
    const rows = this.database.raw.prepare(
      `SELECT DISTINCT agent_id, session_kind, session_key FROM held_drafts
       WHERE status = 'pending' ORDER BY agent_id, session_kind, session_key`,
    ).all() as unknown as Array<{ agent_id: string; session_kind: HeldDraftRow['session_kind']; session_key: string }>;
    return rows;
  }

  listActiveSessions(): Array<{ agent_id: string; session_kind: HeldDraftRow['session_kind']; session_key: string }> {
    const rows = this.database.raw.prepare(
      `SELECT DISTINCT agent_id, session_kind, session_key FROM held_drafts
       WHERE status IN ('pending', 'held') ORDER BY agent_id, session_kind, session_key`,
    ).all() as unknown as Array<{ agent_id: string; session_kind: HeldDraftRow['session_kind']; session_key: string }>;
    return rows;
  }

  fenceOtherBindings(workspaceId: string, agentId: string, bindingRevision: number): number {
    return Number(this.database.raw.prepare(
      `UPDATE held_drafts SET status = 'fenced', updated_at = ?
       WHERE workspace_id = ? AND agent_id = ? AND binding_revision <> ?
         AND status IN ('pending', 'held')`,
    ).run(nowMs(), workspaceId, agentId, bindingRevision).changes);
  }

  createOrReviseCandidate(input: CandidateInput): HeldDraftRow {
    return this.database.transaction(() => {
      const existing = this.getActive(
        input.workspaceId,
        input.agentId,
        input.bindingRevision,
        input.sessionKind,
        input.sessionKey,
        input.target,
      );
      invariant(existing?.status !== 'pending', 'HELD_DRAFT_PENDING',
        'The prior draft submission is still being reconciled.', 409);
      const timestamp = nowMs();
      const body = input.body.trim();
      invariant(body.length > 0, 'INVALID_MESSAGE', 'Agent Message body is required.', 400);
      const artifactIds = input.artifactIds ?? [];
      invariant(artifactIds.length <= 100
        && artifactIds.every((artifactId) => typeof artifactId === 'string' && artifactId.length > 0)
        && new Set(artifactIds).size === artifactIds.length,
      'INVALID_ARTIFACT_REFERENCES', 'Artifact references must be unique and may not exceed 100 items.', 400);
      const artifactIdsJson = JSON.stringify(artifactIds);
      const mentionedActorIds = [...new Set(input.mentionedActorIds ?? [])];
      const workItemIds = [...new Set(input.workItemIds ?? [])];
      invariant(mentionedActorIds.length <= 50 && mentionedActorIds.every((id) => typeof id === 'string' && id.length > 0),
        'INVALID_MENTION_REFERENCES', 'Agent mention references are invalid.', 400);
      invariant(workItemIds.length <= 50 && workItemIds.every((id) => typeof id === 'string' && id.length > 0),
        'INVALID_WORK_ITEM_REFERENCES', 'WorkItem references are invalid.', 400);
      const mentionedActorIdsJson = JSON.stringify(mentionedActorIds);
      const workItemIdsJson = JSON.stringify(workItemIds);
      const bodyHash = sha256(body);
      const idempotencyKey = newId();
      if (existing) {
        this.database.raw.prepare(
          `UPDATE held_drafts
           SET receipt = ?, body = ?, body_hash = ?, artifact_ids_json = ?, mentioned_actor_ids_json = ?, work_item_ids_json = ?,
               status = 'pending', pending_mode = 'check',
               based_on_position = ?, reviewed_through_position = MAX(reviewed_through_position, ?),
               idempotency_key = ?, updated_at = ?
           WHERE id = ? AND status = 'held'`,
        ).run(
          input.receipt,
          body,
          bodyHash,
          artifactIdsJson,
          mentionedActorIdsJson,
          workItemIdsJson,
          input.basedOnPosition,
          input.basedOnPosition,
          idempotencyKey,
          timestamp,
          existing.id,
        );
        return this.require(existing.id);
      }
      const id = newId();
      this.database.raw.prepare(
        `INSERT INTO held_drafts (
           id, workspace_id, agent_id, binding_revision, session_kind, session_key, target, receipt,
           body, body_hash, artifact_ids_json, mentioned_actor_ids_json, work_item_ids_json,
           based_on_position, reviewed_through_position,
           rehold_count, status, pending_mode, idempotency_key, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending', 'check', ?, ?, ?)`,
      ).run(
        id,
        input.workspaceId,
        input.agentId,
        input.bindingRevision,
        input.sessionKind,
        input.sessionKey,
        input.target,
        input.receipt,
        body,
        bodyHash,
        artifactIdsJson,
        mentionedActorIdsJson,
        workItemIdsJson,
        input.basedOnPosition,
        input.basedOnPosition,
        idempotencyKey,
        timestamp,
        timestamp,
      );
      return this.require(id);
    });
  }

  prepareHeld(id: string, mode: 'check' | 'override' | 'discard'): HeldDraftRow {
    return this.database.transaction(() => {
      const current = this.require(id);
      invariant(current.status === 'held', 'HELD_DRAFT_NOT_AVAILABLE',
        'No held draft is available for this target.', 409);
      invariant(mode !== 'override' || current.rehold_count > 0,
        'FRESHNESS_OVERRIDE_NOT_ALLOWED', 'Send anyway requires at least one freshness hold.', 409);
      const basedOnPosition = mode === 'discard'
        ? current.based_on_position
        : current.reviewed_through_position;
      this.database.raw.prepare(
        `UPDATE held_drafts
         SET status = 'pending', pending_mode = ?, based_on_position = ?, idempotency_key = ?, updated_at = ?
         WHERE id = ? AND status = 'held'`,
      ).run(mode, basedOnPosition, newId(), nowMs(), id);
      return this.require(id);
    });
  }

  markReviewed(id: string, receipt: string, reviewedThroughPosition: number): HeldDraftRow {
    this.database.raw.prepare(
      `UPDATE held_drafts
       SET receipt = ?, reviewed_through_position = MAX(reviewed_through_position, ?), updated_at = ?
       WHERE id = ? AND status = 'held'`,
    ).run(receipt, reviewedThroughPosition, nowMs(), id);
    return this.require(id);
  }

  markHeld(id: string, reviewedThroughPosition: number): HeldDraftRow {
    this.database.raw.prepare(
      `UPDATE held_drafts
       SET status = 'held', reviewed_through_position = MAX(reviewed_through_position, ?),
           rehold_count = rehold_count + 1, updated_at = ?
       WHERE id = ? AND status = 'pending'`,
    ).run(reviewedThroughPosition, nowMs(), id);
    return this.require(id);
  }

  markPublished(id: string): HeldDraftRow {
    this.database.raw.prepare(
      `UPDATE held_drafts SET status = 'published', updated_at = ?
       WHERE id = ? AND status = 'pending'`,
    ).run(nowMs(), id);
    return this.require(id);
  }

  markDiscarded(id: string): HeldDraftRow {
    this.database.raw.prepare(
      `UPDATE held_drafts SET status = 'discarded', updated_at = ?
       WHERE id = ? AND status = 'pending'`,
    ).run(nowMs(), id);
    return this.require(id);
  }

  private require(id: string): HeldDraftRow {
    const row = this.database.raw.prepare('SELECT * FROM held_drafts WHERE id = ?').get(id) as HeldDraftRow | undefined;
    invariant(row, 'HELD_DRAFT_NOT_FOUND', 'Held draft does not exist.', 404);
    return row;
  }
}
