import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type {
  AgentMentionOutcomeView,
  AgentRequestStatus,
  AgentRequestView,
  AgentRuntimeSkillsView,
  AgentExecutionPolicy,
  AgentExecutionPolicyView,
  AgentInboxClaimView,
  AgentInboxSummaryView,
  AgentInboxWakeBatchView,
  AgentView,
  AttemptExecutionInputView,
  AttemptView,
  ChangePage,
  ChangeRecord,
  ComputerPrincipal,
  ComputerView,
  ContextSourceKind,
  ContextSourceRef,
  ConversationParticipantView,
  ConversationKind,
  ConversationView,
  HumanPrincipal,
  MembershipRole,
  MentionNotRequestedReason,
  MessageView,
  Page,
  ProjectMemberView,
  ProjectRepositoryView,
  ProjectResourceLinkView,
  ProjectRole,
  ProjectView,
  ProjectWorkingCopyReport,
  ProjectWorkingCopyView,
  PrivateContextGrantView,
  Principal,
  ReasoningEffort,
  WorkspaceBootstrapView,
  WorkspaceInvitationView,
  WorkspaceMemberView,
  WorkspaceView,
  RunContextSnapshotView,
  RunView,
  RuntimeBindingView,
  RuntimeCapabilityUnavailableReason,
  RuntimeCapabilityReport,
  RuntimeConfigurationCapabilities,
  RuntimeConfigurationSelection,
  RuntimeContextReadView,
  RuntimeId,
  RuntimeFailureResult,
  RuntimeReturnEnvelope,
  RuntimeReturnResult,
  WorkspaceDocumentView,
} from './types.js';
import { RUNTIME_CATALOG, runtimeCatalogDefinition } from './runtime-catalog.js';
import { DomainError, invariant, isSqliteConstraintError } from '../lib/errors.js';
import { canonicalJson, decodePageCursor, encodePageCursor, issueToken, newId, nowMs, sha256 } from '../lib/values.js';
import { SqliteDatabase } from '../storage/database.js';
import { LocalExecutionStore } from '../storage/local-execution-store.js';
import { AuthService, type VerificationCodeSink } from './auth-service.js';
import { normalizeDefaultBranch, normalizeGitCloneUrl } from '../lib/git-repository.js';
import { ArtifactService } from './artifact-service.js';
import { ContentBlobStore } from '../storage/content-blob-store.js';
import type { StoredContentBlob } from '../storage/content-blob-store.js';
import { resolve } from 'node:path';

interface MembershipRow {
  id: string;
  workspace_id: string;
  actor_id: string;
  membership_role: 'owner' | 'member';
  status: 'active' | 'removed';
  revision: number;
  joined_at: number;
  updated_at: number;
}

interface WorkspaceDocumentRow {
  id: string;
  workspace_id: string;
  status: 'active' | 'archived';
  revision: number;
  current_version: number;
  created_by_membership_id: string;
  created_at: number;
  updated_at: number;
  version_id: string;
  version: number;
  title: string;
  content_markdown: string;
  content_digest: string;
}

interface ProjectRow {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  created_by_membership_id: string;
  revision: number;
  context_version: number;
  created_at: number;
  updated_at: number;
}

interface ProjectRepositoryRow {
  id: string;
  workspace_id: string;
  project_id: string;
  clone_url: string;
  repository_identity: string;
  default_branch: string;
  status: 'active' | 'detached';
  revision: number;
  created_at: number;
  updated_at: number;
  detached_at: number | null;
}

interface ProjectMembershipRow {
  id: string;
  workspace_id: string;
  project_id: string;
  workspace_membership_id: string;
  project_role: ProjectRole;
  status: 'active' | 'removed';
  revision: number;
  joined_at: number;
  updated_at: number;
  removed_at: number | null;
}

interface AgentRow {
  actor_id: string;
  workspace_id: string;
  created_by_human_id: string;
  owner_membership_id: string;
  owner_human_id: string;
  owner_display_name: string;
  name: string;
  description: string | null;
  lifecycle_status: 'active' | 'suspended';
  revision: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  membership_id: string;
  membership_status: 'active' | 'removed';
}

interface InvitationRow {
  id: string;
  workspace_id: string;
  verified_email: string;
  membership_role: MembershipRole;
  status: 'pending' | 'accepted' | 'revoked';
  revision: number;
  invited_by_membership_id: string;
  accepted_membership_id: string | null;
  created_at: number;
  updated_at: number;
  terminal_at: number | null;
}

interface ExecutionContextRow {
  attempt_id: string;
  run_id: string;
  workspace_id: string;
  conversation_id: string;
  result_thread_id: string | null;
  root_message_id: string | null;
  agent_id: string;
  agent_membership_id: string;
  project_id: string | null;
  agent_project_membership_id: string | null;
  run_context_snapshot_id: string;
  workspace_context_version: number;
  conversation_context_version: number;
  timeline_frontier: number;
  reply_frontier: number | null;
  change_cursor: number;
}

interface RunRow {
  id: string;
  workspace_id: string;
  agent_request_id: string;
  agent_id: string;
  agent_membership_id: string;
  project_id: string | null;
  agent_project_membership_id: string | null;
  binding_id: string;
  binding_revision: number;
  policy_version_id: string;
  effective_budget_json: string;
  status: 'active' | 'terminal';
  outcome: RunView['outcome'];
  deadline_at: number;
  created_at: number;
  terminal_at: number | null;
}

interface AttemptRow {
  id: string;
  workspace_id: string;
  run_id: string;
  attempt_number: number;
  status: AttemptView['status'];
  binding_revision: number;
  policy_version_id: string;
  effective_budget_json: string;
  deadline_at: number;
  created_at: number;
  finished_at: number | null;
}

interface PrivateGrantRow {
  id: string;
  workspace_id: string;
  run_id: string;
  granted_by_membership_id: string;
  source_category: PrivateContextGrantView['sourceCategory'];
  read_allowed: number;
  disclosure_allowed: number;
  policy_version_id: string;
  expires_at: number;
  revoked_at: number | null;
  created_at: number;
}

interface MessageRow {
  id: string;
  workspace_id: string;
  conversation_id: string;
  project_id: string | null;
  thread_id: string | null;
  author_actor_id: string;
  author_membership_id: string;
  author_project_membership_id: string | null;
  body: string;
  conversation_version: number;
  scope_position: number;
  producing_run_id: string | null;
  producing_attempt_id: string | null;
  created_at: number;
}

interface AgentRequestRow {
  id: string;
  workspace_id: string;
  source_message_id: string;
  target_agent_id: string;
  result_conversation_id: string;
  result_thread_id: string | null;
  status: AgentRequestStatus;
  version: number;
  terminal_reason_code: 'requestor_cancelled' | 'authority_revoked' | 'intake_rejected' | null;
  terminal_reason_detail: string | null;
  created_at: number;
  updated_at: number;
  terminal_at: number | null;
}

interface AgentInboxItemRow {
  id: string;
  workspace_id: string;
  agent_id: string;
  sequence: number;
  attention_kind: 'direct_message' | 'mention';
  message_id: string;
  conversation_id: string;
  thread_id: string | null;
  agent_request_id: string;
  state: 'pending' | 'claimed' | 'handled';
  claimed_run_id: string | null;
  claim_receipt: string | null;
  created_at: number;
  claimed_at: number | null;
  handled_at: number | null;
}

interface AgentInboxClaimReceiptRow {
  id: string;
  workspace_id: string;
  agent_id: string;
  receipt: string;
  run_id: string;
  attempt_id: string;
  binding_revision: number;
  conversation_id: string;
  thread_id: string | null;
  from_position: number;
  through_position: number;
  created_at: number;
  updated_at: number;
}

interface ConversationAccess {
  conversation: {
    id: string;
    workspace_id: string;
    project_id: string | null;
    conversation_kind: ConversationKind;
    title: string | null;
    lifecycle_status: 'active' | 'archived';
    revision: number;
    archived_at: number | null;
    archived_by_membership_id: string | null;
    created_by_membership_id: string;
    created_by_project_membership_id: string | null;
    context_version: number;
    timeline_frontier: number;
    created_at: number;
    updated_at: number;
  };
  membership: MembershipRow;
  projectMembership: ProjectMembershipRow | null;
}

interface ConversationParticipantRow {
  membership_id: string;
  project_membership_id: string | null;
  actor_id: string;
  actor_type: 'human' | 'agent';
  display_name: string;
  joined_at: number;
}

const AVAILABLE_CONTEXT_SOURCE_KINDS = new Set<ContextSourceKind>([
  'message',
  'conversation',
  'document',
  'artifact',
  'project',
  'change',
]);

const RUNTIME_ID_PATTERN = /^[a-z0-9._-]{1,80}$/u;
const COMPUTER_ONLINE_WINDOW_MS = 90_000;

interface RuntimeBindingInput {
  computerId: string;
  runtimeId: RuntimeId;
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  mode?: string | null;
}

interface RuntimeBindingUpdateInput extends RuntimeBindingInput {
  expectedRevision: number;
}

interface RuntimeBindingRow {
  id: string;
  workspace_id: string;
  agent_id: string;
  computer_id: string;
  runtime_id: RuntimeId;
  requested_model: string | null;
  requested_reasoning_effort: ReasoningEffort | null;
  requested_mode: string | null;
  runtime_catalog_revision: number;
  binding_revision: number;
  status: 'active' | 'disabled';
  created_at: number;
  updated_at: number;
}

const DEFAULT_EXECUTION_POLICY: AgentExecutionPolicy = {
  maxParallelAttempts: 1,
  maxWallTimeMs: 30 * 60 * 1000,
  maxContextBytes: 16 * 1024 * 1024,
  maxToolCalls: 200,
  allowedContextKinds: ['message', 'conversation', 'document', 'artifact', 'project', 'change'],
  privateContextAllowed: false,
};

export class WorkspaceService {
  readonly localExecutions: LocalExecutionStore;
  readonly auth: AuthService;
  readonly artifacts: ArtifactService;
  private readonly agentInboxWakeEmitter = new EventEmitter();

  constructor(
    readonly workspaceDatabase: SqliteDatabase,
    localDatabase: SqliteDatabase,
    verificationCodeSink?: VerificationCodeSink,
    contentDirectory = resolve(process.cwd(), '.data', 'content-blobs'),
    exposeDevelopmentVerificationCode = false,
  ) {
    this.localExecutions = new LocalExecutionStore(localDatabase);
    this.auth = new AuthService(workspaceDatabase, verificationCodeSink, exposeDevelopmentVerificationCode);
    this.artifacts = new ArtifactService(workspaceDatabase, new ContentBlobStore(contentDirectory));
  }

  bootstrapHuman(displayName: string, verifiedEmail: string, label = 'bootstrap'): { humanId: string; verifiedEmail: string; token: string } {
    const normalizedName = displayName.trim();
    const normalizedEmail = this.normalizeEmail(verifiedEmail);
    invariant(normalizedName.length > 0 && normalizedName.length <= 120, 'INVALID_DISPLAY_NAME', 'Display name is required.');
    const humanId = newId();
    const tokenId = newId();
    const token = issueToken();
    const timestamp = nowMs();
    this.workspaceDatabase.transaction(() => {
      this.workspaceDatabase.raw.prepare("INSERT INTO actors (id, actor_type, created_at) VALUES (?, 'human', ?)").run(humanId, timestamp);
      this.workspaceDatabase.raw
        .prepare("INSERT INTO humans (actor_id, display_name, verified_email, status, created_at) VALUES (?, ?, ?, 'active', ?)")
        .run(humanId, normalizedName, normalizedEmail, timestamp);
      this.workspaceDatabase.raw
        .prepare(
          `INSERT INTO api_tokens (
             id, principal_type, human_actor_id, token_hash, label, status, created_at
           ) VALUES (?, 'human', ?, ?, ?, 'active', ?)`,
        )
        .run(tokenId, humanId, token.hash, label, timestamp);
    });
    return { humanId, verifiedEmail: normalizedEmail, token: token.raw };
  }

  authenticate(rawToken: string): Principal {
    invariant(rawToken.length > 0, 'UNAUTHORIZED', 'Bearer token is required.', 401);
    const row = this.workspaceDatabase.raw
      .prepare(
        `SELECT t.principal_type, t.human_actor_id, t.computer_id, c.owner_human_id
         FROM api_tokens t
         LEFT JOIN computers c ON c.id = t.computer_id
         LEFT JOIN humans h ON h.actor_id = t.human_actor_id
         WHERE t.token_hash = ? AND t.status = 'active'
           AND (t.expires_at IS NULL OR t.expires_at > ?)
           AND ((t.principal_type = 'human' AND h.status = 'active') OR (t.principal_type = 'computer' AND c.status = 'active'))`,
      )
      .get(sha256(rawToken), nowMs()) as
      | { principal_type: 'human' | 'computer'; human_actor_id: string | null; computer_id: string | null; owner_human_id: string | null }
      | undefined;
    invariant(row, 'UNAUTHORIZED', 'Bearer token is invalid or revoked.', 401);
    this.workspaceDatabase.raw.prepare('UPDATE api_tokens SET last_used_at = ? WHERE token_hash = ?').run(nowMs(), sha256(rawToken));
    if (row.principal_type === 'human') {
      invariant(row.human_actor_id, 'UNAUTHORIZED', 'Human token is malformed.', 401);
      return { kind: 'human', actorId: row.human_actor_id };
    }
    invariant(row.computer_id && row.owner_human_id, 'UNAUTHORIZED', 'Computer token is malformed.', 401);
    return { kind: 'computer', computerId: row.computer_id, ownerHumanId: row.owner_human_id };
  }

  createWorkspace(principal: HumanPrincipal, name: string, idempotencyKey: string): WorkspaceView {
    const normalizedName = name.trim();
    invariant(normalizedName.length > 0 && normalizedName.length <= 120, 'INVALID_WORKSPACE_NAME', 'Workspace name is required.');
    return this.idempotent('deployment', principal.actorId, 'CreateWorkspace', idempotencyKey, { name: normalizedName }, () => {
      const workspaceId = newId();
      const membershipId = newId();
      const timestamp = nowMs();
      this.workspaceDatabase.raw
        .prepare(
          `INSERT INTO workspaces (
             id, name, created_by_human_id, revision, context_version, created_at, updated_at
           ) VALUES (?, ?, ?, 1, 1, ?, ?)`,
        )
        .run(workspaceId, normalizedName, principal.actorId, timestamp, timestamp);
      this.workspaceDatabase.raw
        .prepare(
          `INSERT INTO workspace_memberships (
             id, workspace_id, actor_id, membership_role, status, revision, joined_at, updated_at
           ) VALUES (?, ?, ?, 'owner', 'active', 1, ?, ?)`,
        )
        .run(membershipId, workspaceId, principal.actorId, timestamp, timestamp);
      this.appendChange(workspaceId, 1, null, null, 'workspace_created', 'workspace', workspaceId, { name: normalizedName }, timestamp);
      this.enqueueDelivery(workspaceId, 'workspace.created', 'workspace', workspaceId, { workspaceId }, workspaceId, timestamp);
      this.appendAudit(workspaceId, principal.actorId, membershipId, 'workspace.create', 'workspace', workspaceId, { name: normalizedName }, timestamp);
      return {
        id: workspaceId,
        name: normalizedName,
        revision: 1,
        contextVersion: 1,
        membershipId,
        membershipRole: 'owner',
        createdAt: timestamp,
        updatedAt: timestamp,
      };
    });
  }

