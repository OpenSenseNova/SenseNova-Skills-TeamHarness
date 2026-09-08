import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type {
  AgentActivityEventInput,
  AgentActivityEventView,
  AgentMentionOutcomeView,
  AgentRequestStatus,
  AgentRequestView,
  AgentRuntimeSkillsView,
  AgentExecutionPolicy,
  AgentExecutionPolicyView,
  AgentInboxClaimView,
  AgentInboxCompletionResultView,
  AgentInboxDiscussionDeltaView,
  AgentInboxAttentionView,
  AgentInboxSummaryView,
  AgentInboxSessionTriggerView,
  AgentInboxWakeBatchView,
  AgentMessagePublicationResultView,
  AgentDiscussionBindingView,
  AgentSessionInputView,
  AgentSessionWindowView,
  AgentSessionKind,
  AgentView,
  ArtifactV2View,
  AttemptExecutionInputView,
  AttemptView,
  ChangePage,
  ChangeRecord,
  ComputerPrincipal,
  ComputerView,
  ContextSourceKind,
  ContextSourceRef,
  ConversationParticipantView,
  ConversationAccessMode,
  ConversationKind,
  ConversationVisibility,
  ConversationView,
  HumanPrincipal,
  MembershipRole,
  MentionNotRequestedReason,
  MessageView,
  MessageArtifactReferenceView,
  MessageWorkItemReferenceView,
  Page,
  ProjectMemberView,
  ProjectRole,
  ProjectView,
  PrivateContextGrantView,
  Principal,
  ReasoningEffort,
  WorkspaceBootstrapView,
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
  WorkspaceJoinLinkCreatedView,
  WorkspaceJoinLinkPreviewView,
  WorkspaceJoinLinkView,
  WorkItemCommentView,
  WorkItemArtifactReferenceView,
  WorkItemLifecycleStatus,
  WorkItemView,
} from './types.js';
import { RUNTIME_CATALOG, runtimeCatalogDefinition } from './runtime-catalog.js';
import { DomainError, invariant, isSqliteConstraintError } from '../lib/errors.js';
import { canonicalJson, decodePageCursor, encodePageCursor, issueToken, newId, nowMs, sha256 } from '../lib/values.js';
import { SqliteDatabase } from '../storage/database.js';
import { LocalExecutionStore } from '../storage/local-execution-store.js';
import { AuthService, type VerificationCodeSink } from './auth-service.js';
import { ContentBlobStore } from '../storage/content-blob-store.js';
import type { StoredContentBlob } from '../storage/content-blob-store.js';
import { dirname, resolve } from 'node:path';
import { WorkspaceJoinLinkTokenCipher } from '../security/workspace-join-link-token-cipher.js';
import { ArtifactV2Service, ProjectResourceService } from './project-resource-service.js';

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

interface ProjectMembershipRow {
  id: string;
  workspace_id: string;
  project_id: string;
  workspace_membership_id: string;
  project_role: ProjectRole;
  sponsored_by_project_membership_id: string | null;
  status: 'active' | 'removed';
  revision: number;
  joined_at: number;
  updated_at: number;
  removed_at: number | null;
}

interface WorkItemRow {
  id: string;
  workspace_id: string;
  project_id: string;
  description: string;
  task_number: number;
  source_conversation_id: string | null;
  source_message_id: string | null;
  source_thread_id: string | null;
  created_by_membership_id: string;
  created_by_project_membership_id: string;
  lifecycle_status: WorkItemLifecycleStatus;
  blocker_reason: string | null;
  cancellation_reason: string | null;
  assignee_membership_id: string | null;
  assignee_project_membership_id: string | null;
  current_submission_id: string | null;
  assignment_revision: number;
  comment_frontier: number;
  revision: number;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  cancelled_at: number | null;
}

interface WorkItemCommentRow {
  id: string;
  workspace_id: string;
  project_id: string;
  work_item_id: string;
  author_actor_id: string;
  author_membership_id: string;
  author_project_membership_id: string;
  body: string;
  comment_position: number;
  created_at: number;
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

interface WorkspaceJoinLinkRow {
  id: string;
  workspace_id: string;
  token_hash: string;
  token_ciphertext: string | null;
  status: 'active' | 'revoked';
  revision: number;
  created_by_membership_id: string;
  use_count: number;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
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
  reply_to_message_id: string | null;
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
  attention_kind: 'direct_message' | 'mention' | 'discussion_change' | 'work_item_assignment' | 'work_item_mention';
  message_id: string | null;
  conversation_id: string | null;
  thread_id: string | null;
  agent_request_id: string | null;
  work_item_id: string | null;
  work_item_comment_id: string | null;
  state: 'pending' | 'claimed' | 'handled';
  claim_receipt: string | null;
  created_at: number;
  claimed_at: number | null;
  handled_at: number | null;
}

interface AgentInboxClaimReceiptRow {
  id: string;
  workspace_id: string;
  agent_id: string;
  agent_request_id: string;
  receipt: string;
  binding_revision: number;
  target_kind: 'discussion';
  target: string;
  conversation_id: string | null;
  thread_id: string | null;
  from_position: number;
  through_position: number;
  created_at: number;
  updated_at: number;
  handled_at: number | null;
}

interface AgentActivityEventRow {
  id: string;
  workspace_id: string;
  turn_id: string;
  agent_id: string;
  agent_name: string;
  sequence: number;
  event_type: AgentActivityEventView['eventType'];
  title: string;
  status: AgentActivityEventView['status'];
  turn_status: AgentActivityEventView['turnStatus'];
  turn_started_at: number;
  turn_updated_at: number;
  turn_finished_at: number | null;
  created_at: number;
}

interface ConversationAccess {
  conversation: {
    id: string;
    workspace_id: string;
    project_id: string | null;
    scope_type: 'workspace_general' | 'direct_message' | 'project_group';
    membership_mode: 'workspace_all' | 'project_all' | 'explicit';
    conversation_kind: ConversationKind;
    visibility: ConversationVisibility;
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
  accessMode: ConversationAccessMode;
}

interface ConversationParticipantRow {
  scope_membership_id: string;
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
  /** Project-scoped resources and immutable Artifact versions. */
  readonly projectResources: ProjectResourceService;
  readonly artifactV2: ArtifactV2Service;
  private readonly agentInboxWakeEmitter = new EventEmitter();
  private readonly workspaceJoinLinkTokenCipher: WorkspaceJoinLinkTokenCipher;

  constructor(
    readonly workspaceDatabase: SqliteDatabase,
    localDatabase: SqliteDatabase,
    verificationCodeSink?: VerificationCodeSink,
    contentDirectory = resolve(process.cwd(), '.data', 'content-blobs'),
    exposeDevelopmentVerificationCode = false,
  ) {
    const legacyActiveLink = workspaceDatabase.raw
      .prepare("SELECT id FROM workspace_join_links WHERE status = 'active' AND token_ciphertext IS NULL LIMIT 1")
      .get() as { id: string } | undefined;
    if (legacyActiveLink) {
      throw new Error(
        `Active Workspace join-link ${legacyActiveLink.id} has no recoverable encrypted token; revoke it before starting this build.`,
      );
    }
    const encryptedLink = workspaceDatabase.raw
      .prepare('SELECT * FROM workspace_join_links WHERE token_ciphertext IS NOT NULL LIMIT 1')
      .get() as WorkspaceJoinLinkRow | undefined;
    this.workspaceJoinLinkTokenCipher = WorkspaceJoinLinkTokenCipher.open(
      resolve(dirname(contentDirectory), 'workspace-join-link.key'),
      Boolean(encryptedLink),
    );
    if (encryptedLink) this.decryptWorkspaceJoinLinkToken(encryptedLink);
    this.localExecutions = new LocalExecutionStore(localDatabase);
    this.auth = new AuthService(workspaceDatabase, verificationCodeSink, exposeDevelopmentVerificationCode);
    const v2Blobs = new ContentBlobStore(contentDirectory);
    this.projectResources = new ProjectResourceService(workspaceDatabase, v2Blobs);
    this.artifactV2 = new ArtifactV2Service(workspaceDatabase, v2Blobs);
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
      this.insertConversation(
        principal,
        workspaceId,
        null,
        this.requireMembership(workspaceId, principal.actorId),
        null,
        'channel',
        '全员大群',
        'public',
        undefined,
      );
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
    },
    idempotencyKey: string,
  ): ProjectView {
    const normalizedName = input.name.trim();
    const normalizedDescription = this.normalizeProjectDescription(input.description);
    invariant(normalizedName.length > 0 && normalizedName.length <= 120, 'INVALID_PROJECT_NAME', 'Project name is required.');
    const normalizedInput = {
      name: normalizedName,
      description: normalizedDescription,
    };
    return this.idempotent(workspaceId, principal.actorId, 'CreateProject', idempotencyKey, normalizedInput, () => {
      const creator = this.requireMembership(workspaceId, principal.actorId);
      const projectId = newId();
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
      this.workspaceDatabase.raw
        .prepare(
          `INSERT INTO project_memberships (
             id, workspace_id, project_id, workspace_membership_id, project_role,
             sponsored_by_project_membership_id,
             status, revision, joined_at, updated_at
           ) VALUES (?, ?, ?, ?, 'owner', NULL, 'active', 1, ?, ?)`,
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
        { projectId, name: normalizedName },
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
        projectMembershipId,
      }, timestamp);
      this.insertConversation(
        principal,
        workspaceId,
        projectId,
        creator,
        {
          id: projectMembershipId,
          workspace_id: workspaceId,
          project_id: projectId,
          workspace_membership_id: creator.id,
          project_role: 'owner',
          sponsored_by_project_membership_id: null,
          status: 'active',
          revision: 1,
          joined_at: timestamp,
          updated_at: timestamp,
          removed_at: null,
        },
        'channel',
        '主群',
        'public',
        undefined,
      );
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
        `SELECT p.*, pm.id AS project_membership_id, pm.project_role,
                pm.sponsored_by_project_membership_id
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
      ) as unknown as Array<ProjectRow & {
        project_membership_id: string | null;
        project_role: ProjectRole | null;
        sponsored_by_project_membership_id: string | null;
      }>;
    const hasMore = rows.length > pageLimit;
    const items = rows.slice(0, pageLimit).map((row) => this.mapProject(row, row.project_membership_id ? {
      id: row.project_membership_id,
      workspace_id: row.workspace_id,
      project_id: row.id,
      workspace_membership_id: workspaceMembership.id,
      project_role: row.project_role!,
      sponsored_by_project_membership_id: row.sponsored_by_project_membership_id,
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

  listProjectMembers(principal: HumanPrincipal, projectId: string, cursor?: string, limit = 100): Page<ProjectMemberView> {
    const access = this.requireProjectAccess(principal.actorId, projectId);
    const pageCursor = this.requirePageCursor(cursor);
    const pageLimit = this.pageLimit(limit);
    const rows = this.workspaceDatabase.raw
      .prepare(
        `SELECT pm.id AS project_membership_id, pm.workspace_membership_id,
                wm.actor_id, a.actor_type, COALESCE(h.display_name, ag.name) AS display_name,
                pm.project_role, pm.sponsored_by_project_membership_id, pm.revision, pm.joined_at
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
        sponsored_by_project_membership_id: string | null;
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
      invariant(input.role !== 'owner', 'PROJECT_OWNER_TRANSFER_REQUIRED', 'Use an ownership transfer to appoint a new Project Owner.', 409);
      let sponsoredByProjectMembershipId: string | null = null;
      if (target.actorType === 'agent') {
        invariant(input.role === 'member', 'AGENT_PROJECT_ROLE_INVALID', 'An Agent can only be a Project member.');
        const agent = this.requireAgentIdentityRow(project.workspace_id, target.actorId);
        invariant(
          agent.owner_membership_id === authority.workspaceMembership.id,
          'AGENT_OWNER_REQUIRED',
          'A Project administrator may only add an Agent they own.',
          403,
        );
        sponsoredByProjectMembershipId = authority.projectMembership.id;
      } else if (input.role === 'manager') {
        invariant(
          authority.projectMembership.project_role === 'owner',
          'PROJECT_OWNER_REQUIRED',
          'Only the Project Owner may appoint a Manager.',
          403,
        );
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
             sponsored_by_project_membership_id,
             status, revision, joined_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'active', 1, ?, ?)`,
        )
        .run(
          projectMembershipId,
          project.workspace_id,
          projectId,
          input.workspaceMembershipId,
          input.role,
          sponsoredByProjectMembershipId,
          timestamp,
          timestamp,
        );
      const projectVersion = this.bumpProjectContext(projectId, timestamp);
      this.appendChange(
        project.workspace_id,
        null,
        null,
        null,
        'project_member_added',
        'project_membership',
        projectMembershipId,
        {
          projectMembershipId,
          workspaceMembershipId: input.workspaceMembershipId,
          role: input.role,
          sponsoredByProjectMembershipId,
        },
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
        { projectId, workspaceMembershipId: input.workspaceMembershipId, role: input.role, sponsoredByProjectMembershipId },
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
      const authority = this.requireProjectOwner(principal.actorId, projectId);
      const target = this.requireProjectMembership(project.workspace_id, projectId, projectMembershipId);
      const workspaceMember = this.requireActiveWorkspaceMember(project.workspace_id, target.workspace_membership_id);
      if (workspaceMember.actorType === 'agent') {
        invariant(input.role === 'member', 'AGENT_PROJECT_ROLE_INVALID', 'An Agent can only be a Project member.');
      }
      invariant(target.project_role !== input.role, 'PROJECT_ROLE_UNCHANGED', 'Project Membership already has that role.', 409);
      const timestamp = nowMs();
      if (input.role === 'owner') {
        invariant(workspaceMember.actorType === 'human', 'PROJECT_OWNER_MUST_BE_HUMAN', 'Project Owner must be Human.');
        invariant(target.project_role !== 'owner', 'PROJECT_ROLE_UNCHANGED', 'Project Membership is already the Owner.', 409);
        const promoted = this.workspaceDatabase.raw.prepare(
          `UPDATE project_memberships
           SET project_role = 'owner', revision = revision + 1, updated_at = ?
           WHERE workspace_id = ? AND project_id = ? AND id = ? AND status = 'active' AND revision = ?
           RETURNING revision`,
        ).get(timestamp, project.workspace_id, projectId, projectMembershipId, input.expectedRevision) as
          | { revision: number }
          | undefined;
        invariant(promoted, 'STALE_REVISION', 'Project Membership revision changed.', 409);
        const demoted = this.workspaceDatabase.raw.prepare(
          `UPDATE project_memberships
           SET project_role = 'manager', revision = revision + 1, updated_at = ?
           WHERE workspace_id = ? AND project_id = ? AND id = ? AND status = 'active' AND project_role = 'owner'
           RETURNING revision`,
        ).get(timestamp, project.workspace_id, projectId, authority.projectMembership.id) as
          | { revision: number }
          | undefined;
        invariant(demoted, 'PROJECT_OWNER_CONFLICT', 'Project ownership changed concurrently.', 409);
        const projectVersion = this.bumpProjectContext(projectId, timestamp);
        this.appendChange(
          project.workspace_id,
          null,
          null,
          null,
          'project_owner_transferred',
          'project_membership',
          projectMembershipId,
          {
            previousOwnerProjectMembershipId: authority.projectMembership.id,
            ownerProjectMembershipId: projectMembershipId,
            revision: promoted.revision,
          },
          timestamp,
          { projectId, projectVersion },
        );
        this.appendAudit(
          project.workspace_id,
          principal.actorId,
          authority.workspaceMembership.id,
          'project.owner.transfer',
          'project_membership',
          projectMembershipId,
          {
            projectId,
            previousOwnerProjectMembershipId: authority.projectMembership.id,
            revision: promoted.revision,
          },
          timestamp,
        );
        return this.getProjectMember(project.workspace_id, projectId, projectMembershipId);
      }
      invariant(target.project_role !== 'owner', 'PROJECT_OWNER_TRANSFER_REQUIRED', 'Transfer ownership before changing the Owner role.', 409);
      if (target.project_role === 'manager' && input.role === 'member') {
        this.removeSponsoredProjectAgents(
          project,
          target.id,
          principal.actorId,
          authority.workspaceMembership.id,
          timestamp,
          'project.manager-demoted.agent-remove',
        );
      }
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

  createWorkItem(
    principal: HumanPrincipal,
    projectId: string,
    input: {
      description: string;
      assigneeProjectMembershipId?: string | null;
      assigneeProjectMembershipIds?: string[];
    },
    idempotencyKey: string,
  ): WorkItemView {
    const project = this.requireProject(projectId);
    const description = input.description.trim();
    invariant(description.length > 0 && description.length <= 10_000, 'INVALID_WORK_ITEM_DESCRIPTION', 'WorkItem description is required.');
    const assigneeProjectMembershipIds = this.normalizeWorkItemAssigneeIds(input);
    const normalizedInput = {
      description,
      assigneeProjectMembershipIds,
    };
    const result = this.idempotent(
      project.workspace_id,
      principal.actorId,
      'CreateWorkItem',
      idempotencyKey,
      normalizedInput,
      () => {
        const access = this.requireProjectAccess(principal.actorId, projectId);
        const assignees = normalizedInput.assigneeProjectMembershipIds.map((id) =>
          this.getProjectMember(project.workspace_id, projectId, id));
        const assignee = assignees[0] ?? null;
        const timestamp = nowMs();
        const workItemId = newId();
        const taskNumber = this.nextProjectTaskNumber(project.workspace_id, projectId);
        this.workspaceDatabase.raw.prepare(
          `INSERT INTO work_items (
             id, workspace_id, project_id, description, task_number,
             created_by_membership_id, created_by_project_membership_id,
             lifecycle_status, assignee_membership_id, assignee_project_membership_id,
             assignment_revision, revision, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, 1, ?, ?)`,
        ).run(
          workItemId,
          project.workspace_id,
          projectId,
          description,
          taskNumber,
          access.workspaceMembership.id,
          access.projectMembership.id,
          assignee?.workspaceMembershipId ?? null,
          assignee?.projectMembershipId ?? null,
          assignee ? 1 : 0,
          timestamp,
          timestamp,
        );
        this.replaceWorkItemAssignees(project.workspace_id, projectId, workItemId, assignees, timestamp);
        const projectVersion = this.bumpProjectContext(projectId, timestamp);
        this.appendChange(
          project.workspace_id,
          null,
          null,
          null,
          'work_item_created',
          'work_item',
          workItemId,
          {
            projectId,
            assigneeProjectMembershipId: assignee?.projectMembershipId ?? null,
            assigneeProjectMembershipIds: assignees.map((member) => member.projectMembershipId),
          },
          timestamp,
          { projectId, projectVersion },
        );
        this.appendAudit(
          project.workspace_id,
          principal.actorId,
          access.workspaceMembership.id,
          'work_item.create',
          'work_item',
          workItemId,
          {
            projectId,
            assigneeProjectMembershipId: assignee?.projectMembershipId ?? null,
            assigneeProjectMembershipIds: assignees.map((member) => member.projectMembershipId),
          },
          timestamp,
        );
        let wakeSequence: number | null = null;
        for (const member of assignees) {
          if (member.actorType !== 'agent') continue;
          wakeSequence = this.enqueueWorkItemAttention(
            project.workspace_id, member.actorId, workItemId, null, 'work_item_assignment', timestamp,
          );
        }
        return { workItemId, wakeSequence };
      },
    );
    if (result.wakeSequence !== null) this.agentInboxWakeEmitter.emit('changed');
    return this.getWorkItem(principal, result.workItemId);
  }

  updateWorkItemDetails(
    principal: HumanPrincipal,
    workItemId: string,
    input: { description: string; expectedRevision: number },
    idempotencyKey: string,
  ): WorkItemView {
    const existing = this.requireWorkItem(workItemId);
    const description = input.description.trim();
    invariant(description.length > 0 && description.length <= 10_000, 'INVALID_WORK_ITEM_DESCRIPTION', 'WorkItem description is required.');
    return this.idempotent(existing.workspace_id, principal.actorId, 'UpdateWorkItemDetails', idempotencyKey,
      { description, expectedRevision: input.expectedRevision }, () => {
        const workItem = this.requireWorkItem(workItemId);
        const authority = this.requireHumanWorkItemAuthority(principal.actorId, workItem);
        invariant(workItem.lifecycle_status === 'open' && workItem.assignee_membership_id === null,
          'WORK_ITEM_DETAILS_NOT_EDITABLE', 'Only an unassigned open WorkItem can be edited.', 409);
        invariant(workItem.revision === input.expectedRevision,
          'WORK_ITEM_REVISION_CONFLICT', 'WorkItem changed concurrently.', 409);
        const timestamp = nowMs();
        const updated = this.workspaceDatabase.raw.prepare(
          `UPDATE work_items SET description = ?, revision = revision + 1, updated_at = ?
           WHERE workspace_id = ? AND id = ? AND lifecycle_status = 'open'
             AND assignee_membership_id IS NULL AND assignee_project_membership_id IS NULL
             AND revision = ? RETURNING revision`,
        ).get(description, timestamp, workItem.workspace_id, workItem.id, input.expectedRevision) as { revision: number } | undefined;
        invariant(updated, 'WORK_ITEM_REVISION_CONFLICT', 'WorkItem changed concurrently.', 409);
        this.recordWorkItemChange(workItem, 'work_item_details_updated', {
          description,
          revision: updated.revision,
        }, timestamp);
        this.appendAudit(workItem.workspace_id, principal.actorId, authority.id,
          'work_item.details.update', 'work_item', workItem.id,
          { description, revision: updated.revision }, timestamp);
        return this.mapWorkItem(this.requireWorkItem(workItem.id));
      });
  }

  createWorkItemFromMessage(
    principal: HumanPrincipal,
    messageId: string,
    input: {
      description?: string;
      assigneeProjectMembershipId?: string | null;
      assigneeProjectMembershipIds?: string[];
    },
    idempotencyKey: string,
  ): WorkItemView {
    const sourceMessage = this.requireMessage(messageId);
    const sourceAccess = this.requireConversationAccess(principal.actorId, sourceMessage.conversation_id);
    invariant(sourceAccess.conversation.lifecycle_status === 'active',
      'CONVERSATION_ARCHIVED', 'An archived Conversation cannot create a new task.', 409);
    const projectId = sourceAccess.conversation.project_id;
    invariant(projectId !== null && sourceMessage.project_id === projectId,
      'WORK_ITEM_SOURCE_MUST_BE_PROJECT_CONVERSATION',
      'A task source must be a Project Conversation message.', 409);
    const project = this.requireProject(projectId);
    const description = (input.description ?? sourceMessage.body).trim();
    invariant(description.length > 0 && description.length <= 10_000, 'INVALID_WORK_ITEM_DESCRIPTION', 'WorkItem description is required.');
    const assigneeProjectMembershipIds = this.normalizeWorkItemAssigneeIds(input);
    const normalizedInput = {
      messageId,
      description,
      assigneeProjectMembershipIds,
    };
    const result = this.idempotent(
      project.workspace_id,
      principal.actorId,
      'CreateWorkItemFromMessage',
      idempotencyKey,
      normalizedInput,
      () => {
        const currentSourceMessage = this.requireMessage(messageId);
        const currentSourceAccess = this.requireConversationAccess(principal.actorId, currentSourceMessage.conversation_id);
        invariant(currentSourceAccess.conversation.lifecycle_status === 'active',
          'CONVERSATION_ARCHIVED', 'An archived Conversation cannot create a new task.', 409);
        invariant(currentSourceAccess.conversation.project_id === projectId
          && currentSourceMessage.project_id === projectId,
        'WORK_ITEM_SOURCE_MUST_BE_PROJECT_CONVERSATION',
        'A task source must be a Project Conversation message.', 409);
        const access = this.requireProjectAccess(principal.actorId, projectId);
        const assignees = normalizedInput.assigneeProjectMembershipIds.map((id) =>
          this.getProjectMember(project.workspace_id, projectId, id));
        const assignee = assignees[0] ?? null;
        const timestamp = nowMs();
        const workItemId = newId();
        const taskNumber = this.nextProjectTaskNumber(project.workspace_id, projectId);
        this.workspaceDatabase.raw.prepare(
          `INSERT INTO work_items (
             id, workspace_id, project_id, description, task_number,
             source_conversation_id, source_message_id, source_thread_id,
             created_by_membership_id, created_by_project_membership_id,
             lifecycle_status, assignee_membership_id, assignee_project_membership_id,
             assignment_revision, revision, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, 1, ?, ?)`,
        ).run(
          workItemId,
          project.workspace_id,
          projectId,
          description,
          taskNumber,
          currentSourceAccess.conversation.id,
          currentSourceMessage.id,
          currentSourceMessage.thread_id,
          access.workspaceMembership.id,
          access.projectMembership.id,
          assignee?.workspaceMembershipId ?? null,
          assignee?.projectMembershipId ?? null,
          assignee ? 1 : 0,
          timestamp,
          timestamp,
        );
        this.replaceWorkItemAssignees(project.workspace_id, projectId, workItemId, assignees, timestamp);
        // Creating a WorkItem records source provenance only. It must not add
        // the newly created task as a message mention: only WorkItems that the
        // author explicitly selected while composing the source message belong
        // in message_work_item_references_v2.
        const projectVersion = this.bumpProjectContext(projectId, timestamp);
        const sourcePayload = {
          projectId,
          sourceConversationId: currentSourceAccess.conversation.id,
          sourceMessageId: currentSourceMessage.id,
          sourceThreadId: currentSourceMessage.thread_id,
          assigneeProjectMembershipId: assignee?.projectMembershipId ?? null,
          assigneeProjectMembershipIds: assignees.map((member) => member.projectMembershipId),
        };
        this.appendChange(
          project.workspace_id,
          null,
          null,
          null,
          'work_item_created',
          'work_item',
          workItemId,
          sourcePayload,
          timestamp,
          { projectId, projectVersion },
        );
        this.appendAudit(
          project.workspace_id,
          principal.actorId,
          access.workspaceMembership.id,
          'work_item.create',
          'work_item',
          workItemId,
          sourcePayload,
          timestamp,
        );
        let wakeSequence: number | null = null;
        for (const member of assignees) {
          if (member.actorType !== 'agent') continue;
          wakeSequence = this.enqueueWorkItemAttention(
            project.workspace_id, member.actorId, workItemId, null, 'work_item_assignment', timestamp,
          );
        }
        return { workItemId, wakeSequence };
      },
    );
    if (result.wakeSequence !== null) this.agentInboxWakeEmitter.emit('changed');
    return this.getWorkItem(principal, result.workItemId);
  }

  listProjectWorkItems(principal: HumanPrincipal, projectId: string): WorkItemView[] {
    const access = this.requireProjectAccess(principal.actorId, projectId);
    const rows = this.workspaceDatabase.raw.prepare(
      `SELECT * FROM work_items
       WHERE workspace_id = ? AND project_id = ?
       ORDER BY updated_at DESC, id DESC`,
    ).all(access.project.workspace_id, projectId) as unknown as WorkItemRow[];
    return rows.map((row) => this.mapWorkItem(row));
  }

  getWorkItem(principal: HumanPrincipal, workItemId: string): WorkItemView {
    const workItem = this.requireWorkItem(workItemId);
    this.requireProjectAccess(principal.actorId, workItem.project_id);
    return this.mapWorkItem(workItem);
  }

  listWorkItemComments(principal: HumanPrincipal, workItemId: string): WorkItemCommentView[] {
    const workItem = this.requireWorkItem(workItemId);
    this.requireProjectAccess(principal.actorId, workItem.project_id);
    const rows = this.workspaceDatabase.raw.prepare(
      `SELECT * FROM work_item_comments
       WHERE workspace_id = ? AND work_item_id = ?
       ORDER BY comment_position, id`,
    ).all(workItem.workspace_id, workItemId) as unknown as WorkItemCommentRow[];
    return rows.map((row) => this.mapWorkItemComment(row));
  }

  postWorkItemComment(
    principal: HumanPrincipal,
    workItemId: string,
    input: {
      body: string;
      mentionedActorIds?: string[];
      workItemIds?: string[];
      artifactSelections?: Array<{ artifactId: string; artifactVersionId: string }>;
    },
    idempotencyKey: string,
  ): WorkItemCommentView {
    const workItem = this.requireWorkItem(workItemId);
    const body = input.body.trim();
    invariant(body.length > 0 && body.length <= 10_000,
      'INVALID_WORK_ITEM_COMMENT', 'WorkItem comment body is required.');
    const mentionedActorIds = [...new Set(input.mentionedActorIds ?? [])];
    const result = this.idempotent(
      workItem.workspace_id,
      principal.actorId,
      'PostWorkItemComment',
      idempotencyKey,
      { workItemId, body, mentionedActorIds, workItemIds: input.workItemIds ?? [], artifactSelections: input.artifactSelections ?? [] },
      () => {
        const current = this.requireWorkItem(workItemId);
        const access = this.requireProjectAccess(principal.actorId, current.project_id);
        const referencedWorkItemIds = this.normalizeWorkItemCommentReferences(current, input.workItemIds);
        return this.insertWorkItemComment(
          current,
          access.workspaceMembership,
          access.projectMembership,
          body,
          mentionedActorIds,
          referencedWorkItemIds,
          input.artifactSelections ?? [],
          principal.actorId,
        );
      },
    );
    if (result.wakeCount > 0) this.agentInboxWakeEmitter.emit('changed');
    return this.mapWorkItemComment(this.requireWorkItemComment(result.commentId));
  }

  assignWorkItem(
    principal: HumanPrincipal,
    workItemId: string,
    input: {
      assigneeProjectMembershipId: string | null;
      assigneeProjectMembershipIds?: string[];
      expectedRevision: number;
      expectedAssignmentRevision: number;
    },
    idempotencyKey: string,
  ): WorkItemView {
    const existing = this.requireWorkItem(workItemId);
    const assigneeProjectMembershipIds = this.normalizeWorkItemAssigneeIds(input);
    const normalizedInput = { ...input, assigneeProjectMembershipIds };
    const result = this.idempotent(existing.workspace_id, principal.actorId, 'AssignWorkItem', idempotencyKey, normalizedInput, () => {
      const current = this.requireWorkItem(workItemId);
      const authority = this.requireWorkItemManager(principal.actorId, current);
      invariant(current.lifecycle_status === 'open' || current.lifecycle_status === 'blocked',
        'WORK_ITEM_TERMINAL', 'A terminal WorkItem cannot be reassigned.', 409);
      const currentAssigneeIds = this.getWorkItemAssigneeIds(current);
      invariant(currentAssigneeIds.join(',') !== assigneeProjectMembershipIds.join(','),
        'WORK_ITEM_ASSIGNMENT_UNCHANGED', 'WorkItem is already assigned to that member.', 409);
      const assignees = assigneeProjectMembershipIds.map((id) =>
        this.getProjectMember(current.workspace_id, current.project_id, id));
      const assignee = assignees[0] ?? null;
      const timestamp = nowMs();
      const updated = this.workspaceDatabase.raw.prepare(
        `UPDATE work_items
         SET assignee_membership_id = ?, assignee_project_membership_id = ?, current_submission_id = NULL,
             assignment_revision = assignment_revision + 1, revision = revision + 1, updated_at = ?
         WHERE id = ? AND lifecycle_status IN ('open', 'blocked')
           AND revision = ? AND assignment_revision = ?
         RETURNING revision, assignment_revision`,
      ).get(
        assignee?.workspaceMembershipId ?? null,
        assignee?.projectMembershipId ?? null,
        timestamp,
        workItemId,
        input.expectedRevision,
        input.expectedAssignmentRevision,
      ) as { revision: number; assignment_revision: number } | undefined;
      invariant(updated, 'WORK_ITEM_REVISION_CONFLICT', 'WorkItem assignment changed concurrently.', 409);
      this.replaceWorkItemAssignees(current.workspace_id, current.project_id, workItemId, assignees, timestamp);

      this.handleWorkItemAttentionAsHandled(current.workspace_id, current.id);
      let wakeSequence: number | null = null;
      for (const member of assignees) {
        if (member.actorType !== 'agent') continue;
        wakeSequence = this.enqueueWorkItemAttention(
          current.workspace_id, member.actorId, current.id, null, 'work_item_assignment', timestamp,
        );
      }
      this.recordWorkItemChange(current, 'work_item_assigned', {
        assigneeProjectMembershipId: assignee?.projectMembershipId ?? null,
        assigneeProjectMembershipIds: assignees.map((member) => member.projectMembershipId),
        revision: updated.revision,
        assignmentRevision: updated.assignment_revision,
      }, timestamp);
      this.appendAudit(current.workspace_id, principal.actorId, authority.id, 'work_item.assign', 'work_item', workItemId, {
        assigneeProjectMembershipId: assignee?.projectMembershipId ?? null,
        assigneeProjectMembershipIds: assignees.map((member) => member.projectMembershipId),
        revision: updated.revision,
        assignmentRevision: updated.assignment_revision,
      }, timestamp);
      return { wakeSequence };
    });
    if (result.wakeSequence !== null) this.agentInboxWakeEmitter.emit('changed');
    return this.getWorkItem(principal, workItemId);
  }

  blockWorkItem(
    principal: HumanPrincipal,
    workItemId: string,
    input: { reason: string; expectedRevision: number },
    idempotencyKey: string,
  ): WorkItemView {
    const existing = this.requireWorkItem(workItemId);
    const reason = input.reason.trim();
    invariant(reason.length > 0 && reason.length <= 2000, 'WORK_ITEM_BLOCK_REASON_REQUIRED', 'Blocking requires a reason.');
    return this.idempotent(existing.workspace_id, principal.actorId, 'BlockWorkItem', idempotencyKey, input, () => {
      const current = this.requireWorkItem(workItemId);
      const authority = this.requireHumanWorkItemAuthority(principal.actorId, current);
      invariant(current.lifecycle_status === 'open', 'WORK_ITEM_NOT_OPEN', 'Only an open WorkItem can be blocked.', 409);
      const timestamp = nowMs();
      const updated = this.workspaceDatabase.raw.prepare(
        `UPDATE work_items
         SET lifecycle_status = 'blocked', blocker_reason = ?, revision = revision + 1, updated_at = ?
         WHERE id = ? AND lifecycle_status = 'open' AND revision = ? RETURNING revision`,
      ).get(reason, timestamp, workItemId, input.expectedRevision) as { revision: number } | undefined;
      invariant(updated, 'WORK_ITEM_REVISION_CONFLICT', 'WorkItem changed concurrently.', 409);
      this.handleWorkItemAttentionAsHandled(current.workspace_id, workItemId);
      this.recordWorkItemChange(current, 'work_item_blocked', { reason, revision: updated.revision }, timestamp);
      this.appendAudit(current.workspace_id, principal.actorId, authority.id, 'work_item.block', 'work_item', workItemId,
        { reason, revision: updated.revision }, timestamp);
      return this.mapWorkItem(this.requireWorkItem(workItemId));
    });
  }

  unblockWorkItem(
    principal: HumanPrincipal,
    workItemId: string,
    expectedRevision: number,
    idempotencyKey: string,
  ): WorkItemView {
    const existing = this.requireWorkItem(workItemId);
    return this.idempotent(existing.workspace_id, principal.actorId, 'UnblockWorkItem', idempotencyKey,
      { expectedRevision }, () => {
        const current = this.requireWorkItem(workItemId);
        const authority = this.requireWorkItemManager(principal.actorId, current);
        invariant(current.lifecycle_status === 'blocked', 'WORK_ITEM_NOT_BLOCKED', 'Only a blocked WorkItem can be unblocked.', 409);
        const timestamp = nowMs();
        const updated = this.workspaceDatabase.raw.prepare(
          `UPDATE work_items
           SET lifecycle_status = 'open', blocker_reason = NULL, revision = revision + 1, updated_at = ?
           WHERE id = ? AND lifecycle_status = 'blocked' AND revision = ? RETURNING revision`,
        ).get(timestamp, workItemId, expectedRevision) as { revision: number } | undefined;
        invariant(updated, 'WORK_ITEM_REVISION_CONFLICT', 'WorkItem changed concurrently.', 409);
        this.recordWorkItemChange(current, 'work_item_unblocked', { revision: updated.revision }, timestamp);
        this.appendAudit(current.workspace_id, principal.actorId, authority.id, 'work_item.unblock', 'work_item', workItemId,
          { revision: updated.revision }, timestamp);
        return this.mapWorkItem(this.requireWorkItem(workItemId));
      });
  }

  completeWorkItem(
    principal: HumanPrincipal,
    workItemId: string,
    expectedRevision: number,
    idempotencyKey: string,
  ): WorkItemView {
    const existing = this.requireWorkItem(workItemId);
    return this.idempotent(existing.workspace_id, principal.actorId, 'CompleteWorkItem', idempotencyKey,
      { expectedRevision }, () => {
        const current = this.requireWorkItem(workItemId);
        const authority = this.requireWorkItemManager(principal.actorId, current);
        invariant(current.lifecycle_status === 'open', 'WORK_ITEM_NOT_OPEN', 'Only an open WorkItem can be completed.', 409);
        const timestamp = nowMs();
        const updated = this.workspaceDatabase.raw.prepare(
          `UPDATE work_items
           SET lifecycle_status = 'completed', assignee_membership_id = NULL,
               assignee_project_membership_id = NULL, assignment_revision = assignment_revision + 1,
               revision = revision + 1, updated_at = ?, completed_at = ?
           WHERE id = ? AND lifecycle_status = 'open' AND revision = ? RETURNING revision, assignment_revision`,
        ).get(timestamp, timestamp, workItemId, expectedRevision) as
          | { revision: number; assignment_revision: number }
          | undefined;
        invariant(updated, 'WORK_ITEM_REVISION_CONFLICT', 'WorkItem changed concurrently.', 409);
        // Keep the ordered assignee records after completion so the board and
        // message card retain who delivered the WorkItem.  The legacy primary
        // assignee columns are cleared by the terminal-state invariant, while
        // work_item_assignees remains the historical assignment source.
        this.handleWorkItemAttentionAsHandled(current.workspace_id, workItemId);
        this.recordWorkItemChange(current, 'work_item_completed', updated, timestamp);
        this.appendAudit(current.workspace_id, principal.actorId, authority.id, 'work_item.complete', 'work_item', workItemId,
          updated, timestamp);
        return this.mapWorkItem(this.requireWorkItem(workItemId));
      });
  }

  cancelWorkItem(
    principal: HumanPrincipal,
    workItemId: string,
    input: { reason?: string | null; expectedRevision: number },
    idempotencyKey: string,
  ): WorkItemView {
    const existing = this.requireWorkItem(workItemId);
    const reason = typeof input.reason === 'string' && input.reason.trim().length > 0
      ? input.reason.trim()
      : null;
    invariant(reason === null || reason.length <= 2000, 'WORK_ITEM_CANCEL_REASON_TOO_LONG', 'Cancellation reason must be at most 2000 characters.');
    return this.idempotent(existing.workspace_id, principal.actorId, 'CancelWorkItem', idempotencyKey, input, () => {
      const current = this.requireWorkItem(workItemId);
      const authority = this.requireWorkItemManager(principal.actorId, current);
      invariant(current.lifecycle_status === 'open' || current.lifecycle_status === 'blocked',
        'WORK_ITEM_TERMINAL', 'A terminal WorkItem cannot be cancelled.', 409);
      const timestamp = nowMs();
      const updated = this.workspaceDatabase.raw.prepare(
        `UPDATE work_items
         SET lifecycle_status = 'cancelled', blocker_reason = NULL, cancellation_reason = ?,
             assignee_membership_id = NULL, assignee_project_membership_id = NULL,
             assignment_revision = assignment_revision + 1,
             revision = revision + 1, updated_at = ?, cancelled_at = ?
         WHERE id = ? AND lifecycle_status IN ('open', 'blocked') AND revision = ?
         RETURNING revision, assignment_revision`,
      ).get(reason, timestamp, timestamp, workItemId, input.expectedRevision) as
        | { revision: number; assignment_revision: number }
        | undefined;
      invariant(updated, 'WORK_ITEM_REVISION_CONFLICT', 'WorkItem changed concurrently.', 409);
      // Keep the ordered assignee records after cancellation as well, so the
      // card can show which Agent owned the cancelled WorkItem.
      this.handleWorkItemAttentionAsHandled(current.workspace_id, workItemId);
      this.recordWorkItemChange(current, 'work_item_cancelled', { reason, ...updated }, timestamp);
      this.appendAudit(current.workspace_id, principal.actorId, authority.id, 'work_item.cancel', 'work_item', workItemId,
        { reason, ...updated }, timestamp);
      return this.mapWorkItem(this.requireWorkItem(workItemId));
    });
  }

  createWorkspaceJoinLink(
    principal: HumanPrincipal,
    workspaceId: string,
  ): WorkspaceJoinLinkCreatedView {
    const creator = this.requireWorkspaceOwner(workspaceId, principal.actorId);
    const token = issueToken();
    const joinLinkId = newId();
    const tokenCiphertext = this.workspaceJoinLinkTokenCipher.encrypt(token.raw, workspaceId, joinLinkId);
    const timestamp = nowMs();
    this.workspaceDatabase.transaction(() => {
      this.workspaceDatabase.raw
        .prepare(
          `INSERT INTO workspace_join_links (
             id, workspace_id, token_hash, token_ciphertext, status, revision,
             created_by_membership_id, use_count, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'active', 1, ?, 0, ?, ?)`,
        )
        .run(joinLinkId, workspaceId, token.hash, tokenCiphertext, creator.id, timestamp, timestamp);
      this.appendChange(
        workspaceId,
        null,
        null,
        null,
        'workspace_join_link_created',
        'workspace_join_link',
        joinLinkId,
        { joinLinkId },
        timestamp,
      );
      this.enqueueDelivery(
        workspaceId,
        'workspace.join-link-created',
        'workspace_join_link',
        joinLinkId,
        { joinLinkId },
        joinLinkId,
        timestamp,
      );
      this.appendAudit(
        workspaceId,
        principal.actorId,
        creator.id,
        'workspace.join-link.create',
        'workspace_join_link',
        joinLinkId,
        {},
        timestamp,
      );
    });
    return { ...this.mapWorkspaceJoinLink(this.requireWorkspaceJoinLink(joinLinkId)), token: token.raw };
  }

  listWorkspaceJoinLinks(
    principal: HumanPrincipal,
    workspaceId: string,
    cursor?: string,
    limit = 100,
  ): Page<WorkspaceJoinLinkView> {
    this.requireMembership(workspaceId, principal.actorId);
    const pageCursor = this.requirePageCursor(cursor);
    const pageLimit = this.pageLimit(limit);
    const rows = this.workspaceDatabase.raw
      .prepare(
        `SELECT * FROM workspace_join_links
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
      ) as unknown as WorkspaceJoinLinkRow[];
    const hasMore = rows.length > pageLimit;
    const items = rows.slice(0, pageLimit).map((row) => this.mapWorkspaceJoinLink(row));
    const last = items.at(-1);
    return { items, nextCursor: hasMore && last ? encodePageCursor(last.createdAt, last.id) : null };
  }

