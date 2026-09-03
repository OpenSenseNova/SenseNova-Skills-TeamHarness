import { rmSync } from 'node:fs';
import { invariant } from '../lib/errors.js';
import { canonicalJson, newId, nowMs, sha256 } from '../lib/values.js';
import { SqliteDatabase } from './database.js';

export type HeldArtifactDraftStatus = 'pending' | 'held' | 'published' | 'discarded' | 'fenced';
export type HeldArtifactDraftPendingMode = 'check' | 'override' | 'discard';

export type HeldArtifactPublication =
  | {
      kind: 'file';
      artifactName?: string;
      artifactPath?: string;
      fileName: string;
      mediaType: string;
      artifactId?: string;
      expectedLatestVersionId?: string;
      parentVersionIds?: string[];
      sourceResourceRefs?: Array<{ resourceId: string; revision?: number; digest?: string }>;
      taskId?: string;
      messageId?: string;
      publishBatchId?: string;
      note?: string;
    };

export interface HeldArtifactDraftRow {
  id: string;
  workspace_id: string;
  agent_id: string;
  binding_revision: number;
  session_kind: 'mention' | 'work_item';
  session_key: string;
  draft_key: string;
  artifact_id: string | null;
  publication_json: string;
  publication_hash: string;
  content_path: string | null;
  expected_latest_version_id: string | null;
  held_current_latest_version_id: string | null;
  proposed_digest: string;
  rehold_count: number;
  status: HeldArtifactDraftStatus;
  pending_mode: HeldArtifactDraftPendingMode;
  idempotency_key: string;
  created_at: number;
  updated_at: number;
}

/** Local-only durable custody for unpublished Artifact bytes and publication intent. */
export class HeldArtifactDraftStore {
  constructor(private readonly database: SqliteDatabase) {}

  getActiveById(
    workspaceId: string,
    agentId: string,
    bindingRevision: number,
    sessionKind: HeldArtifactDraftRow['session_kind'],
    sessionKey: string,
    id: string,
  ): HeldArtifactDraftRow | undefined {
    return this.database.raw.prepare(
      `SELECT * FROM held_artifact_drafts
       WHERE workspace_id = ? AND agent_id = ? AND binding_revision = ?
         AND session_kind = ? AND session_key = ? AND id = ?
         AND status IN ('pending', 'held')`,
    ).get(workspaceId, agentId, bindingRevision, sessionKind, sessionKey, id) as HeldArtifactDraftRow | undefined;
  }

  getActiveByKey(
    workspaceId: string,
    agentId: string,
    bindingRevision: number,
    sessionKind: HeldArtifactDraftRow['session_kind'],
    sessionKey: string,
    draftKey: string,
  ): HeldArtifactDraftRow | undefined {
    return this.database.raw.prepare(
      `SELECT * FROM held_artifact_drafts
       WHERE workspace_id = ? AND agent_id = ? AND binding_revision = ?
         AND session_kind = ? AND session_key = ? AND draft_key = ?
         AND status IN ('pending', 'held')`,
    ).get(workspaceId, agentId, bindingRevision, sessionKind, sessionKey, draftKey) as HeldArtifactDraftRow | undefined;
  }

  listActive(
    workspaceId: string,
    agentId: string,
    bindingRevision: number,
    sessionKind: HeldArtifactDraftRow['session_kind'],
    sessionKey: string,
  ): HeldArtifactDraftRow[] {
    return this.database.raw.prepare(
      `SELECT * FROM held_artifact_drafts
       WHERE workspace_id = ? AND agent_id = ? AND binding_revision = ?
         AND session_kind = ? AND session_key = ?
         AND status IN ('pending', 'held') ORDER BY updated_at, id`,
    ).all(workspaceId, agentId, bindingRevision, sessionKind, sessionKey) as unknown as HeldArtifactDraftRow[];
  }

  listPendingSessions(): Array<{ agent_id: string; session_kind: HeldArtifactDraftRow['session_kind']; session_key: string }> {
    return this.sessions("status = 'pending'");
  }
  listActiveSessions(): Array<{ agent_id: string; session_kind: HeldArtifactDraftRow['session_kind']; session_key: string }> {
    return this.sessions("status IN ('pending', 'held')");
  }

