import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  AgentInboxSummaryView,
  AgentInboxWakeBatchView,
  AgentSessionRef,
  AgentSessionInputView,
} from '../domain/types.js';
import type { LocalExecutionStore } from '../storage/local-execution-store.js';
import { HeldArtifactDraftStore } from '../storage/held-artifact-draft-store.js';
import { HeldDraftStore } from '../storage/held-draft-store.js';
import {
  RuntimeSessionStore,
  runtimeAdapterInstanceId,
  type RuntimeSessionRow,
} from '../storage/runtime-session-store.js';
import { AcpRuntimeIntegration } from './acp-runtime-integration.js';
import { AgentActivityReporter } from './agent-activity-reporter.js';
import { localAgentPermissionDecision } from './local-agent-permissions.js';
import {
  detectLocalRuntimes,
  requireLocalRuntimeLaunch,
  type LocalRuntimeDetection,
} from './local-runtime-catalog.js';
import type { RuntimeExecutionController, RuntimeIntegration } from './runtime-integration.js';
import { AgentWorkspaceGateway } from './agent-workspace-gateway.js';

export interface LocalComputerApiRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  idempotencyKey?: string;
}

export interface LocalComputerApi {
  request<T>(path: string, request: LocalComputerApiRequest): Promise<T>;
  uploadFile?<T>(
    path: string,
    input: { filePath: string; fileName: string; mediaType: string; fields?: Record<string, string>; idempotencyKey?: string },
  ): Promise<T>;
}

export interface LocalComputerWorkerOptions {
  api: LocalComputerApi;
  localExecutions: LocalExecutionStore;
  agentRoot: string;
  detections?: LocalRuntimeDetection[];
  integration?: RuntimeIntegration;
  onLog?: (message: string) => void;
}

interface ActiveAgentSession {
  session: AgentSessionRef;
  input: AgentSessionInputView;
  adapterInstanceId: string;
  runtimeSession: RuntimeSessionRow;
  controller: RuntimeExecutionController;
  gateway: AgentWorkspaceGateway;
  activity: AgentActivityReporter;
  processing: boolean;
  wakePending: boolean;
}

/** One Local Computer process owns disposable Runtime caches per logical Session. */
export class LocalComputerWorker {
  private detections: LocalRuntimeDetection[];
  private readonly integration: RuntimeIntegration;
  private readonly runtimeSessions: RuntimeSessionStore;
  private readonly heldDrafts: HeldDraftStore;
  private readonly heldArtifactDrafts: HeldArtifactDraftStore;
  private readonly activeSessions = new Map<string, ActiveAgentSession>();

  constructor(private readonly options: LocalComputerWorkerOptions) {
    this.detections = options.detections ?? detectLocalRuntimes();
    this.integration = options.integration ?? new AcpRuntimeIntegration();
    this.runtimeSessions = new RuntimeSessionStore(options.localExecutions.database);
    this.heldDrafts = new HeldDraftStore(options.localExecutions.database);
    this.heldArtifactDrafts = new HeldArtifactDraftStore(options.localExecutions.database);
  }

  updateDetections(detections: LocalRuntimeDetection[]): void {
    this.detections = detections;
  }

