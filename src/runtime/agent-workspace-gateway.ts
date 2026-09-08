import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, delimiter, relative, resolve } from 'node:path';
import { lookup as lookupMediaType } from 'mime-types';
import type {
  AgentDiscussionBindingView,
  AgentSessionRef,
  AgentSessionWindowView,
} from '../domain/types.js';
import { invariant } from '../lib/errors.js';
import { canonicalJson, newId, sha256 } from '../lib/values.js';
import { MAX_ARTIFACT_BYTES } from '../storage/content-blob-store.js';
import {
  HeldArtifactDraftStore,
  type HeldArtifactDraftRow,
  type HeldArtifactPublication,
} from '../storage/held-artifact-draft-store.js';
import { HeldDraftStore, type HeldDraftRow } from '../storage/held-draft-store.js';

const MAX_WORKSPACE_OPERATIONS = 151;
const MAX_FINAL_MESSAGE_BYTES = 100_000;
const MAX_IPC_REQUEST_BYTES = 512_000;

type MessageSendCommand = {
  kind: 'message.send';
  target: string;
  receipt: string;
  messageId: string;
  artifactVersionIds?: string[];
  mentionedActorIds?: string[];
  workItemIds?: string[];
};

type ArtifactPublishCommand = {
  kind: 'artifact.publish';
  filePath: string;
  fileName: string;
  mediaType: string;
  artifactId?: string;
  artifactName?: string;
  artifactPath?: string;
  expectedLatestVersionId?: string;
  parentVersionIds?: string[];
  sourceResourceRefs?: Array<{ resourceId: string; revision?: number; digest?: string }>;
  taskId?: string;
  messageId?: string;
  publishBatchId?: string;
  note?: string;
  draftId?: string;
};

type NoOutputCommand = { kind: 'return.no_output'; target: string; receipt: string };
type AgentWorkspaceOperation = MessageSendCommand | ArtifactPublishCommand | NoOutputCommand;

interface ReceiptState {
  receipt: string;
  throughPosition: number;
}

type FreshnessReviewKind = 'message' | 'artifact' | 'completion';

interface MessagePublicationResult {
  status: 'published' | 'held';
  message?: { id: string };
  draftId?: string;
  expectedDiscussionFrontier?: number;
  currentDiscussionFrontier?: number;
  attention?: unknown[];
  discussionDelta?: unknown;
}

interface InboxCompletionResult {
  status: 'completed' | 'review_required';
  receipt?: string;
  handledAt?: number;
  expectedDiscussionFrontier?: number;
  currentDiscussionFrontier?: number;
  attention?: unknown[];
  discussionDelta?: unknown;
  sessionWindow?: AgentSessionWindowView;
}

interface ArtifactPublicationResult {
  status: 'published' | 'held';
  artifact?: { artifactId: string; latestVersionId?: string | null };
  version?: { versionId: string; version: number; digest: string };
  created?: boolean;
  draftId?: string;
  artifactId?: string | null;
  expectedLatestVersionId?: string | null;
  currentLatestVersionId?: string | null;
  proposedDigest?: string;
}

interface ArtifactDraftDiscardResult {
  status: 'discarded';
  draftId?: string;
  discardedAt?: number;
}

export interface WorkspaceAgentGatewayApi {
  request<T>(path: string, request: {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    body?: unknown;
    idempotencyKey?: string;
  }): Promise<T>;
  uploadFile?<T>(
    path: string,
    input: { filePath: string; fileName: string; mediaType: string; fields?: Record<string, string>; idempotencyKey?: string },
  ): Promise<T>;
}

export interface AgentWorkspaceGatewayEnvironment {
  env: Record<string, string>;
}

/**
 * Agent-facing Local Computer gateway for bidirectional Workspace operations.
 *
 * Its local capability is fenced to the active Agent Runtime Binding revision;
 * the per-request Agent ACP session never receives a Computer token or a
 * writable journal path. The Local Computer validates and proxies every call.
 */
export class AgentWorkspaceGateway {
  private readonly binRoot: string;
  private readonly socketPath: string;
  private readonly token = randomBytes(32).toString('hex');
  private readonly receipts = new Map<string, ReceiptState>();
  private activeProjectId: string | null = null;
  private server: Server | null = null;
  private prepared = false;
  private terminalCommandRevision = 0;
  private workspaceActivityRevision = 0;
  private operationCount = 0;
  private readonly pendingFreshnessReviews = new Map<string, FreshnessReviewKind>();
  private window: AgentSessionWindowView;

  constructor(
    private readonly agentRoot: string,
    private readonly workingDirectory: string,
    private readonly session: AgentSessionRef,
    private readonly sessionTarget: string | null,
    private readonly projectId: string | null,
    private readonly workspaceId: string,
    private readonly agentId: string,
    private readonly bindingRevision: number,
    private readonly api: WorkspaceAgentGatewayApi,
    private readonly heldDrafts: HeldDraftStore,
    private readonly heldArtifactDrafts: HeldArtifactDraftStore,
    initialDiscussionFrontier: number | null = null,
    sessionWindow: AgentSessionWindowView = {
      mode: 'isolated',
      acceptedMessages: 1,
      maxMessages: 10,
      status: 'accepting',
    },
    private readonly discussion: AgentDiscussionBindingView | null = null,
  ) {
    this.initialDiscussionFrontier = initialDiscussionFrontier;
    this.window = { ...sessionWindow };
    this.activeProjectId = projectId;
    this.binRoot = resolve(agentRoot, 'bin');
    this.socketPath = process.platform === 'win32'
      ? `\\\\.\\pipe\\anc-teamctl-${this.sessionKey()}-${randomBytes(8).toString('hex')}`
      : resolve(tmpdir(), `anc-teamctl-${createHash('sha256').update(agentRoot).digest('hex').slice(0, 24)}.sock`);
  }

  private readonly initialDiscussionFrontier: number | null;

  get sessionWindow(): AgentSessionWindowView {
    return { ...this.window };
  }

  private heldMessage(target: string): HeldDraftRow | undefined {
    return this.heldDrafts.getActive(
      this.workspaceId, this.agentId, this.bindingRevision,
      this.session.kind, this.session.key, target,
    );
  }

  private heldArtifactById(id: string): HeldArtifactDraftRow | undefined {
    return this.heldArtifactDrafts.getActiveById(
      this.workspaceId, this.agentId, this.bindingRevision,
      this.session.kind, this.session.key, id,
    );
  }

  private heldArtifactByKey(key: string): HeldArtifactDraftRow | undefined {
    return this.heldArtifactDrafts.getActiveByKey(
      this.workspaceId, this.agentId, this.bindingRevision,
      this.session.kind, this.session.key, key,
    );
  }

  private requireSessionKind(kind: AgentSessionRef['kind'], message: string): void {
    invariant(this.session.kind === kind, 'SESSION_SCOPE_MISMATCH', message, 409);
  }

  private requireWorkItemSession(workItemId: string): void {
    this.requireSessionKind('work_item', 'This command is only available in a WorkItem Session.');
    invariant(this.session.key === workItemId, 'SESSION_SCOPE_MISMATCH',
      'The WorkItem is outside the active Session.', 409);
  }

  /**
   * A normal Mention Session gets its Discussion capability from its own
   * identity.  A WorkItem created from a Mention gets the same capability as
   * an explicit binding, so both obligations can be completed by one Runtime
   * Session.
   */
  private discussionBinding(): AgentDiscussionBindingView {
    if (this.session.kind === 'mention') {
      invariant(this.sessionTarget, 'SESSION_SCOPE_MISMATCH',
        'The Mention Session has no Discussion target.', 409);
      return {
        target: this.sessionTarget,
        agentRequestId: this.session.key,
        initialDiscussionFrontier: this.initialDiscussionFrontier ?? 0,
        sessionWindow: this.window,
      };
    }
    invariant(this.discussion, 'SESSION_SCOPE_MISMATCH',
      'This WorkItem Session has no linked Discussion.', 409);
    return this.discussion;
  }

  private requireDiscussionTarget(value: unknown, operation: string): AgentDiscussionBindingView {
    const binding = this.discussionBinding();
    invariant(typeof value === 'string', 'INVALID_WORKSPACE_COMMAND', `${operation} requires target.`, 400);
    this.parseTarget(value);
    invariant(value === binding.target, 'SESSION_SCOPE_MISMATCH',
      'The Discussion is outside the active Session.', 409);
    return binding;
  }

  private isCompositeWorkItemSession(): boolean {
    return this.session.kind === 'work_item' && this.discussion !== null;
  }

