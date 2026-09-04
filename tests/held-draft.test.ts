import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/http/app.js';
import { AgentWorkspaceGateway, type WorkspaceAgentGatewayApi } from '../src/runtime/agent-workspace-gateway.js';
import type { AgentDiscussionBindingView } from '../src/domain/types.js';
import { HeldArtifactDraftStore } from '../src/storage/held-artifact-draft-store.js';
import { HeldDraftStore } from '../src/storage/held-draft-store.js';
import {
  authorizeAgentInConversation,
  createTestService,
  reportReadyRuntime,
  workspaceGeneral,
} from './helpers.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

describe('Local Held Draft custody', () => {
  it('processes assigned Project WorkItems through the generated teamctl executable', async () => {
    const fixture = await gatewayFixture();
    const project = fixture.service.createProject(
      fixture.principal,
      fixture.workspaceId,
      { name: 'Teamctl board' },
      'teamctl-work-item-project',
    );
    const projectMember = fixture.service.addProjectMember(fixture.principal, project.id, {
      workspaceMembershipId: fixture.agentMembershipId,
      role: 'member',
    }, 'teamctl-work-item-member');
    const projectConversation = fixture.service.listProjectConversations(fixture.principal, project.id).items[0]!;
    const authorizedProjectConversation = authorizeAgentInConversation(
      fixture.service,
      fixture.principal,
      projectConversation,
      fixture.agentMembershipId,
      'teamctl-work-item-conversation-agent',
    );
    const source = fixture.service.postMessage(fixture.principal, authorizedProjectConversation.id, {
      body: '用 teamctl 完成任务看板链路',
    }, 'teamctl-work-item-source');
    const workItem = fixture.service.createWorkItemFromMessage(fixture.principal, source.id, {
      assigneeProjectMembershipId: projectMember.projectMembershipId,
    }, 'teamctl-work-item-create');
    await fixture.useSession(
      { kind: 'work_item', key: workItem.id },
      `work-item:${workItem.id}`,
      project.id,
    );

    expect(await fixture.run(['work-item', 'list', '--project-id', project.id])).toMatchObject({
      kind: 'work_item.list',
      result: { items: [{
        id: workItem.id,
        description: workItem.description,
        lifecycleStatus: 'open',
        sourceConversationId: authorizedProjectConversation.id,
        sourceMessageId: source.id,
        sourceThreadId: null,
      }] },
    });
    expect(await fixture.run(['work-item', 'read', workItem.id])).toMatchObject({
      kind: 'work_item.read',
      result: {
        id: workItem.id,
        sourceConversationId: authorizedProjectConversation.id,
        sourceMessageId: source.id,
        sourceThreadId: null,
        assignmentRevision: 1,
        comments: [],
      },
    });
    expect(await fixture.run([
      'work-item', 'block', workItem.id, '--reason', '需要 Human 补充验收口径',
    ])).toMatchObject({
      kind: 'work_item.block',
      result: { lifecycleStatus: 'blocked', blockerReason: '需要 Human 补充验收口径' },
    });
    const blocked = fixture.service.getWorkItem(fixture.principal, workItem.id);
    fixture.service.unblockWorkItem(
      fixture.principal,
      workItem.id,
      blocked.revision,
      'teamctl-work-item-unblock',
    );

    const comment = await fixture.run([
      'work-item', 'comment', workItem.id, '--body', '真实 teamctl 链路已验证，请验收。',
    ]) as unknown as { result: { id: string; body: string } };
    expect(comment.result.body).toBe('真实 teamctl 链路已验证，请验收。');
    expect(await fixture.run([
      'work-item', 'submit', workItem.id, '--comment-id', comment.result.id,
    ])).toMatchObject({
      kind: 'work_item.submit',
      result: {
        lifecycleStatus: 'open',
        currentSubmission: { commentId: comment.result.id, submittedByActorId: fixture.agentId },
      },
    });
  });

  it('lets one composite WorkItem Session reply in the source Conversation and submit the task', async () => {
    const fixture = await gatewayFixture();
    const project = fixture.service.createProject(
      fixture.principal,
      fixture.workspaceId,
      { name: 'Composite Session board' },
      'teamctl-composite-session-project',
    );
    const projectMember = fixture.service.addProjectMember(fixture.principal, project.id, {
      workspaceMembershipId: fixture.agentMembershipId,
      role: 'member',
    }, 'teamctl-composite-session-member');
    const conversation = authorizeAgentInConversation(
      fixture.service,
      fixture.principal,
      fixture.service.listProjectConversations(fixture.principal, project.id).items[0]!,
      fixture.agentMembershipId,
      'teamctl-composite-session-conversation',
    );
    const source = fixture.service.postMessage(fixture.principal, conversation.id, {
      body: '@Researcher 交付并在群里同步结果',
      mentionedActorIds: [fixture.agentId],
    }, 'teamctl-composite-session-source');
    const requestId = source.mentionOutcomes.find((outcome) => outcome.targetAgentId === fixture.agentId)?.agentRequestId;
    expect(requestId).toBeTruthy();
    const workItem = fixture.service.createWorkItemFromMessage(fixture.principal, source.id, {
      assigneeProjectMembershipId: projectMember.projectMembershipId,
    }, 'teamctl-composite-session-create');
    const input = fixture.service.getComputerAgentSessionInput(
      fixture.apiComputerId,
      fixture.agentId,
      { kind: 'work_item', key: workItem.id },
    );
    expect(input.discussion?.agentRequestId).toBe(requestId);
    await fixture.useSession(
      { kind: 'work_item', key: workItem.id },
      `work-item:${workItem.id}`,
      project.id,
      null,
      input.discussion,
    );

    await fixture.run(['message', 'check', '--target', `conversation:${conversation.id}`]);
    expect(await fixture.run([
      'message', 'send', '--target', `conversation:${conversation.id}`, '--body', '任务已完成，结果已提交。',
    ])).toMatchObject({ kind: 'message.send', result: { status: 'published' } });
    expect(fixture.gateway.sessionWindow.status).toBe('accepting');

    const comment = await fixture.run([
      'work-item', 'comment', workItem.id, '--body', '结果已同步到群聊，请验收。',
    ]) as unknown as { result: { id: string } };
    await fixture.run(['work-item', 'submit', workItem.id, '--comment-id', comment.result.id]);

    expect(fixture.service.listMessages(fixture.principal, conversation.id)
      .some((message) => message.authorActorId === fixture.agentId && message.body === '任务已完成，结果已提交。')).toBe(true);
    expect(fixture.service.getWorkItem(fixture.principal, workItem.id)).toMatchObject({
      currentSubmission: { commentId: comment.result.id },
    });
    expect(fixture.service.getComputerAgentInbox(fixture.apiComputerId, fixture.agentId).sessionTriggers
      .filter((trigger) => trigger.session.kind === 'work_item' && trigger.session.key === workItem.id)).toEqual([]);
  });

  it('lets a Mention Session read only the WorkItem explicitly referenced by its source message', async () => {
    const fixture = await gatewayFixture();
    const project = fixture.service.createProject(
      fixture.principal,
      fixture.workspaceId,
      { name: 'Mention WorkItem board' },
      'teamctl-mentioned-work-item-project',
    );
    const projectMember = fixture.service.addProjectMember(fixture.principal, project.id, {
      workspaceMembershipId: fixture.agentMembershipId,
      role: 'member',
    }, 'teamctl-mentioned-work-item-member');
    const conversation = authorizeAgentInConversation(
      fixture.service,
      fixture.principal,
      fixture.service.listProjectConversations(fixture.principal, project.id).items[0]!,
      fixture.agentMembershipId,
      'teamctl-mentioned-work-item-conversation',
    );
    const workItem = fixture.service.createWorkItem(fixture.principal, project.id, {
      description: '通过 CLI 读取被引用任务',
    }, 'teamctl-mentioned-work-item-create');
    const source = fixture.service.postMessage(fixture.principal, conversation.id, {
      body: '@Researcher 请读取任务',
      mentionedActorIds: [fixture.agentId],
      workItemIds: [workItem.id],
    }, 'teamctl-mentioned-work-item-source');
    const requestId = source.mentionOutcomes.find((outcome) => outcome.targetAgentId === fixture.agentId)?.agentRequestId;
    expect(requestId).toBeTruthy();
    await fixture.useSession(
      { kind: 'mention', key: requestId! },
      `conversation:${conversation.id}`,
      project.id,
    );

    expect(await fixture.run(['work-item', 'read', workItem.id])).toMatchObject({
      kind: 'work_item.read',
      result: { id: workItem.id, description: workItem.description, comments: [] },
    });
    const unrelated = fixture.service.createWorkItem(fixture.principal, project.id, {
      description: '同项目任务可被读取',
    }, 'teamctl-mentioned-work-item-unrelated');
    expect(await fixture.run(['work-item', 'read', unrelated.id])).toMatchObject({
      kind: 'work_item.read', result: { id: unrelated.id, description: unrelated.description },
    });
    expect(projectMember.projectMembershipId).toBeTruthy();
  });

  it('keeps the initial Project scope when message.check returns an empty delta', async () => {
    const fixture = await gatewayFixture();
    const project = fixture.service.createProject(
      fixture.principal,
      fixture.workspaceId,
      { name: 'Empty claim delta project' },
      'teamctl-empty-claim-project',
    );
    fixture.service.addProjectMember(fixture.principal, project.id, {
      workspaceMembershipId: fixture.agentMembershipId,
      role: 'member',
    }, 'teamctl-empty-claim-member');
    const conversation = authorizeAgentInConversation(
      fixture.service,
      fixture.principal,
      fixture.service.listProjectConversations(fixture.principal, project.id).items[0]!,
      fixture.agentMembershipId,
      'teamctl-empty-claim-conversation',
    );
    const source = fixture.service.postMessage(fixture.principal, conversation.id, {
      body: '@Researcher 处理项目任务',
      mentionedActorIds: [fixture.agentId],
    }, 'teamctl-empty-claim-source');
    const requestId = source.mentionOutcomes.find((outcome) => outcome.targetAgentId === fixture.agentId)?.agentRequestId;
    expect(requestId).toBeTruthy();
    await fixture.useSession(
      { kind: 'mention', key: requestId! },
      `conversation:${conversation.id}`,
      project.id,
      source.scopePosition,
    );

    expect(await fixture.run(['message', 'check', '--target', `conversation:${conversation.id}`])).toMatchObject({
      kind: 'message.check',
      result: { discussion: { messages: [] } },
    });
    expect(await fixture.run(['work-item', 'list'])).toMatchObject({
      kind: 'work_item.list',
      result: { items: [] },
    });
  });

  it('submits a published Artifact version as a structured WorkItem result through teamctl', async () => {
    const fixture = await gatewayFixture();
    const project = fixture.service.createProject(
      fixture.principal,
      fixture.workspaceId,
      { name: 'Teamctl Artifact board' },
      'teamctl-artifact-work-item-project',
    );
    const projectMember = fixture.service.addProjectMember(fixture.principal, project.id, {
      workspaceMembershipId: fixture.agentMembershipId,
      role: 'member',
    }, 'teamctl-artifact-work-item-member');
    const conversation = authorizeAgentInConversation(
      fixture.service,
      fixture.principal,
      fixture.service.listProjectConversations(fixture.principal, project.id).items[0]!,
      fixture.agentMembershipId,
      'teamctl-artifact-work-item-conversation',
    );
    const source = fixture.service.postMessage(fixture.principal, conversation.id, {
      body: '提交一张结构化结果图片',
    }, 'teamctl-artifact-work-item-source');
    const workItem = fixture.service.createWorkItemFromMessage(fixture.principal, source.id, {
      description: 'Agent 必须提交 Artifact 版本',
      assigneeProjectMembershipId: projectMember.projectMembershipId,
    }, 'teamctl-artifact-work-item-create');
    await fixture.useSession({ kind: 'work_item', key: workItem.id }, `work-item:${workItem.id}`, project.id);
    const artifact = await fixture.service.artifactV2.publish(
      {
        kind: 'computer', computerId: fixture.apiComputerId, ownerHumanId: fixture.principal.actorId,
        agentId: fixture.agentId,
      },
      project.id,
      { fileName: 'result.png', artifactName: '结构化结果', taskId: workItem.id },
      fixture.service.artifactV2.blobs.writeBufferSync(Buffer.from('png'), 'image/png'),
    );
    expect(await fixture.run([
      'work-item', 'submit', workItem.id, '--artifact-version-id', artifact.version.versionId,
    ])).toMatchObject({
      kind: 'work_item.submit',
      result: {
        currentSubmission: {
          commentId: null,
          artifactReferences: [{ artifactVersionId: artifact.version.versionId, fileName: 'result.png' }],
        },
      },
    });
  });

  it('replays a pending exact submission after response loss and fences old-binding drafts', async () => {
    const fixture = await gatewayFixture();
    await fixture.run(['message', 'check', '--target', fixture.target]);
    fixture.loseNextSendResponse = true;
    const failed = await fixture.runRaw([
      'message', 'send', '--target', fixture.target, '--body', '服务端已发布但响应丢失',
    ]);
    expect(failed.status).not.toBe(0);
    expect(fixture.localDatabase.raw.prepare(
      "SELECT status, body FROM held_drafts WHERE status = 'pending'",
    ).get()).toEqual({ status: 'pending', body: '服务端已发布但响应丢失' });
    expect(fixture.service.listMessages(fixture.principal, fixture.conversationId)
      .filter((message) => message.authorActorId === fixture.agentId)).toHaveLength(1);

    await fixture.gateway.close();
    fixture.gatewayClosed = true;
    const replacement = new AgentWorkspaceGateway(
      fixture.agentRoot,
      fixture.workRoot,
      fixture.session,
      fixture.target,
      null,
      fixture.workspaceId,
      fixture.agentId,
      1,
      fixture.api,
      new HeldDraftStore(fixture.localDatabase),
      new HeldArtifactDraftStore(fixture.localDatabase),
    );
    cleanup.push(() => replacement.close());
    await replacement.prepare();
    expect(fixture.localDatabase.raw.prepare(
      'SELECT status FROM held_drafts WHERE body = ?',
    ).get('服务端已发布但响应丢失')).toEqual({ status: 'published' });
    expect(fixture.service.listMessages(fixture.principal, fixture.conversationId)
      .filter((message) => message.authorActorId === fixture.agentId)).toHaveLength(1);

    const store = new HeldDraftStore(fixture.localDatabase);
    const pending = store.createOrReviseCandidate({
      workspaceId: fixture.workspaceId,
      agentId: fixture.agentId,
      bindingRevision: 1,
      sessionKind: 'mention',
      sessionKey: fixture.session.key,
      target: fixture.target,
      receipt: 'old-binding-receipt',
      body: '旧 Binding 草稿',
      basedOnPosition: 1,
    });
    expect(store.fenceOtherBindings(fixture.workspaceId, fixture.agentId, 2)).toBe(1);
    expect(fixture.localDatabase.raw.prepare('SELECT status FROM held_drafts WHERE id = ?').get(pending.id))
      .toEqual({ status: 'fenced' });
    const artifactStore = new HeldArtifactDraftStore(fixture.localDatabase);
    const artifactPending = artifactStore.createOrReviseCandidate({
      id: randomUUID(),
      workspaceId: fixture.workspaceId,
      agentId: fixture.agentId,
      bindingRevision: 1,
      sessionKind: 'mention',
      sessionKey: fixture.session.key,
      draftKey: 'create:old-binding',
      artifactId: null,
      publication: { kind: 'file', fileName: 'old-binding.txt', mediaType: 'text/plain' },
      contentPath: '/tmp/nonexistent-held-artifact',
      proposedDigest: 'a'.repeat(64),
    });
    expect(artifactStore.fenceOtherBindings(fixture.workspaceId, fixture.agentId, 2)).toBe(1);
    expect(fixture.localDatabase.raw.prepare(
      'SELECT status FROM held_artifact_drafts WHERE id = ?',
    ).get(artifactPending.id)).toEqual({ status: 'fenced' });
  });

});