  previewWorkspaceJoinLink(principal: HumanPrincipal, token: string): WorkspaceJoinLinkPreviewView {
    const link = this.requireWorkspaceJoinLinkByToken(token);
    const workspace = this.workspaceDatabase.raw
      .prepare('SELECT name FROM workspaces WHERE id = ?')
      .get(link.workspace_id) as { name: string } | undefined;
    invariant(workspace, 'WORKSPACE_NOT_FOUND', 'Workspace does not exist.', 404);
    const alreadyMember = Boolean(this.workspaceDatabase.raw
      .prepare("SELECT 1 FROM workspace_memberships WHERE workspace_id = ? AND actor_id = ? AND status = 'active'")
      .get(link.workspace_id, principal.actorId));
    return {
      workspaceId: link.workspace_id,
      workspaceName: workspace.name,
      status: link.status,
      alreadyMember,
    };
  }

  acceptWorkspaceJoinLink(
    principal: HumanPrincipal,
    token: string,
    idempotencyKey: string,
  ): WorkspaceMemberView {
    const link = this.requireWorkspaceJoinLinkByToken(token);
    return this.idempotent(
      link.workspace_id,
      principal.actorId,
      'AcceptWorkspaceJoinLink',
      idempotencyKey,
      { joinLinkId: link.id },
      () => {
        const current = this.requireWorkspaceJoinLink(link.id);
        invariant(current.status === 'active', 'WORKSPACE_JOIN_LINK_REVOKED', 'This Workspace join link has been revoked.', 410);
        const active = this.workspaceDatabase.raw
          .prepare("SELECT id FROM workspace_memberships WHERE workspace_id = ? AND actor_id = ? AND status = 'active'")
          .get(current.workspace_id, principal.actorId) as { id: string } | undefined;
        if (active) return this.getWorkspaceMember(current.workspace_id, active.id);

        const membershipId = newId();
        const timestamp = nowMs();
        this.workspaceDatabase.raw
          .prepare(
            `INSERT INTO workspace_memberships (
               id, workspace_id, actor_id, membership_role,
               status, revision, joined_at, updated_at
             ) VALUES (?, ?, ?, 'member', 'active', 1, ?, ?)`,
          )
          .run(membershipId, current.workspace_id, principal.actorId, timestamp, timestamp);
        this.workspaceDatabase.raw
          .prepare(
            `UPDATE workspace_join_links
             SET use_count = use_count + 1, last_used_at = ?, updated_at = ?
             WHERE id = ? AND status = 'active'`,
          )
          .run(timestamp, timestamp, current.id);
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
        this.appendAudit(
          current.workspace_id,
          principal.actorId,
          membershipId,
          'workspace.join-link.accept',
          'workspace_join_link',
          current.id,
          { membershipId },
          timestamp,
        );
        return this.getWorkspaceMember(current.workspace_id, membershipId);
      },
    );
  }

  revokeWorkspaceJoinLink(
    principal: HumanPrincipal,
    joinLinkId: string,
    expectedRevision: number,
    idempotencyKey: string,
  ): WorkspaceJoinLinkView {
    const link = this.requireWorkspaceJoinLink(joinLinkId);
    return this.idempotent(link.workspace_id, principal.actorId, 'RevokeWorkspaceJoinLink', idempotencyKey, { expectedRevision }, () => {
      const membership = this.requireWorkspaceOwner(link.workspace_id, principal.actorId);
      const timestamp = nowMs();
      const updated = this.workspaceDatabase.raw
        .prepare(
          `UPDATE workspace_join_links
           SET status = 'revoked', token_ciphertext = NULL,
               revision = revision + 1, updated_at = ?, revoked_at = ?
           WHERE id = ? AND status = 'active' AND revision = ?`,
        )
        .run(timestamp, timestamp, joinLinkId, expectedRevision);
      invariant(updated.changes === 1, 'STALE_REVISION', 'Workspace join link revision or status changed.', 409);
      this.appendChange(
        link.workspace_id,
        null,
        null,
        null,
        'workspace_join_link_revoked',
        'workspace_join_link',
        joinLinkId,
        { joinLinkId },
        timestamp,
      );
      this.enqueueDelivery(
        link.workspace_id,
        'workspace.join-link-revoked',
        'workspace_join_link',
        joinLinkId,
        { joinLinkId },
        `revoked:${joinLinkId}:${expectedRevision}`,
        timestamp,
      );
      this.appendAudit(
        link.workspace_id,
        principal.actorId,
        membership.id,
        'workspace.join-link.revoke',
        'workspace_join_link',
        joinLinkId,
        {},
        timestamp,
      );
      return this.mapWorkspaceJoinLink(this.requireWorkspaceJoinLink(joinLinkId));
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
      membership.membership_role === 'owner'
      || (agent.membership_status === 'active' && (
        membership.id === agent.owner_membership_id
        || this.hasSharedProjectParticipation(workspaceId, membership.id, agent.membership_id)
      )),
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
           ON owner.workspace_id = a.workspace_id AND owner.id = a.owner_membership_id
         JOIN humans h ON h.actor_id = owner.actor_id
         WHERE a.workspace_id = ? AND a.deleted_at IS NULL
           AND (m.status = 'active' OR a.owner_membership_id = ? OR ? = 'owner')
           AND (
             a.owner_membership_id = ? OR ? = 'owner'
             OR EXISTS (
               SELECT 1
               FROM project_memberships observer_project
               JOIN project_memberships agent_project
                 ON agent_project.workspace_id = observer_project.workspace_id
                AND agent_project.project_id = observer_project.project_id
                AND agent_project.status = 'active'
               WHERE observer_project.workspace_id = a.workspace_id
                 AND observer_project.workspace_membership_id = ?
                 AND observer_project.status = 'active'
                 AND agent_project.workspace_membership_id = m.id
             )
           )
           AND (? IS NULL OR a.created_at > ? OR (a.created_at = ? AND a.actor_id > ?))
         ORDER BY a.created_at, a.actor_id LIMIT ?`,
      )
      .all(
        workspaceId,
        observer.id,
        observer.membership_role,
        observer.id,
        observer.membership_role,
        observer.id,
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
        }
        const disabled = this.workspaceDatabase.raw.prepare(
          `UPDATE agent_runtime_bindings SET status = 'disabled', updated_at = ?
           WHERE id = ? AND status = 'active'`,
        ).run(timestamp, binding.id);
        invariant(disabled.changes === 1, 'RUNTIME_BINDING_REVISION_CONFLICT', 'Runtime Binding changed.', 409);
        this.fenceAgentInboxBinding(workspaceId, agentId, timestamp);
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
        const caller = this.requireMembership(workspaceId, principal.actorId);
        const agentIdentity = this.requireAgentIdentityRow(workspaceId, agentId);
        invariant(
          caller.membership_role === 'owner' || agentIdentity.owner_membership_id === caller.id,
          'AGENT_TERMINATION_AUTHORITY_REQUIRED',
          'Only the Workspace Owner or the Agent Owner may terminate this Agent Membership.',
          403,
        );
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
        this.interruptActiveAgentActivityTurns(workspaceId, agentId, timestamp);

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
      this.interruptActiveAgentActivityTurns(workspaceId, agentId, timestamp);
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

  recordComputerAgentActivity(
    computerId: string,
    agentId: string,
    input: AgentActivityEventInput,
  ): AgentActivityEventView {
    const binding = this.requireComputerAgentBinding(computerId, agentId);
    const title = input.title.trim();
    invariant(title.length > 0 && title.length <= 500, 'INVALID_AGENT_ACTIVITY', 'Agent activity title is invalid.');
    invariant(input.sequence > 0, 'INVALID_AGENT_ACTIVITY', 'Agent activity sequence must be positive.');
    if (input.eventType === 'turn_started') {
      invariant(input.sequence === 1 && input.status === 'in_progress', 'INVALID_AGENT_ACTIVITY',
        'An Agent activity turn must start at sequence 1 in progress.');
    } else if (input.eventType === 'turn_completed') {
      invariant(input.status === 'completed', 'INVALID_AGENT_ACTIVITY', 'A completed turn requires completed status.');
    } else if (input.eventType === 'turn_failed') {
      invariant(input.status === 'failed', 'INVALID_AGENT_ACTIVITY', 'A failed turn requires failed status.');
    }

    return this.workspaceDatabase.transaction(() => {
      const existing = this.agentActivityEventRow(input.eventId);
      if (existing) {
        invariant(
          existing.workspace_id === binding.workspace_id
          && existing.agent_id === agentId
          && existing.turn_id === input.turnId
          && existing.sequence === input.sequence
          && existing.event_type === input.eventType
          && existing.title === title
          && existing.status === input.status,
          'AGENT_ACTIVITY_CONFLICT',
          'Agent activity event ID was reused with different content.',
          409,
        );
        return this.mapAgentActivityEvent(existing);
      }

      const timestamp = nowMs();
      if (input.eventType === 'turn_started') {
        this.interruptActiveAgentActivityTurns(binding.workspace_id, agentId, timestamp);
        this.createAgentActivityTurn(binding, computerId, agentId, input.turnId, timestamp);
      } else {
        let turn = this.workspaceDatabase.raw.prepare(
          `SELECT status, computer_id, runtime_binding_revision
           FROM agent_activity_turns WHERE workspace_id = ? AND id = ? AND agent_id = ?`,
        ).get(binding.workspace_id, input.turnId, agentId) as {
          status: 'active' | 'completed' | 'failed';
          computer_id: string;
          runtime_binding_revision: number;
        } | undefined;
        if (!turn) {
          invariant(input.sequence > 1, 'INVALID_AGENT_ACTIVITY',
            'A recovered Agent activity turn must continue after sequence 1.');
          this.interruptActiveAgentActivityTurns(binding.workspace_id, agentId, timestamp);
          this.createAgentActivityTurn(binding, computerId, agentId, input.turnId, timestamp);
          this.workspaceDatabase.raw.prepare(
            `INSERT INTO agent_activity_events (
               id, workspace_id, turn_id, agent_id, sequence, event_type, title, status, created_at
             ) VALUES (?, ?, ?, ?, ?, 'turn_started', '动态连接已恢复，继续处理', 'in_progress', ?)`,
          ).run(
            newId(),
            binding.workspace_id,
            input.turnId,
            agentId,
            input.sequence - 1,
            timestamp,
          );
          turn = {
            status: 'active',
            computer_id: computerId,
            runtime_binding_revision: binding.binding_revision,
          };
        }
        invariant(
          turn.computer_id === computerId && turn.runtime_binding_revision === binding.binding_revision,
          'AGENT_ACTIVITY_BINDING_MISMATCH',
          'Agent activity turn belongs to another Runtime Binding.',
          403,
        );
        invariant(turn.status === 'active', 'AGENT_ACTIVITY_TURN_FINISHED', 'Agent activity turn is already finished.', 409);
        const last = this.workspaceDatabase.raw.prepare(
          'SELECT COALESCE(MAX(sequence), 0) AS sequence FROM agent_activity_events WHERE workspace_id = ? AND turn_id = ?',
        ).get(binding.workspace_id, input.turnId) as { sequence: number };
        invariant(last.sequence + 1 === input.sequence, 'AGENT_ACTIVITY_SEQUENCE_CONFLICT',
          'Agent activity events must be recorded in order.', 409);
      }

      this.workspaceDatabase.raw.prepare(
        `INSERT INTO agent_activity_events (
           id, workspace_id, turn_id, agent_id, sequence, event_type, title, status, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.eventId,
        binding.workspace_id,
        input.turnId,
        agentId,
        input.sequence,
        input.eventType,
        title,
        input.status,
        timestamp,
      );
      if (input.eventType === 'turn_completed' || input.eventType === 'turn_failed') {
        const turnStatus = input.eventType === 'turn_completed' ? 'completed' : 'failed';
        const updated = this.workspaceDatabase.raw.prepare(
          `UPDATE agent_activity_turns
           SET status = ?, updated_at = ?, finished_at = ?
           WHERE workspace_id = ? AND id = ? AND status = 'active'`,
        ).run(turnStatus, timestamp, timestamp, binding.workspace_id, input.turnId);
        invariant(updated.changes === 1, 'AGENT_ACTIVITY_TURN_FINISHED', 'Agent activity turn is already finished.', 409);
      } else {
        this.workspaceDatabase.raw.prepare(
          'UPDATE agent_activity_turns SET updated_at = ? WHERE workspace_id = ? AND id = ?',
        ).run(timestamp, binding.workspace_id, input.turnId);
      }
      return this.mapAgentActivityEvent(this.agentActivityEventRow(input.eventId)!);
    });
  }

  listAgentActivity(
    principal: HumanPrincipal,
    workspaceId: string,
    agentId?: string,
    limit = 100,
  ): AgentActivityEventView[] {
    this.requireMembership(workspaceId, principal.actorId);
    if (agentId) this.requireAgentIdentityRow(workspaceId, agentId);
    const pageLimit = Math.min(Math.max(limit, 1), 200);
    const rows = this.workspaceDatabase.raw.prepare(
      `SELECT event.*, agent.name AS agent_name,
              turn.status AS turn_status, turn.started_at AS turn_started_at,
              turn.updated_at AS turn_updated_at, turn.finished_at AS turn_finished_at
       FROM agent_activity_events event
       JOIN agent_activity_turns turn
         ON turn.workspace_id = event.workspace_id AND turn.id = event.turn_id
       JOIN agents agent
         ON agent.workspace_id = event.workspace_id AND agent.actor_id = event.agent_id
       WHERE event.workspace_id = ? AND agent.deleted_at IS NULL
         AND (? IS NULL OR event.agent_id = ?)
       ORDER BY event.position DESC LIMIT ?`,
    ).all(workspaceId, agentId ?? null, agentId ?? null, pageLimit) as unknown as AgentActivityEventRow[];
    return rows.map((row) => this.mapAgentActivityEvent(row));
  }

  private interruptActiveAgentActivityTurns(workspaceId: string, agentId: string, timestamp: number): void {
    const interrupted = this.workspaceDatabase.raw.prepare(
      `SELECT id FROM agent_activity_turns
       WHERE workspace_id = ? AND agent_id = ? AND status = 'active'`,
    ).all(workspaceId, agentId) as Array<{ id: string }>;
    for (const turn of interrupted) {
      const last = this.workspaceDatabase.raw.prepare(
        'SELECT COALESCE(MAX(sequence), 0) AS sequence FROM agent_activity_events WHERE workspace_id = ? AND turn_id = ?',
      ).get(workspaceId, turn.id) as { sequence: number };
      this.workspaceDatabase.raw.prepare(
        `INSERT INTO agent_activity_events (
           id, workspace_id, turn_id, agent_id, sequence, event_type, title, status, created_at
         ) VALUES (?, ?, ?, ?, ?, 'turn_failed', 'Agent 动态连接中断', 'failed', ?)`,
      ).run(newId(), workspaceId, turn.id, agentId, last.sequence + 1, timestamp);
      this.workspaceDatabase.raw.prepare(
        `UPDATE agent_activity_turns
         SET status = 'failed', updated_at = ?, finished_at = ?
         WHERE workspace_id = ? AND id = ? AND status = 'active'`,
      ).run(timestamp, timestamp, workspaceId, turn.id);
    }
  }