  async prepare(): Promise<AgentWorkspaceGatewayEnvironment> {
    invariant(!this.prepared, 'TEAMCTL_BINDING_ALREADY_PREPARED', 'Agent Workspace gateway is already prepared.', 409);
    this.prepared = true;
    this.heldDrafts.fenceOtherBindings(this.workspaceId, this.agentId, this.bindingRevision);
    this.heldArtifactDrafts.fenceOtherBindings(this.workspaceId, this.agentId, this.bindingRevision);
    for (const draft of this.heldDrafts.listActive(
      this.workspaceId, this.agentId, this.bindingRevision, this.session.kind, this.session.key,
    )) {
      this.receipts.set(draft.target, {
        receipt: draft.receipt,
        throughPosition: draft.reviewed_through_position,
      });
      if (draft.status === 'pending') await this.reconcilePendingDraft(draft);
    }
    for (const draft of this.heldArtifactDrafts.listActive(
      this.workspaceId, this.agentId, this.bindingRevision, this.session.kind, this.session.key,
    )) {
      if (draft.status === 'pending') await this.reconcilePendingArtifactDraft(draft);
    }
    for (const draft of this.heldDrafts.listActive(
      this.workspaceId, this.agentId, this.bindingRevision, this.session.kind, this.session.key,
    )) {
      if (draft.status === 'held') this.requireFreshnessReview('message', draft.target);
    }
    for (const draft of this.heldArtifactDrafts.listActive(
      this.workspaceId, this.agentId, this.bindingRevision, this.session.kind, this.session.key,
    )) {
      if (draft.status === 'held') this.requireFreshnessReview('artifact', draft.id);
    }
    mkdirSync(this.binRoot, { recursive: true, mode: 0o700 });
    const executablePath = resolve(this.binRoot, process.platform === 'win32' ? 'teamctl.mjs' : 'teamctl');
    writeFileSync(executablePath, this.cliSource(), { encoding: 'utf8', mode: 0o700 });
    if (process.platform !== 'win32') chmodSync(executablePath, 0o700);
    if (process.platform === 'win32') {
      const cmdPath = resolve(this.binRoot, 'teamctl.cmd');
      const node = process.execPath.replaceAll('"', '""');
      writeFileSync(cmdPath, `@"${node}" "%~dp0teamctl.mjs" %*\r\n`, { encoding: 'utf8', mode: 0o700 });
    }
    if (process.platform !== 'win32') rmSync(this.socketPath, { force: true });
    this.server = createServer((socket) => this.handleConnection(socket));
    await new Promise<void>((resolveListen, rejectListen) => {
      const server = this.server!;
      const onError = (error: Error): void => rejectListen(error);
      server.once('error', onError);
      server.listen(this.socketPath, () => {
        server.off('error', onError);
        resolveListen();
      });
    });
    return {
      env: {
        PATH: `${this.binRoot}${delimiter}${process.env.PATH ?? ''}`,
        ANC_TEAMCTL_SOCKET: this.socketPath,
        ANC_TEAMCTL_TOKEN: this.token,
        ANC_TEAMCTL_WORK_DIR: realpathSync(this.workingDirectory),
        ...(this.projectId ? { ANC_TEAMCTL_PROJECT_ID: this.projectId } : {}),
      },
    };
  }

  get terminalRevision(): number {
    return this.terminalCommandRevision;
  }

  get activityRevision(): number {
    return this.workspaceActivityRevision;
  }

  takeFreshnessReviewPrompt(): string | null {
    const reviews = [...this.pendingFreshnessReviews.entries()];
    this.pendingFreshnessReviews.clear();
    if (reviews.length === 0) return null;
    const descriptions = reviews.map(([target, kind]) => {
      if (kind === 'artifact') {
        return `- Held Artifact draft ${target}: read its current Artifact, then revise, retry unchanged, discard, or knowingly publish anyway.`;
      }
      if (kind === 'message') {
        return `- Held Message draft for ${target}: re-check the Discussion, then revise, retry unchanged, discard, or knowingly publish anyway.`;
      }
      return `- No-output decision for ${target}: re-check the Discussion and make the decision again.`;
    });
    return [
      'Freshness review required. A prior publication or completion decision was not committed because its checked state changed.',
      ...descriptions,
      'For a held Message or no-output decision, re-check its Discussion. For a held Artifact, run `teamctl artifact draft get --draft-id <draft-id>`, then `teamctl artifact read <artifact-id>` before retrying. A held draft remains unpublished.',
    ].join('\n');
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server?.listening) {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
    if (process.platform !== 'win32') rmSync(this.socketPath, { force: true });
  }

