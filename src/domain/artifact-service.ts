import { createHash } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import * as Y from 'yjs';
import type {
  ArtifactCurrentStateView,
  ArtifactSnapshotSaveView,
  ArtifactSnapshotView,
  ArtifactType,
  ArtifactView,
  HumanPrincipal,
  MessageArtifactReferenceView,
  StagedBlobView,
} from './types.js';
import { DomainError, invariant, isSqliteConstraintError } from '../lib/errors.js';
import { canonicalJson, newId, nowMs, sha256 } from '../lib/values.js';
import { ContentBlobStore, MAX_ARTIFACT_BYTES, type StoredContentBlob } from '../storage/content-blob-store.js';
import type { SqliteDatabase } from '../storage/database.js';

const TRASH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const STAGED_BLOB_RETENTION_MS = 24 * 60 * 60 * 1000;

interface MembershipRow {
  id: string;
  workspace_id: string;
  actor_id: string;
  membership_role: 'owner' | 'member';
}

interface ArtifactRow {
  id: string;
  workspace_id: string;
  name: string;
  artifact_type: ArtifactType;
  current_snapshot_id: string | null;
  created_by_membership_id: string;
  revision: number;
  status: 'active' | 'deleted' | 'purged';
  deleted_at: number | null;
  purge_after: number | null;
  purged_at: number | null;
  created_at: number;
  updated_at: number;
}

interface ArtifactSnapshotRow {
  id: string;
  workspace_id: string;
  artifact_id: string;
  label: string | null;
  parent_snapshot_id: string | null;
  blob_hash: string;
  content_digest: string;
  media_type: string;
  byte_length: number;
  created_by_actor_id: string;
  created_by_membership_id: string;
  producing_run_id: string | null;
  producing_attempt_id: string | null;
  revision: number;
  status: 'active' | 'deleted';
  deleted_at: number | null;
  purge_after: number | null;
  created_at: number;
  updated_at: number;
}

interface DraftRow {
  workspace_id: string;
  artifact_id: string;
  base_snapshot_id: string | null;
  yjs_state: Uint8Array;
  draft_revision: number;
  updated_by_membership_id: string;
  updated_at: number;
}

interface FileStateRow {
  workspace_id: string;
  artifact_id: string;
  blob_hash: string;
  content_digest: string;
  media_type: string;
  byte_length: number;
  current_revision: number;
  updated_by_membership_id: string;
  updated_at: number;
}

export interface AgentArtifactPublication {
  stagedBlobId: string;
  artifactId?: string;
  name: string;
  artifactType: ArtifactType;
  projectIds?: string[];
  expectedCurrentRevision?: number;
  expectedContentDigest?: string;
}

export interface AgentPublicationContext {
  workspaceId: string;
  actorId: string;
  membershipId: string;
  runId: string;
  attemptId: string;
}

export class ArtifactService {
  constructor(
    readonly database: SqliteDatabase,
    readonly blobs: ContentBlobStore,
  ) {}

  list(
    principal: HumanPrincipal,
    workspaceId: string,
    options: { projectId?: string; trash?: boolean } = {},
  ): ArtifactView[] {
    this.requireMembership(workspaceId, principal.actorId);
    if (options.projectId) this.requireProjectAccess(workspaceId, options.projectId, principal.actorId);
    const status = options.trash ? 'deleted' : 'active';
    const rows = this.database.raw.prepare(
      `SELECT a.* FROM artifacts a
       WHERE a.workspace_id = ? AND a.status = ?
         AND (? IS NULL OR EXISTS (
           SELECT 1 FROM artifact_project_associations apa
           WHERE apa.workspace_id = a.workspace_id AND apa.artifact_id = a.id AND apa.project_id = ?
         ))
       ORDER BY a.updated_at DESC, a.id`,
    ).all(workspaceId, status, options.projectId ?? null, options.projectId ?? null) as unknown as ArtifactRow[];
    return rows.map((row) => this.hydrate(row));
  }

  cleanupStatus(principal: HumanPrincipal, workspaceId: string): {
    deletedCount: number;
    expiredDeletedCount: number;
    stagedBlobCount: number;
    expiredStagedBlobCount: number;
    nextPurgeAt: number | null;
    checkedAt: number;
  } {
    this.requireMembership(workspaceId, principal.actorId);
    const checkedAt = nowMs();
    const artifacts = this.database.raw.prepare(
      `SELECT COUNT(*) AS deleted_count,
              SUM(CASE WHEN purge_after <= ? THEN 1 ELSE 0 END) AS expired_count,
              MIN(purge_after) AS next_purge_at
       FROM artifacts WHERE workspace_id = ? AND status = 'deleted'`,
    ).get(checkedAt, workspaceId) as {
      deleted_count: number;
      expired_count: number | null;
      next_purge_at: number | null;
    };
    const staged = this.database.raw.prepare(
      `SELECT COUNT(*) AS staged_count,
              SUM(CASE WHEN expires_at <= ? THEN 1 ELSE 0 END) AS expired_count
       FROM staged_blobs WHERE workspace_id = ?`,
    ).get(checkedAt, workspaceId) as { staged_count: number; expired_count: number | null };
    return {
      deletedCount: artifacts.deleted_count,
      expiredDeletedCount: artifacts.expired_count ?? 0,
      stagedBlobCount: staged.staged_count,
      expiredStagedBlobCount: staged.expired_count ?? 0,
      nextPurgeAt: artifacts.next_purge_at,
      checkedAt,
    };
  }

  get(principal: HumanPrincipal, artifactId: string, includeDeleted = false): ArtifactView {
    const artifact = this.requireArtifact(artifactId);
    this.requireMembership(artifact.workspace_id, principal.actorId);
    invariant(
      artifact.status === 'active' || (includeDeleted && artifact.status === 'deleted'),
      'ARTIFACT_NOT_FOUND',
      'Artifact does not exist or is unavailable.',
      404,
    );
    return this.hydrate(artifact);
  }

  createMarkdown(
    principal: HumanPrincipal,
    workspaceId: string,
    input: { name: string; projectIds?: string[] },
    idempotencyKey: string,
  ): ArtifactView {
    const name = this.normalizeName(input.name);
    const projectIds = this.normalizeProjectIds(input.projectIds);
    return this.command(workspaceId, principal.actorId, 'CreateMarkdownArtifact', idempotencyKey, { name, projectIds }, () => {
      const membership = this.requireMembership(workspaceId, principal.actorId);
      for (const projectId of projectIds) this.requireProjectAccess(workspaceId, projectId, principal.actorId);
      const artifactId = newId();
      const timestamp = nowMs();
      this.database.raw.prepare(
        `INSERT INTO artifacts (
           id, workspace_id, name, artifact_type, created_by_membership_id,
           revision, status, created_at, updated_at
         ) VALUES (?, ?, ?, 'markdown', ?, 1, 'active', ?, ?)`,
      ).run(artifactId, workspaceId, name, membership.id, timestamp, timestamp);
      this.database.raw.prepare(
        `INSERT INTO artifact_drafts (
           workspace_id, artifact_id, base_snapshot_id, yjs_state, draft_revision,
           updated_by_membership_id, updated_at
         ) VALUES (?, ?, NULL, ?, 0, ?, ?)`,
      ).run(workspaceId, artifactId, Buffer.from(Y.encodeStateAsUpdate(new Y.Doc())), membership.id, timestamp);
      this.insertProjectAssociations(workspaceId, artifactId, projectIds, membership.id, timestamp);
      this.record(workspaceId, principal.actorId, membership.id, 'artifact_created', 'artifact.create', artifactId, {
        artifactType: 'markdown', name, projectIds,
      }, timestamp);
      return this.hydrate(this.requireArtifact(artifactId));
    });
  }