  getWorkspace(principal: HumanPrincipal, workspaceId: string): WorkspaceView {
    const row = this.workspaceDatabase.raw
      .prepare(
        `SELECT w.id, w.name, w.revision, w.context_version, w.created_at, w.updated_at,
                m.id AS membership_id, m.membership_role
         FROM workspaces w
         JOIN workspace_memberships m ON m.workspace_id = w.id
         WHERE w.id = ? AND m.actor_id = ? AND m.status = 'active'`,
      )
      .get(workspaceId, principal.actorId) as
      | {
          id: string;
          name: string;
          revision: number;
          context_version: number;
          created_at: number;
          updated_at: number;
          membership_id: string;
          membership_role: 'owner' | 'member';
        }
      | undefined;
    invariant(row, 'WORKSPACE_NOT_FOUND', 'Workspace does not exist or is not accessible.', 404);
    return {
      id: row.id,
      name: row.name,
      revision: row.revision,
      contextVersion: row.context_version,
      membershipId: row.membership_id,
      membershipRole: row.membership_role,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listWorkspaces(principal: HumanPrincipal, cursor?: string, limit = 100): Page<WorkspaceView> {
    const pageCursor = this.requirePageCursor(cursor);
    const pageLimit = this.pageLimit(limit);
    const rows = this.workspaceDatabase.raw
      .prepare(
        `SELECT w.id, w.name, w.revision, w.context_version, w.created_at, w.updated_at,
                m.id AS membership_id, m.membership_role
         FROM workspaces w
         JOIN workspace_memberships m ON m.workspace_id = w.id
         WHERE m.actor_id = ? AND m.status = 'active'
           AND (? IS NULL OR w.created_at > ? OR (w.created_at = ? AND w.id > ?))
         ORDER BY w.created_at, w.id LIMIT ?`,
      )
      .all(
        principal.actorId,
        pageCursor?.createdAt ?? null,
        pageCursor?.createdAt ?? 0,
        pageCursor?.createdAt ?? 0,
        pageCursor?.id ?? '',
        pageLimit + 1,
      ) as unknown as Array<{
        id: string;
        name: string;
        revision: number;
        context_version: number;
        created_at: number;
        updated_at: number;
        membership_id: string;
        membership_role: MembershipRole;
      }>;
    const hasMore = rows.length > pageLimit;
    const items = rows.slice(0, pageLimit).map((row) => this.mapWorkspace(row));
    const last = items.at(-1);
    return { items, nextCursor: hasMore && last ? encodePageCursor(last.createdAt, last.id) : null };
  }

  bootstrapWorkspace(principal: HumanPrincipal, workspaceId: string): WorkspaceBootstrapView {
    return this.workspaceDatabase.transaction(() => {
      const workspace = this.getWorkspace(principal, workspaceId);
      const row = this.workspaceDatabase.raw
        .prepare('SELECT COALESCE(MAX(position), 0) AS position FROM workspace_changes WHERE workspace_id = ?')
        .get(workspaceId) as { position: number };
      return { workspace, changeCursor: row.position };
    });
  }

  updateWorkspace(
    principal: HumanPrincipal,
    workspaceId: string,
    input: { name: string; expectedRevision: number },
    idempotencyKey: string,
  ): WorkspaceView {
    const normalizedName = input.name.trim();
    invariant(normalizedName.length > 0 && normalizedName.length <= 120, 'INVALID_WORKSPACE_NAME', 'Workspace name is required.');
    return this.idempotent(workspaceId, principal.actorId, 'UpdateWorkspace', idempotencyKey, input, () => {
      const membership = this.requireWorkspaceOwner(workspaceId, principal.actorId);
      const timestamp = nowMs();
      const updated = this.workspaceDatabase.raw
        .prepare(
          `UPDATE workspaces
           SET name = ?, revision = revision + 1, context_version = context_version + 1, updated_at = ?
           WHERE id = ? AND revision = ?
           RETURNING revision, context_version`,
        )
        .get(normalizedName, timestamp, workspaceId, input.expectedRevision) as
        | { revision: number; context_version: number }
        | undefined;
      invariant(updated, 'STALE_REVISION', 'Workspace revision changed.', 409);
      this.appendChange(
        workspaceId,
        updated.context_version,
        null,
        null,
        'workspace_updated',
        'workspace',
        workspaceId,
        { name: normalizedName, revision: updated.revision },
        timestamp,
      );
      this.enqueueDelivery(
        workspaceId,
        'workspace.updated',
        'workspace',
        workspaceId,
        { workspaceId, revision: updated.revision },
        `updated:${updated.revision}`,
        timestamp,
      );
      this.appendAudit(workspaceId, principal.actorId, membership.id, 'workspace.update', 'workspace', workspaceId, {
        name: normalizedName,
        revision: updated.revision,
      }, timestamp);
      return this.getWorkspace(principal, workspaceId);
    });
  }

  listWorkspaceMembers(principal: HumanPrincipal, workspaceId: string, cursor?: string, limit = 100): Page<WorkspaceMemberView> {
    this.requireMembership(workspaceId, principal.actorId);
    const pageCursor = this.requirePageCursor(cursor);
    const pageLimit = this.pageLimit(limit);
    const rows = this.workspaceDatabase.raw
      .prepare(
        `SELECT m.id AS membership_id, m.actor_id, a.actor_type,
                COALESCE(h.display_name, ag.name) AS display_name,
                m.membership_role, m.revision, m.joined_at
         FROM workspace_memberships m
         JOIN actors a ON a.id = m.actor_id
         LEFT JOIN humans h ON h.actor_id = m.actor_id
         LEFT JOIN agents ag ON ag.actor_id = m.actor_id
         WHERE m.workspace_id = ? AND m.status = 'active'
           AND (? IS NULL OR m.joined_at > ? OR (m.joined_at = ? AND m.id > ?))
         ORDER BY m.joined_at, m.id LIMIT ?`,
      )
      .all(
        workspaceId,
        pageCursor?.createdAt ?? null,
        pageCursor?.createdAt ?? 0,
        pageCursor?.createdAt ?? 0,
        pageCursor?.id ?? '',
        pageLimit + 1,
      ) as unknown as Array<{
        membership_id: string;
        actor_id: string;
        actor_type: 'human' | 'agent';
        display_name: string;
        membership_role: MembershipRole;
        revision: number;
        joined_at: number;
      }>;
    const hasMore = rows.length > pageLimit;
    const items = rows.slice(0, pageLimit).map((row) => this.mapWorkspaceMember(row));
    const last = rows[Math.min(rows.length, pageLimit) - 1];
    return {
      items,
      nextCursor: hasMore && last ? encodePageCursor(last.joined_at, last.membership_id) : null,
    };
  }

  createProject(
    principal: HumanPrincipal,
    workspaceId: string,
    input: {
      name: string;
      description?: string | null;
      repository?: { cloneUrl: string; defaultBranch: string };
    },
    idempotencyKey: string,
  ): ProjectView {
    const normalizedName = input.name.trim();
    const normalizedDescription = this.normalizeProjectDescription(input.description);
    const repository = input.repository ? normalizeGitCloneUrl(input.repository.cloneUrl) : null;
    const defaultBranch = input.repository ? normalizeDefaultBranch(input.repository.defaultBranch) : null;
    invariant(normalizedName.length > 0 && normalizedName.length <= 120, 'INVALID_PROJECT_NAME', 'Project name is required.');
    const normalizedInput = {
      name: normalizedName,
      description: normalizedDescription,
      repository: repository ? { ...repository, defaultBranch } : null,
    };
    return this.idempotent(workspaceId, principal.actorId, 'CreateProject', idempotencyKey, normalizedInput, () => {
      const creator = this.requireMembership(workspaceId, principal.actorId);
      const projectId = newId();
      const repositoryId = repository ? newId() : null;
      const projectMembershipId = newId();
      const timestamp = nowMs();
      this.workspaceDatabase.raw
        .prepare(
          `INSERT INTO projects (
             id, workspace_id, name, description, created_by_membership_id,
             revision, context_version, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)`,
        )
        .run(projectId, workspaceId, normalizedName, normalizedDescription, creator.id, timestamp, timestamp);
      if (repository && repositoryId && defaultBranch) {
        this.workspaceDatabase.raw
          .prepare(
            `INSERT INTO project_repositories (
               id, workspace_id, project_id, clone_url, repository_identity,
               default_branch, status, revision, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, 'active', 1, ?, ?)`,
          )
          .run(
            repositoryId,
            workspaceId,
            projectId,
            repository.cloneUrl,
            repository.repositoryIdentity,
            defaultBranch,
            timestamp,
            timestamp,
          );
      }
      this.workspaceDatabase.raw
        .prepare(
          `INSERT INTO project_memberships (
             id, workspace_id, project_id, workspace_membership_id, project_role,
             status, revision, joined_at, updated_at
           ) VALUES (?, ?, ?, ?, 'manager', 'active', 1, ?, ?)`,
        )
        .run(projectMembershipId, workspaceId, projectId, creator.id, timestamp, timestamp);
      const workspaceVersion = this.bumpWorkspaceContext(workspaceId, timestamp);
      this.appendChange(
        workspaceId,
        workspaceVersion,
        null,
        null,
        'project_created',
        'project',
        projectId,
        { projectId, name: normalizedName, repositoryId },
        timestamp,
        { projectId, projectVersion: 1 },
      );
      this.enqueueDelivery(
        workspaceId,
        'project.created',
        'project',
        projectId,
        { projectId },
        projectId,
        timestamp,
      );
      this.appendAudit(workspaceId, principal.actorId, creator.id, 'project.create', 'project', projectId, {
        name: normalizedName,
        repositoryId,
        projectMembershipId,
      }, timestamp);
      return this.getProject(principal, projectId);
    });
  }

  getProject(principal: HumanPrincipal, projectId: string): ProjectView {
    const project = this.requireProject(projectId);
    const workspaceMembership = this.requireMembership(project.workspace_id, principal.actorId);
    const projectMembership = this.findProjectMembership(project.workspace_id, projectId, workspaceMembership.id);
    invariant(
      projectMembership || workspaceMembership.membership_role === 'owner',
      'PROJECT_NOT_FOUND',
      'Project does not exist or is not accessible.',
      404,
    );
    return this.mapProject(project, projectMembership ?? null, principal.actorId);
  }

  listProjects(principal: HumanPrincipal, workspaceId: string, cursor?: string, limit = 100): Page<ProjectView> {
    const workspaceMembership = this.requireMembership(workspaceId, principal.actorId);
    const pageCursor = this.requirePageCursor(cursor);
    const pageLimit = this.pageLimit(limit);
    const rows = this.workspaceDatabase.raw
      .prepare(
        `SELECT p.*, pm.id AS project_membership_id, pm.project_role
         FROM projects p
         LEFT JOIN project_memberships pm
           ON pm.workspace_id = p.workspace_id
          AND pm.project_id = p.id
          AND pm.workspace_membership_id = ?
          AND pm.status = 'active'
         WHERE p.workspace_id = ?
           AND (pm.id IS NOT NULL OR ? = 'owner')
           AND (? IS NULL OR p.created_at > ? OR (p.created_at = ? AND p.id > ?))
         ORDER BY p.created_at, p.id LIMIT ?`,
      )
      .all(
        workspaceMembership.id,
        workspaceId,
        workspaceMembership.membership_role,
        pageCursor?.createdAt ?? null,
        pageCursor?.createdAt ?? 0,
        pageCursor?.createdAt ?? 0,
        pageCursor?.id ?? '',
        pageLimit + 1,
      ) as unknown as Array<ProjectRow & { project_membership_id: string | null; project_role: ProjectRole | null }>;
    const hasMore = rows.length > pageLimit;
    const items = rows.slice(0, pageLimit).map((row) => this.mapProject(row, row.project_membership_id ? {
      id: row.project_membership_id,
      workspace_id: row.workspace_id,
      project_id: row.id,
      workspace_membership_id: workspaceMembership.id,
      project_role: row.project_role!,
      status: 'active',
      revision: 1,
      joined_at: row.created_at,
      updated_at: row.updated_at,
      removed_at: null,
    } : null, principal.actorId));
    const last = items.at(-1);
    return { items, nextCursor: hasMore && last ? encodePageCursor(last.createdAt, last.id) : null };
  }

  updateProject(
    principal: HumanPrincipal,
    projectId: string,
    input: { name: string; description?: string | null; expectedRevision: number },
    idempotencyKey: string,
  ): ProjectView {
    const normalizedName = input.name.trim();
    const normalizedDescription = this.normalizeProjectDescription(input.description);
    invariant(normalizedName.length > 0 && normalizedName.length <= 120, 'INVALID_PROJECT_NAME', 'Project name is required.');
    const existing = this.requireProject(projectId);
    return this.idempotent(existing.workspace_id, principal.actorId, 'UpdateProject', idempotencyKey, input, () => {
      const authority = this.requireProjectManagerOrWorkspaceOwner(principal.actorId, projectId);
      const timestamp = nowMs();
      const updated = this.workspaceDatabase.raw
        .prepare(
          `UPDATE projects
           SET name = ?, description = ?, revision = revision + 1,
               context_version = context_version + 1, updated_at = ?
           WHERE id = ? AND revision = ?
           RETURNING revision, context_version`,
        )
        .get(normalizedName, normalizedDescription, timestamp, projectId, input.expectedRevision) as
        | { revision: number; context_version: number }
        | undefined;
      invariant(updated, 'STALE_REVISION', 'Project revision changed.', 409);
      this.appendChange(
        authority.project.workspace_id,
        null,
        null,
        null,
        'project_updated',
        'project',
        projectId,
        { projectId, name: normalizedName, description: normalizedDescription, revision: updated.revision },
        timestamp,
        { projectId, projectVersion: updated.context_version },
      );
      this.appendAudit(
        authority.project.workspace_id,
        principal.actorId,
        authority.workspaceMembership.id,
        'project.update',
        'project',
        projectId,
        { name: normalizedName, description: normalizedDescription, revision: updated.revision },
        timestamp,
      );
      return this.getProject(principal, projectId);
    });
  }

  putProjectRepository(
    principal: HumanPrincipal,
    projectId: string,
    input: {
      cloneUrl: string;
      defaultBranch: string;
      expectedProjectRevision: number;
      expectedRepositoryRevision?: number;
    },
    idempotencyKey: string,
  ): ProjectView {
    const existing = this.requireProject(projectId);
    const repository = normalizeGitCloneUrl(input.cloneUrl);
    const defaultBranch = normalizeDefaultBranch(input.defaultBranch);
    return this.idempotent(existing.workspace_id, principal.actorId, 'PutProjectRepository', idempotencyKey, {
      projectId,
      cloneUrl: repository.cloneUrl,
      defaultBranch,
      expectedProjectRevision: input.expectedProjectRevision,
      expectedRepositoryRevision: input.expectedRepositoryRevision ?? null,
    }, () => {
      const authority = this.requireProjectManagerOrWorkspaceOwner(principal.actorId, projectId);
      const project = this.requireProject(projectId);
      invariant(project.revision === input.expectedProjectRevision, 'STALE_REVISION', 'Project revision changed.', 409);
      const current = this.findActiveProjectRepository(projectId);
      const timestamp = nowMs();
      let repositoryId: string;
      let changeType: string;
      if (current) {
        invariant(
          current.repository_identity === repository.repositoryIdentity,
          'PROJECT_REPOSITORY_IDENTITY_IMMUTABLE',
          'Repository identity cannot be changed in place. Detach it before attaching another Repository.',
          409,
        );
        invariant(
          current.revision === input.expectedRepositoryRevision,
          'STALE_REVISION',
          'Project Repository revision changed.',
          409,
        );
        this.workspaceDatabase.raw.prepare(
          `UPDATE project_repositories
           SET default_branch = ?, revision = revision + 1, updated_at = ?
           WHERE id = ? AND status = 'active'`,
        ).run(defaultBranch, timestamp, current.id);
        repositoryId = current.id;
        changeType = 'project_repository_updated';
      } else {
        repositoryId = newId();
        this.workspaceDatabase.raw.prepare(
          `INSERT INTO project_repositories (
             id, workspace_id, project_id, clone_url, repository_identity,
             default_branch, status, revision, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'active', 1, ?, ?)`,
        ).run(
          repositoryId, project.workspace_id, projectId, repository.cloneUrl,
          repository.repositoryIdentity, defaultBranch, timestamp, timestamp,
        );
        changeType = 'project_repository_attached';
      }
      const updatedProject = this.workspaceDatabase.raw.prepare(
        `UPDATE projects SET revision = revision + 1, context_version = context_version + 1, updated_at = ?
         WHERE id = ? AND revision = ? RETURNING revision, context_version`,
      ).get(timestamp, projectId, input.expectedProjectRevision) as { revision: number; context_version: number } | undefined;
      invariant(updatedProject, 'STALE_REVISION', 'Project revision changed.', 409);
      this.appendChange(
        project.workspace_id, null, null, null, changeType, 'project_repository', repositoryId,
        { projectId, repositoryId, defaultBranch }, timestamp,
        { projectId, projectVersion: updatedProject.context_version },
      );
      this.appendAudit(
        project.workspace_id, principal.actorId, authority.workspaceMembership.id,
        changeType === 'project_repository_attached' ? 'project.repository.attach' : 'project.repository.update',
        'project_repository', repositoryId,
        { projectId, defaultBranch }, timestamp,
      );
      return this.getProject(principal, projectId);
    });
  }

  deleteProjectRepository(
    principal: HumanPrincipal,
    projectId: string,
    input: { expectedProjectRevision: number; expectedRepositoryRevision: number },
    idempotencyKey: string,
  ): ProjectView {
    const existing = this.requireProject(projectId);
    return this.idempotent(existing.workspace_id, principal.actorId, 'DeleteProjectRepository', idempotencyKey, {
      projectId,
      ...input,
    }, () => {
      const authority = this.requireProjectManagerOrWorkspaceOwner(principal.actorId, projectId);
      const project = this.requireProject(projectId);
      invariant(project.revision === input.expectedProjectRevision, 'STALE_REVISION', 'Project revision changed.', 409);
      const repository = this.requireProjectRepository(projectId);
      invariant(repository.revision === input.expectedRepositoryRevision, 'STALE_REVISION', 'Project Repository revision changed.', 409);
      const active = this.workspaceDatabase.raw.prepare(
        `SELECT 1
         FROM attempts a
         JOIN runs r ON r.workspace_id = a.workspace_id AND r.id = a.run_id
         JOIN run_context_snapshots rcs ON rcs.workspace_id = r.workspace_id AND rcs.run_id = r.id
         WHERE r.project_id = ? AND rcs.repository_id = ? AND a.status = 'running'
         LIMIT 1`,
      ).get(projectId, repository.id);
      invariant(!active, 'PROJECT_REPOSITORY_IN_USE', 'Repository cannot be detached while an Attempt is active.', 409);
      const timestamp = nowMs();
      this.workspaceDatabase.raw.prepare(
        `UPDATE project_repositories
         SET status = 'detached', detached_at = ?, revision = revision + 1, updated_at = ?
         WHERE id = ? AND status = 'active'`,
      ).run(timestamp, timestamp, repository.id);
      this.workspaceDatabase.raw.prepare(
        'DELETE FROM computer_project_working_copies WHERE workspace_id = ? AND project_id = ? AND repository_id = ?',
      ).run(project.workspace_id, projectId, repository.id);
      const updatedProject = this.workspaceDatabase.raw.prepare(
        `UPDATE projects SET revision = revision + 1, context_version = context_version + 1, updated_at = ?
         WHERE id = ? AND revision = ? RETURNING revision, context_version`,
      ).get(timestamp, projectId, input.expectedProjectRevision) as { revision: number; context_version: number } | undefined;
      invariant(updatedProject, 'STALE_REVISION', 'Project revision changed.', 409);
      this.appendChange(
        project.workspace_id, null, null, null, 'project_repository_detached', 'project_repository', repository.id,
        { projectId, repositoryId: repository.id }, timestamp,
        { projectId, projectVersion: updatedProject.context_version },
      );
      this.appendAudit(
        project.workspace_id, principal.actorId, authority.workspaceMembership.id,
        'project.repository.detach', 'project_repository', repository.id, { projectId }, timestamp,
      );
      return this.getProject(principal, projectId);
    });
  }

  listProjectResourceLinks(principal: HumanPrincipal, projectId: string): ProjectResourceLinkView[] {
    const access = this.requireProjectAccess(principal.actorId, projectId);
    return (this.workspaceDatabase.raw.prepare(
      'SELECT * FROM project_resource_links WHERE workspace_id = ? AND project_id = ? ORDER BY created_at, id',
    ).all(access.project.workspace_id, projectId) as unknown as Array<Record<string, unknown>>).map((row) => this.mapProjectResourceLink(row));
  }

  createProjectResourceLink(
    principal: HumanPrincipal,
    projectId: string,
    input: { title: string; url: string; description?: string | null },
    idempotencyKey: string,
  ): ProjectResourceLinkView {
    const project = this.requireProject(projectId);
    const normalized = this.normalizeProjectResourceLink(input);
    return this.idempotent(project.workspace_id, principal.actorId, 'CreateProjectResourceLink', idempotencyKey, normalized, () => {
      const access = this.requireProjectAccess(principal.actorId, projectId);
      const id = newId();
      const timestamp = nowMs();
      this.workspaceDatabase.raw.prepare(
        `INSERT INTO project_resource_links (
           id, workspace_id, project_id, title, url, description, revision,
           created_by_membership_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      ).run(
        id, project.workspace_id, projectId, normalized.title, normalized.url,
        normalized.description, access.workspaceMembership.id, timestamp, timestamp,
      );
      const projectVersion = this.bumpProjectContext(projectId, timestamp);
      this.appendChange(project.workspace_id, null, null, null, 'project_resource_link_created', 'project_resource_link', id,
        { projectId, title: normalized.title, url: normalized.url }, timestamp,
        { projectId, projectVersion });
      this.appendAudit(project.workspace_id, principal.actorId, access.workspaceMembership.id,
        'project.resource_link.create', 'project_resource_link', id, { projectId }, timestamp);
      return this.mapProjectResourceLink(this.requireProjectResourceLink(id));
    });
  }

  updateProjectResourceLink(
    principal: HumanPrincipal,
    projectId: string,
    linkId: string,
    input: { title: string; url: string; description?: string | null; expectedRevision: number },
    idempotencyKey: string,
  ): ProjectResourceLinkView {
    const project = this.requireProject(projectId);
    const normalized = this.normalizeProjectResourceLink(input);
    return this.idempotent(project.workspace_id, principal.actorId, 'UpdateProjectResourceLink', idempotencyKey, {
      projectId, linkId, ...normalized, expectedRevision: input.expectedRevision,
    }, () => {
      const access = this.requireProjectAccess(principal.actorId, projectId);
      const link = this.requireProjectResourceLink(linkId);
      invariant(link.project_id === projectId, 'PROJECT_RESOURCE_LINK_NOT_FOUND', 'Resource Link does not exist.', 404);
      invariant(
        link.created_by_membership_id === access.workspaceMembership.id || access.projectMembership.project_role === 'manager',
        'PROJECT_RESOURCE_LINK_FORBIDDEN',
        'Only the creator or a Project Manager may update this Resource Link.',
        403,
      );
      const timestamp = nowMs();
      const updated = this.workspaceDatabase.raw.prepare(
        `UPDATE project_resource_links SET title = ?, url = ?, description = ?,
           revision = revision + 1, updated_at = ?
         WHERE id = ? AND project_id = ? AND revision = ? RETURNING *`,
      ).get(normalized.title, normalized.url, normalized.description, timestamp, linkId, projectId, input.expectedRevision) as
        | Record<string, unknown>
        | undefined;
      invariant(updated, 'STALE_REVISION', 'Resource Link revision changed.', 409);
      const projectVersion = this.bumpProjectContext(projectId, timestamp);
      this.appendChange(project.workspace_id, null, null, null, 'project_resource_link_updated', 'project_resource_link', linkId,
        { projectId, revision: Number(updated.revision) }, timestamp, { projectId, projectVersion });
      this.appendAudit(project.workspace_id, principal.actorId, access.workspaceMembership.id,
        'project.resource_link.update', 'project_resource_link', linkId, { projectId }, timestamp);
      return this.mapProjectResourceLink(updated);
    });
  }

  deleteProjectResourceLink(
    principal: HumanPrincipal,
    projectId: string,
    linkId: string,
    expectedRevision: number,
    idempotencyKey: string,
  ): { id: string; deletedAt: number } {
    const project = this.requireProject(projectId);
    return this.idempotent(project.workspace_id, principal.actorId, 'DeleteProjectResourceLink', idempotencyKey, {
      projectId, linkId, expectedRevision,
    }, () => {
      const access = this.requireProjectAccess(principal.actorId, projectId);
      const link = this.requireProjectResourceLink(linkId);
      invariant(link.project_id === projectId, 'PROJECT_RESOURCE_LINK_NOT_FOUND', 'Resource Link does not exist.', 404);
      invariant(
        link.created_by_membership_id === access.workspaceMembership.id || access.projectMembership.project_role === 'manager',
        'PROJECT_RESOURCE_LINK_FORBIDDEN',
        'Only the creator or a Project Manager may delete this Resource Link.',
        403,
      );
      const timestamp = nowMs();
      const deleted = this.workspaceDatabase.raw.prepare(
        'DELETE FROM project_resource_links WHERE id = ? AND project_id = ? AND revision = ?',
      ).run(linkId, projectId, expectedRevision);
      invariant(deleted.changes === 1, 'STALE_REVISION', 'Resource Link revision changed.', 409);
      const projectVersion = this.bumpProjectContext(projectId, timestamp);
      this.appendChange(project.workspace_id, null, null, null, 'project_resource_link_deleted', 'project_resource_link', linkId,
        { projectId }, timestamp, { projectId, projectVersion });
      this.appendAudit(project.workspace_id, principal.actorId, access.workspaceMembership.id,
        'project.resource_link.delete', 'project_resource_link', linkId, { projectId }, timestamp);
      return { id: linkId, deletedAt: timestamp };
    });
  }

  createProjectFromComputer(
    principal: ComputerPrincipal,
    input: {
      workspaceId: string;
      name: string;
      description?: string | null;
      repository: { cloneUrl: string; repositoryIdentity: string; defaultBranch: string };
      workingCopy: Omit<ProjectWorkingCopyReport, 'repositoryId'>;
    },
    idempotencyKey: string,
  ): ProjectView {
    const normalizedRepository = normalizeGitCloneUrl(input.repository.cloneUrl);
    invariant(normalizedRepository.repositoryIdentity === input.repository.repositoryIdentity,
      'PROJECT_REPOSITORY_MISMATCH', 'Reported Repository identity does not match its clone URL.');
    const humanPrincipal: HumanPrincipal = { kind: 'human', actorId: principal.ownerHumanId };
    const created = this.createProject(humanPrincipal, input.workspaceId, {
      name: input.name,
      ...(input.description === undefined ? {} : { description: input.description }),
      repository: {
        cloneUrl: normalizedRepository.cloneUrl,
        defaultBranch: input.repository.defaultBranch,
      },
    }, idempotencyKey);
    invariant(created.repository, 'PROJECT_REPOSITORY_NOT_FOUND', 'Created Project Repository is unavailable.');
    this.reportProjectWorkingCopy(principal, created.id, {
      ...input.workingCopy,
      repositoryId: created.repository.id,
      repositoryIdentity: normalizedRepository.repositoryIdentity,
    }, `${idempotencyKey}:working-copy`);
    return this.getProject(humanPrincipal, created.id);
  }

  getComputerProjectRepository(principal: ComputerPrincipal, projectId: string): {
    projectId: string;
    workspaceId: string;
    repository: ProjectRepositoryView;
  } {
    const project = this.requireProject(projectId);
    this.requireProjectAccess(principal.ownerHumanId, projectId);
    this.requireOwnedComputer(principal);
    return {
      projectId,
      workspaceId: project.workspace_id,
      repository: this.mapProjectRepository(this.requireProjectRepository(project.id)),
    };
  }

  listProjectWorkingCopies(principal: HumanPrincipal, projectId: string): ProjectWorkingCopyView[] {
    const access = this.requireProjectAccess(principal.actorId, projectId);
    return (this.workspaceDatabase.raw
      .prepare(
        `SELECT wc.computer_id, computer.name AS computer_name, computer.status AS computer_status,
                computer.last_seen_at, wc.availability, wc.branch, wc.head_commit, wc.dirty, wc.checked_at
         FROM computer_project_working_copies wc
         JOIN computers computer ON computer.id = wc.computer_id
         WHERE wc.workspace_id = ? AND wc.project_id = ? AND computer.owner_human_id = ?
         ORDER BY computer.created_at, computer.id`,
      )
      .all(access.project.workspace_id, projectId, principal.actorId) as Array<{
        computer_id: string;
        computer_name: string;
        computer_status: 'active' | 'disabled';
        last_seen_at: number | null;
        availability: ProjectWorkingCopyView['availability'];
        branch: string | null;
        head_commit: string | null;
        dirty: number | null;
        checked_at: number;
      }>).map((row) => this.mapProjectWorkingCopy(row));
  }

  reportProjectWorkingCopy(
    principal: ComputerPrincipal,
    projectId: string,
    report: ProjectWorkingCopyReport,
    idempotencyKey: string,
  ): ProjectWorkingCopyView {
    const project = this.requireProject(projectId);
    this.requireProjectAccess(principal.ownerHumanId, projectId);
    this.requireOwnedComputer(principal);
    const repository = this.requireProjectRepository(projectId);
    invariant(report.repositoryId === repository.id,
      'PROJECT_REPOSITORY_MISMATCH', 'Working Copy Repository does not match this Project.', 409);
    const availability = report.repositoryIdentity === repository.repository_identity
      ? report.availability
      : 'mismatch';
    const ready = availability === 'ready';
    invariant(!ready || (
      report.branch !== null
      && report.branch.trim().length > 0
      && report.branch.length <= 255
      && report.headCommit !== null
      && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(report.headCommit)
      && report.dirty !== null
    ), 'INVALID_WORKING_COPY_REPORT', 'Ready Working Copy reports require branch, HEAD commit, and dirty state.');
    const normalizedReport = {
      repositoryId: repository.id,
      repositoryIdentity: report.repositoryIdentity,
      availability,
      branch: ready ? report.branch!.trim() : null,
      headCommit: ready ? report.headCommit : null,
      dirty: ready ? report.dirty : null,
    } satisfies ProjectWorkingCopyReport;
    return this.idempotent(project.workspace_id, principal.ownerHumanId, 'ReportProjectWorkingCopy', idempotencyKey,
      { computerId: principal.computerId, projectId, ...normalizedReport }, () => {
        const prior = this.workspaceDatabase.raw
          .prepare('SELECT * FROM computer_project_working_copies WHERE computer_id = ? AND project_id = ?')
          .get(principal.computerId, projectId) as Record<string, unknown> | undefined;
        const timestamp = nowMs();
        this.workspaceDatabase.raw
          .prepare(
            `INSERT INTO computer_project_working_copies (
               computer_id, workspace_id, project_id, repository_id, availability,
               branch, head_commit, dirty, checked_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(computer_id, project_id) DO UPDATE SET
               repository_id = excluded.repository_id,
               availability = excluded.availability,
               branch = excluded.branch,
               head_commit = excluded.head_commit,
               dirty = excluded.dirty,
               checked_at = excluded.checked_at,
               updated_at = excluded.updated_at`,
          )
          .run(
            principal.computerId,
            project.workspace_id,
            projectId,
            repository.id,
            normalizedReport.availability,
            normalizedReport.branch,
            normalizedReport.headCommit,
            normalizedReport.dirty === null ? null : Number(normalizedReport.dirty),
            timestamp,
            timestamp,
          );
        const semanticChanged = !prior
          || prior.availability !== normalizedReport.availability
          || prior.branch !== normalizedReport.branch
          || prior.head_commit !== normalizedReport.headCommit
          || (prior.dirty === null ? null : Boolean(prior.dirty)) !== normalizedReport.dirty;
        if (semanticChanged) {
          this.appendChange(
            project.workspace_id,
            null,
            null,
            null,
            prior ? 'project_working_copy_updated' : 'project_working_copy_connected',
            'project_working_copy',
            `${principal.computerId}:${projectId}`,
            { projectId, computerId: principal.computerId, availability: normalizedReport.availability },
            timestamp,
            { projectId, projectVersion: project.context_version },
          );
        }
        return this.requireProjectWorkingCopyView(principal.computerId, projectId);
      });
  }

  removeProjectWorkingCopy(
    principal: ComputerPrincipal,
    projectId: string,
    idempotencyKey: string,
  ): { projectId: string; computerId: string; removedAt: number } {
    const project = this.requireProject(projectId);
    this.requireProjectAccess(principal.ownerHumanId, projectId);
    this.requireOwnedComputer(principal);
    return this.idempotent(project.workspace_id, principal.ownerHumanId, 'RemoveProjectWorkingCopy', idempotencyKey,
      { computerId: principal.computerId, projectId }, () => {
        const timestamp = nowMs();
        const removed = this.workspaceDatabase.raw
          .prepare('DELETE FROM computer_project_working_copies WHERE computer_id = ? AND project_id = ?')
          .run(principal.computerId, projectId);
        invariant(removed.changes === 1, 'PROJECT_WORKING_COPY_NOT_FOUND', 'Working Copy connection does not exist.', 404);
        this.appendChange(
          project.workspace_id,
          null,
          null,
          null,
          'project_working_copy_disconnected',
          'project_working_copy',
          `${principal.computerId}:${projectId}`,
          { projectId, computerId: principal.computerId },
          timestamp,
          { projectId, projectVersion: project.context_version },
        );
        return { projectId, computerId: principal.computerId, removedAt: timestamp };
      });
  }

  listProjectMembers(principal: HumanPrincipal, projectId: string, cursor?: string, limit = 100): Page<ProjectMemberView> {
    const access = this.requireProjectAccess(principal.actorId, projectId);
    const pageCursor = this.requirePageCursor(cursor);
    const pageLimit = this.pageLimit(limit);
    const rows = this.workspaceDatabase.raw
      .prepare(
        `SELECT pm.id AS project_membership_id, pm.workspace_membership_id,
                wm.actor_id, a.actor_type, COALESCE(h.display_name, ag.name) AS display_name,
                pm.project_role, pm.revision, pm.joined_at
         FROM project_memberships pm
         JOIN workspace_memberships wm
           ON wm.workspace_id = pm.workspace_id
          AND wm.id = pm.workspace_membership_id
          AND wm.status = 'active'
         JOIN actors a ON a.id = wm.actor_id
         LEFT JOIN humans h ON h.actor_id = wm.actor_id
         LEFT JOIN agents ag ON ag.workspace_id = wm.workspace_id AND ag.actor_id = wm.actor_id
         WHERE pm.workspace_id = ? AND pm.project_id = ? AND pm.status = 'active'
           AND (? IS NULL OR pm.joined_at > ? OR (pm.joined_at = ? AND pm.id > ?))
         ORDER BY pm.joined_at, pm.id LIMIT ?`,
      )
      .all(
        access.project.workspace_id,
        projectId,
        pageCursor?.createdAt ?? null,
        pageCursor?.createdAt ?? 0,
        pageCursor?.createdAt ?? 0,
        pageCursor?.id ?? '',
        pageLimit + 1,
      ) as unknown as Array<{
        project_membership_id: string;
        workspace_membership_id: string;
        actor_id: string;
        actor_type: 'human' | 'agent';
        display_name: string;
        project_role: ProjectRole;
        revision: number;
        joined_at: number;
      }>;
    const hasMore = rows.length > pageLimit;
    const items = rows.slice(0, pageLimit).map((row) => this.mapProjectMember(row));
    const last = items.at(-1);
    return { items, nextCursor: hasMore && last ? encodePageCursor(last.joinedAt, last.projectMembershipId) : null };
  }

  addProjectMember(
    principal: HumanPrincipal,
    projectId: string,
    input: { workspaceMembershipId: string; role: ProjectRole },
    idempotencyKey: string,
  ): ProjectMemberView {
    const project = this.requireProject(projectId);
    return this.idempotent(project.workspace_id, principal.actorId, 'AddProjectMember', idempotencyKey, input, () => {
      const authority = this.requireProjectManagerOrWorkspaceOwner(principal.actorId, projectId);
      const target = this.requireActiveWorkspaceMember(project.workspace_id, input.workspaceMembershipId);
      if (target.actorType === 'agent') {
        invariant(input.role === 'member', 'AGENT_PROJECT_ROLE_INVALID', 'An Agent can only be a Project member.');
      }
      invariant(
        !this.findProjectMembership(project.workspace_id, projectId, input.workspaceMembershipId),
        'PROJECT_MEMBERSHIP_ALREADY_ACTIVE',
        'Workspace Membership is already active in this Project.',
        409,
      );
      const projectMembershipId = newId();
      const timestamp = nowMs();
      this.workspaceDatabase.raw
        .prepare(
          `INSERT INTO project_memberships (
             id, workspace_id, project_id, workspace_membership_id, project_role,
             status, revision, joined_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'active', 1, ?, ?)`,
        )
        .run(projectMembershipId, project.workspace_id, projectId, input.workspaceMembershipId, input.role, timestamp, timestamp);
      const projectVersion = this.bumpProjectContext(projectId, timestamp);
      this.appendChange(
        project.workspace_id,
        null,
        null,
        null,
        'project_member_added',
        'project_membership',
        projectMembershipId,
        { projectMembershipId, workspaceMembershipId: input.workspaceMembershipId, role: input.role },
        timestamp,
        { projectId, projectVersion },
      );
      this.appendAudit(
        project.workspace_id,
        principal.actorId,
        authority.workspaceMembership.id,
        'project.member.add',
        'project_membership',
        projectMembershipId,
        { projectId, workspaceMembershipId: input.workspaceMembershipId, role: input.role },
        timestamp,
      );
      return this.getProjectMember(project.workspace_id, projectId, projectMembershipId);
    });
  }

  updateProjectMember(
    principal: HumanPrincipal,
    projectId: string,
    projectMembershipId: string,
    input: { role: ProjectRole; expectedRevision: number },
    idempotencyKey: string,
  ): ProjectMemberView {
    const project = this.requireProject(projectId);
    return this.idempotent(project.workspace_id, principal.actorId, 'UpdateProjectMember', idempotencyKey, input, () => {
      const authority = this.requireProjectManagerOrWorkspaceOwner(principal.actorId, projectId);
      const target = this.requireProjectMembership(project.workspace_id, projectId, projectMembershipId);
      const workspaceMember = this.requireActiveWorkspaceMember(project.workspace_id, target.workspace_membership_id);
      if (workspaceMember.actorType === 'agent') {
        invariant(input.role === 'member', 'AGENT_PROJECT_ROLE_INVALID', 'An Agent can only be a Project member.');
      }
      const timestamp = nowMs();
      const updated = this.workspaceDatabase.raw
        .prepare(
          `UPDATE project_memberships
           SET project_role = ?, revision = revision + 1, updated_at = ?
           WHERE workspace_id = ? AND project_id = ? AND id = ? AND status = 'active' AND revision = ?
           RETURNING revision`,
        )
        .get(input.role, timestamp, project.workspace_id, projectId, projectMembershipId, input.expectedRevision) as
        | { revision: number }
        | undefined;
      invariant(updated, 'STALE_REVISION', 'Project Membership revision changed.', 409);
      const projectVersion = this.bumpProjectContext(projectId, timestamp);
      this.appendChange(
        project.workspace_id,
        null,
        null,
        null,
        'project_member_updated',
        'project_membership',
        projectMembershipId,
        { projectMembershipId, role: input.role, revision: updated.revision },
        timestamp,
        { projectId, projectVersion },
      );
      this.appendAudit(
        project.workspace_id,
        principal.actorId,
        authority.workspaceMembership.id,
        'project.member.update',
        'project_membership',
        projectMembershipId,
        { projectId, role: input.role, revision: updated.revision },
        timestamp,
      );
      return this.getProjectMember(project.workspace_id, projectId, projectMembershipId);
    });
  }

  removeProjectMember(
    principal: HumanPrincipal,
    projectId: string,
    projectMembershipId: string,
    expectedRevision: number,
    idempotencyKey: string,
  ): { projectMembershipId: string; revision: number; removedAt: number; cancelledAgentRequestIds: string[] } {
    const project = this.requireProject(projectId);
    return this.idempotent(
      project.workspace_id,
      principal.actorId,
      'RemoveProjectMember',
      idempotencyKey,
      { projectMembershipId, expectedRevision },
      () => {
        const authority = this.requireProjectManagerOrWorkspaceOwner(principal.actorId, projectId);
        const target = this.requireProjectMembership(project.workspace_id, projectId, projectMembershipId);
        invariant(
          target.workspace_membership_id !== authority.workspaceMembership.id,
          'USE_LEAVE_PROJECT',
          'Use the leave command to remove your own Project Membership.',
          409,
        );
        return this.removeProjectMembership(
          project,
          target,
          expectedRevision,
          principal.actorId,
          authority.workspaceMembership.id,
          'project.member.remove',
        );
      },
    );
  }

  leaveProject(
    principal: HumanPrincipal,
    projectId: string,
    expectedRevision: number,
    idempotencyKey: string,
  ): { projectMembershipId: string; revision: number; removedAt: number; cancelledAgentRequestIds: string[] } {
    const project = this.requireProject(projectId);
    return this.idempotent(project.workspace_id, principal.actorId, 'LeaveProject', idempotencyKey, { expectedRevision }, () => {
      const access = this.requireProjectAccess(principal.actorId, projectId);
      return this.removeProjectMembership(
        project,
        access.projectMembership,
        expectedRevision,
        principal.actorId,
        access.workspaceMembership.id,
        'project.member.leave',
      );
    });
  }

  createInvitation(
    principal: HumanPrincipal,
    workspaceId: string,
    input: { verifiedEmail: string; membershipRole: MembershipRole },
    idempotencyKey: string,
  ): WorkspaceInvitationView {
    const verifiedEmail = this.normalizeEmail(input.verifiedEmail);
    return this.idempotent(workspaceId, principal.actorId, 'CreateInvitation', idempotencyKey, {
      ...input,
      verifiedEmail,
    }, () => {
      const inviter = this.requireWorkspaceOwner(workspaceId, principal.actorId);
      const active = this.workspaceDatabase.raw
        .prepare(
          `SELECT 1
           FROM humans h
           JOIN workspace_memberships m ON m.actor_id = h.actor_id
           WHERE h.verified_email = ? AND m.workspace_id = ? AND m.status = 'active'`,
        )
        .get(verifiedEmail, workspaceId);
      invariant(!active, 'MEMBERSHIP_ALREADY_ACTIVE', 'The invited Human is already an active Workspace member.', 409);
      const invitationId = newId();
      const timestamp = nowMs();
      this.workspaceDatabase.raw
        .prepare(
          `INSERT INTO workspace_invitations (
             id, workspace_id, verified_email, membership_role,
             status, revision, invited_by_membership_id, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'pending', 1, ?, ?, ?)`,
        )
        .run(
          invitationId,
          workspaceId,
          verifiedEmail,
          input.membershipRole,
          inviter.id,
          timestamp,
          timestamp,
        );
      this.appendChange(
        workspaceId,
        null,
        null,
        null,
        'invitation_created',
        'workspace_invitation',
        invitationId,
        { invitationId },
        timestamp,
        { recipientMembershipIds: this.listWorkspaceOwnerMembershipIds(workspaceId) },
      );
      this.enqueueDelivery(
        workspaceId,
        'workspace.invitation-created',
        'workspace_invitation',
        invitationId,
        { invitationId },
        invitationId,
        timestamp,
      );
      this.appendAudit(workspaceId, principal.actorId, inviter.id, 'workspace.invitation.create', 'workspace_invitation', invitationId, {
        verifiedEmail,
        membershipRole: input.membershipRole,
      }, timestamp);
      return this.mapInvitation(this.requireInvitation(invitationId));
    });
  }

  listInvitations(principal: HumanPrincipal, workspaceId: string, cursor?: string, limit = 100): Page<WorkspaceInvitationView> {
    this.requireWorkspaceOwner(workspaceId, principal.actorId);
    const pageCursor = this.requirePageCursor(cursor);
    const pageLimit = this.pageLimit(limit);
    const rows = this.workspaceDatabase.raw
      .prepare(
        `SELECT * FROM workspace_invitations
         WHERE workspace_id = ?
           AND (? IS NULL OR created_at > ? OR (created_at = ? AND id > ?))
         ORDER BY created_at, id LIMIT ?`,
      )
      .all(
        workspaceId,
        pageCursor?.createdAt ?? null,
        pageCursor?.createdAt ?? 0,
        pageCursor?.createdAt ?? 0,
        pageCursor?.id ?? '',
        pageLimit + 1,
      ) as unknown as InvitationRow[];
    const hasMore = rows.length > pageLimit;
    const items = rows.slice(0, pageLimit).map((row) => this.mapInvitation(row));
    const last = items.at(-1);
    return { items, nextCursor: hasMore && last ? encodePageCursor(last.createdAt, last.id) : null };
  }

  acceptInvitation(
    principal: HumanPrincipal,
    invitationId: string,
    expectedRevision: number,
    idempotencyKey: string,
  ): WorkspaceMemberView {
    const human = this.workspaceDatabase.raw
      .prepare("SELECT verified_email FROM humans WHERE actor_id = ? AND status = 'active'")
      .get(principal.actorId) as { verified_email: string } | undefined;
    invariant(human, 'HUMAN_NOT_FOUND', 'Human identity is not active.', 403);
    const invitation = this.workspaceDatabase.raw
      .prepare("SELECT * FROM workspace_invitations WHERE id = ? AND verified_email = ?")
      .get(invitationId, human.verified_email) as InvitationRow | undefined;
    invariant(invitation, 'INVITATION_NOT_FOUND', 'Invitation does not exist or is not addressed to this Human.', 404);
    return this.idempotent(invitation.workspace_id, principal.actorId, 'AcceptInvitation', idempotencyKey, { expectedRevision }, () => {
      const current = this.requireInvitation(invitationId);
      invariant(current.verified_email === human.verified_email, 'INVITATION_NOT_FOUND', 'Invitation does not exist or is not addressed to this Human.', 404);
      invariant(current.status === 'pending', 'INVITATION_NOT_PENDING', 'Invitation is no longer pending.', 409);
      const active = this.workspaceDatabase.raw
        .prepare("SELECT 1 FROM workspace_memberships WHERE workspace_id = ? AND actor_id = ? AND status = 'active'")
        .get(current.workspace_id, principal.actorId);
      invariant(!active, 'MEMBERSHIP_ALREADY_ACTIVE', 'Human already has an active Membership in this Workspace.', 409);
      const membershipId = newId();
      const timestamp = nowMs();
      this.workspaceDatabase.raw
        .prepare(
          `INSERT INTO workspace_memberships (
             id, workspace_id, actor_id, membership_role,
             status, revision, joined_at, updated_at
           ) VALUES (?, ?, ?, ?, 'active', 1, ?, ?)`,
        )
        .run(
          membershipId,
          current.workspace_id,
          principal.actorId,
          current.membership_role,
          timestamp,
          timestamp,
        );
      const accepted = this.workspaceDatabase.raw
        .prepare(
          `UPDATE workspace_invitations
           SET status = 'accepted', revision = revision + 1, accepted_by_human_id = ?,
               accepted_membership_id = ?, updated_at = ?, terminal_at = ?
           WHERE id = ? AND status = 'pending' AND revision = ?`,
        )
        .run(principal.actorId, membershipId, timestamp, timestamp, invitationId, expectedRevision);
      invariant(accepted.changes === 1, 'STALE_REVISION', 'Invitation revision or status changed.', 409);
      const contextVersion = this.bumpWorkspaceContext(current.workspace_id, timestamp);
      this.appendChange(
        current.workspace_id,
        contextVersion,
        null,
        null,
        'workspace_member_joined',
        'workspace_membership',
        membershipId,
        { membershipId },
        timestamp,
      );
      this.enqueueDelivery(
        current.workspace_id,
        'workspace.member-joined',
        'workspace_membership',
        membershipId,
        { membershipId },
        membershipId,
        timestamp,
      );
      this.appendAudit(current.workspace_id, principal.actorId, membershipId, 'workspace.invitation.accept', 'workspace_invitation', invitationId, {
        membershipId,
      }, timestamp);
      return this.getWorkspaceMember(current.workspace_id, membershipId);
    });
  }

  revokeInvitation(
    principal: HumanPrincipal,
    invitationId: string,
    expectedRevision: number,
    idempotencyKey: string,
  ): WorkspaceInvitationView {
    const invitation = this.requireInvitation(invitationId);
    return this.idempotent(invitation.workspace_id, principal.actorId, 'RevokeInvitation', idempotencyKey, { expectedRevision }, () => {
      const membership = this.requireWorkspaceOwner(invitation.workspace_id, principal.actorId);
      const timestamp = nowMs();
      const updated = this.workspaceDatabase.raw
        .prepare(
          `UPDATE workspace_invitations
           SET status = 'revoked', revision = revision + 1, updated_at = ?, terminal_at = ?
           WHERE id = ? AND status = 'pending' AND revision = ?`,
        )
        .run(timestamp, timestamp, invitationId, expectedRevision);
      invariant(updated.changes === 1, 'STALE_REVISION', 'Invitation revision or status changed.', 409);
      this.appendChange(
        invitation.workspace_id,
        null,
        null,
        null,
        'invitation_revoked',
        'workspace_invitation',
        invitationId,
        { invitationId },
        timestamp,
        { recipientMembershipIds: this.listWorkspaceOwnerMembershipIds(invitation.workspace_id) },
      );
      this.enqueueDelivery(
        invitation.workspace_id,
        'workspace.invitation-revoked',
        'workspace_invitation',
        invitationId,
        { invitationId },
        `revoked:${invitationId}:${expectedRevision}`,
        timestamp,
      );
      this.appendAudit(invitation.workspace_id, principal.actorId, membership.id, 'workspace.invitation.revoke', 'workspace_invitation', invitationId, {}, timestamp);
      return this.mapInvitation(this.requireInvitation(invitationId));
    });
  }

  updateWorkspaceMember(
    principal: HumanPrincipal,
    workspaceId: string,
    membershipId: string,
    input: { membershipRole: MembershipRole; expectedRevision: number },
    idempotencyKey: string,
  ): WorkspaceMemberView {
    return this.idempotent(workspaceId, principal.actorId, 'UpdateWorkspaceMember', idempotencyKey, input, () => {
      const caller = this.requireWorkspaceOwner(workspaceId, principal.actorId);
      const target = this.requireHumanMembership(workspaceId, membershipId);
      const timestamp = nowMs();
      const updated = this.workspaceDatabase.raw
        .prepare(
          `UPDATE workspace_memberships
           SET membership_role = ?, revision = revision + 1, updated_at = ?
           WHERE workspace_id = ? AND id = ? AND status = 'active' AND revision = ?
           RETURNING revision`,
        )
        .get(
          input.membershipRole,
          timestamp,
          workspaceId,
          membershipId,
          input.expectedRevision,
        ) as { revision: number } | undefined;
      invariant(updated, 'STALE_REVISION', 'Membership revision changed.', 409);
      const contextVersion = this.bumpWorkspaceContext(workspaceId, timestamp);
      this.appendChange(workspaceId, contextVersion, null, null, 'workspace_member_updated', 'workspace_membership', membershipId, {
        membershipId,
        membershipRole: input.membershipRole,
        revision: updated.revision,
      }, timestamp);
      this.enqueueDelivery(
        workspaceId,
        'workspace.member-updated',
        'workspace_membership',
        membershipId,
        { membershipId, revision: updated.revision },
        `updated:${membershipId}:${updated.revision}`,
        timestamp,
      );
      this.appendAudit(workspaceId, principal.actorId, caller.id, 'workspace.member.update', 'workspace_membership', membershipId, {
        actorId: target.actor_id,
        membershipRole: input.membershipRole,
        revision: updated.revision,
      }, timestamp);
      return this.getWorkspaceMember(workspaceId, membershipId);
    });
  }

  removeWorkspaceMember(
    principal: HumanPrincipal,
    workspaceId: string,
    membershipId: string,
    expectedRevision: number,
    idempotencyKey: string,
  ): { membershipId: string; revision: number; removedAt: number } {
    return this.idempotent(workspaceId, principal.actorId, 'RemoveWorkspaceMember', idempotencyKey, { membershipId, expectedRevision }, () => {
      const caller = this.requireWorkspaceOwner(workspaceId, principal.actorId);
      const target = this.requireHumanMembership(workspaceId, membershipId);
      invariant(target.actor_id !== principal.actorId, 'USE_LEAVE_WORKSPACE', 'Use the leave command to remove your own Membership.', 409);
      return this.removeHumanMembership(workspaceId, membershipId, expectedRevision, principal.actorId, caller.id, target.actor_id, 'workspace.member.remove');
    });
  }

  leaveWorkspace(
    principal: HumanPrincipal,
    workspaceId: string,
    expectedRevision: number,
    idempotencyKey: string,
  ): { membershipId: string; revision: number; removedAt: number } {
    return this.idempotent(workspaceId, principal.actorId, 'LeaveWorkspace', idempotencyKey, { expectedRevision }, () => {
      const membership = this.requireMembership(workspaceId, principal.actorId);
      this.requireHumanMembership(workspaceId, membership.id);
      return this.removeHumanMembership(workspaceId, membership.id, expectedRevision, principal.actorId, membership.id, principal.actorId, 'workspace.member.leave');
    });
  }

  transferAgentOwnership(
    principal: HumanPrincipal,
    workspaceId: string,
    agentId: string,
    input: { newOwnerMembershipId: string; expectedRevision: number },
    idempotencyKey: string,
  ): AgentView {
    return this.idempotent(workspaceId, principal.actorId, 'TransferAgentOwnership', idempotencyKey, input, () => {
      const caller = this.requireWorkspaceOwner(workspaceId, principal.actorId);
      this.performAgentOwnershipTransfer(
        workspaceId,
        agentId,
        input.newOwnerMembershipId,
        input.expectedRevision,
        principal.actorId,
        caller.id,
      );
      return this.mapAgent(this.requireAgentRow(workspaceId, agentId));
    });
  }

  createAgent(
    principal: HumanPrincipal,
    workspaceId: string,
    input: {
      name: string;
      description?: string;
      runtimeBinding?: RuntimeBindingInput;
    },
    idempotencyKey: string,
  ): AgentView {
    const normalizedName = input.name.trim();
    invariant(normalizedName.length > 0 && normalizedName.length <= 120, 'INVALID_AGENT_NAME', 'Agent name is required.');
    return this.idempotent(workspaceId, principal.actorId, 'CreateAgent', idempotencyKey, input, () => {
      const ownerMembership = this.requireMembership(workspaceId, principal.actorId);
      const agentId = newId();
      const membershipId = newId();
      const timestamp = nowMs();
      this.workspaceDatabase.raw.prepare("INSERT INTO actors (id, actor_type, created_at) VALUES (?, 'agent', ?)").run(agentId, timestamp);
      this.workspaceDatabase.raw
        .prepare(
          `INSERT INTO agents (
             actor_id, workspace_id, created_by_human_id, owner_membership_id,
             name, description, lifecycle_status,
             revision, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'active', 1, ?, ?)`,
        )
        .run(
          agentId,
          workspaceId,
          principal.actorId,
          ownerMembership.id,
          normalizedName,
          input.description?.trim() || null,
          timestamp,
          timestamp,
        );
      this.workspaceDatabase.raw
        .prepare(
          `INSERT INTO workspace_memberships (
             id, workspace_id, actor_id, membership_role, status, revision, joined_at, updated_at
           ) VALUES (?, ?, ?, 'member', 'active', 1, ?, ?)`,
        )
        .run(membershipId, workspaceId, agentId, timestamp, timestamp);
      this.workspaceDatabase.raw
        .prepare(
          `INSERT INTO agent_ownership_history (
             id, workspace_id, agent_id, owner_membership_id, started_at
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(newId(), workspaceId, agentId, ownerMembership.id, timestamp);
      const policyVersionId = newId();
      this.insertExecutionPolicy(
        policyVersionId,
        workspaceId,
        agentId,
        1,
        ownerMembership.id,
        DEFAULT_EXECUTION_POLICY,
        timestamp,
      );
      if (input.runtimeBinding) {
        this.insertRuntimeBinding(principal.actorId, workspaceId, agentId, input.runtimeBinding, timestamp);
      }
      const version = this.bumpWorkspaceContext(workspaceId, timestamp);
      this.appendChange(workspaceId, version, null, null, 'agent_created', 'agent', agentId, {
        name: normalizedName,
        runtimeId: input.runtimeBinding?.runtimeId ?? null,
      }, timestamp);
      this.enqueueDelivery(workspaceId, 'agent.created', 'agent', agentId, { agentId }, agentId, timestamp);
      this.appendAudit(workspaceId, principal.actorId, ownerMembership.id, 'agent.create', 'agent', agentId, {
        computerId: input.runtimeBinding?.computerId ?? null,
        runtimeId: input.runtimeBinding?.runtimeId ?? null,
      }, timestamp);
      return this.mapAgent(this.requireAgentRow(workspaceId, agentId));
    });
  }

  getAgent(principal: HumanPrincipal, workspaceId: string, agentId: string): AgentView {
    const membership = this.requireMembership(workspaceId, principal.actorId);
    const agent = this.requireAgentIdentityRow(workspaceId, agentId);
    invariant(
      agent.membership_status === 'active'
      || membership.membership_role === 'owner'
      || membership.id === agent.owner_membership_id,
      'AGENT_NOT_FOUND',
      'Agent does not exist.',
      404,
    );
    return this.mapAgent(agent);
  }

  getAgentRuntimeSkills(
    principal: HumanPrincipal,
    workspaceId: string,
    agentId: string,
  ): AgentRuntimeSkillsView {
    this.requireMembership(workspaceId, principal.actorId);
    this.requireAgentRow(workspaceId, agentId);
    const row = this.workspaceDatabase.raw
      .prepare(
        `SELECT b.computer_id, b.runtime_id, b.binding_revision,
                c.runtime_catalog_revision, rc.availability, rc.skills_json
         FROM agent_runtime_bindings b
         JOIN computers c ON c.id = b.computer_id
         JOIN computer_runtime_capabilities rc
           ON rc.computer_id = b.computer_id AND rc.runtime_id = b.runtime_id
         WHERE b.workspace_id = ? AND b.agent_id = ? AND b.status = 'active'`,
      )
      .get(workspaceId, agentId) as {
        computer_id: string;
        runtime_id: RuntimeId;
        binding_revision: number;
        runtime_catalog_revision: number;
        availability: AgentRuntimeSkillsView['runtimeAvailability'];
        skills_json: string;
      } | undefined;
    invariant(row, 'RUNTIME_BINDING_NOT_FOUND', 'Agent has no active Runtime Binding.', 404);
    const skills = JSON.parse(row.skills_json) as ComputerView['runtimes'][number]['skills'];
    return {
      agentId,
      computerId: row.computer_id,
      runtimeId: row.runtime_id,
      runtimeAvailability: row.availability,
      bindingRevision: row.binding_revision,
      runtimeCatalogRevision: row.runtime_catalog_revision,
      items: [...skills.global, ...skills.workspace],
    };
  }

  listAgents(principal: HumanPrincipal, workspaceId: string, cursor?: string, limit = 100): Page<AgentView> {
    const observer = this.requireMembership(workspaceId, principal.actorId);
    const pageCursor = this.requirePageCursor(cursor);
    const pageLimit = this.pageLimit(limit);
    const rows = this.workspaceDatabase.raw
      .prepare(
        `SELECT a.*, m.id AS membership_id, m.status AS membership_status,
                owner.actor_id AS owner_human_id, h.display_name AS owner_display_name
         FROM agents a
         JOIN workspace_memberships m
           ON m.id = (
             SELECT latest.id FROM workspace_memberships latest
             WHERE latest.workspace_id = a.workspace_id AND latest.actor_id = a.actor_id
             ORDER BY latest.joined_at DESC, latest.id DESC LIMIT 1
           )
         JOIN workspace_memberships owner
           ON owner.workspace_id = a.workspace_id AND owner.id = a.owner_membership_id AND owner.status = 'active'
         JOIN humans h ON h.actor_id = owner.actor_id
         WHERE a.workspace_id = ? AND a.deleted_at IS NULL
           AND (m.status = 'active' OR a.owner_membership_id = ? OR ? = 'owner')
           AND (? IS NULL OR a.created_at > ? OR (a.created_at = ? AND a.actor_id > ?))
         ORDER BY a.created_at, a.actor_id LIMIT ?`,
      )
      .all(
        workspaceId,
        observer.id,
        observer.membership_role,
        pageCursor?.createdAt ?? null,
        pageCursor?.createdAt ?? 0,
        pageCursor?.createdAt ?? 0,
        pageCursor?.id ?? '',
        pageLimit + 1,
      ) as unknown as AgentRow[];
    const hasMore = rows.length > pageLimit;
    const items = rows.slice(0, pageLimit).map((row) => this.mapAgent(row));
    const last = items.at(-1);
    return { items, nextCursor: hasMore && last ? encodePageCursor(last.createdAt, last.id) : null };
  }

  updateAgent(
    principal: HumanPrincipal,
    workspaceId: string,
    agentId: string,
    input: { name?: string; description?: string | null; expectedRevision: number },
    idempotencyKey: string,
  ): AgentView {
    invariant(input.name !== undefined || input.description !== undefined, 'EMPTY_AGENT_UPDATE', 'Agent name or description is required.');
    const normalizedName = input.name?.trim();
    if (normalizedName !== undefined) {
      invariant(normalizedName.length > 0 && normalizedName.length <= 120, 'INVALID_AGENT_NAME', 'Agent name is required.');
    }
    const normalizedDescription = input.description === null ? null : input.description?.trim() || null;
    return this.idempotent(workspaceId, principal.actorId, 'UpdateAgent', idempotencyKey, input, () => {
      const membership = this.requireAgentOwner(workspaceId, agentId, principal.actorId);
      const current = this.requireAgentRow(workspaceId, agentId);
      const timestamp = nowMs();
      const updated = this.workspaceDatabase.raw
        .prepare(
          `UPDATE agents
           SET name = ?, description = ?, revision = revision + 1, updated_at = ?
           WHERE workspace_id = ? AND actor_id = ? AND revision = ?
           RETURNING revision`,
        )
        .get(
          normalizedName ?? current.name,
          input.description === undefined ? current.description : normalizedDescription,
          timestamp,
          workspaceId,
          agentId,
          input.expectedRevision,
        ) as { revision: number } | undefined;
      invariant(updated, 'STALE_REVISION', 'Agent revision changed.', 409);
      const contextVersion = this.bumpWorkspaceContext(workspaceId, timestamp);
      this.appendChange(workspaceId, contextVersion, null, null, 'agent_updated', 'agent', agentId, {
        revision: updated.revision,
      }, timestamp);
      this.enqueueDelivery(
        workspaceId,
        'agent.updated',
        'agent',
        agentId,
        { agentId, revision: updated.revision },
        `updated:${agentId}:${updated.revision}`,
        timestamp,
      );
      this.appendAudit(workspaceId, principal.actorId, membership.id, 'agent.update', 'agent', agentId, {
        revision: updated.revision,
      }, timestamp);
      return this.mapAgent(this.requireAgentRow(workspaceId, agentId));
    });
  }

  createWorkspaceDocument(
    principal: HumanPrincipal,
    workspaceId: string,
    input: { title: string; contentMarkdown: string },
    idempotencyKey: string,
  ): WorkspaceDocumentView {
    const title = input.title.trim();
    const contentMarkdown = input.contentMarkdown.trim();
    this.validateWorkspaceDocument(title, contentMarkdown);
    return this.idempotent(workspaceId, principal.actorId, 'CreateWorkspaceDocument', idempotencyKey, input, () => {
      const membership = this.requireMembership(workspaceId, principal.actorId);
      const documentId = newId();
      const versionId = newId();
      const timestamp = nowMs();
      this.workspaceDatabase.raw
        .prepare(
          `INSERT INTO workspace_documents (
             id, workspace_id, status, revision, current_version,
             created_by_membership_id, created_at, updated_at
           ) VALUES (?, ?, 'active', 1, 1, ?, ?, ?)`,
        )
        .run(documentId, workspaceId, membership.id, timestamp, timestamp);
      this.insertWorkspaceDocumentVersion(
        versionId, workspaceId, documentId, 1, title, contentMarkdown, membership.id, timestamp,
      );
      const contextVersion = this.bumpWorkspaceContext(workspaceId, timestamp);
      this.appendChange(workspaceId, contextVersion, null, null, 'workspace_document_created', 'document', documentId, {
        version: 1,
        title,
      }, timestamp);
      this.appendAudit(workspaceId, principal.actorId, membership.id, 'workspace_document.create', 'document', documentId, {
        version: 1,
        title,
      }, timestamp);
      return this.hydrateWorkspaceDocument(this.requireWorkspaceDocumentRow(workspaceId, documentId));
    });
  }

  listWorkspaceDocuments(
    principal: HumanPrincipal,
    workspaceId: string,
    cursor?: string,
    limit = 100,
  ): Page<WorkspaceDocumentView> {
    this.requireMembership(workspaceId, principal.actorId);
    const pageCursor = this.requirePageCursor(cursor);
    const pageLimit = this.pageLimit(limit);
    const rows = this.workspaceDatabase.raw
      .prepare(
        `${this.workspaceDocumentSelect()}
         WHERE d.workspace_id = ? AND d.status = 'active'
           AND (? IS NULL OR d.created_at > ? OR (d.created_at = ? AND d.id > ?))
         ORDER BY d.created_at, d.id LIMIT ?`,
      )
      .all(
        workspaceId,
        pageCursor?.createdAt ?? null,
        pageCursor?.createdAt ?? 0,
        pageCursor?.createdAt ?? 0,
        pageCursor?.id ?? '',
        pageLimit + 1,
      ) as unknown as WorkspaceDocumentRow[];
    const hasMore = rows.length > pageLimit;
    const items = rows.slice(0, pageLimit).map((row) => this.hydrateWorkspaceDocument(row));
    const last = items.at(-1);
    return { items, nextCursor: hasMore && last ? encodePageCursor(last.createdAt, last.id) : null };
  }

  getWorkspaceDocument(
    principal: HumanPrincipal,
    workspaceId: string,
    documentId: string,
  ): WorkspaceDocumentView {
    this.requireMembership(workspaceId, principal.actorId);
    return this.hydrateWorkspaceDocument(this.requireWorkspaceDocumentRow(workspaceId, documentId));
  }

  updateWorkspaceDocument(
    principal: HumanPrincipal,
    workspaceId: string,
    documentId: string,
    input: { title: string; contentMarkdown: string; expectedRevision: number },
    idempotencyKey: string,
  ): WorkspaceDocumentView {
    const title = input.title.trim();
    const contentMarkdown = input.contentMarkdown.trim();
    this.validateWorkspaceDocument(title, contentMarkdown);
    return this.idempotent(workspaceId, principal.actorId, 'UpdateWorkspaceDocument', idempotencyKey, input, () => {
      const membership = this.requireMembership(workspaceId, principal.actorId);
      const current = this.requireWorkspaceDocumentRow(workspaceId, documentId);
      invariant(current.status === 'active', 'WORKSPACE_DOCUMENT_ARCHIVED', 'Workspace Document is archived.', 409);
      const timestamp = nowMs();
      const updated = this.workspaceDatabase.raw
        .prepare(
          `UPDATE workspace_documents
           SET revision = revision + 1, current_version = current_version + 1, updated_at = ?
           WHERE workspace_id = ? AND id = ? AND status = 'active' AND revision = ?
           RETURNING revision, current_version`,
        )
        .get(timestamp, workspaceId, documentId, input.expectedRevision) as
          | { revision: number; current_version: number }
          | undefined;
      invariant(updated, 'STALE_REVISION', 'Workspace Document revision changed.', 409);
      this.insertWorkspaceDocumentVersion(
        newId(), workspaceId, documentId, updated.current_version, title, contentMarkdown, membership.id, timestamp,
      );
      const contextVersion = this.bumpWorkspaceContext(workspaceId, timestamp);
      this.appendChange(workspaceId, contextVersion, null, null, 'workspace_document_updated', 'document', documentId, {
        version: updated.current_version,
        revision: updated.revision,
        title,
      }, timestamp);
      this.appendAudit(workspaceId, principal.actorId, membership.id, 'workspace_document.update', 'document', documentId, {
        version: updated.current_version,
        revision: updated.revision,
        title,
      }, timestamp);
      return this.hydrateWorkspaceDocument(this.requireWorkspaceDocumentRow(workspaceId, documentId));
    });
  }

  getExecutionPolicy(
    principal: HumanPrincipal,
    workspaceId: string,
    agentId: string,
  ): AgentExecutionPolicyView {
    this.requireMembership(workspaceId, principal.actorId);
    this.requireAgentRow(workspaceId, agentId);
    return this.hydrateExecutionPolicy(this.requireLatestExecutionPolicy(workspaceId, agentId));
  }

  updateExecutionPolicy(
    principal: HumanPrincipal,
    workspaceId: string,
    agentId: string,
    input: AgentExecutionPolicy & { expectedVersion: number },
    idempotencyKey: string,
  ): AgentExecutionPolicyView {
    const policy: AgentExecutionPolicy = {
      maxParallelAttempts: input.maxParallelAttempts,
      maxWallTimeMs: input.maxWallTimeMs,
      maxContextBytes: input.maxContextBytes,
      maxToolCalls: input.maxToolCalls,
      allowedContextKinds: input.allowedContextKinds,
      privateContextAllowed: input.privateContextAllowed,
    };
    this.validateExecutionPolicy(policy);
    return this.idempotent(workspaceId, principal.actorId, 'UpdateExecutionPolicy', idempotencyKey, input, () => {
      const membership = this.requireAgentOwner(workspaceId, agentId, principal.actorId);
      this.requireAgentRow(workspaceId, agentId);
      const current = this.requireLatestExecutionPolicy(workspaceId, agentId);
      invariant(current.version === input.expectedVersion, 'EXECUTION_POLICY_VERSION_CONFLICT', 'Execution Policy version changed.', 409);
      const id = newId();
      const timestamp = nowMs();
      this.insertExecutionPolicy(id, workspaceId, agentId, current.version + 1, membership.id, policy, timestamp);
      const workspaceVersion = this.bumpWorkspaceContext(workspaceId, timestamp);
      this.appendChange(workspaceId, workspaceVersion, null, null, 'agent_execution_policy_updated', 'agent', agentId, {
        version: current.version + 1,
      }, timestamp);
      this.appendAudit(workspaceId, principal.actorId, membership.id, 'agent.execution-policy.update', 'agent', agentId, {
        version: current.version + 1,
      }, timestamp);
      return this.hydrateExecutionPolicy(this.requireLatestExecutionPolicy(workspaceId, agentId));
    });
  }

  suspendAgent(
    principal: HumanPrincipal,
    workspaceId: string,
    agentId: string,
    expectedRevision: number,
    idempotencyKey: string,
  ): AgentView {
    return this.transitionAgent(principal, workspaceId, agentId, 'active', 'suspended', expectedRevision, idempotencyKey);
  }

  resumeAgent(
    principal: HumanPrincipal,
    workspaceId: string,
    agentId: string,
    expectedRevision: number,
    idempotencyKey: string,
  ): AgentView {
    return this.transitionAgent(principal, workspaceId, agentId, 'suspended', 'active', expectedRevision, idempotencyKey);
  }

  restartAgent(
    principal: HumanPrincipal,
    workspaceId: string,
    agentId: string,
    expectedRevision: number,
    idempotencyKey: string,
  ): AgentView {
    const result = this.idempotent(
      workspaceId,
      principal.actorId,
      'RestartAgentRuntime',
      idempotencyKey,
      { expectedRevision },
      () => {
        const membership = this.requireAgentOwner(workspaceId, agentId, principal.actorId);
        const agent = this.requireAgentRow(workspaceId, agentId);
        invariant(agent.lifecycle_status === 'active' && agent.revision === expectedRevision,
          'AGENT_LIFECYCLE_CONFLICT', 'Agent lifecycle or revision changed.', 409);
        const binding = this.workspaceDatabase.raw.prepare(
          `SELECT * FROM agent_runtime_bindings
           WHERE workspace_id = ? AND agent_id = ? AND status = 'active'`,
        ).get(workspaceId, agentId) as RuntimeBindingRow | undefined;
        invariant(binding, 'RUNTIME_BINDING_UNAVAILABLE', 'Agent has no active Runtime Binding.', 409);
        const timestamp = nowMs();
        const activeRuns = this.workspaceDatabase.raw.prepare(
          `SELECT run.id, attempt.id AS attempt_id
           FROM runs run
           LEFT JOIN attempts attempt
             ON attempt.workspace_id = run.workspace_id
            AND attempt.run_id = run.id
            AND attempt.status = 'running'
           WHERE run.workspace_id = ? AND run.agent_id = ? AND run.status = 'active'
           ORDER BY run.created_at, run.id`,
        ).all(workspaceId, agentId) as unknown as Array<{ id: string; attempt_id: string | null }>;
        for (const run of activeRuns) {
          if (run.attempt_id) {
            this.workspaceDatabase.raw.prepare(
              "UPDATE attempts SET status = 'cancelled', finished_at = ? WHERE id = ? AND status = 'running'",
            ).run(timestamp, run.attempt_id);
          }
          this.workspaceDatabase.raw.prepare(
            "UPDATE runs SET status = 'terminal', outcome = 'cancelled', terminal_at = ? WHERE id = ? AND status = 'active'",
          ).run(timestamp, run.id);
          this.workspaceDatabase.raw.prepare(
            'UPDATE private_context_grants SET revoked_at = ? WHERE workspace_id = ? AND run_id = ? AND revoked_at IS NULL',
          ).run(timestamp, workspaceId, run.id);
          this.markRunInboxHandled(workspaceId, run.id, timestamp);
        }
        const disabled = this.workspaceDatabase.raw.prepare(
          `UPDATE agent_runtime_bindings SET status = 'disabled', updated_at = ?
           WHERE id = ? AND status = 'active'`,
        ).run(timestamp, binding.id);
        invariant(disabled.changes === 1, 'RUNTIME_BINDING_REVISION_CONFLICT', 'Runtime Binding changed.', 409);
        const bindingRevision = binding.binding_revision + 1;
        this.workspaceDatabase.raw.prepare(
          `INSERT INTO agent_runtime_bindings (
             id, workspace_id, agent_id, computer_id, runtime_id,
             requested_model, requested_reasoning_effort, requested_mode,
             runtime_catalog_revision, binding_revision, status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        ).run(
          newId(), workspaceId, agentId, binding.computer_id, binding.runtime_id,
          binding.requested_model, binding.requested_reasoning_effort, binding.requested_mode,
          binding.runtime_catalog_revision, bindingRevision, timestamp, timestamp,
        );
        const updated = this.workspaceDatabase.raw.prepare(
          `UPDATE agents SET revision = revision + 1, updated_at = ?
           WHERE workspace_id = ? AND actor_id = ? AND revision = ?
           RETURNING revision`,
        ).get(timestamp, workspaceId, agentId, expectedRevision) as { revision: number } | undefined;
        invariant(updated, 'AGENT_LIFECYCLE_CONFLICT', 'Agent lifecycle or revision changed.', 409);
        const contextVersion = this.bumpWorkspaceContext(workspaceId, timestamp);
        this.appendChange(workspaceId, contextVersion, null, null, 'agent_runtime_restarted', 'agent', agentId, {
          revision: updated.revision,
          bindingRevision,
          cancelledRunIds: activeRuns.map((run) => run.id),
        }, timestamp);
        this.enqueueDelivery(
          workspaceId,
          'agent.runtime-restarted',
          'agent',
          agentId,
          { agentId, revision: updated.revision, bindingRevision },
          `runtime-restarted:${agentId}:${bindingRevision}`,
          timestamp,
        );
        this.appendAudit(workspaceId, principal.actorId, membership.id, 'agent.runtime.restart', 'agent', agentId, {
          revision: updated.revision,
          bindingRevision,
          cancelledRunIds: activeRuns.map((run) => run.id),
        }, timestamp);
        return {
          agent: this.mapAgent(this.requireAgentRow(workspaceId, agentId)),
          cancelledAttemptIds: activeRuns.flatMap((run) => run.attempt_id ? [run.attempt_id] : []),
        };
      },
    );
    for (const attemptId of result.cancelledAttemptIds) this.localExecutions.cancelIfPresent(attemptId);
    return result.agent;
  }

  terminateAgentMembership(
    principal: HumanPrincipal,
    workspaceId: string,
    agentId: string,
    expectedRevision: number,
    idempotencyKey: string,
  ): { agentId: string; membershipId: string; terminatedAt: number } {
    const result = this.idempotent(
      workspaceId,
      principal.actorId,
      'TerminateAgentMembership',
      idempotencyKey,
      { expectedRevision },
      () => {
        const caller = this.requireWorkspaceOwner(workspaceId, principal.actorId);
        const timestamp = nowMs();
        const current = this.workspaceDatabase.raw
        .prepare(
          `SELECT a.revision, m.id AS membership_id, m.revision AS membership_revision
           FROM agents a
           JOIN workspace_memberships m
             ON m.workspace_id = a.workspace_id AND m.actor_id = a.actor_id AND m.status = 'active'
           WHERE a.workspace_id = ? AND a.actor_id = ?
             AND a.lifecycle_status IN ('active', 'suspended') AND a.revision = ?`,
        )
        .get(workspaceId, agentId, expectedRevision) as {
          revision: number;
          membership_id: string;
          membership_revision: number;
        } | undefined;
        invariant(current, 'AGENT_LIFECYCLE_CONFLICT', 'Agent lifecycle or revision changed.', 409);

      const pendingRequests = this.workspaceDatabase.raw
        .prepare(
          `SELECT ar.id, ar.result_conversation_id
           FROM agent_requests ar
           JOIN agent_mention_outcomes o ON o.workspace_id = ar.workspace_id AND o.id = ar.mention_outcome_id
           JOIN messages m ON m.workspace_id = o.workspace_id AND m.id = o.message_id
           WHERE ar.workspace_id = ? AND ar.status = 'pending'
             AND (ar.target_agent_id = ? OR m.author_membership_id = ?)
           ORDER BY ar.created_at, ar.id`,
        )
        .all(workspaceId, agentId, current.membership_id) as unknown as Array<{ id: string; result_conversation_id: string }>;
      const cancelRequest = this.workspaceDatabase.raw.prepare(
        `UPDATE agent_requests
         SET status = 'cancelled', version = version + 1,
             terminal_reason_code = 'authority_revoked', terminal_reason_detail = NULL,
             updated_at = ?, terminal_at = ?
         WHERE workspace_id = ? AND id = ? AND status = 'pending'`,
      );
      for (const request of pendingRequests) cancelRequest.run(timestamp, timestamp, workspaceId, request.id);
      this.markInboxRequestsHandled(workspaceId, pendingRequests.map((request) => request.id), timestamp);

      const activeRuns = this.workspaceDatabase.raw
        .prepare(
          `SELECT r.id, ar.result_conversation_id, a.id AS attempt_id
           FROM runs r
           JOIN agent_requests ar ON ar.workspace_id = r.workspace_id AND ar.id = r.agent_request_id
           LEFT JOIN attempts a ON a.workspace_id = r.workspace_id AND a.run_id = r.id AND a.status = 'running'
           WHERE r.workspace_id = ? AND r.agent_id = ? AND r.status = 'active'
           ORDER BY r.created_at, r.id`,
        )
        .all(workspaceId, agentId) as unknown as Array<{
          id: string;
          result_conversation_id: string;
          attempt_id: string | null;
        }>;
      for (const run of activeRuns) {
        if (run.attempt_id) {
          this.workspaceDatabase.raw
            .prepare("UPDATE attempts SET status = 'cancelled', finished_at = ? WHERE id = ? AND status = 'running'")
            .run(timestamp, run.attempt_id);
        }
        this.workspaceDatabase.raw
          .prepare("UPDATE runs SET status = 'terminal', outcome = 'cancelled', terminal_at = ? WHERE id = ? AND status = 'active'")
          .run(timestamp, run.id);
        this.workspaceDatabase.raw
          .prepare('UPDATE private_context_grants SET revoked_at = ? WHERE workspace_id = ? AND run_id = ? AND revoked_at IS NULL')
          .run(timestamp, workspaceId, run.id);
        this.markRunInboxHandled(workspaceId, run.id, timestamp);
      }

      this.workspaceDatabase.raw
        .prepare(
          `UPDATE agent_runtime_bindings
           SET status = 'disabled', updated_at = ?
           WHERE workspace_id = ? AND agent_id = ? AND status = 'active'`,
        )
        .run(timestamp, workspaceId, agentId);
      const projectMemberships = this.workspaceDatabase.raw
        .prepare(
          `SELECT pm.*
           FROM project_memberships pm
           WHERE pm.workspace_id = ? AND pm.workspace_membership_id = ? AND pm.status = 'active'
           ORDER BY pm.joined_at, pm.id`,
        )
        .all(workspaceId, current.membership_id) as unknown as ProjectMembershipRow[];
      for (const projectMembership of projectMemberships) {
        this.removeProjectMembership(
          this.requireProject(projectMembership.project_id),
          projectMembership,
          projectMembership.revision,
          principal.actorId,
          caller.id,
          'agent.membership.project-membership.remove',
          timestamp,
        );
      }
      const removedMembership = this.workspaceDatabase.raw
        .prepare(
          `UPDATE workspace_memberships
           SET status = 'removed', revision = revision + 1, updated_at = ?, removed_at = ?
           WHERE workspace_id = ? AND id = ? AND status = 'active'`,
        )
        .run(timestamp, timestamp, workspaceId, current.membership_id);
      invariant(removedMembership.changes === 1, 'AGENT_LIFECYCLE_CONFLICT', 'Agent Membership changed.', 409);
      const suspended = this.workspaceDatabase.raw
        .prepare(
          `UPDATE agents
           SET lifecycle_status = 'suspended', revision = revision + 1, updated_at = ?
           WHERE workspace_id = ? AND actor_id = ? AND lifecycle_status IN ('active', 'suspended') AND revision = ?`,
        )
        .run(timestamp, workspaceId, agentId, expectedRevision);
      invariant(suspended.changes === 1, 'AGENT_LIFECYCLE_CONFLICT', 'Agent lifecycle or revision changed.', 409);

      const contextVersion = this.bumpWorkspaceContext(workspaceId, timestamp);
      this.appendChange(workspaceId, contextVersion, null, null, 'agent_membership_terminated', 'agent', agentId, {
        membershipId: current.membership_id,
        revision: expectedRevision + 1,
        cancelledAgentRequestIds: pendingRequests.map((request) => request.id),
        cancelledRunIds: activeRuns.map((run) => run.id),
        removedProjectMembershipIds: projectMemberships.map((membership) => membership.id),
      }, timestamp);
      this.appendChange(workspaceId, contextVersion, null, null, 'workspace_member_removed', 'workspace_membership', current.membership_id, {
        membershipId: current.membership_id,
        actorId: agentId,
        revision: current.membership_revision + 1,
        reason: 'agent_membership_terminated',
      }, timestamp);
      this.enqueueDelivery(
        workspaceId,
        'agent.membership-terminated',
        'agent',
        agentId,
        { agentId, membershipId: current.membership_id, revision: expectedRevision + 1 },
        `membership-terminated:${agentId}:${expectedRevision + 1}`,
        timestamp,
      );
      for (const request of pendingRequests) {
        this.enqueueDelivery(
          workspaceId,
          'agent-request.cancelled',
          'agent_request',
          request.id,
          { agentRequestId: request.id, reason: 'authority_revoked' },
          `cancelled:${request.id}:agent-membership-terminated`,
          timestamp,
        );
      }
      this.appendAudit(workspaceId, principal.actorId, caller.id, 'agent.membership.terminate', 'agent', agentId, {
        membershipId: current.membership_id,
        revision: expectedRevision + 1,
        cancelledAgentRequestIds: pendingRequests.map((request) => request.id),
        cancelledRunIds: activeRuns.map((run) => run.id),
        removedProjectMembershipIds: projectMemberships.map((membership) => membership.id),
      }, timestamp);
      return {
        agentId,
        membershipId: current.membership_id,
        terminatedAt: timestamp,
        cancelledAttemptIds: activeRuns.flatMap((run) => run.attempt_id ? [run.attempt_id] : []),
      };
    });
    for (const attemptId of result.cancelledAttemptIds) this.localExecutions.cancelIfPresent(attemptId);
    return { agentId: result.agentId, membershipId: result.membershipId, terminatedAt: result.terminatedAt };
  }

  deleteAgent(
    principal: HumanPrincipal,
    workspaceId: string,
    agentId: string,
    expectedRevision: number,
    idempotencyKey: string,
  ): { agentId: string; deletedAt: number } {
    return this.idempotent(workspaceId, principal.actorId, 'DeleteAgent', idempotencyKey, { expectedRevision }, () => {
      const caller = this.requireWorkspaceOwner(workspaceId, principal.actorId);
      const current = this.requireAgentIdentityRow(workspaceId, agentId);
      invariant(
        current.membership_status === 'removed',
        'AGENT_MEMBERSHIP_TERMINATION_REQUIRED',
        'Agent Membership must be terminated before the Agent can be deleted.',
        409,
      );
      invariant(current.revision === expectedRevision, 'STALE_REVISION', 'Agent revision changed.', 409);
      const timestamp = nowMs();
      const deleted = this.workspaceDatabase.raw
        .prepare(
          `UPDATE agents
           SET deleted_at = ?, updated_at = ?, revision = revision + 1
           WHERE workspace_id = ? AND actor_id = ? AND deleted_at IS NULL AND revision = ?`,
        )
        .run(timestamp, timestamp, workspaceId, agentId, expectedRevision);
      invariant(deleted.changes === 1, 'STALE_REVISION', 'Agent revision changed.', 409);
      const contextVersion = this.bumpWorkspaceContext(workspaceId, timestamp);
      this.appendChange(workspaceId, contextVersion, null, null, 'agent_deleted', 'agent', agentId, {
        membershipId: current.membership_id,
        revision: expectedRevision + 1,
      }, timestamp);
      this.enqueueDelivery(
        workspaceId,
        'agent.deleted',
        'agent',
        agentId,
        { agentId, membershipId: current.membership_id, cleanupWorkspace: true },
        `deleted:${agentId}:${expectedRevision + 1}`,
        timestamp,
      );
      this.appendAudit(workspaceId, principal.actorId, caller.id, 'agent.delete', 'agent', agentId, {
        membershipId: current.membership_id,
        revision: expectedRevision + 1,
      }, timestamp);
      return { agentId, deletedAt: timestamp };
    });
  }

  readmitAgentMembership(
    principal: HumanPrincipal,
    workspaceId: string,
    agentId: string,
    expectedRevision: number,
    idempotencyKey: string,
  ): AgentView {
    return this.idempotent(workspaceId, principal.actorId, 'ReadmitAgentMembership', idempotencyKey, { expectedRevision }, () => {
      const caller = this.requireWorkspaceOwner(workspaceId, principal.actorId);
      const current = this.requireAgentIdentityRow(workspaceId, agentId);
      invariant(current.membership_status === 'removed', 'AGENT_MEMBERSHIP_ALREADY_ACTIVE', 'Agent already has an active Membership.', 409);
      invariant(current.revision === expectedRevision, 'STALE_REVISION', 'Agent revision changed.', 409);
      const membershipId = newId();
      const timestamp = nowMs();
      this.workspaceDatabase.raw
        .prepare(
          `INSERT INTO workspace_memberships (
             id, workspace_id, actor_id, membership_role, status, revision, joined_at, updated_at
           ) VALUES (?, ?, ?, 'member', 'active', 1, ?, ?)`,
        )
        .run(membershipId, workspaceId, agentId, timestamp, timestamp);
      const updated = this.workspaceDatabase.raw
        .prepare(
          `UPDATE agents SET revision = revision + 1, updated_at = ?
           WHERE workspace_id = ? AND actor_id = ? AND revision = ?`,
        )
        .run(timestamp, workspaceId, agentId, expectedRevision);
      invariant(updated.changes === 1, 'STALE_REVISION', 'Agent revision changed.', 409);
      const contextVersion = this.bumpWorkspaceContext(workspaceId, timestamp);
      this.appendChange(workspaceId, contextVersion, null, null, 'agent_membership_readmitted', 'agent', agentId, {
        membershipId,
        revision: expectedRevision + 1,
      }, timestamp);
      this.appendChange(workspaceId, contextVersion, null, null, 'workspace_member_joined', 'workspace_membership', membershipId, {
        membershipId,
        actorId: agentId,
        reason: 'agent_membership_readmitted',
      }, timestamp);
      this.enqueueDelivery(
        workspaceId,
        'agent.membership-readmitted',
        'agent',
        agentId,
        { agentId, membershipId, revision: expectedRevision + 1 },
        `membership-readmitted:${agentId}:${expectedRevision + 1}`,
        timestamp,
      );
      this.appendAudit(workspaceId, principal.actorId, caller.id, 'agent.membership.readmit', 'agent', agentId, {
        membershipId,
        revision: expectedRevision + 1,
      }, timestamp);
      return this.mapAgent(this.requireAgentRow(workspaceId, agentId));
    });
  }

  registerComputer(
    principal: HumanPrincipal,
    input: { name: string; label?: string },
    idempotencyKey: string,
  ): { computerId: string; token: string; name: string; createdAt: number } {
    const normalizedName = input.name.trim();
    invariant(normalizedName.length > 0 && normalizedName.length <= 120, 'INVALID_COMPUTER_NAME', 'Computer name is required.');
    invariant(idempotencyKey.trim().length > 0, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is required.');
    const requestHash = sha256(canonicalJson(input));
    return this.workspaceDatabase.transaction(() => {
      const existing = this.workspaceDatabase.raw
        .prepare(
          `SELECT request_hash, result_json FROM idempotency_records
           WHERE scope_key = 'deployment' AND actor_id = ?
             AND command_name = 'RegisterComputer' AND idempotency_key = ?`,
        )
        .get(principal.actorId, idempotencyKey) as { request_hash: string; result_json: string } | undefined;
      if (existing) {
        invariant(existing.request_hash === requestHash, 'IDEMPOTENCY_CONFLICT', 'Idempotency key was reused with a different request.', 409);
        const prior = JSON.parse(existing.result_json) as { computerId: string; name: string; createdAt: number };
        throw new DomainError(
          'TOKEN_ALREADY_ISSUED',
          'The Computer was already registered and its one-time token cannot be returned again.',
          409,
          prior,
        );
      }
      const computerId = newId();
      const tokenId = newId();
      const token = issueToken();
      const timestamp = nowMs();
      this.workspaceDatabase.raw
        .prepare("INSERT INTO computers (id, owner_human_id, name, status, created_at) VALUES (?, ?, ?, 'active', ?)")
        .run(computerId, principal.actorId, normalizedName, timestamp);
      this.workspaceDatabase.raw
        .prepare(
          `INSERT INTO api_tokens (
             id, principal_type, computer_id, token_hash, label, status, created_at
           ) VALUES (?, 'computer', ?, ?, ?, 'active', ?)`,
        )
        .run(tokenId, computerId, token.hash, input.label?.trim() || 'local-node', timestamp);
      const durableResult = { computerId, name: normalizedName, createdAt: timestamp };
      this.workspaceDatabase.raw
        .prepare(
          `INSERT INTO idempotency_records (
             scope_key, actor_id, command_name, idempotency_key, request_hash, result_json, created_at
           ) VALUES ('deployment', ?, 'RegisterComputer', ?, ?, ?, ?)`,
        )
        .run(principal.actorId, idempotencyKey, requestHash, canonicalJson(durableResult), timestamp);
      return { ...durableResult, token: token.raw };
    });
  }

  listComputers(principal: HumanPrincipal): ComputerView[] {
    const timestamp = nowMs();
    return (this.workspaceDatabase.raw
      .prepare(
        `SELECT id, name, status, last_seen_at, runtime_catalog_revision, created_at
         FROM computers
         WHERE owner_human_id = ?
         ORDER BY created_at, id`,
      )
      .all(principal.actorId) as Array<{
        id: string;
        name: string;
        status: 'active' | 'disabled';
        last_seen_at: number | null;
        runtime_catalog_revision: number;
        created_at: number;
      }>).map((row) => ({
        id: row.id,
        name: row.name,
        status: row.status,
        connectionStatus: row.status === 'active'
          && row.last_seen_at !== null
          && timestamp - row.last_seen_at <= COMPUTER_ONLINE_WINDOW_MS
          ? 'online'
          : 'offline',
        lastSeenAt: row.last_seen_at,
        runtimeCatalogRevision: row.runtime_catalog_revision,
        runtimes: (this.workspaceDatabase.raw
          .prepare(
            `SELECT runtime_id, availability, detected_version, configuration_json,
                    skills_json,
                    unavailable_reason_code, unavailable_reason_message, checked_at
             FROM computer_runtime_capabilities
             WHERE computer_id = ?
             ORDER BY runtime_id`,
          )
          .all(row.id) as Array<{
            runtime_id: RuntimeId;
            availability: ComputerView['runtimes'][number]['availability'];
            detected_version: string | null;
            configuration_json: string | null;
            skills_json: string;
            unavailable_reason_code: RuntimeCapabilityUnavailableReason['code'] | null;
            unavailable_reason_message: string | null;
            checked_at: number;
          }>).map((runtime) => ({
            runtimeId: runtime.runtime_id,
            label: runtimeCatalogDefinition(runtime.runtime_id).label,
            availability: runtime.availability,
            detectedVersion: runtime.detected_version,
            configuration: runtime.configuration_json === null
              ? null
              : JSON.parse(runtime.configuration_json) as RuntimeConfigurationCapabilities,
            skills: JSON.parse(runtime.skills_json) as ComputerView['runtimes'][number]['skills'],
            unavailableReason: runtime.unavailable_reason_code === null
              ? null
              : { code: runtime.unavailable_reason_code, message: runtime.unavailable_reason_message! },
            checkedAt: runtime.checked_at,
          })),
        createdAt: row.created_at,
      }));
  }

  reportComputerRuntimeCatalog(
    principal: ComputerPrincipal,
    input: { runtimes: RuntimeCapabilityReport[] },
  ): { computerId: string; runtimeCatalogRevision: number; lastSeenAt: number } {
    const ids = new Set(input.runtimes.map((runtime) => runtime.runtimeId));
    invariant(
      input.runtimes.length >= RUNTIME_CATALOG.length
      && input.runtimes.length <= 100
      && ids.size === input.runtimes.length
      && RUNTIME_CATALOG.every((runtime) => ids.has(runtime.id)),
      'INCOMPLETE_RUNTIME_CATALOG',
      'A Runtime catalog report must contain every supported runtimeId exactly once.',
    );
    for (const runtime of input.runtimes) {
      invariant(RUNTIME_ID_PATTERN.test(runtime.runtimeId), 'INVALID_RUNTIME_ID', 'Runtime catalog contains an invalid runtimeId.');
      if (runtime.detectedVersion !== undefined) {
        invariant(
          runtime.detectedVersion.trim().length > 0 && runtime.detectedVersion.trim().length <= 120,
          'INVALID_RUNTIME_VERSION',
          'Detected Runtime version must contain 1 to 120 characters.',
        );
      }
      this.validateRuntimeSkillCatalog(runtime.skills);
      if (runtime.availability === 'ready') {
        invariant(runtime.configuration !== undefined, 'RUNTIME_CONFIGURATION_REQUIRED',
          'A ready Runtime must include its inspected ACP configuration.', 409);
        invariant(runtime.unavailableReason === undefined, 'INVALID_RUNTIME_UNAVAILABLE_REASON',
          'A ready Runtime cannot include an unavailable reason.');
        this.validateRuntimeConfigurationCapabilities(runtime.configuration);
      } else {
        invariant(runtime.configuration === undefined, 'INVALID_RUNTIME_CONFIGURATION',
          'An unavailable Runtime cannot publish configuration options.');
        invariant(runtime.unavailableReason !== undefined, 'RUNTIME_UNAVAILABLE_REASON_REQUIRED',
          'An unavailable Runtime must include a structured reason.');
        this.validateRuntimeUnavailableReason(runtime.availability, runtime.unavailableReason);
      }
    }
    return this.workspaceDatabase.transaction(() => {
      const timestamp = nowMs();
      const updated = this.workspaceDatabase.raw
        .prepare(
          `UPDATE computers
           SET last_seen_at = ?, runtime_catalog_revision = runtime_catalog_revision + 1
           WHERE id = ? AND owner_human_id = ? AND status = 'active'
           RETURNING runtime_catalog_revision`,
        )
        .get(timestamp, principal.computerId, principal.ownerHumanId) as { runtime_catalog_revision: number } | undefined;
      invariant(updated, 'COMPUTER_NOT_FOUND', 'Computer is not active.', 404);
      this.workspaceDatabase.raw
        .prepare('DELETE FROM computer_runtime_capabilities WHERE computer_id = ?')
        .run(principal.computerId);
      const insert = this.workspaceDatabase.raw.prepare(
        `INSERT INTO computer_runtime_capabilities (
           computer_id, runtime_id, availability, detected_version,
           configuration_json, configuration_digest,
           skills_json, skills_digest,
           unavailable_reason_code, unavailable_reason_message, checked_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const runtime of input.runtimes) {
        const configurationJson = runtime.configuration === undefined
          ? null
          : canonicalJson(runtime.configuration);
        const skillsJson = canonicalJson(runtime.skills);
        insert.run(
          principal.computerId,
          runtime.runtimeId,
          runtime.availability,
          runtime.detectedVersion?.trim() || null,
          configurationJson,
          configurationJson === null ? null : sha256(configurationJson),
          skillsJson,
          sha256(skillsJson),
          runtime.unavailableReason?.code ?? null,
          runtime.unavailableReason?.message.trim() ?? null,
          timestamp,
        );
      }
      return {
        computerId: principal.computerId,
        runtimeCatalogRevision: updated.runtime_catalog_revision,
        lastSeenAt: timestamp,
      };
    });
  }

  heartbeatComputer(principal: ComputerPrincipal): {
    computerId: string;
    runtimeCatalogRevision: number;
    lastSeenAt: number;
  } {
    const timestamp = nowMs();
    const row = this.workspaceDatabase.raw
      .prepare(
        `UPDATE computers SET last_seen_at = ?
         WHERE id = ? AND owner_human_id = ? AND status = 'active'
         RETURNING runtime_catalog_revision`,
      )
      .get(timestamp, principal.computerId, principal.ownerHumanId) as { runtime_catalog_revision: number } | undefined;
    invariant(row, 'COMPUTER_NOT_FOUND', 'Computer is not active.', 404);
    return {
      computerId: principal.computerId,
      runtimeCatalogRevision: row.runtime_catalog_revision,
      lastSeenAt: timestamp,
    };
  }

  listComputerAgentRequests(computerId: string, limit = 20): AgentRequestView[] {
    const rows = this.workspaceDatabase.raw
      .prepare(
        `SELECT ar.*, o.message_id AS source_message_id
         FROM agent_requests ar
         JOIN agent_mention_outcomes o
           ON o.workspace_id = ar.workspace_id AND o.id = ar.mention_outcome_id
         JOIN agent_runtime_bindings b
           ON b.workspace_id = ar.workspace_id
          AND b.agent_id = ar.target_agent_id
          AND b.status = 'active'
         WHERE b.computer_id = ?
           AND (
             (ar.status = 'pending' AND NOT EXISTS (
               SELECT 1 FROM runs active_run
               WHERE active_run.workspace_id = ar.workspace_id
                 AND active_run.agent_id = ar.target_agent_id
                 AND active_run.status = 'active'
             ) AND NOT EXISTS (
               SELECT 1 FROM agent_requests earlier
               WHERE earlier.workspace_id = ar.workspace_id
                 AND earlier.target_agent_id = ar.target_agent_id
                 AND earlier.status = 'pending'
                 AND (
                   earlier.created_at < ar.created_at
                   OR (earlier.created_at = ar.created_at AND earlier.id < ar.id)
                 )
             ))
             OR (
               ar.status = 'accepted'
               AND EXISTS (
                 SELECT 1 FROM runs r
                 JOIN run_agent_requests relation
                   ON relation.workspace_id = r.workspace_id AND relation.run_id = r.id
                 WHERE relation.workspace_id = ar.workspace_id
                   AND relation.agent_request_id = ar.id
                   AND r.status = 'active'
               )
             )
           )
         ORDER BY ar.created_at, ar.id
         LIMIT ?`,
      )
      .all(computerId, Math.min(Math.max(limit, 1), 100)) as unknown as AgentRequestRow[];
    return rows
      .map((row) => this.hydrateAgentRequest(row))
      .filter((request) => request.status === 'accepted' || request.intake?.disposition === 'ready');
  }

  getComputerAgentInbox(computerId: string, agentId: string): AgentInboxSummaryView {
    this.requireComputerAgentBinding(computerId, agentId);
    const highest = this.workspaceDatabase.raw.prepare(
      'SELECT COALESCE(MAX(sequence), 0) AS sequence FROM agent_inbox_items WHERE agent_id = ?',
    ).get(agentId) as { sequence: number };
    const rows = this.workspaceDatabase.raw.prepare(
      `SELECT conversation_id, thread_id, COUNT(*) AS pending_count,
              MIN(sequence) AS first_sequence, MAX(sequence) AS last_sequence
       FROM agent_inbox_items
       WHERE agent_id = ? AND state = 'pending'
       GROUP BY conversation_id, thread_id
       ORDER BY first_sequence`,
    ).all(agentId) as unknown as Array<{
      conversation_id: string;
      thread_id: string | null;
      pending_count: number;
      first_sequence: number;
      last_sequence: number;
    }>;
    return {
      agentId,
      highestSequence: highest.sequence,
      targets: rows.map((row) => ({
        conversationId: row.conversation_id,
        threadId: row.thread_id,
        target: this.inboxTarget(row.conversation_id, row.thread_id),
        pendingCount: row.pending_count,
        firstSequence: row.first_sequence,
        lastSequence: row.last_sequence,
      })),
    };
  }

  getComputerAgentInboxWakes(
    computerId: string,
    after: Record<string, number>,
  ): AgentInboxWakeBatchView {
    const rows = this.workspaceDatabase.raw.prepare(
      `SELECT binding.agent_id, COALESCE(MAX(item.sequence), 0) AS highest_sequence
       FROM agent_runtime_bindings binding
       LEFT JOIN agent_inbox_items item
         ON item.workspace_id = binding.workspace_id AND item.agent_id = binding.agent_id
       WHERE binding.computer_id = ? AND binding.status = 'active'
       GROUP BY binding.agent_id
       ORDER BY binding.agent_id`,
    ).all(computerId) as unknown as Array<{ agent_id: string; highest_sequence: number }>;
    const cursor = Object.fromEntries(rows.map((row) => [row.agent_id, row.highest_sequence]));
    return {
      events: rows.flatMap((row) => row.highest_sequence > (after[row.agent_id] ?? 0)
        ? [{ type: 'agent.inbox_changed' as const, agentId: row.agent_id, highestSequence: row.highest_sequence }]
        : []),
      cursor,
    };
  }

  async waitForComputerAgentInboxWakes(
    computerId: string,
    after: Record<string, number>,
    timeoutMs = 25_000,
  ): Promise<AgentInboxWakeBatchView> {
    const immediate = this.getComputerAgentInboxWakes(computerId, after);
    if (immediate.events.length > 0) return immediate;
    await new Promise<void>((resolveWake) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.agentInboxWakeEmitter.off('changed', finish);
        resolveWake();
      };
      const timer = setTimeout(finish, Math.min(Math.max(timeoutMs, 1_000), 25_000));
      this.agentInboxWakeEmitter.once('changed', finish);
    });
    return this.getComputerAgentInboxWakes(computerId, after);
  }

  claimComputerAgentInbox(
    computerId: string,
    agentId: string,
    input: { attemptId: string; conversationId: string; threadId: string | null; receipt: string },
  ): AgentInboxClaimView {
    invariant(input.receipt.trim().length > 0, 'INVALID_INBOX_RECEIPT', 'Inbox receipt is required.');
    this.authorizeComputerForAttempt(computerId, input.attemptId);
    const attempt = this.requireAttempt(input.attemptId);
    const run = this.requireRun(attempt.run_id);
    invariant(run.status === 'active' && attempt.status === 'running',
      'ATTEMPT_FENCED', 'Run or Attempt is no longer active.', 409);
    invariant(run.agent_id === agentId, 'AGENT_INBOX_SCOPE_MISMATCH', 'Attempt belongs to another Agent.', 403);
    const primary = this.requireAgentRequest(run.agent_request_id);
    invariant(
      primary.result_conversation_id === input.conversationId
      && primary.result_thread_id === input.threadId,
      'AGENT_INBOX_SCOPE_MISMATCH',
      'Inbox target does not match the active Run discussion scope.',
      409,
    );
    const target = this.inboxTarget(input.conversationId, input.threadId);
    return this.workspaceDatabase.transaction(() => {
      let receiptRow = this.workspaceDatabase.raw.prepare(
        `SELECT * FROM agent_inbox_claim_receipts
         WHERE workspace_id = ? AND agent_id = ? AND receipt = ?`,
      ).get(run.workspace_id, agentId, input.receipt) as AgentInboxClaimReceiptRow | undefined;
      if (receiptRow) {
        invariant(
          receiptRow.run_id === run.id
          && receiptRow.attempt_id === input.attemptId
          && receiptRow.binding_revision === run.binding_revision
          && receiptRow.conversation_id === input.conversationId
          && receiptRow.thread_id === input.threadId,
          'INBOX_RECEIPT_SCOPE_MISMATCH',
          'Inbox receipt belongs to another Run or Discussion Scope.',
          409,
        );
      }
      const replayRows = this.workspaceDatabase.raw.prepare(
        `SELECT * FROM agent_inbox_items
         WHERE workspace_id = ? AND agent_id = ? AND claimed_run_id = ? AND claim_receipt = ?
         ORDER BY sequence`,
      ).all(run.workspace_id, agentId, run.id, input.receipt) as unknown as AgentInboxItemRow[];
      const rows = this.workspaceDatabase.raw.prepare(
        `SELECT * FROM agent_inbox_items
         WHERE workspace_id = ? AND agent_id = ? AND conversation_id = ?
           AND thread_id IS ? AND state = 'pending'
         ORDER BY sequence`,
      ).all(run.workspace_id, agentId, input.conversationId, input.threadId) as unknown as AgentInboxItemRow[];
      invariant(receiptRow || rows.length > 0, 'AGENT_INBOX_EMPTY', 'Discussion Scope has no pending Inbox messages.', 409);
      const frontier = this.discussionFrontier(run.workspace_id, input.conversationId, input.threadId);
      const timestamp = nowMs();
      if (!receiptRow) {
        const prior = this.workspaceDatabase.raw.prepare(
          `SELECT COALESCE(MAX(receipt.through_position), 0) AS position
           FROM agent_inbox_claim_receipts receipt
           JOIN runs prior_run
             ON prior_run.workspace_id = receipt.workspace_id AND prior_run.id = receipt.run_id
           WHERE receipt.workspace_id = ? AND receipt.agent_id = ?
             AND receipt.binding_revision = ?
             AND receipt.conversation_id = ? AND receipt.thread_id IS ?
             AND prior_run.status = 'terminal'
             AND prior_run.outcome IN ('publish', 'no_output', 'discard')`,
        ).get(
          run.workspace_id,
          agentId,
          run.binding_revision,
          input.conversationId,
          input.threadId,
        ) as { position: number };
        const receiptId = newId();
        this.workspaceDatabase.raw.prepare(
          `INSERT INTO agent_inbox_claim_receipts (
             id, workspace_id, agent_id, receipt, run_id, attempt_id, binding_revision,
             conversation_id, thread_id, from_position, through_position, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          receiptId,
          run.workspace_id,
          agentId,
          input.receipt,
          run.id,
          input.attemptId,
          run.binding_revision,
          input.conversationId,
          input.threadId,
          prior.position,
          frontier,
          timestamp,
          timestamp,
        );
        receiptRow = this.workspaceDatabase.raw.prepare(
          'SELECT * FROM agent_inbox_claim_receipts WHERE id = ?',
        ).get(receiptId) as unknown as AgentInboxClaimReceiptRow;
      } else if (frontier > receiptRow.through_position) {
        this.workspaceDatabase.raw.prepare(
          `UPDATE agent_inbox_claim_receipts
           SET through_position = ?, updated_at = ? WHERE id = ?`,
        ).run(frontier, timestamp, receiptRow.id);
        receiptRow = { ...receiptRow, through_position: frontier, updated_at: timestamp };
      }
      let requestOrder = Number((this.workspaceDatabase.raw.prepare(
        'SELECT COALESCE(MAX(request_order), -1) AS value FROM run_agent_requests WHERE workspace_id = ? AND run_id = ?',
      ).get(run.workspace_id, run.id) as { value: number }).value) + 1;
      for (const item of rows) {
        const request = this.requireAgentRequest(item.agent_request_id);
        invariant(request.target_agent_id === agentId, 'AGENT_INBOX_SCOPE_MISMATCH', 'Inbox item targets another Agent.', 409);
        if (request.status === 'pending') {
          const accepted = this.workspaceDatabase.raw.prepare(
            `UPDATE agent_requests
             SET status = 'accepted', version = version + 1, updated_at = ?, terminal_at = ?
             WHERE workspace_id = ? AND id = ? AND status = 'pending'`,
          ).run(timestamp, timestamp, run.workspace_id, request.id);
          invariant(accepted.changes === 1, 'AGENT_REQUEST_VERSION_CONFLICT', 'Inbox Agent Request changed.', 409);
        } else {
          invariant(
            request.status === 'accepted'
            && Boolean(this.workspaceDatabase.raw.prepare(
              'SELECT 1 FROM run_agent_requests WHERE workspace_id = ? AND run_id = ? AND agent_request_id = ?',
            ).get(run.workspace_id, run.id, request.id)),
            'AGENT_REQUEST_NOT_CLAIMABLE',
            'Inbox Agent Request is not claimable by this Run.',
            409,
          );
        }
        this.workspaceDatabase.raw.prepare(
          `INSERT OR IGNORE INTO run_agent_requests (
             workspace_id, run_id, agent_request_id, request_order, claimed_at
           ) VALUES (?, ?, ?, ?, ?)`,
        ).run(run.workspace_id, run.id, request.id, requestOrder, timestamp);
        requestOrder += 1;
        this.workspaceDatabase.raw.prepare(
          `UPDATE agent_inbox_items
           SET state = 'claimed', claimed_run_id = ?, claim_receipt = ?, claimed_at = ?
           WHERE workspace_id = ? AND id = ? AND state = 'pending'`,
        ).run(run.id, input.receipt, timestamp, run.workspace_id, item.id);
      }
      const claimed = this.workspaceDatabase.raw.prepare(
        `SELECT * FROM agent_inbox_items
         WHERE workspace_id = ? AND agent_id = ? AND claimed_run_id = ? AND claim_receipt = ?
         ORDER BY sequence`,
      ).all(run.workspace_id, agentId, run.id, input.receipt) as unknown as AgentInboxItemRow[];
      return this.hydrateInboxClaim(
        agentId,
        run.id,
        input.attemptId,
        input.receipt,
        target,
        claimed.length > 0 ? claimed : replayRows,
        receiptRow!,
      );
    });
  }

  readComputerAgentMessages(
    computerId: string,
    agentId: string,
    input: {
      attemptId: string;
      conversationId: string;
      threadId: string | null;
      before?: number;
      after?: number;
      limit?: number;
    },
  ): MessageView[] {
    const context = this.requireComputerAgentAttemptScope(computerId, agentId, input);
    invariant(input.before === undefined || input.after === undefined,
      'INVALID_MESSAGE_RANGE', 'Message history cannot use before and after together.', 400);
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const membership = this.requireMembership(context.workspace_id, agentId);
    const rows = input.before !== undefined
      ? this.workspaceDatabase.raw.prepare(
        `SELECT * FROM messages
         WHERE workspace_id = ? AND conversation_id = ? AND thread_id IS ? AND scope_position < ?
         ORDER BY scope_position DESC LIMIT ?`,
      ).all(context.workspace_id, input.conversationId, input.threadId, input.before, limit).reverse()
      : this.workspaceDatabase.raw.prepare(
        `SELECT * FROM messages
         WHERE workspace_id = ? AND conversation_id = ? AND thread_id IS ?
           AND scope_position > ?
         ORDER BY scope_position LIMIT ?`,
      ).all(context.workspace_id, input.conversationId, input.threadId, input.after ?? 0, limit);
    return (rows as unknown as MessageRow[]).map((row) => this.hydrateMessage(row, membership));
  }

  resolveComputerAgentMessage(
    computerId: string,
    agentId: string,
    input: { attemptId: string; conversationId: string; threadId: string | null; messageId: string },
  ): MessageView {
    const context = this.requireComputerAgentAttemptScope(computerId, agentId, input);
    const message = this.requireMessage(input.messageId);
    invariant(
      message.workspace_id === context.workspace_id
      && message.conversation_id === input.conversationId
      && message.thread_id === input.threadId,
      'MESSAGE_NOT_IN_DISCUSSION_SCOPE',
      'Message does not belong to the active Discussion Scope.',
      404,
    );
    return this.hydrateMessage(message, this.requireMembership(context.workspace_id, agentId));
  }

  sendComputerAgentMessage(
    computerId: string,
    agentId: string,
    input: {
      attemptId: string;
      conversationId: string;
      threadId: string | null;
      receipt: string;
      body: string;
    },
    idempotencyKey: string,
  ): MessageView {
    const context = this.requireComputerAgentAttemptScope(computerId, agentId, input);
    invariant(input.receipt.trim().length > 0, 'INBOX_RECEIPT_REQUIRED', 'Inbox receipt is required.', 400);
    const claim = this.workspaceDatabase.raw.prepare(
      `SELECT 1 FROM agent_inbox_items
       WHERE workspace_id = ? AND agent_id = ? AND claimed_run_id = ? AND claim_receipt = ?
         AND conversation_id = ? AND thread_id IS ? AND state = 'claimed'
       LIMIT 1`,
    ).get(
      context.workspace_id,
      agentId,
      context.run_id,
      input.receipt,
      input.conversationId,
      input.threadId,
    );
    invariant(claim, 'INBOX_RECEIPT_NOT_CLAIMED', 'Inbox receipt does not authorize this Discussion Scope.', 409);
    return this.idempotent(
      context.workspace_id,
      agentId,
      'SendAgentInboxMessage',
      idempotencyKey,
      input,
      () => this.publishAgentMessage(this.requireExecutionContext(input.attemptId), input.body, [], nowMs()),
    );
  }

  private hydrateInboxClaim(
    agentId: string,
    runId: string,
    attemptId: string,
    receiptToken: string,
    target: string,
    rows: AgentInboxItemRow[],
    receipt: AgentInboxClaimReceiptRow,
  ): AgentInboxClaimView {
    const membership = this.requireMembership(receipt.workspace_id, agentId);
    const discussionRows = this.workspaceDatabase.raw.prepare(
      `SELECT * FROM messages
       WHERE workspace_id = ? AND conversation_id = ? AND thread_id IS ?
         AND scope_position > ? AND scope_position <= ?
       ORDER BY scope_position, id`,
    ).all(
      receipt.workspace_id,
      receipt.conversation_id,
      receipt.thread_id,
      receipt.from_position,
      receipt.through_position,
    ) as unknown as MessageRow[];
    const rootMessage = receipt.thread_id === null
      ? null
      : this.workspaceDatabase.raw.prepare(
        `SELECT message.* FROM threads thread
         JOIN messages message
           ON message.workspace_id = thread.workspace_id AND message.id = thread.root_message_id
         WHERE thread.workspace_id = ? AND thread.conversation_id = ? AND thread.id = ?`,
      ).get(receipt.workspace_id, receipt.conversation_id, receipt.thread_id) as MessageRow | undefined;
    return {
      agentId,
      runId,
      attemptId,
      receipt: receiptToken,
      target,
      attention: rows.map((row) => ({
        inboxItemId: row.id,
        sequence: row.sequence,
        attentionKind: row.attention_kind,
        agentRequestId: row.agent_request_id,
        messageId: row.message_id,
      })),
      discussion: {
        conversationId: receipt.conversation_id,
        threadId: receipt.thread_id,
        sincePositionExclusive: receipt.from_position,
        throughPosition: receipt.through_position,
        rootMessage: rootMessage ? this.hydrateMessage(rootMessage, membership) : null,
        messages: discussionRows.map((row) => this.hydrateMessage(row, membership)),
      },
    };
  }

  private discussionFrontier(workspaceId: string, conversationId: string, threadId: string | null): number {
    if (threadId === null) {
      const conversation = this.workspaceDatabase.raw.prepare(
        'SELECT timeline_frontier FROM conversations WHERE workspace_id = ? AND id = ?',
      ).get(workspaceId, conversationId) as { timeline_frontier: number } | undefined;
      invariant(conversation, 'CONVERSATION_NOT_FOUND', 'Conversation does not exist.', 404);
      return conversation.timeline_frontier;
    }
    const thread = this.workspaceDatabase.raw.prepare(
      `SELECT reply_frontier FROM threads
       WHERE workspace_id = ? AND conversation_id = ? AND id = ?`,
    ).get(workspaceId, conversationId, threadId) as { reply_frontier: number } | undefined;
    invariant(thread, 'THREAD_NOT_FOUND', 'Thread does not exist.', 404);
    return thread.reply_frontier;
  }

  private requireComputerAgentBinding(computerId: string, agentId: string): void {
    const row = this.workspaceDatabase.raw.prepare(
      `SELECT 1 FROM agent_runtime_bindings
       WHERE computer_id = ? AND agent_id = ? AND status = 'active'`,
    ).get(computerId, agentId);
    invariant(row, 'RUNTIME_BINDING_UNAVAILABLE', 'Computer does not hold this Agent Runtime Binding.', 403);
  }

  private requireComputerAgentAttemptScope(
    computerId: string,
    agentId: string,
    input: { attemptId: string; conversationId: string; threadId: string | null },
  ): ExecutionContextRow {
    this.requireComputerAgentBinding(computerId, agentId);
    this.authorizeComputerForAttempt(computerId, input.attemptId);
    const context = this.requireExecutionContext(input.attemptId);
    invariant(context.agent_id === agentId, 'AGENT_INBOX_SCOPE_MISMATCH', 'Attempt belongs to another Agent.', 403);
    invariant(
      context.conversation_id === input.conversationId && context.result_thread_id === input.threadId,
      'AGENT_INBOX_SCOPE_MISMATCH',
      'Discussion Scope does not match the active Run.',
      409,
    );
    const run = this.requireRun(context.run_id);
    const attempt = this.requireAttempt(input.attemptId);
    invariant(run.status === 'active' && attempt.status === 'running', 'ATTEMPT_FENCED', 'Run or Attempt is no longer active.', 409);
    return context;
  }

  private inboxTarget(conversationId: string, threadId: string | null): string {
    return threadId === null
      ? `conversation:${conversationId}`
      : `conversation:${conversationId}:thread:${threadId}`;
  }

  bindAgentRuntime(
    principal: HumanPrincipal,
    workspaceId: string,
    agentId: string,
    input: RuntimeBindingUpdateInput,
    idempotencyKey: string,
  ): RuntimeBindingView {
    return this.idempotent(workspaceId, principal.actorId, 'BindAgentRuntime', idempotencyKey, input, () => {
      const membership = this.requireMembership(workspaceId, principal.actorId);
      const agent = this.requireAgentRow(workspaceId, agentId);
      invariant(
        membership.id === agent.owner_membership_id,
        'FORBIDDEN',
        'Only the current Agent Owner may bind its Runtime.',
        403,
      );
      const timestamp = nowMs();
      const binding = this.insertRuntimeBinding(
        principal.actorId,
        workspaceId,
        agentId,
        input,
        timestamp,
        input.expectedRevision,
      );
      this.appendAudit(workspaceId, principal.actorId, membership.id, 'agent.runtime.bind', 'agent', agentId, {
        computerId: input.computerId,
        runtimeId: input.runtimeId,
        runtimeConfiguration: binding.configuration.requested,
        bindingRevision: binding.bindingRevision,
      }, timestamp);
      return binding;
    });
  }

  authorizeComputerForAttempt(computerId: string, attemptId: string): void {
    const row = this.workspaceDatabase.raw
      .prepare(
        `SELECT 1
         FROM attempts a
         JOIN runs r ON r.workspace_id = a.workspace_id AND r.id = a.run_id
         JOIN agent_runtime_bindings b
           ON b.workspace_id = r.workspace_id AND b.id = r.binding_id
         WHERE a.id = ? AND b.computer_id = ?
           AND b.status = 'active'
           AND b.binding_revision = a.binding_revision AND a.binding_revision = r.binding_revision`,
      )
      .get(attemptId, computerId);
    invariant(row, 'ATTEMPT_NOT_FOUND', 'Attempt does not exist or is not assigned to this computer.', 404);
  }

  createConversation(
    principal: HumanPrincipal,
    workspaceId: string,
    input: { kind: ConversationKind; title?: string; directWorkspaceMembershipIds?: string[] },
    idempotencyKey: string,
  ): ConversationView {
    return this.idempotent(workspaceId, principal.actorId, 'CreateConversation', idempotencyKey, input, () => {
      const creator = this.requireMembership(workspaceId, principal.actorId);
      const directWorkspaceMembershipIds = input.kind === 'dm'
        ? [...new Set([creator.id, ...(input.directWorkspaceMembershipIds ?? [])])]
        : input.directWorkspaceMembershipIds ?? [];
      return this.insertConversation(
        principal,
        workspaceId,
        null,
        creator,
        null,
        input.kind,
        input.title,
        directWorkspaceMembershipIds,
      );
    });
  }

  createProjectConversation(
    principal: HumanPrincipal,
    projectId: string,
    input: { kind: 'channel'; title?: string },
    idempotencyKey: string,
  ): ConversationView {
    const project = this.requireProject(projectId);
    return this.idempotent(project.workspace_id, principal.actorId, 'CreateProjectConversation', idempotencyKey, input, () => {
      const access = this.requireProjectAccess(principal.actorId, projectId);
      return this.insertConversation(
        principal,
        project.workspace_id,
        projectId,
        access.workspaceMembership,
        access.projectMembership,
        input.kind,
        input.title,
        [],
      );
    });
  }

  getConversation(principal: HumanPrincipal, conversationId: string): ConversationView {
    const access = this.requireConversationAccess(principal.actorId, conversationId);
    return this.mapConversation(access.conversation);
  }

  archiveConversation(
    principal: HumanPrincipal,
    conversationId: string,
    expectedRevision: number,
    idempotencyKey: string,
  ): ConversationView {
    return this.transitionConversationLifecycle(
      principal, conversationId, 'active', 'archived', expectedRevision, idempotencyKey,
    );
  }

  restoreConversation(
    principal: HumanPrincipal,
    conversationId: string,
    expectedRevision: number,
    idempotencyKey: string,
  ): ConversationView {
    return this.transitionConversationLifecycle(
      principal, conversationId, 'archived', 'active', expectedRevision, idempotencyKey,
    );
  }

  listConversations(
    principal: HumanPrincipal,
    workspaceId: string,
    cursor?: string,
    limit = 100,
    lifecycleStatus: 'active' | 'archived' = 'active',
  ): Page<ConversationView> {
    const membership = this.requireMembership(workspaceId, principal.actorId);
    const pageCursor = this.requirePageCursor(cursor);
    const pageLimit = this.pageLimit(limit);
    const rows = this.workspaceDatabase.raw
      .prepare(
        `SELECT c.*
         FROM conversations c
         WHERE c.workspace_id = ? AND c.project_id IS NULL AND c.lifecycle_status = ?
           AND (
             c.conversation_kind = 'channel'
             OR (c.conversation_kind = 'dm'
               AND EXISTS (
                 SELECT 1 FROM conversation_direct_memberships direct
                 WHERE direct.workspace_id = c.workspace_id
                   AND direct.conversation_id = c.id
                   AND direct.membership_id = ?
               )
               AND 2 = (
               SELECT COUNT(*)
               FROM conversation_direct_memberships direct
               JOIN workspace_memberships dm_m
                 ON dm_m.workspace_id = direct.workspace_id
                AND dm_m.id = direct.membership_id
                AND dm_m.status = 'active'
               WHERE direct.workspace_id = c.workspace_id
                 AND direct.conversation_id = c.id
             ))
           )
           AND (? IS NULL OR c.updated_at < ? OR (c.updated_at = ? AND c.id < ?))
         ORDER BY c.updated_at DESC, c.id DESC LIMIT ?`,
      )
      .all(
        workspaceId,
        lifecycleStatus,
        membership.id,
        pageCursor?.createdAt ?? null,
        pageCursor?.createdAt ?? 0,
        pageCursor?.createdAt ?? 0,
        pageCursor?.id ?? '',
        pageLimit + 1,
      ) as unknown as Array<ConversationAccess['conversation']>;
    const hasMore = rows.length > pageLimit;
    const items = rows.slice(0, pageLimit).map((row) => this.mapConversation(row));
    const last = items.at(-1);
    return { items, nextCursor: hasMore && last ? encodePageCursor(last.updatedAt, last.id) : null };
  }

  listProjectConversations(
    principal: HumanPrincipal,
    projectId: string,
    cursor?: string,
    limit = 100,
    lifecycleStatus: 'active' | 'archived' = 'active',
  ): Page<ConversationView> {
    const access = this.requireProjectAccess(principal.actorId, projectId);
    const pageCursor = this.requirePageCursor(cursor);
    const pageLimit = this.pageLimit(limit);
    const rows = this.workspaceDatabase.raw
      .prepare(
        `SELECT c.*
         FROM conversations c
         WHERE c.workspace_id = ? AND c.project_id = ? AND c.conversation_kind = 'channel'
           AND c.lifecycle_status = ?
           AND (? IS NULL OR c.updated_at < ? OR (c.updated_at = ? AND c.id < ?))
         ORDER BY c.updated_at DESC, c.id DESC LIMIT ?`,
      )
      .all(
        access.project.workspace_id,
        projectId,
        lifecycleStatus,
        pageCursor?.createdAt ?? null,
        pageCursor?.createdAt ?? 0,
        pageCursor?.createdAt ?? 0,
        pageCursor?.id ?? '',
        pageLimit + 1,
      ) as unknown as Array<ConversationAccess['conversation']>;
    const hasMore = rows.length > pageLimit;
    const items = rows.slice(0, pageLimit).map((row) => this.mapConversation(row));
    const last = items.at(-1);
    return { items, nextCursor: hasMore && last ? encodePageCursor(last.updatedAt, last.id) : null };
  }

  postMessage(
    principal: HumanPrincipal,
    conversationId: string,
    input: {
      body: string;
      mentionedActorIds?: string[];
      artifactSelections?: Array<{ artifactId: string; snapshotId: string | null }>;
    },
    idempotencyKey: string,
  ): MessageView {
    const normalizedBody = input.body.trim();
    invariant(normalizedBody.length > 0, 'INVALID_MESSAGE', 'Message body is required.');
    const access = this.requireConversationAccess(principal.actorId, conversationId);
    const mentions = this.resolveMessageMentions(
      access,
      this.addImplicitDirectAgentTarget(access, this.normalizeMentionTargets(input.mentionedActorIds)),
    );
    const artifactSelections = input.artifactSelections ?? [];
    const result = this.idempotent(
      access.conversation.workspace_id,
      principal.actorId,
      'PostMessage',
      idempotencyKey,
      { body: normalizedBody, mentionedActorIds: mentions.map((mention) => mention.actor_id), artifactSelections },
      () => {
        const currentAccess = this.requireConversationAccess(principal.actorId, conversationId);
        this.requireConversationWritable(currentAccess.conversation);
        return {
          messageId: this.publishHumanMessage(currentAccess, normalizedBody, null, mentions, artifactSelections, nowMs()),
        };
      },
    );
    const currentAccess = this.requireConversationAccess(principal.actorId, conversationId);
    const message = this.hydrateMessage(this.requireMessage(result.messageId), currentAccess.membership);
    this.notifyAgentInboxChanged(result.messageId);
    return message;
  }

  replyToMessage(
    principal: HumanPrincipal,
    rootMessageId: string,
    input: {
      body: string;
      mentionedActorIds?: string[];
      artifactSelections?: Array<{ artifactId: string; snapshotId: string | null }>;
    },
    idempotencyKey: string,
  ): MessageView {
    const normalizedBody = input.body.trim();
    invariant(normalizedBody.length > 0, 'INVALID_MESSAGE', 'Message body is required.');
    const root = this.requireMessage(rootMessageId);
    invariant(root.thread_id === null, 'THREAD_ROOT_REQUIRED', 'Replies must target a top-level Message.', 409);
    const access = this.requireConversationAccess(principal.actorId, root.conversation_id);
    const mentions = this.resolveMessageMentions(
      access,
      this.addImplicitDirectAgentTarget(access, this.normalizeMentionTargets(input.mentionedActorIds)),
    );
    const artifactSelections = input.artifactSelections ?? [];
    const result = this.idempotent(
      access.conversation.workspace_id,
      principal.actorId,
      'ReplyToMessage',
      idempotencyKey,
      { rootMessageId, body: normalizedBody, mentionedActorIds: mentions.map((mention) => mention.actor_id), artifactSelections },
      () => {
        const currentRoot = this.requireMessage(rootMessageId);
        invariant(currentRoot.thread_id === null, 'THREAD_ROOT_REQUIRED', 'Replies must target a top-level Message.', 409);
        const currentAccess = this.requireConversationAccess(principal.actorId, currentRoot.conversation_id);
        this.requireConversationWritable(currentAccess.conversation);
        const timestamp = nowMs();
        const priorThread = this.workspaceDatabase.raw
          .prepare('SELECT id FROM threads WHERE workspace_id = ? AND conversation_id = ? AND root_message_id = ?')
          .get(currentRoot.workspace_id, currentRoot.conversation_id, rootMessageId) as { id: string } | undefined;
        const threadId = priorThread?.id ?? newId();
        if (!priorThread) {
          this.workspaceDatabase.raw
            .prepare('INSERT INTO threads (id, workspace_id, conversation_id, root_message_id, created_at) VALUES (?, ?, ?, ?, ?)')
            .run(threadId, currentRoot.workspace_id, currentRoot.conversation_id, rootMessageId, timestamp);
        }
        return {
          messageId: this.publishHumanMessage(currentAccess, normalizedBody, threadId, mentions, artifactSelections, timestamp),
        };
      },
    );
    const message = this.requireMessage(result.messageId);
    const currentAccess = this.requireConversationAccess(principal.actorId, message.conversation_id);
    const view = this.hydrateMessage(message, currentAccess.membership);
    this.notifyAgentInboxChanged(result.messageId);
    return view;
  }

  listMessages(principal: HumanPrincipal, conversationId: string, afterVersion = 0, limit = 100): MessageView[] {
    const access = this.requireConversationAccess(principal.actorId, conversationId);
    const rows = this.workspaceDatabase.raw
      .prepare(
        `SELECT * FROM messages
         WHERE workspace_id = ? AND conversation_id = ? AND conversation_version > ?
         ORDER BY conversation_version ASC LIMIT ?`,
      )
      .all(access.conversation.workspace_id, conversationId, afterVersion, Math.min(Math.max(limit, 1), 200)) as unknown as MessageRow[];
    return rows.map((row) => this.hydrateMessage(row, access.membership));
  }

  listConversationParticipants(principal: HumanPrincipal, conversationId: string): ConversationParticipantView[] {
    const access = this.requireConversationAccess(principal.actorId, conversationId);
    const rows = (access.conversation.conversation_kind === 'dm'
      ? this.workspaceDatabase.raw.prepare(
        `SELECT membership.id AS membership_id, NULL AS project_membership_id,
                membership.actor_id, actor.actor_type,
                COALESCE(human.display_name, agent.name) AS display_name,
                direct.joined_at
         FROM conversation_direct_memberships direct
         JOIN workspace_memberships membership
           ON membership.workspace_id = direct.workspace_id
          AND membership.id = direct.membership_id
          AND membership.status = 'active'
         JOIN actors actor ON actor.id = membership.actor_id
         LEFT JOIN humans human ON human.actor_id = membership.actor_id
         LEFT JOIN agents agent
           ON agent.workspace_id = membership.workspace_id AND agent.actor_id = membership.actor_id
         WHERE direct.workspace_id = ? AND direct.conversation_id = ?
         ORDER BY direct.joined_at, membership.id`,
      ).all(access.conversation.workspace_id, conversationId)
      : access.conversation.project_id === null
        ? this.workspaceDatabase.raw.prepare(
          `SELECT membership.id AS membership_id, NULL AS project_membership_id,
                  membership.actor_id, actor.actor_type,
                  COALESCE(human.display_name, agent.name) AS display_name,
                  membership.joined_at
           FROM workspace_memberships membership
           JOIN actors actor ON actor.id = membership.actor_id
           LEFT JOIN humans human ON human.actor_id = membership.actor_id
           LEFT JOIN agents agent
             ON agent.workspace_id = membership.workspace_id AND agent.actor_id = membership.actor_id
           WHERE membership.workspace_id = ? AND membership.status = 'active'
           ORDER BY membership.joined_at, membership.id`,
        ).all(access.conversation.workspace_id)
        : this.workspaceDatabase.raw.prepare(
          `SELECT membership.id AS membership_id,
                  project_membership.id AS project_membership_id,
                  membership.actor_id, actor.actor_type,
                  COALESCE(human.display_name, agent.name) AS display_name,
                  project_membership.joined_at
           FROM project_memberships project_membership
           JOIN workspace_memberships membership
             ON membership.workspace_id = project_membership.workspace_id
            AND membership.id = project_membership.workspace_membership_id
            AND membership.status = 'active'
           JOIN actors actor ON actor.id = membership.actor_id
           LEFT JOIN humans human ON human.actor_id = membership.actor_id
           LEFT JOIN agents agent
             ON agent.workspace_id = membership.workspace_id AND agent.actor_id = membership.actor_id
           WHERE project_membership.workspace_id = ?
             AND project_membership.project_id = ?
             AND project_membership.status = 'active'
           ORDER BY project_membership.joined_at, project_membership.id`,
        ).all(access.conversation.workspace_id, access.conversation.project_id)) as unknown as ConversationParticipantRow[];
    return rows.map((row) => ({
      workspaceMembershipId: row.membership_id,
      projectMembershipId: row.project_membership_id,
      actorId: row.actor_id,
      actorType: row.actor_type,
      displayName: row.display_name,
      joinedAt: row.joined_at,
    }));
  }

  getAgentRequest(principal: HumanPrincipal, agentRequestId: string): AgentRequestView {
    const row = this.requireAgentRequest(agentRequestId);
    this.requireConversationAccess(principal.actorId, row.result_conversation_id);
    return this.hydrateAgentRequest(row);
  }

  listAgentRequests(
    principal: HumanPrincipal,
    conversationId: string,
    threadId?: string,
    limit = 100,
  ): AgentRequestView[] {
    const access = this.requireConversationAccess(principal.actorId, conversationId);
    const rows = this.workspaceDatabase.raw
      .prepare(
        `SELECT ar.*, o.message_id AS source_message_id
         FROM agent_requests ar
         JOIN agent_mention_outcomes o ON o.workspace_id = ar.workspace_id AND o.id = ar.mention_outcome_id
         JOIN messages message ON message.workspace_id = o.workspace_id AND message.id = o.message_id
         WHERE ar.workspace_id = ? AND ar.result_conversation_id = ?
           AND (? IS NULL OR ar.result_thread_id = ?)
         ORDER BY message.conversation_version, o.target_order LIMIT ?`,
      )
      .all(
        access.conversation.workspace_id,
        conversationId,
        threadId ?? null,
        threadId ?? null,
        Math.min(Math.max(limit, 1), 200),
      ) as unknown as AgentRequestRow[];
    return rows.map((row) => this.hydrateAgentRequest(row));
  }

  cancelAgentRequest(
    principal: HumanPrincipal,
    agentRequestId: string,
    input: { expectedVersion: number },
    idempotencyKey: string,
  ): AgentRequestView {
    const existing = this.requireAgentRequest(agentRequestId);
    const result = this.idempotent(
      existing.workspace_id,
      principal.actorId,
      'CancelAgentRequest',
      idempotencyKey,
      { agentRequestId, expectedVersion: input.expectedVersion },
      () => {
        const current = this.requireAgentRequest(agentRequestId);
        const callerMembership = this.requireMembership(current.workspace_id, principal.actorId);
        const conversation = this.workspaceDatabase.raw
          .prepare('SELECT * FROM conversations WHERE workspace_id = ? AND id = ?')
          .get(current.workspace_id, current.result_conversation_id) as ConversationAccess['conversation'];
        const source = this.workspaceDatabase.raw
          .prepare('SELECT author_actor_id FROM messages WHERE workspace_id = ? AND id = ?')
          .get(current.workspace_id, current.source_message_id) as { author_actor_id: string };
        const requestorCancellation = source.author_actor_id === principal.actorId;
        invariant(
          requestorCancellation
          || callerMembership.membership_role === 'owner'
          || this.isCurrentAgentOwner(current.workspace_id, current.target_agent_id, callerMembership.id),
          'FORBIDDEN',
          'Only the requestor, current target Agent Owner, or a Workspace Owner may cancel this request.',
          403,
        );
        invariant(current.status === 'pending', 'AGENT_REQUEST_NOT_PENDING', 'Only a pending Agent Request can be cancelled.', 409);
        invariant(current.version === input.expectedVersion, 'AGENT_REQUEST_VERSION_CONFLICT', 'Agent Request version changed.', 409);
        const timestamp = nowMs();
        const reasonCode = requestorCancellation ? 'requestor_cancelled' : 'authority_revoked';
        const update = this.workspaceDatabase.raw
          .prepare(
            `UPDATE agent_requests
             SET status = 'cancelled', version = version + 1,
                 terminal_reason_code = ?, terminal_reason_detail = NULL,
                 updated_at = ?, terminal_at = ?
             WHERE workspace_id = ? AND id = ? AND status = 'pending' AND version = ?`,
          )
          .run(reasonCode, timestamp, timestamp, current.workspace_id, agentRequestId, input.expectedVersion);
        invariant(update.changes === 1, 'AGENT_REQUEST_VERSION_CONFLICT', 'Agent Request changed concurrently.', 409);
        this.markInboxRequestsHandled(current.workspace_id, [agentRequestId], timestamp);
        const conversationVersion = this.bumpConversationContext(current.result_conversation_id, null, timestamp);
        this.appendChange(
          current.workspace_id,
          null,
          current.result_conversation_id,
          conversationVersion,
          'agent_request_cancelled',
          'agent_request',
          agentRequestId,
          { reasonCode, resultThreadId: current.result_thread_id },
          timestamp,
          this.conversationChangeOptions(conversation),
        );
        this.enqueueDelivery(
          current.workspace_id,
          'agent-request.cancelled',
          'agent_request',
          agentRequestId,
          { agentRequestId, reason: reasonCode },
          `cancelled:${agentRequestId}:${reasonCode}`,
          timestamp,
        );
        this.appendAudit(
          current.workspace_id,
          principal.actorId,
          callerMembership.id,
          'agent_request.cancel',
          'agent_request',
          agentRequestId,
          { version: input.expectedVersion + 1 },
          timestamp,
        );
        return { agentRequestId };
      },
    );
    return this.hydrateAgentRequest(this.requireAgentRequest(result.agentRequestId));
  }

  followChanges(principal: HumanPrincipal, workspaceId: string, after = 0, limit = 100): ChangePage {
    const membership = this.requireMembership(workspaceId, principal.actorId);
    const pageLimit = this.pageLimit(limit);
    return this.workspaceDatabase.transaction(() => {
      const rows = this.workspaceDatabase.raw
        .prepare(
          `SELECT c.* FROM workspace_changes c
           JOIN workspace_change_recipients r
             ON r.workspace_id = c.workspace_id AND r.change_position = c.position
           WHERE c.workspace_id = ? AND c.position > ? AND r.membership_id = ?
           ORDER BY c.position ASC LIMIT ?`,
        )
        .all(workspaceId, after, membership.id, pageLimit + 1) as unknown as Array<Record<string, unknown>>;
      const hasMore = rows.length > pageLimit;
      const pageRows = rows.slice(0, pageLimit);
      const items = pageRows.map((row) => this.mapChange(row));
      if (hasMore) {
        return { items, nextCursor: items.at(-1)?.position ?? after };
      }
      const head = this.workspaceDatabase.raw
        .prepare('SELECT COALESCE(MAX(position), 0) AS position FROM workspace_changes WHERE workspace_id = ?')
        .get(workspaceId) as { position: number };
      return { items, nextCursor: Math.max(after, head.position) };
    });
  }

  acceptAgentRequest(
    computerId: string,
    agentRequestId: string,
    input: { expectedVersion: number; budget?: Partial<{ maxWallTimeMs: number; maxContextBytes: number; maxToolCalls: number }> },
    idempotencyKey: string,
  ): RunView {
    const existing = this.requireAgentRequest(agentRequestId);
    return this.idempotent(existing.workspace_id, existing.target_agent_id, 'AcceptAgentRequest', idempotencyKey, input, () => {
      const request = this.requireAgentRequest(agentRequestId);
      invariant(request.status === 'pending', 'AGENT_REQUEST_NOT_PENDING', 'Only a pending Agent Request can be accepted.', 409);
      invariant(request.version === input.expectedVersion, 'AGENT_REQUEST_VERSION_CONFLICT', 'Agent Request version changed.', 409);
      const agent = this.requireAgentRow(request.workspace_id, request.target_agent_id);
      invariant(agent.lifecycle_status === 'active', 'AGENT_NOT_EXECUTABLE', 'Agent is not active.', 409);
      const membership = this.requireMembership(request.workspace_id, request.target_agent_id);
      invariant(this.hasConversationAccess(request.workspace_id, request.result_conversation_id, membership.id),
        'RESULT_SCOPE_FORBIDDEN', 'Agent no longer has access to the result scope.', 403);
      const binding = this.workspaceDatabase.raw
        .prepare(
          `SELECT b.*, c.status AS computer_status, c.last_seen_at,
                  rc.availability AS runtime_availability, rc.configuration_json
           FROM agent_runtime_bindings b
           JOIN computers c ON c.id = b.computer_id
           LEFT JOIN computer_runtime_capabilities rc
             ON rc.computer_id = b.computer_id AND rc.runtime_id = b.runtime_id
           WHERE b.workspace_id = ? AND b.agent_id = ? AND b.computer_id = ? AND b.status = 'active'`,
        )
        .get(request.workspace_id, request.target_agent_id, computerId) as (Record<string, unknown> & {
          computer_status: 'active' | 'disabled';
          last_seen_at: number | null;
          runtime_availability: RuntimeCapabilityReport['availability'] | null;
          configuration_json: string | null;
          requested_model: string | null;
          requested_reasoning_effort: ReasoningEffort | null;
          requested_mode: string | null;
        }) | undefined;
      invariant(binding, 'RUNTIME_BINDING_UNAVAILABLE', 'The accepting Computer does not hold the active Runtime Binding.', 409);
      const acceptanceTime = nowMs();
      invariant(
        binding.computer_status === 'active'
        && binding.last_seen_at !== null
        && acceptanceTime - binding.last_seen_at <= COMPUTER_ONLINE_WINDOW_MS,
        'COMPUTER_OFFLINE',
        'The accepting Computer is no longer online.',
        409,
      );
      invariant(binding.runtime_availability === 'ready' && binding.configuration_json !== null,
        'RUNTIME_BINDING_UNAVAILABLE', 'The bound Runtime is no longer ready.', 409);
      this.validateRuntimeConfigurationSelection(
        JSON.parse(binding.configuration_json) as RuntimeConfigurationCapabilities,
        {
          model: binding.requested_model,
          reasoningEffort: binding.requested_reasoning_effort,
          mode: binding.requested_mode,
        },
      );
      const policyRow = this.requireLatestExecutionPolicy(request.workspace_id, request.target_agent_id);
      const policy = this.hydrateExecutionPolicy(policyRow);
      const budget = this.clampBudget(policy, input.budget);
      const sourceMessage = this.requireMessage(request.source_message_id);
      const conversation = this.workspaceDatabase.raw
        .prepare('SELECT * FROM conversations WHERE workspace_id = ? AND id = ?')
        .get(request.workspace_id, request.result_conversation_id) as ConversationAccess['conversation'];
      this.requireConversationWritable(conversation);
      const projectId = conversation.project_id === null ? null : String(conversation.project_id);
      const projectMembership = projectId
        ? this.findProjectMembership(request.workspace_id, projectId, membership.id)
        : null;
      invariant(
        projectId === null || projectMembership,
        'RESULT_SCOPE_FORBIDDEN',
        'Agent no longer belongs to the result Project.',
        403,
      );
      const project = projectId ? this.requireProject(projectId) : null;
      const projectRepository = projectId ? this.findActiveProjectRepository(projectId) : null;
      const projectExecution = projectId && projectRepository
        ? this.requireReadyProjectWorkingCopy(computerId, projectId)
        : null;
      const thread = request.result_thread_id === null ? null : this.workspaceDatabase.raw
        .prepare('SELECT * FROM threads WHERE workspace_id = ? AND conversation_id = ? AND id = ?')
        .get(request.workspace_id, request.result_conversation_id, request.result_thread_id) as Record<string, unknown> | undefined;
      invariant(request.result_thread_id === null || thread, 'RESULT_SCOPE_NOT_FOUND', 'Result Thread does not exist.', 404);
      const scope = this.discussionScope(request.result_conversation_id, request.result_thread_id, thread ? String(thread.root_message_id) : null);
      const triggerFrontier = { ...scope, position: sourceMessage.scope_position };
      const timestamp = acceptanceTime;
      const runId = newId();
      const deadlineAt = timestamp + budget.maxWallTimeMs;
      const update = this.workspaceDatabase.raw
        .prepare(
          `UPDATE agent_requests SET status = 'accepted', version = version + 1, updated_at = ?, terminal_at = ?
           WHERE workspace_id = ? AND id = ? AND status = 'pending' AND version = ?`,
        )
        .run(timestamp, timestamp, request.workspace_id, request.id, input.expectedVersion);
      invariant(update.changes === 1, 'AGENT_REQUEST_VERSION_CONFLICT', 'Agent Request changed concurrently.', 409);
      this.workspaceDatabase.raw
        .prepare(
          `INSERT INTO runs (
             id, workspace_id, agent_request_id, agent_id, agent_membership_id,
             project_id, agent_project_membership_id,
             binding_id, binding_revision, policy_version_id, effective_budget_json,
             status, deadline_at, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        )
        .run(
          runId, request.workspace_id, request.id, request.target_agent_id, membership.id,
          projectId, projectMembership?.id ?? null,
          String(binding.id), Number(binding.binding_revision), policy.id, canonicalJson(budget), deadlineAt, timestamp,
        );
      this.workspaceDatabase.raw.prepare(
        `INSERT INTO run_agent_requests (
           workspace_id, run_id, agent_request_id, request_order, claimed_at
         ) VALUES (?, ?, ?, 0, ?)`,
      ).run(request.workspace_id, runId, request.id, timestamp);
      const runSnapshotId = newId();
      const changeCursor = this.currentChangeCursor(request.workspace_id);
      this.workspaceDatabase.raw
        .prepare(
          `INSERT INTO run_context_snapshots (
             id, workspace_id, run_id, objective, trigger_message_id, mention_outcome_id,
             source_scope_json, result_scope_json, trigger_frontier_json, agent_membership_id,
             policy_version_id, effective_budget_json, workspace_context_version,
             project_id, project_context_version,
             repository_id, repository_identity, repository_base_commit,
             conversation_id,
             conversation_context_version, change_cursor, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          runSnapshotId, request.workspace_id, runId, 'Handle pending Agent Inbox messages.', sourceMessage.id,
          this.requireMentionOutcomeId(request.id), canonicalJson(scope), canonicalJson(scope),
          canonicalJson(triggerFrontier), membership.id, policy.id, canonicalJson(budget),
          Number(this.requireWorkspaceVersion(request.workspace_id)), projectId, project?.context_version ?? null,
          projectExecution?.repository.id ?? null,
          projectExecution?.repository.repository_identity ?? null,
          projectExecution?.headCommit ?? null,
          request.result_conversation_id,
          Number(conversation.context_version), changeCursor, timestamp,
        );
      const runSources: ContextSourceRef[] = [
        this.messageSourceRef(sourceMessage, 0, scope),
        {
          kind: 'conversation', sourceId: request.result_conversation_id,
          sourceVersion: String(conversation.context_version), sourceOrder: 1,
          contentDigest: sha256(canonicalJson({
            id: request.result_conversation_id,
            kind: conversation.conversation_kind,
            title: conversation.title,
          })),
          metadata: { scope },
        },
        ...(project ? [{
          kind: 'project' as const,
          sourceId: project.id,
          sourceVersion: String(project.context_version),
          sourceOrder: 2,
          contentDigest: sha256(canonicalJson({
            id: project.id,
            name: project.name,
            description: project.description,
            repositoryIdentity: projectExecution?.repository.repository_identity,
          })),
          metadata: {
            name: project.name,
            description: project.description,
            repositoryIdentity: projectExecution?.repository.repository_identity,
          },
        }] : []),
      ];
      this.insertRunContextSources(runSnapshotId, runSources);
      this.appendChange(request.workspace_id, null, request.result_conversation_id, Number(conversation.context_version),
        'agent_request_accepted', 'agent_request', request.id,
        { runId, resultThreadId: request.result_thread_id }, timestamp,
        { projectId, projectVersion: project?.context_version ?? null });
      this.appendAudit(
        request.workspace_id,
        request.target_agent_id,
        membership.id,
        'agent_request.accept',
        'run',
        runId,
        { agentRequestId: request.id, computerId, policyVersionId: policy.id, budget },
        timestamp,
      );
      return this.hydrateRun(this.requireRun(runId));
    });
  }

  createAttempt(computerId: string, runId: string, idempotencyKey: string): AttemptView {
    const existing = this.requireRun(runId);
    return this.idempotent(existing.workspace_id, existing.agent_id, 'CreateAttempt', idempotencyKey, { runId }, () => {
      const run = this.requireRun(runId);
      invariant(run.status === 'active', 'RUN_NOT_ACTIVE', 'Run is not active.', 409);
      this.authorizeComputerForRunRequest(computerId, runId);
      const pinned = this.getRunContextSnapshot(run.id);
      if (run.project_id && pinned.repositoryId) {
        const ready = this.requireReadyProjectWorkingCopy(computerId, run.project_id);
        invariant(
          pinned.repositoryId === ready.repository.id
          && pinned.repositoryIdentity === ready.repository.repository_identity,
          'PROJECT_REPOSITORY_MISMATCH',
          'The Computer Working Copy no longer matches the Run Repository.',
          409,
        );
      }
      invariant(run.deadline_at > nowMs(), 'RUN_DEADLINE_EXCEEDED', 'Run deadline has been exceeded.', 409);
      const policy = this.hydrateExecutionPolicy(this.requirePolicyById(run.policy_version_id));
      const activeForAgent = this.workspaceDatabase.raw
        .prepare(
          `SELECT COUNT(*) AS count
           FROM attempts a
           JOIN runs r ON r.workspace_id = a.workspace_id AND r.id = a.run_id
           WHERE a.workspace_id = ? AND r.agent_id = ? AND a.status = 'running'`,
        )
        .get(run.workspace_id, run.agent_id) as { count: number };
      invariant(activeForAgent.count < policy.maxParallelAttempts, 'AGENT_ATTEMPT_CAPACITY_EXCEEDED',
        'The Agent has reached the parallel Attempt limit pinned by this Run policy.', 409);
      const activeCount = this.workspaceDatabase.raw
        .prepare("SELECT COUNT(*) AS count FROM attempts WHERE workspace_id = ? AND run_id = ? AND status = 'running'")
        .get(run.workspace_id, run.id) as { count: number };
      invariant(activeCount.count === 0, 'ACTIVE_ATTEMPT_EXISTS', 'The Run already has an active Attempt.', 409);
      const prior = this.workspaceDatabase.raw
        .prepare('SELECT COALESCE(MAX(attempt_number), 0) AS number FROM attempts WHERE workspace_id = ? AND run_id = ?')
        .get(run.workspace_id, run.id) as { number: number };
      const timestamp = nowMs();
      const attemptId = newId();
      const deadlineAt = Math.min(run.deadline_at, timestamp + this.parseBudget(run.effective_budget_json).maxWallTimeMs);
      this.workspaceDatabase.raw
        .prepare(
          `INSERT INTO attempts (
             id, workspace_id, run_id, attempt_number, status, binding_revision,
             policy_version_id, effective_budget_json, deadline_at, created_at
           ) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)`,
        )
        .run(
          attemptId, run.workspace_id, run.id, prior.number + 1, run.binding_revision,
          run.policy_version_id, run.effective_budget_json, deadlineAt, timestamp,
        );
      this.appendAudit(
        run.workspace_id,
        run.agent_id,
        run.agent_membership_id,
        'run.attempt.create',
        'attempt',
        attemptId,
        { runId: run.id, attemptNumber: prior.number + 1, computerId },
        timestamp,
      );
      return this.hydrateAttempt(this.requireAttempt(attemptId));
    });
  }

  getRunContextSnapshot(runId: string): RunContextSnapshotView {
    const row = this.workspaceDatabase.raw
      .prepare('SELECT * FROM run_context_snapshots WHERE run_id = ?')
      .get(runId) as Record<string, unknown> | undefined;
    invariant(row, 'RUN_CONTEXT_SNAPSHOT_NOT_FOUND', 'Run Context Snapshot does not exist.', 404);
    return this.hydrateRunContextSnapshot(row);
  }

  getAttemptExecutionInput(computerId: string, attemptId: string): AttemptExecutionInputView {
    this.authorizeComputerForAttempt(computerId, attemptId);
    const context = this.requireExecutionContext(attemptId);
    const attempt = this.requireAttempt(attemptId);
    const runContext = this.getRunContextSnapshot(context.run_id);
    if (runContext.projectId && runContext.repositoryId) {
      const ready = this.requireReadyProjectWorkingCopy(computerId, runContext.projectId);
      invariant(
        runContext.repositoryId === ready.repository.id
        && runContext.repositoryIdentity === ready.repository.repository_identity
        && runContext.repositoryBaseCommit !== null,
        'PROJECT_REPOSITORY_MISMATCH',
        'The Computer Working Copy no longer matches the Run Repository.',
        409,
      );
    }
    const binding = this.workspaceDatabase.raw
      .prepare(
        `SELECT b.runtime_id, b.binding_revision, b.requested_model, b.requested_reasoning_effort, b.requested_mode
         FROM runs r
         JOIN agent_runtime_bindings b
           ON b.workspace_id = r.workspace_id AND b.id = r.binding_id
         WHERE r.id = ? AND b.computer_id = ?
           AND b.status = 'active' AND b.binding_revision = r.binding_revision`,
      )
      .get(context.run_id, computerId) as {
        runtime_id: RuntimeId;
        binding_revision: number;
        requested_model: string | null;
        requested_reasoning_effort: ReasoningEffort | null;
        requested_mode: string | null;
      } | undefined;
    invariant(binding, 'RUNTIME_BINDING_UNAVAILABLE', 'The Attempt Runtime Binding is unavailable.', 409);
    return {
      workspaceId: context.workspace_id,
      agentId: context.agent_id,
      runId: context.run_id,
      attemptId,
      deadlineAt: attempt.deadline_at,
      runtimeId: binding.runtime_id,
      runtimeBindingRevision: binding.binding_revision,
      runtimeConfiguration: {
        model: binding.requested_model,
        reasoningEffort: binding.requested_reasoning_effort,
        mode: binding.requested_mode,
      },
      executionScope: runContext.repositoryId === null
        ? { kind: 'workspace_scratch' }
        : {
            kind: 'project_repository',
            projectId: runContext.projectId!,
            repositoryId: runContext.repositoryId!,
            repositoryIdentity: runContext.repositoryIdentity!,
            baseCommit: runContext.repositoryBaseCommit!,
          },
      runContext,
      developerInstructions: this.renderDeveloperInstructions(context.agent_id),
    };
  }

  createPrivateContextGrant(
    principal: HumanPrincipal,
    runId: string,
    input: { sourceCategory: PrivateContextGrantView['sourceCategory']; readAllowed: boolean; disclosureAllowed: boolean; expiresAt: number },
    idempotencyKey: string,
  ): PrivateContextGrantView {
    const existing = this.requireRun(runId);
    return this.idempotent(existing.workspace_id, principal.actorId, 'CreatePrivateContextGrant', idempotencyKey, input, () => {
      const run = this.requireRun(runId);
      invariant(run.status === 'active', 'RUN_NOT_ACTIVE', 'Private Context may only be granted to an active Run.', 409);
      const membership = this.requireMembership(run.workspace_id, principal.actorId);
      invariant(
        this.isCurrentAgentOwner(run.workspace_id, run.agent_id, membership.id),
        'FORBIDDEN',
        'Only the current Agent Owner may grant Private Context.',
        403,
      );
      const policy = this.hydrateExecutionPolicy(this.requirePolicyById(run.policy_version_id));
      invariant(policy.privateContextAllowed, 'PRIVATE_CONTEXT_DISABLED', 'The accepted Execution Policy does not allow Private Context.', 409);
      invariant(input.readAllowed, 'PRIVATE_CONTEXT_READ_REQUIRED', 'A Private Context Grant must grant read access.');
      invariant(input.expiresAt > nowMs() && input.expiresAt <= run.deadline_at,
        'INVALID_PRIVATE_CONTEXT_EXPIRY', 'Private Context Grant expiry must be in the future and no later than the Run deadline.');
      const grantId = newId();
      const timestamp = nowMs();
      this.workspaceDatabase.raw
        .prepare(
          `INSERT INTO private_context_grants (
             id, workspace_id, run_id, granted_by_membership_id, source_category,
             read_allowed, disclosure_allowed, policy_version_id, expires_at, created_at
           ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
        )
        .run(
          grantId, run.workspace_id, run.id, membership.id, input.sourceCategory,
          input.disclosureAllowed ? 1 : 0, run.policy_version_id, input.expiresAt, timestamp,
        );
      this.appendAudit(
        run.workspace_id,
        principal.actorId,
        membership.id,
        'private_context.grant',
        'private_context_grant',
        grantId,
        {
          runId: run.id,
          sourceCategory: input.sourceCategory,
          readAllowed: true,
          disclosureAllowed: input.disclosureAllowed,
          expiresAt: input.expiresAt,
        },
        timestamp,
      );
      return this.hydratePrivateGrant(this.requirePrivateGrant(grantId));
    });
  }

  listPrivateContextGrants(principal: HumanPrincipal, runId: string): PrivateContextGrantView[] {
    const run = this.requireRun(runId);
    const membership = this.requireMembership(run.workspace_id, principal.actorId);
    const request = this.requireAgentRequest(run.agent_request_id);
    invariant(
      this.isCurrentAgentOwner(run.workspace_id, run.agent_id, membership.id)
      || this.hasConversationAccess(run.workspace_id, request.result_conversation_id, membership.id),
      'RUN_NOT_FOUND', 'Run does not exist or is not accessible.', 404,
    );
    return (this.workspaceDatabase.raw
      .prepare('SELECT * FROM private_context_grants WHERE workspace_id = ? AND run_id = ? ORDER BY created_at, id')
      .all(run.workspace_id, runId) as unknown as PrivateGrantRow[])
      .map((row) => this.hydratePrivateGrant(row));
  }

  revokePrivateContextGrant(
    principal: HumanPrincipal,
    grantId: string,
    idempotencyKey: string,
  ): PrivateContextGrantView {
    const existing = this.requirePrivateGrant(grantId);
    return this.idempotent(existing.workspace_id, principal.actorId, 'RevokePrivateContextGrant', idempotencyKey, { grantId }, () => {
      const grant = this.requirePrivateGrant(grantId);
      const membership = this.requireMembership(grant.workspace_id, principal.actorId);
      const run = this.requireRun(grant.run_id);
      invariant(
        membership.id === grant.granted_by_membership_id
        || this.isCurrentAgentOwner(grant.workspace_id, run.agent_id, membership.id),
        'FORBIDDEN',
        'Only the grantor or the current Agent Owner may revoke this grant.',
        403,
      );
      if (grant.revoked_at === null) {
        const timestamp = nowMs();
        this.workspaceDatabase.raw.prepare('UPDATE private_context_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
          .run(timestamp, grantId);
        this.appendAudit(
          grant.workspace_id,
          principal.actorId,
          membership.id,
          'private_context.revoke',
          'private_context_grant',
          grant.id,
          { runId: grant.run_id },
          timestamp,
        );
      }
      return this.hydratePrivateGrant(this.requirePrivateGrant(grantId));
    });
  }

  recordContextRead(
    computerId: string,
    attemptId: string,
    input: { source: ContextSourceRef; privateGrantId?: string; purpose: string },
  ): RuntimeContextReadView {
    this.validateSourceRef(input.source, input.privateGrantId !== undefined);
    const purpose = input.purpose.trim();
    invariant(purpose.length > 0 && purpose.length <= 500, 'INVALID_CONTEXT_READ_PURPOSE', 'Context read purpose is required.');
    return this.workspaceDatabase.transaction(() => {
      this.authorizeComputerForAttempt(computerId, attemptId);
      const context = this.requireExecutionContext(attemptId);
      let authorizationPath: 'snapshot' | 'private_grant' = 'snapshot';
      let grantId: string | null = null;
      if (input.privateGrantId) {
        const grant = this.requirePrivateGrant(input.privateGrantId);
        invariant(grant.workspace_id === context.workspace_id && grant.run_id === context.run_id,
          'PRIVATE_CONTEXT_GRANT_MISMATCH', 'Private Context Grant does not belong to this Run.', 403);
        invariant(grant.revoked_at === null && grant.read_allowed === 1 && grant.expires_at > nowMs(),
          'PRIVATE_CONTEXT_GRANT_INACTIVE', 'Private Context Grant is revoked, expired, or unreadable.', 403);
        authorizationPath = 'private_grant';
        grantId = grant.id;
      } else {
        invariant(this.sourceExistsInRunContext(context.run_context_snapshot_id, input.source),
          'CONTEXT_SOURCE_NOT_AUTHORIZED', 'Source is not present in the Run Context.', 403);
      }
      const id = newId();
      const timestamp = nowMs();
      this.workspaceDatabase.raw
        .prepare(
          `INSERT INTO runtime_context_reads (
             id, workspace_id, run_id, attempt_id, source_kind, source_id, source_version,
             content_digest, metadata_json, agent_membership_id, private_grant_id,
             authorization_path, purpose, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id, context.workspace_id, context.run_id, attemptId, input.source.kind, input.source.sourceId,
          input.source.sourceVersion, input.source.contentDigest, canonicalJson(input.source.metadata),
          context.agent_membership_id, grantId, authorizationPath, purpose, timestamp,
        );
      return {
        id, workspaceId: context.workspace_id, runId: context.run_id, attemptId,
        source: input.source, agentMembershipId: context.agent_membership_id,
        privateGrantId: grantId, purpose, createdAt: timestamp,
      };
    });
  }

  stageAttemptBlob(computerId: string, attemptId: string, stored: StoredContentBlob) {
    this.authorizeComputerForAttempt(computerId, attemptId);
    const context = this.requireExecutionContext(attemptId);
    const run = this.requireRun(context.run_id);
    const attempt = this.requireAttempt(attemptId);
    invariant(run.status === 'active' && attempt.status === 'running', 'ATTEMPT_FENCED', 'Run or Attempt is no longer active.', 409);
    return this.artifacts.registerStagedBlob({
      workspaceId: context.workspace_id,
      actorId: context.agent_id,
      membershipId: context.agent_membership_id,
      runId: context.run_id,
      attemptId,
    }, stored);
  }

  returnAttempt(
    computerId: string,
    attemptId: string,
    envelope: RuntimeReturnEnvelope,
    idempotencyKey: string,
  ): RuntimeReturnResult {
    const context = this.requireExecutionContext(attemptId);
    this.authorizeComputerForAttempt(computerId, attemptId);
    this.localExecutions.beginReturn(attemptId);
    const result = this.idempotent(context.workspace_id, context.agent_id, 'ReturnAttempt', idempotencyKey, envelope, () => {
      const current = this.requireExecutionContext(attemptId);
      const run = this.requireRun(current.run_id);
      const attempt = this.requireAttempt(attemptId);
      invariant(run.status === 'active' && attempt.status === 'running', 'ATTEMPT_FENCED', 'Run or Attempt is no longer active.', 409);
      invariant(nowMs() <= run.deadline_at && nowMs() <= attempt.deadline_at,
        'ATTEMPT_DEADLINE_EXCEEDED', 'Run or Attempt deadline has been exceeded.', 409);
      const directMessageRows = this.workspaceDatabase.raw.prepare(
        'SELECT * FROM messages WHERE workspace_id = ? AND producing_attempt_id = ? ORDER BY created_at, id',
      ).all(current.workspace_id, attemptId) as unknown as MessageRow[];
      const hasPublications = directMessageRows.length > 0
        || envelope.messages.length > 0
        || envelope.artifactPublications.length > 0;
      invariant((envelope.disposition === 'publish') === hasPublications,
        'INVALID_RETURN_ENVELOPE', 'publish requires a Message or Artifact publication and other dispositions forbid them.');
      if (envelope.disposition === 'publish') {
        const agent = this.requireAgentRow(current.workspace_id, current.agent_id);
        invariant(agent.lifecycle_status === 'active', 'ATTEMPT_FENCED', 'The producing Agent is no longer active.', 409);
        const membership = this.requireMembership(current.workspace_id, current.agent_id);
        invariant(membership.id === current.agent_membership_id
          && this.hasConversationAccess(current.workspace_id, current.conversation_id, membership.id),
        'ATTEMPT_FENCED', 'The producing Agent no longer has permission to publish to this Discussion Scope.', 409);
      }
      this.validateReturnDisclosure(current.run_id, envelope);
      const timestamp = nowMs();
      const publishedArtifacts = envelope.artifactPublications.map((publication) =>
        this.artifacts.publishFromAgent({
          workspaceId: current.workspace_id,
          actorId: current.agent_id,
          membershipId: current.agent_membership_id,
          runId: current.run_id,
          attemptId,
        }, publication));
      const publishedMessages = [
        ...directMessageRows.map((row) => this.hydrateMessage(
          row,
          this.requireMembership(current.workspace_id, current.agent_id),
        )),
        ...envelope.messages.map((draft, messageIndex) => {
        const artifactSnapshotIds = envelope.artifactPublications.flatMap((publication, publicationIndex) => {
          const indexes = publication.attachToMessageIndexes ?? [];
          invariant(indexes.every((index) => Number.isSafeInteger(index) && index >= 0 && index < envelope.messages.length),
            'INVALID_ARTIFACT_MESSAGE_REFERENCE', 'Artifact publication references an invalid Message index.');
          const snapshotId = publishedArtifacts[publicationIndex]?.latestSnapshot?.snapshotId;
          return indexes.includes(messageIndex) && snapshotId ? [snapshotId] : [];
        });
        return this.publishAgentMessage(current, draft.body, artifactSnapshotIds, timestamp);
        }),
      ];
      this.workspaceDatabase.raw
        .prepare(
          `INSERT INTO run_return_records (
             id, workspace_id, run_id, attempt_id,
             disposition, publication_results_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          newId(), current.workspace_id, current.run_id, attemptId,
          envelope.disposition, canonicalJson(publishedArtifacts.map((artifact) => ({
            artifactId: artifact.id,
            artifactSnapshotId: artifact.latestSnapshot?.snapshotId ?? null,
          }))), timestamp,
        );
      const runUpdate = this.workspaceDatabase.raw
        .prepare(
          `UPDATE runs SET status = 'terminal', outcome = ?, terminal_at = ?
           WHERE workspace_id = ? AND id = ? AND status = 'active'`,
        )
        .run(envelope.disposition, timestamp, current.workspace_id, current.run_id);
      invariant(runUpdate.changes === 1, 'RUN_ALREADY_TERMINAL', 'Run became terminal concurrently.', 409);
      this.workspaceDatabase.raw
        .prepare("UPDATE attempts SET status = 'finished', finished_at = ? WHERE id = ? AND status = 'running'")
        .run(timestamp, attemptId);
      this.workspaceDatabase.raw
        .prepare(
          `UPDATE agent_inbox_items
           SET state = 'handled', handled_at = ?
           WHERE workspace_id = ? AND claimed_run_id = ? AND state = 'claimed'`,
        )
        .run(timestamp, current.workspace_id, current.run_id);
      const conversation = this.workspaceDatabase.raw
        .prepare('SELECT context_version FROM conversations WHERE workspace_id = ? AND id = ?')
        .get(current.workspace_id, current.conversation_id) as { context_version: number };
      this.appendChange(
        current.workspace_id,
        null,
        current.conversation_id,
        conversation.context_version,
        'run_terminal',
        'agent_request',
        run.agent_request_id,
        { runId: run.id, attemptId, outcome: envelope.disposition },
        timestamp,
        current.project_id ? {
          projectId: current.project_id,
          projectVersion: this.requireProject(current.project_id).context_version,
        } : {},
      );
      this.appendAudit(
        current.workspace_id,
        current.agent_id,
        current.agent_membership_id,
        'run.return',
        'run',
        run.id,
        {
          attemptId,
          disposition: envelope.disposition,
          messageCount: publishedMessages.length,
          artifactCount: publishedArtifacts.length,
        },
        timestamp,
      );
      return {
        run: this.hydrateRun(this.requireRun(current.run_id)),
        attempt: this.hydrateAttempt(this.requireAttempt(attemptId)),
        publishedMessages,
        publishedArtifacts,
      };
    });
    this.localExecutions.finish(attemptId);
    return result;
  }

  failAttempt(
    computerId: string,
    attemptId: string,
    reason: string,
    idempotencyKey: string,
  ): RuntimeFailureResult {
    const normalizedReason = reason.trim().slice(0, 2000);
    invariant(normalizedReason.length > 0, 'ATTEMPT_FAILURE_REASON_REQUIRED', 'Attempt failure reason is required.');
    const context = this.requireExecutionContext(attemptId);
    this.authorizeComputerForAttempt(computerId, attemptId);
    const result = this.idempotent(
      context.workspace_id,
      context.agent_id,
      'FailAttempt',
      idempotencyKey,
      { attemptId, reason: normalizedReason },
      () => {
        const current = this.requireExecutionContext(attemptId);
        const run = this.requireRun(current.run_id);
        const attempt = this.requireAttempt(attemptId);
        invariant(run.status === 'active' && attempt.status === 'running',
          'ATTEMPT_FENCED', 'Run or Attempt is no longer active.', 409);
        const timestamp = nowMs();
        const runUpdate = this.workspaceDatabase.raw
          .prepare(
            `UPDATE runs SET status = 'terminal', outcome = 'failed', terminal_at = ?
             WHERE workspace_id = ? AND id = ? AND status = 'active'`,
          )
          .run(timestamp, current.workspace_id, current.run_id);
        invariant(runUpdate.changes === 1, 'RUN_ALREADY_TERMINAL', 'Run became terminal concurrently.', 409);
        const attemptUpdate = this.workspaceDatabase.raw
          .prepare("UPDATE attempts SET status = 'failed', finished_at = ? WHERE id = ? AND status = 'running'")
          .run(timestamp, attemptId);
        invariant(attemptUpdate.changes === 1, 'ATTEMPT_FENCED', 'Attempt became terminal concurrently.', 409);
        this.markRunInboxHandled(current.workspace_id, current.run_id, timestamp);
        const conversation = this.workspaceDatabase.raw
          .prepare('SELECT context_version FROM conversations WHERE workspace_id = ? AND id = ?')
          .get(current.workspace_id, current.conversation_id) as { context_version: number };
        this.appendChange(
          current.workspace_id,
          null,
          current.conversation_id,
          conversation.context_version,
          'run_terminal',
          'agent_request',
          run.agent_request_id,
          { runId: run.id, attemptId, outcome: 'failed' },
          timestamp,
          current.project_id ? {
            projectId: current.project_id,
            projectVersion: this.requireProject(current.project_id).context_version,
          } : {},
        );
        this.appendAudit(
          current.workspace_id,
          current.agent_id,
          current.agent_membership_id,
          'run.fail',
          'run',
          run.id,
          { attemptId, reason: normalizedReason },
          timestamp,
        );
        return {
          run: this.hydrateRun(this.requireRun(current.run_id)),
          attempt: this.hydrateAttempt(this.requireAttempt(attemptId)),
        };
      },
    );
    this.localExecutions.cancelIfPresent(attemptId);
    return result;
  }

  verifyAuditChain(workspaceId: string): boolean {
    const rows = this.workspaceDatabase.raw
      .prepare('SELECT * FROM audit_events WHERE workspace_id = ? ORDER BY seq')
      .all(workspaceId) as unknown as Array<Record<string, unknown>>;
    let previous = '0'.repeat(64);
    for (const row of rows) {
      if (row.prev_hash !== previous) return false;
      const calculated = this.auditHash({
        workspaceId,
        seq: Number(row.seq),
        prevHash: String(row.prev_hash),
        actorId: String(row.actor_id),
        actorMembershipId: row.actor_membership_id ? String(row.actor_membership_id) : null,
        action: String(row.action),
        targetType: String(row.target_type),
        targetId: String(row.target_id),
        detailsJson: String(row.details_json),
        createdAt: Number(row.created_at),
      });
      if (row.hash !== calculated) return false;
      previous = calculated;
    }
    return true;
  }

  private normalizeEmail(email: string): string {
    const normalized = email.trim().toLowerCase();
    invariant(
      normalized.length >= 3
      && normalized.length <= 320
      && normalized.indexOf('@') > 0
      && normalized.indexOf('@') < normalized.length - 1,
      'INVALID_VERIFIED_EMAIL',
      'A valid verified email is required.',
    );
    return normalized;
  }

  private normalizeProjectDescription(description: string | null | undefined): string | null {
    const normalized = description?.trim() || null;
    invariant(normalized === null || normalized.length <= 3000,
      'INVALID_PROJECT_DESCRIPTION', 'Project description is too long.');
    return normalized;
  }

  private pageLimit(limit: number): number {
    return Math.min(Math.max(Math.trunc(limit), 1), 200);
  }

  private requirePageCursor(cursor?: string): { createdAt: number; id: string } | null {
    const decoded = decodePageCursor(cursor);
    invariant(cursor === undefined || decoded !== null, 'INVALID_CURSOR', 'Pagination cursor is invalid.');
    return decoded;
  }

  private mapWorkspace(row: {
    id: string;
    name: string;
    revision: number;
    context_version: number;
    created_at: number;
    updated_at: number;
    membership_id: string;
    membership_role: MembershipRole;
  }): WorkspaceView {
    return {
      id: row.id,
      name: row.name,
      revision: row.revision,
      contextVersion: row.context_version,
      membershipId: row.membership_id,
      membershipRole: row.membership_role,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private requireWorkspaceOwner(workspaceId: string, actorId: string): MembershipRow {
    const membership = this.requireMembership(workspaceId, actorId);
    const human = this.workspaceDatabase.raw.prepare("SELECT 1 FROM actors WHERE id = ? AND actor_type = 'human'").get(actorId);
    invariant(human && membership.membership_role === 'owner', 'WORKSPACE_OWNER_REQUIRED', 'A current Workspace Owner is required.', 403);
    return membership;
  }

  private listWorkspaceOwnerMembershipIds(workspaceId: string): string[] {
    return this.workspaceDatabase.raw
      .prepare(
        `SELECT m.id
         FROM workspace_memberships m
         JOIN actors a ON a.id = m.actor_id AND a.actor_type = 'human'
         WHERE m.workspace_id = ? AND m.status = 'active' AND m.membership_role = 'owner'`,
      )
      .all(workspaceId)
      .map((row) => String((row as { id: string }).id));
  }

  private requireAgentOwner(workspaceId: string, agentId: string, actorId: string): MembershipRow {
    const membership = this.requireMembership(workspaceId, actorId);
    const agent = this.requireAgentRow(workspaceId, agentId);
    invariant(
      membership.id === agent.owner_membership_id,
      'AGENT_OWNER_REQUIRED',
      'The current Agent Owner is required.',
      403,
    );
    return membership;
  }

  private isCurrentAgentOwner(workspaceId: string, agentId: string | null, membershipId: string): boolean {
    if (!agentId) return false;
    return Boolean(this.workspaceDatabase.raw
      .prepare('SELECT 1 FROM agents WHERE workspace_id = ? AND actor_id = ? AND owner_membership_id = ?')
      .get(workspaceId, agentId, membershipId));
  }

  private requireInvitation(invitationId: string): InvitationRow {
    const row = this.workspaceDatabase.raw.prepare('SELECT * FROM workspace_invitations WHERE id = ?').get(invitationId) as
      | InvitationRow
      | undefined;
    invariant(row, 'INVITATION_NOT_FOUND', 'Invitation does not exist.', 404);
    return row;
  }

  private mapInvitation(row: InvitationRow): WorkspaceInvitationView {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      verifiedEmail: row.verified_email,
      membershipRole: row.membership_role,
      status: row.status,
      revision: row.revision,
      invitedByMembershipId: row.invited_by_membership_id,
      acceptedMembershipId: row.accepted_membership_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      terminalAt: row.terminal_at,
    };
  }

  private requireHumanMembership(workspaceId: string, membershipId: string): MembershipRow {
    const row = this.workspaceDatabase.raw
      .prepare(
        `SELECT m.*
         FROM workspace_memberships m
         JOIN actors a ON a.id = m.actor_id AND a.actor_type = 'human'
         WHERE m.workspace_id = ? AND m.id = ? AND m.status = 'active'`,
      )
      .get(workspaceId, membershipId) as MembershipRow | undefined;
    invariant(row, 'HUMAN_MEMBERSHIP_NOT_FOUND', 'Active Human Membership does not exist.', 404);
    return row;
  }

  private getWorkspaceMember(workspaceId: string, membershipId: string): WorkspaceMemberView {
    const row = this.workspaceDatabase.raw
      .prepare(
        `SELECT m.id AS membership_id, m.actor_id, a.actor_type,
                COALESCE(h.display_name, ag.name) AS display_name,
                m.membership_role, m.revision, m.joined_at
         FROM workspace_memberships m
         JOIN actors a ON a.id = m.actor_id
         LEFT JOIN humans h ON h.actor_id = m.actor_id
         LEFT JOIN agents ag ON ag.actor_id = m.actor_id
         WHERE m.workspace_id = ? AND m.id = ? AND m.status = 'active'`,
      )
      .get(workspaceId, membershipId) as
      | {
          membership_id: string;
          actor_id: string;
          actor_type: 'human' | 'agent';
          display_name: string;
          membership_role: MembershipRole;
          revision: number;
          joined_at: number;
        }
      | undefined;
    invariant(row, 'MEMBERSHIP_NOT_FOUND', 'Active Workspace Membership does not exist.', 404);
    return this.mapWorkspaceMember(row);
  }

  private mapWorkspaceMember(row: {
    membership_id: string;
    actor_id: string;
    actor_type: 'human' | 'agent';
    display_name: string;
    membership_role: MembershipRole;
    revision: number;
    joined_at: number;
  }): WorkspaceMemberView {
    return {
      membershipId: row.membership_id,
      actorId: row.actor_id,
      actorType: row.actor_type,
      displayName: row.display_name,
      membershipRole: row.membership_role,
      revision: row.revision,
      joinedAt: row.joined_at,
    };
  }

  private performAgentOwnershipTransfer(
    workspaceId: string,
    agentId: string,
    newOwnerMembershipId: string,
    expectedRevision: number,
    actorId: string,
    actorMembershipId: string,
  ): void {
    const current = this.requireAgentIdentityRow(workspaceId, agentId);
    invariant(current.revision === expectedRevision, 'STALE_REVISION', 'Agent revision changed.', 409);
    invariant(
      current.owner_membership_id !== newOwnerMembershipId,
      'AGENT_OWNER_UNCHANGED',
      'The target Human Membership already owns this Agent.',
      409,
    );
    const nextOwner = this.requireHumanMembership(workspaceId, newOwnerMembershipId);
    const timestamp = nowMs();
    const closed = this.workspaceDatabase.raw
      .prepare(
        `UPDATE agent_ownership_history
         SET ended_at = ?, ended_by_membership_id = ?
         WHERE workspace_id = ? AND agent_id = ? AND owner_membership_id = ? AND ended_at IS NULL`,
      )
      .run(timestamp, actorMembershipId, workspaceId, agentId, current.owner_membership_id);
    invariant(closed.changes === 1, 'AGENT_OWNERSHIP_CONFLICT', 'Current Agent ownership history is inconsistent.', 409);
    const updated = this.workspaceDatabase.raw
      .prepare(
        `UPDATE agents
         SET owner_membership_id = ?, revision = revision + 1, updated_at = ?
         WHERE workspace_id = ? AND actor_id = ? AND owner_membership_id = ? AND revision = ?`,
      )
      .run(
        newOwnerMembershipId,
        timestamp,
        workspaceId,
        agentId,
        current.owner_membership_id,
        expectedRevision,
      );
    invariant(updated.changes === 1, 'AGENT_OWNERSHIP_CONFLICT', 'Agent ownership changed concurrently.', 409);
    this.workspaceDatabase.raw
      .prepare(
        `INSERT INTO agent_ownership_history (
           id, workspace_id, agent_id, owner_membership_id, started_at
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(newId(), workspaceId, agentId, newOwnerMembershipId, timestamp);
    const contextVersion = this.bumpWorkspaceContext(workspaceId, timestamp);
    this.appendChange(workspaceId, contextVersion, null, null, 'agent_ownership_transferred', 'agent', agentId, {
      previousOwnerMembershipId: current.owner_membership_id,
      newOwnerMembershipId,
      newOwnerHumanId: nextOwner.actor_id,
      revision: expectedRevision + 1,
    }, timestamp);
    this.enqueueDelivery(
      workspaceId,
      'agent.ownership-transferred',
      'agent',
      agentId,
      { agentId, previousOwnerMembershipId: current.owner_membership_id, newOwnerMembershipId, revision: expectedRevision + 1 },
      `ownership:${agentId}:${expectedRevision + 1}`,
      timestamp,
    );
    this.appendAudit(workspaceId, actorId, actorMembershipId, 'agent.ownership.transfer', 'agent', agentId, {
      previousOwnerMembershipId: current.owner_membership_id,
      newOwnerMembershipId,
      newOwnerHumanId: nextOwner.actor_id,
      revision: expectedRevision + 1,
    }, timestamp);
  }

  private removeHumanMembership(
    workspaceId: string,
    membershipId: string,
    expectedRevision: number,
    actorId: string,
    actorMembershipId: string,
    removedActorId: string,
    auditAction: string,
  ): { membershipId: string; revision: number; removedAt: number } {
    const timestamp = nowMs();
    const ownedAgents = this.workspaceDatabase.raw
      .prepare('SELECT actor_id FROM agents WHERE workspace_id = ? AND owner_membership_id = ? ORDER BY actor_id')
      .all(workspaceId, membershipId)
      .map((row) => String((row as { actor_id: string }).actor_id));
    invariant(
      ownedAgents.length === 0,
      'AGENT_OWNERSHIP_TRANSFER_REQUIRED',
      'Human Membership must transfer all owned Agents before it can leave or be removed.',
      409,
      { agentIds: ownedAgents },
    );
    const projectMemberships = this.workspaceDatabase.raw
      .prepare(
        `SELECT pm.*
         FROM project_memberships pm
         WHERE pm.workspace_id = ? AND pm.workspace_membership_id = ? AND pm.status = 'active'
         ORDER BY pm.joined_at, pm.id`,
      )
      .all(workspaceId, membershipId) as unknown as ProjectMembershipRow[];
    for (const projectMembership of projectMemberships) {
      this.removeProjectMembership(
        this.requireProject(projectMembership.project_id),
        projectMembership,
        projectMembership.revision,
        actorId,
        actorMembershipId,
        'workspace.member.project-membership.remove',
        timestamp,
      );
    }
    const updated = this.workspaceDatabase.raw
      .prepare(
        `UPDATE workspace_memberships
         SET status = 'removed', revision = revision + 1, updated_at = ?, removed_at = ?
         WHERE workspace_id = ? AND id = ? AND status = 'active' AND revision = ?
         RETURNING revision`,
      )
      .get(timestamp, timestamp, workspaceId, membershipId, expectedRevision) as { revision: number } | undefined;
    invariant(updated, 'STALE_REVISION', 'Membership revision changed.', 409);
    const contextVersion = this.bumpWorkspaceContext(workspaceId, timestamp);
    this.appendChange(workspaceId, contextVersion, null, null, 'workspace_member_removed', 'workspace_membership', membershipId, {
      membershipId,
      actorId: removedActorId,
      revision: updated.revision,
    }, timestamp);
    this.enqueueDelivery(
      workspaceId,
      'workspace.member-removed',
      'workspace_membership',
      membershipId,
      { membershipId, actorId: removedActorId, revision: updated.revision },
      `removed:${membershipId}:${updated.revision}`,
      timestamp,
    );
    this.appendAudit(workspaceId, actorId, actorMembershipId, auditAction, 'workspace_membership', membershipId, {
      actorId: removedActorId,
      revision: updated.revision,
    }, timestamp);
    return { membershipId, revision: updated.revision, removedAt: timestamp };
  }

  private removeProjectMembership(
    project: ProjectRow,
    target: ProjectMembershipRow,
    expectedRevision: number,
    actorId: string,
    actorMembershipId: string,
    auditAction: string,
    fixedTimestamp?: number,
  ): { projectMembershipId: string; revision: number; removedAt: number; cancelledAgentRequestIds: string[] } {
    if (target.project_role === 'manager') {
      const managerCount = this.workspaceDatabase.raw
        .prepare(
          `SELECT COUNT(*) AS count FROM project_memberships
           WHERE project_id = ? AND status = 'active' AND project_role = 'manager'`,
        )
        .get(project.id) as { count: number };
      invariant(managerCount.count > 1, 'PROJECT_REQUIRES_MANAGER', 'Project must retain an active Human Manager.', 409);
    }
    const timestamp = fixedTimestamp ?? nowMs();
    const updated = this.workspaceDatabase.raw
      .prepare(
        `UPDATE project_memberships
         SET status = 'removed', revision = revision + 1, updated_at = ?, removed_at = ?
         WHERE workspace_id = ? AND project_id = ? AND id = ? AND status = 'active' AND revision = ?
         RETURNING revision`,
      )
      .get(
        timestamp,
        timestamp,
        project.workspace_id,
        project.id,
        target.id,
        expectedRevision,
      ) as { revision: number } | undefined;
    invariant(updated, 'STALE_REVISION', 'Project Membership revision changed.', 409);
    const projectVersion = this.bumpProjectContext(project.id, timestamp);
    const cancelledAgentRequestIds = new Set<string>();
    for (const requestId of this.cancelAcceptedRunsAffectedByProjectMembershipRemoval(project, target, timestamp)) {
      cancelledAgentRequestIds.add(requestId);
    }
    const removedActor = this.workspaceDatabase.raw
      .prepare('SELECT actor_id FROM workspace_memberships WHERE workspace_id = ? AND id = ?')
      .get(project.workspace_id, target.workspace_membership_id) as { actor_id: string };
    const projectConversations = this.workspaceDatabase.raw
      .prepare('SELECT id FROM conversations WHERE workspace_id = ? AND project_id = ? ORDER BY created_at, id')
      .all(project.workspace_id, project.id) as unknown as Array<{ id: string }>;
    for (const conversation of projectConversations) {
      for (const requestId of this.cancelRequestsAffectedByScopeMembershipRemoval(
        project.workspace_id,
        conversation.id,
        target.workspace_membership_id,
        removedActor.actor_id,
        timestamp,
      )) {
        cancelledAgentRequestIds.add(requestId);
      }
    }
    const cancelledIds = [...cancelledAgentRequestIds];
    this.appendChange(
      project.workspace_id,
      null,
      null,
      null,
      'project_member_removed',
      'project_membership',
      target.id,
      {
        projectMembershipId: target.id,
        workspaceMembershipId: target.workspace_membership_id,
        revision: updated.revision,
        cancelledAgentRequestIds: cancelledIds,
      },
      timestamp,
      {
        projectId: project.id,
        projectVersion,
        additionalRecipientMembershipIds: [target.workspace_membership_id],
      },
    );
    this.enqueueDelivery(
      project.workspace_id,
      'project.member-removed',
      'project_membership',
      target.id,
      { projectId: project.id, projectMembershipId: target.id, cancelledAgentRequestIds: cancelledIds },
      `removed:${target.id}:${updated.revision}`,
      timestamp,
    );
    this.appendAudit(
      project.workspace_id,
      actorId,
      actorMembershipId,
      auditAction,
      'project_membership',
      target.id,
      {
        projectId: project.id,
        workspaceMembershipId: target.workspace_membership_id,
        revision: updated.revision,
        cancelledAgentRequestIds: cancelledIds,
      },
      timestamp,
    );
    return {
      projectMembershipId: target.id,
      revision: updated.revision,
      removedAt: timestamp,
      cancelledAgentRequestIds: cancelledIds,
    };
  }

  private cancelAcceptedRunsAffectedByProjectMembershipRemoval(
    project: ProjectRow,
    target: ProjectMembershipRow,
    timestamp: number,
  ): string[] {
    const rows = this.workspaceDatabase.raw
      .prepare(
        `SELECT DISTINCT r.id AS run_id, ar.id AS agent_request_id
         FROM runs r
         JOIN agent_requests ar
           ON ar.workspace_id = r.workspace_id AND ar.id = r.agent_request_id
         JOIN agent_mention_outcomes o
           ON o.workspace_id = ar.workspace_id AND o.id = ar.mention_outcome_id
         JOIN messages m ON m.workspace_id = o.workspace_id AND m.id = o.message_id
         WHERE r.workspace_id = ? AND r.project_id = ? AND r.status = 'active'
           AND (r.agent_project_membership_id = ? OR m.author_project_membership_id = ?)`,
      )
      .all(project.workspace_id, project.id, target.id, target.id) as unknown as Array<{
        run_id: string;
        agent_request_id: string;
      }>;
    const cancelAttempts = this.workspaceDatabase.raw.prepare(
      `UPDATE attempts SET status = 'cancelled', finished_at = ?
       WHERE workspace_id = ? AND run_id = ? AND status = 'running'`,
    );
    const cancelRun = this.workspaceDatabase.raw.prepare(
      `UPDATE runs SET status = 'terminal', outcome = 'cancelled', terminal_at = ?
       WHERE workspace_id = ? AND id = ? AND status = 'active'`,
    );
    for (const row of rows) {
      cancelAttempts.run(timestamp, project.workspace_id, row.run_id);
      cancelRun.run(timestamp, project.workspace_id, row.run_id);
      this.enqueueDelivery(
        project.workspace_id,
        'run.cancelled',
        'run',
        row.run_id,
        { runId: row.run_id, reason: 'authority_revoked' },
        `cancelled:${row.run_id}:project-authority-revoked`,
        timestamp,
      );
    }
    return rows.map((row) => row.agent_request_id);
  }

  private requireAgentRow(workspaceId: string, agentId: string): AgentRow {
    const row = this.workspaceDatabase.raw
      .prepare(
        `SELECT a.*, m.id AS membership_id, 'active' AS membership_status,
                owner.actor_id AS owner_human_id, h.display_name AS owner_display_name
         FROM agents a
         JOIN workspace_memberships m
           ON m.workspace_id = a.workspace_id AND m.actor_id = a.actor_id AND m.status = 'active'
         JOIN workspace_memberships owner
           ON owner.workspace_id = a.workspace_id AND owner.id = a.owner_membership_id AND owner.status = 'active'
         JOIN humans h ON h.actor_id = owner.actor_id
         WHERE a.workspace_id = ? AND a.actor_id = ? AND a.deleted_at IS NULL`,
      )
      .get(workspaceId, agentId) as AgentRow | undefined;
    invariant(row, 'AGENT_NOT_FOUND', 'Agent does not exist.', 404);
    return row;
  }

  private requireAgentIdentityRow(workspaceId: string, agentId: string): AgentRow {
    const row = this.workspaceDatabase.raw
      .prepare(
        `SELECT a.*, m.id AS membership_id, m.status AS membership_status,
                owner.actor_id AS owner_human_id, h.display_name AS owner_display_name
         FROM agents a
         JOIN workspace_memberships m
           ON m.id = (
             SELECT latest.id FROM workspace_memberships latest
             WHERE latest.workspace_id = a.workspace_id AND latest.actor_id = a.actor_id
             ORDER BY latest.joined_at DESC, latest.id DESC LIMIT 1
           )
         JOIN workspace_memberships owner
           ON owner.workspace_id = a.workspace_id AND owner.id = a.owner_membership_id AND owner.status = 'active'
         JOIN humans h ON h.actor_id = owner.actor_id
         WHERE a.workspace_id = ? AND a.actor_id = ? AND a.deleted_at IS NULL`,
      )
      .get(workspaceId, agentId) as AgentRow | undefined;
    invariant(row, 'AGENT_NOT_FOUND', 'Agent does not exist.', 404);
    return row;
  }

  private validateWorkspaceDocument(title: string, contentMarkdown: string): void {
    invariant(title.length >= 1 && title.length <= 200,
      'INVALID_WORKSPACE_DOCUMENT_TITLE', 'Workspace Document title must contain 1 to 200 characters.');
    invariant(contentMarkdown.length >= 1 && contentMarkdown.length <= 1_048_576,
      'INVALID_WORKSPACE_DOCUMENT_CONTENT', 'Workspace Document content must contain 1 to 1048576 characters.');
  }

  private normalizeRuntimeConfiguration(input: Pick<RuntimeBindingInput, 'model' | 'reasoningEffort' | 'mode'>): {
    model: string | null;
    reasoningEffort: ReasoningEffort | null;
    mode: string | null;
  } {
    const model = input.model?.trim() || null;
    const mode = input.mode?.trim() || null;
    invariant(model === null || model.length <= 200, 'INVALID_RUNTIME_MODEL', 'Runtime model must not exceed 200 characters.');
    invariant(mode === null || mode.length <= 120, 'INVALID_RUNTIME_MODE', 'Runtime mode must not exceed 120 characters.');
    const efforts = new Set<ReasoningEffort>(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    invariant(input.reasoningEffort == null || efforts.has(input.reasoningEffort),
      'INVALID_REASONING_EFFORT', 'Runtime reasoning effort is unsupported.');
    return { model, reasoningEffort: input.reasoningEffort ?? null, mode };
  }

  private validateRuntimeConfigurationCapabilities(capabilities: RuntimeConfigurationCapabilities): void {
    const effortIds = new Set<ReasoningEffort>([
      'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
    ]);
    const validateOptions = (
      options: Array<{ id: string; label: string; description: string | null }>,
      kind: string,
    ): Set<string> => {
      invariant(options.length <= 500, 'RUNTIME_CONFIGURATION_TOO_LARGE',
        `Runtime ${kind} options exceed the supported limit.`);
      const ids = new Set<string>();
      for (const option of options) {
        invariant(
          option.id.trim().length > 0 && option.id.trim().length <= 200
          && option.label.trim().length > 0 && option.label.trim().length <= 200
          && (option.description === null || option.description.length <= 1_000),
          'INVALID_RUNTIME_CONFIGURATION',
          `Runtime ${kind} option fields are invalid.`,
        );
        invariant(!ids.has(option.id), 'DUPLICATE_RUNTIME_CONFIGURATION_OPTION',
          `Runtime ${kind} option IDs must be unique.`);
        ids.add(option.id);
      }
      return ids;
    };
    const modelIds = validateOptions(capabilities.models, 'model');
    const reasoningIds = validateOptions(capabilities.reasoningEfforts, 'reasoning effort');
    const modeIds = validateOptions(capabilities.modes, 'mode');
    invariant([...reasoningIds].every((id) => effortIds.has(id as ReasoningEffort)),
      'INVALID_REASONING_EFFORT', 'Runtime reported an unsupported reasoning-effort ID.');
    invariant(capabilities.defaultModelId === null || modelIds.has(capabilities.defaultModelId),
      'INVALID_RUNTIME_DEFAULT', 'Runtime default model is not in the reported model options.');
    invariant(
      capabilities.defaultReasoningEffort === null
      || reasoningIds.has(capabilities.defaultReasoningEffort),
      'INVALID_RUNTIME_DEFAULT',
      'Runtime default reasoning effort is not in the reported reasoning options.',
    );
    invariant(capabilities.defaultModeId === null || modeIds.has(capabilities.defaultModeId),
      'INVALID_RUNTIME_DEFAULT', 'Runtime default mode is not in the reported mode options.');
    for (const model of capabilities.models) {
      if (model.supportedReasoningEfforts === null) continue;
      invariant(
        new Set(model.supportedReasoningEfforts).size === model.supportedReasoningEfforts.length
        && model.supportedReasoningEfforts.every((effort) => reasoningIds.has(effort)),
        'INVALID_RUNTIME_CONFIGURATION_COMBINATION',
        `Runtime model ${model.id} reports invalid reasoning-effort constraints.`,
      );
    }
  }

  private validateRuntimeUnavailableReason(
    availability: Exclude<RuntimeCapabilityReport['availability'], 'ready'>,
    reason: RuntimeCapabilityUnavailableReason,
  ): void {
    const allowed = availability === 'unhealthy'
      ? new Set<RuntimeCapabilityUnavailableReason['code']>([
          'runtime_unhealthy', 'capability_probe_failed', 'version_unsupported',
        ])
      : new Set<RuntimeCapabilityUnavailableReason['code']>([availability]);
    invariant(allowed.has(reason.code), 'INVALID_RUNTIME_UNAVAILABLE_REASON',
      'Runtime unavailable reason does not match its availability.');
    invariant(reason.message.trim().length > 0 && reason.message.trim().length <= 500,
      'INVALID_RUNTIME_UNAVAILABLE_REASON', 'Runtime unavailable reason must contain 1 to 500 characters.');
  }

  private validateRuntimeSkillCatalog(skills: RuntimeCapabilityReport['skills']): void {
    invariant(
      typeof skills === 'object'
      && skills !== null
      && Array.isArray(skills.global)
      && Array.isArray(skills.workspace)
      && skills.global.length <= 2_000
      && skills.workspace.length <= 2_000,
      'INVALID_RUNTIME_SKILL_CATALOG',
      'Runtime Skill catalog must contain bounded global and workspace lists.',
    );
    for (const skill of [...skills.global, ...skills.workspace]) {
      invariant(
        typeof skill.id === 'string'
        && /^[a-f0-9]{64}$/u.test(skill.id)
        && typeof skill.name === 'string'
        && /^[a-zA-Z0-9._-]{1,200}$/u.test(skill.name)
        && typeof skill.displayName === 'string'
        && skill.displayName.trim().length > 0
        && skill.displayName.length <= 200
        && typeof skill.description === 'string'
        && skill.description.length <= 2_000
        && typeof skill.source === 'string'
        && /^[a-z0-9._-]{1,80}$/u.test(skill.source)
        && (skill.scope === 'global' || skill.scope === 'workspace')
        && typeof skill.installed === 'boolean'
        && typeof skill.enabled === 'boolean'
        && typeof skill.runtimeCompatible === 'boolean'
        && (skill.version === null || (skill.version.length > 0 && skill.version.length <= 120))
        && /^[a-f0-9]{64}$/u.test(skill.revision)
        && typeof skill.userInvocable === 'boolean'
        && (skill.unavailableReason === null || (
          typeof skill.unavailableReason.code === 'string'
          && skill.unavailableReason.code.length > 0
          && skill.unavailableReason.code.length <= 120
          && typeof skill.unavailableReason.message === 'string'
          && skill.unavailableReason.message.length > 0
          && skill.unavailableReason.message.length <= 500
        )),
        'INVALID_RUNTIME_SKILL',
        'Runtime Skill metadata or sanitized source identifier is invalid.',
      );
    }
  }

  private runtimeConfigurationSelectionIssue(
    capabilities: RuntimeConfigurationCapabilities,
    selection: RuntimeConfigurationSelection,
  ): { code: 'runtime_model_unavailable' | 'runtime_reasoning_effort_unavailable' | 'runtime_mode_unavailable' | 'runtime_configuration_combination_unsupported'; message: string } | null {
    if (selection.model !== null && !capabilities.models.some((model) => model.id === selection.model)) {
      return { code: 'runtime_model_unavailable', message: `Runtime does not offer model ${selection.model}.` };
    }
    if (
      selection.reasoningEffort !== null
      && !capabilities.reasoningEfforts.some((effort) => effort.id === selection.reasoningEffort)
    ) {
      return {
        code: 'runtime_reasoning_effort_unavailable',
        message: `Runtime does not offer reasoning effort ${selection.reasoningEffort}.`,
      };
    }
    if (selection.mode !== null && !capabilities.modes.some((mode) => mode.id === selection.mode)) {
      return { code: 'runtime_mode_unavailable', message: `Runtime does not offer mode ${selection.mode}.` };
    }
    const effectiveModel = selection.model ?? capabilities.defaultModelId;
    const effectiveEffort = selection.reasoningEffort ?? capabilities.defaultReasoningEffort;
    const model = capabilities.models.find((candidate) => candidate.id === effectiveModel);
    if (
      model
      && model.supportedReasoningEfforts !== null
      && effectiveEffort !== null
      && !model.supportedReasoningEfforts.includes(effectiveEffort)
    ) {
      return {
        code: 'runtime_configuration_combination_unsupported',
        message: `Runtime model ${model.id} does not support reasoning effort ${effectiveEffort}.`,
      };
    }
    return null;
  }

  private validateRuntimeConfigurationSelection(
    capabilities: RuntimeConfigurationCapabilities,
    selection: RuntimeConfigurationSelection,
  ): void {
    const issue = this.runtimeConfigurationSelectionIssue(capabilities, selection);
    if (issue) throw new DomainError(issue.code.toUpperCase(), issue.message, 409);
  }

  private runtimeConfigurationState(
    requested: RuntimeConfigurationSelection,
    capabilities: RuntimeConfigurationCapabilities | null,
    computerConnectionStatus: 'online' | 'offline',
    availability: RuntimeCapabilityReport['availability'],
    unavailableReasonCode: RuntimeCapabilityUnavailableReason['code'] | null,
  ): RuntimeBindingView['configuration'] {
    const unavailable = () => ({ value: null, source: 'unavailable' as const });
    if (availability !== 'ready') {
      const codes = {
        not_installed: 'runtime_not_installed',
        adapter_missing: 'runtime_adapter_missing',
        unauthenticated: 'runtime_unauthenticated',
        unhealthy: unavailableReasonCode === 'version_unsupported'
          ? 'runtime_version_unsupported'
          : unavailableReasonCode === 'capability_probe_failed'
            ? 'runtime_capability_probe_failed'
            : 'runtime_unhealthy',
      } as const;
      const messages = {
        not_installed: 'The selected Runtime is not installed on the bound Computer.',
        adapter_missing: 'The selected Runtime ACP adapter is missing on the bound Computer.',
        unauthenticated: 'The selected Runtime is not authenticated on the bound Computer.',
        unhealthy: unavailableReasonCode === 'version_unsupported'
          ? 'The selected Runtime ACP protocol version is not supported.'
          : unavailableReasonCode === 'capability_probe_failed'
            ? 'The selected Runtime did not complete ACP capability discovery.'
            : 'The selected Runtime is not healthy.',
      } as const;
      return {
        requested,
        effective: { model: unavailable(), reasoningEffort: unavailable(), mode: unavailable() },
        status: 'runtime_unavailable',
        invalidReason: { code: codes[availability], message: messages[availability] },
      };
    }
    if (capabilities === null) {
      return {
        requested,
        effective: { model: unavailable(), reasoningEffort: unavailable(), mode: unavailable() },
        status: 'runtime_unavailable',
        invalidReason: {
          code: 'runtime_configuration_unavailable',
          message: 'The Runtime has not published a valid ACP configuration snapshot.',
        },
      };
    }
    const issue = this.runtimeConfigurationSelectionIssue(capabilities, requested);
    const effective = {
      model: {
        value: requested.model ?? capabilities.defaultModelId,
        source: requested.model === null ? 'runtime_default' as const : 'explicit' as const,
      },
      reasoningEffort: {
        value: requested.reasoningEffort ?? capabilities.defaultReasoningEffort,
        source: requested.reasoningEffort === null ? 'runtime_default' as const : 'explicit' as const,
      },
      mode: {
        value: requested.mode ?? capabilities.defaultModeId,
        source: requested.mode === null ? 'runtime_default' as const : 'explicit' as const,
      },
    };
    if (issue) return { requested, effective, status: 'selection_unavailable', invalidReason: issue };
    if (computerConnectionStatus === 'offline') {
      return {
        requested,
        effective,
        status: 'computer_offline',
        invalidReason: { code: 'computer_offline', message: 'The bound Computer is currently offline.' },
      };
    }
    return { requested, effective, status: 'valid', invalidReason: null };
  }

  private insertWorkspaceDocumentVersion(
    id: string,
    workspaceId: string,
    documentId: string,
    version: number,
    title: string,
    contentMarkdown: string,
    membershipId: string,
    timestamp: number,
  ): void {
    this.workspaceDatabase.raw
      .prepare(
        `INSERT INTO workspace_document_versions (
           id, workspace_id, document_id, version, title, content_markdown,
           content_digest, created_by_membership_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id, workspaceId, documentId, version, title, contentMarkdown,
        sha256(contentMarkdown), membershipId, timestamp,
      );
  }

  private workspaceDocumentSelect(): string {
    return `SELECT d.*, v.id AS version_id, v.version, v.title, v.content_markdown, v.content_digest
            FROM workspace_documents d
            JOIN workspace_document_versions v
              ON v.workspace_id = d.workspace_id
             AND v.document_id = d.id
             AND v.version = d.current_version`;
  }

  private requireWorkspaceDocumentRow(workspaceId: string, documentId: string): WorkspaceDocumentRow {
    const row = this.workspaceDatabase.raw
      .prepare(`${this.workspaceDocumentSelect()} WHERE d.workspace_id = ? AND d.id = ?`)
      .get(workspaceId, documentId) as WorkspaceDocumentRow | undefined;
    invariant(row, 'WORKSPACE_DOCUMENT_NOT_FOUND', 'Workspace Document does not exist.', 404);
    return row;
  }

  private hydrateWorkspaceDocument(row: WorkspaceDocumentRow): WorkspaceDocumentView {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      version: row.version,
      revision: row.revision,
      status: row.status,
      title: row.title,
      contentMarkdown: row.content_markdown,
      contentDigest: row.content_digest,
      createdByMembershipId: row.created_by_membership_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private validateExecutionPolicy(policy: AgentExecutionPolicy): void {
    invariant(Number.isSafeInteger(policy.maxParallelAttempts) && policy.maxParallelAttempts >= 1 && policy.maxParallelAttempts <= 64,
      'INVALID_EXECUTION_POLICY', 'maxParallelAttempts must be between 1 and 64.');
    invariant(Number.isSafeInteger(policy.maxWallTimeMs) && policy.maxWallTimeMs >= 1000 && policy.maxWallTimeMs <= 86_400_000,
      'INVALID_EXECUTION_POLICY', 'maxWallTimeMs is out of range.');
    invariant(Number.isSafeInteger(policy.maxContextBytes) && policy.maxContextBytes >= 1024 && policy.maxContextBytes <= 1_073_741_824,
      'INVALID_EXECUTION_POLICY', 'maxContextBytes is out of range.');
    invariant(Number.isSafeInteger(policy.maxToolCalls) && policy.maxToolCalls >= 0 && policy.maxToolCalls <= 100_000,
      'INVALID_EXECUTION_POLICY', 'maxToolCalls is out of range.');
    invariant(policy.allowedContextKinds.length > 0 && new Set(policy.allowedContextKinds).size === policy.allowedContextKinds.length,
      'INVALID_EXECUTION_POLICY', 'allowedContextKinds must be a non-empty unique list.');
  }

  private insertExecutionPolicy(
    id: string,
    workspaceId: string,
    agentId: string,
    version: number,
    membershipId: string,
    policy: AgentExecutionPolicy,
    timestamp: number,
  ): void {
    this.validateExecutionPolicy(policy);
    this.workspaceDatabase.raw
      .prepare(
        `INSERT INTO agent_execution_policy_versions (
           id, workspace_id, agent_id, version, max_parallel_attempts, max_wall_time_ms,
           max_context_bytes, max_tool_calls, allowed_context_kinds_json,
           private_context_allowed, created_by_membership_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        workspaceId,
        agentId,
        version,
        policy.maxParallelAttempts,
        policy.maxWallTimeMs,
        policy.maxContextBytes,
        policy.maxToolCalls,
        canonicalJson(policy.allowedContextKinds),
        policy.privateContextAllowed ? 1 : 0,
        membershipId,
        timestamp,
      );
  }

  private requireLatestExecutionPolicy(workspaceId: string, agentId: string): Record<string, unknown> {
    const row = this.workspaceDatabase.raw
      .prepare(
        `SELECT * FROM agent_execution_policy_versions
         WHERE workspace_id = ? AND agent_id = ? ORDER BY version DESC LIMIT 1`,
      )
      .get(workspaceId, agentId) as Record<string, unknown> | undefined;
    invariant(row, 'EXECUTION_POLICY_NOT_FOUND', 'Execution Policy does not exist.', 404);
    return row;
  }

  private hydrateExecutionPolicy(row: Record<string, unknown>): AgentExecutionPolicyView {
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      agentId: String(row.agent_id),
      version: Number(row.version),
      maxParallelAttempts: Number(row.max_parallel_attempts),
      maxWallTimeMs: Number(row.max_wall_time_ms),
      maxContextBytes: Number(row.max_context_bytes),
      maxToolCalls: Number(row.max_tool_calls),
      allowedContextKinds: JSON.parse(String(row.allowed_context_kinds_json)) as ContextSourceKind[],
      privateContextAllowed: Number(row.private_context_allowed) === 1,
      createdByMembershipId: String(row.created_by_membership_id),
      createdAt: Number(row.created_at),
    };
  }

  private mapAgent(row: AgentRow): AgentView {
    const policy = this.workspaceDatabase.raw
      .prepare('SELECT MAX(version) AS version FROM agent_execution_policy_versions WHERE workspace_id = ? AND agent_id = ?')
      .get(row.workspace_id, row.actor_id) as { version: number };
    const binding = this.workspaceDatabase.raw
      .prepare(
        `SELECT b.id, b.computer_id, b.runtime_id,
                b.requested_model, b.requested_reasoning_effort, b.requested_mode,
                b.runtime_catalog_revision AS validated_runtime_catalog_revision,
                b.binding_revision, b.created_at,
                c.name AS computer_name, c.status AS computer_status,
                c.last_seen_at, c.runtime_catalog_revision,
                rc.availability AS runtime_availability,
                rc.detected_version, rc.configuration_json, rc.unavailable_reason_code
         FROM agent_runtime_bindings b
         JOIN computers c ON c.id = b.computer_id
         LEFT JOIN computer_runtime_capabilities rc
           ON rc.computer_id = b.computer_id AND rc.runtime_id = b.runtime_id
         WHERE b.workspace_id = ? AND b.agent_id = ? AND b.status = 'active'`,
      )
      .get(row.workspace_id, row.actor_id) as {
        id: string;
        computer_id: string;
        runtime_id: RuntimeId;
        requested_model: string | null;
        requested_reasoning_effort: ReasoningEffort | null;
        requested_mode: string | null;
        binding_revision: number;
        created_at: number;
        computer_name: string;
        computer_status: 'active' | 'disabled';
        last_seen_at: number | null;
        runtime_catalog_revision: number;
        validated_runtime_catalog_revision: number;
        runtime_availability: ComputerView['runtimes'][number]['availability'] | null;
        detected_version: string | null;
        configuration_json: string | null;
        unavailable_reason_code: RuntimeCapabilityUnavailableReason['code'] | null;
      } | undefined;
    const timestamp = nowMs();
    const computerConnectionStatus = binding
      && binding.computer_status === 'active'
      && binding.last_seen_at !== null
      && timestamp - binding.last_seen_at <= COMPUTER_ONLINE_WINDOW_MS
      ? 'online' as const
      : 'offline' as const;
    const runtimeAvailability = binding?.runtime_availability ?? 'unhealthy';
    const runtimeCapabilities = binding?.configuration_json
      ? JSON.parse(binding.configuration_json) as RuntimeConfigurationCapabilities
      : null;
    return {
      id: row.actor_id,
      workspaceId: row.workspace_id,
      createdByHumanId: row.created_by_human_id,
      ownerMembershipId: row.owner_membership_id,
      ownerHumanId: row.owner_human_id,
      ownerDisplayName: row.owner_display_name,
      name: row.name,
      description: row.description,
      lifecycleStatus: row.lifecycle_status,
      revision: row.revision,
      membershipId: row.membership_id,
      membershipStatus: row.membership_status,
      executionPolicyVersion: policy.version,
      runtimeBinding: binding ? {
        id: binding.id,
        workspaceId: row.workspace_id,
        agentId: row.actor_id,
        computerId: binding.computer_id,
        computerName: binding.computer_name,
        computerConnectionStatus,
        runtimeId: binding.runtime_id,
        runtimeAvailability,
        detectedVersion: binding.detected_version,
        validatedRuntimeCatalogRevision: binding.validated_runtime_catalog_revision,
        runtimeCatalogRevision: binding.runtime_catalog_revision,
        configuration: this.runtimeConfigurationState(
          {
            model: binding.requested_model,
            reasoningEffort: binding.requested_reasoning_effort,
            mode: binding.requested_mode,
          },
          runtimeCapabilities,
          computerConnectionStatus,
          runtimeAvailability,
          binding.unavailable_reason_code,
        ),
        bindingRevision: binding.binding_revision,
        createdAt: binding.created_at,
      } : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private insertRuntimeBinding(
    ownerHumanId: string,
    workspaceId: string,
    agentId: string,
    input: RuntimeBindingInput,
    timestamp: number,
    expectedRevision?: number,
  ): RuntimeBindingView {
    invariant(RUNTIME_ID_PATTERN.test(input.runtimeId), 'INVALID_RUNTIME_ID', 'Runtime must use a valid explicit runtimeId.');
    const computer = this.workspaceDatabase.raw
      .prepare("SELECT id, name, last_seen_at, runtime_catalog_revision FROM computers WHERE id = ? AND owner_human_id = ? AND status = 'active'")
      .get(input.computerId, ownerHumanId) as {
        id: string;
        name: string;
        last_seen_at: number | null;
        runtime_catalog_revision: number;
      } | undefined;
    invariant(computer, 'COMPUTER_NOT_FOUND', 'Computer does not exist or is not owned by the caller.', 404);
    invariant(
      computer.last_seen_at !== null && timestamp - computer.last_seen_at <= COMPUTER_ONLINE_WINDOW_MS,
      'COMPUTER_OFFLINE',
      'The selected Computer is not currently connected.',
      409,
    );
    const capability = this.workspaceDatabase.raw
      .prepare(
        `SELECT availability, detected_version, configuration_json
         FROM computer_runtime_capabilities
         WHERE computer_id = ? AND runtime_id = ?`,
      )
      .get(input.computerId, input.runtimeId) as {
        availability: ComputerView['runtimes'][number]['availability'];
        detected_version: string | null;
        configuration_json: string | null;
      } | undefined;
    invariant(
      capability?.availability === 'ready' && capability.configuration_json !== null,
      'RUNTIME_UNAVAILABLE_ON_COMPUTER',
      'The selected Runtime is not ready on this Computer.',
      409,
    );
    const configurationCapabilities = JSON.parse(capability.configuration_json) as RuntimeConfigurationCapabilities;
    const runtimeConfiguration = this.normalizeRuntimeConfiguration(input);
    this.validateRuntimeConfigurationSelection(configurationCapabilities, runtimeConfiguration);
    const activeBinding = this.workspaceDatabase.raw
      .prepare(
        `SELECT binding_revision FROM agent_runtime_bindings
         WHERE workspace_id = ? AND agent_id = ? AND status = 'active'`,
      )
      .get(workspaceId, agentId) as { binding_revision: number } | undefined;
    if (expectedRevision === undefined) {
      invariant(activeBinding === undefined, 'RUNTIME_BINDING_ALREADY_EXISTS', 'The Agent already has a Runtime Binding.', 409);
    } else if (expectedRevision === 0) {
      invariant(activeBinding === undefined, 'RUNTIME_BINDING_REVISION_CONFLICT',
        'Runtime Binding revision changed.', 409);
    } else {
      invariant(activeBinding?.binding_revision === expectedRevision, 'RUNTIME_BINDING_REVISION_CONFLICT',
        'Runtime Binding revision changed.', 409);
    }
    const priorRevision = this.workspaceDatabase.raw
      .prepare('SELECT COALESCE(MAX(binding_revision), 0) AS revision FROM agent_runtime_bindings WHERE workspace_id = ? AND agent_id = ?')
      .get(workspaceId, agentId) as { revision: number };
    const bindingRevision = priorRevision.revision + 1;
    if (activeBinding) {
      const disabled = this.workspaceDatabase.raw
        .prepare(
          `UPDATE agent_runtime_bindings SET status = 'disabled', updated_at = ?
           WHERE workspace_id = ? AND agent_id = ? AND status = 'active' AND binding_revision = ?`,
        )
        .run(timestamp, workspaceId, agentId, activeBinding.binding_revision);
      invariant(disabled.changes === 1, 'RUNTIME_BINDING_REVISION_CONFLICT', 'Runtime Binding revision changed.', 409);
    }
    const bindingId = newId();
    this.workspaceDatabase.raw
      .prepare(
        `INSERT INTO agent_runtime_bindings (
           id, workspace_id, agent_id, computer_id, runtime_id,
           requested_model, requested_reasoning_effort, requested_mode,
           runtime_catalog_revision, binding_revision, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(
        bindingId,
        workspaceId,
        agentId,
        input.computerId,
        input.runtimeId,
        runtimeConfiguration.model,
        runtimeConfiguration.reasoningEffort,
        runtimeConfiguration.mode,
        computer.runtime_catalog_revision,
        bindingRevision,
        timestamp,
        timestamp,
      );
    return {
      id: bindingId,
      workspaceId,
      agentId,
      computerId: input.computerId,
      computerName: computer.name,
      computerConnectionStatus: 'online',
      runtimeId: input.runtimeId,
      runtimeAvailability: 'ready',
      detectedVersion: capability.detected_version,
      validatedRuntimeCatalogRevision: computer.runtime_catalog_revision,
      runtimeCatalogRevision: computer.runtime_catalog_revision,
      configuration: this.runtimeConfigurationState(
        runtimeConfiguration,
        configurationCapabilities,
        'online',
        'ready',
        null,
      ),
      bindingRevision,
      createdAt: timestamp,
    };
  }

  private transitionAgent(
    principal: HumanPrincipal,
    workspaceId: string,
    agentId: string,
    from: 'active' | 'suspended',
    to: 'active' | 'suspended',
    expectedRevision: number,
    idempotencyKey: string,
  ): AgentView {
    const commandName = to === 'suspended' ? 'SuspendAgent' : 'ResumeAgent';
    return this.idempotent(workspaceId, principal.actorId, commandName, idempotencyKey, { expectedRevision }, () => {
      const membership = this.requireAgentOwner(workspaceId, agentId, principal.actorId);
      const timestamp = nowMs();
      const updated = this.workspaceDatabase.raw
        .prepare(
          `UPDATE agents
           SET lifecycle_status = ?, revision = revision + 1, updated_at = ?
           WHERE workspace_id = ? AND actor_id = ? AND lifecycle_status = ? AND revision = ?
           RETURNING revision`,
        )
        .get(to, timestamp, workspaceId, agentId, from, expectedRevision) as { revision: number } | undefined;
      invariant(updated, 'AGENT_LIFECYCLE_CONFLICT', 'Agent lifecycle or revision changed.', 409);
      const contextVersion = this.bumpWorkspaceContext(workspaceId, timestamp);
      const changeType = to === 'suspended' ? 'agent_suspended' : 'agent_resumed';
      this.appendChange(workspaceId, contextVersion, null, null, changeType, 'agent', agentId, {
        revision: updated.revision,
      }, timestamp);
      this.enqueueDelivery(
        workspaceId,
        `agent.${to}`,
        'agent',
        agentId,
        { agentId, revision: updated.revision },
        `${to}:${agentId}:${updated.revision}`,
        timestamp,
      );
      this.appendAudit(workspaceId, principal.actorId, membership.id, `agent.${to}`, 'agent', agentId, {
        revision: updated.revision,
      }, timestamp);
      return this.mapAgent(this.requireAgentRow(workspaceId, agentId));
    });
  }

  private normalizeMentionTargets(targets?: string[]): string[] {
    if (!targets) return [];
    invariant(targets.length <= 50, 'TOO_MANY_MENTIONS', 'A Message may mention at most 50 distinct Agents.');
    const normalized = targets.map((target) => target.trim());
    invariant(normalized.every((target) => target.length > 0), 'INVALID_MENTION_TARGET', 'Mention targets must not be empty.');
    const distinct = [...new Set(normalized)];
    invariant(distinct.length <= 50, 'TOO_MANY_MENTIONS', 'A Message may mention at most 50 distinct Agents.');
    return distinct;
  }

  private addImplicitDirectAgentTarget(access: ConversationAccess, actorIds: string[]): string[] {
    if (access.conversation.conversation_kind !== 'dm') return actorIds;
    const directAgent = this.workspaceDatabase.raw
      .prepare(
        `SELECT membership.actor_id
         FROM conversation_direct_memberships direct
         JOIN workspace_memberships membership
           ON membership.workspace_id = direct.workspace_id
          AND membership.id = direct.membership_id
          AND membership.status = 'active'
         JOIN actors actor ON actor.id = membership.actor_id AND actor.actor_type = 'agent'
         WHERE direct.workspace_id = ? AND direct.conversation_id = ?
           AND membership.actor_id <> ?
         LIMIT 1`,
      )
      .get(
        access.conversation.workspace_id,
        access.conversation.id,
        access.membership.actor_id,
      ) as { actor_id: string } | undefined;
    return directAgent && !actorIds.includes(directAgent.actor_id)
      ? [...actorIds, directAgent.actor_id]
      : actorIds;
  }

  private resolveMessageMentions(access: ConversationAccess, actorIds: string[]): ConversationParticipantRow[] {
    if (actorIds.length === 0) return [];
    const participants = this.listConversationParticipants(
      { kind: 'human', actorId: access.membership.actor_id },
      access.conversation.id,
    );
    const byActorId = new Map(participants.map((participant) => [participant.actorId, participant]));
    return actorIds.map((actorId) => {
      const participant = byActorId.get(actorId);
      invariant(participant, 'MENTION_TARGET_NOT_IN_CONVERSATION', 'Mention target is not a current Conversation participant.', 409);
      return {
        membership_id: participant.workspaceMembershipId,
        project_membership_id: participant.projectMembershipId,
        actor_id: participant.actorId,
        actor_type: participant.actorType,
        display_name: participant.displayName,
        joined_at: participant.joinedAt,
      };
    });
  }

  private publishHumanMessage(
    access: ConversationAccess,
    body: string,
    threadId: string | null,
    mentions: ConversationParticipantRow[],
    artifactSelections: Array<{ artifactId: string; snapshotId: string | null }>,
    timestamp: number,
  ): string {
    const workspaceId = access.conversation.workspace_id;
    const conversationId = access.conversation.id;
    if (threadId) {
      const thread = this.workspaceDatabase.raw
        .prepare('SELECT id FROM threads WHERE workspace_id = ? AND conversation_id = ? AND id = ?')
        .get(workspaceId, conversationId, threadId);
      invariant(thread, 'THREAD_NOT_FOUND', 'Thread does not belong to the conversation.', 404);
    }
    const conversationVersion = this.bumpConversationContext(conversationId, null, timestamp);
    const scopePosition = this.advanceDiscussionFrontier(workspaceId, conversationId, threadId);
    const messageId = newId();
    this.workspaceDatabase.raw
      .prepare(
        `INSERT INTO messages (
           id, workspace_id, conversation_id, project_id, thread_id, author_actor_id,
           author_membership_id, author_project_membership_id,
           body, conversation_version, scope_position, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        messageId,
        workspaceId,
        conversationId,
        access.conversation.project_id,
        threadId,
        access.membership.actor_id,
        access.membership.id,
        access.projectMembership?.id ?? null,
        body,
        conversationVersion,
        scopePosition,
        timestamp,
      );

    const snapshots = this.artifacts.resolveMessageSnapshots(workspaceId, access.membership.actor_id, artifactSelections);
    this.artifacts.insertMessageReferences(workspaceId, messageId, snapshots, timestamp);
    const insertMention = this.workspaceDatabase.raw.prepare(
      `INSERT INTO message_mentions (
         id, workspace_id, message_id, actor_id, actor_type_snapshot,
         display_name_snapshot, mention_order, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    mentions.forEach((mention, index) => {
      insertMention.run(
        newId(), workspaceId, messageId, mention.actor_id, mention.actor_type,
        mention.display_name, index, timestamp,
      );
    });

    const outcomeSummaries: Array<{
      targetReference: string;
      outcome: 'requested' | 'not_requested';
      agentRequestId: string | null;
    }> = [];
    const mentionedAgents = mentions.filter((mention) => mention.actor_type === 'agent');
    for (const [targetOrder, mention] of mentionedAgents.entries()) {
      const targetReference = mention.actor_id;
      const target = this.workspaceDatabase.raw
        .prepare(
          `SELECT a.actor_id, a.lifecycle_status, m.id AS membership_id,
                  pm.id AS project_membership_id
           FROM agents a
           LEFT JOIN workspace_memberships m
             ON m.workspace_id = a.workspace_id AND m.actor_id = a.actor_id AND m.status = 'active'
           LEFT JOIN project_memberships pm
             ON pm.workspace_id = a.workspace_id
            AND pm.project_id = ?
            AND pm.workspace_membership_id = m.id
            AND pm.status = 'active'
           WHERE a.workspace_id = ? AND a.actor_id = ?`,
        )
        .get(access.conversation.project_id, workspaceId, targetReference) as
        | {
            actor_id: string;
            lifecycle_status: 'active' | 'suspended' | 'deleted';
            membership_id: string | null;
            project_membership_id: string | null;
          }
        | undefined;
      let reason: MentionNotRequestedReason | null = null;
      if (!target) {
        reason = 'target_not_in_workspace';
      } else if (target.lifecycle_status === 'deleted' || target.membership_id === null) {
        reason = 'target_not_requestable';
      } else if (access.conversation.project_id !== null && target.project_membership_id === null) {
        reason = 'target_not_in_project';
      } else if (!this.hasConversationAccess(workspaceId, conversationId, target.membership_id)) {
        reason = 'target_cannot_access_scope';
      }

      const outcomeId = newId();
      if (reason) {
        this.workspaceDatabase.raw
          .prepare(
            `INSERT INTO agent_mention_outcomes (
               id, workspace_id, message_id, target_reference, target_order,
               target_agent_id, outcome, reason_code, agent_request_id, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, 'not_requested', ?, NULL, ?)`,
          )
          .run(outcomeId, workspaceId, messageId, targetReference, targetOrder, target?.actor_id ?? null, reason, timestamp);
        outcomeSummaries.push({ targetReference, outcome: 'not_requested', agentRequestId: null });
        continue;
      }

      const targetAgentId = target!.actor_id;
      const requestId = newId();
      this.workspaceDatabase.raw
        .prepare(
          `INSERT INTO agent_mention_outcomes (
             id, workspace_id, message_id, target_reference, target_order,
             target_agent_id, outcome, reason_code, agent_request_id, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'requested', NULL, ?, ?)`,
        )
        .run(outcomeId, workspaceId, messageId, targetReference, targetOrder, targetAgentId, requestId, timestamp);
      this.workspaceDatabase.raw
        .prepare(
          `INSERT INTO agent_requests (
             id, workspace_id, mention_outcome_id, target_agent_id,
             result_conversation_id, result_thread_id, status, version,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?)`,
        )
        .run(requestId, workspaceId, outcomeId, targetAgentId, conversationId, threadId, timestamp, timestamp);
      const inboxSequence = this.nextAgentInboxSequence(workspaceId, targetAgentId);
      const inboxItemId = newId();
      this.workspaceDatabase.raw.prepare(
        `INSERT INTO agent_inbox_items (
           id, workspace_id, agent_id, sequence, attention_kind,
           message_id, conversation_id, thread_id, agent_request_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        inboxItemId,
        workspaceId,
        targetAgentId,
        inboxSequence,
        access.conversation.conversation_kind === 'dm' ? 'direct_message' : 'mention',
        messageId,
        conversationId,
        threadId,
        requestId,
        timestamp,
      );
      this.enqueueDelivery(
        workspaceId,
        'agent.inbox_changed',
        'agent',
        targetAgentId,
        { agentId: targetAgentId, highestSequence: inboxSequence },
        `agent-inbox:${targetAgentId}:${inboxSequence}`,
        timestamp,
      );
      outcomeSummaries.push({ targetReference, outcome: 'requested', agentRequestId: requestId });
    }

    this.appendChange(
      workspaceId,
      null,
      conversationId,
      conversationVersion,
      'message_created',
      'message',
      messageId,
      { threadId, scopePosition, mentionOutcomes: outcomeSummaries },
      timestamp,
      this.conversationChangeOptions(access.conversation),
    );
    this.enqueueDelivery(
      workspaceId,
      'conversation.message',
      'message',
      messageId,
      { conversationId, messageId },
      messageId,
      timestamp,
    );
    this.appendAudit(
      workspaceId,
      access.membership.actor_id,
      access.membership.id,
      'message.post',
      'message',
      messageId,
      { conversationId, threadId, mentionCount: mentions.length, agentRequestTargetCount: mentionedAgents.length },
      timestamp,
    );
    return messageId;
  }

  private nextAgentInboxSequence(workspaceId: string, agentId: string): number {
    const row = this.workspaceDatabase.raw.prepare(
      'SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM agent_inbox_items WHERE workspace_id = ? AND agent_id = ?',
    ).get(workspaceId, agentId) as { sequence: number };
    return row.sequence;
  }

  private notifyAgentInboxChanged(messageId: string): void {
    const wakes = this.workspaceDatabase.raw.prepare(
      `SELECT agent_id, sequence FROM agent_inbox_items
       WHERE message_id = ? ORDER BY agent_id, sequence`,
    ).all(messageId) as unknown as Array<{ agent_id: string; sequence: number }>;
    if (wakes.length > 0) this.agentInboxWakeEmitter.emit('changed');
  }

  private requireMessage(messageId: string): MessageRow {
    const row = this.workspaceDatabase.raw.prepare('SELECT * FROM messages WHERE id = ?').get(messageId) as MessageRow | undefined;
    invariant(row, 'MESSAGE_NOT_FOUND', 'Message does not exist.', 404);
    return row;
  }

  private hydrateMessage(row: MessageRow, observerMembership: MembershipRow): MessageView {
    const mentions = this.workspaceDatabase.raw
      .prepare(
        `SELECT actor_id, actor_type_snapshot, display_name_snapshot
         FROM message_mentions
         WHERE workspace_id = ? AND message_id = ? ORDER BY mention_order`,
      )
      .all(row.workspace_id, row.id) as unknown as Array<{
        actor_id: string;
        actor_type_snapshot: 'human' | 'agent';
        display_name_snapshot: string;
      }>;
    const outcomes = this.workspaceDatabase.raw
      .prepare(
        `SELECT id, target_reference, target_agent_id, outcome, reason_code, agent_request_id
         FROM agent_mention_outcomes
         WHERE workspace_id = ? AND message_id = ? ORDER BY target_order`,
      )
      .all(row.workspace_id, row.id) as unknown as Array<{
      id: string;
      target_reference: string;
      target_agent_id: string | null;
      outcome: 'requested' | 'not_requested';
      reason_code: MentionNotRequestedReason | null;
      agent_request_id: string | null;
    }>;
    const mentionOutcomes: AgentMentionOutcomeView[] = outcomes.map((outcome) => ({
      id: outcome.id,
      targetReference: outcome.target_reference,
      targetAgentId: outcome.target_agent_id,
      outcome: outcome.outcome,
      agentRequestId: outcome.agent_request_id,
      reason:
        outcome.outcome === 'requested'
          ? null
          : observerMembership.membership_role === 'owner'
            || this.isCurrentAgentOwner(row.workspace_id, outcome.target_agent_id, observerMembership.id)
            ? { code: outcome.reason_code!, visibility: 'exact' }
            : { code: 'target_unavailable', visibility: 'summary' },
    }));
    const author = this.workspaceDatabase.raw
      .prepare(
        `SELECT a.actor_type, COALESCE(h.display_name, ag.name) AS display_name,
                CASE WHEN a.actor_type = 'agent' AND ag.deleted_at IS NOT NULL THEN 1 ELSE 0 END AS deleted
         FROM actors a
         LEFT JOIN humans h ON h.actor_id = a.id
         LEFT JOIN agents ag ON ag.actor_id = a.id AND ag.workspace_id = ?
         WHERE a.id = ?`,
      )
      .get(row.workspace_id, row.author_actor_id) as {
        actor_type: 'human' | 'agent';
        display_name: string;
        deleted: number;
      };
    const thread = row.thread_id
      ? this.workspaceDatabase.raw
        .prepare('SELECT root_message_id FROM threads WHERE workspace_id = ? AND id = ?')
        .get(row.workspace_id, row.thread_id) as { root_message_id: string }
      : null;
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      conversationId: row.conversation_id,
      projectId: row.project_id,
      threadId: row.thread_id,
      threadRootMessageId: thread?.root_message_id ?? null,
      authorActorId: row.author_actor_id,
      authorMembershipId: row.author_membership_id,
      authorProjectMembershipId: row.author_project_membership_id,
      authorActorType: author.actor_type,
      authorDisplayName: author.display_name,
      authorDeleted: author.deleted === 1,
      body: row.body,
      conversationVersion: row.conversation_version,
      scopePosition: row.scope_position,
      producingRunId: row.producing_run_id,
      producingAttemptId: row.producing_attempt_id,
      mentions: mentions.map((mention) => ({
        actorId: mention.actor_id,
        actorType: mention.actor_type_snapshot,
        displayName: mention.display_name_snapshot,
      })),
      mentionOutcomes,
      artifactReferences: this.artifacts.messageReferences(row.workspace_id, row.id),
      createdAt: row.created_at,
    };
  }

  private requireAgentRequest(agentRequestId: string): AgentRequestRow {
    const row = this.workspaceDatabase.raw
      .prepare(
        `SELECT ar.*, o.message_id AS source_message_id
         FROM agent_requests ar
         JOIN agent_mention_outcomes o ON o.workspace_id = ar.workspace_id AND o.id = ar.mention_outcome_id
         WHERE ar.id = ?`,
      )
      .get(agentRequestId) as AgentRequestRow | undefined;
    invariant(row, 'AGENT_REQUEST_NOT_FOUND', 'Agent Request does not exist.', 404);
    return row;
  }

  private hydrateAgentRequest(row: AgentRequestRow): AgentRequestView {
    let intake: AgentRequestView['intake'] = null;
    if (row.status === 'pending') {
      const target = this.workspaceDatabase.raw
        .prepare(
          `SELECT a.lifecycle_status, m.id AS membership_id,
                  EXISTS (
                    SELECT 1 FROM agent_runtime_bindings b
                    JOIN computers c ON c.id = b.computer_id
                      AND c.status = 'active'
                      AND c.last_seen_at >= ?
                    WHERE b.workspace_id = a.workspace_id AND b.agent_id = a.actor_id AND b.status = 'active'
                  ) AS has_runtime
           FROM agents a
           LEFT JOIN workspace_memberships m
             ON m.workspace_id = a.workspace_id AND m.actor_id = a.actor_id AND m.status = 'active'
           WHERE a.workspace_id = ? AND a.actor_id = ?`,
        )
        .get(nowMs() - COMPUTER_ONLINE_WINDOW_MS, row.workspace_id, row.target_agent_id) as
        | { lifecycle_status: 'active' | 'suspended' | 'deleted'; membership_id: string | null; has_runtime: number }
        | undefined;
      const hasAuthority =
        target !== undefined &&
        target.lifecycle_status !== 'deleted' &&
        target.membership_id !== null &&
        this.hasConversationAccess(row.workspace_id, row.result_conversation_id, target.membership_id);
      if (!hasAuthority) {
        intake = { disposition: 'blocked', reasons: ['authority_revoked'] };
      } else if (target.lifecycle_status === 'suspended') {
        intake = { disposition: 'blocked', reasons: ['agent_suspended'] };
      } else if (target.has_runtime === 0) {
        intake = { disposition: 'waiting', reasons: ['runtime_unavailable'] };
      } else {
        const projectScope = this.workspaceDatabase.raw
          .prepare('SELECT project_id FROM conversations WHERE workspace_id = ? AND id = ?')
          .get(row.workspace_id, row.result_conversation_id) as { project_id: string | null } | undefined;
        const projectHasRepository = projectScope?.project_id !== null && Boolean(this.workspaceDatabase.raw
          .prepare("SELECT 1 FROM project_repositories WHERE project_id = ? AND status = 'active'")
          .get(projectScope?.project_id ?? ''));
        const workingCopyReady = projectScope?.project_id === null || !projectHasRepository || Boolean(this.workspaceDatabase.raw
          .prepare(
            `SELECT 1
             FROM agent_runtime_bindings binding
             JOIN computers computer
               ON computer.id = binding.computer_id
              AND computer.status = 'active'
              AND computer.last_seen_at >= ?
             JOIN computer_project_working_copies wc
               ON wc.computer_id = binding.computer_id
              AND wc.project_id = ?
              AND wc.availability = 'ready'
              AND wc.checked_at >= ?
              AND wc.branch IS NOT NULL
              AND wc.head_commit IS NOT NULL
             JOIN project_repositories repository
               ON repository.project_id = wc.project_id
              AND repository.id = wc.repository_id
              AND repository.status = 'active'
             WHERE binding.workspace_id = ? AND binding.agent_id = ? AND binding.status = 'active'`,
          )
          .get(
            nowMs() - COMPUTER_ONLINE_WINDOW_MS,
            projectScope?.project_id ?? '',
            nowMs() - COMPUTER_ONLINE_WINDOW_MS,
            row.workspace_id,
            row.target_agent_id,
          ));
        intake = workingCopyReady
          ? { disposition: 'ready', reasons: [] }
          : { disposition: 'waiting', reasons: ['project_working_copy_unavailable'] };
      }
    }
    const runRow = row.status === 'accepted'
      ? this.workspaceDatabase.raw
        .prepare(
          `SELECT r.id, r.status, r.outcome, r.deadline_at,
                  s.id AS snapshot_id, s.policy_version_id, p.version AS policy_version,
                  s.workspace_context_version, s.project_id, s.project_context_version,
                  s.conversation_context_version,
                  s.trigger_frontier_json,
                  a.id AS attempt_id, a.status AS attempt_status,
                  (
                    SELECT json_extract(audit.details_json, '$.reason')
                    FROM audit_events audit
                    WHERE audit.workspace_id = r.workspace_id
                      AND audit.target_type = 'run'
                      AND audit.target_id = r.id
                      AND audit.action = 'run.fail'
                    ORDER BY audit.seq DESC
                    LIMIT 1
                  ) AS attempt_failure_reason,
                  (SELECT COUNT(*) FROM run_context_sources rs WHERE rs.snapshot_id = s.id) AS source_count
           FROM runs r
           JOIN run_agent_requests relation
             ON relation.workspace_id = r.workspace_id AND relation.run_id = r.id
           JOIN run_context_snapshots s ON s.workspace_id = r.workspace_id AND s.run_id = r.id
           JOIN agent_execution_policy_versions p ON p.workspace_id = s.workspace_id AND p.id = s.policy_version_id
           LEFT JOIN attempts a ON a.workspace_id = r.workspace_id AND a.run_id = r.id
             AND a.attempt_number = (SELECT MAX(a2.attempt_number) FROM attempts a2 WHERE a2.run_id = r.id)
           WHERE relation.workspace_id = ? AND relation.agent_request_id = ?`,
        )
        .get(row.workspace_id, row.id) as Record<string, unknown> | undefined
      : undefined;
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      sourceMessageId: row.source_message_id,
      targetAgentId: row.target_agent_id,
      resultConversationId: row.result_conversation_id,
      resultThreadId: row.result_thread_id,
      status: row.status,
      version: row.version,
      intake,
      terminalReason: row.terminal_reason_code
        ? { code: row.terminal_reason_code, detail: row.terminal_reason_detail }
        : null,
      run: runRow ? {
        id: String(runRow.id),
        status: String(runRow.status) as 'active' | 'terminal',
        outcome: runRow.outcome === null ? null : String(runRow.outcome) as RunView['outcome'],
        deadlineAt: Number(runRow.deadline_at),
        contextSnapshotId: String(runRow.snapshot_id),
        policyVersion: Number(runRow.policy_version),
        workspaceContextVersion: Number(runRow.workspace_context_version),
        projectId: runRow.project_id === null ? null : String(runRow.project_id),
        projectContextVersion: runRow.project_context_version === null ? null : Number(runRow.project_context_version),
        conversationContextVersion: Number(runRow.conversation_context_version),
        triggerFrontier: JSON.parse(String(runRow.trigger_frontier_json)) as RunContextSnapshotView['triggerFrontier'],
        sourceCount: Number(runRow.source_count),
        attempt: runRow.attempt_id === null || runRow.attempt_id === undefined ? null : {
          id: String(runRow.attempt_id),
          status: String(runRow.attempt_status) as AttemptView['status'],
          failureReason: runRow.attempt_failure_reason === null || runRow.attempt_failure_reason === undefined
            ? null
            : { code: 'runtime_failure', message: String(runRow.attempt_failure_reason) },
        },
      } : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      terminalAt: row.terminal_at,
    };
  }

  private hasConversationAccess(workspaceId: string, conversationId: string, membershipId: string): boolean {
    return Boolean(
      this.workspaceDatabase.raw
        .prepare(
          `SELECT 1
           FROM conversations conversation
           JOIN workspace_memberships membership
             ON membership.workspace_id = conversation.workspace_id
            AND membership.id = ?
            AND membership.status = 'active'
           LEFT JOIN project_memberships project_membership
             ON project_membership.workspace_id = conversation.workspace_id
            AND project_membership.project_id = conversation.project_id
            AND project_membership.workspace_membership_id = membership.id
            AND project_membership.status = 'active'
           LEFT JOIN conversation_direct_memberships direct
             ON direct.workspace_id = conversation.workspace_id
            AND direct.conversation_id = conversation.id
            AND direct.membership_id = membership.id
           WHERE conversation.workspace_id = ? AND conversation.id = ?
             AND (
               (conversation.conversation_kind = 'channel'
                 AND (conversation.project_id IS NULL OR project_membership.id IS NOT NULL))
               OR (conversation.conversation_kind = 'dm' AND direct.id IS NOT NULL)
             )`,
        )
        .get(membershipId, workspaceId, conversationId),
    );
  }

  private cancelRequestsAffectedByScopeMembershipRemoval(
    workspaceId: string,
    conversationId: string,
    removedMembershipId: string,
    removedActorId: string,
    timestamp: number,
  ): string[] {
    const rows = this.workspaceDatabase.raw
      .prepare(
        `SELECT ar.id
         FROM agent_requests ar
         JOIN agent_mention_outcomes o ON o.workspace_id = ar.workspace_id AND o.id = ar.mention_outcome_id
         JOIN messages m ON m.workspace_id = o.workspace_id AND m.id = o.message_id
         WHERE ar.workspace_id = ? AND ar.result_conversation_id = ? AND ar.status = 'pending'
           AND (m.author_membership_id = ? OR ar.target_agent_id = ?)
         ORDER BY ar.created_at, ar.id`,
      )
      .all(workspaceId, conversationId, removedMembershipId, removedActorId) as unknown as Array<{ id: string }>;
    const update = this.workspaceDatabase.raw.prepare(
      `UPDATE agent_requests
       SET status = 'cancelled', version = version + 1,
           terminal_reason_code = 'authority_revoked', terminal_reason_detail = NULL,
           updated_at = ?, terminal_at = ?
       WHERE workspace_id = ? AND id = ? AND status = 'pending'`,
    );
    for (const row of rows) update.run(timestamp, timestamp, workspaceId, row.id);
    this.markInboxRequestsHandled(workspaceId, rows.map((row) => row.id), timestamp);
    return rows.map((row) => row.id);
  }

  private markInboxRequestsHandled(workspaceId: string, requestIds: string[], timestamp: number): void {
    const update = this.workspaceDatabase.raw.prepare(
      `UPDATE agent_inbox_items SET state = 'handled', handled_at = ?
       WHERE workspace_id = ? AND agent_request_id = ? AND state = 'pending'`,
    );
    requestIds.forEach((requestId) => update.run(timestamp, workspaceId, requestId));
  }

  private markRunInboxHandled(workspaceId: string, runId: string, timestamp: number): void {
    this.workspaceDatabase.raw.prepare(
      `UPDATE agent_inbox_items SET state = 'handled', handled_at = ?
       WHERE workspace_id = ? AND claimed_run_id = ? AND state = 'claimed'`,
    ).run(timestamp, workspaceId, runId);
  }

  private bumpConversationContext(conversationId: string, expectedVersion: number | null, timestamp: number): number {
    const statement = expectedVersion === null
      ? this.workspaceDatabase.raw.prepare(
          'UPDATE conversations SET context_version = context_version + 1, updated_at = ? WHERE id = ? RETURNING context_version',
        )
      : this.workspaceDatabase.raw.prepare(
          `UPDATE conversations SET context_version = context_version + 1, updated_at = ?
           WHERE id = ? AND context_version = ? RETURNING context_version`,
        );
    const row = (expectedVersion === null
      ? statement.get(timestamp, conversationId)
      : statement.get(timestamp, conversationId, expectedVersion)) as { context_version: number } | undefined;
    invariant(row, 'CONVERSATION_VERSION_CONFLICT', 'Conversation context version changed.', 409);
    return row.context_version;
  }

  private advanceDiscussionFrontier(workspaceId: string, conversationId: string, threadId: string | null): number {
    if (threadId === null) {
      const row = this.workspaceDatabase.raw
        .prepare(
          `UPDATE conversations SET timeline_frontier = timeline_frontier + 1
           WHERE workspace_id = ? AND id = ? RETURNING timeline_frontier`,
        )
        .get(workspaceId, conversationId) as { timeline_frontier: number } | undefined;
      invariant(row, 'CONVERSATION_NOT_FOUND', 'Conversation does not exist.', 404);
      return row.timeline_frontier;
    }
    const row = this.workspaceDatabase.raw
      .prepare(
        `UPDATE threads SET reply_frontier = reply_frontier + 1
         WHERE workspace_id = ? AND conversation_id = ? AND id = ? RETURNING reply_frontier`,
      )
      .get(workspaceId, conversationId, threadId) as { reply_frontier: number } | undefined;
    invariant(row, 'THREAD_NOT_FOUND', 'Thread does not belong to the conversation.', 404);
    return row.reply_frontier;
  }

  private enqueueDelivery(
    workspaceId: string,
    topic: string,
    aggregateType: string,
    aggregateId: string,
    payload: unknown,
    dedupeKey: string,
    timestamp: number,
  ): void {
    this.workspaceDatabase.raw
      .prepare(
        `INSERT INTO delivery_jobs (
           id, workspace_id, topic, aggregate_type, aggregate_id, payload_json,
           dedupe_key, state, attempts, next_attempt_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
      )
      .run(newId(), workspaceId, topic, aggregateType, aggregateId, canonicalJson(payload), dedupeKey, timestamp, timestamp);
  }

  private idempotent<T>(
    scopeKey: string,
    actorId: string,
    commandName: string,
    idempotencyKey: string,
    request: unknown,
    operation: () => T,
  ): T {
    invariant(idempotencyKey.trim().length > 0, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is required.');
    const requestHash = sha256(canonicalJson(request));
    return this.workspaceDatabase.transaction(() => {
      const existing = this.workspaceDatabase.raw
        .prepare(
          `SELECT request_hash, result_json FROM idempotency_records
           WHERE scope_key = ? AND actor_id = ? AND command_name = ? AND idempotency_key = ?`,
        )
        .get(scopeKey, actorId, commandName, idempotencyKey) as { request_hash: string; result_json: string } | undefined;
      if (existing) {
        invariant(existing.request_hash === requestHash, 'IDEMPOTENCY_CONFLICT', 'Idempotency key was reused with a different request.', 409);
        return JSON.parse(existing.result_json) as T;
      }
      try {
        const result = operation();
        this.workspaceDatabase.raw
          .prepare(
            `INSERT INTO idempotency_records (
               scope_key, actor_id, command_name, idempotency_key, request_hash, result_json, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(scopeKey, actorId, commandName, idempotencyKey, requestHash, canonicalJson(result), nowMs());
        return result;
      } catch (error) {
        if (isSqliteConstraintError(error)) {
          throw new DomainError('CONSTRAINT_VIOLATION', (error as Error).message, 409);
        }
        throw error;
      }
    });
  }

  private requireMembership(workspaceId: string, actorId: string): MembershipRow {
    const row = this.workspaceDatabase.raw
      .prepare("SELECT * FROM workspace_memberships WHERE workspace_id = ? AND actor_id = ? AND status = 'active'")
      .get(workspaceId, actorId) as MembershipRow | undefined;
    invariant(row, 'WORKSPACE_MEMBERSHIP_REQUIRED', 'An active Workspace Membership is required.', 403);
    return row;
  }

  private requireProject(projectId: string): ProjectRow {
    const row = this.workspaceDatabase.raw.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as ProjectRow | undefined;
    invariant(row, 'PROJECT_NOT_FOUND', 'Project does not exist or is not accessible.', 404);
    return row;
  }

  private requireProjectRepository(projectId: string): ProjectRepositoryRow {
    const row = this.findActiveProjectRepository(projectId);
    invariant(row, 'PROJECT_REPOSITORY_NOT_FOUND', 'Project Repository does not exist.', 404);
    return row;
  }

  private findActiveProjectRepository(projectId: string): ProjectRepositoryRow | undefined {
    return this.workspaceDatabase.raw
      .prepare("SELECT * FROM project_repositories WHERE project_id = ? AND status = 'active'")
      .get(projectId) as ProjectRepositoryRow | undefined;
  }

  private requireProjectResourceLink(linkId: string): Record<string, unknown> & {
    id: string;
    workspace_id: string;
    project_id: string;
    created_by_membership_id: string;
  } {
    const row = this.workspaceDatabase.raw.prepare('SELECT * FROM project_resource_links WHERE id = ?').get(linkId) as
      | (Record<string, unknown> & {
          id: string;
          workspace_id: string;
          project_id: string;
          created_by_membership_id: string;
        })
      | undefined;
    invariant(row, 'PROJECT_RESOURCE_LINK_NOT_FOUND', 'Resource Link does not exist.', 404);
    return row;
  }

  private normalizeProjectResourceLink(input: { title: string; url: string; description?: string | null }): {
    title: string;
    url: string;
    description: string | null;
  } {
    const title = input.title.trim();
    invariant(title.length > 0 && title.length <= 200, 'INVALID_RESOURCE_LINK_TITLE', 'Resource Link title is required.');
    let url: URL;
    try {
      url = new URL(input.url.trim());
    } catch {
      throw new DomainError('INVALID_RESOURCE_LINK_URL', 'Resource Link URL must be a valid http or https URL.', 400);
    }
    invariant(url.protocol === 'http:' || url.protocol === 'https:', 'INVALID_RESOURCE_LINK_URL',
      'Resource Link URL must use http or https.');
    invariant(url.toString().length <= 4000, 'INVALID_RESOURCE_LINK_URL', 'Resource Link URL is too long.');
    const description = input.description?.trim() || null;
    invariant(description === null || description.length <= 3000, 'INVALID_RESOURCE_LINK_DESCRIPTION',
      'Resource Link description is too long.');
    return { title, url: url.toString(), description };
  }

  private mapProjectResourceLink(row: Record<string, unknown>): ProjectResourceLinkView {
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      title: String(row.title),
      url: String(row.url),
      description: row.description === null ? null : String(row.description),
      revision: Number(row.revision),
      createdByMembershipId: String(row.created_by_membership_id),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private requireOwnedComputer(principal: ComputerPrincipal): void {
    const row = this.workspaceDatabase.raw
      .prepare("SELECT id FROM computers WHERE id = ? AND owner_human_id = ? AND status = 'active'")
      .get(principal.computerId, principal.ownerHumanId) as { id: string } | undefined;
    invariant(row, 'COMPUTER_NOT_FOUND', 'Computer does not exist or is not active.', 404);
  }

  private requireReadyProjectWorkingCopy(computerId: string, projectId: string): {
    repository: ProjectRepositoryRow;
    headCommit: string;
  } {
    const repository = this.requireProjectRepository(projectId);
    const row = this.workspaceDatabase.raw
      .prepare(
        `SELECT wc.repository_id, wc.availability, wc.branch, wc.head_commit, wc.checked_at,
                computer.status AS computer_status, computer.last_seen_at
         FROM computer_project_working_copies wc
         JOIN computers computer ON computer.id = wc.computer_id
         WHERE wc.computer_id = ? AND wc.project_id = ?`,
      )
      .get(computerId, projectId) as {
        repository_id: string;
        availability: ProjectWorkingCopyView['availability'];
        branch: string | null;
        head_commit: string | null;
        checked_at: number;
        computer_status: 'active' | 'disabled';
        last_seen_at: number | null;
      } | undefined;
    const timestamp = nowMs();
    invariant(
      row
      && row.repository_id === repository.id
      && row.availability === 'ready'
      && row.branch !== null
      && row.head_commit !== null
      && timestamp - row.checked_at <= COMPUTER_ONLINE_WINDOW_MS
      && row.computer_status === 'active'
      && row.last_seen_at !== null
      && timestamp - row.last_seen_at <= COMPUTER_ONLINE_WINDOW_MS,
      'PROJECT_WORKING_COPY_UNAVAILABLE',
      'The selected Computer does not have a fresh matching Project Working Copy.',
      409,
    );
    return { repository, headCommit: row.head_commit };
  }

  private findProjectMembership(
    workspaceId: string,
    projectId: string,
    workspaceMembershipId: string,
  ): ProjectMembershipRow | undefined {
    return this.workspaceDatabase.raw
      .prepare(
        `SELECT * FROM project_memberships
         WHERE workspace_id = ? AND project_id = ? AND workspace_membership_id = ? AND status = 'active'`,
      )
      .get(workspaceId, projectId, workspaceMembershipId) as ProjectMembershipRow | undefined;
  }

  private requireProjectMembership(
    workspaceId: string,
    projectId: string,
    projectMembershipId: string,
  ): ProjectMembershipRow {
    const row = this.workspaceDatabase.raw
      .prepare(
        `SELECT * FROM project_memberships
         WHERE workspace_id = ? AND project_id = ? AND id = ? AND status = 'active'`,
      )
      .get(workspaceId, projectId, projectMembershipId) as ProjectMembershipRow | undefined;
    invariant(row, 'PROJECT_MEMBERSHIP_NOT_FOUND', 'Active Project Membership does not exist.', 404);
    return row;
  }

  private requireProjectAccess(actorId: string, projectId: string): {
    project: ProjectRow;
    workspaceMembership: MembershipRow;
    projectMembership: ProjectMembershipRow;
  } {
    const project = this.requireProject(projectId);
    const workspaceMembership = this.requireMembership(project.workspace_id, actorId);
    const projectMembership = this.findProjectMembership(project.workspace_id, projectId, workspaceMembership.id);
    invariant(projectMembership, 'PROJECT_NOT_FOUND', 'Project does not exist or is not accessible.', 404);
    return { project, workspaceMembership, projectMembership };
  }

  private requireProjectManagerOrWorkspaceOwner(actorId: string, projectId: string): {
    project: ProjectRow;
    workspaceMembership: MembershipRow;
    projectMembership: ProjectMembershipRow | null;
  } {
    const project = this.requireProject(projectId);
    const workspaceMembership = this.requireMembership(project.workspace_id, actorId);
    const projectMembership = this.findProjectMembership(project.workspace_id, projectId, workspaceMembership.id) ?? null;
    invariant(
      projectMembership?.project_role === 'manager' || workspaceMembership.membership_role === 'owner',
      'PROJECT_MANAGER_REQUIRED',
      'A Project Manager or Workspace Owner is required.',
      403,
    );
    return { project, workspaceMembership, projectMembership };
  }

  private requireActiveWorkspaceMember(workspaceId: string, workspaceMembershipId: string): WorkspaceMemberView {
    return this.getWorkspaceMember(workspaceId, workspaceMembershipId);
  }

  private mapProject(project: ProjectRow, membership: ProjectMembershipRow | null, humanId: string): ProjectView {
    const counts = this.workspaceDatabase.raw
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM project_memberships pm
            WHERE pm.project_id = ? AND pm.status = 'active') AS active_member_count,
           (SELECT COUNT(*) FROM conversations c WHERE c.project_id = ?) AS conversation_count,
           (SELECT COUNT(*)
            FROM computer_project_working_copies wc
            JOIN computers computer ON computer.id = wc.computer_id
            WHERE wc.project_id = ? AND computer.owner_human_id = ?) AS connected_computer_count,
           (SELECT COUNT(*)
           FROM computer_project_working_copies wc
            JOIN computers computer ON computer.id = wc.computer_id
            WHERE wc.project_id = ? AND computer.owner_human_id = ?
              AND wc.availability = 'ready'
              AND wc.checked_at >= ?
              AND computer.status = 'active'
              AND computer.last_seen_at >= ?) AS ready_computer_count,
           (SELECT COUNT(*)
            FROM computer_project_working_copies wc
            JOIN computers computer ON computer.id = wc.computer_id
            WHERE wc.project_id = ? AND computer.owner_human_id = ?
              AND wc.availability = 'mismatch') AS mismatch_computer_count,
           (SELECT COUNT(*)
            FROM computer_project_working_copies wc
            JOIN computers computer ON computer.id = wc.computer_id
            WHERE wc.project_id = ? AND computer.owner_human_id = ?
              AND wc.availability = 'ready'
              AND (wc.checked_at < ? OR computer.status <> 'active' OR computer.last_seen_at IS NULL OR computer.last_seen_at < ?)
           ) AS offline_computer_count`,
      )
      .get(
        project.id,
        project.id,
        project.id,
        humanId,
        project.id,
        humanId,
        nowMs() - COMPUTER_ONLINE_WINDOW_MS,
        nowMs() - COMPUTER_ONLINE_WINDOW_MS,
        project.id,
        humanId,
        project.id,
        humanId,
        nowMs() - COMPUTER_ONLINE_WINDOW_MS,
        nowMs() - COMPUTER_ONLINE_WINDOW_MS,
      ) as {
        active_member_count: number;
        conversation_count: number;
        connected_computer_count: number;
        ready_computer_count: number;
        mismatch_computer_count: number;
        offline_computer_count: number;
      };
    const repository = membership ? this.findActiveProjectRepository(project.id) ?? null : null;
    return {
      id: project.id,
      workspaceId: project.workspace_id,
      name: project.name,
      description: project.description,
      revision: project.revision,
      contextVersion: project.context_version,
      membershipId: membership?.id ?? null,
      role: membership?.project_role ?? null,
      governanceOnly: membership === null,
      activeMemberCount: counts.active_member_count,
      conversationCount: counts.conversation_count,
      repository: repository ? this.mapProjectRepository(repository) : null,
      connectedComputerCount: membership ? counts.connected_computer_count : 0,
      readyComputerCount: membership ? counts.ready_computer_count : 0,
      workingCopySummary: membership === null || counts.connected_computer_count === 0
        ? 'not_connected'
        : counts.ready_computer_count > 0
          ? 'connected'
          : counts.mismatch_computer_count > 0
            ? 'mismatch'
            : counts.offline_computer_count > 0
              ? 'computer_offline'
              : 'not_connected',
      createdByMembershipId: project.created_by_membership_id,
      createdAt: project.created_at,
      updatedAt: project.updated_at,
    };
  }

  private mapProjectRepository(repository: ProjectRepositoryRow): ProjectRepositoryView {
    return {
      id: repository.id,
      cloneUrl: repository.clone_url,
      repositoryIdentity: repository.repository_identity,
      defaultBranch: repository.default_branch,
      revision: repository.revision,
    };
  }

  private mapProjectWorkingCopy(row: {
    computer_id: string;
    computer_name: string;
    computer_status: 'active' | 'disabled';
    last_seen_at: number | null;
    availability: ProjectWorkingCopyView['availability'];
    branch: string | null;
    head_commit: string | null;
    dirty: number | null;
    checked_at: number;
  }): ProjectWorkingCopyView {
    return {
      computerId: row.computer_id,
      computerName: row.computer_name,
      connectionStatus: row.computer_status === 'active'
        && row.last_seen_at !== null
        && nowMs() - row.last_seen_at <= COMPUTER_ONLINE_WINDOW_MS
        ? 'online'
        : 'offline',
      availability: row.availability,
      branch: row.branch,
      headCommit: row.head_commit,
      dirty: row.dirty === null ? null : Boolean(row.dirty),
      checkedAt: row.checked_at,
    };
  }

  private requireProjectWorkingCopyView(computerId: string, projectId: string): ProjectWorkingCopyView {
    const row = this.workspaceDatabase.raw
      .prepare(
        `SELECT wc.computer_id, computer.name AS computer_name, computer.status AS computer_status,
                computer.last_seen_at, wc.availability, wc.branch, wc.head_commit, wc.dirty, wc.checked_at
         FROM computer_project_working_copies wc
         JOIN computers computer ON computer.id = wc.computer_id
         WHERE wc.computer_id = ? AND wc.project_id = ?`,
      )
      .get(computerId, projectId) as Parameters<WorkspaceService['mapProjectWorkingCopy']>[0] | undefined;
    invariant(row, 'PROJECT_WORKING_COPY_NOT_FOUND', 'Working Copy connection does not exist.', 404);
    return this.mapProjectWorkingCopy(row);
  }

  private mapProjectMember(row: {
    project_membership_id: string;
    workspace_membership_id: string;
    actor_id: string;
    actor_type: 'human' | 'agent';
    display_name: string;
    project_role: ProjectRole;
    revision: number;
    joined_at: number;
  }): ProjectMemberView {
    return {
      projectMembershipId: row.project_membership_id,
      workspaceMembershipId: row.workspace_membership_id,
      actorId: row.actor_id,
      actorType: row.actor_type,
      displayName: row.display_name,
      role: row.project_role,
      revision: row.revision,
      joinedAt: row.joined_at,
    };
  }

  private getProjectMember(workspaceId: string, projectId: string, projectMembershipId: string): ProjectMemberView {
    const row = this.workspaceDatabase.raw
      .prepare(
        `SELECT pm.id AS project_membership_id, pm.workspace_membership_id,
                wm.actor_id, a.actor_type, COALESCE(h.display_name, ag.name) AS display_name,
                pm.project_role, pm.revision, pm.joined_at
         FROM project_memberships pm
         JOIN workspace_memberships wm
           ON wm.workspace_id = pm.workspace_id AND wm.id = pm.workspace_membership_id AND wm.status = 'active'
         JOIN actors a ON a.id = wm.actor_id
         LEFT JOIN humans h ON h.actor_id = wm.actor_id
         LEFT JOIN agents ag ON ag.workspace_id = wm.workspace_id AND ag.actor_id = wm.actor_id
         WHERE pm.workspace_id = ? AND pm.project_id = ? AND pm.id = ? AND pm.status = 'active'`,
      )
      .get(workspaceId, projectId, projectMembershipId) as Parameters<WorkspaceService['mapProjectMember']>[0] | undefined;
    invariant(row, 'PROJECT_MEMBERSHIP_NOT_FOUND', 'Active Project Membership does not exist.', 404);
    return this.mapProjectMember(row);
  }

  private bumpProjectContext(projectId: string, timestamp: number): number {
    const row = this.workspaceDatabase.raw
      .prepare('UPDATE projects SET context_version = context_version + 1, updated_at = ? WHERE id = ? RETURNING context_version')
      .get(timestamp, projectId) as { context_version: number } | undefined;
    invariant(row, 'PROJECT_NOT_FOUND', 'Project does not exist.', 404);
    return row.context_version;
  }

  private insertConversation(
    principal: HumanPrincipal,
    workspaceId: string,
    projectId: string | null,
    creator: MembershipRow,
    creatorProjectMembership: ProjectMembershipRow | null,
    kind: ConversationKind,
    title: string | undefined,
    directWorkspaceMembershipIds: string[],
  ): ConversationView {
    invariant(
      projectId === null || kind === 'channel',
      'PROJECT_DM_NOT_SUPPORTED',
      'Direct messages belong to the Workspace and cannot be created inside a Project.',
    );
    invariant(
      (projectId === null && creatorProjectMembership === null)
        || (projectId !== null && creatorProjectMembership?.project_id === projectId),
      'INVALID_CONVERSATION_SCOPE',
      'Conversation creator does not belong to the requested scope.',
    );
    const directMembershipIds = [...new Set(directWorkspaceMembershipIds)];
    if (kind === 'dm') {
      invariant(directMembershipIds.length === 2, 'INVALID_DM_PARTICIPANTS', 'A DM must contain exactly two memberships.');
      for (const membershipId of directMembershipIds) this.requireActiveWorkspaceMember(workspaceId, membershipId);
    } else {
      invariant(
        directMembershipIds.length === 0,
        'CHANNEL_MEMBERS_ARE_DERIVED',
        'Channel members are derived from the Workspace or Project scope.',
      );
    }
    const conversationId = newId();
    const timestamp = nowMs();
    this.workspaceDatabase.raw
      .prepare(
        `INSERT INTO conversations (
           id, workspace_id, project_id, conversation_kind, title,
           created_by_membership_id, created_by_project_membership_id,
           context_version, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        conversationId,
        workspaceId,
        projectId,
        kind,
        title?.trim() || null,
        creator.id,
        creatorProjectMembership?.id ?? null,
        timestamp,
        timestamp,
      );
    const insertDirectMembership = this.workspaceDatabase.raw.prepare(
      `INSERT INTO conversation_direct_memberships (
         id, workspace_id, conversation_id, membership_id, joined_at
       ) VALUES (?, ?, ?, ?, ?)`,
    );
    for (const membershipId of directMembershipIds) {
      insertDirectMembership.run(
        newId(),
        workspaceId,
        conversationId,
        membershipId,
        timestamp,
      );
    }
    const projectVersion = projectId ? this.bumpProjectContext(projectId, timestamp) : null;
    this.appendChange(
      workspaceId,
      null,
      conversationId,
      1,
      'conversation_created',
      'conversation',
      conversationId,
      {
        kind,
        projectId,
        ...(kind === 'dm' ? { directWorkspaceMembershipIds: directMembershipIds } : {}),
      },
      timestamp,
      { projectId, projectVersion },
    );
    this.appendAudit(workspaceId, principal.actorId, creator.id, 'conversation.create', 'conversation', conversationId, {
      kind,
      projectId,
    }, timestamp);
    return this.mapConversation({
      id: conversationId,
      workspace_id: workspaceId,
      project_id: projectId,
      conversation_kind: kind,
      title: title?.trim() || null,
      lifecycle_status: 'active',
      revision: 1,
      archived_at: null,
      archived_by_membership_id: null,
      created_by_membership_id: creator.id,
      created_by_project_membership_id: creatorProjectMembership?.id ?? null,
      context_version: 1,
      timeline_frontier: 0,
      created_at: timestamp,
      updated_at: timestamp,
    });
  }

  private conversationChangeOptions(conversation: ConversationAccess['conversation']): {
    projectId?: string;
    projectVersion?: number;
  } {
    if (conversation.project_id === null) return {};
    const project = this.requireProject(conversation.project_id);
    return { projectId: project.id, projectVersion: project.context_version };
  }

  private requireConversationAccess(actorId: string, conversationId: string): ConversationAccess {
    const conversation = this.workspaceDatabase.raw.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId) as
      | ConversationAccess['conversation']
      | undefined;
    invariant(conversation, 'CONVERSATION_NOT_FOUND', 'Conversation does not exist or is not accessible.', 404);
    const membership = this.requireMembership(conversation.workspace_id, actorId);
    const projectMembership = conversation.project_id
      ? this.findProjectMembership(conversation.workspace_id, conversation.project_id, membership.id) ?? null
      : null;
    invariant(
      conversation.project_id === null || projectMembership,
      'CONVERSATION_NOT_FOUND',
      'Conversation does not exist or is not accessible.',
      404,
    );
    invariant(
      this.hasConversationAccess(conversation.workspace_id, conversationId, membership.id),
      'CONVERSATION_NOT_FOUND',
      'Conversation does not exist or is not accessible.',
      404,
    );
    return { conversation, membership, projectMembership };
  }

  private transitionConversationLifecycle(
    principal: HumanPrincipal,
    conversationId: string,
    from: 'active' | 'archived',
    to: 'active' | 'archived',
    expectedRevision: number,
    idempotencyKey: string,
  ): ConversationView {
    const existing = this.requireConversationAccess(principal.actorId, conversationId);
    const command = to === 'archived' ? 'ArchiveConversation' : 'RestoreConversation';
    return this.idempotent(
      existing.conversation.workspace_id,
      principal.actorId,
      command,
      idempotencyKey,
      { conversationId, expectedRevision },
      () => {
        const access = this.requireConversationAccess(principal.actorId, conversationId);
        this.requireConversationLifecycleAuthority(access);
        invariant(
          access.conversation.lifecycle_status === from,
          to === 'archived' ? 'CONVERSATION_NOT_ACTIVE' : 'CONVERSATION_NOT_ARCHIVED',
          to === 'archived' ? 'Only an active Conversation can be archived.' : 'Only an archived Conversation can be restored.',
          409,
        );
        invariant(
          access.conversation.revision === expectedRevision,
          'CONVERSATION_REVISION_CONFLICT',
          'Conversation revision changed.',
          409,
        );
        if (to === 'archived') {
          const blockingExecution = this.workspaceDatabase.raw
            .prepare(
              `SELECT ar.id
               FROM agent_requests ar
               LEFT JOIN runs run ON run.workspace_id = ar.workspace_id AND run.agent_request_id = ar.id
               WHERE ar.workspace_id = ? AND ar.result_conversation_id = ?
                 AND (ar.status = 'pending' OR run.status = 'active')
               LIMIT 1`,
            )
            .get(access.conversation.workspace_id, conversationId);
          invariant(
            !blockingExecution,
            'CONVERSATION_HAS_ACTIVE_EXECUTION',
            'Cancel or finish pending Agent Requests and active Runs before archiving this Conversation.',
            409,
          );
        }
        const timestamp = nowMs();
        const archived = to === 'archived';
        const update = this.workspaceDatabase.raw
          .prepare(
            `UPDATE conversations
             SET lifecycle_status = ?, revision = revision + 1,
                 archived_at = ?, archived_by_membership_id = ?, updated_at = ?
             WHERE workspace_id = ? AND id = ? AND lifecycle_status = ? AND revision = ?`,
          )
          .run(
            to,
            archived ? timestamp : null,
            archived ? access.membership.id : null,
            timestamp,
            access.conversation.workspace_id,
            conversationId,
            from,
            expectedRevision,
          );
        invariant(update.changes === 1, 'CONVERSATION_REVISION_CONFLICT', 'Conversation changed concurrently.', 409);
        const conversationVersion = this.bumpConversationContext(conversationId, null, timestamp);
        const projectVersion = access.conversation.project_id === null
          ? null
          : this.bumpProjectContext(access.conversation.project_id, timestamp);
        const changeType = archived ? 'conversation_archived' : 'conversation_restored';
        this.appendChange(
          access.conversation.workspace_id,
          null,
          conversationId,
          conversationVersion,
          changeType,
          'conversation',
          conversationId,
          { lifecycleStatus: to, revision: expectedRevision + 1 },
          timestamp,
          access.conversation.project_id === null
            ? {}
            : { projectId: access.conversation.project_id, projectVersion: projectVersion! },
        );
        this.enqueueDelivery(
          access.conversation.workspace_id,
          `conversation.${archived ? 'archived' : 'restored'}`,
          'conversation',
          conversationId,
          { conversationId, lifecycleStatus: to, revision: expectedRevision + 1 },
          `${to}:${conversationId}:${expectedRevision + 1}`,
          timestamp,
        );
        this.appendAudit(
          access.conversation.workspace_id,
          principal.actorId,
          access.membership.id,
          `conversation.${archived ? 'archive' : 'restore'}`,
          'conversation',
          conversationId,
          { revision: expectedRevision + 1 },
          timestamp,
        );
        const row = this.workspaceDatabase.raw
          .prepare('SELECT * FROM conversations WHERE workspace_id = ? AND id = ?')
          .get(access.conversation.workspace_id, conversationId) as ConversationAccess['conversation'];
        return this.mapConversation(row);
      },
    );
  }

  private requireConversationLifecycleAuthority(access: ConversationAccess): void {
    const allowed = access.conversation.conversation_kind === 'dm'
      || access.conversation.created_by_membership_id === access.membership.id
      || access.membership.membership_role === 'owner'
      || access.projectMembership?.project_role === 'manager';
    invariant(
      allowed,
      'FORBIDDEN',
      'Only a DM participant, Conversation creator, Project Manager, or Workspace Owner may change Conversation lifecycle.',
      403,
    );
  }

  private requireConversationWritable(conversation: ConversationAccess['conversation']): void {
    invariant(
      conversation.lifecycle_status === 'active',
      'CONVERSATION_ARCHIVED',
      'Archived Conversations are read-only until restored.',
      409,
    );
    if (conversation.conversation_kind !== 'dm') return;
    const row = this.workspaceDatabase.raw
      .prepare(
        `SELECT COUNT(*) AS count
         FROM conversation_direct_memberships direct
         JOIN workspace_memberships m
           ON m.workspace_id = direct.workspace_id
          AND m.id = direct.membership_id
          AND m.status = 'active'
         WHERE direct.workspace_id = ? AND direct.conversation_id = ?`,
      )
      .get(conversation.workspace_id, conversation.id) as { count: number };
    invariant(
      row.count === 2,
      'CONVERSATION_CLOSED',
      'This DM is read-only because a participant is no longer active.',
      409,
    );
  }

  private mapConversation(row: {
    id: string;
    workspace_id: string;
    project_id: string | null;
    conversation_kind: ConversationKind;
    title: string | null;
    lifecycle_status: 'active' | 'archived';
    revision: number;
    archived_at: number | null;
    archived_by_membership_id: string | null;
    created_by_membership_id: string;
    created_by_project_membership_id: string | null;
    context_version: number;
    timeline_frontier: number;
    created_at: number;
    updated_at: number;
  }): ConversationView {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      projectId: row.project_id,
      kind: row.conversation_kind,
      title: row.title,
      lifecycleStatus: row.lifecycle_status,
      revision: row.revision,
      archivedAt: row.archived_at,
      archivedByMembershipId: row.archived_by_membership_id,
      contextVersion: row.context_version,
      timelineFrontier: row.timeline_frontier,
      createdByMembershipId: row.created_by_membership_id,
      createdByProjectMembershipId: row.created_by_project_membership_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private bumpWorkspaceContext(workspaceId: string, timestamp: number): number {
    const row = this.workspaceDatabase.raw
      .prepare('UPDATE workspaces SET context_version = context_version + 1, updated_at = ? WHERE id = ? RETURNING context_version')
      .get(timestamp, workspaceId) as { context_version: number } | undefined;
    invariant(row, 'WORKSPACE_NOT_FOUND', 'Workspace does not exist.', 404);
    return row.context_version;
  }

  private listConversationRecipientMembershipIds(workspaceId: string, conversationId: string): string[] {
    return this.workspaceDatabase.raw
      .prepare(
        `SELECT DISTINCT membership.id
         FROM conversations conversation
         JOIN workspace_memberships membership
           ON membership.workspace_id = conversation.workspace_id
          AND membership.status = 'active'
         LEFT JOIN project_memberships project_membership
           ON project_membership.workspace_id = conversation.workspace_id
          AND project_membership.project_id = conversation.project_id
          AND project_membership.workspace_membership_id = membership.id
          AND project_membership.status = 'active'
         LEFT JOIN conversation_direct_memberships direct
           ON direct.workspace_id = conversation.workspace_id
          AND direct.conversation_id = conversation.id
          AND direct.membership_id = membership.id
         WHERE conversation.workspace_id = ? AND conversation.id = ?
           AND (
             (conversation.conversation_kind = 'channel'
               AND (conversation.project_id IS NULL OR project_membership.id IS NOT NULL))
             OR (conversation.conversation_kind = 'dm' AND direct.id IS NOT NULL)
           )
         ORDER BY membership.id`,
      )
      .all(workspaceId, conversationId)
      .map((row) => String((row as { id: string }).id));
  }

  private appendChange(
    workspaceId: string,
    workspaceVersion: number | null,
    conversationId: string | null,
    conversationVersion: number | null,
    changeType: string,
    sourceType: string,
    sourceId: string,
    payload: unknown,
    timestamp: number,
    options: {
      projectId?: string | null;
      projectVersion?: number | null;
      recipientMembershipIds?: string[];
      additionalRecipientMembershipIds?: string[];
    } = {},
  ): void {
    const inserted = this.workspaceDatabase.raw
      .prepare(
        `INSERT INTO workspace_changes (
           workspace_id, workspace_context_version, project_id, project_context_version,
           conversation_id, conversation_context_version,
           change_type, source_type, source_id, payload_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING position`,
      )
      .get(
        workspaceId,
        workspaceVersion,
        options.projectId ?? null,
        options.projectVersion ?? null,
        conversationId,
        conversationVersion,
        changeType,
        sourceType,
        sourceId,
        canonicalJson(payload),
        timestamp,
      ) as { position: number };
    const recipients = options.recipientMembershipIds ?? (conversationId !== null
      ? this.listConversationRecipientMembershipIds(workspaceId, conversationId)
      : options.projectId
        ? this.workspaceDatabase.raw
          .prepare(
            `SELECT workspace_membership_id FROM project_memberships
             WHERE workspace_id = ? AND project_id = ? AND status = 'active'`,
          )
          .all(workspaceId, options.projectId)
          .map((row) => String((row as { workspace_membership_id: string }).workspace_membership_id))
        : this.workspaceDatabase.raw
          .prepare("SELECT id FROM workspace_memberships WHERE workspace_id = ? AND status = 'active'")
          .all(workspaceId)
          .map((row) => String((row as { id: string }).id)));
    const allRecipients = new Set([...recipients, ...(options.additionalRecipientMembershipIds ?? [])]);
    const insertRecipient = this.workspaceDatabase.raw.prepare(
      'INSERT OR IGNORE INTO workspace_change_recipients (workspace_id, change_position, membership_id) VALUES (?, ?, ?)',
    );
    for (const membershipId of allRecipients) insertRecipient.run(workspaceId, inserted.position, membershipId);
  }

  private appendAudit(
    workspaceId: string,
    actorId: string,
    membershipId: string | null,
    action: string,
    targetType: string,
    targetId: string,
    details: unknown,
    timestamp: number,
  ): void {
    const previous = this.workspaceDatabase.raw
      .prepare('SELECT seq, hash FROM audit_events WHERE workspace_id = ? ORDER BY seq DESC LIMIT 1')
      .get(workspaceId) as { seq: number; hash: string } | undefined;
    const seq = (previous?.seq ?? 0) + 1;
    const prevHash = previous?.hash ?? '0'.repeat(64);
    const detailsJson = canonicalJson(details);
    const hash = this.auditHash({
      workspaceId,
      seq,
      prevHash,
      actorId,
      actorMembershipId: membershipId,
      action,
      targetType,
      targetId,
      detailsJson,
      createdAt: timestamp,
    });
    this.workspaceDatabase.raw
      .prepare(
        `INSERT INTO audit_events (
           workspace_id, seq, prev_hash, hash, actor_id, actor_membership_id,
           action, target_type, target_id, details_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(workspaceId, seq, prevHash, hash, actorId, membershipId, action, targetType, targetId, detailsJson, timestamp);
  }

  private auditHash(input: {
    workspaceId: string;
    seq: number;
    prevHash: string;
    actorId: string;
    actorMembershipId: string | null;
    action: string;
    targetType: string;
    targetId: string;
    detailsJson: string;
    createdAt: number;
  }): string {
    return createHash('sha256').update(canonicalJson(input)).digest('hex');
  }

  private requireExecutionContext(attemptId: string): ExecutionContextRow {
    const row = this.workspaceDatabase.raw
      .prepare(
        `SELECT a.id AS attempt_id, r.id AS run_id, r.workspace_id,
                ar.result_conversation_id AS conversation_id, ar.result_thread_id,
                t.root_message_id, r.agent_id, r.agent_membership_id,
                r.project_id, r.agent_project_membership_id,
                rcs.id AS run_context_snapshot_id,
                w.context_version AS workspace_context_version,
                c.context_version AS conversation_context_version,
                c.timeline_frontier, t.reply_frontier,
                COALESCE((SELECT MAX(position) FROM workspace_changes wc WHERE wc.workspace_id = r.workspace_id), 0) AS change_cursor
         FROM attempts a
         JOIN runs r ON r.workspace_id = a.workspace_id AND r.id = a.run_id
         JOIN agent_requests ar ON ar.workspace_id = r.workspace_id AND ar.id = r.agent_request_id
         JOIN run_context_snapshots rcs ON rcs.workspace_id = r.workspace_id AND rcs.run_id = r.id
         JOIN workspaces w ON w.id = r.workspace_id
         JOIN conversations c ON c.workspace_id = r.workspace_id AND c.id = ar.result_conversation_id
         LEFT JOIN threads t ON t.workspace_id = r.workspace_id
           AND t.conversation_id = ar.result_conversation_id AND t.id = ar.result_thread_id
         WHERE a.id = ?`,
      )
      .get(attemptId) as ExecutionContextRow | undefined;
    invariant(row, 'ATTEMPT_NOT_FOUND', 'Attempt does not exist.', 404);
    return row;
  }

  private requireRun(runId: string): RunRow {
    const row = this.workspaceDatabase.raw.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as RunRow | undefined;
    invariant(row, 'RUN_NOT_FOUND', 'Run does not exist.', 404);
    return row;
  }

  private hydrateRun(row: RunRow): RunView {
    const policy = this.hydrateExecutionPolicy(this.requirePolicyById(row.policy_version_id));
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      agentRequestId: row.agent_request_id,
      agentId: row.agent_id,
      agentMembershipId: row.agent_membership_id,
      projectId: row.project_id,
      agentProjectMembershipId: row.agent_project_membership_id,
      bindingId: row.binding_id,
      bindingRevision: row.binding_revision,
      policyVersionId: row.policy_version_id,
      policyVersion: policy.version,
      budget: this.parseBudget(row.effective_budget_json),
      status: row.status,
      outcome: row.outcome,
      deadlineAt: row.deadline_at,
      createdAt: row.created_at,
      terminalAt: row.terminal_at,
    };
  }

  private requireAttempt(attemptId: string): AttemptRow {
    const row = this.workspaceDatabase.raw.prepare('SELECT * FROM attempts WHERE id = ?').get(attemptId) as AttemptRow | undefined;
    invariant(row, 'ATTEMPT_NOT_FOUND', 'Attempt does not exist.', 404);
    return row;
  }

  private hydrateAttempt(row: AttemptRow): AttemptView {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      runId: row.run_id,
      attemptNumber: row.attempt_number,
      status: row.status,
      bindingRevision: row.binding_revision,
      policyVersionId: row.policy_version_id,
      budget: this.parseBudget(row.effective_budget_json),
      deadlineAt: row.deadline_at,
      createdAt: row.created_at,
      finishedAt: row.finished_at,
    };
  }

  authorizeComputerForRunRequest(computerId: string, runId: string): void {
    const row = this.workspaceDatabase.raw
      .prepare(
        `SELECT 1 FROM runs r
         JOIN agent_runtime_bindings b ON b.workspace_id = r.workspace_id AND b.id = r.binding_id
         WHERE r.id = ? AND b.computer_id = ? AND b.status = 'active'
           AND b.binding_revision = r.binding_revision`,
      )
      .get(runId, computerId);
    invariant(row, 'RUN_NOT_FOUND', 'Run does not exist or is not assigned to this Computer.', 404);
  }

  private requirePolicyById(policyId: string): Record<string, unknown> {
    const row = this.workspaceDatabase.raw
      .prepare('SELECT * FROM agent_execution_policy_versions WHERE id = ?')
      .get(policyId) as Record<string, unknown> | undefined;
    invariant(row, 'EXECUTION_POLICY_NOT_FOUND', 'Execution Policy does not exist.', 404);
    return row;
  }

  private clampBudget(
    policy: AgentExecutionPolicyView,
    requested?: Partial<{ maxWallTimeMs: number; maxContextBytes: number; maxToolCalls: number }>,
  ): { maxWallTimeMs: number; maxContextBytes: number; maxToolCalls: number } {
    const candidate = {
      maxWallTimeMs: requested?.maxWallTimeMs ?? policy.maxWallTimeMs,
      maxContextBytes: requested?.maxContextBytes ?? policy.maxContextBytes,
      maxToolCalls: requested?.maxToolCalls ?? policy.maxToolCalls,
    };
    invariant(
      Number.isSafeInteger(candidate.maxWallTimeMs) && candidate.maxWallTimeMs >= 1000 && candidate.maxWallTimeMs <= policy.maxWallTimeMs
      && Number.isSafeInteger(candidate.maxContextBytes) && candidate.maxContextBytes >= 1024 && candidate.maxContextBytes <= policy.maxContextBytes
      && Number.isSafeInteger(candidate.maxToolCalls) && candidate.maxToolCalls >= 0 && candidate.maxToolCalls <= policy.maxToolCalls,
      'INVALID_EFFECTIVE_BUDGET',
      'Effective budget must be positive and no greater than the accepted Execution Policy.',
    );
    return candidate;
  }

  private parseBudget(value: string): { maxWallTimeMs: number; maxContextBytes: number; maxToolCalls: number } {
    return JSON.parse(value) as { maxWallTimeMs: number; maxContextBytes: number; maxToolCalls: number };
  }

  private currentChangeCursor(workspaceId: string): number {
    const row = this.workspaceDatabase.raw
      .prepare('SELECT COALESCE(MAX(position), 0) AS position FROM workspace_changes WHERE workspace_id = ?')
      .get(workspaceId) as { position: number };
    return row.position;
  }

  private requireWorkspaceVersion(workspaceId: string): number {
    const row = this.workspaceDatabase.raw.prepare('SELECT context_version FROM workspaces WHERE id = ?').get(workspaceId) as
      | { context_version: number }
      | undefined;
    invariant(row, 'WORKSPACE_NOT_FOUND', 'Workspace does not exist.', 404);
    return row.context_version;
  }

  private requireMentionOutcomeId(agentRequestId: string): string {
    const row = this.workspaceDatabase.raw.prepare('SELECT mention_outcome_id FROM agent_requests WHERE id = ?').get(agentRequestId) as
      | { mention_outcome_id: string }
      | undefined;
    invariant(row, 'AGENT_REQUEST_NOT_FOUND', 'Agent Request does not exist.', 404);
    return row.mention_outcome_id;
  }

  private discussionScope(conversationId: string, threadId: string | null, rootMessageId: string | null) {
    return threadId === null
      ? { kind: 'timeline' as const, conversationId, threadId: null, rootMessageId: null }
      : { kind: 'thread' as const, conversationId, threadId, rootMessageId };
  }

  private validateSourceRef(source: ContextSourceRef, privateSource = false): void {
    invariant(source.sourceId.trim().length > 0 && source.sourceVersion.trim().length > 0,
      'INVALID_CONTEXT_SOURCE_REF', 'Context source id and opaque version are required.');
    invariant(Number.isSafeInteger(source.sourceOrder) && source.sourceOrder >= 0,
      'INVALID_CONTEXT_SOURCE_REF', 'Context source order is invalid.');
    invariant(/^[a-f0-9]{64}$/.test(source.contentDigest),
      'INVALID_CONTEXT_SOURCE_REF', 'Context source digest must be lowercase SHA-256.');
    if (!privateSource) {
      invariant(AVAILABLE_CONTEXT_SOURCE_KINDS.has(source.kind), 'CONTEXT_SOURCE_KIND_UNAVAILABLE',
        `Context source kind ${source.kind} has no active Authority resolver.`, 409);
    }
  }

  private insertRunContextSources(snapshotId: string, sources: ContextSourceRef[]): void {
    const insert = this.workspaceDatabase.raw.prepare(
      `INSERT INTO run_context_sources (
         snapshot_id, source_kind, source_id, source_version, source_order, content_digest, metadata_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const source of sources) {
      this.validateSourceRef(source);
      insert.run(
        snapshotId, source.kind, source.sourceId, source.sourceVersion,
        source.sourceOrder, source.contentDigest, canonicalJson(source.metadata),
      );
    }
  }

  private renderDeveloperInstructions(agentId: string): string {
    const agent = this.workspaceDatabase.raw.prepare(
      `SELECT agent.name, agent.description, workspace.name AS workspace_name
       FROM agents agent
       JOIN workspaces workspace ON workspace.id = agent.workspace_id
       WHERE agent.actor_id = ? AND agent.lifecycle_status = 'active'`,
    ).get(agentId) as { name: string; description: string | null; workspace_name: string } | undefined;
    invariant(agent, 'AGENT_NOT_FOUND', 'Agent does not exist.', 404);
    return [
      '# Agent identity and Workspace protocol',
      '',
      `You are ${agent.name}, a persistent Agent in the ${agent.workspace_name} Workspace.`,
      agent.description?.trim() ? `Your role: ${agent.description.trim()}` : '',
      `Stable Agent ID: ${agentId}`,
      '',
      `Identify yourself as ${agent.name}; do not describe yourself as a generic Runtime, Codex session, or Attempt.`,
      'On each lightweight wake, use teamctl to inspect the Agent Inbox and explicitly claim the pending Discussion Scope.',
      'User Message bodies are available only through teamctl message check/read/resolve and are never embedded in wake text.',
      'Workspace documents and Artifacts are shared team knowledge, not identity instructions.',
      'Publish messages, Artifact changes, and final status only through the injected Workspace tools.',
      'Security, authorization, budgets, and disclosure rules are enforced by the Workspace and Local Computer gateway.',
    ].filter(Boolean).join('\n').trim();
  }

  private messageSourceRef(
    message: MessageRow,
    sourceOrder: number,
    scope: ReturnType<WorkspaceService['discussionScope']>,
  ): ContextSourceRef {
    const author = this.workspaceDatabase.raw.prepare(
      `SELECT a.actor_type, COALESCE(h.display_name, ag.name) AS display_name
       FROM actors a
       LEFT JOIN humans h ON h.actor_id = a.id
       LEFT JOIN agents ag ON ag.actor_id = a.id AND ag.workspace_id = ?
       WHERE a.id = ?`,
    ).get(message.workspace_id, message.author_actor_id) as {
      actor_type: 'human' | 'agent';
      display_name: string;
    } | undefined;
    return {
      kind: 'message',
      sourceId: message.id,
      sourceVersion: String(message.scope_position),
      sourceOrder,
      contentDigest: sha256(message.body),
      metadata: {
        scope,
        authorActorId: message.author_actor_id,
        authorActorType: author?.actor_type ?? 'human',
        authorDisplayName: author?.display_name ?? message.author_actor_id,
        createdAt: message.created_at,
        mediaType: 'text/plain; charset=utf-8',
        byteLength: Buffer.byteLength(message.body),
      },
    };
  }

  private hydrateSourceRefs(snapshotId: string): ContextSourceRef[] {
    const rows = this.workspaceDatabase.raw
      .prepare('SELECT * FROM run_context_sources WHERE snapshot_id = ? ORDER BY source_order')
      .all(snapshotId) as unknown as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      kind: String(row.source_kind) as ContextSourceKind,
      sourceId: String(row.source_id),
      sourceVersion: String(row.source_version),
      sourceOrder: Number(row.source_order),
      contentDigest: String(row.content_digest),
      metadata: JSON.parse(String(row.metadata_json)) as Record<string, unknown>,
    }));
  }

  private hydrateRunContextSnapshot(row: Record<string, unknown>): RunContextSnapshotView {
    const policy = this.hydrateExecutionPolicy(this.requirePolicyById(String(row.policy_version_id)));
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      runId: String(row.run_id),
      objective: String(row.objective),
      triggerMessageId: String(row.trigger_message_id),
      mentionOutcomeId: String(row.mention_outcome_id),
      sourceScope: JSON.parse(String(row.source_scope_json)) as RunContextSnapshotView['sourceScope'],
      resultScope: JSON.parse(String(row.result_scope_json)) as RunContextSnapshotView['resultScope'],
      triggerFrontier: JSON.parse(String(row.trigger_frontier_json)) as RunContextSnapshotView['triggerFrontier'],
      agentMembershipId: String(row.agent_membership_id),
      policyVersionId: String(row.policy_version_id),
      policyVersion: policy.version,
      budget: this.parseBudget(String(row.effective_budget_json)),
      workspaceContextVersion: Number(row.workspace_context_version),
      projectId: row.project_id === null ? null : String(row.project_id),
      projectContextVersion: row.project_context_version === null ? null : Number(row.project_context_version),
      repositoryId: row.repository_id === null ? null : String(row.repository_id),
      repositoryIdentity: row.repository_identity === null ? null : String(row.repository_identity),
      repositoryBaseCommit: row.repository_base_commit === null ? null : String(row.repository_base_commit),
      conversationContextVersion: Number(row.conversation_context_version),
      changeCursor: Number(row.change_cursor),
      sources: this.hydrateSourceRefs(String(row.id)),
      createdAt: Number(row.created_at),
    };
  }

  private requirePrivateGrant(grantId: string): PrivateGrantRow {
    const row = this.workspaceDatabase.raw.prepare('SELECT * FROM private_context_grants WHERE id = ?').get(grantId) as
      | PrivateGrantRow
      | undefined;
    invariant(row, 'PRIVATE_CONTEXT_GRANT_NOT_FOUND', 'Private Context Grant does not exist.', 404);
    return row;
  }

  private hydratePrivateGrant(row: PrivateGrantRow): PrivateContextGrantView {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      runId: row.run_id,
      grantedByMembershipId: row.granted_by_membership_id,
      sourceCategory: row.source_category,
      readAllowed: row.read_allowed === 1,
      disclosureAllowed: row.disclosure_allowed === 1,
      policyVersionId: row.policy_version_id,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      createdAt: row.created_at,
    };
  }

  private sourceExistsInRunContext(snapshotId: string, source: ContextSourceRef): boolean {
    return Boolean(this.workspaceDatabase.raw
      .prepare(
        `SELECT 1 FROM run_context_sources
         WHERE snapshot_id = ? AND source_kind = ? AND source_id = ? AND source_version = ? AND content_digest = ?`,
      )
      .get(snapshotId, source.kind, source.sourceId, source.sourceVersion, source.contentDigest));
  }

  private validateReturnDisclosure(runId: string, envelope: RuntimeReturnEnvelope): void {
    const grantIds = new Set([
      ...envelope.messages.flatMap((message) => message.privateGrantIds ?? []),
      ...envelope.artifactPublications.flatMap((artifact) => artifact.privateGrantIds ?? []),
    ]);
    for (const grantId of grantIds) {
      const grant = this.requirePrivateGrant(grantId);
      invariant(grant.run_id === runId, 'PRIVATE_CONTEXT_GRANT_MISMATCH', 'Return references a grant from another Run.', 403);
      invariant(grant.disclosure_allowed === 1, 'PRIVATE_CONTEXT_DISCLOSURE_FORBIDDEN',
        'Return may not disclose content, paths, or reversible summaries from this Private Context Grant.', 403);
      invariant(grant.read_allowed === 1 && grant.revoked_at === null && grant.expires_at > nowMs(),
        'PRIVATE_CONTEXT_GRANT_INACTIVE', 'Return references a revoked, expired, or unreadable Private Context Grant.', 403);
    }
  }

  private publishAgentMessage(
    context: ExecutionContextRow,
    body: string,
    artifactSnapshotIds: string[],
    timestamp: number,
  ): MessageView {
    const normalizedBody = body.trim();
    invariant(normalizedBody.length > 0, 'INVALID_MESSAGE', 'Agent Message body is required.');
    const conversation = this.workspaceDatabase.raw
      .prepare('SELECT * FROM conversations WHERE workspace_id = ? AND id = ?')
      .get(context.workspace_id, context.conversation_id) as ConversationAccess['conversation'];
    this.requireConversationWritable(conversation);
    const conversationVersion = this.bumpConversationContext(context.conversation_id, null, timestamp);
    const scopePosition = this.advanceDiscussionFrontier(context.workspace_id, context.conversation_id, context.result_thread_id);
    const messageId = newId();
    this.workspaceDatabase.raw
      .prepare(
        `INSERT INTO messages (
           id, workspace_id, conversation_id, project_id, thread_id,
           author_actor_id, author_membership_id, author_project_membership_id,
           body, conversation_version, scope_position, producing_run_id, producing_attempt_id,
           created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        messageId, context.workspace_id, context.conversation_id, context.project_id, context.result_thread_id,
        context.agent_id, context.agent_membership_id, context.agent_project_membership_id,
        normalizedBody, conversationVersion, scopePosition,
        context.run_id, context.attempt_id, timestamp,
      );
    const artifactSnapshots = this.artifacts.validateMessageSnapshotIds(context.workspace_id, artifactSnapshotIds);
    this.artifacts.insertMessageReferences(context.workspace_id, messageId, artifactSnapshots, timestamp);
    this.appendChange(
      context.workspace_id, null, context.conversation_id, conversationVersion,
      'message_created', 'message', messageId,
      { threadId: context.result_thread_id, scopePosition, producingRunId: context.run_id }, timestamp,
      context.project_id ? {
        projectId: context.project_id,
        projectVersion: this.requireProject(context.project_id).context_version,
      } : {},
    );
    this.appendAudit(
      context.workspace_id, context.agent_id, context.agent_membership_id,
      'message.post', 'message', messageId,
      { runId: context.run_id, attemptId: context.attempt_id }, timestamp,
    );
    return this.hydrateMessage(this.requireMessage(messageId), this.requireMembership(context.workspace_id, context.agent_id));
  }

  private mapChange(row: Record<string, unknown>): ChangeRecord {
    return {
      position: Number(row.position),
      workspaceId: String(row.workspace_id),
      workspaceContextVersion: row.workspace_context_version === null ? null : Number(row.workspace_context_version),
      projectId: row.project_id === null ? null : String(row.project_id),
      projectContextVersion: row.project_context_version === null ? null : Number(row.project_context_version),
      conversationId: row.conversation_id === null ? null : String(row.conversation_id),
      conversationContextVersion: row.conversation_context_version === null ? null : Number(row.conversation_context_version),
      changeType: String(row.change_type),
      sourceType: String(row.source_type),
      sourceId: String(row.source_id),
      payload: JSON.parse(String(row.payload_json)),
      createdAt: Number(row.created_at),
    };
  }
}
