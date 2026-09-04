import { readFileSync, rmSync } from 'node:fs';
import type {
  ArtifactV2View,
  ArtifactVersionView,
  ComputerPrincipal,
  HumanPrincipal,
  Principal,
  ProjectLinkView,
  ProjectResourceView,
} from './types.js';
import { DomainError, invariant } from '../lib/errors.js';
import { canonicalJson, newId, nowMs, sha256 } from '../lib/values.js';
import { SqliteDatabase } from '../storage/database.js';
import { ContentBlobStore, type StoredContentBlob } from '../storage/content-blob-store.js';

const TRASH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

interface ResourceRow {
  id: string; workspace_id: string; project_id: string; parent_id: string | null; name: string;
  kind: 'file' | 'directory'; status: 'active' | 'deleted' | 'purged'; revision: number;
  created_by_actor_id: string; created_at: number; updated_at: number;
  deleted_at: number | null; purge_after: number | null; purged_at: number | null;
}
interface ResourceFileRow { resource_id: string; blob_hash: string; media_type: string; byte_length: number; content_digest: string; revision: number; }
interface ArtifactRow {
  id: string; workspace_id: string; project_id: string; name: string; project_path: string;
  status: 'active' | 'deleted' | 'purged'; latest_version_id: string | null; next_version_number: number;
  created_by_actor_id: string; created_at: number; updated_at: number; deleted_at: number | null; purge_after: number | null; purged_at: number | null;
}
interface VersionRow {
  id: string; workspace_id: string; artifact_id: string; version_number: number; file_name: string;
  blob_hash: string | null; media_type: string; byte_length: number; content_digest: string;
  parent_version_id: string | null; created_by_actor_id: string; task_id: string | null; message_id: string | null;
  publish_batch_id: string | null; note: string | null; status: 'active' | 'deleted' | 'purged'; created_at: number;
  deleted_at: number | null; purge_after: number | null; purged_at: number | null;
}
interface LinkRow {
  id: string; workspace_id: string; project_id: string; locator: string; name: string; description: string | null;
  status: 'active' | 'deleted' | 'purged'; revision: number; created_by_actor_id: string; created_at: number; updated_at: number;
  deleted_at: number | null; purge_after: number | null; purged_at: number | null;
}

type ActorPrincipal = HumanPrincipal | ComputerPrincipal;

function actorId(principal: Principal): string {
  return principal.kind === 'human' ? principal.actorId : principal.agentId ?? principal.ownerHumanId;
}

function cleanName(value: string, field = 'name'): string {
  const result = value.trim();
  invariant(result.length > 0 && result.length <= 255, 'INVALID_RESOURCE_NAME', `${field} is required.`);
  invariant(!result.includes('/') && !result.includes('\\'), 'INVALID_RESOURCE_NAME', `${field} may not contain path separators.`);
  return result;
}

function cleanPath(value: string | undefined): string {
  const result = (value ?? '').trim().replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
  invariant(!result.split('/').some((part) => part === '..' || part === '.'), 'INVALID_PROJECT_PATH', 'Project paths may not contain dot segments.');
  return result;
}

export class ProjectResourceService {
  readonly blobs: ContentBlobStore;

  constructor(readonly database: SqliteDatabase, blobs: ContentBlobStore) {
    this.blobs = blobs;
  }

  protected access(principal: Principal, projectId: string): { workspaceId: string; projectMembershipId: string; actor: string } {
    // Computer credentials are only valid on the Agent-scoped runtime
    // namespace, where the URL supplies the exact Agent identity. This
    // prevents a bare Computer token from reading a human Project route and
    // accidentally widening access to every sponsored Agent.
    if (principal.kind === 'computer') {
      invariant(principal.agentId, 'AGENT_SCOPE_REQUIRED', 'Computer access requires an explicit Agent scope.', 403);
    }
    const id = actorId(principal);
    const ownerHumanId = principal.kind === 'computer' ? principal.ownerHumanId : id;
    const row = this.database.raw.prepare(
      `SELECT p.workspace_id AS workspace_id, pm.id AS project_membership_id
       FROM projects p JOIN project_memberships pm
         ON pm.workspace_id = p.workspace_id AND pm.project_id = p.id AND pm.status = 'active'
       JOIN workspace_memberships wm
         ON wm.workspace_id = p.workspace_id AND wm.id = pm.workspace_membership_id
       WHERE p.id = ? AND ? = 1 AND wm.actor_id = ? AND wm.status = 'active'
       UNION ALL
       SELECT p.workspace_id AS workspace_id, pm.id AS project_membership_id
       FROM projects p JOIN project_memberships pm
         ON pm.workspace_id = p.workspace_id AND pm.project_id = p.id AND pm.status = 'active'
       JOIN workspace_memberships wm
         ON wm.workspace_id = p.workspace_id AND wm.id = pm.workspace_membership_id AND wm.status = 'active'
       JOIN agents ag ON ag.workspace_id = p.workspace_id AND ag.actor_id = wm.actor_id
       WHERE p.id = ? AND ? = 1 AND ag.created_by_human_id = ? AND (? IS NULL OR ag.actor_id = ?)
       LIMIT 1`,
    ).get(projectId, principal.kind === 'human' ? 1 : 0, id, projectId, principal.kind === 'computer' ? 1 : 0, ownerHumanId, principal.kind === 'computer' ? principal.agentId ?? null : null, principal.kind === 'computer' ? principal.agentId ?? null : null) as { workspace_id: string; project_membership_id: string } | undefined;
    invariant(row, 'PROJECT_NOT_FOUND', 'Project does not exist or is not accessible.', 404);
    return { workspaceId: row.workspace_id, projectMembershipId: row.project_membership_id, actor: id };
  }

  protected humanWrite(principal: Principal, projectId: string): ReturnType<ProjectResourceService['access']> {
    invariant(principal.kind === 'human', 'HUMAN_PRINCIPAL_REQUIRED', 'A Human bearer token is required.', 403);
    return this.access(principal, projectId);
  }

  protected managerWrite(principal: Principal, projectId: string): ReturnType<ProjectResourceService['access']> {
    invariant(principal.kind === 'human', 'HUMAN_PRINCIPAL_REQUIRED', 'A Human bearer token is required.', 403);
    const access = this.access(principal, projectId);
    const role = this.database.raw.prepare('SELECT project_role FROM project_memberships WHERE id = ?').get(access.projectMembershipId) as { project_role: string };
    invariant(role.project_role === 'owner' || role.project_role === 'manager', 'PROJECT_MANAGER_REQUIRED', 'A Project Owner or Manager is required.', 403);
    return access;
  }

  protected resource(resourceId: string, includeDeleted = false): ResourceRow {
    const row = this.database.raw.prepare('SELECT * FROM project_resources WHERE id = ?').get(resourceId) as ResourceRow | undefined;
    invariant(row && (includeDeleted || row.status === 'active'), 'RESOURCE_NOT_FOUND', 'Project resource does not exist or is unavailable.', 404);
    return row;
  }