  publication(draft: HeldArtifactDraftRow): HeldArtifactPublication {
    const publication = JSON.parse(draft.publication_json) as HeldArtifactPublication;
    invariant(publication.kind === 'file',
      'INVALID_HELD_ARTIFACT_DRAFT', 'Held Artifact draft publication is invalid.', 409);
    return publication;
  }

  createOrReviseCandidate(input: {
    id: string;
    workspaceId: string;
    agentId: string;
    bindingRevision: number;
    sessionKind: HeldArtifactDraftRow['session_kind'];
    sessionKey: string;
    draftKey: string;
    artifactId: string | null;
    publication: HeldArtifactPublication;
    contentPath?: string;
    expectedLatestVersionId?: string;
    proposedDigest: string;
  }): HeldArtifactDraftRow {
    return this.database.transaction(() => {
      const existing = this.getActiveByKey(
        input.workspaceId, input.agentId, input.bindingRevision,
        input.sessionKind, input.sessionKey, input.draftKey,
      );
      invariant(existing?.status !== 'pending', 'HELD_ARTIFACT_DRAFT_PENDING',
        'The prior Artifact draft submission is still being reconciled.', 409);
      if (existing) {
        invariant(
          existing.expected_latest_version_id === existing.held_current_latest_version_id
          && (input.expectedLatestVersionId ?? null) === existing.held_current_latest_version_id,
          'ARTIFACT_REVIEW_REQUIRED',
          'Read the current Artifact before revising this held draft.',
          409,
        );
      }
      const filePublication = input.publication.kind === 'file';
      invariant(filePublication === Boolean(input.contentPath), 'INVALID_HELD_ARTIFACT_DRAFT',
        'Artifact drafts require frozen local content.', 409);
      const publicationJson = canonicalJson(input.publication);
      const publicationHash = sha256(publicationJson);
      const timestamp = nowMs();
      if (existing) {
        if (existing.content_path && existing.content_path !== input.contentPath) rmSync(existing.content_path, { force: true });
        this.database.raw.prepare(
          `UPDATE held_artifact_drafts
           SET publication_json = ?, publication_hash = ?, content_path = ?, artifact_id = ?,
               expected_latest_version_id = ?, held_current_latest_version_id = NULL, proposed_digest = ?,
               status = 'pending', pending_mode = 'check', idempotency_key = ?, updated_at = ?
           WHERE id = ? AND status = 'held'`,
        ).run(
          publicationJson, publicationHash, input.contentPath ?? null, input.artifactId,
          input.expectedLatestVersionId ?? null, input.proposedDigest, newId(), timestamp, existing.id,
        );
        return this.require(existing.id);
      }
      this.database.raw.prepare(
        `INSERT INTO held_artifact_drafts (
           id, workspace_id, agent_id, binding_revision, session_kind, session_key, draft_key, artifact_id,
           publication_json, publication_hash, content_path, expected_latest_version_id,
           held_current_latest_version_id, proposed_digest, rehold_count, status, pending_mode,
           idempotency_key, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 0, 'pending', 'check', ?, ?, ?)`,
      ).run(
        input.id, input.workspaceId, input.agentId, input.bindingRevision, input.sessionKind, input.sessionKey, input.draftKey,
        input.artifactId, publicationJson, publicationHash, input.contentPath ?? null,
        input.expectedLatestVersionId ?? null, input.proposedDigest, newId(), timestamp, timestamp,
      );
      return this.require(input.id);
    });
  }