  async runOnce(): Promise<number> {
    const batch = await this.options.api.request<AgentInboxWakeBatchView>(
      '/v1/computers/self/agent-inbox-wakes',
      { method: 'GET' },
    );
    let processed = 0;
    const refsByAgent = new Map<string, AgentSessionRef[]>();
    const dmWindowRefs = new Map<string, AgentSessionRef>();
    const frozenDmRefs = new Map<string, AgentSessionRef>();
    const add = (agentId: string, ref: AgentSessionRef): void => {
      const refs = refsByAgent.get(agentId) ?? [];
      if (!refs.some((item) => item.kind === ref.kind && item.key === ref.key)) refs.push(ref);
      refsByAgent.set(agentId, refs);
    };
    for (const row of this.runtimeSessions.listActive()) {
      if (row.session_target && row.window_mode === 'dm' && row.window_status === 'accepting' && row.window_message_count < 10) {
        dmWindowRefs.set(`${row.agent_id}:${row.session_target}`, { kind: row.session_kind, key: row.session_key });
      }
      if (row.session_target && row.window_mode === 'dm' && row.window_status === 'frozen') {
        frozenDmRefs.set(`${row.agent_id}:${row.session_target}`, { kind: row.session_kind, key: row.session_key });
      }
    }
    for (const [, active] of this.activeSessions) {
      if (active.input.target && active.input.sessionWindow.mode === 'dm'
        && active.gateway.sessionWindow.status === 'accepting'
        && active.gateway.sessionWindow.acceptedMessages < 10) {
        dmWindowRefs.set(`${active.input.agentId}:${active.input.target}`, active.session);
      }
      if (active.input.target && active.input.sessionWindow.mode === 'dm'
        && active.gateway.sessionWindow.status === 'frozen') {
        frozenDmRefs.set(`${active.input.agentId}:${active.input.target}`, active.session);
      }
    }
    for (const event of batch.events) {
      const summary = await this.options.api.request<AgentInboxSummaryView>(`/v1/computers/self/agents/${event.agentId}/inbox`, { method: 'GET' });
      for (const trigger of (summary.sessionTriggers ?? []).filter((item) => item.requiresAction)) {
        const dmRef = trigger.target ? dmWindowRefs.get(`${event.agentId}:${trigger.target}`) : undefined;
        const frozenRef = trigger.target ? frozenDmRefs.get(`${event.agentId}:${trigger.target}`) : undefined;
        const anchorStillActive = dmRef === undefined || (summary.sessionTriggers ?? []).some((item) =>
          item.requiresAction && item.session.kind === dmRef.kind && item.session.key === dmRef.key);
        const frozenStillActive = frozenRef !== undefined && (summary.sessionTriggers ?? []).some((item) =>
          item.requiresAction && item.session.kind === frozenRef.kind && item.session.key === frozenRef.key);
        add(event.agentId, anchorStillActive ? dmRef ?? (frozenStillActive ? frozenRef : trigger.session) : trigger.session);
      }
    }
    for (const row of this.runtimeSessions.listActive()) add(row.agent_id, { kind: row.session_kind, key: row.session_key });
    for (const row of [...this.heldDrafts.listActiveSessions(), ...this.heldArtifactDrafts.listActiveSessions()]) {
      add(row.agent_id, { kind: row.session_kind, key: row.session_key });
    }
    for (const [, active] of this.activeSessions) {
      add(active.input.agentId, active.session);
      if (active.input.target && active.input.sessionWindow.mode === 'dm'
        && active.gateway.sessionWindow.status === 'accepting'
        && active.gateway.sessionWindow.acceptedMessages < 10) {
        dmWindowRefs.set(`${active.input.agentId}:${active.input.target}`, active.session);
      }
      if (active.input.target && active.input.sessionWindow.mode === 'dm'
        && active.gateway.sessionWindow.status === 'frozen') {
        frozenDmRefs.set(`${active.input.agentId}:${active.input.target}`, active.session);
      }
    }
    for (const [agentId, refs] of refsByAgent) {
      for (const ref of refs) {
        try {
          const summary = await this.options.api.request<AgentInboxSummaryView>(`/v1/computers/self/agents/${agentId}/inbox`, { method: 'GET' });
          let trigger = (summary.sessionTriggers ?? []).find((item) => item.session.kind === ref.kind && item.session.key === ref.key && item.requiresAction);
          if (!trigger && ref.kind === 'mention') {
            const active = this.activeSessions.get(this.sessionKey(agentId, ref));
            const target = active?.input.target;
            if (target) trigger = (summary.sessionTriggers ?? []).find((item) => item.target === target && item.requiresAction);
          }
          if (!trigger && ref.kind === 'mention') continue;
          await this.wakeSession(agentId, ref);
          processed += 1;
        } catch (error) {
          await this.dropSession(agentId, ref, error);
          // diagnostics for local agent failures are surfaced through onLog
          this.options.onLog?.(`Agent ${agentId} ${ref.kind}:${ref.key} session failed: ${this.errorMessage(error)}`);
        }
      }
    }
    return processed;
  }

  async close(): Promise<void> {
    const sessions = [...this.activeSessions.values()];
    await Promise.allSettled(sessions.map((session) => this.dropSession(session.input.agentId, session.session)));
  }

