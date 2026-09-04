import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/http/app.js';
import { LocalComputerWorker, type LocalComputerApiRequest } from '../src/runtime/local-computer-worker.js';
import type { LocalRuntimeDetection } from '../src/runtime/local-runtime-catalog.js';
import { LocalExecutionStore } from '../src/storage/local-execution-store.js';
import {
  authorizeAgentInConversation,
  createTestService,
  reportReadyRuntime,
} from './helpers.js';

describe('Local Computer worker', () => {
  it('executes a plain Human message in an Agent DM through ACP and publishes the Agent reply', async () => {
    const { service, localDatabase } = createTestService();
    const alice = service.bootstrapHuman('Alice', 'alice@example.com');
    const principal = { kind: 'human' as const, actorId: alice.humanId };
    const workspace = service.createWorkspace(principal, 'Product', 'worker-workspace');
    const computer = service.registerComputer(principal, { name: 'Alice Mac' }, 'worker-computer');
    reportReadyRuntime(service, computer.computerId, alice.humanId, 'generic-acp');
    const agent = service.createAgent(principal, workspace.id, {
      name: 'Researcher',
      runtimeBinding: { computerId: computer.computerId, runtimeId: 'generic-acp' },
    }, 'worker-agent');
    const conversation = service.createConversation(
      principal,
      workspace.id,
      { kind: 'dm', directWorkspaceMembershipIds: [agent.membershipId] },
      'worker-agent-dm',
    );
    const source = service.postMessage(
      principal,
      conversation.id,
      { body: '请直接回复我' },
      'worker-source-message',
    );
    const requestId = source.mentionOutcomes[0]!.agentRequestId!;
    const app = await buildApp(service);
    const agentRoot = mkdtempSync(resolve(tmpdir(), 'anc-worker-'));
    const fixture = resolve(process.cwd(), 'tests/fixtures/fake-acp-agent.ts');
    const detections: LocalRuntimeDetection[] = [
      {
        runtimeId: 'generic-acp',
        availability: 'ready',
        skills: { global: [], workspace: [] },
        launch: {
          runtimeId: 'generic-acp',
          command: process.execPath,
          args: ['--import', import.meta.resolve('tsx'), fixture],
          env: {
            FAKE_ACP_USE_TEAMCTL: 'message',
            FAKE_ACP_REQUEST_TEAMCTL_PERMISSION: '1',
            FAKE_ACP_EMIT_ACTIVITY: '1',
          },
        },
      },
      ...(['codex', 'claude', 'gemini', 'goose', 'hermes'] as const).map((runtimeId) => ({
        runtimeId,
        availability: 'not_installed' as const,
        skills: { global: [], workspace: [] },
        launch: null,
      })),
    ];
    let injectedRunningFollowUp = false;
    let injectedFollowUpRequestId: string | null = null;
    try {
      const worker = new LocalComputerWorker({
        api: {
          request: async <T>(path: string, request: LocalComputerApiRequest): Promise<T> => {
            if (
              !injectedRunningFollowUp
              && request.method === 'POST'
              && /\/v1\/computers\/self\/agents\/[^/]+\/messages$/u.test(path)
            ) {
              injectedRunningFollowUp = true;
              const followUp = service.postMessage(
                principal,
                conversation.id,
                { body: '你是谁' },
                'worker-running-follow-up',
              );
              expect(followUp.mentionOutcomes[0]).toMatchObject({ outcome: 'requested' });
              injectedFollowUpRequestId = followUp.mentionOutcomes[0]!.agentRequestId!;
            }
            const headers = {
              authorization: `Bearer ${computer.token}`,
              ...(request.idempotencyKey ? { 'idempotency-key': request.idempotencyKey } : {}),
            };
            const response = request.body === undefined
              ? await app.inject({ method: request.method, url: path, headers })
              : await app.inject({
                  method: request.method,
                  url: path,
                  headers: { ...headers, 'content-type': 'application/json' },
                  payload: JSON.stringify(request.body),
                });
            if (response.statusCode < 200 || response.statusCode >= 300) {
              throw new Error(`HTTP ${response.statusCode}: ${response.body}`);
            }
            return response.json<T>();
          },
        },
        localExecutions: new LocalExecutionStore(localDatabase),
        agentRoot,
        detections,
      });

      await expect(worker.runOnce()).resolves.toBe(1);
      const messages = service.listMessages(principal, conversation.id);
      expect(messages).toHaveLength(3);
      expect(messages[2]).toMatchObject({
        authorActorId: agent.id,
        authorActorType: 'agent',
        body: 'prompt-2',
      });
      const completed = service.getAgentRequest(principal, requestId);
      expect(completed).toMatchObject({
        status: 'accepted',
        run: null,
      });
      expect(localDatabase.raw.prepare('SELECT COUNT(*) AS count FROM local_runtime_executions').get())
        .toEqual({ count: 0 });
      expect(localDatabase.raw.prepare(
        "SELECT COUNT(*) AS count FROM runtime_sessions WHERE agent_id = ? AND status = 'active'",
      ).get(agent.id)).toEqual({ count: 0 });
      const activity = service.listAgentActivity(principal, workspace.id, agent.id);
      expect(activity[0]).toMatchObject({
        agentId: agent.id,
        agentName: 'Researcher',
        eventType: 'turn_completed',
        title: '本轮处理完成',
        turnStatus: 'completed',
      });
      expect(activity).toEqual(expect.arrayContaining([
        expect.objectContaining({ eventType: 'plan', title: '计划：检查项目文件' }),
        expect.objectContaining({ eventType: 'tool', title: '读取项目文件', status: 'completed' }),
      ]));
      expect(JSON.stringify(activity)).not.toMatch(/private reasoning|private tool output|private\/example/iu);

      worker.updateDetections(detections.map((detection) => {
        if (detection.runtimeId !== 'generic-acp' || !detection.launch?.env) return detection;
        return detection;
      }));

      expect(injectedFollowUpRequestId).not.toBeNull();
      await expect(worker.runOnce()).resolves.toBe(0);
      expect(service.getAgentRequest(principal, injectedFollowUpRequestId!)).toMatchObject({
        status: 'accepted',
        run: null,
      });

      const recoverableSource = service.postMessage(
        principal,
        conversation.id,
        { body: '@Researcher 这条在 Computer 重启后继续', mentionedActorIds: [agent.id] },
        'worker-recovery-source',
      );
      const recoverableRequestId = recoverableSource.mentionOutcomes[0]!.agentRequestId!;
      await expect(worker.runOnce()).resolves.toBe(1);
      expect(service.getAgentRequest(principal, recoverableRequestId)).toMatchObject({
        status: 'accepted',
        run: null,
      });
      expect(localDatabase.raw.prepare(
        "SELECT COUNT(*) AS count FROM runtime_sessions WHERE agent_id = ? AND status = 'closed'",
      ).get(agent.id)).toEqual({ count: 2 });
      await expect(worker.runOnce()).resolves.toBe(0);
      await worker.close();
    } finally {
      await app.close();
      rmSync(agentRoot, { recursive: true, force: true });
    }
  });

  it('keeps a message arriving during execution in the active DM window', async () => {
    const { service, localDatabase } = createTestService();
    const alice = service.bootstrapHuman('Alice', 'alice@example.com');
    const principal = { kind: 'human' as const, actorId: alice.humanId };
    const workspace = service.createWorkspace(principal, 'Product', 'worker-steering-workspace');
    const computer = service.registerComputer(principal, { name: 'Alice Mac' }, 'worker-steering-computer');
    reportReadyRuntime(service, computer.computerId, alice.humanId, 'codex');
    const agent = service.createAgent(principal, workspace.id, {
      name: 'Researcher',
      runtimeBinding: { computerId: computer.computerId, runtimeId: 'codex' },
    }, 'worker-steering-agent');
    const conversation = service.createConversation(
      principal,
      workspace.id,
      { kind: 'dm', directWorkspaceMembershipIds: [agent.membershipId] },
      'worker-steering-dm',
    );
    service.postMessage(principal, conversation.id, { body: '先等一下' }, 'worker-steering-source');

    const app = await buildApp(service);
    const agentRoot = mkdtempSync(resolve(tmpdir(), 'anc-worker-steering-'));
    const fixture = resolve(process.cwd(), 'tests/fixtures/fake-acp-agent.ts');
    const detections: LocalRuntimeDetection[] = [
      {
        runtimeId: 'codex',
        availability: 'ready',
        skills: { global: [], workspace: [] },
        launch: {
          runtimeId: 'codex',
          command: process.execPath,
          args: ['--import', import.meta.resolve('tsx'), fixture],
          env: {
            FAKE_ACP_USE_TEAMCTL: 'message',
          },
        },
      },
      ...(['claude', 'gemini', 'goose', 'hermes', 'generic-acp'] as const).map((runtimeId) => ({
        runtimeId,
        availability: 'not_installed' as const,
        skills: { global: [], workspace: [] },
        launch: null,
      })),
    ];
    let injectedFollowUp = false;
    let injectedFollowUpRequestId: string | null = null;
    try {
      const worker = new LocalComputerWorker({
        api: {
          request: async <T>(path: string, request: LocalComputerApiRequest): Promise<T> => {
            if (
              !injectedFollowUp
              && request.method === 'POST'
              && /\/v1\/computers\/self\/agents\/[^/]+\/messages$/u.test(path)
            ) {
              injectedFollowUp = true;
              const followUp = service.postMessage(
                principal,
                conversation.id,
                { body: '你是谁' },
                'worker-steering-follow-up',
              );
              injectedFollowUpRequestId = followUp.mentionOutcomes[0]!.agentRequestId!;
            }
            const headers = {
              authorization: `Bearer ${computer.token}`,
              ...(request.idempotencyKey ? { 'idempotency-key': request.idempotencyKey } : {}),
            };
            const response = await app.inject({
              method: request.method,
              url: path,
              headers: request.body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
              ...(request.body === undefined ? {} : { payload: JSON.stringify(request.body) }),
            });
            if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(response.body);
            return response.json<T>();
          },
        },
        localExecutions: new LocalExecutionStore(localDatabase),
        agentRoot,
        detections,
      });

      await expect(worker.runOnce()).resolves.toBe(1);
      const agentMessages = service.listMessages(principal, conversation.id)
        .filter((message) => message.authorActorType === 'agent');
      expect(agentMessages).toMatchObject([
        { authorActorId: agent.id, body: 'prompt-2' },
      ]);
      expect(localDatabase.raw.prepare(
        "SELECT COUNT(*) AS count FROM runtime_sessions WHERE agent_id = ? AND status = 'active'",
      ).get(agent.id)).toEqual({ count: 0 });
      expect(injectedFollowUpRequestId).not.toBeNull();
      await expect(worker.runOnce()).resolves.toBe(0);
      expect(service.getAgentRequest(principal, injectedFollowUpRequestId!)).toMatchObject({ status: 'accepted' });
      expect(service.listMessages(principal, conversation.id)
        .filter((message) => message.authorActorType === 'agent')).toMatchObject([
        { authorActorId: agent.id, body: 'prompt-2' },
      ]);
      expect(localDatabase.raw.prepare(
        `SELECT COUNT(*) AS count, COUNT(DISTINCT session_key) AS session_count
         FROM runtime_sessions WHERE agent_id = ? AND status = 'closed'`,
      ).get(agent.id)).toEqual({ count: 1, session_count: 1 });
      await worker.close();
    } finally {
      await app.close();
      rmSync(agentRoot, { recursive: true, force: true });
    }
  });

});