  private handleConnection(socket: Socket): void {
    let body = '';
    let handled = false;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      if (handled) return;
      body += chunk;
      if (Buffer.byteLength(body, 'utf8') > MAX_IPC_REQUEST_BYTES) {
        this.reply(socket, { ok: false, error: 'teamctl request exceeds the IPC limit.' });
        socket.destroy();
        return;
      }
      const newline = body.indexOf('\n');
      if (newline < 0) return;
      handled = true;
      const line = body.slice(0, newline);
      body = '';
      void (async () => {
        const request = JSON.parse(line) as { token?: unknown; command?: unknown };
        invariant(request.token === this.token, 'TEAMCTL_IPC_UNAUTHORIZED', 'teamctl Agent session capability is invalid.', 403);
        const result = await this.executeCommand(request.command);
        this.reply(socket, { ok: true, ...result });
      })().catch((error: unknown) => {
        this.reply(socket, { ok: false, error: error instanceof Error ? error.message : String(error) });
      });
    });
  }

  private async executeCommand(value: unknown): Promise<Record<string, unknown>> {
    invariant(typeof value === 'object' && value !== null, 'INVALID_WORKSPACE_COMMAND',
      'Workspace command must be an object.', 409);
    const raw = value as Record<string, unknown>;
    if (raw.kind === 'work_item.list') {
      invariant(raw.projectId === undefined || typeof raw.projectId === 'string',
        'INVALID_WORKSPACE_COMMAND', 'work-item list projectId is invalid.', 400);
      const projectId = typeof raw.projectId === 'string'
        ? raw.projectId
        : this.activeProjectId ?? this.projectId;
      invariant(projectId, 'PROJECT_REQUIRED', 'WorkItem listing requires an active Project or --project-id.', 409);
      const result = await this.api.request<{ items: unknown[] }>(
        `/v1/computers/self/agents/${this.agentId}/work-items?projectId=${encodeURIComponent(projectId)}`,
        { method: 'GET' },
      );
      return { kind: raw.kind, result };
    }
    if (raw.kind === 'work_item.read') {
      invariant(typeof raw.workItemId === 'string',
        'INVALID_WORKSPACE_COMMAND', 'work-item read requires workItemId.', 400);
      const [workItem, comments] = await Promise.all([
        this.api.request<Record<string, unknown>>(
          `/v1/computers/self/agents/${this.agentId}/work-items/${raw.workItemId}`,
          { method: 'GET' },
        ),
        this.api.request<{ items: unknown[] }>(
          `/v1/computers/self/agents/${this.agentId}/work-items/${raw.workItemId}/comments`,
          { method: 'GET' },
        ),
      ]);
      return { kind: raw.kind, result: { ...workItem, comments: comments.items } };
    }
    if (raw.kind === 'work_item.block') {
      this.requireOperationCapacity();
      invariant(typeof raw.workItemId === 'string',
        'INVALID_WORKSPACE_COMMAND', 'work-item block requires workItemId.', 400);
      this.requireWorkItemSession(raw.workItemId);
      invariant(typeof raw.reason === 'string' && raw.reason.trim().length > 0,
        'INVALID_WORKSPACE_COMMAND', 'work-item block requires a reason.', 400);
      const current = await this.api.request<{ revision: number; assignmentRevision: number }>(
        `/v1/computers/self/agents/${this.agentId}/work-items/${raw.workItemId}`,
        { method: 'GET' },
      );
      const result = await this.api.request<Record<string, unknown>>(
        `/v1/computers/self/agents/${this.agentId}/work-items/${raw.workItemId}/block`,
        {
          method: 'POST',
          body: {
            reason: raw.reason.trim(),
            expectedRevision: current.revision,
            expectedAssignmentRevision: current.assignmentRevision,
          },
          idempotencyKey: `work-item-block:${raw.workItemId}:${current.revision}:${current.assignmentRevision}`,
        },
      );
      this.recordActivity();
      return { kind: raw.kind, result };
    }
    if (raw.kind === 'work_item.comment') {
      this.requireOperationCapacity();
      invariant(typeof raw.workItemId === 'string',
        'INVALID_WORKSPACE_COMMAND', 'work-item comment requires workItemId.', 400);
      this.requireWorkItemSession(raw.workItemId);
      invariant(typeof raw.body === 'string' && raw.body.trim().length > 0,
        'INVALID_WORKSPACE_COMMAND', 'work-item comment requires a body.', 400);
      invariant(raw.mentionedActorIds === undefined
        || (Array.isArray(raw.mentionedActorIds) && raw.mentionedActorIds.every((id) => typeof id === 'string')),
      'INVALID_WORKSPACE_COMMAND', 'work-item comment mentions are invalid.', 400);
      invariant(raw.workItemIds === undefined
        || (Array.isArray(raw.workItemIds) && raw.workItemIds.every((id) => typeof id === 'string')),
      'INVALID_WORKSPACE_COMMAND', 'work-item comment WorkItem references are invalid.', 400);
      invariant(raw.artifactSelections === undefined
        || (Array.isArray(raw.artifactSelections) && raw.artifactSelections.every((selection) => {
          return typeof selection === 'object' && selection !== null
            && typeof (selection as Record<string, unknown>).artifactId === 'string'
            && typeof (selection as Record<string, unknown>).artifactVersionId === 'string';
        })),
      'INVALID_WORKSPACE_COMMAND', 'work-item comment Artifact references are invalid.', 400);
      const result = await this.api.request<Record<string, unknown>>(
        `/v1/computers/self/agents/${this.agentId}/work-items/${raw.workItemId}/comments`,
        {
          method: 'POST',
          body: {
            body: raw.body.trim(),
            mentionedActorIds: raw.mentionedActorIds ?? [],
            workItemIds: this.stringArray(raw.workItemIds, 'workItemIds'),
            artifactSelections: (raw.artifactSelections as Array<{ artifactId: string; artifactVersionId: string }> | undefined) ?? [],
          },
          idempotencyKey: `work-item-comment:${raw.workItemId}:${newId()}`,
        },
      );
      this.recordActivity();
      return { kind: raw.kind, result };
    }
    if (raw.kind === 'work_item.submit') {
      this.requireOperationCapacity();
      invariant(typeof raw.workItemId === 'string',
        'INVALID_WORKSPACE_COMMAND', 'work-item submit requires workItemId.', 400);
      this.requireWorkItemSession(raw.workItemId);
      invariant(raw.commentId === undefined || raw.commentId === null || typeof raw.commentId === 'string',
        'INVALID_WORKSPACE_COMMAND', 'work-item submit commentId is invalid.', 400);
      const inputArtifactVersionIds = raw.artifactVersionIds;
      invariant(inputArtifactVersionIds === undefined
        || (Array.isArray(inputArtifactVersionIds) && inputArtifactVersionIds.every((id) => typeof id === 'string')),
      'INVALID_WORKSPACE_COMMAND', 'work-item submit Artifact versions are invalid.', 400);
      const artifactVersionIds = inputArtifactVersionIds === undefined
        ? []
        : this.stringArray(inputArtifactVersionIds, 'artifactVersionIds');
      invariant(inputArtifactVersionIds === undefined || artifactVersionIds.length === inputArtifactVersionIds.length,
        'INVALID_WORKSPACE_COMMAND', 'work-item submit Artifact versions must be unique.', 400);
      invariant(raw.commentId !== undefined && raw.commentId !== null || artifactVersionIds.length > 0,
        'INVALID_WORKSPACE_COMMAND', 'work-item submit requires a comment or at least one Artifact version.', 400);
      invariant(artifactVersionIds.length <= 100,
        'INVALID_WORKSPACE_COMMAND', 'work-item submit may reference at most 100 Artifact versions.', 400);
      const current = await this.api.request<{ revision: number; assignmentRevision: number }>(
        `/v1/computers/self/agents/${this.agentId}/work-items/${raw.workItemId}`,
        { method: 'GET' },
      );
      const result = await this.api.request<Record<string, unknown>>(
        `/v1/computers/self/agents/${this.agentId}/work-items/${raw.workItemId}/submissions`,
        {
          method: 'POST',
          body: {
            ...(raw.commentId === undefined || raw.commentId === null ? {} : { commentId: raw.commentId }),
            ...(artifactVersionIds.length > 0 ? { artifactVersionIds } : {}),
            expectedRevision: current.revision,
            expectedAssignmentRevision: current.assignmentRevision,
          },
          idempotencyKey: `work-item-submit:${raw.workItemId}:${raw.commentId}:${current.revision}:${current.assignmentRevision}`,
        },
      );
      this.recordActivity();
      return { kind: raw.kind, result };
    }
    if (raw.kind === 'inbox.check') {
      const summary = await this.api.request<Record<string, unknown>>(
        `/v1/computers/self/agents/${this.agentId}/inbox`,
        { method: 'GET' },
      );
      const discussionTarget = this.discussion?.target ?? null;
      const targets = Array.isArray(summary.targets)
        ? summary.targets.filter((target) => target && typeof target === 'object'
          && ((target as { target?: unknown }).target === this.sessionTarget
            || discussionTarget !== null && (target as { target?: unknown }).target === discussionTarget))
        : [];
      const sessionTriggers = Array.isArray(summary.sessionTriggers)
        ? summary.sessionTriggers.filter((trigger) => trigger && typeof trigger === 'object'
          && (trigger as { session?: { kind?: unknown; key?: unknown } }).session?.kind === this.session.kind
          && (trigger as { session?: { kind?: unknown; key?: unknown } }).session?.key === this.session.key)
        : [];
      return { kind: raw.kind, result: { ...summary, targets, sessionTriggers } };
    }
    if (raw.kind === 'message.check') {
      const discussionBinding = this.requireDiscussionTarget(raw.target, 'message check');
      const receipt = this.receiptFor(discussionBinding.target);
      const claim = await this.api.request<Record<string, unknown>>(
        `/v1/computers/self/agents/${this.agentId}/inbox/claim`,
        {
          method: 'POST',
          body: {
            target: discussionBinding.target,
            receipt,
            agentRequestId: discussionBinding.agentRequestId,
            initialDiscussionFrontier: discussionBinding.initialDiscussionFrontier,
          },
          idempotencyKey: `claim:${receipt}`,
        },
      );
      const discussion = claim.discussion as { throughPosition?: unknown; messages?: Array<{ projectId?: unknown }> }
        | null
        | undefined;
      const receiptState = {
        receipt: String(claim.receipt ?? receipt),
        throughPosition: Number(discussion?.throughPosition ?? 0),
      };
      this.receipts.set(discussionBinding.target, receiptState);
      const returnedWindow = claim.sessionWindow as AgentSessionWindowView | undefined;
      if (returnedWindow && typeof returnedWindow === 'object' && !this.isCompositeWorkItemSession()) {
        this.window = {
          mode: returnedWindow.mode === 'dm' ? 'dm' : 'isolated',
          acceptedMessages: Math.min(Math.max(Number(returnedWindow.acceptedMessages) || 0, 0), 10),
          maxMessages: 10,
          status: returnedWindow.status === 'frozen' ? 'frozen' : returnedWindow.status === 'completed' ? 'completed' : 'accepting',
        };
      }
      const heldDraft = this.heldMessage(discussionBinding.target);
      if (heldDraft?.status === 'held') {
        this.heldDrafts.markReviewed(heldDraft.id, receiptState.receipt, receiptState.throughPosition);
      }
      const projectId = discussion?.messages?.find((message) => typeof message.projectId === 'string')?.projectId;
      // A Mention Session starts with its source message already materialized
      // in the Session JSONL. When the claim frontier is exactly that source
      // position, the returned discussion delta is legitimately empty. Do not
      // erase the project scope that was established at session creation just
      // because this incremental claim has no project-bearing messages.
      if (typeof projectId === 'string') this.activeProjectId = projectId;
      return { kind: raw.kind, result: claim };
    }
    if (raw.kind === 'message.read') {
      const discussionBinding = this.requireDiscussionTarget(raw.target, 'message read');
      const scope = this.parseTarget(discussionBinding.target);
      const params = new URLSearchParams({
        conversationId: scope.conversationId,
        ...(scope.threadId ? { threadId: scope.threadId } : {}),
      });
      if (raw.before !== undefined) params.set('before', String(raw.before));
      if (raw.after !== undefined) params.set('after', String(raw.after));
      if (raw.limit !== undefined) params.set('limit', String(raw.limit));
      const history = await this.api.request<Record<string, unknown>>(
        `/v1/computers/self/agents/${this.agentId}/messages?${params.toString()}`,
        { method: 'GET' },
      );
      return { kind: raw.kind, result: history };
    }
    if (raw.kind === 'message.resolve') {
      invariant(typeof raw.messageId === 'string', 'INVALID_WORKSPACE_COMMAND', 'message resolve requires messageId.', 400);
      const target = this.requireDiscussionTarget(raw.target, 'message resolve').target;
      const scope = this.parseTarget(target);
      const params = new URLSearchParams({
        conversationId: scope.conversationId,
        ...(scope.threadId ? { threadId: scope.threadId } : {}),
      });
      const message = await this.api.request<Record<string, unknown>>(
        `/v1/computers/self/agents/${this.agentId}/messages/${raw.messageId}?${params.toString()}`,
        { method: 'GET' },
      );
      return { kind: raw.kind, result: message };
    }
    if (raw.kind === 'message.draft_get') {
      const target = this.requireDiscussionTarget(raw.target, 'message draft get').target;
      const draft = this.heldMessage(target);
      invariant(draft, 'HELD_DRAFT_NOT_FOUND', 'No active held draft exists for this target.', 404);
      return { kind: raw.kind, result: this.presentDraft(draft) };
    }
    if (raw.kind === 'message.draft_discard') {
      this.requireOperationCapacity();
      const target = this.requireDiscussionTarget(raw.target, 'message draft discard').target;
      const draft = this.heldMessage(target);
      invariant(draft?.status === 'held', 'HELD_DRAFT_NOT_AVAILABLE',
        'No held draft is available for this target.', 409);
      return this.submitPendingDiscard(this.heldDrafts.prepareHeld(draft.id, 'discard'));
    }
    if (raw.kind === 'message.send') {
      this.requireOperationCapacity();
      const target = this.requireDiscussionTarget(raw.target, 'message send').target;
      const receipt = this.receipts.get(target);
      invariant(receipt, 'INBOX_TARGET_NOT_CLAIMED', 'Run message check for this target before sending.', 409);
      const sendDraft = raw.sendDraft === true;
      const anyway = raw.anyway === true;
      invariant(!anyway || sendDraft, 'INVALID_WORKSPACE_COMMAND', '--anyway requires --send-draft.', 400);
      let pending: HeldDraftRow;
      if (sendDraft) {
        invariant(raw.body === undefined, 'INVALID_WORKSPACE_COMMAND',
          '--send-draft cannot be combined with a new body.', 400);
        invariant(raw.artifactVersionIds === undefined, 'INVALID_WORKSPACE_COMMAND',
          '--send-draft cannot replace the held draft Artifact references.', 400);
        invariant(raw.mentionedActorIds === undefined && raw.workItemIds === undefined, 'INVALID_WORKSPACE_COMMAND',
          '--send-draft cannot replace held Message references.', 400);
        const draft = this.heldMessage(target);
        invariant(draft?.status === 'held', 'HELD_DRAFT_NOT_AVAILABLE',
          'No held draft is available for this target.', 409);
        pending = this.heldDrafts.prepareHeld(draft.id, anyway ? 'override' : 'check');
      } else {
        invariant(typeof raw.body === 'string' && raw.body.trim().length > 0,
          'INVALID_WORKSPACE_COMMAND', 'message send requires a non-empty body.', 400);
        invariant(Buffer.byteLength(raw.body, 'utf8') <= MAX_FINAL_MESSAGE_BYTES,
          'INVALID_WORKSPACE_COMMAND', 'Message exceeds the publication limit.', 400);
        const inputArtifactIds = raw.artifactVersionIds;
        invariant(inputArtifactIds === undefined || Array.isArray(inputArtifactIds),
          'INVALID_WORKSPACE_COMMAND', 'Message Artifact version references must be an array.', 400);
        const artifactIds = inputArtifactIds === undefined ? [] : this.stringArray(inputArtifactIds, 'artifactVersionIds');
        const inputArtifactCount = Array.isArray(inputArtifactIds) ? inputArtifactIds.length : 0;
        invariant(inputArtifactIds === undefined || artifactIds.length === inputArtifactCount,
          'INVALID_WORKSPACE_COMMAND', 'Message Artifact references must be unique.', 400);
        invariant(artifactIds.length <= 100, 'INVALID_WORKSPACE_COMMAND',
          'Message Artifact references may not exceed 100 items.', 400);
        const mentionedActorIds = this.stringArray(raw.mentionedActorIds, 'mentionedActorIds');
        const workItemIds = this.stringArray(raw.workItemIds, 'workItemIds');
        pending = this.heldDrafts.createOrReviseCandidate({
          workspaceId: this.workspaceId,
          agentId: this.agentId,
          bindingRevision: this.bindingRevision,
          sessionKind: this.session.kind,
          sessionKey: this.session.key,
          target,
          receipt: receipt.receipt,
          body: raw.body,
          artifactIds,
          mentionedActorIds,
          workItemIds,
          basedOnPosition: receipt.throughPosition,
        });
      }
      return this.submitPendingMessageDraft(pending);
    }
    if (raw.kind === 'return.no_output') {
      this.requireOperationCapacity();
      const target = this.requireDiscussionTarget(raw.target, 'return no-output').target;
      const receiptState = this.receipts.get(target);
      invariant(receiptState, 'INBOX_TARGET_NOT_CLAIMED', 'Claim this target before returning no output.', 409);
      const activeDraft = this.heldMessage(target);
      invariant(!activeDraft, 'HELD_DRAFT_DECISION_REQUIRED',
        'An active held draft must be published or discarded with message draft discard.', 409);
      const result = await this.api.request<InboxCompletionResult>(
        `/v1/computers/self/agents/${this.agentId}/inbox/complete`,
        {
          method: 'POST',
          body: {
            target,
            receipt: receiptState.receipt,
            expectedDiscussionFrontier: receiptState.throughPosition,
          },
          idempotencyKey: `inbox-complete:${receiptState.receipt}:${receiptState.throughPosition}`,
        },
      );
      if (result.status === 'review_required') {
        const current = Number(result.currentDiscussionFrontier);
        this.receipts.set(target, { receipt: receiptState.receipt, throughPosition: current });
        this.requireFreshnessReview('completion', target);
        this.recordActivity();
        return { kind: raw.kind, result };
      }
      const command: NoOutputCommand = {
        kind: 'return.no_output', target, receipt: receiptState.receipt,
      };
      this.recordOperation(command);
      this.receipts.delete(target);
      if (!this.isCompositeWorkItemSession()) this.window = { ...this.window, status: 'completed' };
      this.clearFreshnessReview(target);
      return { kind: raw.kind, result, terminalRevision: this.terminalCommandRevision };
    }
    if (raw.kind === 'artifact.read') {
      invariant(typeof raw.artifactId === 'string', 'INVALID_WORKSPACE_COMMAND', 'artifact read requires an Artifact ID.', 400);
      invariant(this.activeProjectId, 'PROJECT_REQUIRED', 'Artifact reads require an active Project.', 409);
      const result = await this.api.request<{ artifactId: string; name: string; latestVersionId: string | null; latestVersion?: { versionId: string; fileName: string; mediaType: string; status: string } | null; contentBase64?: string; mediaType?: string }>(`/v1/computers/self/agents/${this.agentId}/projects/${this.activeProjectId}/artifacts/${raw.artifactId}`, { method: 'GET' });
      this.heldArtifactDrafts.markReviewed(result.artifactId, result.latestVersionId);
      invariant(result.contentBase64 !== undefined && result.mediaType !== undefined,
        'INVALID_AGENT_ARTIFACT_READ', 'Workspace returned an Artifact without readable latest-version content.', 409);
      const artifactDirectory = resolve(this.workingDirectory, 'artifacts');
      mkdirSync(artifactDirectory, { recursive: true, mode: 0o700 });
      const filePath = resolve(artifactDirectory, `${result.artifactId}-${basename(result.latestVersion?.fileName ?? result.name)}`);
      writeFileSync(filePath, Buffer.from(result.contentBase64, 'base64'), { mode: 0o600 });
      return {
        kind: raw.kind,
        result: { artifact: result, mediaType: result.mediaType, filePath },
      };
    }
    if (raw.kind === 'resource.list') {
      invariant(this.activeProjectId, 'PROJECT_REQUIRED', 'Resource listing requires an active Project.', 409);
      const result = await this.api.request<{ items: Array<{ resourceId: string; name: string; path: string; kind: string; mediaType: string | null; byteLength: number | null }> }>(`/v1/computers/self/agents/${this.agentId}/projects/${this.activeProjectId}/resources`, { method: 'GET' });
      return { kind: raw.kind, result };
    }
    if (raw.kind === 'resource.read') {
      invariant(typeof raw.resourceId === 'string', 'INVALID_WORKSPACE_COMMAND', 'resource read requires a Resource ID.', 400);
      invariant(this.activeProjectId, 'PROJECT_REQUIRED', 'Resource reads require an active Project.', 409);
      const result = await this.api.request<{ resource: { resourceId: string; name: string; path: string; kind: string; mediaType: string | null; byteLength: number | null }; contentBase64?: string }>(`/v1/computers/self/agents/${this.agentId}/projects/${this.activeProjectId}/resources/${raw.resourceId}`, { method: 'GET' });
      invariant(result.resource.kind === 'file' && result.contentBase64 !== undefined,
        'RESOURCE_IS_DIRECTORY', 'Only file resources contain readable content.', 409);
      const resourceDirectory = resolve(this.workingDirectory, 'resources');
      mkdirSync(resourceDirectory, { recursive: true, mode: 0o700 });
      const filePath = resolve(resourceDirectory, `${result.resource.resourceId}-${basename(result.resource.name)}`);
      writeFileSync(filePath, Buffer.from(result.contentBase64, 'base64'), { mode: 0o600 });
      return {
        kind: raw.kind,
        result: { resource: result.resource, mediaType: result.resource.mediaType, filePath },
      };
    }
    if (raw.kind === 'artifact.draft_get') {
      invariant(typeof raw.draftId === 'string', 'INVALID_WORKSPACE_COMMAND', 'artifact draft get requires draftId.', 400);
      const draft = this.heldArtifactById(raw.draftId);
      invariant(draft, 'HELD_ARTIFACT_DRAFT_NOT_FOUND',
        'No active held Artifact draft exists.', 404);
      return { kind: raw.kind, result: this.presentArtifactDraft(draft) };
    }
    if (raw.kind === 'artifact.draft_discard') {
      this.requireOperationCapacity();
      invariant(typeof raw.draftId === 'string', 'INVALID_WORKSPACE_COMMAND', 'artifact draft discard requires draftId.', 400);
      const draft = this.heldArtifactById(raw.draftId);
      invariant(draft?.status === 'held', 'HELD_ARTIFACT_DRAFT_NOT_AVAILABLE',
        'No held Artifact draft is available.', 409);
      return this.submitPendingArtifactDiscard(this.heldArtifactDrafts.prepareHeld(draft.id, 'discard'));
    }
    if (raw.kind === 'artifact.publish' && raw.sendDraft === true) {
      this.requireOperationCapacity();
      invariant(typeof raw.draftId === 'string', 'INVALID_WORKSPACE_COMMAND',
        'artifact publish --send-draft requires draftId.', 400);
      const draft = this.heldArtifactById(raw.draftId);
      invariant(draft?.status === 'held', 'HELD_ARTIFACT_DRAFT_NOT_AVAILABLE',
        'No held Artifact draft is available.', 409);
      return this.submitPendingArtifactDraft(this.heldArtifactDrafts.prepareHeld(
        draft.id,
        raw.anyway === true ? 'override' : 'check',
      ));
    }
    if (raw.kind === 'artifact.publish') {
      this.requireOperationCapacity();
      const validated = this.validateCommand(raw, this.operationCount);
      invariant(validated.kind === 'artifact.publish', 'INVALID_AGENT_WORKSPACE_OPERATION',
        'Artifact publication command is invalid.', 409);
      invariant(this.activeProjectId, 'PROJECT_REQUIRED', 'Artifact publication requires an active Project.', 409);
      const command: ArtifactPublishCommand = validated;
      const requestedDraft = command.draftId
        ? this.heldArtifactById(command.draftId)
        : undefined;
      invariant(!command.draftId || requestedDraft?.status === 'held', 'HELD_ARTIFACT_DRAFT_NOT_AVAILABLE',
        'The Artifact draft selected for revision is unavailable.', 409);
      const draftKey = requestedDraft?.draft_key ?? (
        command.artifactId
          ? `artifact:${command.artifactId}`
          : `create:${newId()}`
      );
      const existing = requestedDraft ?? this.heldArtifactByKey(draftKey);
      invariant(!requestedDraft || requestedDraft.artifact_id === (command.artifactId ?? null), 'HELD_ARTIFACT_DRAFT_SCOPE_MISMATCH',
      'Artifact draft revision cannot change the target Artifact.', 409);
      invariant(existing?.status !== 'pending', 'HELD_ARTIFACT_DRAFT_PENDING',
        'The prior Artifact draft submission is still being reconciled.', 409);
      const draftId = existing?.id ?? newId();
      const resolvedDraftKey = draftKey.startsWith('create:') ? `create:${draftId}` : draftKey;
      const content = readFileSync(command.filePath);
      invariant(content.byteLength <= MAX_ARTIFACT_BYTES, 'ARTIFACT_FILE_TOO_LARGE',
        'Artifact files may not exceed 100 MiB.', 413);
      const contentDirectory = resolve(this.agentRoot, 'held-artifacts');
      mkdirSync(contentDirectory, { recursive: true, mode: 0o700 });
      const contentPath = resolve(contentDirectory, draftId);
      writeFileSync(contentPath, content, { mode: 0o600 });
      const publication: HeldArtifactPublication = {
        kind: 'file',
        fileName: command.fileName,
        mediaType: command.mediaType,
        ...(command.artifactName ? { artifactName: command.artifactName } : {}),
        ...(command.artifactPath ? { artifactPath: command.artifactPath } : {}),
        ...(command.artifactId ? { artifactId: command.artifactId } : {}),
        ...(command.expectedLatestVersionId ? { expectedLatestVersionId: command.expectedLatestVersionId } : {}),
        ...(command.parentVersionIds ? { parentVersionIds: command.parentVersionIds } : {}),
        ...(command.sourceResourceRefs ? { sourceResourceRefs: command.sourceResourceRefs } : {}),
        ...(command.taskId ? { taskId: command.taskId } : {}),
        ...(command.messageId ? { messageId: command.messageId } : {}),
        ...(command.publishBatchId ? { publishBatchId: command.publishBatchId } : {}),
        ...(command.note ? { note: command.note } : {}),
      };
      const proposedDigest = createHash('sha256').update(content).digest('hex');
      const pending = this.heldArtifactDrafts.createOrReviseCandidate({
        id: draftId,
        workspaceId: this.workspaceId,
        agentId: this.agentId,
        bindingRevision: this.bindingRevision,
        sessionKind: this.session.kind,
        sessionKey: this.session.key,
        draftKey: resolvedDraftKey,
        artifactId: command.artifactId ?? null,
        publication,
        contentPath,
        ...(command.expectedLatestVersionId ? { expectedLatestVersionId: command.expectedLatestVersionId } : {}),
        proposedDigest,
      });
      return this.submitPendingArtifactDraft(pending);
    }
    this.requireOperationCapacity();
    const command = this.validateCommand(raw, this.operationCount);
    this.recordOperation(command);
    return { kind: command.kind, terminalRevision: this.terminalCommandRevision };
  }

  private async reconcilePendingDraft(draft: HeldDraftRow): Promise<void> {
    if (draft.pending_mode === 'discard') {
      await this.submitPendingDiscard(draft);
      return;
    }
    await this.submitPendingMessageDraft(draft);
  }

  private async reconcilePendingArtifactDraft(draft: HeldArtifactDraftRow): Promise<void> {
    if (draft.pending_mode === 'discard') {
      await this.submitPendingArtifactDiscard(draft);
      return;
    }
    await this.submitPendingArtifactDraft(draft);
  }

  private async submitPendingArtifactDraft(draft: HeldArtifactDraftRow): Promise<Record<string, unknown>> {
    const publication = this.heldArtifactDrafts.publication(draft);
    invariant(draft.content_path && this.api.uploadFile, 'AGENT_ARTIFACT_UPLOAD_UNAVAILABLE',
      'Local Computer does not have the held Artifact content or upload support.', 409);
    invariant(this.activeProjectId, 'PROJECT_REQUIRED', 'Artifact publication requires an active Project.', 409);
    const fields: Record<string, string> = {
      draftId: draft.id,
      fileName: publication.fileName,
      mediaType: publication.mediaType,
      ...(publication.artifactId ? { artifactId: publication.artifactId } : {}),
      ...(publication.artifactName ? { artifactName: publication.artifactName } : {}),
      ...(publication.artifactPath ? { artifactPath: publication.artifactPath } : {}),
      ...(publication.expectedLatestVersionId ? { expectedLatestVersionId: publication.expectedLatestVersionId } : {}),
      ...(publication.parentVersionIds ? { parentVersionIds: JSON.stringify(publication.parentVersionIds) } : {}),
      ...(publication.sourceResourceRefs ? { sourceResourceRefs: JSON.stringify(publication.sourceResourceRefs) } : {}),
      ...(publication.taskId ? { taskId: publication.taskId } : {}),
      ...(publication.messageId ? { messageId: publication.messageId } : {}),
      ...(publication.publishBatchId ? { publishBatchId: publication.publishBatchId } : {}),
      ...(publication.note ? { note: publication.note } : {}),
    };
    let result: ArtifactPublicationResult;
    try {
      result = await this.api.uploadFile<ArtifactPublicationResult>(
        `/v1/computers/self/agents/${this.agentId}/projects/${this.activeProjectId}/artifacts`,
        {
          filePath: draft.content_path,
          fileName: publication.fileName,
          mediaType: publication.mediaType,
          fields,
          idempotencyKey: draft.idempotency_key,
        },
      );
    } catch (error) {
      const details = error && typeof error === 'object' && 'details' in error
        ? (error as { details?: unknown }).details : undefined;
      const code = error && typeof error === 'object' && 'code' in error
        ? (error as { code?: unknown }).code : undefined;
      if (code === 'ARTIFACT_VERSION_CONFLICT' && details && typeof details === 'object') {
        const held = details as { heldDraftId?: string; currentLatestVersionId?: string | null };
        if (held.heldDraftId) {
          const marked = this.heldArtifactDrafts.markHeld(draft.id, held.currentLatestVersionId ?? null, draft.proposed_digest);
          this.requireFreshnessReview('artifact', draft.id);
          this.recordActivity();
          return { kind: 'artifact.publish', result: { status: 'held', draftId: draft.id, artifactId: draft.artifact_id, expectedLatestVersionId: draft.expected_latest_version_id, currentLatestVersionId: held.currentLatestVersionId ?? null, proposedDigest: marked.proposed_digest, draft: this.presentArtifactDraft(marked) } };
        }
      }
      throw error;
    }
    if (result.status === 'held') {
      invariant(result.draftId === draft.id
        && (result.currentLatestVersionId === null || typeof result.currentLatestVersionId === 'string')
        && typeof result.proposedDigest === 'string',
        'INVALID_ARTIFACT_FRESHNESS_HOLD', 'Workspace returned an invalid Artifact freshness hold.', 409);
      const held = this.heldArtifactDrafts.markHeld(
        draft.id, result.currentLatestVersionId ?? null, result.proposedDigest,
      );
      this.requireFreshnessReview('artifact', draft.id);
      this.recordActivity();
      return { kind: 'artifact.publish', result: { ...result, draft: this.presentArtifactDraft(held) } };
    }
    invariant(result.artifact?.artifactId && result.version?.versionId, 'INVALID_ARTIFACT_PUBLICATION',
      'Workspace returned an invalid published Artifact result.', 409);
    this.heldArtifactDrafts.markPublished(draft.id);
    this.clearFreshnessReview(draft.id);
    this.recordActivity();
    return { kind: 'artifact.publish', result };
  }

  private async submitPendingArtifactDiscard(draft: HeldArtifactDraftRow): Promise<Record<string, unknown>> {
    invariant(this.activeProjectId, 'PROJECT_REQUIRED', 'Artifact draft operations require an active Project.', 409);
    const result = await this.api.request<ArtifactDraftDiscardResult>(
      `/v1/computers/self/agents/${this.agentId}/projects/${this.activeProjectId}/artifact-held-drafts/${draft.id}/discard`,
      {
        method: 'POST',
        idempotencyKey: draft.idempotency_key,
      },
    );
    invariant(result.draftId === draft.id, 'INVALID_ARTIFACT_DRAFT_DISCARD',
      'Workspace returned an invalid Artifact draft discard result.', 409);
    this.heldArtifactDrafts.markDiscarded(draft.id);
    this.clearFreshnessReview(draft.id);
    this.recordActivity();
    return {
      kind: 'artifact.draft_discard',
      result,
    };
  }

  private async submitPendingMessageDraft(draft: HeldDraftRow): Promise<Record<string, unknown>> {
    const scope = this.parseTarget(draft.target);
    const result = await this.api.request<MessagePublicationResult>(
      `/v1/computers/self/agents/${this.agentId}/messages`,
      {
        method: 'POST',
        body: {
          ...scope,
          receipt: draft.receipt,
          draftId: draft.id,
          expectedDiscussionFrontier: draft.reviewed_through_position,
          body: draft.body,
          artifactVersionIds: this.heldDrafts.artifactIds(draft),
          mentionedActorIds: this.heldDrafts.mentionedActorIds(draft),
          workItemIds: this.heldDrafts.workItemIds(draft),
          mode: draft.pending_mode === 'override' ? 'override' : 'check',
        },
        idempotencyKey: draft.idempotency_key,
      },
    );
    if (result.status === 'held') {
      invariant(result.draftId === draft.id && Number.isSafeInteger(result.currentDiscussionFrontier),
        'INVALID_FRESHNESS_HOLD', 'Workspace returned an invalid freshness hold.', 409);
      const current = Number(result.currentDiscussionFrontier);
      const held = this.heldDrafts.markHeld(draft.id, current);
      this.receipts.set(draft.target, { receipt: draft.receipt, throughPosition: current });
      this.requireFreshnessReview('message', draft.target);
      this.recordActivity();
      return { kind: 'message.send', result: { ...result, draft: this.presentDraft(held) } };
    }
    invariant(result.message?.id, 'INVALID_MESSAGE_PUBLICATION',
      'Workspace returned an invalid published Message result.', 409);
    this.heldDrafts.markPublished(draft.id);
    const command: MessageSendCommand = {
      kind: 'message.send', target: draft.target, receipt: draft.receipt, messageId: result.message.id,
      artifactVersionIds: this.heldDrafts.artifactIds(draft),
      mentionedActorIds: this.heldDrafts.mentionedActorIds(draft),
      workItemIds: this.heldDrafts.workItemIds(draft),
    };
    this.recordOperation(command);
      this.receipts.delete(draft.target);
    if (!this.isCompositeWorkItemSession()) this.window = { ...this.window, status: 'completed' };
    this.clearFreshnessReview(draft.target);
    return {
      kind: 'message.send',
      result,
      terminalRevision: this.terminalCommandRevision,
    };
  }

  private async submitPendingDiscard(draft: HeldDraftRow): Promise<Record<string, unknown>> {
    const result = await this.api.request<InboxCompletionResult>(
      `/v1/computers/self/agents/${this.agentId}/inbox/complete`,
      {
        method: 'POST',
        body: {
          target: draft.target,
          receipt: draft.receipt,
          expectedDiscussionFrontier: draft.reviewed_through_position,
          draftId: draft.id,
        },
        idempotencyKey: draft.idempotency_key,
      },
    );
    if (result.status === 'review_required') {
      invariant(Number.isSafeInteger(result.currentDiscussionFrontier),
        'INVALID_FRESHNESS_REVIEW', 'Workspace returned an invalid freshness review.', 409);
      const current = Number(result.currentDiscussionFrontier);
      const held = this.heldDrafts.markHeld(draft.id, current);
      this.receipts.set(draft.target, { receipt: draft.receipt, throughPosition: current });
      this.requireFreshnessReview('message', draft.target);
      this.recordActivity();
      return { kind: 'message.draft_discard', result: { ...result, draft: this.presentDraft(held) } };
    }
    this.heldDrafts.markDiscarded(draft.id);
    const command: NoOutputCommand = {
      kind: 'return.no_output', target: draft.target, receipt: draft.receipt,
    };
    this.recordOperation(command);
    this.receipts.delete(draft.target);
    if (!this.isCompositeWorkItemSession()) this.window = { ...this.window, status: 'completed' };
    this.clearFreshnessReview(draft.target);
    return {
      kind: 'message.draft_discard',
      result,
      terminalRevision: this.terminalCommandRevision,
    };
  }

  private presentDraft(draft: HeldDraftRow): Record<string, unknown> {
    return {
      draftId: draft.id,
      workspaceId: draft.workspace_id,
      agentId: draft.agent_id,
      bindingRevision: draft.binding_revision,
      target: draft.target,
      receipt: draft.receipt,
      body: draft.body,
      bodyHash: draft.body_hash,
      artifactVersionIds: this.heldDrafts.artifactIds(draft),
      mentionedActorIds: this.heldDrafts.mentionedActorIds(draft),
      workItemIds: this.heldDrafts.workItemIds(draft),
      basedOnPosition: draft.based_on_position,
      reviewedThroughPosition: draft.reviewed_through_position,
      reholdCount: draft.rehold_count,
      status: draft.status,
      pendingMode: draft.pending_mode,
      createdAt: draft.created_at,
      updatedAt: draft.updated_at,
    };
  }

  private presentArtifactDraft(draft: HeldArtifactDraftRow): Record<string, unknown> {
    return {
      draftId: draft.id,
      workspaceId: draft.workspace_id,
      agentId: draft.agent_id,
      bindingRevision: draft.binding_revision,
      draftKey: draft.draft_key,
      artifactId: draft.artifact_id,
      publication: this.heldArtifactDrafts.publication(draft),
      publicationHash: draft.publication_hash,
      contentPath: draft.content_path,
      expectedLatestVersionId: draft.expected_latest_version_id,
      heldCurrentLatestVersionId: draft.held_current_latest_version_id,
      proposedDigest: draft.proposed_digest,
      reholdCount: draft.rehold_count,
      status: draft.status,
      pendingMode: draft.pending_mode,
      createdAt: draft.created_at,
      updatedAt: draft.updated_at,
    };
  }

  private recordOperation(command: AgentWorkspaceOperation): void {
    this.operationCount += 1;
    this.workspaceActivityRevision += 1;
    if (this.isTerminal(command)) this.terminalCommandRevision += 1;
  }

  private recordActivity(): void {
    this.operationCount += 1;
    this.workspaceActivityRevision += 1;
  }

  private requireFreshnessReview(kind: FreshnessReviewKind, target: string): void {
    this.pendingFreshnessReviews.set(target, kind);
  }

  private clearFreshnessReview(target: string): void {
    this.pendingFreshnessReviews.delete(target);
  }

  private requireOperationCapacity(): void {
    invariant(this.operationCount < MAX_WORKSPACE_OPERATIONS, 'AGENT_WORKSPACE_OPERATION_LIMIT',
      'Runtime exceeded the Workspace operation limit.', 409);
  }

  private reply(socket: Socket, response: Record<string, unknown>): void {
    if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`);
  }

  private isTerminal(command: AgentWorkspaceOperation): command is MessageSendCommand | NoOutputCommand {
    return command.kind === 'message.send' || command.kind === 'return.no_output';
  }

  private sessionKey(): string {
    return this.agentRoot.split(/[\\/]/u).at(-1)!;
  }

  private parseTarget(target: string): { conversationId: string; threadId: string | null } {
    const match = /^conversation:([^:]+)(?::thread:([^:]+))?$/u.exec(target);
    invariant(match?.[1], 'INVALID_DISCUSSION_TARGET', 'Target must be conversation:<id>[:thread:<id>].', 400);
    return { conversationId: match[1], threadId: match[2] ?? null };
  }

  private receiptFor(target: string): string {
    return `${this.bindingRevision}:${createHash('sha256').update(target).digest('hex').slice(0, 16)}:${randomBytes(12).toString('hex')}`;
  }

  private validateCommand(value: unknown, index: number): AgentWorkspaceOperation {
    invariant(typeof value === 'object' && value !== null, 'INVALID_AGENT_WORKSPACE_OPERATION',
      `Workspace operation ${index + 1} must be an object.`, 409);
    const command = value as Record<string, unknown>;
    if (command.kind === 'return.no_output') {
      invariant(
        typeof command.target === 'string' && typeof command.receipt === 'string',
        'INVALID_AGENT_WORKSPACE_OPERATION',
        'Persisted no-output completion is invalid.',
        409,
      );
      return { kind: 'return.no_output', target: command.target, receipt: command.receipt };
    }
    if (command.kind === 'message.send') {
      invariant(
        typeof command.target === 'string'
        && typeof command.receipt === 'string'
        && typeof command.messageId === 'string',
        'INVALID_AGENT_WORKSPACE_OPERATION',
        'Persisted Message publication is invalid.',
        409,
      );
      return {
        kind: 'message.send', target: command.target, receipt: command.receipt, messageId: command.messageId,
        ...(this.stringArray(command.artifactVersionIds, 'artifactVersionIds').length > 0
          ? { artifactVersionIds: this.stringArray(command.artifactVersionIds, 'artifactVersionIds') } : {}),
        ...(this.stringArray(command.mentionedActorIds, 'mentionedActorIds').length > 0
          ? { mentionedActorIds: this.stringArray(command.mentionedActorIds, 'mentionedActorIds') } : {}),
        ...(this.stringArray(command.workItemIds, 'workItemIds').length > 0
          ? { workItemIds: this.stringArray(command.workItemIds, 'workItemIds') } : {}),
      };
    }
    invariant(command.kind === 'artifact.publish', 'INVALID_AGENT_WORKSPACE_OPERATION',
      `Workspace operation ${index + 1} has an unsupported kind.`, 409);
    invariant(typeof command.filePath === 'string', 'INVALID_AGENT_WORKSPACE_OPERATION',
      'Artifact publication requires a file.', 409);
    const filePath = realpathSync(command.filePath);
    const workRoot = realpathSync(this.workingDirectory);
    const relativePath = relative(workRoot, filePath);
    invariant(relativePath !== '..' && !relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`),
      'ARTIFACT_FILE_OUTSIDE_WORKDIR', 'Artifact publication file must be inside the Agent work directory.', 409);
    invariant(command.mediaType === undefined || (typeof command.mediaType === 'string' && command.mediaType.trim().length > 0),
      'INVALID_AGENT_WORKSPACE_OPERATION', 'Artifact publication media type is invalid.', 409);
    const inferredMediaType = lookupMediaType(filePath);
    const mediaType = typeof command.mediaType === 'string'
      ? command.mediaType.trim()
      : typeof inferredMediaType === 'string' ? inferredMediaType : 'application/octet-stream';
    const parentVersionIds = this.stringArray(command.parentVersionIds, 'parentVersionIds');
    const sourceResourceRefs = Array.isArray(command.sourceResourceRefs) ? command.sourceResourceRefs.map((value) => {
      invariant(typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>).resourceId === 'string',
        'INVALID_AGENT_WORKSPACE_OPERATION', 'sourceResourceRefs entries require resourceId.', 409);
      const ref = value as Record<string, unknown>;
      invariant(ref.revision === undefined || Number.isSafeInteger(ref.revision), 'INVALID_AGENT_WORKSPACE_OPERATION', 'sourceResourceRefs revision is invalid.', 409);
      invariant(ref.digest === undefined || (typeof ref.digest === 'string' && /^[a-f0-9]{64}$/u.test(ref.digest)), 'INVALID_AGENT_WORKSPACE_OPERATION', 'sourceResourceRefs digest is invalid.', 409);
      return { resourceId: ref.resourceId as string, ...(ref.revision === undefined ? {} : { revision: ref.revision as number }), ...(ref.digest === undefined ? {} : { digest: ref.digest as string }) };
    }) : undefined;
    invariant(command.sourceResourceRefs === undefined || Array.isArray(command.sourceResourceRefs), 'INVALID_AGENT_WORKSPACE_OPERATION', 'sourceResourceRefs must be an array.', 409);
    const artifactName = typeof command.artifactName === 'string' ? command.artifactName.trim() || undefined : undefined;
    const artifactPath = typeof command.artifactPath === 'string' ? command.artifactPath.trim() || undefined : undefined;
    return {
      kind: 'artifact.publish',
      filePath, fileName: typeof command.fileName === 'string' && command.fileName.trim() ? command.fileName.trim() : basename(filePath),
      mediaType,
      ...(typeof command.artifactId === 'string' ? { artifactId: command.artifactId } : {}),
      ...(artifactName ? { artifactName } : {}), ...(artifactPath ? { artifactPath } : {}),
      ...(typeof command.expectedLatestVersionId === 'string' ? { expectedLatestVersionId: command.expectedLatestVersionId } : {}),
      ...(parentVersionIds.length ? { parentVersionIds } : {}),
      ...(sourceResourceRefs?.length ? { sourceResourceRefs } : {}),
      ...(typeof command.taskId === 'string' ? { taskId: command.taskId } : {}),
      ...(typeof command.messageId === 'string' ? { messageId: command.messageId } : {}),
      ...(typeof command.publishBatchId === 'string' ? { publishBatchId: command.publishBatchId } : {}),
      ...(typeof command.note === 'string' ? { note: command.note.trim() } : {}),
      ...(typeof command.draftId === 'string' ? { draftId: command.draftId } : {}),
    };
  }

  private stringArray(value: unknown, name: string): string[] {
    invariant(value === undefined || (Array.isArray(value) && value.every((entry) => typeof entry === 'string')),
      'INVALID_AGENT_WORKSPACE_OPERATION', `${name} must be a string array.`, 409);
    return [...new Set((value ?? []) as string[])];
  }

  private cliSource(): string {
    return `#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { createConnection } from 'node:net';
import { relative } from 'node:path';
const args = process.argv.slice(2);
const socketPath = process.env.ANC_TEAMCTL_SOCKET;
const token = process.env.ANC_TEAMCTL_TOKEN;
const workRoot = process.env.ANC_TEAMCTL_WORK_DIR;
if (!socketPath || !token || !workRoot) throw new Error('teamctl is not bound to an active Agent session.');
  const values = (name) => {
  const found = [];
  for (let i = 0; i < args.length; i += 1) if (args[i] === '--' + name) found.push(args[i + 1]);
  return found.filter((value) => typeof value === 'string');
};
const artifactRefs = (name) => values(name).map((value) => {
  const separator = value.indexOf(':');
  if (separator <= 0 || separator === value.length - 1) throw new Error('--' + name + ' must be <artifactId>:<artifactVersionId>.');
  return { artifactId: value.slice(0, separator), artifactVersionId: value.slice(separator + 1) };
});
const value = (name) => values(name).at(-1);
const has = (name) => args.includes('--' + name);
const required = (name) => {
  const found = value(name);
  if (!found) throw new Error('--' + name + ' is required.');
  return found;
};
const send = (command) => new Promise((resolveSend, rejectSend) => {
  const socket = createConnection(socketPath);
  let response = '';
  socket.setEncoding('utf8');
  socket.on('connect', () => socket.write(JSON.stringify({ token, command }) + '\\n'));
  socket.on('data', (chunk) => { response += chunk; });
  socket.on('error', rejectSend);
  socket.on('end', () => {
    try {
      const result = JSON.parse(response.trim());
      if (!result.ok) throw new Error(result.error || 'Workspace operation failed.');
      process.stdout.write(JSON.stringify(result) + '\\n');
      resolveSend();
    } catch (error) { rejectSend(error); }
  });
});
let command;
if (args[0] === 'work-item' && args[1] === 'list') {
  command = { kind: 'work_item.list', ...(value('project-id') ? { projectId: value('project-id') } : {}) };
} else if (args[0] === 'work-item' && args[1] === 'read') {
  if (!args[2] || args[2].startsWith('--')) throw new Error('work-item read requires a WorkItem ID.');
  command = { kind: 'work_item.read', workItemId: args[2] };
} else if (args[0] === 'work-item' && args[1] === 'block') {
  if (!args[2] || args[2].startsWith('--')) throw new Error('work-item block requires a WorkItem ID.');
  const reasonFile = value('reason-file');
  const reason = value('reason') ?? (reasonFile ? readFileSync(realpathSync(reasonFile), 'utf8') : undefined);
  if (!reason?.trim()) throw new Error('--reason or --reason-file is required.');
  command = { kind: 'work_item.block', workItemId: args[2], reason };
} else if (args[0] === 'work-item' && args[1] === 'comment') {
  if (!args[2] || args[2].startsWith('--')) throw new Error('work-item comment requires a WorkItem ID.');
  const bodyFile = value('body-file');
  const body = value('body') ?? (bodyFile ? readFileSync(realpathSync(bodyFile), 'utf8') : undefined);
  if (!body?.trim()) throw new Error('--body or --body-file is required.');
  command = {
    kind: 'work_item.comment', workItemId: args[2], body,
    ...(values('mention').length ? { mentionedActorIds: values('mention') } : {}),
    ...(values('work-item-id').length ? { workItemIds: values('work-item-id') } : {}),
    ...(artifactRefs('artifact-ref').length ? { artifactSelections: artifactRefs('artifact-ref') } : {}),
  };
} else if (args[0] === 'work-item' && args[1] === 'submit') {
  if (!args[2] || args[2].startsWith('--')) throw new Error('work-item submit requires a WorkItem ID.');
  const commentId = value('comment-id');
  const artifactVersionIds = values('artifact-version-id');
  if (!commentId && artifactVersionIds.length === 0) throw new Error('--comment-id or --artifact-version-id is required.');
  command = {
    kind: 'work_item.submit', workItemId: args[2],
    ...(commentId ? { commentId } : {}),
    ...(artifactVersionIds.length ? { artifactVersionIds } : {}),
  };
} else if (args[0] === 'inbox' && args[1] === 'check') {
  command = { kind: 'inbox.check' };
} else if (args[0] === 'message' && args[1] === 'check') {
  command = { kind: 'message.check', target: required('target') };
} else if (args[0] === 'message' && args[1] === 'read') {
  const before = value('before');
  const after = value('after');
  if (before && after) throw new Error('--before and --after cannot be used together.');
  command = {
    kind: 'message.read', target: required('target'),
    ...(before ? { before: Number(before) } : {}),
    ...(after ? { after: Number(after) } : {}),
    ...(value('limit') ? { limit: Number(value('limit')) } : {}),
  };
} else if (args[0] === 'message' && args[1] === 'resolve') {
  if (!args[2] || args[2].startsWith('--')) throw new Error('message resolve requires a Message ID.');
  command = { kind: 'message.resolve', messageId: args[2], target: required('target') };
} else if (args[0] === 'return' && args[1] === 'no-output') {
  command = { kind: 'return.no_output', target: required('target') };
} else if (args[0] === 'message' && args[1] === 'draft' && args[2] === 'get') {
  command = { kind: 'message.draft_get', target: required('target') };
} else if (args[0] === 'message' && args[1] === 'draft' && args[2] === 'discard') {
  command = { kind: 'message.draft_discard', target: required('target') };
} else if (args[0] === 'message' && args[1] === 'send') {
  const bodyFile = value('body-file');
  const explicitBody = value('body');
  const sendDraft = has('send-draft');
  const anyway = has('anyway');
  const artifactIds = values('artifact-version-id');
  const mentions = values('mention');
  const workItemIds = values('work-item-id');
  if (sendDraft && (explicitBody !== undefined || bodyFile)) {
    throw new Error('--send-draft cannot be combined with --body or --body-file.');
  }
  if (sendDraft && (artifactIds.length > 0 || mentions.length > 0 || workItemIds.length > 0)) throw new Error('--send-draft cannot replace held Message references.');
  if (anyway && !sendDraft) throw new Error('--anyway requires --send-draft.');
  const body = explicitBody ?? (bodyFile ? readFileSync(realpathSync(bodyFile), 'utf8') : undefined);
  if (!sendDraft && !body?.trim()) throw new Error('--body or --body-file is required.');
  command = {
    kind: 'message.send', target: required('target'),
    ...(sendDraft ? { sendDraft: true, ...(anyway ? { anyway: true } : {}) } : {
      body,
      ...(artifactIds.length > 0 ? { artifactVersionIds: artifactIds } : {}),
      ...(mentions.length > 0 ? { mentionedActorIds: mentions } : {}),
      ...(workItemIds.length > 0 ? { workItemIds } : {}),
    }),
  };
} else if (args[0] === 'artifact' && args[1] === 'read') {
  if (!args[2] || args[2].startsWith('--')) throw new Error('artifact read requires an Artifact ID.');
  command = { kind: 'artifact.read', artifactId: args[2] };
} else if (args[0] === 'resource' && args[1] === 'list') {
  command = { kind: 'resource.list' };
} else if (args[0] === 'resource' && args[1] === 'read') {
  if (!args[2] || args[2].startsWith('--')) throw new Error('resource read requires a Resource ID.');
  command = { kind: 'resource.read', resourceId: args[2] };
} else if (args[0] === 'artifact' && args[1] === 'draft' && args[2] === 'get') {
  command = { kind: 'artifact.draft_get', draftId: required('draft-id') };
} else if (args[0] === 'artifact' && args[1] === 'draft' && args[2] === 'discard') {
  command = { kind: 'artifact.draft_discard', draftId: required('draft-id') };
} else if (args[0] === 'artifact' && args[1] === 'publish') {
  const sendDraft = has('send-draft');
  const anyway = has('anyway');
  if (anyway && !sendDraft) throw new Error('--anyway requires --send-draft.');
  if (sendDraft) {
    if (value('file') || value('artifact-name') || value('artifact-path')) {
      throw new Error('--send-draft cannot be combined with new Artifact publication fields.');
    }
    command = { kind: 'artifact.publish', draftId: required('draft-id'), sendDraft: true, ...(anyway ? { anyway: true } : {}) };
  } else {
    const fileInput = required('file');
    const artifactId = value('artifact-id');
    const expectedLatestVersionId = value('expected-latest-version-id');
    if (artifactId && !expectedLatestVersionId) throw new Error('--expected-latest-version-id is required when appending an Artifact.');
    if (!artifactId && expectedLatestVersionId) throw new Error('--expected-latest-version-id requires --artifact-id.');
    const filePath = realpathSync(fileInput);
    const rel = relative(realpathSync(workRoot), filePath);
    if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\\\')) {
      throw new Error('Artifact file must be inside the Agent work directory.');
    }
    const parentVersionIds = values('parent-version-id');
    const sourceResourceRefs = values('source-resource-ref').map((entry) => {
      try { return JSON.parse(entry); } catch { throw new Error('--source-resource-ref must be valid JSON.'); }
    });
    command = {
      kind: 'artifact.publish', filePath, fileName: value('file-name') ?? filePath.split(/[\\/]/).at(-1),
      ...(value('media-type') ? { mediaType: value('media-type') } : {}),
      ...(artifactId ? { artifactId } : {}), ...(value('artifact-name') ? { artifactName: value('artifact-name') } : {}),
      ...(value('artifact-path') ? { artifactPath: value('artifact-path') } : {}),
      ...(expectedLatestVersionId ? { expectedLatestVersionId } : {}),
      ...(parentVersionIds.length ? { parentVersionIds } : {}),
      ...(sourceResourceRefs.length ? { sourceResourceRefs } : {}),
      ...(value('task-id') ? { taskId: value('task-id') } : {}), ...(value('message-id') ? { messageId: value('message-id') } : {}),
      ...(value('publish-batch-id') ? { publishBatchId: value('publish-batch-id') } : {}), ...(value('note') ? { note: value('note') } : {}),
      ...(value('draft-id') === undefined ? {} : { draftId: value('draft-id') }),
    };
  }
} else {
  process.stderr.write('Usage:\\n  teamctl resource list\\n  teamctl resource read <resource-id>\\n  teamctl artifact publish --file <path> [--file-name <name>] [--artifact-id <id> --expected-latest-version-id <version-id>] [--artifact-name <name>] [--artifact-path <path>] [--parent-version-id <version-id> ...] [--source-resource-ref <json> ...] [--draft-id <id>]\\n  teamctl artifact publish --send-draft --draft-id <id> [--anyway]\\n  teamctl artifact read <artifact-id>\\n  teamctl artifact draft get --draft-id <id>\\n  teamctl artifact draft discard --draft-id <id>\\n');
  process.exit(2);
}
await send(command);
`;
  }
}