  private async wakeSession(agentId: string, ref: AgentSessionRef): Promise<void> {
    const session = await this.ensureSession(agentId, ref);
    if (session.processing) {
      session.wakePending = true;
      return;
    }
    session.processing = true;
    try {
      do {
        session.wakePending = false;
        await this.driveInbox(session);
        if (!this.activeSessions.has(this.sessionKey(agentId, session.session))) break;
      } while (session.wakePending);
    } finally {
      session.processing = false;
    }
  }

  private async ensureSession(agentId: string, ref: AgentSessionRef): Promise<ActiveAgentSession> {
    let input = await this.options.api.request<AgentSessionInputView>(
      `/v1/computers/self/agents/${agentId}/session-input?kind=${encodeURIComponent(ref.kind)}&key=${encodeURIComponent(ref.key)}`,
      { method: 'GET' },
    );
    const adapterInstanceId = runtimeAdapterInstanceId(
      input.runtimeId,
      `acp-v1:binding-${input.runtimeBindingRevision}`,
      input.developerInstructions,
    );
    const sessionKey = this.sessionKey(agentId, input.session);
    const active = this.activeSessions.get(sessionKey);
    // A Session JSONL is immutable after the first ACP turn. Workspace fields
    // may change while that turn is alive, but must not replace the Runtime
    // conversation or its already-sent snapshot.
    if (active?.adapterInstanceId === adapterInstanceId) return active;
    if (active) await this.dropSession(agentId, input.session);

    const agentRoot = resolve(this.options.agentRoot, agentId, input.session.kind, input.session.key);
    const workingDirectory = resolve(agentRoot, 'work');
    mkdirSync(workingDirectory, { recursive: true, mode: 0o700 });
    let runtimeSession = this.runtimeSessions.findActive(input.workspaceId, input.agentId, adapterInstanceId, input.session.kind, input.session.key, input.contextHash);
    if (runtimeSession) {
      input = {
        ...input,
        contextHash: runtimeSession.context_hash || input.contextHash,
        contextJsonl: runtimeSession.context_jsonl || input.contextJsonl,
        initialDiscussionFrontier: runtimeSession.window_initial_frontier || input.initialDiscussionFrontier,
        sessionWindow: {
          mode: runtimeSession.window_mode,
          acceptedMessages: runtimeSession.window_message_count,
          maxMessages: 10,
          status: runtimeSession.window_status,
        },
      };
    }
    const gateway = new AgentWorkspaceGateway(
      agentRoot,
      workingDirectory,
      input.session,
      input.target,
      input.projectId,
      input.workspaceId,
      agentId,
      input.runtimeBindingRevision,
      this.options.api,
      this.heldDrafts,
      this.heldArtifactDrafts,
      input.initialDiscussionFrontier,
      input.sessionWindow,
      input.discussion,
    );
    const boundGateway = await gateway.prepare();
    const launch = requireLocalRuntimeLaunch(input.runtimeId, this.detections);
    const activity = new AgentActivityReporter(this.options.api, agentId, this.options.onLog);
    const open = (priorSessionId?: string) => this.integration.openExecution({
      ...launch,
      executionId: `agent-session-${agentId}-${input.session.kind}-${input.session.key}`,
      executionRoot: agentRoot,
      workingDirectory,
      executionKind: 'agent_session',
      runtimeConfiguration: input.runtimeConfiguration,
      ...(priorSessionId ? { priorSessionId } : {}),
      developerInstructions: input.developerInstructions,
      env: { ...launch.env, ...boundGateway.env },
      onEvent: () => {},
      onActivity: (event) => activity.record(event),
      requestPermission: async (permission) => localAgentPermissionDecision(permission),
    });
    let controller: RuntimeExecutionController;
    try {
      controller = await open(runtimeSession?.runtime_session_id);
    } catch (error) {
      if (!runtimeSession || !this.isUnavailablePersistentSession(error)) {
        await gateway.close();
        throw error;
      }
      this.runtimeSessions.markLost(runtimeSession.id);
      runtimeSession = undefined;
      controller = await open();
    }
    invariantWorker(controller.capabilities.loadSession,
      `Runtime ${input.runtimeId} does not support persistent Agent sessions.`);
    if (!runtimeSession) {
      runtimeSession = this.runtimeSessions.replaceActive(
        input.workspaceId,
        input.agentId,
        adapterInstanceId,
        controller.sessionId,
        input.session.kind,
        input.session.key,
        input.contextHash,
        0,
        input.contextJsonl,
        {
          target: input.target,
          mode: input.sessionWindow.mode,
          initialFrontier: input.initialDiscussionFrontier ?? 0,
          acceptedMessages: input.sessionWindow.acceptedMessages,
          status: input.sessionWindow.status,
        },
      );
    }
    const created: ActiveAgentSession = {
      input,
      session: input.session,
      adapterInstanceId,
      runtimeSession,
      controller,
      gateway,
      activity,
      processing: false,
      wakePending: false,
    };
    this.activeSessions.set(sessionKey, created);
    this.options.onLog?.(`Agent ${input.session.kind}:${input.session.key} Runtime cache started for ${agentId}.`);
    return created;
  }

