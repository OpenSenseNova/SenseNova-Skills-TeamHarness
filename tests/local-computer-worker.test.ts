import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/http/app.js';
import { LocalComputerWorker, type LocalComputerApiRequest } from '../src/runtime/local-computer-worker.js';
import type { LocalRuntimeDetection } from '../src/runtime/local-runtime-catalog.js';
import { inspectGitWorkingCopy, ProjectWorkingCopyStore } from '../src/runtime/project-working-copy.js';
import { LocalExecutionStore } from '../src/storage/local-execution-store.js';
import { createTestService, reportReadyRuntime } from './helpers.js';

describe('Local Computer worker', () => {
  it('runs a locally-created Project mention in a pinned worktree and publishes a normal Conversation Message', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'anc-project-vertical-'));
    const checkout = resolve(root, 'checkout');
    execFileSync('git', ['init', '--initial-branch=main', checkout]);
    execFileSync('git', ['-C', checkout, 'config', 'user.name', 'Test']);
    execFileSync('git', ['-C', checkout, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', checkout, 'remote', 'add', 'origin', 'git@github.com:Example/Vertical.git']);
    writeFileSync(resolve(checkout, 'tracked.txt'), 'committed\n');
    execFileSync('git', ['-C', checkout, 'add', 'tracked.txt']);
    execFileSync('git', ['-C', checkout, 'commit', '-m', 'initial']);
    const inspected = inspectGitWorkingCopy(checkout);
    writeFileSync(resolve(checkout, 'tracked.txt'), 'dirty main checkout\n');

    const { service, localDatabase } = createTestService();
    const alice = service.bootstrapHuman('Alice', 'alice@example.com');
    const principal = { kind: 'human' as const, actorId: alice.humanId };
    const workspace = service.createWorkspace(principal, 'Product', 'vertical-workspace');
    const computer = service.registerComputer(principal, { name: 'Alice Mac' }, 'vertical-computer');
    reportReadyRuntime(service, computer.computerId, alice.humanId, 'codex');
    const computerPrincipal = {
      kind: 'computer' as const,
      computerId: computer.computerId,
      ownerHumanId: alice.humanId,
    };
    const project = service.createProjectFromComputer(computerPrincipal, {
      workspaceId: workspace.id,
      name: 'Vertical',
      description: 'End-to-end Repository Project',
      repository: {
        cloneUrl: inspected.cloneUrl,
        repositoryIdentity: inspected.repositoryIdentity,
        defaultBranch: inspected.defaultBranch,
      },
      workingCopy: {
        repositoryIdentity: inspected.repositoryIdentity,
        availability: 'ready',
        branch: inspected.branch,
        headCommit: inspected.headCommit,
        dirty: true,
      },
    }, 'vertical-project');
    new ProjectWorkingCopyStore(localDatabase).bind({
      project_id: project.id,
      workspace_id: workspace.id,
      repository_id: project.repository!.id,
      repository_identity: project.repository!.repositoryIdentity,
      absolute_path: checkout,
    });
    const agent = service.createAgent(principal, workspace.id, {
      name: 'Builder',
      runtimeBinding: { computerId: computer.computerId, runtimeId: 'codex' },
    }, 'vertical-agent');
    const projectAgent = service.addProjectMember(principal, project.id, {
      workspaceMembershipId: agent.membershipId,
      role: 'member',
    }, 'vertical-project-agent');
    const conversation = service.createProjectConversation(principal, project.id, {
      kind: 'channel',
    }, 'vertical-conversation');
    service.postMessage(principal, conversation.id, {
      body: '@Builder inspect the Repository',
      mentionedActorIds: [agent.id],
    }, 'vertical-message');

    const app = await buildApp(service);
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
          env: { FAKE_ACP_USE_TEAMCTL: 'message' },
        },
      },
      ...(['claude', 'gemini', 'goose', 'hermes', 'generic-acp'] as const).map((runtimeId) => ({
        runtimeId,
        availability: 'not_installed' as const,
        skills: { global: [], workspace: [] },
        launch: null,
      })),
    ];
    try {
      const worker = new LocalComputerWorker({
        api: {
          request: async <T>(path: string, request: LocalComputerApiRequest): Promise<T> => {
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
        attemptRoot: resolve(root, 'attempts'),
        detections,
      });
      await expect(worker.runOnce()).resolves.toBe(1);
      const messages = service.listMessages(principal, conversation.id);
      expect(messages.at(-1)).toMatchObject({ authorActorId: agent.id, body: 'prompt-1' });
      const execution = localDatabase.raw.prepare(
        `SELECT attempt_id, working_directory, execution_kind, repository_identity
         FROM local_runtime_executions ORDER BY started_at DESC LIMIT 1`,
      ).get() as { attempt_id: string; working_directory: string; execution_kind: string; repository_identity: string };
      expect(execution).toMatchObject({
        execution_kind: 'project_repository',
        repository_identity: inspected.repositoryIdentity,
      });
      expect(execution.working_directory).toBe(realpathSync(resolve(root, 'attempts', execution.attempt_id, 'work')));
      expect(readFileSync(resolve(execution.working_directory, 'tracked.txt'), 'utf8')).toBe('committed\n');
      expect(existsSync(resolve(execution.working_directory, 'AGENTS.md'))).toBe(false);
    } finally {
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

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
    const attemptRoot = mkdtempSync(resolve(tmpdir(), 'anc-worker-'));
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
            FAKE_ACP_FORBID_PROMPT_TEXT: '请直接回复我',
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
        attemptRoot,
        detections,
      });

      await expect(worker.runOnce()).resolves.toBe(1);
      const messages = service.listMessages(principal, conversation.id);
      expect(messages).toHaveLength(4);
      expect(messages[3]).toMatchObject({
        authorActorId: agent.id,
        authorActorType: 'agent',
        body: 'prompt-2',
      });
      const completed = service.getAgentRequest(principal, requestId);
      expect(completed).toMatchObject({
        status: 'accepted',
        run: { status: 'terminal', outcome: 'publish' },
      });
      const localExecution = localDatabase.raw
        .prepare('SELECT phase FROM local_runtime_executions')
        .get();
      expect(localExecution).toEqual({ phase: 'finished' });

      worker.updateDetections(detections.map((detection) => {
        if (detection.runtimeId !== 'generic-acp' || !detection.launch?.env) return detection;
        return detection;
      }));

      const recoverableSource = service.postMessage(
        principal,
        conversation.id,
        { body: '@Researcher 这条在 Computer 重启后继续', mentionedActorIds: [agent.id] },
        'worker-recovery-source',
      );
      const recoverableRequestId = recoverableSource.mentionOutcomes[0]!.agentRequestId!;
      const recoverableRun = service.acceptAgentRequest(
        computer.computerId,
        recoverableRequestId,
        { expectedVersion: 1 },
        'worker-recovery-accept',
      );
      service.createAttempt(computer.computerId, recoverableRun.id, 'worker-recovery-attempt');
      await expect(worker.runOnce()).resolves.toBe(1);
      expect(service.getAgentRequest(principal, recoverableRequestId)).toMatchObject({
        status: 'accepted',
        run: { status: 'terminal', outcome: 'publish' },
      });
      await expect(worker.runOnce()).resolves.toBe(0);

      worker.updateDetections(detections.map((detection) => {
        if (detection.runtimeId !== 'generic-acp' || !detection.launch) return detection;
        const { env: _ignoredEnvironment, ...launchWithoutEnvironment } = detection.launch;
        return { ...detection, launch: launchWithoutEnvironment };
      }));
      const silentSource = service.postMessage(
        principal,
        conversation.id,
        { body: '@Researcher ACP 文本不能自动成为 Message', mentionedActorIds: [agent.id] },
        'worker-missing-teamctl-source',
      );
      const silentRequestId = silentSource.mentionOutcomes[0]!.agentRequestId!;
      await expect(worker.runOnce()).resolves.toBe(0);
      expect(service.getAgentRequest(principal, silentRequestId)).toMatchObject({
        status: 'accepted',
        run: { status: 'terminal', outcome: 'failed' },
      });
      expect(service.listMessages(principal, conversation.id).filter((message) => message.authorActorType === 'agent'))
        .toHaveLength(3);
    } finally {
      await app.close();
      rmSync(attemptRoot, { recursive: true, force: true });
    }
  });

  it('handles a message arriving during execution at the next safe boundary in the same Run', async () => {
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
    const attemptRoot = mkdtempSync(resolve(tmpdir(), 'anc-worker-steering-'));
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
              service.postMessage(principal, conversation.id, { body: '你是谁' }, 'worker-steering-follow-up');
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
        attemptRoot,
        detections,
      });

      await expect(worker.runOnce()).resolves.toBe(1);
      const agentMessages = service.listMessages(principal, conversation.id)
        .filter((message) => message.authorActorType === 'agent');
      expect(agentMessages).toMatchObject([
        { authorActorId: agent.id, body: 'prompt-1' },
        { authorActorId: agent.id, body: 'prompt-2' },
      ]);
    } finally {
      await app.close();
      rmSync(attemptRoot, { recursive: true, force: true });
    }
  });

  it('lets two ACP Agents collaborate on one Project Artifact through teamctl and normal Messages', async () => {
    const { service, localDatabase, workspaceDatabase } = createTestService();
    const alice = service.bootstrapHuman('Alice', 'alice@example.com');
    const principal = { kind: 'human' as const, actorId: alice.humanId };
    const workspace = service.createWorkspace(principal, 'Product', 'multi-agent-artifact-workspace');
    const computer = service.registerComputer(principal, { name: 'Alice Mac' }, 'multi-agent-artifact-computer');
    reportReadyRuntime(service, computer.computerId, alice.humanId, 'generic-acp');
    const project = service.createProject(principal, workspace.id, {
      name: 'Artifact delivery',
      description: 'Repository is optional for this collaboration scope.',
    }, 'multi-agent-artifact-project');
    const writer = service.createAgent(principal, workspace.id, {
      name: 'Writer',
      runtimeBinding: { computerId: computer.computerId, runtimeId: 'generic-acp' },
    }, 'multi-agent-artifact-writer');
    const reviewer = service.createAgent(principal, workspace.id, {
      name: 'Reviewer',
      runtimeBinding: { computerId: computer.computerId, runtimeId: 'generic-acp' },
    }, 'multi-agent-artifact-reviewer');
    const writerProjectMember = service.addProjectMember(principal, project.id, {
      workspaceMembershipId: writer.membershipId,
      role: 'member',
    }, 'multi-agent-writer-project-member');
    const reviewerProjectMember = service.addProjectMember(principal, project.id, {
      workspaceMembershipId: reviewer.membershipId,
      role: 'member',
    }, 'multi-agent-reviewer-project-member');
    const conversation = service.createProjectConversation(principal, project.id, {
      kind: 'channel',
      title: 'Artifact collaboration',
    }, 'multi-agent-artifact-conversation');
    service.postMessage(principal, conversation.id, {
      body: '@Writer create the shared Artifact.',
      mentionedActorIds: [writer.id],
    }, 'multi-agent-writer-request');

    const app = await buildApp(service);
    const attemptRoot = mkdtempSync(resolve(tmpdir(), 'anc-multi-agent-artifact-'));
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
          env: { FAKE_ACP_USE_TEAMCTL: 'multi-artifact' },
        },
      },
      ...(['codex', 'claude', 'gemini', 'goose', 'hermes'] as const).map((runtimeId) => ({
        runtimeId,
        availability: 'not_installed' as const,
        skills: { global: [], workspace: [] },
        launch: null,
      })),
    ];
    const api = {
      request: async <T>(path: string, request: LocalComputerApiRequest): Promise<T> => {
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
      uploadFile: async <T>(path: string, file: { filePath: string; fileName: string; mediaType: string }): Promise<T> => {
        const attemptId = path.match(/^\/v1\/attempts\/([^/]+)\/staged-blobs$/u)?.[1];
        if (!attemptId) throw new Error(`Unexpected staged upload path ${path}.`);
        const blob = await service.artifacts.blobs.writeBuffer(readFileSync(file.filePath), file.mediaType);
        return service.stageAttemptBlob(computer.computerId, attemptId, blob) as T;
      },
    };
    const worker = new LocalComputerWorker({
      api,
      localExecutions: new LocalExecutionStore(localDatabase),
      attemptRoot,
      detections,
    });
    try {
      await expect(worker.runOnce()).resolves.toBe(1);
      const firstArtifact = service.artifacts.list(principal, workspace.id, { projectId: project.id })[0]!;
      expect(firstArtifact).toMatchObject({
        name: 'multi-agent-artifact.md',
        artifactType: 'markdown',
        projectIds: [project.id],
        latestSnapshot: { status: 'active' },
      });

      service.postMessage(principal, conversation.id, {
        body: '@Reviewer review and update the shared Artifact.',
        mentionedActorIds: [reviewer.id],
      }, 'multi-agent-reviewer-request');
      const reviewerBaseline = service.artifacts.get(principal, firstArtifact.id).currentState;
      const reviewerBlob = service.artifacts.currentBlob(principal, firstArtifact.id);
      worker.updateDetections(detections.map((detection) => {
        if (detection.runtimeId !== 'generic-acp' || !detection.launch) return detection;
        return {
          ...detection,
          launch: {
            ...detection.launch,
            env: {
              ...detection.launch.env,
              FAKE_ACP_ARTIFACT_ID: firstArtifact.id,
              FAKE_ACP_ARTIFACT_PATH: reviewerBlob.storagePath,
              FAKE_ACP_ARTIFACT_REVISION: String(reviewerBaseline.currentRevision),
              FAKE_ACP_ARTIFACT_DIGEST: reviewerBaseline.contentDigest,
              FAKE_ACP_ARTIFACT_TYPE: firstArtifact.artifactType,
              FAKE_ACP_ARTIFACT_NAME: firstArtifact.name,
            },
          },
        };
      }));
      await expect(worker.runOnce()).resolves.toBe(1);

      const artifact = service.artifacts.get(principal, firstArtifact.id);
      const snapshots = service.artifacts.listSnapshots(principal, artifact.id);
      const firstSnapshot = snapshots.find((snapshot) => snapshot.snapshotId !== artifact.latestSnapshot?.snapshotId)!;
      expect(artifact.latestSnapshot).toMatchObject({ parentSnapshotId: firstSnapshot.snapshotId });
      expect(readFileSync(service.artifacts.snapshotBlob(
        principal,
        artifact.id,
        artifact.latestSnapshot!.snapshotId,
      ).storagePath, 'utf8')).toContain('Reviewer revision.');
      const producingAgents = workspaceDatabase.raw.prepare(
        `SELECT r.agent_id
         FROM artifact_snapshots av
         JOIN runs r ON r.id = av.producing_run_id
         WHERE av.artifact_id = ?
         ORDER BY av.created_at, av.id`,
      ).all(artifact.id) as Array<{ agent_id: string }>;
      expect(producingAgents).toEqual([{ agent_id: writer.id }, { agent_id: reviewer.id }]);
      const agentMessages = service.listMessages(principal, conversation.id)
        .filter((message) => message.authorActorType === 'agent');
      expect(agentMessages).toMatchObject([
        {
          authorActorId: writer.id,
          body: 'Writer published the first Artifact version.',
          artifactReferences: [],
        },
        {
          authorActorId: reviewer.id,
          body: 'Reviewer published the second Artifact version.',
          artifactReferences: [],
        },
      ]);
    } finally {
      await app.close();
      rmSync(attemptRoot, { recursive: true, force: true });
    }
  });
});
