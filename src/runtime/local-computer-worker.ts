import { resolve } from 'node:path';
import type {
  AgentInboxSummaryView,
  AgentRequestView,
  AttemptExecutionInputView,
  AttemptView,
  RunView,
} from '../domain/types.js';
import type { LocalExecutionStore } from '../storage/local-execution-store.js';
import {
  RuntimeSessionStore,
  runtimeAdapterInstanceId,
  type RuntimeSessionRow,
} from '../storage/runtime-session-store.js';
import { AcpRuntimeIntegration } from './acp-runtime-integration.js';
import { localAttemptPermissionDecision } from './local-attempt-permissions.js';
import {
  detectLocalRuntimes,
  requireLocalRuntimeLaunch,
  type LocalRuntimeDetection,
} from './local-runtime-catalog.js';
import type { RuntimeExecutionController, RuntimeIntegration } from './runtime-integration.js';
import { AttemptWorkspaceManager, ProjectWorkingCopyStore } from './project-working-copy.js';
import {
  WorkspaceReturnBinding,
  type StagedArtifactUpload,
} from './workspace-return-binding.js';

export interface LocalComputerApiRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  idempotencyKey?: string;
}

export interface LocalComputerApi {
  request<T>(path: string, request: LocalComputerApiRequest): Promise<T>;
  uploadFile?<T>(
    path: string,
    input: { filePath: string; fileName: string; mediaType: string },
  ): Promise<T>;
}

export interface LocalComputerWorkerOptions {
  api: LocalComputerApi;
  localExecutions: LocalExecutionStore;
  attemptRoot: string;
  detections?: LocalRuntimeDetection[];
  integration?: RuntimeIntegration;
  onLog?: (message: string) => void;
}

/**
 * Claims Agent Requests, wakes one persistent Agent ACP session, and exposes
 * Workspace state only through the local teamctl IPC proxy.
 */
export class LocalComputerWorker {
  private detections: LocalRuntimeDetection[];
  private readonly integration: RuntimeIntegration;
  private readonly attemptWorkspaces: AttemptWorkspaceManager;
  private readonly runtimeSessions: RuntimeSessionStore;

  constructor(private readonly options: LocalComputerWorkerOptions) {
    this.detections = options.detections ?? detectLocalRuntimes();
    this.integration = options.integration ?? new AcpRuntimeIntegration();
    this.attemptWorkspaces = new AttemptWorkspaceManager(new ProjectWorkingCopyStore(options.localExecutions.database));
    this.runtimeSessions = new RuntimeSessionStore(options.localExecutions.database);
  }

  updateDetections(detections: LocalRuntimeDetection[]): void {
    this.detections = detections;
  }

  async runOnce(): Promise<number> {
    const page = await this.options.api.request<{ items: AgentRequestView[] }>(
      '/v1/computers/self/agent-requests?limit=20',
      { method: 'GET' },
    );
    let completed = 0;
    for (const request of page.items) {
      if (!(
        (request.status === 'pending' && request.intake?.disposition === 'ready')
        || (request.status === 'accepted' && request.run?.status === 'active')
      )) continue;
      try {
        await this.executeRequest(request);
        completed += 1;
      } catch (error) {
        this.options.onLog?.(`Agent Request ${request.id} failed: ${this.errorMessage(error)}`);
      }
    }
    return completed;
  }