  private async driveInbox(session: ActiveAgentSession): Promise<void> {
    const wake = 'Agent Inbox changed.';
    const initialWake = session.gateway.takeFreshnessReviewPrompt() ?? wake;
    let prompt = session.runtimeSession.initial_prompt_sent === 0
      ? `${session.input.developerInstructions}\n\n## Session JSONL\n\n${session.input.contextJsonl}\n\n${initialWake}`
      : initialWake;
    session.activity.begin();
    try {
      while (true) {
        const activityRevisionBeforeTurn = session.gateway.activityRevision;
        await session.controller.sendInput(prompt);
        if (session.runtimeSession.initial_prompt_sent === 0) {
          this.runtimeSessions.markInitialPromptSent(session.runtimeSession.id);
          session.runtimeSession.initial_prompt_sent = 1;
        }
        this.runtimeSessions.updateWindow(session.runtimeSession.id, session.gateway.sessionWindow);
        const summary = await this.options.api.request<AgentInboxSummaryView>(
          `/v1/computers/self/agents/${session.input.agentId}/inbox`,
          { method: 'GET' },
        );
        this.runtimeSessions.touch(session.runtimeSession.id, summary.highestSequence);
        const stillActive = (summary.sessionTriggers ?? []).some((trigger) => (trigger.session.kind === session.session.kind
          && trigger.session.key === session.session.key
          || session.input.sessionWindow.mode === 'dm' && trigger.target === session.input.target)
          && trigger.requiresAction)
          && session.gateway.sessionWindow.status !== 'completed';
        if (!stillActive) {
          await this.dropSession(session.input.agentId, session.session);
          await session.activity.complete();
          return;
        }
        invariantWorker(
          session.gateway.activityRevision > activityRevisionBeforeTurn,
          'Runtime ended its turn without completing a claimed Agent Inbox target.',
        );
        prompt = session.gateway.takeFreshnessReviewPrompt() ?? wake;
      }
    } catch (error) {
      await session.activity.fail();
      throw error;
    }
  }

  private async dropSession(agentId: string, ref: AgentSessionRef, cause?: unknown): Promise<void> {
    const session = this.activeSessions.get(this.sessionKey(agentId, ref));
    if (!session) return;
    this.activeSessions.delete(this.sessionKey(agentId, ref));
    if (cause) this.runtimeSessions.markLost(session.runtimeSession.id);
    else this.runtimeSessions.markClosed(session.runtimeSession.id);
    const results = await Promise.allSettled([session.controller.close(), session.gateway.close()]);
    for (const result of results) {
      if (result.status === 'rejected') {
        this.options.onLog?.(`Agent session cleanup failed: ${this.errorMessage(result.reason)}`);
      }
    }
  }

  private sessionKey(agentId: string, ref: AgentSessionRef): string {
    return `${agentId}:${ref.kind}:${ref.key}`;
  }

  private isUnavailablePersistentSession(error: unknown): boolean {
    let current: unknown = error;
    for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
      const code = (current as Error & { code?: unknown }).code;
      if (code === 'ACP_LOAD_SESSION_UNAVAILABLE' || code === -32602 || code === -32001) return true;
      const message = current.message.toLowerCase();
      if (message.includes('session') && (message.includes('not found') || message.includes('does not exist'))) return true;
      current = current.cause;
    }
    return false;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

function invariantWorker(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
