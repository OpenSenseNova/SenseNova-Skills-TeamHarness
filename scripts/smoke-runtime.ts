import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { AcpRuntimeIntegration } from '../src/runtime/acp-runtime-integration.js';
import { AgentWorkspaceGateway, type WorkspaceAgentGatewayApi } from '../src/runtime/agent-workspace-gateway.js';
import { localAgentPermissionDecision } from '../src/runtime/local-agent-permissions.js';
import type { RuntimeLaunchSpec } from '../src/runtime/runtime-integration.js';
import { HeldArtifactDraftStore } from '../src/storage/held-artifact-draft-store.js';
import { HeldDraftStore } from '../src/storage/held-draft-store.js';
import { SqliteDatabase } from '../src/storage/database.js';

const supportedRuntimeIds = new Set(['codex', 'claude', 'gemini', 'goose', 'hermes']);
const runtimeId = process.argv[2];
if (!runtimeId || !supportedRuntimeIds.has(runtimeId)) {
  throw new Error('Usage: npm run smoke:<codex|claude|gemini|goose|hermes>');
}

const command = process.env.ANC_RUNTIME_COMMAND?.trim();
if (!command) {
  throw new Error('Set ANC_RUNTIME_COMMAND to this Runtime\'s ACP v1 stdio command. No command is inferred from runtimeId.');
}

let args: string[] = [];
if (process.env.ANC_RUNTIME_ARGS_JSON) {
  const value: unknown = JSON.parse(process.env.ANC_RUNTIME_ARGS_JSON);
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error('ANC_RUNTIME_ARGS_JSON must be a JSON array of strings.');
  }
  args = value;
}

let runtimeConfiguration: RuntimeLaunchSpec['runtimeConfiguration'] = {
  model: null,
  reasoningEffort: null,
  mode: null,
};
if (process.env.ANC_RUNTIME_CONFIGURATION_JSON) {
  const value: unknown = JSON.parse(process.env.ANC_RUNTIME_CONFIGURATION_JSON);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('ANC_RUNTIME_CONFIGURATION_JSON must be a JSON object.');
  }
  runtimeConfiguration = value as RuntimeLaunchSpec['runtimeConfiguration'];
}

const agentRoot = mkdtempSync(resolve(tmpdir(), `anc-${runtimeId}-agent-smoke-`));
const workingDirectory = resolve(agentRoot, 'work');
mkdirSync(workingDirectory, { recursive: true, mode: 0o700 });

const target = 'conversation:smoke-conversation';
const session = { kind: 'mention' as const, key: 'smoke-request-1' };
let pendingBody = 'Reply briefly to confirm the persistent Agent Inbox works.';
const publishedBodies: string[] = [];
let receiptSequence = 0;
const api: WorkspaceAgentGatewayApi = {
  async request<T>(path: string, request: { method: 'GET' | 'POST'; body?: unknown }): Promise<T> {
    if (path.endsWith('/inbox') && request.method === 'GET') {
      return {
        agentId: 'smoke-agent', highestSequence: receiptSequence + 1,
        sessionTriggers: pendingBody ? [{ session, inboxItemId: 'smoke-inbox-1', sequence: 1, target, agentRequestId: session.key, messageId: 'smoke-message-1', conversationId: 'smoke-conversation', threadId: null, workItemId: null, requiresAction: true }] : [],
        targets: pendingBody ? [{
          kind: 'discussion', conversationId: 'smoke-conversation', threadId: null,
          target, pendingCount: 1, firstSequence: receiptSequence + 1, lastSequence: receiptSequence + 1,
        }] : [],
      } as T;
    }
    if (path.endsWith('/inbox/claim') && request.method === 'POST') {
      receiptSequence += 1;
      const body = pendingBody;
      pendingBody = '';
      return {
        agentId: 'smoke-agent', receipt: `smoke-receipt-${receiptSequence}`, target, targetKind: 'discussion',
        attention: [{
          inboxItemId: `smoke-inbox-${receiptSequence}`, sequence: receiptSequence,
          attentionKind: 'direct_message', agentRequestId: `smoke-request-${receiptSequence}`,
          messageId: `smoke-message-${receiptSequence}`, workspaceChangePosition: null,
        }],
        discussion: {
          conversationId: 'smoke-conversation', threadId: null,
          sincePositionExclusive: receiptSequence - 1, throughPosition: receiptSequence,
          rootMessage: null,
          messages: [{
            id: `smoke-message-${receiptSequence}`, body, scopePosition: receiptSequence,
            author: { actorType: 'human', displayName: 'Smoke Human' },
          }],
        },
        changes: [],
      } as T;
    }
    if (path.endsWith('/messages') && request.method === 'POST') {
      const body = String((request.body as { body?: unknown }).body ?? '').trim();
      if (!body) throw new Error('Runtime published an empty Message.');
      publishedBodies.push(body);
      return { id: `smoke-agent-message-${publishedBodies.length}` } as T;
    }
    if (path.endsWith('/inbox/complete') && request.method === 'POST') {
      return { handledAt: Date.now() } as T;
    }
    throw new Error(`Unexpected smoke Gateway request: ${request.method} ${path}`);
  },
};