  private createAgentActivityTurn(
    binding: { workspace_id: string; binding_revision: number },
    computerId: string,
    agentId: string,
    turnId: string,
    timestamp: number,
  ): void {
    this.workspaceDatabase.raw.prepare(
      `INSERT INTO agent_activity_turns (
         id, workspace_id, agent_id, computer_id, runtime_binding_revision,
         status, started_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
    ).run(
      turnId,
      binding.workspace_id,
      agentId,
      computerId,
      binding.binding_revision,
      timestamp,
      timestamp,
    );
  }

  listComputerAgentWorkItems(computerId: string, agentId: string, projectId?: string): WorkItemView[] {
    const binding = this.requireComputerAgentBinding(computerId, agentId);
    const membership = this.requireMembership(binding.workspace_id, agentId);
    const rows = this.workspaceDatabase.raw.prepare(
      `SELECT item.*
       FROM work_items item
       JOIN project_memberships project_membership
         ON project_membership.workspace_id = item.workspace_id
        AND project_membership.project_id = item.project_id
        AND project_membership.workspace_membership_id = ?
        AND project_membership.status = 'active'
       WHERE item.workspace_id = ?
         AND (? IS NULL OR item.project_id = ?)
       ORDER BY item.updated_at DESC, item.id DESC`,
    ).all(membership.id, binding.workspace_id, projectId ?? null, projectId ?? null) as unknown as WorkItemRow[];
    return rows.map((row) => this.mapWorkItem(row));
  }

  getComputerAgentWorkItem(
    computerId: string,
    agentId: string,
    workItemId: string,
  ): WorkItemView {
    const binding = this.requireComputerAgentBinding(computerId, agentId);
    const workItem = this.requireWorkItem(workItemId);
    invariant(workItem.workspace_id === binding.workspace_id,
      'WORK_ITEM_NOT_FOUND', 'WorkItem does not exist or is not accessible.', 404);
    this.requireProjectAccess(agentId, workItem.project_id);
    return this.mapWorkItem(workItem);
  }

  listComputerAgentWorkItemComments(
    computerId: string,
    agentId: string,
    workItemId: string,
  ): WorkItemCommentView[] {
    const binding = this.requireComputerAgentBinding(computerId, agentId);
    const workItem = this.requireWorkItem(workItemId);
    invariant(workItem.workspace_id === binding.workspace_id,
      'WORK_ITEM_NOT_FOUND', 'WorkItem does not exist or is not accessible.', 404);
    this.requireProjectAccess(agentId, workItem.project_id);
    const rows = this.workspaceDatabase.raw.prepare(
      `SELECT * FROM work_item_comments
       WHERE workspace_id = ? AND work_item_id = ? ORDER BY comment_position, id`,
    ).all(binding.workspace_id, workItemId) as unknown as WorkItemCommentRow[];
    return rows.map((row) => this.mapWorkItemComment(row));
  }

  postComputerAgentWorkItemComment(
    computerId: string,
    agentId: string,
    workItemId: string,
    input: {
      body: string;
      mentionedActorIds?: string[];
      workItemIds?: string[];
      artifactSelections?: Array<{ artifactId: string; artifactVersionId: string }>;
    },
    idempotencyKey: string,
  ): WorkItemCommentView {
    const binding = this.requireComputerAgentBinding(computerId, agentId);
    const body = input.body.trim();
    invariant(body.length > 0 && body.length <= 10_000,
      'INVALID_WORK_ITEM_COMMENT', 'WorkItem comment body is required.');
    const mentionedActorIds = [...new Set(input.mentionedActorIds ?? [])];
    const result = this.idempotent(
      binding.workspace_id,
      agentId,
      'PostAgentWorkItemComment',
      idempotencyKey,
      { workItemId, body, mentionedActorIds, workItemIds: input.workItemIds ?? [], artifactSelections: input.artifactSelections ?? [] },
      () => {
        const workItem = this.requireWorkItem(workItemId);
        invariant(workItem.workspace_id === binding.workspace_id,
          'WORK_ITEM_NOT_FOUND', 'WorkItem does not exist or is not accessible.', 404);
        const membership = this.requireMembership(binding.workspace_id, agentId);
        const projectMembership = this.findProjectMembership(
          binding.workspace_id,
          workItem.project_id,
          membership.id,
        );
        invariant(projectMembership && this.getWorkItemAssigneeIds(workItem).includes(projectMembership.id),
          'WORK_ITEM_NOT_FOUND', 'WorkItem does not exist or is not accessible.', 404);
        const referencedWorkItemIds = this.normalizeWorkItemCommentReferences(workItem, input.workItemIds);
        return this.insertWorkItemComment(
          workItem,
          membership,
          projectMembership,
          body,
          mentionedActorIds,
          referencedWorkItemIds,
          input.artifactSelections ?? [],
          agentId,
        );
      },
    );
    if (result.wakeCount > 0) this.agentInboxWakeEmitter.emit('changed');
    this.handleWorkItemAttentionAsHandled(binding.workspace_id, workItemId, agentId);
    return this.mapWorkItemComment(this.requireWorkItemComment(result.commentId));
  }

  blockComputerAgentWorkItem(
    computerId: string,
    agentId: string,
    workItemId: string,
    input: { reason: string; expectedRevision: number; expectedAssignmentRevision: number },
    idempotencyKey: string,
  ): WorkItemView {
    const binding = this.requireComputerAgentBinding(computerId, agentId);
    const reason = input.reason.trim();
    invariant(reason.length > 0 && reason.length <= 2000,
      'WORK_ITEM_BLOCK_REASON_REQUIRED', 'Blocking requires a reason.');
    return this.idempotent(binding.workspace_id, agentId, 'BlockAssignedWorkItem', idempotencyKey,
      { workItemId, ...input, reason }, () => {
        const workItem = this.requireAssignedAgentWorkItem(binding.workspace_id, agentId, workItemId);
        invariant(workItem.lifecycle_status === 'open', 'WORK_ITEM_NOT_OPEN', 'Only an open WorkItem can be blocked.', 409);
        const timestamp = nowMs();
        const updated = this.workspaceDatabase.raw.prepare(
          `UPDATE work_items
           SET lifecycle_status = 'blocked', blocker_reason = ?, revision = revision + 1, updated_at = ?
           WHERE workspace_id = ? AND id = ? AND lifecycle_status = 'open'
             AND revision = ? AND assignment_revision = ?
           RETURNING revision`,
        ).get(
          reason,
          timestamp,
          binding.workspace_id,
          workItemId,
          input.expectedRevision,
          input.expectedAssignmentRevision,
        ) as { revision: number } | undefined;
        invariant(updated, 'WORK_ITEM_REVISION_CONFLICT', 'WorkItem or assignment changed concurrently.', 409);
        this.handleWorkItemAttentionAsHandled(binding.workspace_id, workItemId);
        this.recordWorkItemChange(workItem, 'work_item_blocked', { reason, revision: updated.revision }, timestamp);
        this.appendAudit(binding.workspace_id, agentId, this.requireMembership(binding.workspace_id, agentId).id,
          'work_item.block', 'work_item', workItemId,
          { reason, revision: updated.revision, runtimeBindingRevision: binding.binding_revision }, timestamp);
        return this.mapWorkItem(this.requireWorkItem(workItemId));
      });
  }

  submitComputerAgentWorkItemResult(
    computerId: string,
    agentId: string,
    workItemId: string,
    input: {
      commentId?: string | null;
      artifactVersionIds?: string[];
      expectedRevision: number;
      expectedAssignmentRevision: number;
    },
    idempotencyKey: string,
  ): WorkItemView {
    const binding = this.requireComputerAgentBinding(computerId, agentId);
    return this.idempotent(binding.workspace_id, agentId, 'SubmitAssignedWorkItemResult', idempotencyKey,
      { workItemId, ...input }, () => {
        const workItem = this.requireAssignedAgentWorkItem(binding.workspace_id, agentId, workItemId);
        invariant(workItem.lifecycle_status === 'open', 'WORK_ITEM_NOT_OPEN', 'Results can only be submitted for an open WorkItem.', 409);
        invariant(workItem.revision === input.expectedRevision
          && workItem.assignment_revision === input.expectedAssignmentRevision,
        'WORK_ITEM_REVISION_CONFLICT', 'WorkItem or assignment changed concurrently.', 409);
        const commentId = input.commentId ?? null;
        if (commentId) {
          const comment = this.requireWorkItemComment(commentId);
          invariant(
            comment.workspace_id === binding.workspace_id
            && comment.work_item_id === workItem.id
            && comment.author_actor_id === agentId
            && this.getWorkItemAssigneeIds(workItem).includes(comment.author_project_membership_id),
            'WORK_ITEM_SUBMISSION_COMMENT_INVALID',
            'Result comment must be authored by the current assignee on this WorkItem.',
            409,
          );
        }
        const artifactVersionIds = [...new Set(input.artifactVersionIds ?? [])];
        invariant(commentId !== null || artifactVersionIds.length > 0,
          'WORK_ITEM_SUBMISSION_EMPTY', 'A Result Submission requires a comment or at least one Artifact version.', 400);
        invariant(artifactVersionIds.length <= 100,
          'WORK_ITEM_SUBMISSION_TOO_MANY_ARTIFACTS', 'A Result Submission may reference at most 100 Artifact versions.', 400);
        const submissionId = newId();
        const timestamp = nowMs();
        this.workspaceDatabase.raw.prepare(
          `INSERT INTO work_item_submissions (
             id, workspace_id, project_id, work_item_id, comment_id,
             submitted_by_membership_id, submitted_by_project_membership_id,
             assignment_revision, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          submissionId,
          binding.workspace_id,
          workItem.project_id,
          workItemId,
          commentId,
          this.requireMembership(binding.workspace_id, agentId).id,
          this.findProjectMembership(binding.workspace_id, workItem.project_id,
            this.requireMembership(binding.workspace_id, agentId).id)!.id,
          workItem.assignment_revision,
          timestamp,
        );
        this.insertWorkItemSubmissionArtifactReferences(
          workItem,
          submissionId,
          artifactVersionIds,
          timestamp,
        );
        const updated = this.workspaceDatabase.raw.prepare(
          `UPDATE work_items
           SET current_submission_id = ?, revision = revision + 1, updated_at = ?
           WHERE workspace_id = ? AND id = ? AND lifecycle_status = 'open'
             AND revision = ? AND assignment_revision = ?
           RETURNING revision`,
        ).get(
          submissionId,
          timestamp,
          binding.workspace_id,
          workItemId,
          input.expectedRevision,
          input.expectedAssignmentRevision,
        ) as { revision: number } | undefined;
        invariant(updated, 'WORK_ITEM_REVISION_CONFLICT', 'WorkItem or assignment changed concurrently.', 409);
        this.handleWorkItemAttentionAsHandled(binding.workspace_id, workItemId);
        this.recordWorkItemChange(workItem, 'work_item_result_submitted', {
          submissionId,
          commentId,
          artifactVersionIds,
          revision: updated.revision,
          assignmentRevision: workItem.assignment_revision,
        }, timestamp);
        this.appendAudit(binding.workspace_id, agentId, this.requireMembership(binding.workspace_id, agentId).id,
          'work_item.result.submit', 'work_item', workItemId,
          {
            submissionId,
            commentId,
            artifactVersionIds,
            revision: updated.revision,
            assignmentRevision: workItem.assignment_revision,
            runtimeBindingRevision: binding.binding_revision,
          }, timestamp);
        return this.mapWorkItem(this.requireWorkItem(workItemId));
      });
  }

