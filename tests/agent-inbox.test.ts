import { describe, expect, it } from 'vitest';
import { createTestService, reportReadyRuntime } from './helpers.js';

describe('pull-based Agent Inbox', () => {
  it('routes only Agent DM and explicit mentions into the Inbox', () => {
    const fixture = inboxFixture();
    const plainChannel = fixture.service.postMessage(
      fixture.principal,
      fixture.channelId,
      { body: '普通 Channel 消息' },
      'plain-channel-message',
    );
    expect(plainChannel.mentionOutcomes).toEqual([]);
    expect(fixture.service.getComputerAgentInbox(fixture.computerId, fixture.agentId).targets).toEqual([]);

    const mentioned = fixture.service.postMessage(
      fixture.principal,
      fixture.channelId,
      { body: '请处理', mentionedActorIds: [fixture.agentId] },
      'mentioned-channel-message',
    );
    expect(mentioned.mentionOutcomes[0]).toMatchObject({ outcome: 'requested' });
    expect(fixture.service.getComputerAgentInbox(fixture.computerId, fixture.agentId).targets).toEqual([
      expect.objectContaining({
        target: `conversation:${fixture.channelId}`,
        pendingCount: 1,
      }),
    ]);
    expect(fixture.service.getComputerAgentInboxWakes(fixture.computerId, {})).toEqual({
      events: [{ type: 'agent.inbox_changed', agentId: fixture.agentId, highestSequence: 1 }],
      cursor: { [fixture.agentId]: 1 },
    });

    const run = fixture.service.acceptAgentRequest(
      fixture.computerId,
      mentioned.mentionOutcomes[0]!.agentRequestId!,
      { expectedVersion: 1 },
      'accept-mentioned-channel-message',
    );
    const attempt = fixture.service.createAttempt(
      fixture.computerId,
      run.id,
      'attempt-mentioned-channel-message',
    );
    const claim = fixture.service.claimComputerAgentInbox(fixture.computerId, fixture.agentId, {
      attemptId: attempt.id,
      conversationId: fixture.channelId,
      threadId: null,
      receipt: `${attempt.id}:channel`,
    });
    expect(claim.attention.map((item) => item.messageId)).toEqual([mentioned.id]);
    expect(claim.discussion.messages.map((message) => message.body)).toEqual([
      '普通 Channel 消息',
      '请处理',
    ]);
  });

  it('claims multiple DM messages in order, replays the receipt, and publishes a normal Message', () => {
    const fixture = inboxFixture();
    const dm = fixture.service.createConversation(
      fixture.principal,
      fixture.workspaceId,
      { kind: 'dm', directWorkspaceMembershipIds: [fixture.agentMembershipId] },
      'agent-dm',
    );
    const first = fixture.service.postMessage(
      fixture.principal,
      dm.id,
      { body: '你好' },
      'dm-first',
    );
    const second = fixture.service.postMessage(
      fixture.principal,
      dm.id,
      { body: '你是谁' },
      'dm-second',
    );
    const requests = fixture.service.listAgentRequests(fixture.principal, dm.id);
    expect(requests).toHaveLength(2);

    const run = fixture.service.acceptAgentRequest(
      fixture.computerId,
      first.mentionOutcomes[0]!.agentRequestId!,
      { expectedVersion: 1 },
      'accept-dm-batch',
    );
    const attempt = fixture.service.createAttempt(fixture.computerId, run.id, 'attempt-dm-batch');
    const execution = fixture.service.getAttemptExecutionInput(fixture.computerId, attempt.id);
    fixture.service.localExecutions.start(attempt.id, execution.workspaceId, execution.runId);
    const receipt = `${attempt.id}:dm`;
    const claim = fixture.service.claimComputerAgentInbox(fixture.computerId, fixture.agentId, {
      attemptId: attempt.id,
      conversationId: dm.id,
      threadId: null,
      receipt,
    });
    expect(claim.attention.map((item) => item.messageId)).toEqual([first.id, second.id]);
    expect(claim.attention.map((item) => item.sequence)).toEqual([1, 2]);
    expect(claim.discussion).toMatchObject({
      conversationId: dm.id,
      threadId: null,
      sincePositionExclusive: 0,
      rootMessage: null,
    });
    expect(claim.discussion.messages.map((message) => message.body)).toEqual(['你好', '你是谁']);
    expect(new Set(claim.attention.map((item) => item.agentRequestId))).toEqual(new Set([
      first.mentionOutcomes[0]!.agentRequestId!,
      second.mentionOutcomes[0]!.agentRequestId!,
    ]));
    expect(fixture.service.claimComputerAgentInbox(fixture.computerId, fixture.agentId, {
      attemptId: attempt.id,
      conversationId: dm.id,
      threadId: null,
      receipt,
    })).toEqual(claim);

    const sent = fixture.service.sendComputerAgentMessage(fixture.computerId, fixture.agentId, {
      attemptId: attempt.id,
      conversationId: dm.id,
      threadId: null,
      receipt,
      body: '你好，我是 Researcher。',
    }, 'send-dm-answer');
    expect(sent).toMatchObject({
      body: '你好，我是 Researcher。',
      authorActorId: fixture.agentId,
      producingRunId: run.id,
      producingAttemptId: attempt.id,
    });
    const returned = fixture.service.returnAttempt(fixture.computerId, attempt.id, {
      disposition: 'publish',
      messages: [],
      artifactPublications: [],
    }, 'return-dm-batch');
    expect(returned.publishedMessages.map((message) => message.id)).toContain(sent.id);
    expect(fixture.service.getComputerAgentInbox(fixture.computerId, fixture.agentId).targets).toEqual([]);
    expect(fixture.service.listMessages(fixture.principal, dm.id).at(-1)).toMatchObject({
      id: sent.id,
      body: '你好，我是 Researcher。',
    });
  });

  it('reads and resolves Message history only inside the active Discussion Scope', () => {
    const fixture = inboxFixture();
    const trigger = fixture.service.postMessage(
      fixture.principal,
      fixture.channelId,
      { body: '处理这个问题', mentionedActorIds: [fixture.agentId] },
      'history-trigger',
    );
    const run = fixture.service.acceptAgentRequest(
      fixture.computerId,
      trigger.mentionOutcomes[0]!.agentRequestId!,
      { expectedVersion: 1 },
      'history-accept',
    );
    const attempt = fixture.service.createAttempt(fixture.computerId, run.id, 'history-attempt');
    const messages = fixture.service.readComputerAgentMessages(fixture.computerId, fixture.agentId, {
      attemptId: attempt.id,
      conversationId: fixture.channelId,
      threadId: null,
    });
    expect(messages.map((message) => message.id)).toContain(trigger.id);
    expect(fixture.service.resolveComputerAgentMessage(fixture.computerId, fixture.agentId, {
      attemptId: attempt.id,
      conversationId: fixture.channelId,
      threadId: null,
      messageId: trigger.id,
    }).body).toBe('处理这个问题');
  });

  it('returns the Thread root and all replies up to the mention that caused attention', () => {
    const fixture = inboxFixture();
    const root = fixture.service.postMessage(
      fixture.principal,
      fixture.channelId,
      { body: '根问题' },
      'thread-delta-root',
    );
    fixture.service.replyToMessage(
      fixture.principal,
      root.id,
      { body: '没有艾特的补充' },
      'thread-delta-plain-reply',
    );
    const mentioned = fixture.service.replyToMessage(
      fixture.principal,
      root.id,
      { body: '请结合整个线程处理', mentionedActorIds: [fixture.agentId] },
      'thread-delta-mentioned-reply',
    );
    const run = fixture.service.acceptAgentRequest(
      fixture.computerId,
      mentioned.mentionOutcomes[0]!.agentRequestId!,
      { expectedVersion: 1 },
      'thread-delta-accept',
    );
    const attempt = fixture.service.createAttempt(fixture.computerId, run.id, 'thread-delta-attempt');
    const claim = fixture.service.claimComputerAgentInbox(fixture.computerId, fixture.agentId, {
      attemptId: attempt.id,
      conversationId: fixture.channelId,
      threadId: mentioned.threadId,
      receipt: `${attempt.id}:thread`,
    });

    expect(claim.attention.map((item) => item.messageId)).toEqual([mentioned.id]);
    expect(claim.discussion.rootMessage?.body).toBe('根问题');
    expect(claim.discussion.messages.map((message) => message.body)).toEqual([
      '没有艾特的补充',
      '请结合整个线程处理',
    ]);
  });

  it('starts the next pull after the last successfully handled Discussion position', () => {
    const fixture = inboxFixture();
    const firstMention = fixture.service.postMessage(
      fixture.principal,
      fixture.channelId,
      { body: '第一轮', mentionedActorIds: [fixture.agentId] },
      'discussion-checkpoint-first',
    );
    const firstRun = fixture.service.acceptAgentRequest(
      fixture.computerId,
      firstMention.mentionOutcomes[0]!.agentRequestId!,
      { expectedVersion: 1 },
      'discussion-checkpoint-first-accept',
    );
    const firstAttempt = fixture.service.createAttempt(
      fixture.computerId,
      firstRun.id,
      'discussion-checkpoint-first-attempt',
    );
    const firstExecution = fixture.service.getAttemptExecutionInput(fixture.computerId, firstAttempt.id);
    fixture.service.localExecutions.start(
      firstAttempt.id,
      firstExecution.workspaceId,
      firstExecution.runId,
    );
    const firstClaim = fixture.service.claimComputerAgentInbox(fixture.computerId, fixture.agentId, {
      attemptId: firstAttempt.id,
      conversationId: fixture.channelId,
      threadId: null,
      receipt: `${firstAttempt.id}:channel`,
    });
    fixture.service.returnAttempt(fixture.computerId, firstAttempt.id, {
      disposition: 'no_output',
      messages: [],
      artifactPublications: [],
    }, 'discussion-checkpoint-first-return');

    fixture.service.postMessage(
      fixture.principal,
      fixture.channelId,
      { body: '第二轮的普通背景' },
      'discussion-checkpoint-background',
    );
    const secondMention = fixture.service.postMessage(
      fixture.principal,
      fixture.channelId,
      { body: '第二轮请处理', mentionedActorIds: [fixture.agentId] },
      'discussion-checkpoint-second',
    );
    const secondRun = fixture.service.acceptAgentRequest(
      fixture.computerId,
      secondMention.mentionOutcomes[0]!.agentRequestId!,
      { expectedVersion: 1 },
      'discussion-checkpoint-second-accept',
    );
    const secondAttempt = fixture.service.createAttempt(
      fixture.computerId,
      secondRun.id,
      'discussion-checkpoint-second-attempt',
    );
    const secondClaim = fixture.service.claimComputerAgentInbox(fixture.computerId, fixture.agentId, {
      attemptId: secondAttempt.id,
      conversationId: fixture.channelId,
      threadId: null,
      receipt: `${secondAttempt.id}:channel`,
    });

    expect(secondClaim.discussion.sincePositionExclusive).toBe(firstClaim.discussion.throughPosition);
    expect(secondClaim.discussion.messages.map((message) => message.body)).toEqual([
      '第二轮的普通背景',
      '第二轮请处理',
    ]);
  });

  it('fences the old claim receipt and Attempt after an Agent restart', () => {
    const fixture = inboxFixture();
    const dm = fixture.service.createConversation(
      fixture.principal,
      fixture.workspaceId,
      { kind: 'dm', directWorkspaceMembershipIds: [fixture.agentMembershipId] },
      'restart-agent-dm',
    );
    const source = fixture.service.postMessage(
      fixture.principal,
      dm.id,
      { body: '重启前的消息' },
      'restart-source',
    );
    const run = fixture.service.acceptAgentRequest(
      fixture.computerId,
      source.mentionOutcomes[0]!.agentRequestId!,
      { expectedVersion: 1 },
      'restart-accept',
    );
    const attempt = fixture.service.createAttempt(fixture.computerId, run.id, 'restart-attempt');
    const execution = fixture.service.getAttemptExecutionInput(fixture.computerId, attempt.id);
    fixture.service.localExecutions.start(attempt.id, execution.workspaceId, execution.runId);
    const receipt = `${attempt.id}:restart`;
    fixture.service.claimComputerAgentInbox(fixture.computerId, fixture.agentId, {
      attemptId: attempt.id,
      conversationId: dm.id,
      threadId: null,
      receipt,
    });

    const current = fixture.service.getAgent(fixture.principal, fixture.workspaceId, fixture.agentId);
    const restarted = fixture.service.restartAgent(
      fixture.principal,
      fixture.workspaceId,
      fixture.agentId,
      current.revision,
      'restart-agent-runtime',
    );
    expect(restarted.runtimeBinding?.bindingRevision).toBe(2);
    expect(() => fixture.service.sendComputerAgentMessage(fixture.computerId, fixture.agentId, {
      attemptId: attempt.id,
      conversationId: dm.id,
      threadId: null,
      receipt,
      body: '旧 capability 不应继续发布',
    }, 'restart-old-send')).toThrow(/no longer active|no longer owns|not assigned/i);
    expect(() => fixture.service.claimComputerAgentInbox(fixture.computerId, fixture.agentId, {
      attemptId: attempt.id,
      conversationId: dm.id,
      threadId: null,
      receipt,
    })).toThrow(/no longer active|no longer owns|not assigned/i);
  });
});

function inboxFixture() {
  const { service } = createTestService();
  const human = service.bootstrapHuman('Alice', 'alice@example.com');
  const principal = { kind: 'human' as const, actorId: human.humanId };
  const workspace = service.createWorkspace(principal, 'Product', 'inbox-workspace');
  const agent = service.createAgent(principal, workspace.id, { name: 'Researcher' }, 'inbox-agent');
  const computer = service.registerComputer(principal, { name: 'Alice Mac' }, 'inbox-computer');
  reportReadyRuntime(service, computer.computerId, human.humanId);
  service.bindAgentRuntime(principal, workspace.id, agent.id, {
    computerId: computer.computerId,
    runtimeId: 'generic-acp',
    expectedRevision: 0,
  }, 'inbox-binding');
  const channel = service.createConversation(principal, workspace.id, { kind: 'channel' }, 'inbox-channel');
  return {
    service,
    principal,
    workspaceId: workspace.id,
    agentId: agent.id,
    agentMembershipId: agent.membershipId,
    computerId: computer.computerId,
    channelId: channel.id,
  };
}