  private ensureResourceAccess(principal: Principal, row: ResourceRow, includeDeleted = false): { workspaceId: string; projectMembershipId: string; actor: string } {
    const access = this.access(principal, row.project_id);
    invariant(includeDeleted || row.status === 'active', 'RESOURCE_NOT_FOUND', 'Project resource does not exist or is unavailable.', 404);
    return access;
  }

  private path(row: ResourceRow): string {
    const parts = [row.name];
    let parent = row.parent_id ? this.database.raw.prepare('SELECT * FROM project_resources WHERE id = ?').get(row.parent_id) as ResourceRow | undefined : undefined;
    let guard = 0;
    while (parent && guard++ < 100) {
      parts.unshift(parent.name);
      parent = parent.parent_id ? this.database.raw.prepare('SELECT * FROM project_resources WHERE id = ?').get(parent.parent_id) as ResourceRow | undefined : undefined;
    }
    return parts.join('/');
  }

  private view(row: ResourceRow): ProjectResourceView {
    const file = row.kind === 'file' ? this.database.raw.prepare('SELECT * FROM project_resource_files WHERE resource_id = ?').get(row.id) as ResourceFileRow | undefined : undefined;
    return {
      resourceId: row.id, projectId: row.project_id, parentResourceId: row.parent_id, name: row.name,
      path: this.path(row), kind: row.kind, status: row.status, revision: row.revision,
      digest: file?.content_digest ?? null, mediaType: file?.media_type ?? null, byteLength: file?.byte_length ?? null,
      createdByActorId: row.created_by_actor_id, createdAt: row.created_at, updatedAt: row.updated_at,
      deletedAt: row.deleted_at, purgeAfter: row.purge_after,
    };
  }

  list(principal: Principal, projectId: string, includeDeleted = false): ProjectResourceView[] {
    this.access(principal, projectId);
    const rows = this.database.raw.prepare(
      `SELECT * FROM project_resources WHERE project_id = ? ${includeDeleted ? '' : "AND status = 'active'"} ORDER BY parent_id IS NOT NULL, parent_id, name, id`,
    ).all(projectId) as unknown as ResourceRow[];
    return rows.map((row) => this.view(row));
  }

  get(principal: Principal, resourceId: string, includeDeleted = false): ProjectResourceView {
    const row = this.resource(resourceId, includeDeleted);
    this.ensureResourceAccess(principal, row, includeDeleted);
    return this.view(row);
  }

  getInProject(principal: Principal, projectId: string, resourceId: string, includeDeleted = false): ProjectResourceView {
    const resource = this.get(principal, resourceId, includeDeleted);
    invariant(resource.projectId === projectId, 'PROJECT_SCOPE_VIOLATION', 'Resource does not belong to this Project.', 404);
    return resource;
  }

  read(principal: Principal, resourceId: string): { resource: ProjectResourceView; storagePath: string } {
    const row = this.resource(resourceId);
    this.ensureResourceAccess(principal, row);
    invariant(row.kind === 'file', 'RESOURCE_IS_DIRECTORY', 'Directories do not contain file content.', 409);
    const file = this.database.raw.prepare('SELECT * FROM project_resource_files WHERE resource_id = ?').get(row.id) as ResourceFileRow | undefined;
    invariant(file, 'RESOURCE_CONTENT_NOT_FOUND', 'Resource content is unavailable.', 404);
    const blob = this.database.raw.prepare('SELECT storage_path FROM content_blobs WHERE hash = ?').get(file.blob_hash) as { storage_path: string } | undefined;
    invariant(blob, 'RESOURCE_CONTENT_NOT_FOUND', 'Resource content is unavailable.', 404);
    return { resource: this.view(row), storagePath: blob.storage_path };
  }

  createFolder(principal: HumanPrincipal, projectId: string, input: { name: string; parentResourceId?: string | null }): ProjectResourceView {
    const access = this.humanWrite(principal, projectId);
    return this.database.transaction(() => {
      const parentId = input.parentResourceId ?? null;
      this.validateParent(access.workspaceId, projectId, parentId);
      const row = this.insertResource(access.workspaceId, projectId, parentId, cleanName(input.name), 'directory', principal.actorId);
      return this.view(row);
    });
  }

