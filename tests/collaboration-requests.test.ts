import { describe, expect, it } from 'vitest';
import { newId } from '../src/lib/values.js';
import { createTestService, reportReadyRuntime } from './helpers.js';

describe('Collaboration requests', () => {
  it('implicitly requests the direct Agent in a DM while keeping Human DMs non-agentic', () => {
    const { service } = createTestService();
    const alice = service.bootstrapHuman('Alice', 'alice@example.com');
    const bob = service.bootstrapHuman('Bob', 'bob@example.com');
    const alicePrincipal = { kind: 'human' as const, actorId: alice.humanId };
    const bobPrincipal = { kind: 'human' as const, actorId: bob.humanId };
    const workspace = service.createWorkspace(alicePrincipal, 'Product', 'direct-agent-workspace');
    const bobInvitation = service.createInvitation(
      alicePrincipal,
      workspace.id,
      { verifiedEmail: 'bob@example.com', membershipRole: 'member' },
      'invite-bob-for-direct-message',
    );
    const bobMembershipId = service.acceptInvitation(
      bobPrincipal,
      bobInvitation.id,
      bobInvitation.revision,
      'accept-bob-for-direct-message',
    ).membershipId;
    const agent = service.createAgent(alicePrincipal, workspace.id, { name: 'Researcher' }, 'direct-message-agent');

    const agentDm = service.createConversation(
      alicePrincipal,
      workspace.id,
      { kind: 'dm', directWorkspaceMembershipIds: [agent.membershipId] },
      'agent-direct-message',
    );
    const directMessage = service.postMessage(
      alicePrincipal,
      agentDm.id,
      { body: '请直接调查这个问题' },
      'agent-direct-message-source',
    );
    expect(directMessage.mentions).toEqual([
      expect.objectContaining({ actorId: agent.id, actorType: 'agent', displayName: 'Researcher' }),
    ]);
    expect(directMessage.mentionOutcomes).toEqual([
      expect.objectContaining({
        targetReference: agent.id,
        targetAgentId: agent.id,
        outcome: 'requested',
      }),
    ]);
    expect(service.listAgentRequests(alicePrincipal, agentDm.id)).toEqual([
      expect.objectContaining({
        sourceMessageId: directMessage.id,
        targetAgentId: agent.id,
        resultConversationId: agentDm.id,
        resultThreadId: null,
        status: 'pending',
      }),
    ]);

    const directReply = service.replyToMessage(
      alicePrincipal,
      directMessage.id,
      { body: '在线程里补充一个条件' },
      'agent-direct-message-reply',
    );
    expect(directReply.mentionOutcomes[0]).toMatchObject({
      targetAgentId: agent.id,
      outcome: 'requested',
    });
    expect(service.listAgentRequests(alicePrincipal, agentDm.id, directReply.threadId!)[0]).toMatchObject({
      sourceMessageId: directReply.id,
      targetAgentId: agent.id,
      resultThreadId: directReply.threadId,
    });

    const explicitlyMentioned = service.postMessage(
      alicePrincipal,
      agentDm.id,
      { body: '@Researcher 再处理一个问题', mentionedActorIds: [agent.id] },
      'agent-direct-message-explicit-source',
    );
    expect(explicitlyMentioned.mentions).toHaveLength(1);
    expect(explicitlyMentioned.mentionOutcomes).toHaveLength(1);

    const humanDm = service.createConversation(
      alicePrincipal,
      workspace.id,
      { kind: 'dm', directWorkspaceMembershipIds: [bobMembershipId] },
      'human-direct-message',
    );
    const humanMessage = service.postMessage(
      alicePrincipal,
      humanDm.id,
      { body: '@Bob 这只是 Human 私聊', mentionedActorIds: [bob.humanId] },
      'human-direct-message-source',
    );
    expect(humanMessage.mentionOutcomes).toEqual([]);
    expect(humanMessage.mentions).toEqual([
      expect.objectContaining({ actorId: bob.humanId, actorType: 'human', displayName: 'Bob' }),
    ]);
    expect(service.listAgentRequests(alicePrincipal, humanDm.id)).toEqual([]);
  });

  it('stores current participant mentions and rejects actors outside the conversation', () => {
    const { service, workspaceDatabase } = createTestService();
    const alice = service.bootstrapHuman('Alice', 'alice@example.com');
    const bob = service.bootstrapHuman('Bob', 'bob@example.com');
    const alicePrincipal = { kind: 'human' as const, actorId: alice.humanId };
    const bobPrincipal = { kind: 'human' as const, actorId: bob.humanId };
    const workspace = service.createWorkspace(alicePrincipal, 'Product', 'mentions-workspace');
    const bobInvitation = service.createInvitation(
      alicePrincipal,
      workspace.id,
      { verifiedEmail: 'bob@example.com', membershipRole: 'member' },
      'invite-bob-for-mentions',
    );
    const bobMembershipId = service.acceptInvitation(
      bobPrincipal,
      bobInvitation.id,
      bobInvitation.revision,
      'accept-bob-for-mentions',
    ).membershipId;
    const requestable = service.createAgent(alicePrincipal, workspace.id, { name: 'Researcher' }, 'requestable-agent');
    const outsideScope = service.createAgent(alicePrincipal, workspace.id, { name: 'Writer' }, 'outside-agent');
    const unknownTarget = newId();
    const conversation = service.createConversation(
      alicePrincipal,
      workspace.id,
      { kind: 'channel' },
      'mentions-conversation',
    );

    expect(() => service.postMessage(
      alicePrincipal,
      conversation.id,
      { body: '@Unknown', mentionedActorIds: [unknownTarget] },
      'unknown-target-message',
    )).toThrowError(expect.objectContaining({ code: 'MENTION_TARGET_NOT_IN_CONVERSATION' }));

    const message = service.postMessage(
      alicePrincipal,
      conversation.id,
      {
        body: '@Researcher 和 @Writer 分别处理',
        mentionedActorIds: [requestable.id, outsideScope.id, requestable.id],
      },
      'multi-target-message',
    );

    expect(message.mentions.map((mention) => mention.actorId)).toEqual([requestable.id, outsideScope.id]);
    expect(message.mentionOutcomes).toHaveLength(2);
    expect(message.mentionOutcomes.map((outcome) => outcome.outcome)).toEqual([
      'requested',
      'requested',
    ]);
    expect(() =>
      workspaceDatabase.raw
        .prepare('UPDATE agent_mention_outcomes SET target_order = target_order WHERE id = ?')
        .run(message.mentionOutcomes[0]!.id),
    ).toThrow(/immutable/);

    const bobMessage = service.listMessages(bobPrincipal, conversation.id)[0]!;
    expect(bobMessage.mentions).toHaveLength(2);

    const requests = service.listAgentRequests(alicePrincipal, conversation.id);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      id: message.mentionOutcomes[0]?.agentRequestId,
      sourceMessageId: message.id,
      targetAgentId: requestable.id,
      status: 'pending',
      version: 1,
      intake: { disposition: 'waiting', reasons: ['runtime_unavailable'] },
    });

    const computer = service.registerComputer(alicePrincipal, { name: 'Alice Mac' }, 'mentions-computer');
    reportReadyRuntime(service, computer.computerId, alice.humanId);
    service.bindAgentRuntime(
      alicePrincipal,
      workspace.id,
      requestable.id,
      { computerId: computer.computerId, runtimeId: 'generic-acp', expectedRevision: 0 },
      'mentions-binding',
    );
    expect(service.getAgentRequest(alicePrincipal, requests[0]!.id).intake).toEqual({ disposition: 'ready', reasons: [] });
    service.suspendAgent(alicePrincipal, workspace.id, requestable.id, requestable.revision, 'suspend-requestable-agent');
    expect(service.getAgentRequest(alicePrincipal, requests[0]!.id).intake).toEqual({
      disposition: 'blocked',
      reasons: ['agent_suspended'],
    });

    const plainTextOnly = service.postMessage(
      alicePrincipal,
      conversation.id,
      { body: '@Researcher 只是正文，不是结构化 mention' },
      'plain-text-at-name',
    );
    expect(plainTextOnly.mentionOutcomes).toEqual([]);
    expect(workspaceDatabase.raw.prepare('SELECT count(*) AS count FROM agent_requests').get()).toEqual({ count: 2 });
  });

  it('creates a Thread with its first reply and preserves the exact result scope', () => {
    const { service } = createTestService();
    const alice = service.bootstrapHuman('Alice', 'alice@example.com');
    const principal = { kind: 'human' as const, actorId: alice.humanId };
    const workspace = service.createWorkspace(principal, 'Product', 'thread-workspace');
    const agent = service.createAgent(principal, workspace.id, { name: 'Researcher' }, 'thread-agent');
    const conversation = service.createConversation(
      principal,
      workspace.id,
      { kind: 'channel' },
      'thread-conversation',
    );
    const root = service.postMessage(principal, conversation.id, { body: '根消息' }, 'root-message');
    const firstReply = service.replyToMessage(
      principal,
      root.id,
      { body: '@Researcher 在线程中调查', mentionedActorIds: [agent.id] },
      'first-reply',
    );
    const secondReply = service.replyToMessage(principal, root.id, { body: '补充信息' }, 'second-reply');

    expect(firstReply.threadId).not.toBeNull();
    expect(firstReply.threadRootMessageId).toBe(root.id);
    expect(firstReply.authorDisplayName).toBe('Alice');
    expect(firstReply.authorActorType).toBe('human');
    expect(secondReply.threadId).toBe(firstReply.threadId);
    const request = service.getAgentRequest(principal, firstReply.mentionOutcomes[0]!.agentRequestId!);
    expect(request.resultConversationId).toBe(conversation.id);
    expect(request.resultThreadId).toBe(firstReply.threadId);
    expect(service.listAgentRequests(principal, conversation.id, firstReply.threadId!)).toHaveLength(1);
    expect(() => service.replyToMessage(principal, firstReply.id, { body: '禁止嵌套 Thread' }, 'nested-reply')).toThrow(
      /top-level Message/,
    );
  });

  it('cancels a pending request with optimistic concurrency without rewriting its Mention Outcome', () => {
    const { service, workspaceDatabase } = createTestService();
    const alice = service.bootstrapHuman('Alice', 'alice@example.com');
    const bob = service.bootstrapHuman('Bob', 'bob@example.com');
    const alicePrincipal = { kind: 'human' as const, actorId: alice.humanId };
    const bobPrincipal = { kind: 'human' as const, actorId: bob.humanId };
    const workspace = service.createWorkspace(alicePrincipal, 'Product', 'cancel-workspace');
    const bobInvitation = service.createInvitation(
      alicePrincipal,
      workspace.id,
      { verifiedEmail: 'bob@example.com', membershipRole: 'member' },
      'invite-bob-for-cancel',
    );
    const bobMembershipId = service.acceptInvitation(
      bobPrincipal,
      bobInvitation.id,
      bobInvitation.revision,
      'accept-bob-for-cancel',
    ).membershipId;
    const agent = service.createAgent(alicePrincipal, workspace.id, { name: 'Researcher' }, 'cancel-agent');
    const conversation = service.createConversation(
      alicePrincipal,
      workspace.id,
      { kind: 'channel' },
      'cancel-conversation',
    );
    const message = service.postMessage(
      alicePrincipal,
      conversation.id,
      { body: '@Researcher 查资料', mentionedActorIds: [agent.id] },
      'cancel-source',
    );
    const requestId = message.mentionOutcomes[0]!.agentRequestId!;

    expect(() =>
      service.cancelAgentRequest(
        bobPrincipal,
        requestId,
        { expectedVersion: 1 },
        'bob-cancel',
      ),
    ).toThrow(/Only the requestor, current target Agent Owner, or a Workspace Owner/);

    const cancelled = service.cancelAgentRequest(
      alicePrincipal,
      requestId,
      { expectedVersion: 1 },
      'alice-cancel',
    );
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      version: 2,
      intake: null,
      terminalReason: { code: 'requestor_cancelled', detail: null },
    });
    expect(service.listMessages(alicePrincipal, conversation.id)[0]!.mentionOutcomes[0]).toMatchObject({
      outcome: 'requested',
      agentRequestId: requestId,
    });
    expect(() =>
      service.cancelAgentRequest(
        alicePrincipal,
        requestId,
        { expectedVersion: 1 },
        'alice-cancel-again',
      ),
    ).toThrow(/pending/);
    expect(service.followChanges(alicePrincipal, workspace.id).items.map((change) => change.changeType)).toContain(
      'agent_request_cancelled',
    );
  });

  it('derives Project Channel mention choices from current Project Membership', () => {
    const { service } = createTestService();
    const alice = service.bootstrapHuman('Alice', 'alice@example.com');
    const principal = { kind: 'human' as const, actorId: alice.humanId };
    const workspace = service.createWorkspace(principal, 'Product', 'scope-workspace');
    const project = service.createProject(principal, workspace.id, { name: 'Launch' }, 'scope-project');
    const agent = service.createAgent(principal, workspace.id, { name: 'Researcher' }, 'scope-agent');
    const conversation = service.createProjectConversation(principal, project.id, { kind: 'channel' }, 'scope-conversation');

    expect(() => service.postMessage(
      principal,
      conversation.id,
      { body: '@Researcher 当前不在 Project', mentionedActorIds: [agent.id] },
      'refused-mention',
    )).toThrowError(expect.objectContaining({ code: 'MENTION_TARGET_NOT_IN_CONVERSATION' }));

    const projectMembership = service.addProjectMember(
      principal,
      project.id,
      { workspaceMembershipId: agent.membershipId, role: 'member' },
      'add-agent-to-project',
    );
    expect(service.listConversationParticipants(principal, conversation.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorId: agent.id,
          workspaceMembershipId: agent.membershipId,
          projectMembershipId: projectMembership.projectMembershipId,
        }),
      ]),
    );
    expect(service.listMessages(principal, conversation.id)).toEqual([]);
    expect(service.listAgentRequests(principal, conversation.id)).toEqual([]);

    const requested = service.postMessage(
      principal,
      conversation.id,
      { body: '@Researcher 新请求', mentionedActorIds: [agent.id] },
      'new-request',
    );
    const requestId = requested.mentionOutcomes[0]!.agentRequestId!;
    const removed = service.removeProjectMember(
      principal,
      project.id,
      projectMembership.projectMembershipId,
      projectMembership.revision,
      'remove-agent-from-project',
    );
    expect(removed.cancelledAgentRequestIds).toEqual([requestId]);
    expect(service.getAgentRequest(principal, requestId)).toMatchObject({
      status: 'cancelled',
      version: 2,
      terminalReason: { code: 'authority_revoked', detail: null },
    });

    service.addProjectMember(
      principal,
      project.id,
      { workspaceMembershipId: agent.membershipId, role: 'member' },
      'readd-agent-to-project',
    );
    expect(service.getAgentRequest(principal, requestId).status).toBe('cancelled');
  });
});