  prepareHeld(id: string, mode: HeldArtifactDraftPendingMode): HeldArtifactDraftRow {
    return this.database.transaction(() => {
      const current = this.require(id);
      invariant(current.status === 'held', 'HELD_ARTIFACT_DRAFT_NOT_AVAILABLE',
        'No held Artifact draft is available.', 409);
      invariant(mode !== 'override' || current.rehold_count > 0,
        'FRESHNESS_OVERRIDE_NOT_ALLOWED', 'Publish anyway requires at least one Artifact freshness hold.', 409);
    invariant(mode === 'discard' || current.expected_latest_version_id === current.held_current_latest_version_id,
        'ARTIFACT_REVIEW_REQUIRED', 'Read the current Artifact before retrying this held draft.', 409);
      this.database.raw.prepare(
        `UPDATE held_artifact_drafts
         SET status = 'pending', pending_mode = ?, idempotency_key = ?, updated_at = ?
         WHERE id = ? AND status = 'held'`,
      ).run(mode, newId(), nowMs(), id);
      return this.require(id);
    });
  }

  markReviewed(artifactId: string, latestVersionId: string | null): number {
    return Number(this.database.raw.prepare(
      `UPDATE held_artifact_drafts SET expected_latest_version_id = ?, updated_at = ?
       WHERE artifact_id = ? AND status = 'held' AND held_current_latest_version_id IS ?`,
    ).run(latestVersionId, nowMs(), artifactId, latestVersionId).changes);
  }

  markHeld(id: string, currentLatestVersionId: string | null, proposedDigest?: string): HeldArtifactDraftRow {
    this.database.raw.prepare(
      `UPDATE held_artifact_drafts
       SET status = 'held', held_current_latest_version_id = ?, proposed_digest = COALESCE(?, proposed_digest),
           rehold_count = rehold_count + 1, updated_at = ?
       WHERE id = ? AND status = 'pending'`,
    ).run(currentLatestVersionId, proposedDigest ?? null, nowMs(), id);
    return this.require(id);
  }

  markPublished(id: string): HeldArtifactDraftRow { return this.markTerminal(id, 'published'); }
  markDiscarded(id: string): HeldArtifactDraftRow { return this.markTerminal(id, 'discarded'); }

  fenceOtherBindings(workspaceId: string, agentId: string, bindingRevision: number): number {
    const rows = this.database.raw.prepare(
      `SELECT * FROM held_artifact_drafts
       WHERE workspace_id = ? AND agent_id = ? AND binding_revision <> ?
         AND status IN ('pending', 'held')`,
    ).all(workspaceId, agentId, bindingRevision) as unknown as HeldArtifactDraftRow[];
    this.database.raw.prepare(
      `UPDATE held_artifact_drafts SET status = 'fenced', updated_at = ?
       WHERE workspace_id = ? AND agent_id = ? AND binding_revision <> ?
         AND status IN ('pending', 'held')`,
    ).run(nowMs(), workspaceId, agentId, bindingRevision);
    rows.forEach((row) => this.removeContent(row));
    return rows.length;
  }

  private markTerminal(id: string, status: 'published' | 'discarded'): HeldArtifactDraftRow {
    const current = this.require(id);
    this.database.raw.prepare(
      `UPDATE held_artifact_drafts SET status = ?, updated_at = ?
       WHERE id = ? AND status = 'pending'`,
    ).run(status, nowMs(), id);
    this.removeContent(current);
    return this.require(id);
  }

  private removeContent(row: HeldArtifactDraftRow): void {
    if (row.content_path) rmSync(row.content_path, { force: true });
  }

  private sessions(predicate: string): Array<{ agent_id: string; session_kind: HeldArtifactDraftRow['session_kind']; session_key: string }> {
    const rows = this.database.raw.prepare(
      `SELECT DISTINCT agent_id, session_kind, session_key FROM held_artifact_drafts
       WHERE ${predicate} ORDER BY agent_id, session_kind, session_key`,
    ).all() as unknown as Array<{ agent_id: string; session_kind: HeldArtifactDraftRow['session_kind']; session_key: string }>;
    return rows;
  }

  private require(id: string): HeldArtifactDraftRow {
    const row = this.database.raw.prepare('SELECT * FROM held_artifact_drafts WHERE id = ?')
      .get(id) as HeldArtifactDraftRow | undefined;
    invariant(row, 'HELD_ARTIFACT_DRAFT_NOT_FOUND', 'Held Artifact draft does not exist.', 404);
    return row;
  }
}