  async upload(principal: HumanPrincipal, projectId: string, input: { name: string; parentResourceId?: string | null; path?: string }, stored: StoredContentBlob): Promise<ProjectResourceView> {
    const access = this.humanWrite(principal, projectId);
    try {
      return this.database.transaction(() => {
        const parentId = this.resolveParentPath(access.workspaceId, projectId, input.parentResourceId ?? null, input.path, principal.actorId);
        const row = this.insertResource(access.workspaceId, projectId, parentId, cleanName(input.name), 'file', principal.actorId);
        this.registerBlob(stored);
        this.database.raw.prepare(
          `INSERT INTO project_resource_files (resource_id, workspace_id, blob_hash, media_type, byte_length, content_digest, revision, updated_by_actor_id, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        ).run(row.id, access.workspaceId, stored.hash, stored.mediaType, stored.byteLength, stored.hash, principal.actorId, row.updated_at);
        return this.view(row);
      });
    } catch (error) {
      this.discardBlob(stored);
      throw error;
    }
  }

  async replace(principal: HumanPrincipal, resourceId: string, expectedRevision: number, stored: StoredContentBlob): Promise<ProjectResourceView> {
    const row = this.resource(resourceId);
    const access = this.humanWrite(principal, row.project_id);
    invariant(row.kind === 'file', 'RESOURCE_IS_DIRECTORY', 'Directories cannot be replaced.', 409);
    try {
      return this.database.transaction(() => {
        const file = this.database.raw.prepare('SELECT revision FROM project_resource_files WHERE resource_id = ?').get(row.id) as { revision: number } | undefined;
        invariant(file && row.revision === expectedRevision && file.revision === expectedRevision, 'RESOURCE_REVISION_CONFLICT', 'Resource changed since it was read.', 409, { expectedRevision, currentRevision: row.revision });
        this.registerBlob(stored);
        const timestamp = nowMs();
        this.database.raw.prepare('UPDATE project_resources SET revision = revision + 1, updated_at = ? WHERE id = ?').run(timestamp, row.id);
        this.database.raw.prepare(
          `UPDATE project_resource_files SET blob_hash = ?, media_type = ?, byte_length = ?, content_digest = ?, revision = revision + 1, updated_by_actor_id = ?, updated_at = ? WHERE resource_id = ?`,
        ).run(stored.hash, stored.mediaType, stored.byteLength, stored.hash, principal.actorId, timestamp, row.id);
        return this.view(this.resource(row.id));
      });
    } catch (error) {
      this.discardBlob(stored);
      throw error;
    }
  }

  move(principal: HumanPrincipal, resourceId: string, parentResourceId: string | null): ProjectResourceView {
    const row = this.resource(resourceId);
    const access = this.humanWrite(principal, row.project_id);
    this.validateParent(access.workspaceId, row.project_id, parentResourceId);
    invariant(parentResourceId !== row.id, 'RESOURCE_CYCLE', 'A resource cannot be moved inside itself.', 409);
    let ancestor = parentResourceId;
    while (ancestor) {
      invariant(ancestor !== row.id, 'RESOURCE_CYCLE', 'A resource cannot be moved inside its descendant.', 409);
      ancestor = (this.database.raw.prepare('SELECT parent_id FROM project_resources WHERE id = ?').get(ancestor) as { parent_id: string | null } | undefined)?.parent_id ?? null;
    }
    const timestamp = nowMs();
    this.database.raw.prepare('UPDATE project_resources SET parent_id = ?, revision = revision + 1, updated_at = ? WHERE id = ?').run(parentResourceId, timestamp, row.id);
    return this.view(this.resource(row.id));
  }

  rename(principal: HumanPrincipal, resourceId: string, name: string): ProjectResourceView {
    const row = this.resource(resourceId); this.humanWrite(principal, row.project_id);
    const timestamp = nowMs();
    this.database.raw.prepare('UPDATE project_resources SET name = ?, revision = revision + 1, updated_at = ? WHERE id = ?').run(cleanName(name), timestamp, row.id);
    return this.view(this.resource(row.id));
  }

  delete(principal: HumanPrincipal, resourceId: string): ProjectResourceView {
    const row = this.resource(resourceId); this.humanWrite(principal, row.project_id);
    const timestamp = nowMs();
    this.database.transaction(() => {
      this.database.raw.prepare(
        `WITH RECURSIVE descendants(id) AS (
           SELECT id FROM project_resources WHERE id = ?
           UNION ALL SELECT child.id FROM project_resources child JOIN descendants d ON child.parent_id = d.id
         ) UPDATE project_resources SET status = 'deleted', deleted_at = ?, purge_after = ?, revision = revision + 1, updated_at = ?
         WHERE id IN (SELECT id FROM descendants) AND status = 'active'`,
      ).run(row.id, timestamp, timestamp + TRASH_RETENTION_MS, timestamp);
    });
    return this.view(this.resource(row.id, true));
  }

  restore(principal: HumanPrincipal, resourceId: string): ProjectResourceView {
    const row = this.resource(resourceId, true); this.humanWrite(principal, row.project_id);
    invariant(row.status === 'deleted' && (!row.purge_after || row.purge_after > nowMs()), 'RESOURCE_PURGED', 'The resource retention window has expired.', 410);
    const timestamp = nowMs();
    this.database.transaction(() => {
      this.database.raw.prepare(
        `WITH RECURSIVE descendants(id) AS (
           SELECT id FROM project_resources WHERE id = ?
           UNION ALL SELECT child.id FROM project_resources child JOIN descendants d ON child.parent_id = d.id
         ) UPDATE project_resources SET status = 'active', deleted_at = NULL, purge_after = NULL, revision = revision + 1, updated_at = ?
         WHERE id IN (SELECT id FROM descendants) AND status = 'deleted'`,
      ).run(row.id, timestamp);
    });
    return this.view(this.resource(row.id));
  }

  private validateParent(workspaceId: string, projectId: string, parentId: string | null): void {
    if (!parentId) return;
    const parent = this.database.raw.prepare('SELECT * FROM project_resources WHERE id = ? AND workspace_id = ? AND project_id = ?').get(parentId, workspaceId, projectId) as ResourceRow | undefined;
    invariant(parent && parent.kind === 'directory' && parent.status === 'active', 'RESOURCE_PARENT_INVALID', 'Parent resource must be an active directory.', 409);
  }

  private resolveParentPath(workspaceId: string, projectId: string, parentId: string | null, path: string | undefined, creator: string): string | null {
    this.validateParent(workspaceId, projectId, parentId);
    const relative = cleanPath(path);
    if (!relative) return parentId;
    let current = parentId;
    for (const part of relative.split('/')) {
      const found = this.database.raw.prepare("SELECT * FROM project_resources WHERE workspace_id = ? AND project_id = ? AND parent_id IS ? AND name = ? AND status = 'active'").get(workspaceId, projectId, current, cleanName(part)) as ResourceRow | undefined;
      if (found) { invariant(found.kind === 'directory', 'RESOURCE_PARENT_INVALID', 'A path component is a file.', 409); current = found.id; continue; }
      const row = this.insertResource(workspaceId, projectId, current, cleanName(part), 'directory', creator);
      current = row.id;
    }
    return current;
  }

  private insertResource(workspaceId: string, projectId: string, parentId: string | null, name: string, kind: 'file' | 'directory', creator: string): ResourceRow {
    const id = newId(); const timestamp = nowMs();
    try {
      this.database.raw.prepare(
        `INSERT INTO project_resources (id, workspace_id, project_id, parent_id, name, kind, status, revision, created_by_actor_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?)`,
      ).run(id, workspaceId, projectId, parentId, name, kind, creator, timestamp, timestamp);
    } catch (error) {
      if (String(error).includes('UNIQUE')) throw new DomainError('RESOURCE_NAME_CONFLICT', 'A resource with this name already exists in the directory.', 409);
      throw error;
    }
    return this.resource(id);
  }

  protected registerBlob(stored: StoredContentBlob): void {
    this.database.raw.prepare(
      'INSERT OR IGNORE INTO content_blobs (hash, byte_length, media_type, storage_path, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(stored.hash, stored.byteLength, stored.mediaType, stored.storagePath, nowMs());
  }

  protected discardBlob(stored: StoredContentBlob): void {
    const used = this.database.raw.prepare('SELECT 1 FROM content_blobs WHERE hash = ?').get(stored.hash);
    if (!used) rmSync(stored.storagePath, { force: true });
  }

  createLink(principal: HumanPrincipal, projectId: string, input: { locator: string; name: string; description?: string | null }): ProjectLinkView {
    const access = this.humanWrite(principal, projectId);
    const locator = input.locator.trim();
    invariant(/^https?:\/\/[^\s]+$/u.test(locator), 'INVALID_LINK_LOCATOR', 'Only http/https links are supported.');
    const id = newId(); const timestamp = nowMs();
    try {
      this.database.raw.prepare(
        `INSERT INTO project_links (id, workspace_id, project_id, locator, name, description, created_by_actor_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, access.workspaceId, projectId, locator, cleanName(input.name), input.description?.trim() || null, principal.actorId, timestamp, timestamp);
    } catch (error) {
      if (String(error).includes('UNIQUE')) throw new DomainError('LINK_LOCATOR_CONFLICT', 'This locator is already registered in the Project.', 409);
      throw error;
    }
    return this.link(this.linkRow(id));
  }

  listLinks(principal: Principal, projectId: string, includeDeleted = false): ProjectLinkView[] {
    this.access(principal, projectId);
    const rows = this.database.raw.prepare(`SELECT * FROM project_links WHERE project_id = ? ${includeDeleted ? '' : "AND status = 'active'"} ORDER BY name, id`).all(projectId) as unknown as LinkRow[];
    return rows.map((row) => this.link(row));
  }

  updateLink(principal: HumanPrincipal, linkId: string, input: { name?: string; description?: string | null }): ProjectLinkView {
    const row = this.linkRow(linkId); this.humanWrite(principal, row.project_id);
    invariant(row.status === 'active', 'LINK_NOT_FOUND', 'Link does not exist or is unavailable.', 404);
    const timestamp = nowMs();
    const updates: string[] = [];
    const values: Array<string | number | null> = [];
    if (input.name !== undefined) { updates.push('name = ?'); values.push(cleanName(input.name)); }
    if (input.description !== undefined) { updates.push('description = ?'); values.push(input.description?.trim() || null); }
    if (updates.length === 0) return this.link(row);
    updates.push('revision = revision + 1', 'updated_at = ?');
    values.push(timestamp, linkId);
    this.database.raw.prepare(`UPDATE project_links SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    return this.link(this.linkRow(linkId));
  }

  deleteLink(principal: HumanPrincipal, linkId: string): ProjectLinkView {
    const row = this.linkRow(linkId); this.humanWrite(principal, row.project_id);
    const timestamp = nowMs();
    this.database.raw.prepare("UPDATE project_links SET status = 'deleted', deleted_at = ?, purge_after = ?, revision = revision + 1, updated_at = ? WHERE id = ?").run(timestamp, timestamp + TRASH_RETENTION_MS, timestamp, linkId);
    return this.link(this.linkRow(linkId));
  }

  restoreLink(principal: HumanPrincipal, linkId: string): ProjectLinkView {
    const row = this.linkRow(linkId); this.humanWrite(principal, row.project_id);
    invariant(row.status === 'deleted' && (!row.purge_after || row.purge_after > nowMs()), 'LINK_PURGED', 'The link retention window has expired.', 410);
    const timestamp = nowMs();
    try {
      this.database.raw.prepare("UPDATE project_links SET status = 'active', deleted_at = NULL, purge_after = NULL, revision = revision + 1, updated_at = ? WHERE id = ?").run(timestamp, linkId);
    } catch (error) {
      if (String(error).includes('UNIQUE')) throw new DomainError('LINK_LOCATOR_CONFLICT', 'This locator is already registered in the Project.', 409);
      throw error;
    }
    return this.link(this.linkRow(linkId));
  }

  private linkRow(id: string, includeDeleted = true): LinkRow {
    const row = this.database.raw.prepare('SELECT * FROM project_links WHERE id = ?').get(id) as LinkRow | undefined;
    invariant(row && (includeDeleted || row.status === 'active'), 'LINK_NOT_FOUND', 'Link does not exist or is unavailable.', 404);
    return row;
  }

  private link(row: LinkRow): ProjectLinkView {
    return { linkId: row.id, projectId: row.project_id, locator: row.locator, name: row.name, description: row.description, status: row.status, revision: row.revision, createdByActorId: row.created_by_actor_id, createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at, purgeAfter: row.purge_after };
  }

  purgeExpired(checkedAt = nowMs()): { resources: number; links: number; artifacts: number; versions: number } {
    return this.database.transaction(() => {
      const versions = this.database.raw.prepare("SELECT * FROM artifact_versions_v2 WHERE status = 'deleted' AND purge_after IS NOT NULL AND purge_after <= ?").all(checkedAt) as unknown as VersionRow[];
      for (const row of versions) {
        this.database.raw.prepare("UPDATE artifact_versions_v2 SET status = 'purged', blob_hash = NULL, purged_at = ? WHERE id = ?").run(checkedAt, row.id);
        this.database.raw.prepare('UPDATE artifact_preview_caches_v2 SET status = \'failed\', blob_hash = NULL, error_message = \'purged\', updated_at = ? WHERE version_id = ?').run(checkedAt, row.id);
      }
      const expiredResources = this.database.raw.prepare("SELECT id FROM project_resources WHERE status = 'deleted' AND purge_after IS NOT NULL AND purge_after <= ?").all(checkedAt) as unknown as Array<{ id: string }>;
      for (const resource of expiredResources) this.database.raw.prepare("UPDATE project_resource_files SET blob_hash = NULL WHERE resource_id = ?").run(resource.id);
      const resources = this.database.raw.prepare("UPDATE project_resources SET status = 'purged', purged_at = ? WHERE status = 'deleted' AND purge_after IS NOT NULL AND purge_after <= ?").run(checkedAt, checkedAt).changes;
      const links = this.database.raw.prepare("UPDATE project_links SET status = 'purged', purged_at = ? WHERE status = 'deleted' AND purge_after IS NOT NULL AND purge_after <= ?").run(checkedAt, checkedAt).changes;
      const expiredArtifacts = this.database.raw.prepare("SELECT id FROM project_artifacts_v2 WHERE status = 'deleted' AND purge_after IS NOT NULL AND purge_after <= ?").all(checkedAt) as unknown as Array<{ id: string }>;
      for (const artifact of expiredArtifacts) {
        // A deleted Artifact may still contain active versions.  Purging the
        // parent must tombstone those versions as well, otherwise the STRICT
        // status/deleted_at invariant would reject the update and leave the
        // Artifact stuck in the trash.
        this.database.raw.prepare("UPDATE artifact_versions_v2 SET status = 'purged', deleted_at = COALESCE(deleted_at, ?), blob_hash = NULL, purged_at = COALESCE(purged_at, ?) WHERE artifact_id = ? AND status <> 'purged'").run(checkedAt, checkedAt, artifact.id);
        this.database.raw.prepare("UPDATE artifact_preview_caches_v2 SET status = 'failed', blob_hash = NULL, error_message = 'purged', updated_at = ? WHERE version_id IN (SELECT id FROM artifact_versions_v2 WHERE artifact_id = ?)").run(checkedAt, artifact.id);
      }
      const artifacts = this.database.raw.prepare("UPDATE project_artifacts_v2 SET status = 'purged', purged_at = ? WHERE status = 'deleted' AND purge_after IS NOT NULL AND purge_after <= ?").run(checkedAt, checkedAt).changes;
      // Version/resource purging removes database references first. Only then
      // can a content blob be physically removed.
      const unreferenced = this.database.raw.prepare(
        `SELECT cb.hash, cb.storage_path FROM content_blobs cb
         WHERE NOT EXISTS (SELECT 1 FROM staged_blobs sb WHERE sb.blob_hash = cb.hash)
           AND NOT EXISTS (SELECT 1 FROM project_resource_files rf WHERE rf.blob_hash = cb.hash)
           AND NOT EXISTS (SELECT 1 FROM artifact_versions_v2 av WHERE av.blob_hash = cb.hash)
           AND NOT EXISTS (SELECT 1 FROM artifact_preview_caches_v2 pc WHERE pc.blob_hash = cb.hash)
           AND NOT EXISTS (SELECT 1 FROM artifact_v2_held_drafts hd WHERE hd.blob_hash = cb.hash)`,
      ).all() as unknown as Array<{ hash: string; storage_path: string }>;
      for (const blob of unreferenced) {
        rmSync(blob.storage_path, { force: true });
        this.database.raw.prepare('DELETE FROM content_blobs WHERE hash = ?').run(blob.hash);
      }
      return { resources: Number(resources), links: Number(links), artifacts: Number(artifacts), versions: versions.length, blobsRemoved: unreferenced.length };
    });
  }
}

export class ArtifactV2Service extends ProjectResourceService {
  private artifactRow(artifactId: string, includeDeleted = false): ArtifactRow {
    const row = this.database.raw.prepare('SELECT * FROM project_artifacts_v2 WHERE id = ?').get(artifactId) as ArtifactRow | undefined;
    invariant(row && (includeDeleted || row.status === 'active'), 'ARTIFACT_NOT_FOUND', 'Artifact does not exist or is unavailable.', 404);
    return row;
  }

  private versionRow(versionId: string, includeDeleted = true): VersionRow {
    const row = this.database.raw.prepare('SELECT * FROM artifact_versions_v2 WHERE id = ?').get(versionId) as VersionRow | undefined;
    invariant(row && (includeDeleted || row.status === 'active'), 'ARTIFACT_VERSION_NOT_FOUND', 'Artifact version does not exist or is unavailable.', 404);
    return row;
  }

  private versionView(row: VersionRow): ArtifactVersionView {
    const preview = this.database.raw.prepare('SELECT status, error_message FROM artifact_preview_caches_v2 WHERE version_id = ?').get(row.id) as { status: 'pending' | 'ready' | 'failed'; error_message: string | null } | undefined;
    return { versionId: row.id, artifactId: row.artifact_id, version: row.version_number, fileName: row.file_name, mediaType: row.media_type, byteLength: row.byte_length, digest: row.content_digest, parentVersionId: row.parent_version_id, status: row.status, createdByActorId: row.created_by_actor_id, createdAt: row.created_at, taskId: row.task_id, messageId: row.message_id, publishBatchId: row.publish_batch_id, note: row.note, preview: { status: preview?.status ?? 'failed', errorMessage: preview?.error_message ?? null }, deletedAt: row.deleted_at, purgeAfter: row.purge_after };
  }

  private artifactView(row: ArtifactRow, includeDeleted = true): ArtifactV2View {
    const latest = row.latest_version_id ? this.versionRow(row.latest_version_id, true) : null;
    const parents = this.database.raw.prepare('SELECT parent_version_id FROM artifact_derivation_parents_v2 WHERE artifact_id = ? ORDER BY parent_ordinal').all(row.id) as { parent_version_id: string }[];
    return { artifactId: row.id, projectId: row.project_id, name: row.name, projectPath: row.project_path, status: row.status, latestVersionId: row.latest_version_id, latestVersion: latest && latest.status === 'active' ? this.versionView(latest) : this.latestActiveVersion(row.id), createdByActorId: row.created_by_actor_id, createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at, purgeAfter: row.purge_after, derivationParentVersionIds: parents.map((parent) => parent.parent_version_id) };
  }

  private latestActiveVersion(artifactId: string): ArtifactVersionView | null {
    const row = this.database.raw.prepare("SELECT * FROM artifact_versions_v2 WHERE artifact_id = ? AND status = 'active' ORDER BY version_number DESC LIMIT 1").get(artifactId) as VersionRow | undefined;
    return row ? this.versionView(row) : null;
  }

  listArtifacts(principal: Principal, projectId: string, includeDeleted = false): ArtifactV2View[] {
    this.access(principal, projectId);
    const rows = this.database.raw.prepare(`SELECT * FROM project_artifacts_v2 WHERE project_id = ? ${includeDeleted ? '' : "AND status = 'active'"} ORDER BY project_path, name, id`).all(projectId) as unknown as ArtifactRow[];
    return rows.map((row) => this.artifactView(row));
  }

  getArtifact(principal: Principal, artifactId: string, includeDeleted = false): ArtifactV2View {
    const row = this.artifactRow(artifactId, includeDeleted); this.access(principal, row.project_id);
    return this.artifactView(row);
  }

  getArtifactInProject(principal: Principal, projectId: string, artifactId: string, includeDeleted = false): ArtifactV2View {
    const artifact = this.getArtifact(principal, artifactId, includeDeleted);
    invariant(artifact.projectId === projectId, 'PROJECT_SCOPE_VIOLATION', 'Artifact does not belong to this Project.', 404);
    return artifact;
  }

  listVersions(principal: Principal, artifactId: string, includeDeleted = true): ArtifactVersionView[] {
    const artifact = this.artifactRow(artifactId, true); this.access(principal, artifact.project_id);
    const rows = this.database.raw.prepare(`SELECT * FROM artifact_versions_v2 WHERE artifact_id = ? ${includeDeleted ? '' : "AND status = 'active'"} ORDER BY version_number`).all(artifactId) as unknown as VersionRow[];
    return rows.map((row) => this.versionView(row));
  }

  getVersion(principal: Principal, versionId: string, includeDeleted = true): ArtifactVersionView {
    const row = this.versionRow(versionId, includeDeleted); const artifact = this.artifactRow(row.artifact_id, true); this.access(principal, artifact.project_id); return this.versionView(row);
  }

  getVersionContext(principal: Principal, versionId: string): {
    version: ArtifactVersionView;
    artifact: { artifactId: string; projectId: string; name: string; projectPath: string };
    sourceResourceRefs: Array<{ resourceId: string; revision: number; digest: string }>;
    derivationParentVersionIds: string[];
  } {
    const row = this.versionRow(versionId, true);
    const artifact = this.artifactRow(row.artifact_id, true);
    this.access(principal, artifact.project_id);
    const sources = this.database.raw.prepare('SELECT resource_id, resource_revision, resource_digest FROM artifact_version_sources_v2 WHERE version_id = ? ORDER BY resource_id').all(versionId) as unknown as Array<{ resource_id: string; resource_revision: number; resource_digest: string }>;
    const parents = this.database.raw.prepare('SELECT parent_version_id FROM artifact_derivation_parents_v2 WHERE artifact_id = ? ORDER BY parent_ordinal').all(artifact.id) as unknown as Array<{ parent_version_id: string }>;
    return { version: this.versionView(row), artifact: { artifactId: artifact.id, projectId: artifact.project_id, name: artifact.name, projectPath: artifact.project_path }, sourceResourceRefs: sources.map((source) => ({ resourceId: source.resource_id, revision: source.resource_revision, digest: source.resource_digest })), derivationParentVersionIds: parents.map((parent) => parent.parent_version_id) };
  }

  readVersion(principal: Principal, versionId: string): { version: ArtifactVersionView; storagePath: string } {
    const row = this.versionRow(versionId, false); const artifact = this.artifactRow(row.artifact_id); this.access(principal, artifact.project_id);
    invariant(row.blob_hash, 'ARTIFACT_VERSION_PURGED', 'Artifact version content has been purged.', 410);
    const blob = this.database.raw.prepare('SELECT storage_path FROM content_blobs WHERE hash = ?').get(row.blob_hash) as { storage_path: string } | undefined;
    invariant(blob, 'ARTIFACT_VERSION_CONTENT_NOT_FOUND', 'Artifact version content is unavailable.', 404);
    return { version: this.versionView(row), storagePath: blob.storage_path };
  }

  async publish(principal: ActorPrincipal, projectId: string, input: { draftId?: string; artifactId?: string; fileName: string; artifactName?: string; artifactPath?: string; expectedLatestVersionId?: string; parentVersionIds?: string[]; sourceResourceRefs?: Array<{ resourceId: string; revision?: number; digest?: string }>; taskId?: string; messageId?: string; publishBatchId?: string; note?: string }, stored: StoredContentBlob, idempotencyKey?: string): Promise<{ artifact: ArtifactV2View; version: ArtifactVersionView; created: boolean }> {
    return this.publishSync(principal, projectId, input, stored, idempotencyKey);
  }

  /** Synchronous form used by the atomic Attempt return transaction. */
  publishSync(principal: ActorPrincipal, projectId: string, input: { draftId?: string; artifactId?: string; fileName: string; artifactName?: string; artifactPath?: string; expectedLatestVersionId?: string; parentVersionIds?: string[]; sourceResourceRefs?: Array<{ resourceId: string; revision?: number; digest?: string }>; taskId?: string; messageId?: string; publishBatchId?: string; note?: string }, stored: StoredContentBlob, idempotencyKey?: string): { artifact: ArtifactV2View; version: ArtifactVersionView; created: boolean } {
    const access = this.access(principal, projectId);
    // Agent retries use draftId as their stable publication identity. Human
    // HTTP callers may supply the Idempotency-Key separately. Persisting the
    // result in the shared idempotency table makes a response-loss retry
    // return the original Artifact/version instead of appending a duplicate.
    const stableKey = input.draftId ?? idempotencyKey;
    const requestHash = stableKey
      ? sha256(canonicalJson({ projectId, input, contentDigest: stored.hash }))
      : null;
    if (stableKey && requestHash) {
      const prior = this.database.raw.prepare(
        `SELECT request_hash, result_json FROM idempotency_records
         WHERE scope_key = ? AND actor_id = ? AND command_name = 'PublishArtifactV2' AND idempotency_key = ?`,
      ).get(access.workspaceId, actorId(principal), stableKey) as { request_hash: string; result_json: string } | undefined;
      if (prior) {
        invariant(prior.request_hash === requestHash, 'IDEMPOTENCY_CONFLICT', 'Idempotency key was reused with a different publication.', 409);
        this.discardBlob(stored);
        return JSON.parse(prior.result_json) as { artifact: ArtifactV2View; version: ArtifactVersionView; created: boolean };
      }
    }
    try {
      const result = this.database.transaction(() => {
      const timestamp = nowMs(); let artifact: ArtifactRow; let created = false;
      if (input.artifactId) {
        artifact = this.artifactRow(input.artifactId);
        invariant(artifact.project_id === projectId, 'PROJECT_SCOPE_VIOLATION', 'Artifact belongs to another Project.', 403);
        invariant(input.expectedLatestVersionId, 'EXPECTED_LATEST_VERSION_REQUIRED', 'expectedLatestVersionId is required when appending.', 400);
        invariant(artifact.latest_version_id === input.expectedLatestVersionId, 'ARTIFACT_VERSION_CONFLICT', 'Artifact has changed since it was read.', 409, { expectedLatestVersionId: input.expectedLatestVersionId, currentLatestVersionId: artifact.latest_version_id });
      } else {
        const artifactId = newId(); created = true;
        this.database.raw.prepare(`INSERT INTO project_artifacts_v2 (id, workspace_id, project_id, name, project_path, created_by_actor_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(artifactId, access.workspaceId, projectId, cleanName(input.artifactName ?? input.fileName), cleanPath(input.artifactPath), actorId(principal), timestamp, timestamp);
        artifact = this.artifactRow(artifactId);
      }
      if (input.parentVersionIds?.length) {
        invariant(created, 'DERIVATION_PARENTS_ONLY_ON_CREATE', 'parentVersionIds can only be supplied when creating an Artifact.', 400);
        const unique = [...new Set(input.parentVersionIds)];
        unique.forEach((parentId, ordinal) => {
          const parent = this.versionRow(parentId, true); const parentArtifact = this.artifactRow(parent.artifact_id, true);
          invariant(parentArtifact.project_id === projectId && parent.status === 'active', 'INVALID_DERIVATION_PARENT', 'Derivation parents must be active versions in the same Project.', 400);
          this.database.raw.prepare('INSERT INTO artifact_derivation_parents_v2 (artifact_id, parent_version_id, parent_ordinal) VALUES (?, ?, ?)').run(artifact.id, parentId, ordinal);
        });
      }
      const actualSources: Array<{ resourceId: string; revision: number; digest: string }> = [];
      if (input.sourceResourceRefs?.length) {
        for (const source of input.sourceResourceRefs) {
          const resource = this.resource(source.resourceId, true); invariant(resource.project_id === projectId && resource.status === 'active', 'INVALID_RESOURCE_SOURCE', 'Source Resource must be active and in the same Project.', 400);
          invariant(resource.kind === 'file', 'INVALID_RESOURCE_SOURCE', 'Source Resource must be a file.', 400);
          const file = this.database.raw.prepare('SELECT revision, content_digest FROM project_resource_files WHERE resource_id = ?').get(resource.id) as { revision: number; content_digest: string } | undefined;
          invariant(file, 'INVALID_RESOURCE_SOURCE', 'Source Resource content is unavailable.', 400);
          actualSources.push({ resourceId: resource.id, revision: file.revision, digest: file.content_digest });
        }
      }
      const versionId = newId(); const versionNumber = artifact.next_version_number;
      const expectedLatestVersionId = input.expectedLatestVersionId ?? null;
      this.registerBlob(stored);
      this.database.raw.prepare(
        `INSERT INTO artifact_versions_v2 (id, workspace_id, artifact_id, version_number, file_name, blob_hash, media_type, byte_length, content_digest, parent_version_id, created_by_actor_id, task_id, message_id, publish_batch_id, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(versionId, access.workspaceId, artifact.id, versionNumber, cleanName(input.fileName, 'fileName'), stored.hash, stored.mediaType, stored.byteLength, stored.hash, input.artifactId ? expectedLatestVersionId : null, actorId(principal), input.taskId ?? null, input.messageId ?? null, input.publishBatchId ?? null, input.note?.trim() || null, timestamp);
      this.database.raw.prepare('UPDATE project_artifacts_v2 SET latest_version_id = ?, next_version_number = ?, updated_at = ? WHERE id = ?').run(versionId, versionNumber + 1, timestamp, artifact.id);
      for (const source of actualSources) this.database.raw.prepare('INSERT INTO artifact_version_sources_v2 (version_id, resource_id, resource_revision, resource_digest) VALUES (?, ?, ?, ?)').run(versionId, source.resourceId, source.revision, source.digest);
      this.database.raw.prepare("INSERT INTO artifact_preview_caches_v2 (version_id, status, blob_hash, updated_at) VALUES (?, 'ready', ?, ?)").run(versionId, stored.hash, timestamp);
      const nextArtifact = this.artifactRow(artifact.id);
      const version = this.versionRow(versionId);
      return { artifact: this.artifactView(nextArtifact), version: this.versionView(version), created };
      });
      if (input.draftId) {
        this.database.raw.prepare("UPDATE artifact_v2_held_drafts SET status = 'retried', updated_at = ? WHERE id = ? AND status = 'held'").run(nowMs(), input.draftId);
      }
      if (stableKey && requestHash) {
        try {
          this.database.raw.prepare(
            `INSERT INTO idempotency_records (
               scope_key, actor_id, command_name, idempotency_key, request_hash, result_json, created_at
             ) VALUES (?, ?, 'PublishArtifactV2', ?, ?, ?, ?)`,
          ).run(access.workspaceId, actorId(principal), stableKey, requestHash, canonicalJson(result), nowMs());
        } catch (error) {
          if (!String(error).includes('UNIQUE')) throw error;
          const concurrent = this.database.raw.prepare(
            `SELECT request_hash, result_json FROM idempotency_records
             WHERE scope_key = ? AND actor_id = ? AND command_name = 'PublishArtifactV2' AND idempotency_key = ?`,
          ).get(access.workspaceId, actorId(principal), stableKey) as { request_hash: string; result_json: string } | undefined;
          invariant(concurrent?.request_hash === requestHash, 'IDEMPOTENCY_CONFLICT', 'Idempotency key was reused with a different publication.', 409);
          return JSON.parse(concurrent.result_json) as { artifact: ArtifactV2View; version: ArtifactVersionView; created: boolean };
        }
      }
      return result;
    } catch (error) {
      if (error instanceof DomainError && error.code === 'ARTIFACT_VERSION_CONFLICT' && input.artifactId) {
        this.registerBlob(stored);
        const draftId = input.draftId ?? newId(); const timestamp = nowMs();
        try {
          this.database.raw.prepare(
            `INSERT INTO artifact_v2_held_drafts (id, workspace_id, project_id, artifact_id, blob_hash, file_name, expected_latest_version_id, payload_json, created_by_actor_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(draftId, access.workspaceId, projectId, input.artifactId, stored.hash, input.fileName, input.expectedLatestVersionId ?? null, JSON.stringify(input), actorId(principal), timestamp, timestamp);
        } catch (insertError) {
          if (!String(insertError).includes('UNIQUE')) throw insertError;
          const existingDraft = this.database.raw.prepare('SELECT status FROM artifact_v2_held_drafts WHERE id = ?').get(draftId) as { status: string } | undefined;
          invariant(existingDraft, 'ARTIFACT_VERSION_CONFLICT', error.message, 409, { heldDraftId: draftId });
        }
        throw new DomainError('ARTIFACT_VERSION_CONFLICT', error.message, 409, { ...(typeof error.details === 'object' && error.details !== null ? error.details as Record<string, unknown> : {}), heldDraftId: draftId });
      }
      this.discardBlob(stored);
      throw error;
    }
  }

  listHeldDrafts(principal: Principal, projectId: string): Array<{ draftId: string; artifactId: string; fileName: string; expectedLatestVersionId: string | null; status: string; createdAt: number; updatedAt: number }> {
    const access = this.access(principal, projectId);
    return this.database.raw.prepare('SELECT id AS draft_id, artifact_id, file_name, expected_latest_version_id, status, created_at, updated_at FROM artifact_v2_held_drafts WHERE workspace_id = ? AND project_id = ? ORDER BY created_at DESC').all(access.workspaceId, projectId).map((row) => {
      const item = row as { draft_id: string; artifact_id: string; file_name: string; expected_latest_version_id: string | null; status: string; created_at: number; updated_at: number };
      return { draftId: item.draft_id, artifactId: item.artifact_id, fileName: item.file_name, expectedLatestVersionId: item.expected_latest_version_id, status: item.status, createdAt: item.created_at, updatedAt: item.updated_at };
    });
  }

  discardHeldDraft(principal: ActorPrincipal, draftId: string, expectedProjectId?: string): void {
    const row = this.database.raw.prepare('SELECT * FROM artifact_v2_held_drafts WHERE id = ?').get(draftId) as { project_id: string; status: string } | undefined;
    invariant(row, 'HELD_DRAFT_NOT_FOUND', 'Held Draft does not exist.', 404);
    invariant(!expectedProjectId || row.project_id === expectedProjectId, 'PROJECT_SCOPE_VIOLATION', 'Held Draft does not belong to this Project.', 404);
    if (principal.kind === 'human') this.humanWrite(principal, row.project_id);
    else this.access(principal, row.project_id);
    this.database.raw.prepare("UPDATE artifact_v2_held_drafts SET status = 'discarded', updated_at = ? WHERE id = ?").run(nowMs(), draftId);
  }

  async retryHeldDraft(principal: ActorPrincipal, draftId: string, mode: 'retry' | 'force' = 'retry', expectedProjectId?: string): Promise<{ artifact: ArtifactV2View; version: ArtifactVersionView; created: boolean }> {
    const row = this.database.raw.prepare('SELECT d.*, cb.storage_path, cb.byte_length, cb.media_type FROM artifact_v2_held_drafts d JOIN content_blobs cb ON cb.hash = d.blob_hash WHERE d.id = ?').get(draftId) as {
      id: string; workspace_id: string; project_id: string; artifact_id: string; blob_hash: string; file_name: string; expected_latest_version_id: string | null; payload_json: string; status: string; storage_path: string; byte_length: number; media_type: string;
    } | undefined;
    invariant(row, 'HELD_DRAFT_NOT_FOUND', 'Held Draft does not exist or its content was purged.', 404);
    invariant(!expectedProjectId || row.project_id === expectedProjectId, 'PROJECT_SCOPE_VIOLATION', 'Held Draft does not belong to this Project.', 404);
    this.access(principal, row.project_id);
    invariant(row.status === 'held', 'HELD_DRAFT_NOT_RETRYABLE', 'Held Draft is no longer retryable.', 409);
    const artifact = this.artifactRow(row.artifact_id);
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    const stored: StoredContentBlob = { hash: row.blob_hash, storagePath: row.storage_path, byteLength: row.byte_length, mediaType: row.media_type };
    const result = await this.publish(principal, row.project_id, {
      draftId: row.id,
      artifactId: row.artifact_id,
      fileName: row.file_name,
      ...(typeof payload.artifactName === 'string' ? { artifactName: payload.artifactName } : {}),
      ...(typeof payload.artifactPath === 'string' ? { artifactPath: payload.artifactPath } : {}),
      ...(artifact.latest_version_id ? { expectedLatestVersionId: artifact.latest_version_id } : {}),
      ...(Array.isArray(payload.parentVersionIds) ? { parentVersionIds: payload.parentVersionIds as string[] } : {}),
      ...(Array.isArray(payload.sourceResourceRefs) ? { sourceResourceRefs: payload.sourceResourceRefs as Array<{ resourceId: string; revision?: number; digest?: string }> } : {}),
      ...(typeof payload.taskId === 'string' ? { taskId: payload.taskId } : {}), ...(typeof payload.messageId === 'string' ? { messageId: payload.messageId } : {}),
      ...(typeof payload.publishBatchId === 'string' ? { publishBatchId: payload.publishBatchId } : {}), ...(typeof payload.note === 'string' ? { note: payload.note } : {}),
    }, stored);
    this.database.raw.prepare("UPDATE artifact_v2_held_drafts SET status = 'retried', updated_at = ? WHERE id = ?").run(nowMs(), draftId);
    return result;
  }

  async publishFromResource(principal: ActorPrincipal, projectId: string, input: { resourceId: string; artifactId?: string; artifactName?: string; artifactPath?: string; expectedLatestVersionId?: string; taskId?: string; messageId?: string; publishBatchId?: string; note?: string }): Promise<{ artifact: ArtifactV2View; version: ArtifactVersionView; created: boolean }> {
    const source = this.read(principal, input.resourceId);
    const content = readFileSync(source.storagePath);
    const stored = this.blobs.writeBufferSync(content, source.resource.mediaType ?? 'application/octet-stream');
    return this.publish(principal, projectId, {
      ...(input.artifactId ? { artifactId: input.artifactId } : {}), fileName: source.resource.name,
      ...(input.artifactName ? { artifactName: input.artifactName } : {}),
      ...(input.artifactPath ? { artifactPath: input.artifactPath } : {}),
      ...(input.expectedLatestVersionId ? { expectedLatestVersionId: input.expectedLatestVersionId } : {}),
      sourceResourceRefs: [{ resourceId: input.resourceId, revision: source.resource.revision, digest: source.resource.digest ?? stored.hash }],
      ...(input.taskId ? { taskId: input.taskId } : {}), ...(input.messageId ? { messageId: input.messageId } : {}),
      ...(input.publishBatchId ? { publishBatchId: input.publishBatchId } : {}), ...(input.note ? { note: input.note } : {}),
    }, stored);
  }

  updateArtifact(principal: HumanPrincipal, artifactId: string, input: { name?: string; projectPath?: string }): ArtifactV2View {
    const row = this.artifactRow(artifactId); const access = this.humanWrite(principal, row.project_id);
    const timestamp = nowMs();
    this.database.raw.prepare('UPDATE project_artifacts_v2 SET name = COALESCE(?, name), project_path = COALESCE(?, project_path), updated_at = ? WHERE id = ?').run(input.name ? cleanName(input.name) : null, input.projectPath === undefined ? null : cleanPath(input.projectPath), timestamp, artifactId);
    return this.artifactView(this.artifactRow(artifactId));
  }

  deleteArtifact(principal: HumanPrincipal, artifactId: string): ArtifactV2View {
    const row = this.artifactRow(artifactId); this.humanWrite(principal, row.project_id); const timestamp = nowMs();
    this.database.raw.prepare("UPDATE project_artifacts_v2 SET status = 'deleted', deleted_at = ?, purge_after = ?, updated_at = ? WHERE id = ?").run(timestamp, timestamp + TRASH_RETENTION_MS, timestamp, artifactId);
    return this.artifactView(this.artifactRow(artifactId, true));
  }

  restoreArtifact(principal: HumanPrincipal, artifactId: string): ArtifactV2View {
    const row = this.artifactRow(artifactId, true); this.humanWrite(principal, row.project_id); invariant(row.status === 'deleted' && (!row.purge_after || row.purge_after > nowMs()), 'ARTIFACT_PURGED', 'The Artifact retention window has expired.', 410); const timestamp = nowMs();
    this.database.raw.prepare("UPDATE project_artifacts_v2 SET status = 'active', deleted_at = NULL, purge_after = NULL, updated_at = ? WHERE id = ?").run(timestamp, artifactId);
    return this.artifactView(this.artifactRow(artifactId));
  }

  deleteVersion(principal: HumanPrincipal, versionId: string): ArtifactVersionView {
    const row = this.versionRow(versionId, true); const artifact = this.artifactRow(row.artifact_id, true); this.humanWrite(principal, artifact.project_id); invariant(row.status === 'active', 'ARTIFACT_VERSION_NOT_FOUND', 'Artifact version does not exist or is unavailable.', 404); const timestamp = nowMs();
    this.database.transaction(() => {
      this.database.raw.prepare("UPDATE artifact_versions_v2 SET status = 'deleted', deleted_at = ?, purge_after = ? WHERE id = ?").run(timestamp, timestamp + TRASH_RETENTION_MS, versionId);
      this.database.raw.prepare("UPDATE artifact_preview_caches_v2 SET status = 'failed', blob_hash = NULL, error_message = 'version_deleted', updated_at = ? WHERE version_id = ?").run(timestamp, versionId);
      const latest = this.database.raw.prepare("SELECT id FROM artifact_versions_v2 WHERE artifact_id = ? AND status = 'active' ORDER BY version_number DESC LIMIT 1").get(row.artifact_id) as { id: string } | undefined;
      this.database.raw.prepare('UPDATE project_artifacts_v2 SET latest_version_id = ?, updated_at = ? WHERE id = ?').run(latest?.id ?? null, timestamp, row.artifact_id);
    });
    return this.versionView(this.versionRow(versionId));
  }

  restoreVersion(principal: HumanPrincipal, versionId: string): ArtifactVersionView {
    const row = this.versionRow(versionId, true); const artifact = this.artifactRow(row.artifact_id, true); this.humanWrite(principal, artifact.project_id); invariant(row.status === 'deleted' && (!row.purge_after || row.purge_after > nowMs()), 'ARTIFACT_VERSION_PURGED', 'The version retention window has expired.', 410); const timestamp = nowMs();
    this.database.transaction(() => {
      this.database.raw.prepare("UPDATE artifact_versions_v2 SET status = 'active', deleted_at = NULL, purge_after = NULL WHERE id = ?").run(versionId);
      this.database.raw.prepare("UPDATE artifact_preview_caches_v2 SET status = CASE WHEN (SELECT blob_hash FROM artifact_versions_v2 WHERE id = ?) IS NULL THEN 'failed' ELSE 'ready' END, blob_hash = (SELECT blob_hash FROM artifact_versions_v2 WHERE id = ?), error_message = CASE WHEN (SELECT blob_hash FROM artifact_versions_v2 WHERE id = ?) IS NULL THEN 'content_purged' ELSE NULL END, updated_at = ? WHERE version_id = ?").run(versionId, versionId, versionId, timestamp, versionId);
      const latest = this.database.raw.prepare("SELECT id FROM artifact_versions_v2 WHERE artifact_id = ? AND status = 'active' ORDER BY version_number DESC LIMIT 1").get(row.artifact_id) as { id: string } | undefined;
      this.database.raw.prepare('UPDATE project_artifacts_v2 SET latest_version_id = ?, updated_at = ? WHERE id = ?').run(latest?.id ?? null, timestamp, row.artifact_id);
    });
    return this.versionView(this.versionRow(versionId));
  }
}