  createFile(
    principal: HumanPrincipal,
    workspaceId: string,
    input: { name: string; projectIds?: string[] },
    stored: StoredContentBlob,
    idempotencyKey: string,
  ): ArtifactView {
    const name = this.normalizeName(input.name);
    const projectIds = this.normalizeProjectIds(input.projectIds);
    return this.command(workspaceId, principal.actorId, 'CreateFileArtifact', idempotencyKey, {
      name, projectIds, contentDigest: stored.hash,
    }, () => {
      const membership = this.requireMembership(workspaceId, principal.actorId);
      for (const projectId of projectIds) this.requireProjectAccess(workspaceId, projectId, principal.actorId);
      const artifactId = newId();
      const timestamp = nowMs();
      this.database.raw.prepare(
        `INSERT INTO artifacts (
           id, workspace_id, name, artifact_type, created_by_membership_id,
           revision, status, created_at, updated_at
         ) VALUES (?, ?, ?, 'file', ?, 1, 'active', ?, ?)`,
      ).run(artifactId, workspaceId, name, membership.id, timestamp, timestamp);
      this.registerBlob(stored);
      this.database.raw.prepare(
        `INSERT INTO artifact_file_states (
           workspace_id, artifact_id, blob_hash, content_digest, media_type, byte_length,
           current_revision, updated_by_membership_id, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      ).run(
        workspaceId, artifactId, stored.hash, stored.hash, stored.mediaType,
        stored.byteLength, membership.id, timestamp,
      );
      this.insertProjectAssociations(workspaceId, artifactId, projectIds, membership.id, timestamp);
      this.record(workspaceId, principal.actorId, membership.id, 'artifact_created', 'artifact.create', artifactId, {
        artifactType: 'file', name, projectIds, contentDigest: stored.hash,
      }, timestamp);
      return this.hydrate(this.requireArtifact(artifactId));
    });
  }

  replaceFileCurrent(
    principal: HumanPrincipal,
    artifactId: string,
    input: { expectedCurrentRevision: number },
    stored: StoredContentBlob,
    idempotencyKey: string,
  ): ArtifactView {
    const artifact = this.requireArtifact(artifactId);
    return this.command(artifact.workspace_id, principal.actorId, 'ReplaceFileArtifactCurrent', idempotencyKey, {
      artifactId, expectedCurrentRevision: input.expectedCurrentRevision, contentDigest: stored.hash,
    }, () => {
      const current = this.requireArtifact(artifactId);
      const membership = this.requireMembership(current.workspace_id, principal.actorId);
      invariant(current.status === 'active' && current.artifact_type === 'file', 'ARTIFACT_NOT_EDITABLE', 'File Artifact is unavailable.', 409);
      const fileState = this.requireFileState(artifactId);
      invariant(fileState.current_revision === input.expectedCurrentRevision, 'ARTIFACT_CURRENT_CONFLICT', 'Artifact current state changed.', 409, {
        currentRevision: fileState.current_revision,
      });
      invariant(fileState.content_digest !== stored.hash, 'ARTIFACT_CONTENT_UNCHANGED', 'Artifact content is unchanged.', 409);
      const timestamp = nowMs();
      this.registerBlob(stored);
      this.database.raw.prepare(
        `UPDATE artifact_file_states SET blob_hash = ?, content_digest = ?, media_type = ?, byte_length = ?,
           current_revision = current_revision + 1, updated_by_membership_id = ?, updated_at = ?
         WHERE workspace_id = ? AND artifact_id = ? AND current_revision = ?`,
      ).run(
        stored.hash, stored.hash, stored.mediaType, stored.byteLength, membership.id, timestamp,
        current.workspace_id, artifactId, input.expectedCurrentRevision,
      );
      this.database.raw.prepare(
        'UPDATE artifacts SET revision = revision + 1, updated_at = ? WHERE workspace_id = ? AND id = ?',
      ).run(timestamp, current.workspace_id, artifactId);
      this.record(current.workspace_id, principal.actorId, membership.id, 'artifact_current_changed', 'artifact.current.replace', artifactId, {
        contentDigest: stored.hash,
      }, timestamp);
      return this.hydrate(this.requireArtifact(artifactId));
    });
  }

  async saveCurrentSnapshot(
    principal: HumanPrincipal,
    artifactId: string,
    input: { expectedCurrentRevision: number; label: string | null },
    idempotencyKey: string,
  ): Promise<ArtifactSnapshotSaveView> {
    const before = this.requireArtifact(artifactId);
    this.requireMembership(before.workspace_id, principal.actorId);
    const label = this.normalizeSnapshotLabel(input.label);
    const commandRequest = { artifactId, expectedCurrentRevision: input.expectedCurrentRevision, label };
    const replay = this.commandReplay<ArtifactSnapshotSaveView>(
      before.workspace_id,
      principal.actorId,
      'SaveArtifactSnapshot',
      idempotencyKey,
      commandRequest,
    );
    if (replay) return replay;
    invariant(before.status === 'active', 'ARTIFACT_NOT_EDITABLE', 'Artifact is unavailable.', 409);
    const initialState = this.currentStateRow(before);
    invariant(initialState.currentRevision === input.expectedCurrentRevision, 'ARTIFACT_CURRENT_CONFLICT', 'Artifact current state changed.', 409, {
      currentRevision: initialState.currentRevision,
    });
    const stored = before.artifact_type === 'markdown'
      ? await this.blobs.writeBuffer(
        Buffer.from(this.markdownFromState(this.requireDraft(artifactId).yjs_state), 'utf8'),
        'text/markdown; charset=utf-8',
      )
      : this.storedForFileState(this.requireFileState(artifactId));
    return this.command(before.workspace_id, principal.actorId, 'SaveArtifactSnapshot', idempotencyKey, commandRequest, () => {
      const current = this.requireArtifact(artifactId);
      const currentMembership = this.requireMembership(current.workspace_id, principal.actorId);
      const currentState = this.currentStateRow(current);
      invariant(currentState.currentRevision === input.expectedCurrentRevision, 'ARTIFACT_CURRENT_CONFLICT', 'Artifact current state changed.', 409, {
        currentRevision: currentState.currentRevision,
      });
      invariant(currentState.contentDigest === stored.hash, 'ARTIFACT_CURRENT_CONFLICT', 'Artifact current content changed.', 409);
      const timestamp = nowMs();
      const saved = this.saveOrReuseSnapshot({
        workspaceId: current.workspace_id, artifactId, parentSnapshotId: current.current_snapshot_id,
        label, stored, actorId: principal.actorId, membershipId: currentMembership.id,
        runId: null, attemptId: null, timestamp,
      });
      if (current.artifact_type === 'markdown' && saved.created) {
        this.database.raw.prepare(
          'UPDATE artifact_drafts SET base_snapshot_id = ?, updated_at = ? WHERE workspace_id = ? AND artifact_id = ?',
        ).run(saved.snapshot.snapshotId, timestamp, current.workspace_id, artifactId);
      }
      this.record(current.workspace_id, principal.actorId, currentMembership.id, 'artifact_snapshot_saved', 'artifact.snapshot.save', artifactId, {
        snapshotId: saved.snapshot.snapshotId,
        created: saved.created,
        labelChanged: saved.labelChanged,
      }, timestamp);
      return { ...saved, artifact: this.hydrate(this.requireArtifact(artifactId)) };
    });
  }

  rename(
    principal: HumanPrincipal,
    artifactId: string,
    input: { name: string; expectedRevision: number },
    idempotencyKey: string,
  ): ArtifactView {
    const artifact = this.requireArtifact(artifactId);
    const name = this.normalizeName(input.name);
    return this.command(artifact.workspace_id, principal.actorId, 'RenameArtifact', idempotencyKey, { artifactId, ...input, name }, () => {
      const current = this.requireArtifact(artifactId);
      const membership = this.requireMembership(current.workspace_id, principal.actorId);
      invariant(current.status === 'active', 'ARTIFACT_NOT_FOUND', 'Artifact is unavailable.', 404);
      const update = this.database.raw.prepare(
        `UPDATE artifacts SET name = ?, revision = revision + 1, updated_at = ?
         WHERE id = ? AND revision = ? RETURNING revision`,
      ).get(name, nowMs(), artifactId, input.expectedRevision);
      invariant(update, 'STALE_REVISION', 'Artifact revision changed.', 409);
      const timestamp = nowMs();
      this.record(current.workspace_id, principal.actorId, membership.id, 'artifact_renamed', 'artifact.rename', artifactId, { name }, timestamp);
      return this.hydrate(this.requireArtifact(artifactId));
    });
  }

  renameSnapshot(
    principal: HumanPrincipal,
    artifactId: string,
    snapshotId: string,
    input: { label: string | null; expectedRevision: number },
    idempotencyKey: string,
  ): ArtifactSnapshotView {
    const artifact = this.requireArtifact(artifactId);
    const label = this.normalizeSnapshotLabel(input.label);
    return this.command(
      artifact.workspace_id,
      principal.actorId,
      'RenameArtifactSnapshot',
      idempotencyKey,
      { artifactId, snapshotId, expectedRevision: input.expectedRevision, label },
      () => {
        const current = this.requireArtifact(artifactId);
        const membership = this.requireMembership(current.workspace_id, principal.actorId);
        this.requireReadableContent(current);
        const timestamp = nowMs();
        const updated = this.database.raw.prepare(
          `UPDATE artifact_snapshots SET label = ?, revision = revision + 1, updated_at = ?
           WHERE workspace_id = ? AND artifact_id = ? AND id = ? AND status = 'active' AND revision = ?
           RETURNING *`,
        ).get(label, timestamp, current.workspace_id, artifactId, snapshotId, input.expectedRevision) as ArtifactSnapshotRow | undefined;
        invariant(updated, 'STALE_ARTIFACT_SNAPSHOT', 'Artifact snapshot changed or is unavailable.', 409);
        this.record(current.workspace_id, principal.actorId, membership.id, 'artifact_snapshot_renamed', 'artifact.snapshot.rename', artifactId, {
          snapshotId,
          label,
        }, timestamp);
        return this.mapSnapshot(updated);
      },
    );
  }

  deleteSnapshot(
    principal: HumanPrincipal,
    artifactId: string,
    snapshotId: string,
    expectedRevision: number,
    idempotencyKey: string,
  ): ArtifactView {
    const artifact = this.requireArtifact(artifactId);
    return this.command(
      artifact.workspace_id,
      principal.actorId,
      'DeleteArtifactSnapshot',
      idempotencyKey,
      { artifactId, snapshotId, expectedRevision },
      () => {
        const current = this.requireArtifact(artifactId);
        const membership = this.requireMembership(current.workspace_id, principal.actorId);
        this.requireReadableContent(current);
        const snapshot = this.requireSnapshot(current.workspace_id, artifactId, snapshotId);
        invariant(snapshot.status === 'active', 'ARTIFACT_SNAPSHOT_NOT_FOUND', 'Artifact snapshot does not exist or is unavailable.', 404);
        invariant(
          membership.membership_role === 'owner' || snapshot.created_by_membership_id === membership.id,
          'ARTIFACT_SNAPSHOT_DELETE_FORBIDDEN',
          'Only the snapshot creator or a Workspace Owner may delete it.',
          403,
        );
        const timestamp = nowMs();
        const replacementSnapshotId = this.nearestActiveAncestor(current.workspace_id, artifactId, snapshot.parent_snapshot_id);
        const updated = this.database.raw.prepare(
          `UPDATE artifact_snapshots SET status = 'deleted', deleted_at = ?, purge_after = ?,
             revision = revision + 1, updated_at = ?
           WHERE workspace_id = ? AND artifact_id = ? AND id = ? AND status = 'active' AND revision = ?
           RETURNING id`,
        ).get(
          timestamp, timestamp + TRASH_RETENTION_MS, timestamp,
          current.workspace_id, artifactId, snapshotId, expectedRevision,
        );
        invariant(updated, 'STALE_ARTIFACT_SNAPSHOT', 'Artifact snapshot changed or is unavailable.', 409);
        if (current.current_snapshot_id === snapshotId) {
          this.database.raw.prepare(
            `UPDATE artifacts SET current_snapshot_id = ?, revision = revision + 1, updated_at = ?
             WHERE workspace_id = ? AND id = ?`,
          ).run(replacementSnapshotId, timestamp, current.workspace_id, artifactId);
        }
        this.record(current.workspace_id, principal.actorId, membership.id, 'artifact_snapshot_deleted', 'artifact.snapshot.delete', artifactId, {
          snapshotId,
          replacementSnapshotId,
        }, timestamp);
        return this.hydrate(this.requireArtifact(artifactId));
      },
    );
  }

  restoreSnapshot(
    principal: HumanPrincipal,
    artifactId: string,
    snapshotId: string,
    expectedCurrentRevision: number,
    idempotencyKey: string,
  ): ArtifactView {
    const artifact = this.requireArtifact(artifactId);
    return this.command(
      artifact.workspace_id,
      principal.actorId,
      'RestoreArtifactSnapshot',
      idempotencyKey,
      { artifactId, snapshotId, expectedCurrentRevision },
      () => {
        const current = this.requireArtifact(artifactId);
        const membership = this.requireMembership(current.workspace_id, principal.actorId);
        this.requireReadableContent(current);
        const snapshot = this.requireSnapshot(current.workspace_id, artifactId, snapshotId);
        invariant(snapshot.status === 'active', 'ARTIFACT_SNAPSHOT_NOT_FOUND', 'Artifact snapshot does not exist or is unavailable.', 404);
        const currentState = this.currentStateRow(current);
        invariant(currentState.currentRevision === expectedCurrentRevision, 'ARTIFACT_CURRENT_CONFLICT', 'Artifact current state changed.', 409, {
          currentRevision: currentState.currentRevision,
        });
        const timestamp = nowMs();
        if (current.artifact_type === 'markdown') {
          const blob = this.requireContentBlob(snapshot.blob_hash);
          const content = readFileSync(blob.storage_path, 'utf8');
          this.database.raw.prepare(
            `UPDATE artifact_drafts SET base_snapshot_id = ?, yjs_state = ?, draft_revision = draft_revision + 1,
               updated_by_membership_id = ?, updated_at = ?
             WHERE workspace_id = ? AND artifact_id = ? AND draft_revision = ?`,
          ).run(
            snapshotId, Buffer.from(this.stateFromMarkdown(content)), membership.id, timestamp,
            current.workspace_id, artifactId, expectedCurrentRevision,
          );
        } else {
          this.database.raw.prepare(
            `UPDATE artifact_file_states SET blob_hash = ?, content_digest = ?, media_type = ?, byte_length = ?,
               current_revision = current_revision + 1, updated_by_membership_id = ?, updated_at = ?
             WHERE workspace_id = ? AND artifact_id = ? AND current_revision = ?`,
          ).run(
            snapshot.blob_hash, snapshot.content_digest, snapshot.media_type, snapshot.byte_length,
            membership.id, timestamp, current.workspace_id, artifactId, expectedCurrentRevision,
          );
        }
        this.database.raw.prepare(
          `UPDATE artifacts SET current_snapshot_id = ?, revision = revision + 1, updated_at = ?
           WHERE workspace_id = ? AND id = ?`,
        ).run(snapshotId, timestamp, current.workspace_id, artifactId);
        this.record(current.workspace_id, principal.actorId, membership.id, 'artifact_snapshot_restored', 'artifact.snapshot.restore', artifactId, {
          snapshotId,
        }, timestamp);
        return this.hydrate(this.requireArtifact(artifactId));
      },
    );
  }

  delete(principal: HumanPrincipal, artifactId: string, expectedRevision: number, idempotencyKey: string): ArtifactView {
    const artifact = this.requireArtifact(artifactId);
    return this.command(artifact.workspace_id, principal.actorId, 'DeleteArtifact', idempotencyKey, { artifactId, expectedRevision }, () => {
      const current = this.requireArtifact(artifactId);
      const membership = this.requireMembership(current.workspace_id, principal.actorId);
      invariant(
        membership.membership_role === 'owner' || current.created_by_membership_id === membership.id,
        'ARTIFACT_DELETE_FORBIDDEN',
        'Only the Artifact creator or a Workspace Owner may delete it.',
        403,
      );
      const timestamp = nowMs();
      const updated = this.database.raw.prepare(
        `UPDATE artifacts SET status = 'deleted', deleted_at = ?, purge_after = ?,
           revision = revision + 1, updated_at = ?
         WHERE id = ? AND status = 'active' AND revision = ? RETURNING revision`,
      ).get(timestamp, timestamp + TRASH_RETENTION_MS, timestamp, artifactId, expectedRevision);
      invariant(updated, 'STALE_REVISION', 'Artifact status or revision changed.', 409);
      this.record(current.workspace_id, principal.actorId, membership.id, 'artifact_deleted', 'artifact.delete', artifactId, {
        purgeAfter: timestamp + TRASH_RETENTION_MS,
      }, timestamp);
      return this.hydrate(this.requireArtifact(artifactId));
    });
  }

  restore(principal: HumanPrincipal, artifactId: string, expectedRevision: number, idempotencyKey: string): ArtifactView {
    const artifact = this.requireArtifact(artifactId);
    return this.command(artifact.workspace_id, principal.actorId, 'RestoreArtifact', idempotencyKey, { artifactId, expectedRevision }, () => {
      const current = this.requireArtifact(artifactId);
      const membership = this.requireMembership(current.workspace_id, principal.actorId);
      invariant(
        membership.membership_role === 'owner' || current.created_by_membership_id === membership.id,
        'ARTIFACT_RESTORE_FORBIDDEN',
        'Only the Artifact creator or a Workspace Owner may restore it.',
        403,
      );
      const timestamp = nowMs();
      const updated = this.database.raw.prepare(
        `UPDATE artifacts SET status = 'active', deleted_at = NULL, purge_after = NULL,
           revision = revision + 1, updated_at = ?
         WHERE id = ? AND status = 'deleted' AND revision = ? RETURNING revision`,
      ).get(timestamp, artifactId, expectedRevision);
      invariant(updated, 'STALE_REVISION', 'Artifact status or revision changed.', 409);
      this.record(current.workspace_id, principal.actorId, membership.id, 'artifact_restored', 'artifact.restore', artifactId, {}, timestamp);
      return this.hydrate(this.requireArtifact(artifactId));
    });
  }

  associate(principal: HumanPrincipal, projectId: string, artifactId: string, idempotencyKey: string): ArtifactView {
    const artifact = this.requireArtifact(artifactId);
    invariant(artifact.workspace_id === this.requireProjectWorkspace(projectId), 'ARTIFACT_PROJECT_MISMATCH', 'Artifact and Project must share a Workspace.');
    return this.command(artifact.workspace_id, principal.actorId, 'AssociateArtifactProject', idempotencyKey, { projectId, artifactId }, () => {
      const membership = this.requireProjectAccess(artifact.workspace_id, projectId, principal.actorId);
      invariant(this.requireArtifact(artifactId).status === 'active', 'ARTIFACT_NOT_FOUND', 'Artifact is unavailable.', 404);
      const timestamp = nowMs();
      this.database.raw.prepare(
        `INSERT OR IGNORE INTO artifact_project_associations (
           workspace_id, artifact_id, project_id, associated_by_membership_id, created_at
         ) VALUES (?, ?, ?, ?, ?)`,
      ).run(artifact.workspace_id, artifactId, projectId, membership.id, timestamp);
      this.record(artifact.workspace_id, principal.actorId, membership.id, 'artifact_project_associated', 'artifact.project.associate', artifactId, {
        projectId,
      }, timestamp, projectId);
      return this.hydrate(this.requireArtifact(artifactId));
    });
  }

  dissociate(principal: HumanPrincipal, projectId: string, artifactId: string, idempotencyKey: string): ArtifactView {
    const artifact = this.requireArtifact(artifactId);
    return this.command(artifact.workspace_id, principal.actorId, 'DissociateArtifactProject', idempotencyKey, { projectId, artifactId }, () => {
      const membership = this.requireProjectManager(artifact.workspace_id, projectId, principal.actorId);
      this.database.raw.prepare(
        'DELETE FROM artifact_project_associations WHERE workspace_id = ? AND artifact_id = ? AND project_id = ?',
      ).run(artifact.workspace_id, artifactId, projectId);
      const timestamp = nowMs();
      this.record(artifact.workspace_id, principal.actorId, membership.id, 'artifact_project_dissociated', 'artifact.project.dissociate', artifactId, {
        projectId,
      }, timestamp, projectId);
      return this.hydrate(this.requireArtifact(artifactId));
    });
  }

  listSnapshots(principal: HumanPrincipal, artifactId: string): ArtifactSnapshotView[] {
    const artifact = this.requireArtifact(artifactId);
    this.requireMembership(artifact.workspace_id, principal.actorId);
    this.requireReadableContent(artifact);
    return (this.database.raw.prepare(
      "SELECT * FROM artifact_snapshots WHERE workspace_id = ? AND artifact_id = ? AND status = 'active' ORDER BY created_at DESC, id DESC",
    ).all(artifact.workspace_id, artifactId) as unknown as ArtifactSnapshotRow[]).map((row) => this.mapSnapshot(row));
  }

  getSnapshot(principal: HumanPrincipal, artifactId: string, snapshotId: string): ArtifactSnapshotView {
    const artifact = this.requireArtifact(artifactId);
    this.requireMembership(artifact.workspace_id, principal.actorId);
    this.requireReadableContent(artifact);
    const snapshot = this.requireSnapshot(artifact.workspace_id, artifactId, snapshotId);
    invariant(snapshot.status === 'active', 'ARTIFACT_SNAPSHOT_NOT_FOUND', 'Artifact snapshot does not exist or is unavailable.', 404);
    return this.mapSnapshot(snapshot);
  }

  snapshotBlob(principal: HumanPrincipal, artifactId: string, snapshotId: string): { snapshot: ArtifactSnapshotView; storagePath: string } {
    const artifact = this.requireArtifact(artifactId);
    this.requireMembership(artifact.workspace_id, principal.actorId);
    this.requireReadableContent(artifact);
    const snapshot = this.requireSnapshot(artifact.workspace_id, artifactId, snapshotId);
    invariant(snapshot.status === 'active', 'ARTIFACT_SNAPSHOT_NOT_FOUND', 'Artifact snapshot does not exist or is unavailable.', 404);
    const blob = this.requireContentBlob(snapshot.blob_hash);
    return { snapshot: this.mapSnapshot(snapshot), storagePath: blob.storage_path };
  }

  currentBlob(principal: HumanPrincipal, artifactId: string): { state: ArtifactCurrentStateView; storagePath: string } {
    const artifact = this.requireArtifact(artifactId);
    this.requireMembership(artifact.workspace_id, principal.actorId);
    this.requireReadableContent(artifact);
    const state = this.currentStateRow(artifact);
    if (artifact.artifact_type === 'markdown') {
      const stored = this.blobs.writeBufferSync(
        Buffer.from(this.markdownFromState(this.requireDraft(artifactId).yjs_state), 'utf8'),
        state.mediaType,
      );
      return { state, storagePath: stored.storagePath };
    }
    return { state, storagePath: this.requireContentBlob(this.requireFileState(artifactId).blob_hash).storage_path };
  }

  pinCurrentForContext(workspaceId: string, actorId: string, artifactId: string): {
    snapshot: ArtifactSnapshotView;
    currentState: ArtifactCurrentStateView;
  } {
    const membership = this.requireMembership(workspaceId, actorId);
    const artifact = this.requireArtifact(artifactId);
    invariant(artifact.workspace_id === workspaceId && artifact.status === 'active', 'ARTIFACT_NOT_FOUND', 'Artifact is unavailable.', 404);
    const currentState = this.currentStateRow(artifact);
    const snapshot = this.pinCurrentSnapshot(artifact, actorId, membership.id, nowMs());
    return { snapshot: this.mapSnapshot(snapshot), currentState };
  }

  authorizeDraft(principal: HumanPrincipal, artifactId: string): { artifact: ArtifactView; membershipId: string } {
    const artifact = this.requireArtifact(artifactId);
    const membership = this.requireMembership(artifact.workspace_id, principal.actorId);
    invariant(artifact.status === 'active' && artifact.artifact_type === 'markdown', 'ARTIFACT_NOT_EDITABLE', 'Markdown Artifact is unavailable.', 409);
    return { artifact: this.hydrate(artifact), membershipId: membership.id };
  }

  fetchDraftState(artifactId: string): Uint8Array {
    return Buffer.from(this.requireDraft(artifactId).yjs_state);
  }

  storeDraftState(artifactId: string, membershipId: string, state: Uint8Array): void {
    invariant(state.byteLength <= MAX_ARTIFACT_BYTES, 'ARTIFACT_FILE_TOO_LARGE', 'Artifact drafts may not exceed 100 MiB.', 413);
    this.database.transaction(() => {
      const artifact = this.requireArtifact(artifactId);
      invariant(artifact.status === 'active' && artifact.artifact_type === 'markdown', 'ARTIFACT_NOT_EDITABLE', 'Markdown Artifact is unavailable.', 409);
      const draft = this.requireDraft(artifactId);
      if (Buffer.from(draft.yjs_state).equals(Buffer.from(state))) return;
      const membership = this.database.raw.prepare(
        "SELECT * FROM workspace_memberships WHERE workspace_id = ? AND id = ? AND status = 'active'",
      ).get(artifact.workspace_id, membershipId) as MembershipRow | undefined;
      invariant(membership, 'WORKSPACE_MEMBERSHIP_REQUIRED', 'An active Workspace Membership is required.', 403);
      const timestamp = nowMs();
      const updated = this.database.raw.prepare(
        `UPDATE artifact_drafts SET yjs_state = ?, draft_revision = draft_revision + 1,
           updated_by_membership_id = ?, updated_at = ?
         WHERE workspace_id = ? AND artifact_id = ? RETURNING draft_revision`,
      ).get(Buffer.from(state), membershipId, timestamp, artifact.workspace_id, artifactId) as { draft_revision: number };
      this.record(artifact.workspace_id, membership.actor_id, membership.id, 'artifact_draft_changed', 'artifact.draft.change', artifactId, {
        draftRevision: updated.draft_revision,
      }, timestamp);
    });
  }

  registerStagedBlob(
    context: AgentPublicationContext,
    stored: StoredContentBlob,
  ): StagedBlobView {
    this.registerBlob(stored);
    const id = newId();
    const timestamp = nowMs();
    const expiresAt = timestamp + STAGED_BLOB_RETENTION_MS;
    this.database.raw.prepare(
      `INSERT INTO staged_blobs (
         id, workspace_id, run_id, attempt_id, blob_hash, media_type,
         byte_length, created_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, context.workspaceId, context.runId, context.attemptId, stored.hash, stored.mediaType, stored.byteLength, timestamp, expiresAt);
    return {
      id, workspaceId: context.workspaceId, runId: context.runId, attemptId: context.attemptId,
      contentDigest: stored.hash, mediaType: stored.mediaType, byteLength: stored.byteLength, expiresAt,
    };
  }

  publishFromAgent(context: AgentPublicationContext, publication: AgentArtifactPublication): ArtifactView {
    const staged = this.database.raw.prepare(
      `SELECT * FROM staged_blobs WHERE workspace_id = ? AND id = ? AND run_id = ? AND attempt_id = ?
         AND expires_at > ?`,
    ).get(context.workspaceId, publication.stagedBlobId, context.runId, context.attemptId, nowMs()) as
      | Record<string, unknown>
      | undefined;
    invariant(staged, 'STAGED_BLOB_NOT_FOUND', 'Staged blob is unavailable or expired.', 404);
    const stored = this.database.raw.prepare('SELECT * FROM content_blobs WHERE hash = ?').get(String(staged.blob_hash)) as
      | { hash: string; byte_length: number; media_type: string; storage_path: string }
      | undefined;
    invariant(stored, 'STAGED_BLOB_NOT_FOUND', 'Staged blob content is unavailable.', 404);
    const timestamp = nowMs();
    const name = this.normalizeName(publication.name);
    const projectIds = this.normalizeProjectIds(publication.projectIds);
    const run = this.database.raw.prepare(
      'SELECT project_id FROM runs WHERE workspace_id = ? AND id = ?',
    ).get(context.workspaceId, context.runId) as { project_id: string | null } | undefined;
    invariant(run, 'RUN_NOT_FOUND', 'Run does not exist.', 404);
    for (const projectId of projectIds) {
      invariant(this.requireProjectWorkspace(projectId) === context.workspaceId, 'ARTIFACT_PROJECT_MISMATCH', 'Artifact and Project must share a Workspace.');
      invariant(run.project_id === projectId, 'ARTIFACT_PROJECT_FORBIDDEN', 'An Agent may only associate an Artifact with its Run Project.', 403);
    }
    let artifact: ArtifactRow;
    if (publication.artifactId) {
      artifact = this.requireArtifact(publication.artifactId);
      invariant(artifact.workspace_id === context.workspaceId && artifact.status === 'active', 'ARTIFACT_NOT_FOUND', 'Artifact is unavailable.', 404);
      invariant(artifact.artifact_type === publication.artifactType, 'ARTIFACT_TYPE_MISMATCH', 'Artifact type cannot change.', 409);
      invariant(
        publication.expectedCurrentRevision !== undefined
        && publication.expectedContentDigest !== undefined,
        'ARTIFACT_BASELINE_REQUIRED',
        'Updating an Artifact requires an explicit current revision and content digest.',
        409,
      );
      const currentState = this.currentStateRow(artifact);
      invariant(
        currentState.currentRevision === publication.expectedCurrentRevision
        && currentState.contentDigest === publication.expectedContentDigest,
        'ARTIFACT_CURRENT_CONFLICT',
        'Artifact current state changed.',
        409,
        { currentRevision: currentState.currentRevision, contentDigest: currentState.contentDigest },
      );
      this.database.raw.prepare(
        'UPDATE artifacts SET name = ?, revision = revision + 1, updated_at = ? WHERE id = ?',
      ).run(name, timestamp, artifact.id);
    } else {
      invariant(
        publication.expectedCurrentRevision === undefined && publication.expectedContentDigest === undefined,
        'ARTIFACT_CURRENT_CONFLICT',
        'New Artifact baseline must be null.',
        409,
      );
      const artifactId = newId();
      this.database.raw.prepare(
        `INSERT INTO artifacts (
           id, workspace_id, name, artifact_type, created_by_membership_id,
           revision, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 1, 'active', ?, ?)`,
      ).run(artifactId, context.workspaceId, name, publication.artifactType, context.membershipId, timestamp, timestamp);
      artifact = this.requireArtifact(artifactId);
    }
    const storedView = {
      hash: stored.hash,
      byteLength: stored.byte_length,
      mediaType: stored.media_type,
      storagePath: stored.storage_path,
    };
    const saved = this.saveOrReuseSnapshot({
      workspaceId: context.workspaceId,
      artifactId: artifact.id,
      parentSnapshotId: artifact.current_snapshot_id,
      label: null,
      stored: storedView,
      actorId: context.actorId,
      membershipId: context.membershipId,
      runId: context.runId,
      attemptId: context.attemptId,
      timestamp,
    });
    if (publication.artifactType === 'markdown') {
      const content = readFileSync(stored.storage_path, 'utf8');
      const state = this.stateFromMarkdown(content);
      this.database.raw.prepare(
        `INSERT INTO artifact_drafts (
           workspace_id, artifact_id, base_snapshot_id, yjs_state, draft_revision,
           updated_by_membership_id, updated_at
         ) VALUES (?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT(workspace_id, artifact_id) DO UPDATE SET
           base_snapshot_id = excluded.base_snapshot_id,
           yjs_state = excluded.yjs_state,
           draft_revision = artifact_drafts.draft_revision + 1,
           updated_by_membership_id = excluded.updated_by_membership_id,
           updated_at = excluded.updated_at`,
      ).run(context.workspaceId, artifact.id, saved.snapshot.snapshotId, Buffer.from(state), context.membershipId, timestamp);
    } else {
      this.database.raw.prepare(
        `INSERT INTO artifact_file_states (
           workspace_id, artifact_id, blob_hash, content_digest, media_type, byte_length,
           current_revision, updated_by_membership_id, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(workspace_id, artifact_id) DO UPDATE SET
           blob_hash = excluded.blob_hash,
           content_digest = excluded.content_digest,
           media_type = excluded.media_type,
           byte_length = excluded.byte_length,
           current_revision = artifact_file_states.current_revision + 1,
           updated_by_membership_id = excluded.updated_by_membership_id,
           updated_at = excluded.updated_at`,
      ).run(
        context.workspaceId, artifact.id, stored.hash, stored.hash, stored.media_type,
        stored.byte_length, context.membershipId, timestamp,
      );
    }
    this.insertProjectAssociations(context.workspaceId, artifact.id, projectIds, context.membershipId, timestamp);
    this.database.raw.prepare('DELETE FROM staged_blobs WHERE id = ?').run(publication.stagedBlobId);
    this.record(context.workspaceId, context.actorId, context.membershipId, 'artifact_snapshot_saved', 'artifact.snapshot.save', artifact.id, {
      snapshotId: saved.snapshot.snapshotId, runId: context.runId, attemptId: context.attemptId, projectIds,
    }, timestamp);
    return this.hydrate(this.requireArtifact(artifact.id));
  }

  resolveMessageSnapshots(
    workspaceId: string,
    actorId: string,
    selections: Array<{ artifactId: string; snapshotId: string | null }>,
  ): ArtifactSnapshotRow[] {
    const membership = this.requireMembership(workspaceId, actorId);
    const distinct = new Set<string>();
    invariant(selections.length <= 100, 'INVALID_ARTIFACT_REFERENCES', 'Artifact references may not exceed 100 items.');
    return selections.map((selection) => {
      const artifact = this.requireArtifact(selection.artifactId);
      invariant(artifact.workspace_id === workspaceId && artifact.status === 'active', 'ARTIFACT_NOT_FOUND', 'Artifact is unavailable.', 404);
      const snapshot = selection.snapshotId
        ? this.requireSnapshot(workspaceId, selection.artifactId, selection.snapshotId)
        : this.pinCurrentSnapshot(artifact, actorId, membership.id, nowMs());
      invariant(snapshot.status === 'active', 'ARTIFACT_SNAPSHOT_NOT_FOUND', 'Artifact snapshot does not exist or is unavailable.', 404);
      invariant(!distinct.has(snapshot.id), 'INVALID_ARTIFACT_REFERENCES', 'Artifact snapshot references must be unique.');
      distinct.add(snapshot.id);
      return snapshot;
    });
  }

  validateMessageSnapshotIds(workspaceId: string, snapshotIds: string[]): ArtifactSnapshotRow[] {
    const distinct = [...new Set(snapshotIds)];
    invariant(distinct.length === snapshotIds.length && distinct.length <= 100, 'INVALID_ARTIFACT_REFERENCES', 'Artifact snapshot references must be unique.');
    return distinct.map((snapshotId) => {
      const row = this.database.raw.prepare(
        `SELECT v.* FROM artifact_snapshots v
         JOIN artifacts a ON a.workspace_id = v.workspace_id AND a.id = v.artifact_id
         WHERE v.workspace_id = ? AND v.id = ? AND v.status = 'active' AND a.status = 'active'`,
      ).get(workspaceId, snapshotId) as ArtifactSnapshotRow | undefined;
      invariant(row, 'ARTIFACT_SNAPSHOT_NOT_FOUND', 'Artifact snapshot does not exist or is unavailable.', 404);
      return row;
    });
  }

  insertMessageReferences(workspaceId: string, messageId: string, snapshots: ArtifactSnapshotRow[], timestamp: number): void {
    const insert = this.database.raw.prepare(
      `INSERT INTO message_artifact_references (
         workspace_id, message_id, reference_order, artifact_id, artifact_snapshot_id,
         artifact_name_snapshot, artifact_snapshot_label_snapshot,
         snapshot_created_at, media_type_snapshot, content_digest_snapshot, byte_length_snapshot, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    snapshots.forEach((snapshot, index) => {
      const artifact = this.requireArtifact(snapshot.artifact_id);
      insert.run(
        workspaceId, messageId, index, snapshot.artifact_id, snapshot.id,
        artifact.name, snapshot.label, snapshot.created_at,
        snapshot.media_type, snapshot.content_digest, snapshot.byte_length, timestamp,
      );
    });
  }

  messageReferences(workspaceId: string, messageId: string): MessageArtifactReferenceView[] {
    const rows = this.database.raw.prepare(
      `SELECT r.*, CASE WHEN v.id IS NULL OR v.status <> 'active' OR a.status <> 'active' THEN 0 ELSE 1 END AS content_available
       FROM message_artifact_references r
       LEFT JOIN artifact_snapshots v
         ON v.workspace_id = r.workspace_id AND v.id = r.artifact_snapshot_id
       LEFT JOIN artifacts a
         ON a.workspace_id = r.workspace_id AND a.id = r.artifact_id
       WHERE r.workspace_id = ? AND r.message_id = ? ORDER BY r.reference_order`,
    ).all(workspaceId, messageId) as unknown as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      artifactId: String(row.artifact_id),
      artifactSnapshotId: String(row.artifact_snapshot_id),
      artifactName: String(row.artifact_name_snapshot),
      snapshotLabel: row.artifact_snapshot_label_snapshot === null ? null : String(row.artifact_snapshot_label_snapshot),
      snapshotCreatedAt: Number(row.snapshot_created_at),
      mediaType: String(row.media_type_snapshot),
      contentDigest: String(row.content_digest_snapshot),
      byteLength: Number(row.byte_length_snapshot),
      contentAvailable: Number(row.content_available) === 1,
    }));
  }

  purgeExpired(timestamp = nowMs()): { artifactsPurged: number; stagedBlobsPurged: number; blobsRemoved: number } {
    const artifactRows = this.database.raw.prepare(
      "SELECT * FROM artifacts WHERE status = 'deleted' AND purge_after <= ? ORDER BY purge_after, id",
    ).all(timestamp) as unknown as ArtifactRow[];
    let artifactsPurged = 0;
    for (const artifact of artifactRows) {
      this.database.transaction(() => {
        this.database.raw.prepare('UPDATE artifacts SET current_snapshot_id = NULL WHERE id = ?').run(artifact.id);
        this.database.raw.prepare('DELETE FROM artifact_drafts WHERE workspace_id = ? AND artifact_id = ?').run(artifact.workspace_id, artifact.id);
        this.database.raw.prepare('DELETE FROM artifact_file_states WHERE workspace_id = ? AND artifact_id = ?').run(artifact.workspace_id, artifact.id);
        this.database.raw.prepare('DELETE FROM artifact_project_associations WHERE workspace_id = ? AND artifact_id = ?').run(artifact.workspace_id, artifact.id);
        this.database.raw.prepare('UPDATE artifact_snapshots SET parent_snapshot_id = NULL WHERE workspace_id = ? AND artifact_id = ?')
          .run(artifact.workspace_id, artifact.id);
        this.database.raw.prepare('DELETE FROM artifact_snapshots WHERE workspace_id = ? AND artifact_id = ?').run(artifact.workspace_id, artifact.id);
        this.database.raw.prepare(
          "UPDATE artifacts SET status = 'purged', purged_at = ?, updated_at = ? WHERE id = ? AND status = 'deleted'",
        ).run(timestamp, timestamp, artifact.id);
        this.record(artifact.workspace_id, this.workspaceOwnerActor(artifact.workspace_id), null, 'artifact_purged', 'artifact.purge', artifact.id, {}, timestamp);
      });
      artifactsPurged += 1;
    }
    this.database.raw.prepare(
      `UPDATE artifact_snapshots
       SET blob_hash = NULL, content_purged_at = ?, updated_at = ?
       WHERE status = 'deleted' AND purge_after <= ? AND blob_hash IS NOT NULL`,
    ).run(timestamp, timestamp, timestamp);
    const staged = this.database.raw.prepare(
      'DELETE FROM staged_blobs WHERE expires_at <= ? RETURNING id',
    ).all(timestamp);
    const blobRows = this.database.raw.prepare(
      `SELECT cb.hash, cb.storage_path FROM content_blobs cb
       WHERE NOT EXISTS (SELECT 1 FROM artifact_snapshots av WHERE av.blob_hash = cb.hash)
         AND NOT EXISTS (SELECT 1 FROM artifact_file_states fs WHERE fs.blob_hash = cb.hash)
         AND NOT EXISTS (SELECT 1 FROM staged_blobs sb WHERE sb.blob_hash = cb.hash)`,
    ).all() as unknown as Array<{ hash: string; storage_path: string }>;
    for (const blob of blobRows) {
      rmSync(blob.storage_path, { force: true });
      this.database.raw.prepare('DELETE FROM content_blobs WHERE hash = ?').run(blob.hash);
    }
    return { artifactsPurged, stagedBlobsPurged: staged.length, blobsRemoved: blobRows.length };
  }

  private saveOrReuseSnapshot(input: {
    workspaceId: string;
    artifactId: string;
    parentSnapshotId: string | null;
    label: string | null;
    stored: StoredContentBlob;
    actorId: string;
    membershipId: string;
    runId: string | null;
    attemptId: string | null;
    timestamp: number;
  }): Omit<ArtifactSnapshotSaveView, 'artifact'> {
    const existing = this.database.raw.prepare(
      `SELECT * FROM artifact_snapshots
       WHERE workspace_id = ? AND artifact_id = ? AND content_digest = ? AND status = 'active'
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    ).get(input.workspaceId, input.artifactId, input.stored.hash) as ArtifactSnapshotRow | undefined;
    if (existing) {
      let current = existing;
      let labelChanged = false;
      if (input.label !== null && input.label !== existing.label) {
        current = this.database.raw.prepare(
          `UPDATE artifact_snapshots SET label = ?, revision = revision + 1, updated_at = ?
           WHERE workspace_id = ? AND artifact_id = ? AND id = ? RETURNING *`,
        ).get(input.label, input.timestamp, input.workspaceId, input.artifactId, existing.id) as unknown as ArtifactSnapshotRow;
        labelChanged = true;
      }
      if (input.parentSnapshotId !== existing.id) {
        this.database.raw.prepare(
          `UPDATE artifacts SET current_snapshot_id = ?, revision = revision + 1, updated_at = ?
           WHERE workspace_id = ? AND id = ?`,
        ).run(existing.id, input.timestamp, input.workspaceId, input.artifactId);
      }
      return { snapshot: this.mapSnapshot(current), created: false, labelChanged };
    }
    return { snapshot: this.insertSnapshot(input), created: true, labelChanged: false };
  }

  private insertSnapshot(input: {
    workspaceId: string;
    artifactId: string;
    parentSnapshotId: string | null;
    label: string | null;
    stored: StoredContentBlob;
    actorId: string;
    membershipId: string;
    runId: string | null;
    attemptId: string | null;
    timestamp: number;
  }): ArtifactSnapshotView {
    this.registerBlob(input.stored);
    const snapshotId = newId();
    this.database.raw.prepare(
      `INSERT INTO artifact_snapshots (
         id, workspace_id, artifact_id, label, parent_snapshot_id,
         blob_hash, content_digest, media_type, byte_length,
         created_by_actor_id, created_by_membership_id,
         producing_run_id, producing_attempt_id, revision, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'active', ?, ?)`,
    ).run(
      snapshotId, input.workspaceId, input.artifactId, input.label, input.parentSnapshotId,
      input.stored.hash, input.stored.hash, input.stored.mediaType, input.stored.byteLength,
      input.actorId, input.membershipId, input.runId, input.attemptId, input.timestamp, input.timestamp,
    );
    this.database.raw.prepare(
      `UPDATE artifacts SET current_snapshot_id = ?, revision = revision + 1, updated_at = ?
       WHERE workspace_id = ? AND id = ?`,
    ).run(snapshotId, input.timestamp, input.workspaceId, input.artifactId);
    return this.mapSnapshot(this.requireSnapshot(input.workspaceId, input.artifactId, snapshotId));
  }

  private pinCurrentSnapshot(
    artifact: ArtifactRow,
    actorId: string,
    membershipId: string,
    timestamp: number,
  ): ArtifactSnapshotRow {
    const stored = artifact.artifact_type === 'markdown'
      ? this.blobs.writeBufferSync(
        Buffer.from(this.markdownFromState(this.requireDraft(artifact.id).yjs_state), 'utf8'),
        'text/markdown; charset=utf-8',
      )
      : this.storedForFileState(this.requireFileState(artifact.id));
    const saved = this.saveOrReuseSnapshot({
      workspaceId: artifact.workspace_id,
      artifactId: artifact.id,
      parentSnapshotId: artifact.current_snapshot_id,
      label: null,
      stored,
      actorId,
      membershipId,
      runId: null,
      attemptId: null,
      timestamp,
    });
    return this.requireSnapshot(artifact.workspace_id, artifact.id, saved.snapshot.snapshotId);
  }

  private insertProjectAssociations(
    workspaceId: string,
    artifactId: string,
    projectIds: string[],
    membershipId: string,
    timestamp: number,
  ): void {
    const statement = this.database.raw.prepare(
      `INSERT OR IGNORE INTO artifact_project_associations (
         workspace_id, artifact_id, project_id, associated_by_membership_id, created_at
       ) VALUES (?, ?, ?, ?, ?)`,
    );
    for (const projectId of projectIds) statement.run(workspaceId, artifactId, projectId, membershipId, timestamp);
  }

  private registerBlob(stored: StoredContentBlob): void {
    this.database.raw.prepare(
      `INSERT INTO content_blobs (hash, byte_length, media_type, storage_path, created_at)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT(hash) DO NOTHING`,
    ).run(stored.hash, stored.byteLength, stored.mediaType, stored.storagePath, nowMs());
  }

  private hydrate(row: ArtifactRow): ArtifactView {
    const latestSnapshot = row.current_snapshot_id
      ? this.mapSnapshot(this.requireSnapshot(row.workspace_id, row.id, row.current_snapshot_id))
      : null;
    const projectIds = this.database.raw.prepare(
      'SELECT project_id FROM artifact_project_associations WHERE workspace_id = ? AND artifact_id = ? ORDER BY created_at, project_id',
    ).all(row.workspace_id, row.id).map((item) => String((item as { project_id: string }).project_id));
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      name: row.name,
      artifactType: row.artifact_type,
      currentState: this.currentStateRow(row),
      latestSnapshot,
      projectIds,
      createdByMembershipId: row.created_by_membership_id,
      revision: row.revision,
      status: row.status,
      deletedAt: row.deleted_at,
      purgeAfter: row.purge_after,
      purgedAt: row.purged_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapSnapshot(row: ArtifactSnapshotRow): ArtifactSnapshotView {
    const creator = this.database.raw.prepare(
      `SELECT COALESCE(h.display_name, ag.name) AS display_name
       FROM actors a
       LEFT JOIN humans h ON h.actor_id = a.id
       LEFT JOIN agents ag ON ag.actor_id = a.id AND ag.workspace_id = ?
       WHERE a.id = ?`,
    ).get(row.workspace_id, row.created_by_actor_id) as { display_name: string } | undefined;
    return {
      snapshotId: row.id,
      artifactId: row.artifact_id,
      label: row.label,
      parentSnapshotId: row.parent_snapshot_id,
      contentDigest: row.content_digest,
      mediaType: row.media_type,
      byteLength: row.byte_length,
      createdByActorId: row.created_by_actor_id,
      createdByMembershipId: row.created_by_membership_id,
      createdByDisplayName: creator?.display_name ?? row.created_by_actor_id,
      revision: row.revision,
      status: row.status,
      deletedAt: row.deleted_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private currentStateRow(artifact: ArtifactRow): ArtifactCurrentStateView {
    if (artifact.artifact_type === 'markdown') {
      const draft = this.requireDraft(artifact.id);
      const content = this.markdownFromState(draft.yjs_state);
      return {
        artifactId: artifact.id,
        currentRevision: draft.draft_revision,
        contentDigest: sha256(content),
        mediaType: 'text/markdown; charset=utf-8',
        byteLength: Buffer.byteLength(content),
        updatedByMembershipId: draft.updated_by_membership_id,
        updatedAt: draft.updated_at,
      };
    }
    const state = this.requireFileState(artifact.id);
    return {
      artifactId: artifact.id,
      currentRevision: state.current_revision,
      contentDigest: state.content_digest,
      mediaType: state.media_type,
      byteLength: state.byte_length,
      updatedByMembershipId: state.updated_by_membership_id,
      updatedAt: state.updated_at,
    };
  }

  private requireFileState(artifactId: string): FileStateRow {
    const row = this.database.raw.prepare('SELECT * FROM artifact_file_states WHERE artifact_id = ?').get(artifactId) as FileStateRow | undefined;
    invariant(row, 'ARTIFACT_CURRENT_NOT_FOUND', 'Artifact current state is unavailable.', 404);
    return row;
  }

  private storedForFileState(state: FileStateRow): StoredContentBlob {
    const blob = this.requireContentBlob(state.blob_hash);
    return {
      hash: state.content_digest,
      byteLength: state.byte_length,
      mediaType: state.media_type,
      storagePath: blob.storage_path,
    };
  }

  private requireContentBlob(hash: string): { storage_path: string } {
    const blob = this.database.raw.prepare('SELECT storage_path FROM content_blobs WHERE hash = ?').get(hash) as
      | { storage_path: string }
      | undefined;
    invariant(blob, 'ARTIFACT_CONTENT_PURGED', 'Artifact content has been purged.', 410);
    return blob;
  }

  private requireArtifact(artifactId: string): ArtifactRow {
    const row = this.database.raw.prepare('SELECT * FROM artifacts WHERE id = ?').get(artifactId) as ArtifactRow | undefined;
    invariant(row, 'ARTIFACT_NOT_FOUND', 'Artifact does not exist or is unavailable.', 404);
    return row;
  }

  private requireSnapshot(workspaceId: string, artifactId: string, snapshotId: string): ArtifactSnapshotRow {
    const row = this.database.raw.prepare(
      'SELECT * FROM artifact_snapshots WHERE workspace_id = ? AND artifact_id = ? AND id = ?',
    ).get(workspaceId, artifactId, snapshotId) as ArtifactSnapshotRow | undefined;
    invariant(row, 'ARTIFACT_SNAPSHOT_NOT_FOUND', 'Artifact snapshot does not exist.', 404);
    return row;
  }

  private requireDraft(artifactId: string): DraftRow {
    const row = this.database.raw.prepare('SELECT * FROM artifact_drafts WHERE artifact_id = ?').get(artifactId) as DraftRow | undefined;
    invariant(row, 'ARTIFACT_DRAFT_NOT_FOUND', 'Artifact draft does not exist.', 404);
    return row;
  }

  private requireMembership(workspaceId: string, actorId: string): MembershipRow {
    const row = this.database.raw.prepare(
      "SELECT * FROM workspace_memberships WHERE workspace_id = ? AND actor_id = ? AND status = 'active'",
    ).get(workspaceId, actorId) as MembershipRow | undefined;
    invariant(row, 'WORKSPACE_MEMBERSHIP_REQUIRED', 'An active Workspace Membership is required.', 403);
    return row;
  }

  private requireProjectWorkspace(projectId: string): string {
    const row = this.database.raw.prepare('SELECT workspace_id FROM projects WHERE id = ?').get(projectId) as
      | { workspace_id: string }
      | undefined;
    invariant(row, 'PROJECT_NOT_FOUND', 'Project does not exist or is not accessible.', 404);
    return row.workspace_id;
  }

  private requireProjectAccess(workspaceId: string, projectId: string, actorId: string): MembershipRow {
    const membership = this.requireMembership(workspaceId, actorId);
    const projectMembership = this.database.raw.prepare(
      `SELECT 1 FROM project_memberships
       WHERE workspace_id = ? AND project_id = ? AND workspace_membership_id = ? AND status = 'active'`,
    ).get(workspaceId, projectId, membership.id);
    invariant(projectMembership, 'PROJECT_NOT_FOUND', 'Project does not exist or is not accessible.', 404);
    return membership;
  }

  private requireProjectManager(workspaceId: string, projectId: string, actorId: string): MembershipRow {
    const membership = this.requireMembership(workspaceId, actorId);
    const manager = this.database.raw.prepare(
      `SELECT 1 FROM project_memberships
       WHERE workspace_id = ? AND project_id = ? AND workspace_membership_id = ?
         AND project_role = 'manager' AND status = 'active'`,
    ).get(workspaceId, projectId, membership.id);
    invariant(manager || membership.membership_role === 'owner', 'PROJECT_MANAGER_REQUIRED', 'A Project Manager or Workspace Owner is required.', 403);
    return membership;
  }

  private requireReadableContent(artifact: ArtifactRow): void {
    invariant(artifact.status !== 'purged', 'ARTIFACT_CONTENT_PURGED', 'Artifact content has been purged.', 410);
    invariant(artifact.status === 'active', 'ARTIFACT_NOT_FOUND', 'Artifact is unavailable.', 404);
  }

  private normalizeName(value: string): string {
    const name = value.trim();
    invariant(name.length > 0 && name.length <= 500, 'INVALID_ARTIFACT_NAME', 'Artifact name is required and may not exceed 500 characters.');
    return name;
  }

  private normalizeSnapshotLabel(value: string | null): string | null {
    if (value === null) return null;
    const label = value.trim();
    if (label.length === 0) return null;
    invariant(label.length <= 200, 'INVALID_ARTIFACT_SNAPSHOT_LABEL', 'Snapshot label may not exceed 200 characters.');
    return label;
  }

  private nearestActiveAncestor(workspaceId: string, artifactId: string, snapshotId: string | null): string | null {
    let candidate = snapshotId;
    while (candidate) {
      const snapshot = this.requireSnapshot(workspaceId, artifactId, candidate);
      if (snapshot.status === 'active') return snapshot.id;
      candidate = snapshot.parent_snapshot_id;
    }
    return null;
  }

  private normalizeProjectIds(value?: string[]): string[] {
    const result = [...new Set(value ?? [])];
    invariant(result.length === (value?.length ?? 0) && result.length <= 100, 'INVALID_ARTIFACT_PROJECTS', 'Project associations must be unique.');
    return result;
  }

  private markdownFromState(state: Uint8Array): string {
    const document = new Y.Doc();
    Y.applyUpdate(document, state);
    return document.getText('content').toString();
  }

  private stateFromMarkdown(content: string): Uint8Array {
    const document = new Y.Doc();
    document.getText('content').insert(0, content);
    return Y.encodeStateAsUpdate(document);
  }

  private command<T>(
    scopeKey: string,
    actorId: string,
    commandName: string,
    idempotencyKey: string,
    request: unknown,
    operation: () => T,
  ): T {
    invariant(idempotencyKey.trim().length > 0, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is required.');
    const requestHash = sha256(canonicalJson(request));
    return this.database.transaction(() => {
      const existing = this.database.raw.prepare(
        `SELECT request_hash, result_json FROM idempotency_records
         WHERE scope_key = ? AND actor_id = ? AND command_name = ? AND idempotency_key = ?`,
      ).get(scopeKey, actorId, commandName, idempotencyKey) as { request_hash: string; result_json: string } | undefined;
      if (existing) {
        invariant(existing.request_hash === requestHash, 'IDEMPOTENCY_CONFLICT', 'Idempotency key was reused with a different request.', 409);
        return JSON.parse(existing.result_json) as T;
      }
      try {
        const result = operation();
        this.database.raw.prepare(
          `INSERT INTO idempotency_records (
             scope_key, actor_id, command_name, idempotency_key, request_hash, result_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(scopeKey, actorId, commandName, idempotencyKey, requestHash, canonicalJson(result), nowMs());
        return result;
      } catch (error) {
        if (isSqliteConstraintError(error)) throw new DomainError('CONSTRAINT_VIOLATION', (error as Error).message, 409);
        throw error;
      }
    });
  }

  private commandReplay<T>(
    scopeKey: string,
    actorId: string,
    commandName: string,
    idempotencyKey: string,
    request: unknown,
  ): T | undefined {
    invariant(idempotencyKey.trim().length > 0, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is required.');
    const existing = this.database.raw.prepare(
      `SELECT request_hash, result_json FROM idempotency_records
       WHERE scope_key = ? AND actor_id = ? AND command_name = ? AND idempotency_key = ?`,
    ).get(scopeKey, actorId, commandName, idempotencyKey) as { request_hash: string; result_json: string } | undefined;
    if (!existing) return undefined;
    invariant(existing.request_hash === sha256(canonicalJson(request)),
      'IDEMPOTENCY_CONFLICT', 'Idempotency key was reused with a different request.', 409);
    return JSON.parse(existing.result_json) as T;
  }

  private record(
    workspaceId: string,
    actorId: string,
    membershipId: string | null,
    changeType: string,
    action: string,
    artifactId: string,
    details: unknown,
    timestamp: number,
    projectId?: string,
  ): void {
    const workspace = this.database.raw.prepare(
      'UPDATE workspaces SET context_version = context_version + 1, updated_at = ? WHERE id = ? RETURNING context_version',
    ).get(timestamp, workspaceId) as { context_version: number };
    let projectVersion: number | null = null;
    if (projectId) {
      projectVersion = (this.database.raw.prepare(
        'UPDATE projects SET context_version = context_version + 1, updated_at = ? WHERE id = ? RETURNING context_version',
      ).get(timestamp, projectId) as { context_version: number }).context_version;
    }
    const inserted = this.database.raw.prepare(
      `INSERT INTO workspace_changes (
         workspace_id, workspace_context_version, project_id, project_context_version,
         conversation_id, conversation_context_version, change_type, source_type,
         source_id, payload_json, created_at
       ) VALUES (?, ?, ?, ?, NULL, NULL, ?, 'artifact', ?, ?, ?) RETURNING position`,
    ).get(workspaceId, workspace.context_version, projectId ?? null, projectVersion, changeType, artifactId, canonicalJson(details), timestamp) as
      { position: number };
    const recipients = this.database.raw.prepare(
      "SELECT id FROM workspace_memberships WHERE workspace_id = ? AND status = 'active'",
    ).all(workspaceId) as unknown as Array<{ id: string }>;
    const insertRecipient = this.database.raw.prepare(
      'INSERT INTO workspace_change_recipients (workspace_id, change_position, membership_id) VALUES (?, ?, ?)',
    );
    for (const recipient of recipients) insertRecipient.run(workspaceId, inserted.position, recipient.id);
    const previous = this.database.raw.prepare(
      'SELECT seq, hash FROM audit_events WHERE workspace_id = ? ORDER BY seq DESC LIMIT 1',
    ).get(workspaceId) as { seq: number; hash: string } | undefined;
    const seq = (previous?.seq ?? 0) + 1;
    const prevHash = previous?.hash ?? '0'.repeat(64);
    const detailsJson = canonicalJson(details);
    const audit = {
      workspaceId, seq, prevHash, actorId, actorMembershipId: membershipId,
      action, targetType: 'artifact', targetId: artifactId, detailsJson, createdAt: timestamp,
    };
    const hash = createHash('sha256').update(canonicalJson(audit)).digest('hex');
    this.database.raw.prepare(
      `INSERT INTO audit_events (
         workspace_id, seq, prev_hash, hash, actor_id, actor_membership_id,
         action, target_type, target_id, details_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'artifact', ?, ?, ?)`,
    ).run(workspaceId, seq, prevHash, hash, actorId, membershipId, action, artifactId, detailsJson, timestamp);
  }

  private workspaceOwnerActor(workspaceId: string): string {
    const row = this.database.raw.prepare(
      `SELECT actor_id FROM workspace_memberships
       WHERE workspace_id = ? AND status = 'active' AND membership_role = 'owner'
       ORDER BY joined_at LIMIT 1`,
    ).get(workspaceId) as { actor_id: string };
    return row.actor_id;
  }
}