  submitHumanWorkItemResult(
    principal: HumanPrincipal,
    workItemId: string,
    input: { artifactVersionIds: string[]; expectedRevision: number },
    idempotencyKey: string,
  ): WorkItemView {
    const existing = this.requireWorkItem(workItemId);
    return this.idempotent(existing.workspace_id, principal.actorId, 'SubmitHumanWorkItemResult', idempotencyKey,
      { workItemId, ...input }, () => {
        const workItem = this.requireWorkItem(workItemId);
        const membership = this.requireHumanWorkItemAuthority(principal.actorId, workItem);
        const projectMembership = this.findProjectMembership(workItem.workspace_id, workItem.project_id, membership.id);
        invariant(projectMembership, 'WORK_ITEM_AUTHORITY_REQUIRED', 'A Project membership is required to submit a result.', 403);
        invariant(workItem.lifecycle_status === 'open', 'WORK_ITEM_NOT_OPEN', 'Results can only be submitted for an open WorkItem.', 409);
        invariant(workItem.revision === input.expectedRevision,
          'WORK_ITEM_REVISION_CONFLICT', 'WorkItem changed concurrently.', 409);
        const artifactVersionIds = [...new Set(input.artifactVersionIds)];
        invariant(artifactVersionIds.length > 0,
          'WORK_ITEM_SUBMISSION_EMPTY', 'A Result Submission requires at least one Artifact version.', 400);
        invariant(artifactVersionIds.length <= 100,
          'WORK_ITEM_SUBMISSION_TOO_MANY_ARTIFACTS', 'A Result Submission may reference at most 100 Artifact versions.', 400);
        const submissionId = newId();
        const timestamp = nowMs();
        this.workspaceDatabase.raw.prepare(
          `INSERT INTO work_item_submissions (
             id, workspace_id, project_id, work_item_id, comment_id,
             submitted_by_membership_id, submitted_by_project_membership_id,
             assignment_revision, created_at
           ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
        ).run(
          submissionId,
          workItem.workspace_id,
          workItem.project_id,
          workItem.id,
          membership.id,
          projectMembership.id,
          workItem.assignment_revision,
          timestamp,
        );
        this.insertWorkItemSubmissionArtifactReferences(workItem, submissionId, artifactVersionIds, timestamp);
        const updated = this.workspaceDatabase.raw.prepare(
          `UPDATE work_items
           SET current_submission_id = ?, revision = revision + 1, updated_at = ?
           WHERE workspace_id = ? AND id = ? AND lifecycle_status = 'open' AND revision = ?
           RETURNING revision`,
        ).get(submissionId, timestamp, workItem.workspace_id, workItem.id, input.expectedRevision) as { revision: number } | undefined;
        invariant(updated, 'WORK_ITEM_REVISION_CONFLICT', 'WorkItem changed concurrently.', 409);
        this.recordWorkItemChange(workItem, 'work_item_result_submitted', {
          submissionId,
          commentId: null,
          artifactVersionIds,
          revision: updated.revision,
          assignmentRevision: workItem.assignment_revision,
        }, timestamp);
        this.appendAudit(workItem.workspace_id, principal.actorId, membership.id,
          'work_item.result.submit', 'work_item', workItem.id,
          {
            submissionId,
            commentId: null,
            artifactVersionIds,
            revision: updated.revision,
            assignmentRevision: workItem.assignment_revision,
          }, timestamp);
        return this.mapWorkItem(this.requireWorkItem(workItem.id));
      });
  }

  /**
   * A WorkItem created from a Conversation message is a handoff, not a second
   * independent wake for the same Agent.  Resolve the one active WorkItem that
   * owns the source message so its assignment and the source Mention can share
   * the WorkItem Session.
   */
  private linkedWorkItemSessionForMention(
    workspaceId: string,
    agentId: string,
    messageId: string | null,
  ): string | null {
    if (!messageId) return null;
    const row = this.workspaceDatabase.raw.prepare(
      `SELECT item.id
       FROM work_items item
       WHERE item.workspace_id = ? AND item.source_message_id = ?
         AND item.lifecycle_status IN ('open', 'blocked')
         AND (
           EXISTS (
             SELECT 1
             FROM work_item_assignees assignee
             JOIN project_memberships project_membership
               ON project_membership.workspace_id = assignee.workspace_id
              AND project_membership.project_id = assignee.project_id
              AND project_membership.id = assignee.project_membership_id
             JOIN workspace_memberships membership
               ON membership.workspace_id = project_membership.workspace_id
              AND membership.id = project_membership.workspace_membership_id
             WHERE assignee.workspace_id = item.workspace_id
               AND assignee.work_item_id = item.id
               AND membership.actor_id = ?
           )
           OR EXISTS (
             SELECT 1
             FROM project_memberships project_membership
             JOIN workspace_memberships membership
               ON membership.workspace_id = project_membership.workspace_id
              AND membership.id = project_membership.workspace_membership_id
             WHERE project_membership.workspace_id = item.workspace_id
               AND project_membership.project_id = item.project_id
               AND project_membership.id = item.assignee_project_membership_id
               AND membership.actor_id = ?
           )
         )
       ORDER BY item.created_at, item.id
       LIMIT 1`,
    ).get(workspaceId, messageId, agentId, agentId) as { id: string } | undefined;
    return row?.id ?? null;
  }

  getComputerAgentInbox(computerId: string, agentId: string): AgentInboxSummaryView {
    const binding = this.requireComputerAgentBinding(computerId, agentId);
    const highest = this.workspaceDatabase.raw.prepare(
      'SELECT COALESCE(MAX(sequence), 0) AS sequence FROM agent_inbox_items WHERE workspace_id = ? AND agent_id = ?',
    ).get(binding.workspace_id, agentId) as { sequence: number };
    const rows = this.workspaceDatabase.raw.prepare(
      `SELECT item.conversation_id, item.thread_id, item.work_item_id, COUNT(*) AS pending_count,
              MIN(item.sequence) AS first_sequence, MAX(item.sequence) AS last_sequence,
              MAX(CASE WHEN item.state = 'claimed' OR wake.inbox_item_id IS NOT NULL THEN 1 ELSE 0 END)
                AS requires_action
       FROM agent_inbox_items item
       LEFT JOIN agent_inbox_wakes wake
         ON wake.workspace_id = item.workspace_id AND wake.inbox_item_id = item.id
       WHERE item.workspace_id = ? AND item.agent_id = ? AND item.state IN ('pending', 'claimed')
       GROUP BY conversation_id, thread_id, work_item_id
       ORDER BY first_sequence`,
    ).all(binding.workspace_id, agentId) as unknown as Array<{
      conversation_id: string | null;
      thread_id: string | null;
      work_item_id: string | null;
      pending_count: number;
      first_sequence: number;
      last_sequence: number;
      requires_action: 0 | 1;
    }>;
    const triggerRows = this.workspaceDatabase.raw.prepare(
      `SELECT id, sequence, attention_kind, agent_request_id, message_id,
              conversation_id, thread_id, work_item_id, state
       FROM agent_inbox_items
       WHERE workspace_id = ? AND agent_id = ?
         AND state IN ('pending', 'claimed')
         AND attention_kind <> 'discussion_change'
       ORDER BY sequence, id`,
    ).all(binding.workspace_id, agentId) as unknown as Array<{
      id: string;
      sequence: number;
      attention_kind: AgentInboxItemRow['attention_kind'];
      agent_request_id: string | null;
      message_id: string | null;
      conversation_id: string | null;
      thread_id: string | null;
      work_item_id: string | null;
      state: 'pending' | 'claimed';
    }>;
    const sessionTriggers: AgentInboxSessionTriggerView[] = [];
    for (const row of triggerRows) {
      const linkedWorkItemId = row.agent_request_id
        ? this.linkedWorkItemSessionForMention(binding.workspace_id, agentId, row.message_id)
        : null;
      const session: { kind: AgentSessionKind; key: string } | null = linkedWorkItemId
        ? { kind: 'work_item', key: linkedWorkItemId }
        : row.agent_request_id
          ? { kind: 'mention', key: row.agent_request_id }
        : row.work_item_id
          ? { kind: 'work_item', key: row.work_item_id }
          : null;
      if (!session) continue;
      sessionTriggers.push({
        session,
        inboxItemId: row.id,
        sequence: row.sequence,
        target: row.conversation_id
          ? this.inboxTarget(row.conversation_id, row.thread_id)
          : row.work_item_id ? `work-item:${row.work_item_id}` : null,
        agentRequestId: row.agent_request_id,
        messageId: row.message_id,
        conversationId: row.conversation_id,
        threadId: row.thread_id,
        workItemId: row.work_item_id,
        requiresAction: row.state === 'pending' || row.state === 'claimed',
      });
    }
    return {
      agentId,
      highestSequence: highest.sequence,
      targets: rows.map((row) => row.work_item_id !== null ? {
        kind: 'work_item' as const,
        conversationId: null,
        threadId: null,
        workItemId: row.work_item_id,
        target: `work-item:${row.work_item_id}`,
        pendingCount: row.pending_count,
        firstSequence: row.first_sequence,
        lastSequence: row.last_sequence,
        requiresAction: true as const,
      } : {
        kind: 'discussion' as const,
        conversationId: row.conversation_id!,
        threadId: row.thread_id,
        workItemId: null,
        target: this.inboxTarget(row.conversation_id!, row.thread_id),
        pendingCount: row.pending_count,
        firstSequence: row.first_sequence,
        lastSequence: row.last_sequence,
        requiresAction: row.requires_action === 1,
      }),
      sessionTriggers,
    };
  }

  getComputerAgentInboxWakes(
    computerId: string,
    after: Record<string, number>,
  ): AgentInboxWakeBatchView {
    const rows = this.workspaceDatabase.raw.prepare(
      `SELECT binding.agent_id, COALESCE(MAX(wake.sequence), 0) AS wake_sequence
       FROM agent_runtime_bindings binding
       LEFT JOIN agent_inbox_wakes wake
         ON wake.workspace_id = binding.workspace_id AND wake.agent_id = binding.agent_id
       WHERE binding.computer_id = ? AND binding.status = 'active'
       GROUP BY binding.agent_id
       ORDER BY binding.agent_id`,
    ).all(computerId) as unknown as Array<{ agent_id: string; wake_sequence: number }>;
    const cursor = Object.fromEntries(rows.map((row) => [row.agent_id, row.wake_sequence]));
    return {
      events: rows.flatMap((row) => row.wake_sequence > (after[row.agent_id] ?? 0)
        ? [{ type: 'agent.inbox_changed' as const, agentId: row.agent_id, wakeSequence: row.wake_sequence }]
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
    input: { target: string; receipt: string; agentRequestId?: string; initialDiscussionFrontier?: number },
  ): AgentInboxClaimView {
    invariant(input.receipt.trim().length > 0, 'INVALID_INBOX_RECEIPT', 'Inbox receipt is required.');
    invariant(input.initialDiscussionFrontier === undefined
      || (Number.isSafeInteger(input.initialDiscussionFrontier) && input.initialDiscussionFrontier >= 0),
    'INVALID_DISCUSSION_FRONTIER', 'Initial Discussion frontier must be a non-negative integer.', 400);
    const binding = this.requireComputerAgentBinding(computerId, agentId);
    const scope = this.parseInboxTarget(binding.workspace_id, input.target);
    const membership = this.requireMembership(binding.workspace_id, agentId);
    invariant(this.hasConversationAccess(binding.workspace_id, scope.conversationId, membership.id),
      'CONVERSATION_NOT_FOUND', 'Conversation is not accessible to this Agent.', 404);
    return this.workspaceDatabase.transaction(() => {
      const requestedAgentRequestId = input.agentRequestId?.trim() || null;
      let receiptRow = this.workspaceDatabase.raw.prepare(
        `SELECT * FROM agent_inbox_claim_receipts
         WHERE workspace_id = ? AND agent_id = ? AND receipt = ?`,
      ).get(binding.workspace_id, agentId, input.receipt) as AgentInboxClaimReceiptRow | undefined;
      if (!receiptRow && requestedAgentRequestId) {
        receiptRow = this.workspaceDatabase.raw.prepare(
          `SELECT * FROM agent_inbox_claim_receipts
           WHERE workspace_id = ? AND agent_id = ? AND agent_request_id = ? AND handled_at IS NULL
           ORDER BY created_at DESC LIMIT 1`,
        ).get(binding.workspace_id, agentId, requestedAgentRequestId) as AgentInboxClaimReceiptRow | undefined;
      }
      if (receiptRow) {
        invariant(receiptRow.binding_revision === binding.binding_revision
          && receiptRow.target === input.target
          && (!requestedAgentRequestId || receiptRow.agent_request_id === requestedAgentRequestId),
        'INBOX_RECEIPT_SCOPE_MISMATCH', 'Inbox receipt belongs to another Agent session or target.', 409);
      }
      const receiptToken = receiptRow?.receipt ?? input.receipt;
      const replayRows = this.workspaceDatabase.raw.prepare(
        `SELECT * FROM agent_inbox_items
         WHERE workspace_id = ? AND agent_id = ? AND claim_receipt = ? ORDER BY sequence`,
      ).all(binding.workspace_id, agentId, receiptToken) as unknown as AgentInboxItemRow[];
      const trigger = requestedAgentRequestId ? this.workspaceDatabase.raw.prepare(
        `SELECT * FROM agent_inbox_items
         WHERE workspace_id = ? AND agent_id = ? AND agent_request_id = ?
           AND conversation_id = ? AND thread_id IS ?`,
      ).get(binding.workspace_id, agentId, requestedAgentRequestId, scope.conversationId, scope.threadId) as AgentInboxItemRow | undefined : undefined;
      const legacyRows = !requestedAgentRequestId && !receiptRow
        ? this.workspaceDatabase.raw.prepare(
          `SELECT * FROM agent_inbox_items
           WHERE workspace_id = ? AND agent_id = ? AND conversation_id = ? AND thread_id IS ? AND state = 'pending'
           ORDER BY sequence`,
        ).all(binding.workspace_id, agentId, scope.conversationId, scope.threadId) as unknown as AgentInboxItemRow[]
        : [];
      const legacyTrigger = legacyRows.find((row) => row.agent_request_id !== null);
      const effectiveAgentRequestId = requestedAgentRequestId ?? receiptRow?.agent_request_id ?? legacyTrigger?.agent_request_id;
      const conversation = this.workspaceDatabase.raw.prepare(
        'SELECT conversation_kind FROM conversations WHERE workspace_id = ? AND id = ?',
      ).get(binding.workspace_id, scope.conversationId) as { conversation_kind: ConversationKind } | undefined;
      invariant(conversation, 'CONVERSATION_NOT_FOUND', 'Conversation does not exist.', 404);
      const dynamicDm = conversation.conversation_kind === 'dm' && requestedAgentRequestId !== null;
      invariant(receiptRow || trigger || legacyRows.length > 0,
        'AGENT_INBOX_EMPTY', 'Inbox target has no pending event for this Agent Request.', 409);
      invariant(receiptRow || (requestedAgentRequestId ? trigger?.state === 'pending' : legacyRows.length > 0),
        'AGENT_INBOX_EMPTY', 'Inbox target has no pending event for this Agent Request.', 409);
      const sourceMessage = trigger
        ? this.requireMessage(trigger.message_id!)
        : effectiveAgentRequestId
          ? this.requireMessage(this.requireAgentRequest(effectiveAgentRequestId).source_message_id)
          : this.requireMessage(legacyRows[0]!.message_id!);
      invariant(sourceMessage.conversation_id === scope.conversationId && sourceMessage.thread_id === scope.threadId,
        'INBOX_RECEIPT_SCOPE_MISMATCH', 'Agent Request does not belong to the requested Discussion scope.', 409);
      // When the caller supplies the Session frontier, never allow it to move
      // behind the source trigger that is already present in the JSONL snapshot.
      const sessionInitialFrontier = input.initialDiscussionFrontier === undefined
        ? 0
        : Math.max(input.initialDiscussionFrontier, sourceMessage.scope_position);
      const acceptedBefore = dynamicDm
        ? Number((this.workspaceDatabase.raw.prepare(
          `SELECT COUNT(*) AS count
           FROM agent_inbox_items item
           JOIN agent_inbox_claim_receipts receipt
             ON receipt.workspace_id = item.workspace_id AND receipt.receipt = item.claim_receipt
           WHERE item.workspace_id = ? AND item.agent_id = ?
             AND item.attention_kind = 'direct_message' AND receipt.agent_request_id = ?`,
        ).get(binding.workspace_id, agentId, requestedAgentRequestId) as { count: number }).count)
        : 0;
      const remaining = dynamicDm ? Math.max(0, 10 - acceptedBefore) : 0;
      let rows: AgentInboxItemRow[];
      let deltaFrom = receiptRow?.through_position ?? sessionInitialFrontier;
      if (legacyRows.length > 0 && !requestedAgentRequestId && !receiptRow) {
        rows = legacyRows;
      } else if (dynamicDm && remaining > 0) {
        rows = this.workspaceDatabase.raw.prepare(
          `SELECT * FROM agent_inbox_items
           WHERE workspace_id = ? AND agent_id = ? AND conversation_id = ? AND thread_id IS ?
             AND state = 'pending' AND attention_kind = 'direct_message'
           ORDER BY sequence LIMIT ?`,
        ).all(binding.workspace_id, agentId, scope.conversationId, scope.threadId, remaining) as unknown as AgentInboxItemRow[];
      } else if (receiptRow && requestedAgentRequestId && !dynamicDm) {
        rows = this.workspaceDatabase.raw.prepare(
          `SELECT * FROM agent_inbox_items
           WHERE workspace_id = ? AND agent_id = ? AND conversation_id = ? AND thread_id IS ?
             AND state = 'pending' AND attention_kind = 'discussion_change' AND sequence > ?
           ORDER BY sequence`,
        ).all(binding.workspace_id, agentId, scope.conversationId, scope.threadId, receiptRow.through_position) as unknown as AgentInboxItemRow[];
      } else if (!receiptRow && trigger) {
        rows = this.workspaceDatabase.raw.prepare(
          `SELECT * FROM agent_inbox_items
           WHERE workspace_id = ? AND agent_id = ? AND conversation_id = ? AND thread_id IS ? AND state = 'pending'
             AND (id = ? OR (attention_kind = 'discussion_change' AND sequence <= ?)) ORDER BY sequence`,
        ).all(binding.workspace_id, agentId, scope.conversationId, scope.threadId, trigger.id, trigger.sequence) as unknown as AgentInboxItemRow[];
      } else {
        rows = [];
      }
      if (receiptRow && rows.length === 0) {
        rows = replayRows;
        deltaFrom = receiptRow.from_position;
      }
      invariant(rows.length > 0, 'AGENT_INBOX_EMPTY', 'Inbox target has no pending event for this Agent Request.', 409);
      const timestamp = nowMs();
      if (!receiptRow) {
        const prior = this.workspaceDatabase.raw.prepare(
          `SELECT COALESCE(MAX(receipt.through_position), 0) AS position
           FROM agent_inbox_claim_receipts receipt
           WHERE receipt.workspace_id = ? AND receipt.agent_id = ? AND receipt.binding_revision = ?
             AND receipt.target = ? AND receipt.handled_at IS NOT NULL`,
        ).get(binding.workspace_id, agentId, binding.binding_revision, input.target) as { position: number };
        deltaFrom = Math.max(prior.position, sessionInitialFrontier);
        const throughPosition = Math.max(sourceMessage.scope_position,
          ...rows.map((row) => row.message_id ? this.requireMessage(row.message_id).scope_position : 0));
        const receiptId = newId();
        this.workspaceDatabase.raw.prepare(
          `INSERT INTO agent_inbox_claim_receipts (
             id, workspace_id, agent_id, agent_request_id, receipt, binding_revision, target_kind, target,
             conversation_id, thread_id, from_position, through_position, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(receiptId, binding.workspace_id, agentId, effectiveAgentRequestId!, input.receipt,
          binding.binding_revision, scope.kind, input.target, scope.conversationId, scope.threadId,
          Math.max(prior.position, sessionInitialFrontier), throughPosition, timestamp, timestamp);
        receiptRow = this.workspaceDatabase.raw.prepare('SELECT * FROM agent_inbox_claim_receipts WHERE id = ?')
          .get(receiptId) as unknown as AgentInboxClaimReceiptRow;
      }
      const replaying = receiptRow.handled_at !== null || (receiptRow && rows === replayRows);
      const rowsToClaim = replaying ? [] : rows;
      this.claimInboxItems(binding.workspace_id, agentId, receiptToken, rowsToClaim, timestamp);
      if (rowsToClaim.length > 0) {
        const throughPosition = Math.max(receiptRow.through_position,
          ...rowsToClaim.map((row) => row.message_id ? this.requireMessage(row.message_id).scope_position : 0));
        this.workspaceDatabase.raw.prepare(
          `UPDATE agent_inbox_claim_receipts SET through_position = MAX(through_position, ?), updated_at = ?
           WHERE id = ? AND handled_at IS NULL`,
        ).run(throughPosition, timestamp, receiptRow.id);
        receiptRow = this.workspaceDatabase.raw.prepare('SELECT * FROM agent_inbox_claim_receipts WHERE id = ?')
          .get(receiptRow.id) as unknown as AgentInboxClaimReceiptRow;
      }
      const acceptedAfter = dynamicDm
        ? Number((this.workspaceDatabase.raw.prepare(
          `SELECT COUNT(*) AS count FROM agent_inbox_items item
           JOIN agent_inbox_claim_receipts receipt
             ON receipt.workspace_id = item.workspace_id AND receipt.receipt = item.claim_receipt
           WHERE item.workspace_id = ? AND item.agent_id = ?
             AND item.attention_kind = 'direct_message' AND receipt.agent_request_id = ?`,
        ).get(binding.workspace_id, agentId, requestedAgentRequestId) as { count: number }).count)
        : 1;
      const sessionWindow: AgentSessionWindowView = {
        mode: dynamicDm ? 'dm' : 'isolated',
        acceptedMessages: dynamicDm ? Math.min(acceptedAfter, 10) : 1,
        maxMessages: 10,
        status: receiptRow.handled_at !== null
          ? 'completed'
          : dynamicDm && acceptedAfter >= 10 ? 'frozen' : 'accepting',
      };
      return this.hydrateInboxClaim(agentId, receiptToken, input.target,
        rowsToClaim.length > 0 ? rowsToClaim : replayRows, receiptRow!,
        rowsToClaim.length > 0 ? deltaFrom : undefined, sessionWindow);
    });
  }

  readComputerAgentMessages(
    computerId: string,
    agentId: string,
    input: {
      conversationId: string;
      threadId: string | null;
      before?: number;
      after?: number;
      limit?: number;
    },
  ): MessageView[] {
    const binding = this.requireComputerAgentBinding(computerId, agentId);
    const membership = this.requireMembership(binding.workspace_id, agentId);
    invariant(this.hasConversationAccess(binding.workspace_id, input.conversationId, membership.id),
      'CONVERSATION_NOT_FOUND', 'Conversation is not accessible to this Agent.', 404);
    invariant(input.before === undefined || input.after === undefined,
      'INVALID_MESSAGE_RANGE', 'Message history cannot use before and after together.', 400);
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const rows = input.before !== undefined
      ? this.workspaceDatabase.raw.prepare(
        `SELECT * FROM messages
         WHERE workspace_id = ? AND conversation_id = ? AND thread_id IS ? AND scope_position < ?
         ORDER BY scope_position DESC LIMIT ?`,
      ).all(binding.workspace_id, input.conversationId, input.threadId, input.before, limit).reverse()
      : this.workspaceDatabase.raw.prepare(
        `SELECT * FROM messages
         WHERE workspace_id = ? AND conversation_id = ? AND thread_id IS ?
           AND scope_position > ?
         ORDER BY scope_position LIMIT ?`,
      ).all(binding.workspace_id, input.conversationId, input.threadId, input.after ?? 0, limit);
    return (rows as unknown as MessageRow[]).map((row) => this.hydrateMessage(row, membership));
  }

  resolveComputerAgentMessage(
    computerId: string,
    agentId: string,
    input: { conversationId: string; threadId: string | null; messageId: string },
  ): MessageView {
    const binding = this.requireComputerAgentBinding(computerId, agentId);
    const membership = this.requireMembership(binding.workspace_id, agentId);
    invariant(this.hasConversationAccess(binding.workspace_id, input.conversationId, membership.id),
      'CONVERSATION_NOT_FOUND', 'Conversation is not accessible to this Agent.', 404);
    const message = this.requireMessage(input.messageId);
    invariant(
      message.workspace_id === binding.workspace_id
      && message.conversation_id === input.conversationId
      && message.thread_id === input.threadId,
      'MESSAGE_NOT_IN_DISCUSSION_SCOPE',
      'Message does not belong to the active Discussion Scope.',
      404,
    );
    return this.hydrateMessage(message, membership);
  }

  sendComputerAgentMessage(
    computerId: string,
    agentId: string,
    input: {
      conversationId: string;
      threadId: string | null;
      receipt: string;
      draftId: string;
      expectedDiscussionFrontier: number;
      body: string;
      artifactVersionIds?: string[];
      mentionedActorIds?: string[];
      workItemIds?: string[];
      mode: 'check' | 'override';
    },
    idempotencyKey: string,
  ): AgentMessagePublicationResultView {
    const binding = this.requireComputerAgentBinding(computerId, agentId);
    invariant(input.receipt.trim().length > 0, 'INBOX_RECEIPT_REQUIRED', 'Inbox receipt is required.', 400);
    const target = this.inboxTarget(input.conversationId, input.threadId);
    return this.idempotent(
      binding.workspace_id,
      agentId,
      'SendAgentInboxMessage',
      idempotencyKey,
      input,
      () => {
        const claim = this.requireActiveInboxReceipt(binding, agentId, input.receipt, target);
        invariant(claim.target_kind === 'discussion', 'INBOX_RECEIPT_SCOPE_MISMATCH',
          'Message publication requires a Discussion receipt.', 409);
        invariant(input.expectedDiscussionFrontier === claim.through_position,
          'INBOX_RECEIPT_FRONTIER_MISMATCH',
          'Expected Discussion frontier must match the claimed receipt checkpoint.', 409);
        const currentDiscussionFrontier = this.discussionFrontier(
          binding.workspace_id,
          input.conversationId,
          input.threadId,
        );
        invariant(input.expectedDiscussionFrontier <= currentDiscussionFrontier,
          'INVALID_DISCUSSION_FRONTIER', 'Expected Discussion frontier is ahead of Workspace state.', 409);
        if (input.mode === 'override') {
          this.requirePriorFreshnessHold(
            binding.workspace_id,
            agentId,
            binding.binding_revision,
            target,
            input.draftId,
          );
          this.extendInboxReceiptThroughFrontier(claim, currentDiscussionFrontier, nowMs());
        } else if (currentDiscussionFrontier !== input.expectedDiscussionFrontier
          && !this.isFrozenDmInboxWindow(binding.workspace_id, agentId, claim)) {
          const heldAt = nowMs();
          const attention = this.extendInboxReceiptThroughFrontier(claim, currentDiscussionFrontier, heldAt);
          const membership = this.requireMembership(binding.workspace_id, agentId);
          this.appendAudit(
            binding.workspace_id,
            agentId,
            membership.id,
            'message.freshness_hold',
            'held_draft',
            input.draftId,
            {
              draftId: input.draftId,
              target,
              expectedDiscussionFrontier: input.expectedDiscussionFrontier,
              currentDiscussionFrontier,
              runtimeBindingRevision: binding.binding_revision,
            },
            heldAt,
          );
          return {
            status: 'held',
            draftId: input.draftId,
            expectedDiscussionFrontier: input.expectedDiscussionFrontier,
            currentDiscussionFrontier,
            attention: this.mapInboxAttentions(attention),
            discussionDelta: this.discussionDelta(
              binding.workspace_id,
              agentId,
              input.conversationId,
              input.threadId,
              input.expectedDiscussionFrontier,
              currentDiscussionFrontier,
            ),
          };
        }
        const publishedAt = nowMs();
        const message = this.publishPersistentAgentMessage(
          binding.workspace_id,
          agentId,
          input.conversationId,
          input.threadId,
          input.body,
          input.artifactVersionIds ?? [],
          input.mentionedActorIds ?? [],
          input.workItemIds ?? [],
          binding.binding_revision,
          publishedAt,
        );
        this.completeInboxReceipt(binding.workspace_id, agentId, input.receipt, publishedAt);
        if (input.mode === 'override') {
          const membership = this.requireMembership(binding.workspace_id, agentId);
          this.appendAudit(
            binding.workspace_id,
            agentId,
            membership.id,
            'message.freshness_override',
            'message',
            message.id,
            {
              draftId: input.draftId,
              target,
              expectedDiscussionFrontier: input.expectedDiscussionFrontier,
              currentDiscussionFrontier,
              runtimeBindingRevision: binding.binding_revision,
            },
            publishedAt,
          );
        }
        return { status: 'published', message };
      },
    );
  }

  completeComputerAgentInbox(
    computerId: string,
    agentId: string,
    input: {
      receipt: string;
      target: string;
      expectedDiscussionFrontier?: number;
      draftId?: string;
    },
    idempotencyKey: string,
  ): AgentInboxCompletionResultView {
    const binding = this.requireComputerAgentBinding(computerId, agentId);
    return this.idempotent(binding.workspace_id, agentId, 'CompleteAgentInbox', idempotencyKey, input, () => {
      const claim = this.requireActiveInboxReceipt(binding, agentId, input.receipt, input.target);
      {
        invariant(input.expectedDiscussionFrontier !== undefined,
          'DISCUSSION_FRONTIER_REQUIRED', 'Discussion completion requires the reviewed frontier.', 400);
        invariant(input.expectedDiscussionFrontier === claim.through_position,
          'INBOX_RECEIPT_FRONTIER_MISMATCH',
          'Expected Discussion frontier must match the claimed receipt checkpoint.', 409);
        const currentDiscussionFrontier = this.discussionFrontier(
          binding.workspace_id,
          claim.conversation_id!,
          claim.thread_id,
        );
        invariant(input.expectedDiscussionFrontier <= currentDiscussionFrontier,
          'INVALID_DISCUSSION_FRONTIER', 'Expected Discussion frontier is ahead of Workspace state.', 409);
        if (currentDiscussionFrontier !== input.expectedDiscussionFrontier
          && !this.isFrozenDmInboxWindow(binding.workspace_id, agentId, claim)) {
          const reviewedAt = nowMs();
          const attention = this.extendInboxReceiptThroughFrontier(claim, currentDiscussionFrontier, reviewedAt);
          return {
            status: 'review_required',
            expectedDiscussionFrontier: input.expectedDiscussionFrontier,
            currentDiscussionFrontier,
            attention: this.mapInboxAttentions(attention),
            discussionDelta: this.discussionDelta(
              binding.workspace_id,
              agentId,
              claim.conversation_id!,
              claim.thread_id,
              input.expectedDiscussionFrontier,
              currentDiscussionFrontier,
            ),
          };
        }
      }
      const handledAt = nowMs();
      this.completeInboxReceipt(binding.workspace_id, agentId, input.receipt, handledAt);
      if (input.draftId) {
        this.requirePriorFreshnessHold(
          binding.workspace_id,
          agentId,
          binding.binding_revision,
          input.target,
          input.draftId,
        );
        const membership = this.requireMembership(binding.workspace_id, agentId);
        this.appendAudit(
          binding.workspace_id,
          agentId,
          membership.id,
          'message.freshness_discard',
          'held_draft',
          input.draftId,
          {
            draftId: input.draftId,
            target: input.target,
            reviewedThroughPosition: input.expectedDiscussionFrontier,
            runtimeBindingRevision: binding.binding_revision,
          },
          handledAt,
        );
      }
      return { status: 'completed', receipt: input.receipt, handledAt };
    });
  }

  private hydrateInboxClaim(
    agentId: string,
    receiptToken: string,
    target: string,
    rows: AgentInboxItemRow[],
    receipt: AgentInboxClaimReceiptRow,
    fromPosition = receipt.from_position,
    sessionWindow: AgentSessionWindowView = {
      mode: 'isolated',
      acceptedMessages: 1,
      maxMessages: 10,
      status: 'accepting',
    },
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
      fromPosition,
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
      receipt: receiptToken,
      target,
      targetKind: 'discussion',
      sessionWindow,
      attention: this.mapInboxAttentions(rows),
      discussion: {
        conversationId: receipt.conversation_id!,
        threadId: receipt.thread_id,
        sincePositionExclusive: fromPosition,
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

  private extendInboxReceiptThroughFrontier(
    receipt: AgentInboxClaimReceiptRow,
    currentDiscussionFrontier: number,
    timestamp: number,
  ): AgentInboxItemRow[] {
    invariant(receipt.conversation_id !== null,
      'INBOX_RECEIPT_SCOPE_MISMATCH', 'Discussion freshness requires a Discussion receipt.', 409);
    const pending = this.workspaceDatabase.raw.prepare(
      `SELECT * FROM agent_inbox_items
       WHERE workspace_id = ? AND agent_id = ?
         AND conversation_id = ? AND thread_id IS ? AND state = 'pending'
         AND attention_kind = 'discussion_change'
       ORDER BY sequence`,
    ).all(
      receipt.workspace_id,
      receipt.agent_id,
      receipt.conversation_id,
      receipt.thread_id,
    ) as unknown as AgentInboxItemRow[];
    this.claimInboxItems(receipt.workspace_id, receipt.agent_id, receipt.receipt, pending, timestamp);
    this.workspaceDatabase.raw.prepare(
      `UPDATE agent_inbox_claim_receipts
       SET through_position = MAX(through_position, ?), updated_at = ?
       WHERE id = ? AND handled_at IS NULL`,
    ).run(currentDiscussionFrontier, timestamp, receipt.id);
    return pending;
  }

  private claimInboxItems(
    workspaceId: string,
    agentId: string,
    receipt: string,
    rows: AgentInboxItemRow[],
    timestamp: number,
  ): void {
    for (const item of rows) {
      if (item.agent_request_id) {
        const request = this.requireAgentRequest(item.agent_request_id);
        invariant(request.target_agent_id === agentId,
          'AGENT_INBOX_SCOPE_MISMATCH', 'Inbox item targets another Agent.', 409);
        if (request.status === 'pending') {
          this.workspaceDatabase.raw.prepare(
            `UPDATE agent_requests
             SET status = 'accepted', version = version + 1, updated_at = ?, terminal_at = ?
             WHERE workspace_id = ? AND id = ? AND status = 'pending'`,
          ).run(timestamp, timestamp, workspaceId, request.id);
        }
      }
      this.workspaceDatabase.raw.prepare(
        `UPDATE agent_inbox_items
         SET state = 'claimed', claim_receipt = ?, claimed_at = ?
         WHERE workspace_id = ? AND id = ? AND state = 'pending'`,
      ).run(receipt, timestamp, workspaceId, item.id);
    }
  }

  private mapInboxAttention(row: AgentInboxItemRow): AgentInboxAttentionView {
    invariant(row.attention_kind !== 'discussion_change', 'INVALID_AGENT_INBOX_ATTENTION',
      'A silent Discussion delivery is not an attention signal.', 409);
    return {
      inboxItemId: row.id,
      sequence: row.sequence,
      attentionKind: row.attention_kind,
      agentRequestId: row.agent_request_id,
      messageId: row.message_id,
      workItemId: row.work_item_id,
      workItemCommentId: row.work_item_comment_id,
    };
  }

  private mapInboxAttentions(rows: AgentInboxItemRow[]): AgentInboxAttentionView[] {
    return rows
      .filter((row) => row.attention_kind !== 'discussion_change')
      .map((row) => this.mapInboxAttention(row));
  }

  private discussionDelta(
    workspaceId: string,
    agentId: string,
    conversationId: string,
    threadId: string | null,
    sincePositionExclusive: number,
    throughPosition: number,
  ): AgentInboxDiscussionDeltaView {
    const membership = this.requireMembership(workspaceId, agentId);
    const messages = this.workspaceDatabase.raw.prepare(
      `SELECT * FROM messages
       WHERE workspace_id = ? AND conversation_id = ? AND thread_id IS ?
         AND scope_position > ? AND scope_position <= ?
       ORDER BY scope_position, id`,
    ).all(
      workspaceId,
      conversationId,
      threadId,
      sincePositionExclusive,
      throughPosition,
    ) as unknown as MessageRow[];
    const rootMessage = threadId === null ? undefined : this.workspaceDatabase.raw.prepare(
      `SELECT message.* FROM threads thread
       JOIN messages message
         ON message.workspace_id = thread.workspace_id AND message.id = thread.root_message_id
       WHERE thread.workspace_id = ? AND thread.conversation_id = ? AND thread.id = ?`,
    ).get(workspaceId, conversationId, threadId) as MessageRow | undefined;
    return {
      conversationId,
      threadId,
      sincePositionExclusive,
      throughPosition,
      rootMessage: rootMessage ? this.hydrateMessage(rootMessage, membership) : null,
      messages: messages.map((row) => this.hydrateMessage(row, membership)),
    };
  }

  private requirePriorFreshnessHold(
    workspaceId: string,
    agentId: string,
    bindingRevision: number,
    target: string,
    draftId: string,
  ): void {
    const rows = this.workspaceDatabase.raw.prepare(
      `SELECT details_json FROM audit_events
       WHERE workspace_id = ? AND actor_id = ? AND action = 'message.freshness_hold'
         AND target_type = 'held_draft' AND target_id = ?
       ORDER BY seq DESC`,
    ).all(workspaceId, agentId, draftId) as Array<{ details_json: string }>;
    const held = rows.some((row) => {
      const details = JSON.parse(row.details_json) as Record<string, unknown>;
      return details.target === target && details.runtimeBindingRevision === bindingRevision;
    });
    invariant(held, 'FRESHNESS_OVERRIDE_NOT_ALLOWED',
      'This Agent, target, and draft have not completed a freshness hold.', 409);
  }

  private agentActivityEventRow(eventId: string): AgentActivityEventRow | undefined {
    return this.workspaceDatabase.raw.prepare(
      `SELECT event.*, agent.name AS agent_name,
              turn.status AS turn_status, turn.started_at AS turn_started_at,
              turn.updated_at AS turn_updated_at, turn.finished_at AS turn_finished_at
       FROM agent_activity_events event
       JOIN agent_activity_turns turn
         ON turn.workspace_id = event.workspace_id AND turn.id = event.turn_id
       JOIN agents agent
         ON agent.workspace_id = event.workspace_id AND agent.actor_id = event.agent_id
       WHERE event.id = ?`,
    ).get(eventId) as AgentActivityEventRow | undefined;
  }

  private mapAgentActivityEvent(row: AgentActivityEventRow): AgentActivityEventView {
    return {
      eventId: row.id,
      turnId: row.turn_id,
      workspaceId: row.workspace_id,
      agentId: row.agent_id,
      agentName: row.agent_name,
      sequence: row.sequence,
      eventType: row.event_type,
      title: row.title,
      status: row.status,
      turnStatus: row.turn_status,
      turnStartedAt: row.turn_started_at,
      turnUpdatedAt: row.turn_updated_at,
      turnFinishedAt: row.turn_finished_at,
      createdAt: row.created_at,
    };
  }

  private requireComputerAgentBinding(computerId: string, agentId: string): {
    workspace_id: string;
    binding_revision: number;
  } {
    const row = this.workspaceDatabase.raw.prepare(
      `SELECT workspace_id, binding_revision FROM agent_runtime_bindings
       WHERE computer_id = ? AND agent_id = ? AND status = 'active'`,
    ).get(computerId, agentId) as { workspace_id: string; binding_revision: number } | undefined;
    invariant(row, 'RUNTIME_BINDING_UNAVAILABLE', 'Computer does not hold this Agent Runtime Binding.', 403);
    return row;
  }

  private inboxTarget(conversationId: string, threadId: string | null): string {
    return threadId === null
      ? `conversation:${conversationId}`
      : `conversation:${conversationId}:thread:${threadId}`;
  }

  private isFrozenDmInboxWindow(
    workspaceId: string,
    agentId: string,
    receipt: AgentInboxClaimReceiptRow,
  ): boolean {
    if (!receipt.conversation_id || !receipt.agent_request_id) return false;
    const conversation = this.workspaceDatabase.raw.prepare(
      'SELECT conversation_kind FROM conversations WHERE workspace_id = ? AND id = ?',
    ).get(workspaceId, receipt.conversation_id) as { conversation_kind: ConversationKind } | undefined;
    if (conversation?.conversation_kind !== 'dm') return false;
    const row = this.workspaceDatabase.raw.prepare(
      `SELECT COUNT(*) AS count
       FROM agent_inbox_items item
       JOIN agent_inbox_claim_receipts claim
         ON claim.workspace_id = item.workspace_id AND claim.receipt = item.claim_receipt
       WHERE item.workspace_id = ? AND item.agent_id = ?
         AND item.attention_kind = 'direct_message' AND claim.agent_request_id = ?`,
    ).get(workspaceId, agentId, receipt.agent_request_id) as { count: number };
    return row.count >= 10;
  }

  private parseInboxTarget(
    _workspaceId: string,
    target: string,
  ): { kind: 'discussion'; conversationId: string; threadId: string | null } {
    const match = /^conversation:([^:]+)(?::thread:([^:]+))?$/u.exec(target);
    invariant(match?.[1], 'INVALID_INBOX_TARGET', 'Inbox target is invalid.', 400);
    return { kind: 'discussion', conversationId: match[1], threadId: match[2] ?? null };
  }

  private requireActiveInboxReceipt(
    binding: { workspace_id: string; binding_revision: number },
    agentId: string,
    receipt: string,
    target: string,
  ): AgentInboxClaimReceiptRow {
    const row = this.workspaceDatabase.raw.prepare(
      `SELECT * FROM agent_inbox_claim_receipts
       WHERE workspace_id = ? AND agent_id = ? AND receipt = ?
         AND binding_revision = ? AND target = ? AND handled_at IS NULL`,
    ).get(binding.workspace_id, agentId, receipt, binding.binding_revision, target) as
      | AgentInboxClaimReceiptRow
      | undefined;
    invariant(row, 'INBOX_RECEIPT_NOT_CLAIMED', 'Inbox receipt is unavailable or fenced.', 409);
    return row;
  }

  private completeInboxReceipt(workspaceId: string, agentId: string, receipt: string, timestamp: number): void {
    this.workspaceDatabase.raw.prepare(
      `UPDATE agent_inbox_items SET state = 'handled', handled_at = ?
       WHERE workspace_id = ? AND agent_id = ? AND claim_receipt = ? AND state = 'claimed'`,
    ).run(timestamp, workspaceId, agentId, receipt);
    this.workspaceDatabase.raw.prepare(
      `UPDATE agent_inbox_claim_receipts SET handled_at = ?, updated_at = ?
       WHERE workspace_id = ? AND agent_id = ? AND receipt = ? AND handled_at IS NULL`,
    ).run(timestamp, timestamp, workspaceId, agentId, receipt);
  }

  private fenceAgentInboxBinding(workspaceId: string, agentId: string, timestamp: number): void {
    this.workspaceDatabase.raw.prepare(
      `UPDATE agent_inbox_items
       SET state = 'pending', claim_receipt = NULL, claimed_at = NULL, handled_at = NULL
       WHERE workspace_id = ? AND agent_id = ? AND state = 'claimed'`,
    ).run(workspaceId, agentId);
    this.workspaceDatabase.raw.prepare(
      `UPDATE agent_inbox_claim_receipts SET handled_at = ?, updated_at = ?
       WHERE workspace_id = ? AND agent_id = ? AND handled_at IS NULL`,
    ).run(timestamp, timestamp, workspaceId, agentId);
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
    input:
      | { kind: 'dm'; title?: string; directWorkspaceMembershipIds?: string[]; visibility?: 'private' }
      | {
          kind: 'channel';
          title?: string;
          visibility: ConversationVisibility;
          participantWorkspaceMembershipIds?: string[];
        },
    idempotencyKey: string,
  ): ConversationView {
    return this.idempotent(workspaceId, principal.actorId, 'CreateConversation', idempotencyKey, input, () => {
      const creator = this.requireMembership(workspaceId, principal.actorId);
      invariant(
        input.kind === 'dm',
        'WORKSPACE_CHANNEL_CREATION_DISABLED',
        'A Workspace has exactly one system-created general group.',
        409,
      );
      invariant(
        input.visibility === undefined || input.visibility === 'private',
        'DM_MUST_BE_PRIVATE',
        'A DM must be private.',
      );
      const participantWorkspaceMembershipIds = [...new Set([creator.id, ...(input.directWorkspaceMembershipIds ?? [])])];
      for (const workspaceMembershipId of participantWorkspaceMembershipIds) {
        const participant = this.requireActiveWorkspaceMember(workspaceId, workspaceMembershipId);
        if (participant.actorType === 'agent') {
          const agent = this.requireAgentIdentityRow(workspaceId, participant.actorId);
          invariant(
            agent.owner_membership_id === creator.id
            || this.hasSharedProjectParticipation(workspaceId, creator.id, participant.membershipId),
            'AGENT_DIRECT_MESSAGE_APPROVAL_REQUIRED',
            'A Human may start an Agent DM only after sharing a Project with that Agent or when they own it.',
            403,
          );
        }
      }
      return this.insertConversation(
        principal,
        workspaceId,
        null,
        creator,
        null,
        'dm',
        input.title,
        'private',
        participantWorkspaceMembershipIds,
      );
    });
  }

  createProjectConversation(
    principal: HumanPrincipal,
    projectId: string,
    input: {
      kind: 'channel';
      title?: string;
      visibility?: ConversationVisibility;
      participantProjectMembershipIds?: string[];
    },
    idempotencyKey: string,
  ): ConversationView {
    const project = this.requireProject(projectId);
    return this.idempotent(project.workspace_id, principal.actorId, 'CreateProjectConversation', idempotencyKey, input, () => {
      const access = this.requireProjectAccess(principal.actorId, projectId);
      invariant(
        input.visibility === undefined || input.visibility === 'private',
        'PROJECT_MAIN_GROUP_ALREADY_EXISTS',
        'A Project has one system-created main group; additional groups use an explicit audience.',
        409,
      );
      const participantProjectMembershipIds = [...new Set([
        access.projectMembership.id,
        ...(input.participantProjectMembershipIds ?? []),
      ])];
      for (const projectMembershipId of participantProjectMembershipIds) {
        const participant = this.requireProjectMembership(project.workspace_id, projectId, projectMembershipId);
        const workspaceMember = this.requireActiveWorkspaceMember(project.workspace_id, participant.workspace_membership_id);
        if (workspaceMember.actorType === 'agent') {
          this.requireAgentOwner(project.workspace_id, workspaceMember.actorId, principal.actorId);
        }
      }
      return this.insertConversation(
        principal,
        project.workspace_id,
        projectId,
        access.workspaceMembership,
        access.projectMembership,
        input.kind,
        input.title,
        'private',
        participantProjectMembershipIds,
      );
    });
  }

  getConversation(principal: HumanPrincipal, conversationId: string): ConversationView {
    const access = this.requireConversationViewAccess(principal.actorId, conversationId);
    return this.mapConversation(access.conversation, access.accessMode);
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
        `SELECT c.*,
                'content' AS access_mode
         FROM conversations c
         WHERE c.workspace_id = ? AND c.project_id IS NULL AND c.lifecycle_status = ?
           AND (
             c.scope_type = 'workspace_general'
             OR EXISTS (
               SELECT 1 FROM conversation_memberships audience
               WHERE audience.workspace_id = c.workspace_id
                 AND audience.conversation_id = c.id
                 AND audience.workspace_membership_id = ?
             )
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
    const items = rows.slice(0, pageLimit).map((row) => this.mapConversation(
      row,
      (row as ConversationAccess['conversation'] & { access_mode: ConversationAccessMode }).access_mode,
    ));
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
        `SELECT c.*,
                CASE WHEN c.membership_mode = 'explicit' AND NOT EXISTS (
                  SELECT 1 FROM conversation_memberships audience
                  WHERE audience.workspace_id = c.workspace_id
                    AND audience.conversation_id = c.id
                    AND audience.project_membership_id = ?
                ) THEN 'governance' ELSE 'content' END AS access_mode
         FROM conversations c
         WHERE c.workspace_id = ? AND c.project_id = ? AND c.conversation_kind = 'channel'
           AND c.lifecycle_status = ?
           AND (
             c.membership_mode = 'project_all'
             OR EXISTS (
               SELECT 1 FROM conversation_memberships audience
               WHERE audience.workspace_id = c.workspace_id
                 AND audience.conversation_id = c.id
                 AND audience.project_membership_id = ?
             )
             OR ? IN ('owner', 'manager')
           )
           AND (? IS NULL OR c.updated_at < ? OR (c.updated_at = ? AND c.id < ?))
         ORDER BY c.updated_at DESC, c.id DESC LIMIT ?`,
      )
      .all(
        access.projectMembership.id,
        access.project.workspace_id,
        projectId,
        lifecycleStatus,
        access.projectMembership.id,
        access.projectMembership.project_role,
        pageCursor?.createdAt ?? null,
        pageCursor?.createdAt ?? 0,
        pageCursor?.createdAt ?? 0,
        pageCursor?.id ?? '',
        pageLimit + 1,
      ) as unknown as Array<ConversationAccess['conversation']>;
    const hasMore = rows.length > pageLimit;
    const items = rows.slice(0, pageLimit).map((row) => this.mapConversation(
      row,
      (row as ConversationAccess['conversation'] & { access_mode: ConversationAccessMode }).access_mode,
    ));
    const last = items.at(-1);
    return { items, nextCursor: hasMore && last ? encodePageCursor(last.updatedAt, last.id) : null };
  }

  postMessage(
    principal: HumanPrincipal,
    conversationId: string,
    input: {
      body: string;
      mentionedActorIds?: string[];
      artifactSelections?: Array<{ artifactId: string; artifactVersionId: string }>;
      workItemIds?: string[];
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
    const workItemIds = this.normalizeMessageWorkItemIds(access, input.workItemIds);
    const result = this.idempotent(
      access.conversation.workspace_id,
      principal.actorId,
      'PostMessage',
      idempotencyKey,
      { body: normalizedBody, mentionedActorIds: mentions.map((mention) => mention.actor_id), artifactSelections, workItemIds },
      () => {
        const currentAccess = this.requireConversationAccess(principal.actorId, conversationId);
        this.requireConversationWritable(currentAccess.conversation);
        return {
          messageId: this.publishHumanMessage(
            currentAccess,
            normalizedBody,
            null,
            null,
            mentions,
            artifactSelections,
            workItemIds,
            nowMs(),
          ),
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
    messageId: string,
    input: {
      body: string;
      mentionedActorIds?: string[];
      artifactSelections?: Array<{ artifactId: string; artifactVersionId: string }>;
      workItemIds?: string[];
    },
    idempotencyKey: string,
  ): MessageView {
    const normalizedBody = input.body.trim();
    invariant(normalizedBody.length > 0, 'INVALID_MESSAGE', 'Message body is required.');
    const targetMessage = this.requireMessage(messageId);
    const access = this.requireConversationAccess(principal.actorId, targetMessage.conversation_id);
    const mentionTargets = this.addImplicitReplyAuthorTarget(
      access,
      targetMessage.author_actor_id,
      this.addImplicitDirectAgentTarget(access, this.normalizeMentionTargets(input.mentionedActorIds)),
    );
    const mentions = this.resolveMessageMentions(
      access,
      this.normalizeMentionTargets(mentionTargets),
    );
    const artifactSelections = input.artifactSelections ?? [];
    const workItemIds = this.normalizeMessageWorkItemIds(access, input.workItemIds);
    const result = this.idempotent(
      access.conversation.workspace_id,
      principal.actorId,
      'ReplyToMessage',
      idempotencyKey,
      { replyToMessageId: messageId, body: normalizedBody, mentionedActorIds: mentions.map((mention) => mention.actor_id), artifactSelections, workItemIds },
      () => {
        const currentTarget = this.requireMessage(messageId);
        const currentAccess = this.requireConversationAccess(principal.actorId, currentTarget.conversation_id);
        this.requireConversationWritable(currentAccess.conversation);
        const timestamp = nowMs();
        let threadId = currentTarget.thread_id;
        if (threadId === null) {
          const priorThread = this.workspaceDatabase.raw
            .prepare('SELECT id FROM threads WHERE workspace_id = ? AND conversation_id = ? AND root_message_id = ?')
            .get(currentTarget.workspace_id, currentTarget.conversation_id, messageId) as { id: string } | undefined;
          threadId = priorThread?.id ?? newId();
          if (!priorThread) {
            this.workspaceDatabase.raw
              .prepare('INSERT INTO threads (id, workspace_id, conversation_id, root_message_id, created_at) VALUES (?, ?, ?, ?, ?)')
              .run(threadId, currentTarget.workspace_id, currentTarget.conversation_id, messageId, timestamp);
          }
        }
        return {
          messageId: this.publishHumanMessage(
            currentAccess,
            normalizedBody,
            threadId,
            messageId,
            mentions,
            artifactSelections,
            workItemIds,
            timestamp,
          ),
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
    const access = this.requireConversationViewAccess(principal.actorId, conversationId);
    const rows = (access.conversation.membership_mode === 'explicit'
      ? this.workspaceDatabase.raw.prepare(
        `SELECT audience.scope_membership_id,
                membership.id AS membership_id, audience.project_membership_id,
                membership.actor_id, actor.actor_type,
                COALESCE(human.display_name, agent.name) AS display_name,
                audience.joined_at
         FROM conversation_memberships audience
         JOIN workspace_memberships membership
           ON membership.workspace_id = audience.workspace_id
          AND membership.id = audience.workspace_membership_id
          AND membership.status = 'active'
         LEFT JOIN project_memberships project_membership
           ON project_membership.workspace_id = audience.workspace_id
          AND project_membership.project_id = audience.project_id
          AND project_membership.id = audience.project_membership_id
          AND project_membership.status = 'active'
         JOIN actors actor ON actor.id = membership.actor_id
         LEFT JOIN humans human ON human.actor_id = membership.actor_id
         LEFT JOIN agents agent
           ON agent.workspace_id = membership.workspace_id AND agent.actor_id = membership.actor_id
         WHERE audience.workspace_id = ? AND audience.conversation_id = ?
           AND (audience.project_id IS NULL OR project_membership.id IS NOT NULL)
         ORDER BY audience.joined_at, audience.scope_membership_id`,
      ).all(access.conversation.workspace_id, conversationId)
      : access.conversation.project_id === null
        ? this.workspaceDatabase.raw.prepare(
          `SELECT membership.id AS scope_membership_id,
                  membership.id AS membership_id, NULL AS project_membership_id,
                  membership.actor_id, actor.actor_type,
                  COALESCE(human.display_name, agent.name) AS display_name,
                  membership.joined_at
           FROM workspace_memberships membership
           JOIN actors actor ON actor.id = membership.actor_id
           LEFT JOIN humans human ON human.actor_id = membership.actor_id
           LEFT JOIN agents agent
             ON agent.workspace_id = membership.workspace_id AND agent.actor_id = membership.actor_id
           WHERE membership.workspace_id = ? AND membership.status = 'active'
             AND actor.actor_type = 'human'
           UNION ALL
           SELECT audience.scope_membership_id,
                  membership.id AS membership_id, NULL AS project_membership_id,
                  membership.actor_id, actor.actor_type,
                  agent.name AS display_name,
                  audience.joined_at
           FROM conversation_memberships audience
           JOIN workspace_memberships membership
             ON membership.workspace_id = audience.workspace_id
            AND membership.id = audience.workspace_membership_id
            AND membership.status = 'active'
           JOIN actors actor ON actor.id = membership.actor_id AND actor.actor_type = 'agent'
           JOIN agents agent
             ON agent.workspace_id = membership.workspace_id AND agent.actor_id = membership.actor_id
           WHERE audience.workspace_id = ? AND audience.conversation_id = ?
           ORDER BY 7, 1`,
        ).all(access.conversation.workspace_id, access.conversation.workspace_id, conversationId)
        : this.workspaceDatabase.raw.prepare(
          `SELECT project_membership.id AS scope_membership_id,
                  membership.id AS membership_id,
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
             AND actor.actor_type = 'human'
           UNION ALL
           SELECT audience.scope_membership_id,
                  membership.id AS membership_id,
                  project_membership.id AS project_membership_id,
                  membership.actor_id, actor.actor_type,
                  agent.name AS display_name,
                  audience.joined_at
           FROM conversation_memberships audience
           JOIN project_memberships project_membership
             ON project_membership.workspace_id = audience.workspace_id
            AND project_membership.project_id = audience.project_id
            AND project_membership.id = audience.project_membership_id
            AND project_membership.status = 'active'
           JOIN workspace_memberships membership
             ON membership.workspace_id = project_membership.workspace_id
            AND membership.id = project_membership.workspace_membership_id
            AND membership.status = 'active'
           JOIN actors actor ON actor.id = membership.actor_id AND actor.actor_type = 'agent'
           JOIN agents agent
             ON agent.workspace_id = membership.workspace_id AND agent.actor_id = membership.actor_id
           WHERE audience.workspace_id = ? AND audience.conversation_id = ?
           ORDER BY 7, 1`,
        ).all(
          access.conversation.workspace_id,
          access.conversation.project_id,
          access.conversation.workspace_id,
          conversationId,
        )) as unknown as ConversationParticipantRow[];
    return rows.map((row) => ({
      scopeMembershipId: row.scope_membership_id,
      workspaceMembershipId: row.membership_id,
      projectMembershipId: row.project_membership_id,
      actorId: row.actor_id,
      actorType: row.actor_type,
      displayName: row.display_name,
      joinedAt: row.joined_at,
    }));
  }

  addConversationParticipant(
    principal: HumanPrincipal,
    conversationId: string,
    scopeMembershipId: string,
    expectedRevision: number,
    idempotencyKey: string,
  ): ConversationParticipantView {
    const existing = this.requireConversationViewAccess(principal.actorId, conversationId);
    return this.idempotent(
      existing.conversation.workspace_id,
      principal.actorId,
      'AddConversationParticipant',
      idempotencyKey,
      { conversationId, scopeMembershipId, expectedRevision },
      () => {
        const access = this.requireConversationAudienceAuthority(principal.actorId, conversationId);
        const participant = this.resolveConversationScopeMembership(access.conversation, scopeMembershipId);
        this.requireConversationParticipantAdditionAuthority(access, participant, principal.actorId);
        invariant(
          access.conversation.revision === expectedRevision,
          'CONVERSATION_REVISION_CONFLICT',
          'Conversation revision changed.',
          409,
        );
        const duplicate = this.workspaceDatabase.raw.prepare(
          `SELECT 1 FROM conversation_memberships
           WHERE workspace_id = ? AND conversation_id = ? AND scope_membership_id = ?`,
        ).get(access.conversation.workspace_id, conversationId, scopeMembershipId);
        invariant(!duplicate, 'CONVERSATION_PARTICIPANT_EXISTS', 'The Membership is already in the private audience.', 409);
        const timestamp = nowMs();
        this.workspaceDatabase.raw.prepare(
          `INSERT INTO conversation_memberships (
             id, workspace_id, conversation_id, project_id, scope_membership_id,
             workspace_membership_id, project_membership_id, joined_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          newId(), access.conversation.workspace_id, conversationId, access.conversation.project_id,
          scopeMembershipId, participant.workspaceMembershipId, participant.projectMembershipId, timestamp,
        );
        const updated = this.advanceConversationAudienceRevision(
          access.conversation,
          expectedRevision,
          timestamp,
        );
        const projectVersion = access.conversation.project_id
          ? this.bumpProjectContext(access.conversation.project_id, timestamp)
          : null;
        this.appendChange(
          access.conversation.workspace_id,
          null,
          conversationId,
          updated.contextVersion,
          'conversation_participant_added',
          'conversation',
          conversationId,
          { scopeMembershipId, revision: updated.revision },
          timestamp,
          access.conversation.project_id
            ? { projectId: access.conversation.project_id, projectVersion: projectVersion! }
            : {},
        );
        this.appendAudit(
          access.conversation.workspace_id,
          principal.actorId,
          access.membership.id,
          'conversation.participant.add',
          'conversation_membership',
          scopeMembershipId,
          { conversationId, revision: updated.revision },
          timestamp,
        );
        const item = this.listConversationParticipants(principal, conversationId)
          .find((candidate) => candidate.scopeMembershipId === scopeMembershipId);
        invariant(item, 'CONVERSATION_PARTICIPANT_NOT_FOUND', 'Conversation participant is unavailable.', 404);
        return item;
      },
    );
  }

  removeConversationParticipant(
    principal: HumanPrincipal,
    conversationId: string,
    scopeMembershipId: string,
    expectedRevision: number,
    idempotencyKey: string,
  ): {
    scopeMembershipId: string;
    revision: number;
    contextVersion: number;
    removedAt: number;
    cancelledAgentRequestIds: string[];
    cancelledRunIds: string[];
  } {
    const existing = this.requireConversationViewAccess(principal.actorId, conversationId);
    const result = this.idempotent(
      existing.conversation.workspace_id,
      principal.actorId,
      'RemoveConversationParticipant',
      idempotencyKey,
      { conversationId, scopeMembershipId, expectedRevision },
      () => {
        const access = this.requireConversationAudienceAuthority(principal.actorId, conversationId);
        invariant(
          access.conversation.revision === expectedRevision,
          'CONVERSATION_REVISION_CONFLICT',
          'Conversation revision changed.',
          409,
        );
        const audience = this.workspaceDatabase.raw.prepare(
          `SELECT audience.workspace_membership_id, audience.project_membership_id, membership.actor_id
           FROM conversation_memberships audience
           JOIN workspace_memberships membership
             ON membership.workspace_id = audience.workspace_id
            AND membership.id = audience.workspace_membership_id
           WHERE audience.workspace_id = ? AND audience.conversation_id = ?
             AND audience.scope_membership_id = ?`,
        ).get(access.conversation.workspace_id, conversationId, scopeMembershipId) as {
          workspace_membership_id: string;
          project_membership_id: string | null;
          actor_id: string;
        } | undefined;
        invariant(audience, 'CONVERSATION_PARTICIPANT_NOT_FOUND', 'Conversation participant does not exist.', 404);
        this.requireConversationParticipantRemovalAuthority(
          access,
          audience.actor_id,
          audience.workspace_membership_id,
        );
        const timestamp = nowMs();
        const removed = this.workspaceDatabase.raw.prepare(
          `DELETE FROM conversation_memberships
           WHERE workspace_id = ? AND conversation_id = ? AND scope_membership_id = ?`,
        ).run(access.conversation.workspace_id, conversationId, scopeMembershipId);
        invariant(removed.changes === 1, 'CONVERSATION_REVISION_CONFLICT', 'Conversation audience changed concurrently.', 409);
        const updated = this.advanceConversationAudienceRevision(access.conversation, expectedRevision, timestamp);
        const cancelledAgentRequestIds = this.cancelRequestsAffectedByScopeMembershipRemoval(
          access.conversation.workspace_id,
          conversationId,
          audience.workspace_membership_id,
          audience.actor_id,
          timestamp,
        );
        const isolated = this.cancelRunsAffectedByConversationMembershipRemoval(
          access.conversation,
          audience.workspace_membership_id,
          audience.project_membership_id,
          timestamp,
        );
        this.fenceRemovedConversationAgentInbox(
          access.conversation.workspace_id,
          conversationId,
          audience.actor_id,
          timestamp,
        );
        const projectVersion = access.conversation.project_id
          ? this.bumpProjectContext(access.conversation.project_id, timestamp)
          : null;
        this.appendChange(
          access.conversation.workspace_id,
          null,
          conversationId,
          updated.contextVersion,
          'conversation_participant_removed',
          'conversation',
          conversationId,
          {
            scopeMembershipId,
            revision: updated.revision,
            cancelledAgentRequestIds,
            cancelledRunIds: isolated.runIds,
          },
          timestamp,
          access.conversation.project_id
            ? { projectId: access.conversation.project_id, projectVersion: projectVersion! }
            : {},
        );
        this.appendAudit(
          access.conversation.workspace_id,
          principal.actorId,
          access.membership.id,
          'conversation.participant.remove',
          'conversation_membership',
          scopeMembershipId,
          { conversationId, revision: updated.revision, cancelledRunIds: isolated.runIds },
          timestamp,
        );
        return {
          scopeMembershipId,
          revision: updated.revision,
          contextVersion: updated.contextVersion,
          removedAt: timestamp,
          cancelledAgentRequestIds,
          cancelledRunIds: isolated.runIds,
          cancelledAttemptIds: isolated.attemptIds,
        };
      },
    );
    for (const attemptId of result.cancelledAttemptIds) this.localExecutions.cancelIfPresent(attemptId);
    const { cancelledAttemptIds: _cancelledAttemptIds, ...view } = result;
    return view;
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
      const visibleRows = pageRows.filter((row) => (
        row.conversation_id === null
        || this.hasConversationAccess(workspaceId, String(row.conversation_id), membership.id)
      ));
      const items = visibleRows.map((row) => this.mapChange(row));
      if (hasMore) {
        return { items, nextCursor: Number(pageRows.at(-1)?.position ?? after) };
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
             project_id, project_context_version, conversation_id,
             conversation_context_version, change_cursor, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          runSnapshotId, request.workspace_id, runId, 'Handle pending Agent Inbox messages.', sourceMessage.id,
          this.requireMentionOutcomeId(request.id), canonicalJson(scope), canonicalJson(scope),
          canonicalJson(triggerFrontier), membership.id, policy.id, canonicalJson(budget),
          Number(this.requireWorkspaceVersion(request.workspace_id)), projectId, project?.context_version ?? null,
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
          })),
          metadata: {
            name: project.name,
            description: project.description,
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
      executionScope: runContext.projectId === null
        ? { kind: 'workspace_scratch' }
        : { kind: 'project_scratch', projectId: runContext.projectId },
      runContext,
      developerInstructions: this.renderDeveloperInstructions(context.agent_id),
    };
  }

  getComputerAgentSessionInput(
    computerId: string,
    agentId: string,
    session?: { kind: AgentSessionKind; key: string },
  ): AgentSessionInputView {
    const binding = this.workspaceDatabase.raw.prepare(
      `SELECT binding.workspace_id, binding.runtime_id, binding.binding_revision,
              binding.requested_model, binding.requested_reasoning_effort, binding.requested_mode
       FROM agent_runtime_bindings binding
       JOIN agents agent
         ON agent.workspace_id = binding.workspace_id
        AND agent.actor_id = binding.agent_id
        AND agent.lifecycle_status = 'active'
       WHERE binding.computer_id = ? AND binding.agent_id = ? AND binding.status = 'active'`,
    ).get(computerId, agentId) as {
      workspace_id: string;
      runtime_id: RuntimeId;
      binding_revision: number;
      requested_model: string | null;
      requested_reasoning_effort: ReasoningEffort | null;
      requested_mode: string | null;
    } | undefined;
    invariant(binding, 'RUNTIME_BINDING_UNAVAILABLE', 'Computer does not hold this Agent Runtime Binding.', 403);
    const membership = this.requireMembership(binding.workspace_id, agentId);
    const resolvedSession = session ?? (() => {
      const row = this.workspaceDatabase.raw.prepare(
        `SELECT agent_request_id FROM agent_inbox_items
         WHERE workspace_id = ? AND agent_id = ? AND state IN ('pending', 'claimed')
           AND agent_request_id IS NOT NULL ORDER BY sequence LIMIT 1`,
      ).get(binding.workspace_id, agentId) as { agent_request_id: string } | undefined;
      return { kind: 'mention' as const, key: row?.agent_request_id ?? 'unbound-session' };
    })();
    const workspace = this.workspaceDatabase.raw.prepare(
      'SELECT id, name, revision, context_version FROM workspaces WHERE id = ?',
    ).get(binding.workspace_id) as { id: string; name: string; revision: number; context_version: number } | undefined;
    invariant(workspace, 'WORKSPACE_NOT_FOUND', 'Workspace does not exist.', 404);
    let projectId: string | null = null;
    let target: string | null = null;
    let initialDiscussionFrontier: number | null = null;
    let discussion: AgentDiscussionBindingView | null = null;
    let referencedWorkItemIds: string[] = [];
    let sessionWindow: AgentSessionWindowView = {
      mode: 'isolated',
      acceptedMessages: 1,
      maxMessages: 10,
      status: 'accepting',
    };
    const lines: unknown[] = [{
      type: 'session',
      session: resolvedSession,
      workspaceId: binding.workspace_id,
      agentId,
      generatedAt: 0,
    }];
    lines.push({
      type: 'workspace',
      id: workspace.id,
      name: workspace.name,
      revision: workspace.revision,
      contextVersion: workspace.context_version,
    });
    const appendWorkItemMentions = (references: MessageWorkItemReferenceView[]) => {
      for (const reference of references) {
        if (referencedWorkItemIds.includes(reference.workItemId)) continue;
        referencedWorkItemIds.push(reference.workItemId);
        lines.push({
          type: 'work_item_mention',
          workItemId: reference.workItemId,
          taskNumber: reference.taskNumber,
          instruction: `use teamctl work-item read ${reference.workItemId} to inspect its current state and artifacts`,
        });
      }
    };
    if (resolvedSession.kind === 'mention') {
      const request = this.requireAgentRequest(resolvedSession.key);
      invariant(request.workspace_id === binding.workspace_id && request.target_agent_id === agentId,
        'AGENT_REQUEST_SCOPE_MISMATCH', 'Mention Session does not belong to this Agent.', 409);
      const source = this.requireMessage(request.source_message_id);
      projectId = source.project_id;
      target = this.inboxTarget(source.conversation_id, source.thread_id);
      initialDiscussionFrontier = source.scope_position;
      invariant(this.hasConversationAccess(binding.workspace_id, source.conversation_id, membership.id),
        'CONVERSATION_NOT_FOUND', 'Conversation is not accessible to this Agent.', 404);
      const conversation = this.workspaceDatabase.raw.prepare(
        'SELECT id, project_id, scope_type, conversation_kind, title, context_version, timeline_frontier FROM conversations WHERE workspace_id = ? AND id = ?',
      ).get(binding.workspace_id, source.conversation_id) as (Record<string, unknown> & { conversation_kind: ConversationKind }) | undefined;
      if (conversation) lines.push({ type: 'conversation', ...conversation, threadId: source.thread_id });
      sessionWindow = {
        mode: conversation?.conversation_kind === 'dm' ? 'dm' : 'isolated',
        acceptedMessages: 1,
        maxMessages: 10,
        status: 'accepting',
      };
      if (sessionWindow.mode === 'dm') {
        const accepted = Number((this.workspaceDatabase.raw.prepare(
          `SELECT COUNT(*) AS count
           FROM agent_inbox_items item
           JOIN agent_inbox_claim_receipts receipt
             ON receipt.workspace_id = item.workspace_id AND receipt.receipt = item.claim_receipt
           WHERE item.workspace_id = ? AND item.agent_id = ?
             AND item.attention_kind = 'direct_message' AND receipt.agent_request_id = ?`,
        ).get(binding.workspace_id, agentId, request.id) as { count: number }).count);
        const latestReceipt = this.workspaceDatabase.raw.prepare(
          `SELECT handled_at FROM agent_inbox_claim_receipts
           WHERE workspace_id = ? AND agent_id = ? AND agent_request_id = ?
           ORDER BY created_at DESC LIMIT 1`,
        ).get(binding.workspace_id, agentId, request.id) as { handled_at: number | null } | undefined;
        sessionWindow = {
          mode: 'dm',
          acceptedMessages: accepted === 0 ? 1 : Math.min(accepted, 10),
          maxMessages: 10,
          status: latestReceipt?.handled_at !== null && latestReceipt !== undefined
            ? 'completed'
            : accepted >= 10 ? 'frozen' : 'accepting',
        };
      }
      discussion = {
        target: this.inboxTarget(source.conversation_id, source.thread_id),
        agentRequestId: request.id,
        initialDiscussionFrontier: source.scope_position,
        sessionWindow,
      };
      if (projectId) {
        const project = this.requireProject(projectId);
        lines.push({ type: 'project', id: project.id, workspaceId: project.workspace_id, name: project.name, description: project.description, revision: project.revision, contextVersion: project.context_version });
      }
      const history = this.workspaceDatabase.raw.prepare(
        `SELECT * FROM messages
         WHERE workspace_id = ? AND conversation_id = ? AND thread_id IS ? AND scope_position <= ?
         ORDER BY scope_position DESC, id DESC LIMIT 200`,
      ).all(binding.workspace_id, source.conversation_id, source.thread_id, source.scope_position)
        .reverse() as unknown as MessageRow[];
      if (source.thread_id !== null) {
        const root = this.workspaceDatabase.raw.prepare(
          `SELECT message.* FROM threads thread
           JOIN messages message ON message.workspace_id = thread.workspace_id AND message.id = thread.root_message_id
           WHERE thread.workspace_id = ? AND thread.conversation_id = ? AND thread.id = ?`,
        ).get(binding.workspace_id, source.conversation_id, source.thread_id) as MessageRow | undefined;
        if (root && !history.some((row) => row.id === root.id)) {
          lines.push({ type: 'thread_root', message: this.hydrateAgentContextMessage(root, membership) });
        }
      }
      if (history.length === 200) lines.push({ type: 'conversation_history_truncated', omittedBefore: history[0]?.scope_position ?? 0 });
      lines.push(...history.map((row) => ({ type: 'message', message: this.hydrateAgentContextMessage(row, membership) })));
      const sourceView = this.hydrateMessage(source, membership);
      appendWorkItemMentions(sourceView.workItemReferences);
      lines.push({ type: 'trigger', agentRequestId: request.id, messageId: source.id, scopePosition: source.scope_position });
    } else {
      const workItem = this.requireWorkItem(resolvedSession.key);
      invariant(workItem.workspace_id === binding.workspace_id
        && this.findProjectMembership(binding.workspace_id, workItem.project_id, membership.id),
      'WORK_ITEM_NOT_FOUND', 'WorkItem does not exist or is not accessible to this Agent.', 404);
      projectId = workItem.project_id;
      target = `work-item:${workItem.id}`;
      sessionWindow = {
        mode: 'isolated',
        acceptedMessages: 0,
        maxMessages: 10,
        status: 'accepting',
      };
      const project = this.requireProject(projectId);
      lines.push({ type: 'project', id: project.id, workspaceId: project.workspace_id, name: project.name, description: project.description, revision: project.revision, contextVersion: project.context_version });
      const workItemView = this.mapWorkItem(workItem);
      lines.push({ type: 'work_item', workItem: workItemView });
      referencedWorkItemIds = [workItem.id];
      lines.push({
        type: 'work_item_mention',
        workItemId: workItem.id,
        taskNumber: workItem.task_number,
        instruction: `use teamctl work-item read ${workItem.id} to inspect its current state and artifacts`,
      });
      for (const reference of workItemView.relatedWorkItemReferences) {
        lines.push({
          type: 'work_item_relation',
          workItemId: workItem.id,
          relatedWorkItemId: reference.workItemId,
          relatedTaskNumber: reference.taskNumber,
          relation: 'created_from_message_reference',
          instruction: `WorkItem #${workItem.task_number} was created from a message referencing WorkItem #${reference.taskNumber}; use teamctl work-item read ${reference.workItemId} to inspect that related task.`,
        });
      }
      if (workItem.source_conversation_id !== null
        && workItem.source_message_id !== null
        && this.hasConversationAccess(binding.workspace_id, workItem.source_conversation_id, membership.id)) {
        const sourceMessage = this.workspaceDatabase.raw.prepare(
          `SELECT * FROM messages
           WHERE workspace_id = ? AND conversation_id = ? AND id = ?`,
        ).get(binding.workspace_id, workItem.source_conversation_id, workItem.source_message_id) as MessageRow | undefined;
        if (sourceMessage) {
          const sourceMessageView = this.hydrateMessage(sourceMessage, membership);
          lines.push({ type: 'work_item_source_message', message: this.hydrateAgentContextMessage(sourceMessage, membership) });
          appendWorkItemMentions(sourceMessageView.workItemReferences);
          const sourceRequest = this.workspaceDatabase.raw.prepare(
            `SELECT request.id, inbox.state
             FROM agent_requests request
             JOIN agent_mention_outcomes outcome
               ON outcome.workspace_id = request.workspace_id
              AND outcome.id = request.mention_outcome_id
             JOIN agent_inbox_items inbox
               ON inbox.workspace_id = request.workspace_id
              AND inbox.agent_request_id = request.id
              AND inbox.agent_id = request.target_agent_id
             WHERE request.workspace_id = ? AND request.target_agent_id = ?
               AND outcome.message_id = ? AND request.status IN ('pending', 'accepted')
               AND inbox.state IN ('pending', 'claimed')
             ORDER BY request.created_at, request.id
             LIMIT 1`,
          ).get(binding.workspace_id, agentId, sourceMessage.id) as { id: string; state: 'pending' | 'claimed' } | undefined;
          if (sourceRequest) {
            const sourceConversation = this.workspaceDatabase.raw.prepare(
              'SELECT id, project_id, scope_type, conversation_kind, title, context_version, timeline_frontier FROM conversations WHERE workspace_id = ? AND id = ?',
            ).get(binding.workspace_id, sourceMessage.conversation_id) as (Record<string, unknown> & { conversation_kind: ConversationKind }) | undefined;
            if (sourceConversation) lines.push({ type: 'conversation', ...sourceConversation, threadId: sourceMessage.thread_id });
            const sourceHistory = this.workspaceDatabase.raw.prepare(
              `SELECT * FROM messages
               WHERE workspace_id = ? AND conversation_id = ? AND thread_id IS ? AND scope_position <= ?
               ORDER BY scope_position DESC, id DESC LIMIT 200`,
            ).all(binding.workspace_id, sourceMessage.conversation_id, sourceMessage.thread_id, sourceMessage.scope_position)
              .reverse() as unknown as MessageRow[];
            if (sourceHistory.length === 200) lines.push({ type: 'conversation_history_truncated', omittedBefore: sourceHistory[0]?.scope_position ?? 0 });
            lines.push(...sourceHistory.map((row) => ({ type: 'message', message: this.hydrateAgentContextMessage(row, membership) })));
            discussion = {
              target: this.inboxTarget(sourceMessage.conversation_id, sourceMessage.thread_id),
              agentRequestId: sourceRequest.id,
              initialDiscussionFrontier: sourceMessage.scope_position,
              sessionWindow: {
                mode: sourceConversation?.conversation_kind === 'dm' ? 'dm' : 'isolated',
                acceptedMessages: 1,
                maxMessages: 10,
                status: 'accepting',
              },
            };
          }
        }
      }
      const comments = this.workspaceDatabase.raw.prepare(
        `SELECT * FROM work_item_comments WHERE workspace_id = ? AND work_item_id = ? ORDER BY comment_position, id`,
      ).all(workItem.workspace_id, workItem.id) as unknown as WorkItemCommentRow[];
      for (const row of comments) {
        const comment = this.mapWorkItemComment(row);
        lines.push({ type: 'work_item_comment', comment });
        for (const reference of comment.workItemReferences) {
          if (!referencedWorkItemIds.includes(reference.workItemId)) {
            referencedWorkItemIds.push(reference.workItemId);
            lines.push({
              type: 'work_item_mention',
              workItemId: reference.workItemId,
              taskNumber: reference.taskNumber,
              instruction: `use teamctl work-item read ${reference.workItemId} to inspect its current state and artifacts`,
            });
          }
        }
      }
    }
    const contextJsonl = lines.map((line) => JSON.stringify(line)).join('\n');
    return {
      workspaceId: binding.workspace_id,
      agentId,
      session: resolvedSession,
      target,
      projectId,
      contextHash: sha256(contextJsonl),
      contextJsonl,
      referencedWorkItemIds,
      initialDiscussionFrontier,
      discussion,
      sessionWindow,
      runtimeId: binding.runtime_id,
      runtimeBindingRevision: binding.binding_revision,
      runtimeConfiguration: {
        model: binding.requested_model,
        reasoningEffort: binding.requested_reasoning_effort,
        mode: binding.requested_mode,
      },
      developerInstructions: this.renderDeveloperInstructions(agentId),
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
    this.workspaceDatabase.raw.prepare(
      `INSERT INTO content_blobs (hash, byte_length, media_type, storage_path, created_at)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT(hash) DO NOTHING`,
    ).run(stored.hash, stored.byteLength, stored.mediaType, stored.storagePath, nowMs());
    const id = newId();
    const timestamp = nowMs();
    const expiresAt = timestamp + 24 * 60 * 60 * 1000;
    this.workspaceDatabase.raw.prepare(
      `INSERT INTO staged_blobs (
         id, workspace_id, run_id, attempt_id, blob_hash, media_type,
         byte_length, created_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, context.workspace_id, context.run_id, attemptId, stored.hash, stored.mediaType, stored.byteLength, timestamp, expiresAt);
    return {
      id,
      workspaceId: context.workspace_id,
      runId: context.run_id,
      attemptId,
      contentDigest: stored.hash,
      mediaType: stored.mediaType,
      byteLength: stored.byteLength,
      expiresAt,
    };
  }

  private publishStagedArtifactV2(context: ExecutionContextRow, publication: RuntimeReturnEnvelope['artifactPublications'][number]): import('./types.js').ArtifactV2View {
    invariant(context.project_id, 'PROJECT_REQUIRED', 'Artifact publication requires the Run to be bound to a Project.', 409);
    invariant(publication.stagedBlobId, 'STAGED_BLOB_REQUIRED', 'v2 Artifact publication requires a staged file blob.', 400);
    const staged = this.workspaceDatabase.raw.prepare(
      `SELECT sb.blob_hash, sb.media_type, sb.byte_length, sb.expires_at, cb.storage_path
       FROM staged_blobs sb JOIN content_blobs cb ON cb.hash = sb.blob_hash
       WHERE sb.workspace_id = ? AND sb.id = ? AND sb.run_id = ? AND sb.attempt_id = ? AND sb.expires_at > ?`,
    ).get(context.workspace_id, publication.stagedBlobId, context.run_id, context.attempt_id, nowMs()) as {
      blob_hash: string; media_type: string; byte_length: number; expires_at: number; storage_path: string;
    } | undefined;
    invariant(staged, 'STAGED_BLOB_NOT_FOUND', 'Staged blob is unavailable or expired.', 404);
    const agent = this.requireAgentRow(context.workspace_id, context.agent_id);
    const result = this.artifactV2.publishSync({
      kind: 'computer', computerId: '', ownerHumanId: agent.owner_human_id, agentId: context.agent_id,
    }, context.project_id, {
      ...(publication.artifactId ? { artifactId: publication.artifactId } : {}),
      fileName: publication.fileName ?? publication.stagedBlobId,
      ...(publication.artifactName ? { artifactName: publication.artifactName } : {}),
      ...(publication.artifactPath ? { artifactPath: publication.artifactPath } : {}),
      ...(publication.expectedLatestVersionId ? { expectedLatestVersionId: publication.expectedLatestVersionId } : {}),
      ...(publication.parentVersionIds ? { parentVersionIds: publication.parentVersionIds } : {}),
      ...(publication.sourceResourceRefs ? { sourceResourceRefs: publication.sourceResourceRefs } : {}),
      ...(publication.taskId ? { taskId: publication.taskId } : {}), ...(publication.messageId ? { messageId: publication.messageId } : {}),
      ...(publication.publishBatchId ? { publishBatchId: publication.publishBatchId } : {}), ...(publication.note ? { note: publication.note } : {}),
    }, { hash: staged.blob_hash, storagePath: staged.storage_path, byteLength: staged.byte_length, mediaType: staged.media_type });
    this.workspaceDatabase.raw.prepare('DELETE FROM staged_blobs WHERE id = ?').run(publication.stagedBlobId);
    return result.artifact;
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
      const publishedArtifactsV2 = envelope.artifactPublications.map((publication) => this.publishStagedArtifactV2(current, publication));
      const publishedArtifacts = publishedArtifactsV2 as ArtifactV2View[];
      const publishedMessages = [
        ...directMessageRows.map((row) => this.hydrateMessage(
          row,
          this.requireMembership(current.workspace_id, current.agent_id),
        )),
        ...envelope.messages.map((draft, messageIndex) => {
        const artifactIds = envelope.artifactPublications.flatMap((publication, publicationIndex) => {
          const indexes = publication.attachToMessageIndexes ?? [];
          invariant(indexes.every((index) => Number.isSafeInteger(index) && index >= 0 && index < envelope.messages.length),
            'INVALID_ARTIFACT_MESSAGE_REFERENCE', 'Artifact publication references an invalid Message index.');
          const versionId = publishedArtifactsV2[publicationIndex]?.latestVersionId;
          return indexes.includes(messageIndex) && versionId ? [versionId] : [];
        });
        return this.publishAgentMessage(
          current,
          draft.body,
          artifactIds,
          draft.mentionedActorIds ?? [],
          draft.workItemIds ?? [],
          timestamp,
        );
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
          envelope.disposition, canonicalJson(publishedArtifactsV2.map((artifact) => ({
            artifactId: artifact.artifactId,
            artifactVersionId: artifact.latestVersionId,
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

  private hasSharedProjectParticipation(
    workspaceId: string,
    humanWorkspaceMembershipId: string,
    agentWorkspaceMembershipId: string,
  ): boolean {
    return Boolean(this.workspaceDatabase.raw.prepare(
      `SELECT 1
       FROM project_memberships human_project
       JOIN project_memberships agent_project
         ON agent_project.workspace_id = human_project.workspace_id
        AND agent_project.project_id = human_project.project_id
        AND agent_project.status = 'active'
       WHERE human_project.workspace_id = ?
         AND human_project.workspace_membership_id = ?
         AND human_project.status = 'active'
         AND agent_project.workspace_membership_id = ?
       LIMIT 1`,
    ).get(workspaceId, humanWorkspaceMembershipId, agentWorkspaceMembershipId));
  }

  private requireWorkspaceJoinLink(joinLinkId: string): WorkspaceJoinLinkRow {
    const row = this.workspaceDatabase.raw.prepare('SELECT * FROM workspace_join_links WHERE id = ?').get(joinLinkId) as
      | WorkspaceJoinLinkRow
      | undefined;
    invariant(row, 'WORKSPACE_JOIN_LINK_NOT_FOUND', 'Workspace join link does not exist.', 404);
    return row;
  }

  private requireWorkspaceJoinLinkByToken(token: string): WorkspaceJoinLinkRow {
    const row = this.workspaceDatabase.raw
      .prepare('SELECT * FROM workspace_join_links WHERE token_hash = ?')
      .get(sha256(token)) as WorkspaceJoinLinkRow | undefined;
    invariant(row, 'WORKSPACE_JOIN_LINK_NOT_FOUND', 'Workspace join link does not exist.', 404);
    return row;
  }

  private mapWorkspaceJoinLink(row: WorkspaceJoinLinkRow): WorkspaceJoinLinkView {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      token: row.status === 'active' ? this.decryptWorkspaceJoinLinkToken(row) : null,
      status: row.status,
      revision: row.revision,
      createdByMembershipId: row.created_by_membership_id,
      useCount: row.use_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastUsedAt: row.last_used_at,
      revokedAt: row.revoked_at,
    };
  }

  private decryptWorkspaceJoinLinkToken(row: WorkspaceJoinLinkRow): string {
    if (!row.token_ciphertext) {
      throw new Error(`Active Workspace join-link ${row.id} has no encrypted token.`);
    }
    let token: string;
    try {
      token = this.workspaceJoinLinkTokenCipher.decrypt(row.token_ciphertext, row.workspace_id, row.id);
    } catch (error) {
      throw new Error(`Workspace join-link ${row.id} token cannot be decrypted with the configured key.`, { cause: error });
    }
    if (sha256(token) !== row.token_hash) {
      throw new Error(`Workspace join-link ${row.id} encrypted token does not match its digest.`);
    }
    return token;
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
    const projectMemberships = this.workspaceDatabase.raw
      .prepare(
        `SELECT pm.*
         FROM project_memberships pm
         WHERE pm.workspace_id = ? AND pm.workspace_membership_id = ? AND pm.status = 'active'
         ORDER BY pm.joined_at, pm.id`,
      )
      .all(workspaceId, membershipId) as unknown as ProjectMembershipRow[];
    invariant(
      projectMemberships.every((membership) => membership.project_role !== 'owner'),
      'PROJECT_OWNER_TRANSFER_REQUIRED',
      'Transfer every owned Project before leaving or removing this Workspace Membership.',
      409,
      { projectIds: projectMemberships.filter((membership) => membership.project_role === 'owner').map((membership) => membership.project_id) },
    );
    const ownedAgents = this.workspaceDatabase.raw
      .prepare('SELECT actor_id FROM agents WHERE workspace_id = ? AND owner_membership_id = ? ORDER BY actor_id')
      .all(workspaceId, membershipId)
      .map((row) => String((row as { actor_id: string }).actor_id));
    for (const agentId of ownedAgents) {
      const agent = this.requireAgentIdentityRow(workspaceId, agentId);
      if (agent.membership_status !== 'active') continue;
      this.terminateAgentMembership(
        { kind: 'human', actorId },
        workspaceId,
        agentId,
        agent.revision,
        `auto-terminate-owner-leave:${membershipId}:${agentId}:${expectedRevision}`,
      );
    }
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
    invariant(
      target.project_role !== 'owner',
      'PROJECT_OWNER_TRANSFER_REQUIRED',
      'Transfer Project ownership before the Owner can leave or be removed.',
      409,
    );
    const timestamp = fixedTimestamp ?? nowMs();
    if (target.project_role === 'manager') {
      this.removeSponsoredProjectAgents(
        project,
        target.id,
        actorId,
        actorMembershipId,
        timestamp,
        'project.manager-removed.agent-remove',
      );
    }
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
    const assignedWorkItems = this.workspaceDatabase.raw.prepare(
      `SELECT * FROM work_items
       WHERE (workspace_id = ? AND project_id = ? AND assignee_project_membership_id = ?
          OR (workspace_id = ? AND project_id = ? AND EXISTS (
            SELECT 1 FROM work_item_assignees assigned
            WHERE assigned.workspace_id = work_items.workspace_id
              AND assigned.work_item_id = work_items.id
              AND assigned.project_membership_id = ?
          )))
         AND lifecycle_status IN ('open', 'blocked')
       ORDER BY created_at, id`,
    ).all(project.workspace_id, project.id, target.id, project.workspace_id, project.id, target.id) as unknown as WorkItemRow[];
    const releasedWorkItemIds: string[] = [];
    for (const workItem of assignedWorkItems) {
      const remainingIds = this.getWorkItemAssigneeIds(workItem).filter((id) => id !== target.id);
      const remaining = remainingIds.map((id) => this.getProjectMember(project.workspace_id, project.id, id));
      const primary = remaining[0] ?? null;
      const released = this.workspaceDatabase.raw.prepare(
        `UPDATE work_items
         SET assignee_membership_id = ?, assignee_project_membership_id = ?,
             current_submission_id = NULL, assignment_revision = assignment_revision + 1,
             revision = revision + 1, updated_at = ?
         WHERE id = ?
           AND lifecycle_status IN ('open', 'blocked')
         RETURNING revision, assignment_revision`,
      ).get(primary?.workspaceMembershipId ?? null, primary?.projectMembershipId ?? null, timestamp, workItem.id) as
        | { revision: number; assignment_revision: number }
        | undefined;
      if (!released) continue;
      this.replaceWorkItemAssignees(project.workspace_id, project.id, workItem.id, remaining, timestamp);
      releasedWorkItemIds.push(workItem.id);
      this.handleWorkItemAttentionAsHandled(project.workspace_id, workItem.id);
      this.recordWorkItemChange(workItem, 'work_item_unassigned', {
        reason: 'project_membership_removed',
        projectMembershipId: target.id,
        revision: released.revision,
        assignmentRevision: released.assignment_revision,
      }, timestamp);
      this.appendAudit(
        project.workspace_id,
        actorId,
        actorMembershipId,
        'work_item.unassign.project-member-removed',
        'work_item',
        workItem.id,
        {
          projectMembershipId: target.id,
          revision: released.revision,
          assignmentRevision: released.assignment_revision,
        },
        timestamp,
      );
    }
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
      this.fenceRemovedConversationAgentInbox(
        project.workspace_id,
        conversation.id,
        removedActor.actor_id,
        timestamp,
      );
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
        releasedWorkItemIds,
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
      { projectId: project.id, projectMembershipId: target.id, cancelledAgentRequestIds: cancelledIds, releasedWorkItemIds },
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
        releasedWorkItemIds,
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

  private removeSponsoredProjectAgents(
    project: ProjectRow,
    sponsorProjectMembershipId: string,
    actorId: string,
    actorMembershipId: string,
    timestamp: number,
    auditAction: string,
  ): string[] {
    const sponsored = this.workspaceDatabase.raw.prepare(
      `SELECT * FROM project_memberships
       WHERE workspace_id = ? AND project_id = ?
         AND sponsored_by_project_membership_id = ? AND status = 'active'
       ORDER BY joined_at, id`,
    ).all(project.workspace_id, project.id, sponsorProjectMembershipId) as unknown as ProjectMembershipRow[];
    for (const membership of sponsored) {
      this.removeProjectMembership(
        project,
        membership,
        membership.revision,
        actorId,
        actorMembershipId,
        auditAction,
        timestamp,
      );
    }
    return sponsored.map((membership) => membership.id);
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
           ON owner.workspace_id = a.workspace_id AND owner.id = a.owner_membership_id
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
           ON owner.workspace_id = a.workspace_id AND owner.id = a.owner_membership_id
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
      this.fenceAgentInboxBinding(workspaceId, agentId, timestamp);
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

  private normalizeMessageWorkItemIds(access: ConversationAccess, ids?: string[]): string[] {
    const distinct = [...new Set((ids ?? []).map((id) => id.trim()).filter(Boolean))];
    invariant(distinct.length <= 50, 'TOO_MANY_WORK_ITEM_REFERENCES', 'A message may reference at most 50 WorkItems.', 400);
    if (distinct.length === 0) return [];
    invariant(access.conversation.project_id !== null,
      'WORK_ITEM_REFERENCE_PROJECT_REQUIRED', 'WorkItem references are only available in Project Conversations.', 409);
    for (const id of distinct) {
      const workItem = this.requireWorkItem(id);
      invariant(workItem.workspace_id === access.conversation.workspace_id
        && workItem.project_id === access.conversation.project_id,
      'WORK_ITEM_REFERENCE_NOT_IN_PROJECT', 'Referenced WorkItem does not belong to this Project.', 409);
    }
    return distinct;
  }

  private addImplicitDirectAgentTarget(access: ConversationAccess, actorIds: string[]): string[] {
    if (access.conversation.conversation_kind !== 'dm') return actorIds;
    const directAgent = this.workspaceDatabase.raw
      .prepare(
        `SELECT membership.actor_id
         FROM conversation_memberships direct
         JOIN workspace_memberships membership
           ON membership.workspace_id = direct.workspace_id
          AND membership.id = direct.workspace_membership_id
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

  private addImplicitReplyAuthorTarget(
    access: ConversationAccess,
    authorActorId: string,
    actorIds: string[],
  ): string[] {
    if (authorActorId === access.membership.actor_id || actorIds.includes(authorActorId)) return actorIds;
    const authorIsCurrentParticipant = this.listConversationParticipants(
      { kind: 'human', actorId: access.membership.actor_id },
      access.conversation.id,
    ).some((participant) => participant.actorId === authorActorId);
    return authorIsCurrentParticipant ? [authorActorId, ...actorIds] : actorIds;
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
        scope_membership_id: participant.scopeMembershipId,
        membership_id: participant.workspaceMembershipId,
        project_membership_id: participant.projectMembershipId,
        actor_id: participant.actorId,
        actor_type: participant.actorType,
        display_name: participant.displayName,
        joined_at: participant.joinedAt,
      };
    });
  }

  private resolveAgentMessageMentions(
    workspaceId: string,
    conversationId: string,
    projectId: string | null,
    actorIds: string[] = [],
  ): ConversationParticipantRow[] {
    const distinct = [...new Set(actorIds.map((id) => id.trim()).filter(Boolean))];
    invariant(distinct.length <= 50, 'TOO_MANY_MENTIONS', 'A Message may mention at most 50 distinct Agents.', 400);
    if (distinct.length === 0) return [];
    const rows = this.workspaceDatabase.raw.prepare(projectId === null
      ? `SELECT membership.id AS membership_id,
                NULL AS project_membership_id,
                membership.actor_id, actor.actor_type,
                COALESCE(human.display_name, agent.name, membership.actor_id) AS display_name,
                membership.joined_at
         FROM conversation_memberships audience
         JOIN workspace_memberships membership
           ON membership.workspace_id = audience.workspace_id
          AND membership.id = audience.workspace_membership_id
          AND membership.status = 'active'
         JOIN actors actor ON actor.id = membership.actor_id
         LEFT JOIN humans human ON human.actor_id = membership.actor_id
         LEFT JOIN agents agent
           ON agent.workspace_id = membership.workspace_id AND agent.actor_id = membership.actor_id
        WHERE audience.workspace_id = ? AND audience.conversation_id = ?
          AND membership.actor_id IN (${distinct.map(() => '?').join(', ')})
        ORDER BY audience.joined_at, membership.id`
      : `SELECT membership.id AS membership_id,
                project_membership.id AS project_membership_id,
                membership.actor_id, actor.actor_type,
                COALESCE(human.display_name, agent.name, membership.actor_id) AS display_name,
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
        WHERE project_membership.workspace_id = ? AND project_membership.project_id = ?
          AND project_membership.status = 'active'
          AND membership.actor_id IN (${distinct.map(() => '?').join(', ')})
        ORDER BY project_membership.joined_at, membership.id`)
      .all(...(projectId === null ? [workspaceId, conversationId, ...distinct] : [workspaceId, projectId, ...distinct])) as unknown as Array<{
      membership_id: string;
      project_membership_id: string | null;
      actor_id: string;
      actor_type: 'human' | 'agent';
      display_name: string;
      joined_at: number;
    }>;
    const byActor = new Map(rows.map((row) => [row.actor_id, row]));
    return distinct.map((actorId) => {
      const row = byActor.get(actorId);
      invariant(row, 'MENTION_TARGET_NOT_IN_CONVERSATION', 'Mention target is not a current Conversation participant.', 409);
      return {
        scope_membership_id: row.membership_id,
        membership_id: row.membership_id,
        project_membership_id: row.project_membership_id,
        actor_id: row.actor_id,
        actor_type: row.actor_type,
        display_name: row.display_name,
        joined_at: row.joined_at,
      };
    });
  }

  private publishHumanMessage(
    access: ConversationAccess,
    body: string,
    threadId: string | null,
    replyToMessageId: string | null,
    mentions: ConversationParticipantRow[],
    artifactSelections: Array<{ artifactId: string; artifactVersionId: string }>,
    workItemIds: string[],
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
           id, workspace_id, conversation_id, project_id, thread_id, reply_to_message_id, author_actor_id,
           author_membership_id, author_project_membership_id,
           body, conversation_version, scope_position, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        messageId,
        workspaceId,
        conversationId,
        access.conversation.project_id,
        threadId,
        replyToMessageId,
        access.membership.actor_id,
        access.membership.id,
        access.projectMembership?.id ?? null,
        body,
        conversationVersion,
        scopePosition,
        timestamp,
      );

    artifactSelections.forEach((selection) => invariant(selection.artifactVersionId, 'ARTIFACT_VERSION_REQUIRED', 'Messages must reference a fixed Artifact version.', 400));
    const versionSelections = artifactSelections as Array<{ artifactId: string; artifactVersionId: string }>;
    const insertVersionReference = this.workspaceDatabase.raw.prepare(
      `INSERT INTO message_artifact_version_references_v2 (
         workspace_id, message_id, reference_order, artifact_id, version_id,
         artifact_name_snapshot, version_number_snapshot, version_created_at_snapshot, file_name_snapshot,
         media_type_snapshot, content_digest_snapshot, byte_length_snapshot,
         status_snapshot, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    versionSelections.forEach((selection, index) => {
      const row = this.workspaceDatabase.raw.prepare(
        `SELECT a.id AS artifact_id, a.project_id, a.name, a.status AS artifact_status,
                v.id AS version_id, v.version_number, v.created_at AS version_created_at, v.file_name, v.media_type,
                v.content_digest, v.byte_length, v.status
         FROM project_artifacts_v2 a JOIN artifact_versions_v2 v
           ON v.artifact_id = a.id AND v.workspace_id = a.workspace_id
         WHERE a.workspace_id = ? AND a.project_id = ? AND a.id = ? AND v.id = ?`,
       ).get(workspaceId, access.conversation.project_id, selection.artifactId, selection.artifactVersionId) as {
        artifact_id: string; name: string; artifact_status: 'active' | 'deleted' | 'purged'; version_id: string;
        version_number: number; version_created_at: number; file_name: string; media_type: string; content_digest: string; byte_length: number; status: 'active' | 'deleted' | 'purged';
      } | undefined;
      invariant(row, 'ARTIFACT_VERSION_NOT_FOUND', 'Artifact version does not belong to this Project.', 404);
      insertVersionReference.run(
        workspaceId, messageId, index, row.artifact_id, row.version_id, row.name, row.version_number, row.version_created_at,
        row.file_name, row.media_type, row.content_digest, row.byte_length,
        row.status === 'active' && row.artifact_status === 'active' ? 'active' : row.status, timestamp,
      );
    });
    const insertWorkItemReference = this.workspaceDatabase.raw.prepare(
      `INSERT INTO message_work_item_references_v2 (
         workspace_id, project_id, message_id, reference_order, work_item_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    workItemIds.forEach((workItemId, index) => {
      const workItem = this.requireWorkItem(workItemId);
      invariant(workItem.workspace_id === workspaceId && workItem.project_id === access.conversation.project_id,
        'WORK_ITEM_REFERENCE_NOT_IN_PROJECT', 'Referenced WorkItem does not belong to this Project.', 409);
      insertWorkItemReference.run(
        workspaceId, access.conversation.project_id!, messageId, index, workItem.id,
        timestamp,
      );
    });
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
      const wakeSequence = this.enqueueAgentInboxWake(
        workspaceId,
        targetAgentId,
        inboxItemId,
        timestamp,
      );
      this.enqueueDelivery(
        workspaceId,
        'agent.inbox_changed',
        'agent',
        targetAgentId,
        { agentId: targetAgentId, wakeSequence },
        `agent-inbox-wake:${targetAgentId}:${wakeSequence}`,
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
      { threadId, replyToMessageId, scopePosition, mentionOutcomes: outcomeSummaries },
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
      { conversationId, threadId, replyToMessageId, mentionCount: mentions.length, agentRequestTargetCount: mentionedAgents.length },
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

  private enqueueAgentInboxWake(
    workspaceId: string,
    agentId: string,
    inboxItemId: string,
    timestamp: number,
  ): number {
    const row = this.workspaceDatabase.raw.prepare(
      'SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM agent_inbox_wakes WHERE workspace_id = ? AND agent_id = ?',
    ).get(workspaceId, agentId) as { sequence: number };
    this.workspaceDatabase.raw.prepare(
      `INSERT INTO agent_inbox_wakes (workspace_id, agent_id, sequence, inbox_item_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(workspaceId, agentId, row.sequence, inboxItemId, timestamp);
    return row.sequence;
  }

  private notifyAgentInboxChanged(messageId: string): void {
    const wakes = this.workspaceDatabase.raw.prepare(
      `SELECT wake.agent_id, wake.sequence
       FROM agent_inbox_wakes wake
       JOIN agent_inbox_items item
         ON item.workspace_id = wake.workspace_id AND item.id = wake.inbox_item_id
       WHERE item.message_id = ? ORDER BY wake.agent_id, wake.sequence`,
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
    const workItemReferences = this.workspaceDatabase.raw.prepare(
      `SELECT reference.work_item_id, item.task_number
       FROM message_work_item_references_v2 reference
       JOIN work_items item
         ON item.workspace_id = reference.workspace_id AND item.id = reference.work_item_id
       WHERE reference.workspace_id = ? AND reference.message_id = ? ORDER BY reference.reference_order`,
    ).all(row.workspace_id, row.id).map((reference) => {
      const item = reference as {
        work_item_id: string;
        task_number: number;
      };
      return {
        workItemId: item.work_item_id,
        taskNumber: item.task_number,
      } satisfies MessageWorkItemReferenceView;
    });
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      conversationId: row.conversation_id,
      projectId: row.project_id,
      threadId: row.thread_id,
      threadRootMessageId: thread?.root_message_id ?? null,
      replyToMessageId: row.reply_to_message_id,
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
      artifactReferences: [
        ...this.workspaceDatabase.raw.prepare(
          `SELECT reference.artifact_id, reference.version_id, reference.artifact_name_snapshot,
                  reference.version_number_snapshot, reference.version_created_at_snapshot,
                  reference.file_name_snapshot, reference.media_type_snapshot, reference.content_digest_snapshot,
                  reference.byte_length_snapshot, reference.status_snapshot,
                  version.status AS current_version_status, artifact.status AS current_artifact_status
           FROM message_artifact_version_references_v2 reference
           JOIN artifact_versions_v2 version
             ON version.workspace_id = reference.workspace_id AND version.id = reference.version_id
           JOIN project_artifacts_v2 artifact
             ON artifact.workspace_id = reference.workspace_id AND artifact.id = reference.artifact_id
           WHERE reference.workspace_id = ? AND reference.message_id = ? ORDER BY reference.reference_order`,
        ).all(row.workspace_id, row.id).map((reference) => {
          const item = reference as {
            artifact_id: string; version_id: string; artifact_name_snapshot: string; version_number_snapshot: number; version_created_at_snapshot: number;
            file_name_snapshot: string; media_type_snapshot: string; content_digest_snapshot: string; byte_length_snapshot: number; status_snapshot: 'active' | 'deleted' | 'purged';
            current_version_status: 'active' | 'deleted' | 'purged'; current_artifact_status: 'active' | 'deleted' | 'purged';
          };
          return {
            artifactId: item.artifact_id,
            artifactVersionId: item.version_id,
            artifactName: item.artifact_name_snapshot,
            version: item.version_number_snapshot,
            fileName: item.file_name_snapshot,
            mediaType: item.media_type_snapshot,
            contentDigest: item.content_digest_snapshot,
            byteLength: item.byte_length_snapshot,
            contentAvailable: item.current_version_status === 'active' && item.current_artifact_status === 'active',
            artifactStatus: item.current_version_status === 'active' ? item.current_artifact_status : item.current_version_status,
          } as unknown as MessageArtifactReferenceView;
        }),
      ],
      workItemReferences,
      createdAt: row.created_at,
    };
  }

  private hydrateAgentContextMessage(row: MessageRow, observerMembership: MembershipRow): MessageView {
    const message = this.hydrateMessage(row, observerMembership);
    // WorkItem references are capabilities, not context snapshots. The
    // Mention Session receives their IDs in dedicated work_item_mention lines
    // and reads the authoritative entity through teamctl.
    return { ...message, workItemReferences: [] };
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
        // Project execution uses an isolated scratch directory.
        // Once the Agent has an active runtime binding it can use the scoped
        // Resource/Artifact APIs from an isolated scratch directory.
        intake = { disposition: 'ready', reasons: [] };
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
           JOIN actors actor ON actor.id = membership.actor_id
           LEFT JOIN project_memberships project_membership
             ON project_membership.workspace_id = conversation.workspace_id
            AND project_membership.project_id = conversation.project_id
            AND project_membership.workspace_membership_id = membership.id
            AND project_membership.status = 'active'
           LEFT JOIN conversation_memberships audience
             ON audience.workspace_id = conversation.workspace_id
            AND audience.conversation_id = conversation.id
            AND (
              (conversation.project_id IS NULL AND audience.workspace_membership_id = membership.id)
              OR
              (conversation.project_id IS NOT NULL AND audience.project_membership_id = project_membership.id)
            )
           WHERE conversation.workspace_id = ? AND conversation.id = ?
             AND (conversation.project_id IS NULL OR project_membership.id IS NOT NULL)
             AND (
               (conversation.membership_mode = 'workspace_all' AND actor.actor_type = 'human')
               OR (conversation.membership_mode = 'project_all' AND actor.actor_type = 'human')
               OR audience.id IS NOT NULL
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

  private cancelRunsAffectedByConversationMembershipRemoval(
    conversation: ConversationAccess['conversation'],
    removedWorkspaceMembershipId: string,
    removedProjectMembershipId: string | null,
    timestamp: number,
  ): { runIds: string[]; attemptIds: string[] } {
    const rows = this.workspaceDatabase.raw.prepare(
      `SELECT DISTINCT run.id AS run_id, attempt.id AS attempt_id
       FROM runs run
       JOIN agent_requests request
         ON request.workspace_id = run.workspace_id AND request.id = run.agent_request_id
       JOIN agent_mention_outcomes outcome
         ON outcome.workspace_id = request.workspace_id AND outcome.id = request.mention_outcome_id
       JOIN messages source
         ON source.workspace_id = outcome.workspace_id AND source.id = outcome.message_id
       LEFT JOIN attempts attempt
         ON attempt.workspace_id = run.workspace_id
        AND attempt.run_id = run.id
        AND attempt.status = 'running'
       WHERE run.workspace_id = ? AND request.result_conversation_id = ? AND run.status = 'active'
         AND (
           (? IS NULL AND (run.agent_membership_id = ? OR source.author_membership_id = ?))
           OR
           (? IS NOT NULL AND (
             run.agent_project_membership_id = ? OR source.author_project_membership_id = ?
           ))
         )
       ORDER BY run.created_at, run.id`,
    ).all(
      conversation.workspace_id,
      conversation.id,
      conversation.project_id,
      removedWorkspaceMembershipId,
      removedWorkspaceMembershipId,
      conversation.project_id,
      removedProjectMembershipId,
      removedProjectMembershipId,
    ) as unknown as Array<{ run_id: string; attempt_id: string | null }>;
    for (const row of rows) {
      if (row.attempt_id) {
        this.workspaceDatabase.raw.prepare(
          "UPDATE attempts SET status = 'cancelled', finished_at = ? WHERE id = ? AND status = 'running'",
        ).run(timestamp, row.attempt_id);
      }
      this.workspaceDatabase.raw.prepare(
        "UPDATE runs SET status = 'terminal', outcome = 'cancelled', terminal_at = ? WHERE id = ? AND status = 'active'",
      ).run(timestamp, row.run_id);
      this.workspaceDatabase.raw.prepare(
        'UPDATE private_context_grants SET revoked_at = ? WHERE workspace_id = ? AND run_id = ? AND revoked_at IS NULL',
      ).run(timestamp, conversation.workspace_id, row.run_id);
      this.enqueueDelivery(
        conversation.workspace_id,
        'run.cancelled',
        'run',
        row.run_id,
        { runId: row.run_id, reason: 'conversation_authority_revoked' },
        `cancelled:${row.run_id}:conversation-authority-revoked`,
        timestamp,
      );
    }
    return {
      runIds: rows.map((row) => row.run_id),
      attemptIds: rows.flatMap((row) => row.attempt_id ? [row.attempt_id] : []),
    };
  }

  private fenceRemovedConversationAgentInbox(
    workspaceId: string,
    conversationId: string,
    actorId: string,
    timestamp: number,
  ): void {
    const actor = this.workspaceDatabase.raw.prepare('SELECT actor_type FROM actors WHERE id = ?')
      .get(actorId) as { actor_type: 'human' | 'agent' } | undefined;
    if (actor?.actor_type !== 'agent') return;
    this.workspaceDatabase.raw.prepare(
      `UPDATE agent_inbox_items
       SET state = 'handled', handled_at = ?
       WHERE workspace_id = ? AND agent_id = ? AND state IN ('pending', 'claimed')
         AND conversation_id = ?`,
    ).run(timestamp, workspaceId, actorId, conversationId);
    this.workspaceDatabase.raw.prepare(
      `UPDATE agent_inbox_claim_receipts
       SET handled_at = ?, updated_at = ?
       WHERE workspace_id = ? AND agent_id = ? AND conversation_id = ? AND handled_at IS NULL`,
    ).run(timestamp, timestamp, workspaceId, actorId, conversationId);
  }

  private markInboxRequestsHandled(workspaceId: string, requestIds: string[], timestamp: number): void {
    const update = this.workspaceDatabase.raw.prepare(
      `UPDATE agent_inbox_items SET state = 'handled', handled_at = ?
       WHERE workspace_id = ? AND agent_request_id = ? AND state = 'pending'`,
    );
    requestIds.forEach((requestId) => update.run(timestamp, workspaceId, requestId));
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

  private requireConversationContextVersion(conversationId: string): number {
    const row = this.workspaceDatabase.raw.prepare('SELECT context_version FROM conversations WHERE id = ?')
      .get(conversationId) as { context_version: number } | undefined;
    invariant(row, 'CONVERSATION_NOT_FOUND', 'Conversation does not exist.', 404);
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
    // The (workspace_id, topic, dedupe_key) UNIQUE index makes this an
    // at-most-once outbox enqueue: a duplicate logical event must be a silent
    // no-op, never a constraint error. Without ON CONFLICT the plain INSERT
    // would throw, and the surrounding idempotent() wrapper would surface it as
    // CONSTRAINT_VIOLATION (409), rolling back the entire (unrelated) command.
    this.workspaceDatabase.raw
      .prepare(
        `INSERT INTO delivery_jobs (
           id, workspace_id, topic, aggregate_type, aggregate_id, payload_json,
           dedupe_key, state, attempts, next_attempt_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
         ON CONFLICT (workspace_id, topic, dedupe_key) DO NOTHING`,
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

  private requireWorkItem(workItemId: string): WorkItemRow {
    const row = this.workspaceDatabase.raw.prepare('SELECT * FROM work_items WHERE id = ?')
      .get(workItemId) as WorkItemRow | undefined;
    invariant(row, 'WORK_ITEM_NOT_FOUND', 'WorkItem does not exist or is not accessible.', 404);
    return row;
  }

  private normalizeWorkItemAssigneeIds(input: {
    assigneeProjectMembershipId?: string | null;
    assigneeProjectMembershipIds?: string[];
  }): string[] {
    if (input.assigneeProjectMembershipIds !== undefined) {
      const ids = [...new Set(input.assigneeProjectMembershipIds.map((id) => id.trim()).filter(Boolean))];
      invariant(ids.length <= 50, 'TOO_MANY_WORK_ITEM_ASSIGNEES', 'A WorkItem may have at most 50 responsible members.', 400);
      return ids;
    }
    return input.assigneeProjectMembershipId ? [input.assigneeProjectMembershipId] : [];
  }

  private replaceWorkItemAssignees(
    workspaceId: string,
    projectId: string,
    workItemId: string,
    assignees: Array<Pick<ProjectMemberView, 'projectMembershipId' | 'workspaceMembershipId'>>,
    timestamp: number,
  ): void {
    this.workspaceDatabase.raw.prepare(
      'DELETE FROM work_item_assignees WHERE workspace_id = ? AND work_item_id = ?',
    ).run(workspaceId, workItemId);
    const insert = this.workspaceDatabase.raw.prepare(
      `INSERT INTO work_item_assignees (
         workspace_id, project_id, work_item_id, assignment_order,
         project_membership_id, workspace_membership_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    assignees.forEach((member, index) => insert.run(
      workspaceId, projectId, workItemId, index, member.projectMembershipId, member.workspaceMembershipId, timestamp,
    ));
  }

  private getWorkItemAssigneeIds(workItem: WorkItemRow): string[] {
    const rows = this.workspaceDatabase.raw.prepare(
      `SELECT project_membership_id FROM work_item_assignees
       WHERE workspace_id = ? AND work_item_id = ? ORDER BY assignment_order`,
    ).all(workItem.workspace_id, workItem.id) as unknown as Array<{ project_membership_id: string }>;
    return rows.length > 0
      ? rows.map((row) => row.project_membership_id)
      : (workItem.assignee_project_membership_id ? [workItem.assignee_project_membership_id] : []);
  }

  private requireAssignedAgentWorkItem(workspaceId: string, agentId: string, workItemId: string): WorkItemRow {
    const membership = this.requireMembership(workspaceId, agentId);
    const workItem = this.requireWorkItem(workItemId);
    invariant(
      workItem.workspace_id === workspaceId
      && this.getWorkItemAssigneeIds(workItem).length > 0
      && (workItem.assignee_membership_id === membership.id
        || this.workspaceDatabase.raw.prepare(
          `SELECT 1 FROM work_item_assignees
           WHERE workspace_id = ? AND work_item_id = ? AND workspace_membership_id = ? LIMIT 1`,
        ).get(workspaceId, workItem.id, membership.id)),
      'WORK_ITEM_ASSIGNMENT_REQUIRED',
      'WorkItem is not assigned to this Agent.',
      403,
    );
    const projectMembership = this.findProjectMembership(workspaceId, workItem.project_id, membership.id);
    invariant(projectMembership && this.getWorkItemAssigneeIds(workItem).includes(projectMembership.id),
      'WORK_ITEM_ASSIGNMENT_FENCED', 'The WorkItem assignment is no longer active.', 409);
    return workItem;
  }

  private requireHumanWorkItemAuthority(actorId: string, workItem: WorkItemRow): MembershipRow {
    const workspaceMembership = this.requireMembership(workItem.workspace_id, actorId);
    const projectMembership = this.findProjectMembership(
      workItem.workspace_id,
      workItem.project_id,
      workspaceMembership.id,
    );
    invariant(
      projectMembership?.project_role === 'owner'
      || projectMembership?.project_role === 'manager'
      || workItem.assignee_membership_id === workspaceMembership.id
      || this.workspaceDatabase.raw.prepare(
        `SELECT 1 FROM work_item_assignees
         WHERE workspace_id = ? AND work_item_id = ? AND workspace_membership_id = ? LIMIT 1`,
      ).get(workItem.workspace_id, workItem.id, workspaceMembership.id),
      'WORK_ITEM_AUTHORITY_REQUIRED',
      'Only the current Human assignee or a Project Owner or Manager may change this WorkItem.',
      403,
    );
    return workspaceMembership;
  }

  private requireWorkItemManager(actorId: string, workItem: WorkItemRow): MembershipRow {
    return this.requireProjectManagerOrWorkspaceOwner(actorId, workItem.project_id).workspaceMembership;
  }

  private normalizeWorkItemCommentReferences(workItem: WorkItemRow, ids?: string[]): string[] {
    const distinct = [...new Set((ids ?? []).map((id) => id.trim()).filter(Boolean))];
    invariant(distinct.length <= 50, 'TOO_MANY_WORK_ITEM_REFERENCES', 'A WorkItem comment may reference at most 50 WorkItems.', 400);
    for (const id of distinct) {
      const referenced = this.requireWorkItem(id);
      invariant(referenced.workspace_id === workItem.workspace_id && referenced.project_id === workItem.project_id,
        'WORK_ITEM_REFERENCE_NOT_IN_PROJECT', 'Referenced WorkItem does not belong to this Project.', 409);
    }
    return distinct;
  }

  private insertWorkItemCommentReferences(
    workItem: WorkItemRow,
    commentId: string,
    workItemIds: string[],
  ): void {
    const insert = this.workspaceDatabase.raw.prepare(
      `INSERT INTO work_item_comment_work_item_references_v2 (
         workspace_id, project_id, comment_id, reference_order, work_item_id
       ) VALUES (?, ?, ?, ?, ?)`,
    );
    workItemIds.forEach((workItemId, referenceOrder) => {
      insert.run(workItem.workspace_id, workItem.project_id, commentId, referenceOrder, workItemId);
    });
  }

  private insertWorkItemCommentArtifactReferences(
    workItem: WorkItemRow,
    commentId: string,
    selections: Array<{ artifactId: string; artifactVersionId: string }>,
    timestamp: number,
  ): void {
    invariant(selections.length <= 100, 'TOO_MANY_ARTIFACT_REFERENCES', 'A WorkItem comment may reference at most 100 Artifacts.', 400);
    const insert = this.workspaceDatabase.raw.prepare(
      `INSERT INTO work_item_comment_artifact_version_references_v2 (
         workspace_id, project_id, comment_id, reference_order, artifact_id, version_id,
         artifact_name_snapshot, version_number_snapshot, version_created_at_snapshot, file_name_snapshot,
         media_type_snapshot, content_digest_snapshot, byte_length_snapshot, status_snapshot, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    selections.forEach((selection, referenceOrder) => {
      const row = this.workspaceDatabase.raw.prepare(
        `SELECT artifact.id AS artifact_id, artifact.name AS artifact_name,
                artifact.status AS artifact_status, version.id AS version_id,
                version.version_number, version.created_at AS version_created_at,
                version.file_name, version.media_type, version.content_digest,
                version.byte_length, version.status AS version_status
         FROM artifact_versions_v2 version
         JOIN project_artifacts_v2 artifact
           ON artifact.workspace_id = version.workspace_id AND artifact.id = version.artifact_id
         WHERE version.workspace_id = ? AND artifact.project_id = ?
           AND artifact.id = ? AND version.id = ?`,
      ).get(workItem.workspace_id, workItem.project_id, selection.artifactId, selection.artifactVersionId) as {
        artifact_id: string;
        artifact_name: string;
        artifact_status: 'active' | 'deleted' | 'purged';
        version_id: string;
        version_number: number;
        version_created_at: number;
        file_name: string;
        media_type: string;
        content_digest: string;
        byte_length: number;
        version_status: 'active' | 'deleted' | 'purged';
      } | undefined;
      invariant(row, 'ARTIFACT_VERSION_NOT_FOUND', 'Artifact version does not belong to this Project.', 404);
      insert.run(
        workItem.workspace_id, workItem.project_id, commentId, referenceOrder,
        row.artifact_id, row.version_id, row.artifact_name, row.version_number, row.version_created_at,
        row.file_name, row.media_type, row.content_digest, row.byte_length,
        row.version_status === 'active' && row.artifact_status === 'active' ? 'active' : row.version_status,
        timestamp,
      );
    });
  }

  private insertWorkItemComment(
    workItem: WorkItemRow,
    authorMembership: MembershipRow,
    authorProjectMembership: ProjectMembershipRow,
    body: string,
    mentionedActorIds: string[],
    referencedWorkItemIds: string[],
    artifactSelections: Array<{ artifactId: string; artifactVersionId: string }>,
    auditActorId: string,
  ): { commentId: string; wakeCount: number } {
    const mentions = mentionedActorIds.map((actorId) => {
      const row = this.workspaceDatabase.raw.prepare(
        `SELECT membership.id AS workspace_membership_id,
                project_membership.id AS project_membership_id,
                actor.actor_type
         FROM project_memberships project_membership
         JOIN workspace_memberships membership
           ON membership.workspace_id = project_membership.workspace_id
          AND membership.id = project_membership.workspace_membership_id
          AND membership.status = 'active'
         JOIN actors actor ON actor.id = membership.actor_id
         WHERE project_membership.workspace_id = ? AND project_membership.project_id = ?
           AND project_membership.status = 'active' AND membership.actor_id = ?`,
      ).get(workItem.workspace_id, workItem.project_id, actorId) as {
        workspace_membership_id: string;
        project_membership_id: string;
        actor_type: 'human' | 'agent';
      } | undefined;
      invariant(row, 'WORK_ITEM_MENTION_TARGET_NOT_FOUND',
        'A WorkItem comment can only mention an active Project participant.', 404);
      return { actorId, ...row };
    });
    const timestamp = nowMs();
    const frontier = this.workspaceDatabase.raw.prepare(
      `UPDATE work_items
       SET comment_frontier = comment_frontier + 1, updated_at = ?
       WHERE workspace_id = ? AND id = ?
       RETURNING comment_frontier`,
    ).get(timestamp, workItem.workspace_id, workItem.id) as { comment_frontier: number } | undefined;
    invariant(frontier, 'WORK_ITEM_NOT_FOUND', 'WorkItem does not exist.', 404);
    const commentId = newId();
    this.workspaceDatabase.raw.prepare(
      `INSERT INTO work_item_comments (
         id, workspace_id, project_id, work_item_id, author_actor_id,
         author_membership_id, author_project_membership_id, body,
         comment_position, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      commentId,
      workItem.workspace_id,
      workItem.project_id,
      workItem.id,
      authorMembership.actor_id,
      authorMembership.id,
      authorProjectMembership.id,
      body,
      frontier.comment_frontier,
      timestamp,
    );
    const insertMention = this.workspaceDatabase.raw.prepare(
      `INSERT INTO work_item_comment_mentions (
         workspace_id, comment_id, actor_id, mention_order
       ) VALUES (?, ?, ?, ?)`,
    );
    let wakeCount = 0;
    mentions.forEach((mention, mentionOrder) => {
      insertMention.run(workItem.workspace_id, commentId, mention.actorId, mentionOrder);
      if (mention.actor_type === 'agent') {
        this.enqueueWorkItemAttention(
          workItem.workspace_id,
          mention.actorId,
          workItem.id,
          commentId,
          'work_item_mention',
          timestamp,
        );
        wakeCount += 1;
      }
    });
    this.insertWorkItemCommentReferences(workItem, commentId, referencedWorkItemIds);
    this.insertWorkItemCommentArtifactReferences(workItem, commentId, artifactSelections, timestamp);
    this.recordWorkItemChange(workItem, 'work_item_comment_created', {
      commentId,
      commentPosition: frontier.comment_frontier,
      mentionedActorIds,
      workItemIds: referencedWorkItemIds,
      artifactSelections,
    }, timestamp);
    this.appendAudit(
      workItem.workspace_id,
      auditActorId,
      authorMembership.id,
      'work_item.comment.post',
      'work_item_comment',
      commentId,
      { workItemId: workItem.id, commentPosition: frontier.comment_frontier, mentionedActorIds, workItemIds: referencedWorkItemIds, artifactSelections },
      timestamp,
    );
    return { commentId, wakeCount };
  }

  private requireWorkItemComment(commentId: string): WorkItemCommentRow {
    const row = this.workspaceDatabase.raw.prepare(
      'SELECT * FROM work_item_comments WHERE id = ?',
    ).get(commentId) as WorkItemCommentRow | undefined;
    invariant(row, 'WORK_ITEM_COMMENT_NOT_FOUND', 'WorkItem comment does not exist.', 404);
    return row;
  }

  private mapWorkItemComment(row: WorkItemCommentRow): WorkItemCommentView {
    const author = this.workspaceDatabase.raw.prepare(
      `SELECT actor.actor_type, COALESCE(human.display_name, agent.name) AS display_name
       FROM workspace_memberships membership
       JOIN actors actor ON actor.id = membership.actor_id
       LEFT JOIN humans human ON human.actor_id = membership.actor_id
       LEFT JOIN agents agent
         ON agent.workspace_id = membership.workspace_id AND agent.actor_id = membership.actor_id
       WHERE membership.workspace_id = ? AND membership.id = ?`,
    ).get(row.workspace_id, row.author_membership_id) as {
      actor_type: 'human' | 'agent';
      display_name: string;
    } | undefined;
    invariant(author, 'WORK_ITEM_COMMENT_AUTHOR_NOT_FOUND', 'WorkItem comment author is unavailable.', 409);
    const mentionedActorIds = this.workspaceDatabase.raw.prepare(
      `SELECT actor_id FROM work_item_comment_mentions
       WHERE workspace_id = ? AND comment_id = ? ORDER BY mention_order`,
    ).all(row.workspace_id, row.id).map((item) => String((item as { actor_id: string }).actor_id));
    const mentions = this.workspaceDatabase.raw.prepare(
      `SELECT mention.actor_id, actor.actor_type,
              COALESCE(human.display_name, agent.name, mention.actor_id) AS display_name
       FROM work_item_comment_mentions mention
       JOIN actors actor ON actor.id = mention.actor_id
       LEFT JOIN humans human ON human.actor_id = mention.actor_id
       LEFT JOIN agents agent
         ON agent.workspace_id = mention.workspace_id AND agent.actor_id = mention.actor_id
       WHERE mention.workspace_id = ? AND mention.comment_id = ?
       ORDER BY mention.mention_order`,
    ).all(row.workspace_id, row.id).map((value) => {
      const mention = value as { actor_id: string; actor_type: 'human' | 'agent'; display_name: string };
      return { actorId: mention.actor_id, actorType: mention.actor_type, displayName: mention.display_name };
    });
    const workItemReferences = this.workspaceDatabase.raw.prepare(
      `SELECT reference.work_item_id, item.task_number
       FROM work_item_comment_work_item_references_v2 reference
       JOIN work_items item
         ON item.workspace_id = reference.workspace_id AND item.id = reference.work_item_id
       WHERE reference.workspace_id = ? AND reference.comment_id = ?
       ORDER BY reference.reference_order`,
    ).all(row.workspace_id, row.id).map((value) => {
      const reference = value as { work_item_id: string; task_number: number };
      return { workItemId: reference.work_item_id, taskNumber: reference.task_number };
    });
    const artifactReferences = this.mapWorkItemCommentArtifactReferences(row.workspace_id, row.id);
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      projectId: row.project_id,
      workItemId: row.work_item_id,
      authorActorId: row.author_actor_id,
      authorMembershipId: row.author_membership_id,
      authorProjectMembershipId: row.author_project_membership_id,
      authorActorType: author.actor_type,
      authorDisplayName: author.display_name,
      body: row.body,
      mentionedActorIds,
      mentions,
      workItemReferences,
      artifactReferences,
      position: row.comment_position,
      createdAt: row.created_at,
    };
  }

  private mapWorkItemCommentArtifactReferences(
    workspaceId: string,
    commentId: string,
  ): WorkItemArtifactReferenceView[] {
    return this.workspaceDatabase.raw.prepare(
      `SELECT reference.artifact_id, reference.version_id,
              reference.artifact_name_snapshot, reference.version_number_snapshot,
              reference.file_name_snapshot, reference.media_type_snapshot,
              reference.content_digest_snapshot, reference.byte_length_snapshot,
              reference.status_snapshot, version.status AS current_version_status,
              artifact.status AS current_artifact_status
       FROM work_item_comment_artifact_version_references_v2 reference
       JOIN artifact_versions_v2 version
         ON version.workspace_id = reference.workspace_id AND version.id = reference.version_id
       JOIN project_artifacts_v2 artifact
         ON artifact.workspace_id = reference.workspace_id AND artifact.id = reference.artifact_id
       WHERE reference.workspace_id = ? AND reference.comment_id = ?
       ORDER BY reference.reference_order`,
    ).all(workspaceId, commentId).map((value) => {
      const item = value as {
        artifact_id: string; version_id: string; artifact_name_snapshot: string;
        version_number_snapshot: number; file_name_snapshot: string; media_type_snapshot: string;
        content_digest_snapshot: string; byte_length_snapshot: number; status_snapshot: 'active' | 'deleted' | 'purged';
        current_version_status: 'active' | 'deleted' | 'purged'; current_artifact_status: 'active' | 'deleted' | 'purged';
      };
      return {
        artifactId: item.artifact_id,
        artifactVersionId: item.version_id,
        artifactName: item.artifact_name_snapshot,
        version: item.version_number_snapshot,
        fileName: item.file_name_snapshot,
        mediaType: item.media_type_snapshot,
        contentDigest: item.content_digest_snapshot,
        byteLength: item.byte_length_snapshot,
        contentAvailable: item.current_version_status === 'active' && item.current_artifact_status === 'active',
        artifactStatus: item.current_version_status === 'active'
          ? item.current_artifact_status
          : item.current_version_status,
      };
    });
  }

  private insertWorkItemSubmissionArtifactReferences(
    workItem: WorkItemRow,
    submissionId: string,
    artifactVersionIds: string[],
    timestamp: number,
  ): void {
    const insert = this.workspaceDatabase.raw.prepare(
      `INSERT INTO work_item_submission_artifact_references_v2 (
         workspace_id, submission_id, reference_order, artifact_id, version_id,
         artifact_name_snapshot, version_number_snapshot, version_created_at_snapshot,
         file_name_snapshot, media_type_snapshot, content_digest_snapshot,
         byte_length_snapshot, status_snapshot, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    artifactVersionIds.forEach((versionId, referenceOrder) => {
      const row = this.workspaceDatabase.raw.prepare(
        `SELECT artifact.id AS artifact_id, artifact.name AS artifact_name,
                artifact.status AS artifact_status, version.id AS version_id,
                version.version_number, version.created_at AS version_created_at,
                version.file_name, version.media_type, version.content_digest,
                version.byte_length, version.status AS version_status
         FROM artifact_versions_v2 version
         JOIN project_artifacts_v2 artifact
           ON artifact.workspace_id = version.workspace_id AND artifact.id = version.artifact_id
         WHERE version.workspace_id = ? AND artifact.project_id = ? AND version.id = ?`,
      ).get(workItem.workspace_id, workItem.project_id, versionId) as {
        artifact_id: string;
        artifact_name: string;
        artifact_status: 'active' | 'deleted' | 'purged';
        version_id: string;
        version_number: number;
        version_created_at: number;
        file_name: string;
        media_type: string;
        content_digest: string;
        byte_length: number;
        version_status: 'active' | 'deleted' | 'purged';
      } | undefined;
      invariant(row, 'ARTIFACT_VERSION_NOT_FOUND', 'Artifact version does not belong to this Project.', 404);
      invariant(row.artifact_status === 'active' && row.version_status === 'active',
        'ARTIFACT_VERSION_NOT_AVAILABLE', 'Only active Artifact versions can be submitted as a result.', 409);
      insert.run(
        workItem.workspace_id,
        submissionId,
        referenceOrder,
        row.artifact_id,
        row.version_id,
        row.artifact_name,
        row.version_number,
        row.version_created_at,
        row.file_name,
        row.media_type,
        row.content_digest,
        row.byte_length,
        row.version_status,
        timestamp,
      );
    });
  }

  private mapWorkItemSubmissionArtifactReferences(
    workspaceId: string,
    submissionId: string,
  ): WorkItemArtifactReferenceView[] {
    return this.workspaceDatabase.raw.prepare(
      `SELECT reference.artifact_id, reference.version_id,
              reference.artifact_name_snapshot, reference.version_number_snapshot,
              reference.file_name_snapshot, reference.media_type_snapshot,
              reference.content_digest_snapshot, reference.byte_length_snapshot,
              reference.status_snapshot, version.status AS current_version_status,
              artifact.status AS current_artifact_status
       FROM work_item_submission_artifact_references_v2 reference
       JOIN artifact_versions_v2 version
         ON version.workspace_id = reference.workspace_id AND version.id = reference.version_id
       JOIN project_artifacts_v2 artifact
         ON artifact.workspace_id = reference.workspace_id AND artifact.id = reference.artifact_id
       WHERE reference.workspace_id = ? AND reference.submission_id = ?
       ORDER BY reference.reference_order`,
    ).all(workspaceId, submissionId).map((value) => {
      const row = value as {
        artifact_id: string;
        version_id: string;
        artifact_name_snapshot: string;
        version_number_snapshot: number;
        file_name_snapshot: string;
        media_type_snapshot: string;
        content_digest_snapshot: string;
        byte_length_snapshot: number;
        status_snapshot: 'active' | 'deleted' | 'purged';
        current_version_status: 'active' | 'deleted' | 'purged';
        current_artifact_status: 'active' | 'deleted' | 'purged';
      };
      return {
        artifactId: row.artifact_id,
        artifactVersionId: row.version_id,
        artifactName: row.artifact_name_snapshot,
        version: row.version_number_snapshot,
        fileName: row.file_name_snapshot,
        mediaType: row.media_type_snapshot,
        contentDigest: row.content_digest_snapshot,
        byteLength: row.byte_length_snapshot,
        contentAvailable: row.current_version_status === 'active' && row.current_artifact_status === 'active',
        artifactStatus: row.current_version_status === 'active'
          ? row.current_artifact_status
          : row.current_version_status,
      };
    });
  }

  private enqueueWorkItemAttention(
    workspaceId: string,
    agentId: string,
    workItemId: string,
    commentId: string | null,
    attentionKind: 'work_item_assignment' | 'work_item_mention',
    timestamp: number,
  ): number {
    const inboxItemId = newId();
    const inboxSequence = this.nextAgentInboxSequence(workspaceId, agentId);
    this.workspaceDatabase.raw.prepare(
      `INSERT INTO agent_inbox_items (
         id, workspace_id, agent_id, sequence, attention_kind,
         message_id, conversation_id, thread_id, agent_request_id,
         work_item_id, work_item_comment_id, created_at
       ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)`,
    ).run(
      inboxItemId,
      workspaceId,
      agentId,
      inboxSequence,
      attentionKind,
      workItemId,
      commentId,
      timestamp,
    );
    const wakeSequence = this.enqueueAgentInboxWake(workspaceId, agentId, inboxItemId, timestamp);
    this.enqueueDelivery(
      workspaceId,
      'agent.inbox_changed',
      'agent',
      agentId,
      { agentId, wakeSequence, workItemId },
      `agent-inbox-wake:${agentId}:${wakeSequence}`,
      timestamp,
    );
    return wakeSequence;
  }

  private handleWorkItemAttentionAsHandled(workspaceId: string, workItemId: string, agentId?: string): void {
    this.workspaceDatabase.raw.prepare(
      `UPDATE agent_inbox_items
       SET state = 'handled', handled_at = ?
       WHERE workspace_id = ? AND work_item_id = ? AND state = 'pending'
         AND (? IS NULL OR agent_id = ?)`,
    ).run(nowMs(), workspaceId, workItemId, agentId ?? null, agentId ?? null);
  }

  private mapWorkItem(row: WorkItemRow): WorkItemView {
    const creator = this.workspaceDatabase.raw.prepare(
      `SELECT COALESCE(human.display_name, agent.name) AS display_name
       FROM workspace_memberships membership
       LEFT JOIN humans human ON human.actor_id = membership.actor_id
       LEFT JOIN agents agent
         ON agent.workspace_id = membership.workspace_id AND agent.actor_id = membership.actor_id
       WHERE membership.workspace_id = ? AND membership.id = ?`,
    ).get(row.workspace_id, row.created_by_membership_id) as { display_name: string } | undefined;
    invariant(creator, 'WORK_ITEM_CREATOR_NOT_FOUND', 'WorkItem creator provenance is unavailable.', 409);
    const assigneeRows = this.workspaceDatabase.raw.prepare(
      `SELECT project_membership.id AS project_membership_id,
              project_membership.workspace_membership_id,
              membership.actor_id, actor.actor_type,
              COALESCE(human.display_name, agent.name) AS display_name
       FROM project_memberships project_membership
       JOIN workspace_memberships membership
         ON membership.workspace_id = project_membership.workspace_id
        AND membership.id = project_membership.workspace_membership_id
       JOIN actors actor ON actor.id = membership.actor_id
       LEFT JOIN humans human ON human.actor_id = membership.actor_id
       LEFT JOIN agents agent
         ON agent.workspace_id = membership.workspace_id AND agent.actor_id = membership.actor_id
       WHERE project_membership.workspace_id = ? AND project_membership.project_id = ?
         AND project_membership.id IN (
           SELECT project_membership_id FROM work_item_assignees
           WHERE workspace_id = ? AND work_item_id = ? ORDER BY assignment_order
         )
       ORDER BY (SELECT assignment_order FROM work_item_assignees
                 WHERE workspace_id = ? AND work_item_id = ?
                   AND project_membership_id = project_membership.id)`,
    ).all(row.workspace_id, row.project_id, row.workspace_id, row.id, row.workspace_id, row.id) as unknown as Array<{
      project_membership_id: string;
      workspace_membership_id: string;
      actor_id: string;
      actor_type: 'human' | 'agent';
      display_name: string;
    }>;
    if (assigneeRows.length === 0 && row.assignee_project_membership_id !== null) {
      const legacy = this.workspaceDatabase.raw.prepare(
        `SELECT project_membership.id AS project_membership_id,
                project_membership.workspace_membership_id,
                membership.actor_id, actor.actor_type,
                COALESCE(human.display_name, agent.name) AS display_name
         FROM project_memberships project_membership
         JOIN workspace_memberships membership
           ON membership.workspace_id = project_membership.workspace_id
          AND membership.id = project_membership.workspace_membership_id
         JOIN actors actor ON actor.id = membership.actor_id
         LEFT JOIN humans human ON human.actor_id = membership.actor_id
         LEFT JOIN agents agent ON agent.workspace_id = membership.workspace_id AND agent.actor_id = membership.actor_id
         WHERE project_membership.workspace_id = ? AND project_membership.project_id = ?
           AND project_membership.id = ?`,
      ).get(row.workspace_id, row.project_id, row.assignee_project_membership_id) as typeof assigneeRows[number] | undefined;
      if (legacy) assigneeRows.push(legacy);
    }
    invariant(row.assignee_project_membership_id === null || assigneeRows.length > 0,
      'WORK_ITEM_ASSIGNEE_NOT_FOUND', 'WorkItem assignee provenance is unavailable.', 409);
    const assignees = assigneeRows.map((assignee) => ({
      projectMembershipId: assignee.project_membership_id,
      workspaceMembershipId: assignee.workspace_membership_id,
      actorId: assignee.actor_id,
      actorType: assignee.actor_type,
      displayName: assignee.display_name,
    }));
    const submission = row.current_submission_id === null ? null : this.workspaceDatabase.raw.prepare(
      `SELECT submission.id, submission.comment_id, submission.submitted_by_membership_id,
              submission.submitted_by_project_membership_id, submission.assignment_revision,
              submission.created_at, membership.actor_id,
              COALESCE(human.display_name, agent.name) AS display_name
       FROM work_item_submissions submission
       JOIN workspace_memberships membership
         ON membership.workspace_id = submission.workspace_id
        AND membership.id = submission.submitted_by_membership_id
       LEFT JOIN humans human ON human.actor_id = membership.actor_id
       LEFT JOIN agents agent
         ON agent.workspace_id = membership.workspace_id AND agent.actor_id = membership.actor_id
       WHERE submission.workspace_id = ? AND submission.work_item_id = ? AND submission.id = ?`,
    ).get(row.workspace_id, row.id, row.current_submission_id) as {
      id: string;
      comment_id: string | null;
      submitted_by_membership_id: string;
      submitted_by_project_membership_id: string;
      assignment_revision: number;
      created_at: number;
      actor_id: string;
      display_name: string;
    } | undefined;
    invariant(row.current_submission_id === null || submission,
      'WORK_ITEM_SUBMISSION_NOT_FOUND', 'Current WorkItem submission is unavailable.', 409);
    const relatedWorkItemReferences = row.source_message_id === null ? [] : this.workspaceDatabase.raw.prepare(
      `SELECT reference.work_item_id, item.task_number
       FROM message_work_item_references_v2 reference
       JOIN work_items item
         ON item.workspace_id = reference.workspace_id
        AND item.project_id = ?
        AND item.id = reference.work_item_id
       WHERE reference.workspace_id = ?
         AND reference.message_id = ?
         AND reference.work_item_id <> ?
       ORDER BY reference.reference_order`,
    ).all(row.project_id, row.workspace_id, row.source_message_id, row.id).map((value) => {
      const reference = value as { work_item_id: string; task_number: number };
      return { workItemId: reference.work_item_id, taskNumber: reference.task_number };
    });
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      projectId: row.project_id,
      taskNumber: row.task_number,
      description: row.description,
      relatedWorkItemReferences,
      sourceConversationId: row.source_conversation_id,
      sourceMessageId: row.source_message_id,
      sourceThreadId: row.source_thread_id,
      lifecycleStatus: row.lifecycle_status,
      blockerReason: row.blocker_reason,
      cancellationReason: row.cancellation_reason,
      assignee: assignees[0] ?? null,
      assignees,
      currentSubmission: submission ? {
        id: submission.id,
        commentId: submission.comment_id,
        submittedByMembershipId: submission.submitted_by_membership_id,
        submittedByProjectMembershipId: submission.submitted_by_project_membership_id,
        submittedByActorId: submission.actor_id,
        submittedByDisplayName: submission.display_name,
        assignmentRevision: submission.assignment_revision,
        artifactReferences: this.mapWorkItemSubmissionArtifactReferences(row.workspace_id, submission.id),
        createdAt: submission.created_at,
      } : null,
      assignmentRevision: row.assignment_revision,
      commentFrontier: row.comment_frontier,
      revision: row.revision,
      createdByMembershipId: row.created_by_membership_id,
      createdByProjectMembershipId: row.created_by_project_membership_id,
      createdByDisplayName: creator.display_name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
      cancelledAt: row.cancelled_at,
    };
  }

  private nextProjectTaskNumber(workspaceId: string, projectId: string): number {
    const row = this.workspaceDatabase.raw.prepare(
      `SELECT COALESCE(MAX(task_number), 0) + 1 AS task_number
       FROM work_items WHERE workspace_id = ? AND project_id = ?`,
    ).get(workspaceId, projectId) as { task_number: number };
    invariant(Number.isSafeInteger(row.task_number) && row.task_number > 0,
      'TASK_NUMBER_EXHAUSTED', 'Project task numbering is exhausted.', 409);
    return row.task_number;
  }

  private recordWorkItemChange(
    workItem: WorkItemRow,
    changeType: string,
    payload: Record<string, unknown>,
    timestamp: number,
  ): void {
    const projectVersion = this.bumpProjectContext(workItem.project_id, timestamp);
    this.appendChange(
      workItem.workspace_id,
      null,
      null,
      null,
      changeType,
      'work_item',
      workItem.id,
      { workItemId: workItem.id, projectId: workItem.project_id, ...payload },
      timestamp,
      { projectId: workItem.project_id, projectVersion },
    );
    this.enqueueDelivery(
      workItem.workspace_id,
      `work-item.${changeType.slice('work_item_'.length).replaceAll('_', '-')}`,
      'work_item',
      workItem.id,
      { workItemId: workItem.id, projectId: workItem.project_id, ...payload },
      `${changeType}:${workItem.id}:${String(payload.revision ?? timestamp)}`,
      timestamp,
    );
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

  private requireProjectManager(actorId: string, projectId: string): {
    project: ProjectRow;
    workspaceMembership: MembershipRow;
    projectMembership: ProjectMembershipRow;
  } {
    const access = this.requireProjectAccess(actorId, projectId);
    invariant(
      access.projectMembership.project_role === 'owner' || access.projectMembership.project_role === 'manager',
      'PROJECT_MANAGER_REQUIRED',
      'An active Human Project Owner or Manager is required.',
      403,
    );
    return access;
  }

  private requireProjectManagerOrWorkspaceOwner(actorId: string, projectId: string): {
    project: ProjectRow;
    workspaceMembership: MembershipRow;
    projectMembership: ProjectMembershipRow;
  } {
    return this.requireProjectManager(actorId, projectId);
  }

  private requireProjectOwner(actorId: string, projectId: string): {
    project: ProjectRow;
    workspaceMembership: MembershipRow;
    projectMembership: ProjectMembershipRow;
  } {
    const access = this.requireProjectAccess(actorId, projectId);
    invariant(
      access.projectMembership.project_role === 'owner',
      'PROJECT_OWNER_REQUIRED',
      'The active Project Owner is required.',
      403,
    );
    return access;
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
           (SELECT COUNT(*) FROM conversations c WHERE c.project_id = ?) AS conversation_count`,
      )
      .get(
        project.id,
        project.id,
      ) as {
        active_member_count: number;
        conversation_count: number;
      };
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
      createdByMembershipId: project.created_by_membership_id,
      createdAt: project.created_at,
      updatedAt: project.updated_at,
    };
  }

  private mapProjectMember(row: {
    project_membership_id: string;
    workspace_membership_id: string;
    actor_id: string;
    actor_type: 'human' | 'agent';
    display_name: string;
    project_role: ProjectRole;
    sponsored_by_project_membership_id: string | null;
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
      sponsoredByProjectMembershipId: row.sponsored_by_project_membership_id,
      revision: row.revision,
      joinedAt: row.joined_at,
    };
  }

  private getProjectMember(workspaceId: string, projectId: string, projectMembershipId: string): ProjectMemberView {
    const row = this.workspaceDatabase.raw
      .prepare(
        `SELECT pm.id AS project_membership_id, pm.workspace_membership_id,
                wm.actor_id, a.actor_type, COALESCE(h.display_name, ag.name) AS display_name,
                pm.project_role, pm.sponsored_by_project_membership_id, pm.revision, pm.joined_at
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
    visibility: ConversationVisibility,
    participantScopeMembershipIds: string[] | undefined,
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
    invariant(kind !== 'dm' || visibility === 'private', 'DM_MUST_BE_PRIVATE', 'A DM must be private.');
    const scopeType = projectId !== null
      ? 'project_group' as const
      : kind === 'dm' ? 'direct_message' as const : 'workspace_general' as const;
    const membershipMode = scopeType === 'workspace_general'
      ? 'workspace_all' as const
      : scopeType === 'project_group' && visibility === 'public'
        ? 'project_all' as const
        : 'explicit' as const;
    const participantMembershipIds = participantScopeMembershipIds === undefined
      ? undefined
      : [...new Set(participantScopeMembershipIds)];
    if (kind === 'dm') {
      invariant(participantMembershipIds?.length === 2, 'INVALID_DM_PARTICIPANTS', 'A DM must contain exactly two memberships.');
      for (const membershipId of participantMembershipIds) this.requireActiveWorkspaceMember(workspaceId, membershipId);
    } else if (visibility === 'public') {
      invariant(
        participantMembershipIds === undefined,
        'PUBLIC_CHANNEL_PARTICIPANTS_FORBIDDEN',
        'A public Channel cannot carry an explicit participant audience.',
      );
    } else if (projectId === null) {
      invariant(participantMembershipIds && participantMembershipIds.length > 0,
        'PRIVATE_CHANNEL_PARTICIPANTS_REQUIRED', 'A private Channel must include its creator.');
      for (const membershipId of participantMembershipIds) this.requireActiveWorkspaceMember(workspaceId, membershipId);
    } else {
      invariant(participantMembershipIds && participantMembershipIds.length > 0,
        'PRIVATE_CHANNEL_PARTICIPANTS_REQUIRED', 'A private Channel must include its creator.');
      for (const membershipId of participantMembershipIds) {
        this.requireProjectMembership(workspaceId, projectId, membershipId);
      }
    }
    const conversationId = newId();
    const timestamp = nowMs();
    this.workspaceDatabase.raw
      .prepare(
        `INSERT INTO conversations (
           id, workspace_id, project_id, scope_type, membership_mode,
           conversation_kind, visibility, title,
           created_by_membership_id, created_by_project_membership_id,
           context_version, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        conversationId,
        workspaceId,
        projectId,
        scopeType,
        membershipMode,
        kind,
        visibility,
        title?.trim() || null,
        creator.id,
        creatorProjectMembership?.id ?? null,
        timestamp,
        timestamp,
      );
    const insertMembership = this.workspaceDatabase.raw.prepare(
      `INSERT INTO conversation_memberships (
         id, workspace_id, conversation_id, project_id, scope_membership_id,
         workspace_membership_id, project_membership_id, joined_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const scopeMembershipId of participantMembershipIds ?? []) {
      const projectMembership = projectId === null
        ? null
        : this.requireProjectMembership(workspaceId, projectId, scopeMembershipId);
      insertMembership.run(
        newId(), workspaceId, conversationId, projectId, scopeMembershipId,
        projectMembership?.workspace_membership_id ?? scopeMembershipId,
        projectMembership?.id ?? null, timestamp,
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
        scopeType,
        membershipMode,
        kind,
        projectId,
        visibility,
        ...(visibility === 'private' ? { participantScopeMembershipIds: participantMembershipIds } : {}),
      },
      timestamp,
      { projectId, projectVersion },
    );
    this.appendAudit(workspaceId, principal.actorId, creator.id, 'conversation.create', 'conversation', conversationId, {
      kind,
      visibility,
      projectId,
    }, timestamp);
    return this.mapConversation({
      id: conversationId,
      workspace_id: workspaceId,
      project_id: projectId,
      scope_type: scopeType,
      membership_mode: membershipMode,
      conversation_kind: kind,
      visibility,
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
    }, 'content');
  }

  private conversationChangeOptions(conversation: ConversationAccess['conversation']): {
    projectId?: string;
    projectVersion?: number;
  } {
    if (conversation.project_id === null) return {};
    const project = this.requireProject(conversation.project_id);
    return { projectId: project.id, projectVersion: project.context_version };
  }

  private requireConversationViewAccess(actorId: string, conversationId: string): ConversationAccess {
    const conversation = this.workspaceDatabase.raw.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId) as
      | ConversationAccess['conversation']
      | undefined;
    invariant(conversation, 'CONVERSATION_NOT_FOUND', 'Conversation does not exist or is not accessible.', 404);
    const membership = this.requireMembership(conversation.workspace_id, actorId);
    const projectMembership = conversation.project_id
      ? this.findProjectMembership(conversation.workspace_id, conversation.project_id, membership.id) ?? null
      : null;
    const hasContent = this.hasConversationAccess(conversation.workspace_id, conversationId, membership.id);
    const hasGovernance = conversation.scope_type === 'project_group'
      && conversation.membership_mode === 'explicit'
      && (
        conversation.created_by_membership_id === membership.id
        || projectMembership?.project_role === 'owner'
        || projectMembership?.project_role === 'manager'
      );
    invariant(hasContent || hasGovernance, 'CONVERSATION_NOT_FOUND', 'Conversation does not exist or is not accessible.', 404);
    return { conversation, membership, projectMembership, accessMode: hasContent ? 'content' : 'governance' };
  }

  private requireConversationAccess(actorId: string, conversationId: string): ConversationAccess {
    const access = this.requireConversationViewAccess(actorId, conversationId);
    invariant(
      access.accessMode === 'content',
      'CONVERSATION_CONTENT_FORBIDDEN',
      'This administrator has governance access only and cannot read or write Conversation content.',
      403,
    );
    return access;
  }

  private requireConversationAudienceAuthority(actorId: string, conversationId: string): ConversationAccess {
    const access = this.requireConversationViewAccess(actorId, conversationId);
    invariant(
      access.conversation.scope_type !== 'direct_message',
      'DM_PARTICIPANTS_IMMUTABLE',
      'DM participants are fixed and cannot be changed.',
      409,
    );
    return access;
  }

  private resolveConversationScopeMembership(
    conversation: ConversationAccess['conversation'],
    scopeMembershipId: string,
  ): {
    workspaceMembershipId: string;
    projectMembershipId: string | null;
    actorId: string;
    actorType: 'human' | 'agent';
  } {
    if (conversation.project_id === null) {
      const workspaceMember = this.requireActiveWorkspaceMember(conversation.workspace_id, scopeMembershipId);
      return {
        workspaceMembershipId: workspaceMember.membershipId,
        projectMembershipId: null,
        actorId: workspaceMember.actorId,
        actorType: workspaceMember.actorType,
      };
    }
    const projectMembership = this.requireProjectMembership(
      conversation.workspace_id,
      conversation.project_id,
      scopeMembershipId,
    );
    const workspaceMember = this.requireActiveWorkspaceMember(
      conversation.workspace_id,
      projectMembership.workspace_membership_id,
    );
    return {
      workspaceMembershipId: projectMembership.workspace_membership_id,
      projectMembershipId: projectMembership.id,
      actorId: workspaceMember.actorId,
      actorType: workspaceMember.actorType,
    };
  }

  private requireConversationParticipantAdditionAuthority(
    access: ConversationAccess,
    participant: { actorId: string; actorType: 'human' | 'agent' },
    actorId: string,
  ): void {
    if (participant.actorType === 'agent') {
      this.requireAgentOwner(access.conversation.workspace_id, participant.actorId, actorId);
      return;
    }
    invariant(
      access.conversation.membership_mode === 'explicit'
      && access.conversation.scope_type === 'project_group'
      && (
        access.conversation.created_by_membership_id === access.membership.id
        || access.projectMembership?.project_role === 'owner'
        || access.projectMembership?.project_role === 'manager'
      ),
      'FORBIDDEN',
      'Only the group creator or a Project Owner or Manager may add Human participants.',
      403,
    );
  }

  private requireConversationParticipantRemovalAuthority(
    access: ConversationAccess,
    participantActorId: string,
    participantWorkspaceMembershipId: string,
  ): void {
    const target = this.requireActiveWorkspaceMember(
      access.conversation.workspace_id,
      participantWorkspaceMembershipId,
    );
    if (target.actorType === 'agent') {
      const projectAdmin = access.conversation.project_id !== null
        && (access.projectMembership?.project_role === 'owner' || access.projectMembership?.project_role === 'manager');
      invariant(
        projectAdmin || this.isCurrentAgentOwner(access.conversation.workspace_id, participantActorId, access.membership.id),
        'FORBIDDEN',
        'Only the Agent Owner or a Project Owner or Manager may remove this Agent.',
        403,
      );
      return;
    }
    invariant(
      access.conversation.membership_mode === 'explicit'
      && access.conversation.scope_type === 'project_group'
      && (
        access.conversation.created_by_membership_id === access.membership.id
        || access.projectMembership?.project_role === 'owner'
        || access.projectMembership?.project_role === 'manager'
      ),
      'FORBIDDEN',
      'Only the group creator or a Project Owner or Manager may remove Human participants.',
      403,
    );
  }

  private advanceConversationAudienceRevision(
    conversation: ConversationAccess['conversation'],
    expectedRevision: number,
    timestamp: number,
  ): { revision: number; contextVersion: number } {
    const row = this.workspaceDatabase.raw.prepare(
      `UPDATE conversations
       SET revision = revision + 1, context_version = context_version + 1, updated_at = ?
       WHERE workspace_id = ? AND id = ? AND revision = ?
       RETURNING revision, context_version`,
    ).get(timestamp, conversation.workspace_id, conversation.id, expectedRevision) as {
      revision: number;
      context_version: number;
    } | undefined;
    invariant(row, 'CONVERSATION_REVISION_CONFLICT', 'Conversation audience changed concurrently.', 409);
    return { revision: row.revision, contextVersion: row.context_version };
  }

  private transitionConversationLifecycle(
    principal: HumanPrincipal,
    conversationId: string,
    from: 'active' | 'archived',
    to: 'active' | 'archived',
    expectedRevision: number,
    idempotencyKey: string,
  ): ConversationView {
    const existing = this.requireConversationViewAccess(principal.actorId, conversationId);
    const command = to === 'archived' ? 'ArchiveConversation' : 'RestoreConversation';
    return this.idempotent(
      existing.conversation.workspace_id,
      principal.actorId,
      command,
      idempotencyKey,
      { conversationId, expectedRevision },
      () => {
        const access = this.requireConversationViewAccess(principal.actorId, conversationId);
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
        return this.mapConversation(row, access.accessMode);
      },
    );
  }

  private requireConversationLifecycleAuthority(access: ConversationAccess): void {
    const allowed = access.conversation.conversation_kind === 'dm'
      || (
        access.conversation.scope_type === 'project_group'
        && access.conversation.membership_mode === 'explicit'
        && (
          access.conversation.created_by_membership_id === access.membership.id
          || access.projectMembership?.project_role === 'owner'
          || access.projectMembership?.project_role === 'manager'
        )
      );
    invariant(
      allowed,
      'FORBIDDEN',
      'Only a DM participant or the current scope administrator may change Conversation lifecycle.',
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
         FROM conversation_memberships direct
         JOIN workspace_memberships m
           ON m.workspace_id = direct.workspace_id
          AND m.id = direct.workspace_membership_id
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
    scope_type: 'workspace_general' | 'direct_message' | 'project_group';
    membership_mode: 'workspace_all' | 'project_all' | 'explicit';
    conversation_kind: ConversationKind;
    visibility: ConversationVisibility;
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
  }, accessMode: ConversationAccessMode): ConversationView {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      projectId: row.project_id,
      scope: row.scope_type === 'project_group'
        ? { type: 'project_group', projectId: row.project_id!, membershipMode: row.membership_mode as 'project_all' | 'explicit' }
        : { type: row.scope_type },
      kind: row.conversation_kind,
      visibility: row.visibility,
      accessMode,
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
         LEFT JOIN conversation_memberships audience
           ON audience.workspace_id = conversation.workspace_id
          AND audience.conversation_id = conversation.id
          AND (
            (conversation.project_id IS NULL AND audience.workspace_membership_id = membership.id)
            OR
            (conversation.project_id IS NOT NULL AND audience.project_membership_id = project_membership.id)
          )
         WHERE conversation.workspace_id = ? AND conversation.id = ?
           AND (conversation.project_id IS NULL OR project_membership.id IS NOT NULL)
           AND (
             (conversation.conversation_kind = 'channel' AND conversation.visibility = 'public')
             OR (conversation.visibility = 'private' AND audience.id IS NOT NULL)
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
      `You are ${agent.name}, an Agent in the ${agent.workspace_name} Workspace. Each Mention or WorkItem has an isolated Session. A WorkItem created from a Conversation Mention may use one composite WorkItem Session with both task and Discussion obligations.`,
      agent.description?.trim() ? `Your role: ${agent.description.trim()}` : '',
      '',
      '## teamctl CLI',
      '',
      'Your Workspace communication and shared output are performed with `teamctl`. Standard output is not delivered to users.',
      'The Local Computer Runtime is a disposable cache. The Session JSONL supplied at startup is authoritative and must never be mixed with another Session.',
      '',
      '### Inbox',
      '',
      '- `teamctl inbox check` lists pending targets without claiming or consuming them.',
      '- Discussion targets use `conversation:<conversation-id>` or `conversation:<conversation-id>:thread:<thread-id>`.',
      '- Agent Inbox contains Discussion attention plus explicit WorkItem assignment or mention attention. Workspace, Project, File, Document, and Artifact changes remain in shared history and are not Inbox items.',
      '- Inbox delivery and Runtime wake are separate. Ordinary accessible Discussion Messages remain queryable without waking you; Human-Agent direct Messages and explicit mentions create content-free wakes.',
      '- A wake contains no Message body. The Session JSONL contains the bounded context for exactly one Mention or WorkItem; a source-message WorkItem Session may also include one linked Conversation and its Discussion capability.',
      '',
      '### WorkItems',
      '',
      '- `teamctl work-item list [--project-id <id>]` lists every WorkItem in a Project where you are an active Project member.',
      '- `teamctl work-item read <work-item-id>` returns the immutable description and task number, current assignment revision, lifecycle, comment frontier, current Result Submission, and optional source Conversation/Message/Thread IDs.',
      '- Mention and WorkItem Sessions include a `work_item_mention` line for each referenced WorkItem. Use `teamctl work-item read <work-item-id>` to inspect current state and Artifact references; Project membership, not the current Session, governs read/list access.',
      '- WorkItem comments are independent from Conversation Messages. Use `teamctl work-item comment <work-item-id> --body <text> [--mention <actor-id> ...] [--work-item-id <id> ...] [--artifact-ref <artifact-id>:<artifact-version-id> ...]` for task-specific collaboration.',
      '- If assigned work cannot advance, run `teamctl work-item block <work-item-id> --reason <text>` with a concrete blocker. Only an authorized Human can unblock it.',
      '- Publish result files with `teamctl artifact publish --file <path> --task-id <work-item-id>`, then run `teamctl work-item submit <work-item-id> --artifact-version-id <version-id> [--comment-id <comment-id>]`. The Artifact version is the structured Result Submission; the comment is optional explanation only. Submission does not complete the WorkItem; an authorized Human completes or cancels it.',
      '',
      '### Messages',
      '',
      '- `teamctl message check --target <discussion-target>` claims pending Inbox events for this Session and reads only Discussion messages after the Session JSONL frontier. The initial Mention is already in the snapshot and is not repeated as a second user message.',
      '- The Session JSONL is a fixed startup snapshot. New messages remain in Inbox until a later check; they are never appended to the already-sent ACP context.',
      '- A DM Session accepts at most 10 messages total, including its initial trigger. When the window reaches 10 it is frozen; stop checking and reply or return no-output. Overflow messages stay pending for the next Session.',
      '- Never claim another Group Mention Session. In a DM, a pending message may join this active window only while it is accepting and below the limit; otherwise it belongs to the next Session.',
      '- `teamctl message read --target <discussion-target> [--before <position>|--after <position>] [--limit <count>]` reads additional Conversation history without changing Inbox state.',
      '- `teamctl message resolve <message-id> --target <discussion-target>` resolves one referenced Message in that scope.',
      '- Immediately before `message send` or Discussion `return no-output`, run `teamctl message check --target <discussion-target>` again and review everything it returns.',
      '- `teamctl message send --target <discussion-target> --body <text> [--mention <actor-id> ...] [--work-item-id <id> ...] [--artifact-version-id <version-id> ...]` stages the body and all references durably on this Local Computer, then asks Workspace to atomically freshness-check and publish them. Use `--body-file <path>` for any multi-line or long content (including paragraphs, lists, and code); use `--body` only for one-line text. A literal `\\n` in `--body` is not converted to a line break.',
      '- A successful command returns `status: "published"`. `status: "held"` is a normal freshness result, not a tool failure: the candidate was not published and the receipt remains active.',
      '- After a hold choose exactly one path: revise with `message send --target ... --body ...` for one-line text or `message send --target ... --body-file <path>` for multi-line text; retry unchanged with `message send --target ... --send-draft`; inspect it with `message draft get --target ...` and stay silent with `message draft discard --target ...`; or, only after at least one hold, knowingly publish with `message send --target ... --send-draft --anyway`.',
      '',
      '### Artifacts',
      '',
      '- `teamctl artifact read <artifact-id>` fetches the active Project Artifact and its latest readable version into the Agent work directory. The response includes the immutable `versionId` and version number used by Message references.',
      '- `teamctl artifact publish --file <path> [--artifact-id <id> --expected-latest-version-id <version-id>] [--artifact-name <name>] [--artifact-path <path>]` publishes one file as a new Artifact or appends a version to an existing Artifact. Publication records source Resource revisions/digests and optional Task/Message/batch provenance.',
      '- Derived Artifacts accept repeated `--parent-version-id <version-id>` flags at creation time; parents must be active versions in the same Project.',
      '- A concurrent append returns `status: "held"` with the expected/current latest version IDs and a durable draft. Inspect the current Artifact, then retry with `artifact publish --send-draft --draft-id ...`, discard with `artifact draft discard --draft-id ...`, or force after review with `artifact publish --send-draft --draft-id ... --anyway`.',
      '- A successful Artifact publication writes the Artifact and its Workspace change history. It does not create an Agent Inbox item or Runtime wake. Share an Artifact with another Agent by referencing it from a Message.',
      '',
      '### Completing without a Message',
      '',
      '- `teamctl return no-output --target <discussion-target>` completes a claimed Discussion when no Message is appropriate. It can return `status: "review_required"`; review its delta and decide again.',
      '- Every claimed target must finish with either `message send` or `return no-output`; otherwise it remains pending for recovery.',
      '- When a WorkItem Session includes a linked Discussion, complete both sides in this same Session: use `teamctl work-item ...` for the assigned task and `teamctl message check/send --target <discussion-target>` for the source Conversation reply. Do not wait for or create another Session.',
      '',
      'On startup run both `teamctl work-item list` and `teamctl inbox check`. After every `Agent Inbox changed.` wake, inspect the Inbox, claim each pending target with the matching check command, handle all returned events, and explicitly complete every claimed target.',
    ].join('\n').replace(/\n{3,}/gu, '\n\n').trim();
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

  private insertFixedArtifactVersionReferences(
    workspaceId: string,
    messageId: string,
    projectId: string | null,
    versionIds: string[],
    timestamp: number,
  ): void {
    if (versionIds.length === 0) return;
    invariant(projectId, 'PROJECT_REQUIRED', 'Artifact Message references require a Project.', 400);
    const insertReference = this.workspaceDatabase.raw.prepare(
      `INSERT INTO message_artifact_version_references_v2 (
         workspace_id, message_id, reference_order, artifact_id, version_id,
         artifact_name_snapshot, version_number_snapshot, version_created_at_snapshot, file_name_snapshot,
         media_type_snapshot, content_digest_snapshot, byte_length_snapshot, status_snapshot, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    versionIds.forEach((versionId, index) => {
      const row = this.workspaceDatabase.raw.prepare(
        `SELECT a.id AS artifact_id, a.name, a.status AS artifact_status, v.id AS version_id,
                v.version_number, v.created_at AS version_created_at, v.file_name, v.media_type,
                v.content_digest, v.byte_length, v.status
         FROM project_artifacts_v2 a JOIN artifact_versions_v2 v ON v.artifact_id = a.id AND v.workspace_id = a.workspace_id
         WHERE a.workspace_id = ? AND a.project_id = ? AND v.id = ?`,
      ).get(workspaceId, projectId, versionId) as {
        artifact_id: string; name: string; artifact_status: 'active' | 'deleted' | 'purged'; version_id: string;
        version_number: number; version_created_at: number; file_name: string; media_type: string; content_digest: string; byte_length: number; status: 'active' | 'deleted' | 'purged';
      } | undefined;
      invariant(row, 'ARTIFACT_VERSION_NOT_FOUND', 'Artifact version does not belong to this Project.', 404);
      insertReference.run(workspaceId, messageId, index, row.artifact_id, row.version_id, row.name,
        row.version_number, row.version_created_at, row.file_name, row.media_type, row.content_digest,
        row.byte_length, row.status === 'active' && row.artifact_status === 'active' ? 'active' : row.status, timestamp);
    });
  }

  private insertAgentMessageReferences(
    workspaceId: string,
    messageId: string,
    projectId: string | null,
    workItemIds: string[],
    mentions: ConversationParticipantRow[],
    timestamp: number,
  ): void {
    const distinctWorkItemIds = [...new Set(workItemIds.map((id) => id.trim()).filter(Boolean))];
    invariant(distinctWorkItemIds.length <= 50, 'TOO_MANY_WORK_ITEM_REFERENCES', 'A Message may reference at most 50 WorkItems.', 400);
    if (distinctWorkItemIds.length > 0) {
      invariant(projectId, 'WORK_ITEM_REFERENCE_PROJECT_REQUIRED', 'WorkItem references are only available in Project Conversations.', 409);
      const insert = this.workspaceDatabase.raw.prepare(
        `INSERT INTO message_work_item_references_v2
          (workspace_id, project_id, message_id, reference_order, work_item_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const [index, workItemId] of distinctWorkItemIds.entries()) {
        const workItem = this.requireWorkItem(workItemId);
        invariant(workItem.workspace_id === workspaceId && workItem.project_id === projectId,
          'WORK_ITEM_REFERENCE_NOT_IN_PROJECT', 'Referenced WorkItem does not belong to this Project.', 409);
        insert.run(workspaceId, projectId, messageId, index, workItemId, timestamp);
      }
    }
    for (const [index, mention] of mentions.entries()) {
      this.workspaceDatabase.raw.prepare(
        `INSERT INTO message_mentions (
           id, workspace_id, message_id, actor_id, actor_type_snapshot,
           display_name_snapshot, mention_order, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(newId(), workspaceId, messageId, mention.actor_id, mention.actor_type,
        mention.display_name, index, timestamp);
    }
  }

  private publishAgentMessage(
    context: ExecutionContextRow,
    body: string,
    artifactIds: string[],
    mentionedActorIds: string[] = [],
    workItemIds: string[] = [],
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
    this.insertFixedArtifactVersionReferences(context.workspace_id, messageId, context.project_id, artifactIds, timestamp);
    const mentions = this.resolveAgentMessageMentions(
      context.workspace_id, context.conversation_id, context.project_id, mentionedActorIds,
    );
    this.insertAgentMessageReferences(context.workspace_id, messageId, context.project_id, workItemIds, mentions, timestamp);
    this.appendChange(
      context.workspace_id, null, context.conversation_id, conversationVersion,
      'message_created', 'message', messageId,
      { threadId: context.result_thread_id, scopePosition, producingRunId: context.run_id }, timestamp,
      context.project_id ? {
        projectId: context.project_id,
        projectVersion: this.requireProject(context.project_id).context_version,
      } : {},
    );
    this.markOwnMessageDelivered(context.workspace_id, context.agent_id, messageId, timestamp);
    this.appendAudit(
      context.workspace_id, context.agent_id, context.agent_membership_id,
      'message.post', 'message', messageId,
      { runId: context.run_id, attemptId: context.attempt_id }, timestamp,
    );
    return this.hydrateMessage(this.requireMessage(messageId), this.requireMembership(context.workspace_id, context.agent_id));
  }

  private publishPersistentAgentMessage(
    workspaceId: string,
    agentId: string,
    conversationId: string,
    threadId: string | null,
    body: string,
    artifactIds: string[],
    mentionedActorIds: string[],
    workItemIds: string[],
    bindingRevision: number,
    timestamp: number,
  ): MessageView {
    const normalizedBody = body.trim();
    invariant(normalizedBody.length > 0, 'INVALID_MESSAGE', 'Agent Message body is required.');
    const membership = this.requireMembership(workspaceId, agentId);
    invariant(this.hasConversationAccess(workspaceId, conversationId, membership.id),
      'CONVERSATION_NOT_FOUND', 'Conversation is not accessible to this Agent.', 404);
    const conversation = this.workspaceDatabase.raw.prepare(
      'SELECT * FROM conversations WHERE workspace_id = ? AND id = ?',
    ).get(workspaceId, conversationId) as ConversationAccess['conversation'] | undefined;
    invariant(conversation, 'CONVERSATION_NOT_FOUND', 'Conversation does not exist.', 404);
    this.requireConversationWritable(conversation);
    const projectMembership = conversation.project_id === null ? null : this.workspaceDatabase.raw.prepare(
      `SELECT id FROM project_memberships
       WHERE workspace_id = ? AND project_id = ? AND workspace_membership_id = ? AND status = 'active'`,
    ).get(workspaceId, conversation.project_id, membership.id) as { id: string } | undefined;
    invariant(conversation.project_id === null || projectMembership,
      'PROJECT_MEMBERSHIP_REQUIRED', 'Agent is not an active Project member.', 403);
    const conversationVersion = this.bumpConversationContext(conversationId, null, timestamp);
    const scopePosition = this.advanceDiscussionFrontier(workspaceId, conversationId, threadId);
    const messageId = newId();
    this.workspaceDatabase.raw.prepare(
      `INSERT INTO messages (
         id, workspace_id, conversation_id, project_id, thread_id,
         author_actor_id, author_membership_id, author_project_membership_id,
         body, conversation_version, scope_position, producing_run_id, producing_attempt_id,
         created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
    ).run(
      messageId,
      workspaceId,
      conversationId,
      conversation.project_id,
      threadId,
      agentId,
      membership.id,
      projectMembership?.id ?? null,
      normalizedBody,
      conversationVersion,
      scopePosition,
      timestamp,
    );
    this.insertFixedArtifactVersionReferences(workspaceId, messageId, conversation.project_id, artifactIds, timestamp);
    const mentions = this.resolveAgentMessageMentions(workspaceId, conversationId, conversation.project_id, mentionedActorIds);
    this.insertAgentMessageReferences(workspaceId, messageId, conversation.project_id, workItemIds, mentions, timestamp);
    this.appendChange(
      workspaceId,
      null,
      conversationId,
      conversationVersion,
      'message_created',
      'message',
      messageId,
      { threadId, scopePosition, runtimeBindingRevision: bindingRevision },
      timestamp,
      conversation.project_id ? {
        projectId: conversation.project_id,
        projectVersion: this.requireProject(conversation.project_id).context_version,
      } : {},
    );
    this.markOwnMessageDelivered(workspaceId, agentId, messageId, timestamp);
    this.appendAudit(
      workspaceId,
      agentId,
      membership.id,
      'message.post',
      'message',
      messageId,
      { runtimeBindingRevision: bindingRevision, source: 'persistent_agent_session' },
      timestamp,
    );
    return this.hydrateMessage(this.requireMessage(messageId), membership);
  }

  private markOwnMessageDelivered(
    workspaceId: string,
    agentId: string,
    messageId: string,
    timestamp: number,
  ): void {
    this.workspaceDatabase.raw.prepare(
      `UPDATE agent_inbox_items
       SET state = 'handled', handled_at = ?
       WHERE workspace_id = ? AND agent_id = ? AND message_id = ?
         AND attention_kind = 'discussion_change' AND state = 'pending'`,
    ).run(timestamp, workspaceId, agentId, messageId);
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