const localDatabase = SqliteDatabase.open(resolve(agentRoot, 'local-node.sqlite'), 'local-node');
const gateway = new AgentWorkspaceGateway(
  agentRoot,
  workingDirectory,
  session,
  target,
  null,
  'smoke-workspace',
  'smoke-agent',
  1,
  api,
  new HeldDraftStore(localDatabase),
  new HeldArtifactDraftStore(localDatabase),
);
const boundGateway = await gateway.prepare();
const developerInstructions = [
  'You are Smoke Agent, a persistent Agent in the Runtime Smoke Workspace.',
  'Use teamctl for all Workspace communication. Standard output is not delivered to the user.',
  'On every `Agent Inbox changed.` wake, run `teamctl inbox check`, claim each Discussion target with `teamctl message check --target <target>`, and finish it with `teamctl message send --target <target> --body <text>` or `teamctl return no-output --target <target>`.',
  'Available commands: teamctl inbox check; teamctl message check/read/resolve/send; teamctl artifact read/publish/update; teamctl return no-output.',
].join('\n\n');

const events: string[] = [];
const startedAt = Date.now();
const integration = new AcpRuntimeIntegration();
let controller: Awaited<ReturnType<AcpRuntimeIntegration['openExecution']>> | undefined;
const requirePublishedCount = (expected: number): void => {
  if (publishedBodies.length !== expected) {
    throw new Error(`Runtime published ${publishedBodies.length} Messages; expected ${expected}.`);
  }
};
try {
  controller = await integration.openExecution({
    runtimeId,
    command,
    args,
    executionId: 'persistent-agent-smoke-session',
    executionRoot: agentRoot,
    workingDirectory,
    executionKind: 'agent_session',
    env: boundGateway.env,
    runtimeConfiguration,
    developerInstructions,
    onEvent: (event) => events.push(event.type),
    requestPermission: async (request) => localAgentPermissionDecision(request),
  });
  const first = await controller.sendInput(`${developerInstructions}\n\nAgent Inbox changed.`);
  requirePublishedCount(1);

  pendingBody = 'Reply briefly again using the same Agent Runtime session.';
  const second = await controller.sendInput('Agent Inbox changed.');
  requirePublishedCount(2);

  const result = {
    runtimeId,
    command: basename(command),
    passed: true,
    sameSessionId: controller.sessionId,
    firstStopReason: first.stopReason,
    secondStopReason: second.stopReason,
    publishedMessageCount: publishedBodies.length,
    capabilities: controller.capabilities,
    contextEvents: [...new Set(events)],
    runtimeConfiguration,
    durationMs: Date.now() - startedAt,
    completedAt: new Date().toISOString(),
  };
  const outputPath = resolve(process.env.ANC_SMOKE_OUTPUT
    ?? `artifacts/runtime-smoke/${runtimeId}-${Date.now()}.json`);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${outputPath}\n`);
} finally {
  await controller?.close();
  await gateway.close();
  localDatabase.close();
  rmSync(agentRoot, { recursive: true, force: true });
}