  private async executeRequest(request: AgentRequestView): Promise<void> {
    let attemptId: string | undefined;
    let controller: RuntimeExecutionController | undefined;
    let gateway: WorkspaceReturnBinding | undefined;
    let runtimeSession: RuntimeSessionRow | undefined;
    try {
      const runId = request.status === 'pending'
        ? (await this.options.api.request<RunView>(
            `/v1/agent-requests/${request.id}/accept`,
            {
              method: 'POST',
              body: { expectedVersion: request.version },
              idempotencyKey: `accept:${request.id}`,
            },
          )).id
        : request.run!.id;
      attemptId = request.run?.attempt?.status === 'running'
        ? request.run.attempt.id
        : (await this.options.api.request<AttemptView>(
            `/v1/runs/${runId}/attempts`,
            { method: 'POST', idempotencyKey: `attempt:${runId}` },
          )).id;
      const input = await this.options.api.request<AttemptExecutionInputView>(
        `/v1/attempts/${attemptId}/execution-input`,
        { method: 'GET' },
      );
      const attemptRoot = resolve(this.options.attemptRoot, attemptId);
      const workingDirectory = this.attemptWorkspaces.prepare(input.executionScope, attemptRoot);
      gateway = new WorkspaceReturnBinding(
        attemptRoot,
        workingDirectory,
        input.runContext.projectId,
        input.agentId,
        input.runId,
        this.options.api,
      );
      const boundGateway = await gateway.prepare();
      this.options.localExecutions.start(attemptId, input.workspaceId, input.runId, {
        attemptRoot,
        workingDirectory,
        executionScope: input.executionScope,
      });
      const launch = requireLocalRuntimeLaunch(input.runtimeId, this.detections);
      const developerInstructions = `${input.developerInstructions}\n\n${boundGateway.instructions}`;
      const adapterInstanceId = runtimeAdapterInstanceId(
        input.runtimeId,
        `acp-v1:binding-${input.runtimeBindingRevision}`,
        developerInstructions,
      );
      runtimeSession = this.runtimeSessions.findActive(input.workspaceId, input.agentId, adapterInstanceId);
      const open = (priorSessionId?: string) => this.integration.openExecution({
        ...launch,
        attemptId: input.attemptId,
        attemptRoot,
        workingDirectory,
        executionKind: input.executionScope.kind,
        runtimeConfiguration: input.runtimeConfiguration,
        ...(priorSessionId ? { priorSessionId } : {}),
        developerInstructions,
        env: { ...launch.env, ...boundGateway.env },
        onEvent: (event) => this.options.localExecutions.recordContextEvent(event),
        requestPermission: async (permission) => localAttemptPermissionDecision(permission),
      });
      try {
        controller = await open(runtimeSession?.runtime_session_id);
      } catch (error) {
        if (!runtimeSession || !this.isUnavailablePersistentSession(error)) throw error;
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
          0,
        );
      }
      await this.driveInbox(input, controller, gateway, runtimeSession, developerInstructions);
      this.options.localExecutions.beginReturn(attemptId);
      const envelope = await gateway.buildEnvelope(async (path, file) => {
        if (!this.options.api.uploadFile) {
          throw new Error('Local Computer API does not support staged Artifact upload.');
        }
        return this.options.api.uploadFile<StagedArtifactUpload>(path, file);
      });
      await this.options.api.request(
        `/v1/attempts/${attemptId}/return`,
        { method: 'POST', body: envelope, idempotencyKey: `return:${attemptId}` },
      );
      controller.markReturnCommitted();
      this.options.localExecutions.finish(attemptId);
      this.options.onLog?.(`Agent Request ${request.id} completed with ${envelope.disposition}.`);
    } catch (error) {
      if (runtimeSession) this.runtimeSessions.markLost(runtimeSession.id);
      if (attemptId) {
        this.options.localExecutions.cancelIfPresent(attemptId);
        try {
          await this.options.api.request(
            `/v1/attempts/${attemptId}/fail`,
            {
              method: 'POST',
              body: { reason: this.errorMessage(error) },
              idempotencyKey: `fail:${attemptId}`,
            },
          );
        } catch (failError) {
          this.options.onLog?.(`Attempt ${attemptId} failure report was rejected: ${this.errorMessage(failError)}`);
        }
      }
      throw error;
    } finally {
      try {
        await controller?.close();
      } catch (closeError) {
        this.options.onLog?.(`Runtime cleanup failed: ${this.errorMessage(closeError)}`);
      }
      try {
        await gateway?.close();
      } catch (closeError) {
        this.options.onLog?.(`Workspace gateway cleanup failed: ${this.errorMessage(closeError)}`);
      }
    }
  }

  private async driveInbox(
    input: AttemptExecutionInputView,
    controller: RuntimeExecutionController,
    gateway: WorkspaceReturnBinding,
    runtimeSession: RuntimeSessionRow,
    developerInstructions: string,
  ): Promise<void> {
    const target = this.targetFor(input);
    const wake = [
      'Agent Inbox changed.',
      'Run `teamctl inbox check`, then `teamctl message check --target <scope>` for the pending Discussion Scope.',
      'No user Message body is included in this wake.',
    ].join('\n');
    let prompt = runtimeSession.initial_prompt_sent === 0
      ? `${developerInstructions}\n\n${wake}`
      : wake;
    const deadlineAt = input.deadlineAt;
    while (true) {
      invariantWorker(Date.now() <= deadlineAt, 'Agent Inbox processing exceeded the Run deadline.');
      const terminalRevisionBeforeTurn = gateway.terminalRevision;
      await controller.sendInput(prompt);
      if (runtimeSession.initial_prompt_sent === 0) {
        this.runtimeSessions.markInitialPromptSent(runtimeSession.id);
        runtimeSession.initial_prompt_sent = 1;
      }
      const summary = await this.options.api.request<AgentInboxSummaryView>(
        `/v1/computers/self/agents/${input.agentId}/inbox`,
        { method: 'GET' },
      );
      this.runtimeSessions.touch(runtimeSession.id, summary.highestSequence);
      const sameScopePending = summary.targets.some((item) => item.target === target);
      if (sameScopePending) {
        invariantWorker(gateway.terminalRevision > terminalRevisionBeforeTurn,
          'Runtime ended its turn without checking and handling the pending Agent Inbox.');
        prompt = wake;
        continue;
      }
      invariantWorker(gateway.terminalRevision > terminalRevisionBeforeTurn,
        'Runtime stopped without sending a Message or explicitly returning no output.');
      return;
    }
  }

  private targetFor(input: AttemptExecutionInputView): string {
    const scope = input.runContext.resultScope;
    return scope.threadId === null
      ? `conversation:${scope.conversationId}`
      : `conversation:${scope.conversationId}:thread:${scope.threadId}`;
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