async function gatewayFixture() {
  const test = createTestService();
  cleanup.push(test.close);
  const alice = test.service.bootstrapHuman('Alice', 'alice@example.com');
  const principal = { kind: 'human' as const, actorId: alice.humanId };
  const workspace = test.service.createWorkspace(principal, 'Product', 'held-workspace');
  const computer = test.service.registerComputer(principal, { name: 'Alice Mac' }, 'held-computer');
  reportReadyRuntime(test.service, computer.computerId, alice.humanId, 'generic-acp');
  const agent = test.service.createAgent(principal, workspace.id, {
    name: 'Researcher',
    runtimeBinding: { computerId: computer.computerId, runtimeId: 'generic-acp' },
  }, 'held-agent');
  const conversation = authorizeAgentInConversation(
    test.service,
    principal,
    workspaceGeneral(test.service, principal, workspace.id),
    agent.membershipId,
    'held-general-agent',
  );
  const initialMessage = test.service.postMessage(principal, conversation.id, {
    body: '初始请求',
    mentionedActorIds: [agent.id],
  }, 'held-initial');
  let session: { kind: 'mention' | 'work_item'; key: string } = {
    kind: 'mention',
    key: initialMessage.mentionOutcomes.find((outcome) => outcome.targetAgentId === agent.id)?.agentRequestId ?? 'missing-request',
  };
  const app = await buildApp(test.service);
  cleanup.push(() => app.close());
  const root = mkdtempSync(resolve(tmpdir(), 'anc-held-draft-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const agentRoot = resolve(root, 'agent');
  const workRoot = resolve(agentRoot, 'work');
  mkdirSync(workRoot, { recursive: true });
  const mutable = {
    beforeNextSend: undefined as (() => void) | undefined,
    loseNextSendResponse: false,
    loseNextArtifactResponse: false,
  };
  const api: WorkspaceAgentGatewayApi = {
    request: async <T>(path: string, request: {
      method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
      body?: unknown;
      idempotencyKey?: string;
    }): Promise<T> => {
      const isSend = request.method === 'POST' && /\/messages$/u.test(path);
      const isArtifactPublication = /\/artifacts(?:\/urls|\/[^/]+)?$/u.test(path)
        && (request.method === 'POST' || request.method === 'PATCH');
      if (isSend && mutable.beforeNextSend) {
        const before = mutable.beforeNextSend;
        mutable.beforeNextSend = undefined;
        before();
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
      if (isSend && mutable.loseNextSendResponse) {
        mutable.loseNextSendResponse = false;
        throw new Error('simulated response loss');
      }
      if (isArtifactPublication && mutable.loseNextArtifactResponse) {
        mutable.loseNextArtifactResponse = false;
        throw new Error('simulated Artifact response loss');
      }
      return response.json<T>();
    },
  };
  const heldDrafts = new HeldDraftStore(test.localDatabase);
  let gateway = new AgentWorkspaceGateway(
    agentRoot,
    workRoot,
    session,
    `conversation:${conversation.id}`,
    null,
    workspace.id,
    agent.id,
    1,
    api,
    heldDrafts,
    new HeldArtifactDraftStore(test.localDatabase),
  );
  let bound = await gateway.prepare();
  const gatewayState = { closed: false };
  cleanup.push(async () => {
    if (!gatewayState.closed) await gateway.close();
  });
  const useSession = async (
    nextSession: { kind: 'mention' | 'work_item'; key: string },
    nextTarget: string | null,
    nextProjectId: string | null,
    nextInitialDiscussionFrontier?: number | null,
    nextDiscussion?: AgentDiscussionBindingView | null,
  ): Promise<void> => {
    if (!gatewayState.closed) await gateway.close();
    session = nextSession;
    gateway = new AgentWorkspaceGateway(
      agentRoot,
      workRoot,
      nextSession,
      nextTarget,
      nextProjectId,
      workspace.id,
      agent.id,
      1,
      api,
      heldDrafts,
      new HeldArtifactDraftStore(test.localDatabase),
      nextInitialDiscussionFrontier ?? null,
      nextDiscussion ? { mode: 'isolated', acceptedMessages: 0, maxMessages: 10, status: 'accepting' } : undefined,
      nextDiscussion ?? null,
    );
    bound = await gateway.prepare();
    gatewayState.closed = false;
  };
  const runRaw = (args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> => (
    new Promise((resolveRun, rejectRun) => {
      const child = spawn(process.platform === 'win32' ? 'teamctl.cmd' : 'teamctl', args, {
        cwd: workRoot,
        env: { ...process.env, ...bound.env },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { stdout += chunk; });
      child.stderr.on('data', (chunk: string) => { stderr += chunk; });
      child.once('error', rejectRun);
      child.once('close', (status) => resolveRun({ status, stdout, stderr }));
    })
  );
  const run = async (args: string[]): Promise<Record<string, unknown>> => {
    const result = await runRaw(args);
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    return JSON.parse(result.stdout.trim()) as Record<string, unknown>;
  };
  return {
    ...test,
    principal,
    workspaceId: workspace.id,
    agentId: agent.id,
    agentMembershipId: agent.membershipId,
    apiComputerId: computer.computerId,
    conversationId: conversation.id,
    target: `conversation:${conversation.id}`,
    get session() { return session; },
    agentRoot,
    workRoot,
    api,
    get gateway() { return gateway; },
    useSession,
    get gatewayClosed() { return gatewayState.closed; },
    set gatewayClosed(value: boolean) { gatewayState.closed = value; },
    run,
    runRaw,
    get beforeNextSend() { return mutable.beforeNextSend; },
    set beforeNextSend(value: (() => void) | undefined) { mutable.beforeNextSend = value; },
    get loseNextSendResponse() { return mutable.loseNextSendResponse; },
    set loseNextSendResponse(value: boolean) { mutable.loseNextSendResponse = value; },
    get loseNextArtifactResponse() { return mutable.loseNextArtifactResponse; },
    set loseNextArtifactResponse(value: boolean) { mutable.loseNextArtifactResponse = value; },
  };
}
