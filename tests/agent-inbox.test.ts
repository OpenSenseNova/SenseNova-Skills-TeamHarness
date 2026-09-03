import { describe, expect, it } from 'vitest';
import type { WorkspaceService } from '../src/domain/workspace-service.js';
import type { SqliteDatabase } from '../src/storage/database.js';
import {
  authorizeAgentInConversation,
  createTestService,
  reportReadyRuntime,
  workspaceGeneral,
} from './helpers.js';

interface InboxFixture {
  service: WorkspaceService;
  principal: { kind: 'human'; actorId: string };
  workspaceId: string;
  agentId: string;
  agentMembershipId: string;
  computerId: string;
  channelId: string;
  workspaceDatabase: SqliteDatabase;
}

describe('persistent Agent Inbox', () => {
  it('coalesces consecutive DM messages into one active Session window', () => {
    const fixture = inboxFixture();
    const dm = fixture.service.createConversation(
      fixture.principal,
      fixture.workspaceId,
      { kind: 'dm', directWorkspaceMembershipIds: [fixture.agentMembershipId] },
      'isolated-dm',
    );
    const first = fixture.service.postMessage(fixture.principal, dm.id, { body: '上传文档' }, 'isolated-first');
    const second = fixture.service.postMessage(fixture.principal, dm.id, { body: '私聊回复' }, 'isolated-second');
    const firstRequest = first.mentionOutcomes.find((outcome) => outcome.targetAgentId === fixture.agentId)?.agentRequestId!;
    const secondRequest = second.mentionOutcomes.find((outcome) => outcome.targetAgentId === fixture.agentId)?.agentRequestId!;
    expect(firstRequest).not.toBe(secondRequest);
    const firstInput = fixture.service.getComputerAgentSessionInput(fixture.computerId, fixture.agentId, { kind: 'mention', key: firstRequest });
    const secondInput = fixture.service.getComputerAgentSessionInput(fixture.computerId, fixture.agentId, { kind: 'mention', key: secondRequest });
    expect(firstInput.contextJsonl).toContain('上传文档');
    expect(firstInput.contextJsonl).not.toContain('私聊回复');
    expect(secondInput.contextJsonl).toContain('私聊回复');
    expect(secondInput.session).toEqual({ kind: 'mention', key: secondRequest });
    const firstClaim = fixture.service.claimComputerAgentInbox(fixture.computerId, fixture.agentId, {
      target: `conversation:${dm.id}`, receipt: 'isolated-first-receipt', agentRequestId: firstRequest,
    });
    expect(firstClaim.attention.map((item) => item.messageId)).toEqual([first.id, second.id]);
    expect(firstClaim.sessionWindow).toMatchObject({ mode: 'dm', acceptedMessages: 2, status: 'accepting' });
    expect(fixture.service.getComputerAgentInbox(fixture.computerId, fixture.agentId).sessionTriggers)
      .toEqual(expect.arrayContaining([expect.objectContaining({ session: { kind: 'mention', key: secondRequest }, requiresAction: true })]));
  });

  it('delivers ordinary Channel messages silently and wakes only for direct attention', () => {
    const fixture = inboxFixture();
    fixture.service.postMessage(
      fixture.principal,
      fixture.channelId,
      { body: '普通 Channel 消息' },
      'plain-channel-message',
    );
    const target = `conversation:${fixture.channelId}`;
    expect(fixture.service.getComputerAgentInbox(fixture.computerId, fixture.agentId).targets).toEqual([
      expect.objectContaining({ kind: 'discussion', target, pendingCount: 1, requiresAction: false }),
    ]);
    expect(fixture.service.getComputerAgentInboxWakes(fixture.computerId, {}).events).toEqual([]);
    expect(fixture.workspaceDatabase.raw.prepare(
      "SELECT attention_kind FROM agent_inbox_items WHERE agent_id = ? AND message_id = (SELECT id FROM messages WHERE body = '普通 Channel 消息')",
    ).get(fixture.agentId)).toEqual({ attention_kind: 'discussion_change' });

    const mentioned = fixture.service.postMessage(
      fixture.principal,
      fixture.channelId,
      { body: '请处理', mentionedActorIds: [fixture.agentId] },
      'mentioned-channel-message',
    );
    expect(fixture.service.getComputerAgentInbox(fixture.computerId, fixture.agentId).targets).toEqual([
      expect.objectContaining({ kind: 'discussion', target, pendingCount: 2, requiresAction: true }),
    ]);
    expect(fixture.service.getComputerAgentInboxWakes(fixture.computerId, {}).events).toEqual([
      expect.objectContaining({ agentId: fixture.agentId, wakeSequence: 1 }),
    ]);
    const claim = fixture.service.claimComputerAgentInbox(fixture.computerId, fixture.agentId, {
      target,
      receipt: 'channel-receipt',
    });
    expect(claim).not.toHaveProperty('runId');
    expect(claim).not.toHaveProperty('attemptId');
    expect(claim.attention.map((item) => item.messageId)).toEqual([mentioned.id]);
    expect(claim.discussion?.messages.map((message) => message.body)).toEqual([
      '普通 Channel 消息',
      '请处理',
    ]);
  });

  it('claims one DM Mention Session and leaves the next request isolated', () => {
    const fixture = inboxFixture();
    const dm = fixture.service.createConversation(
      fixture.principal,
      fixture.workspaceId,
      { kind: 'dm', directWorkspaceMembershipIds: [fixture.agentMembershipId] },
      'agent-dm',
    );
    drainWorkspaceChanges(fixture, 'after-dm-create');
    const first = fixture.service.postMessage(fixture.principal, dm.id, { body: '你好' }, 'dm-first');
    const firstRequestId = first.mentionOutcomes[0]!.agentRequestId!;
    const session = fixture.service.getComputerAgentSessionInput(
      fixture.computerId,
      fixture.agentId,
      { kind: 'mention', key: firstRequestId },
    );
    expect(session.developerInstructions).toContain('## teamctl CLI');
    expect(session.developerInstructions).toContain('teamctl message check --target <discussion-target>');
    expect(session.developerInstructions).toContain('Agent Inbox contains Discussion attention plus explicit WorkItem assignment or mention attention.');
    expect(session.developerInstructions).toContain('teamctl return no-output --target <discussion-target>');
    expect(session.developerInstructions).toContain('Immediately before `message send`');
    expect(session.developerInstructions).toContain('status: "held"');
    expect(session.developerInstructions).toContain('--send-draft --anyway');
    expect(session.developerInstructions).toContain('message draft discard');
    expect(session.developerInstructions).toContain('--body-file <path>` for any multi-line or long content');
    expect(session.developerInstructions).toContain('is not converted to a line break.');
    expect(session.developerInstructions).not.toContain('Stable Agent ID');

    const target = `conversation:${dm.id}`;
    const claim = fixture.service.claimComputerAgentInbox(fixture.computerId, fixture.agentId, {
      target,
      receipt: 'dm-receipt',
      agentRequestId: firstRequestId,
    });
    expect(claim.attention.map((item) => item.messageId)).toEqual([first.id]);
    expect(claim.discussion?.messages.map((message) => message.body)).toEqual(['你好']);
    expect(fixture.service.claimComputerAgentInbox(fixture.computerId, fixture.agentId, {
      target,
      receipt: 'dm-receipt',
      agentRequestId: firstRequestId,
    })).toEqual(claim);
    expect(() => fixture.service.sendComputerAgentMessage(fixture.computerId, fixture.agentId, {
      conversationId: dm.id,
      threadId: null,
      receipt: 'dm-receipt',
      draftId: 'mismatched-frontier-draft',
      expectedDiscussionFrontier: claim.discussion!.throughPosition - 1,
      body: '不应绕过 receipt checkpoint',
      mode: 'check',
    }, 'mismatched-receipt-frontier')).toThrow(/receipt checkpoint/i);

    const sent = fixture.service.sendComputerAgentMessage(fixture.computerId, fixture.agentId, {
      conversationId: dm.id,
      threadId: null,
      receipt: 'dm-receipt',
      draftId: 'dm-draft',
      expectedDiscussionFrontier: claim.discussion!.throughPosition,
      body: '你好，我是 Researcher。',
      mode: 'check',
    }, 'send-dm-answer');
    expect(sent).toMatchObject({
      status: 'published',
      message: {
        body: '你好，我是 Researcher。',
        authorActorId: fixture.agentId,
        producingRunId: null,
        producingAttemptId: null,
      },
    });
    const second = fixture.service.postMessage(fixture.principal, dm.id, { body: '你是谁' }, 'dm-second');
    const secondRequestId = second.mentionOutcomes[0]!.agentRequestId!;
    expect(fixture.service.getComputerAgentInbox(fixture.computerId, fixture.agentId).sessionTriggers)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ session: { kind: 'mention', key: secondRequestId }, requiresAction: true }),
      ]));
  });

  it('returns complete Thread context and advances only after explicit completion', () => {
    const fixture = inboxFixture();
    const root = fixture.service.postMessage(fixture.principal, fixture.channelId, { body: '根问题' }, 'thread-root');
    fixture.service.replyToMessage(fixture.principal, root.id, { body: '普通补充' }, 'thread-background');
    const mentioned = fixture.service.replyToMessage(
      fixture.principal,
      root.id,
      { body: '请结合整个线程处理', mentionedActorIds: [fixture.agentId] },
      'thread-mention',
    );
    const target = `conversation:${fixture.channelId}:thread:${mentioned.threadId}`;
    const first = fixture.service.claimComputerAgentInbox(fixture.computerId, fixture.agentId, {
      target,
      receipt: 'thread-first',
    });
    expect(first.discussion?.rootMessage?.body).toBe('根问题');
    expect(first.discussion?.messages.map((message) => message.body)).toEqual(['普通补充', '请结合整个线程处理']);
    fixture.service.completeComputerAgentInbox(
      fixture.computerId,
      fixture.agentId,
      { target, receipt: 'thread-first', expectedDiscussionFrontier: first.discussion!.throughPosition },
      'complete-thread-first',
    );

    const next = fixture.service.replyToMessage(
      fixture.principal,
      root.id,
      { body: '新的请求', mentionedActorIds: [fixture.agentId] },
      'thread-next',
    );
    const second = fixture.service.claimComputerAgentInbox(fixture.computerId, fixture.agentId, {
      target,
      receipt: 'thread-second',
    });
    expect(second.discussion?.sincePositionExclusive).toBe(first.discussion?.throughPosition);
    expect(second.discussion?.messages.map((message) => message.id)).toEqual([next.id]);
  });

  it('keeps Workspace changes out of the message-only Agent Inbox', () => {
    const fixture = inboxFixture();
    const current = fixture.service.getAgent(fixture.principal, fixture.workspaceId, fixture.agentId);
    fixture.service.updateAgent(
      fixture.principal,
      fixture.workspaceId,
      fixture.agentId,
      { description: '分析共享资料', expectedRevision: current.revision },
      'update-agent-for-change-inbox',
    );
    expect(fixture.service.getComputerAgentInbox(fixture.computerId, fixture.agentId).targets).toEqual([]);
    expect(fixture.service.getComputerAgentInboxWakes(fixture.computerId, {}).events).toEqual([]);
    expect(fixture.service.followChanges(fixture.principal, fixture.workspaceId).items
      .map((change) => change.changeType)).toContain('agent_updated');
  });

  it('fences old receipts on restart and redelivers claimed events to the new binding revision', () => {
    const fixture = inboxFixture();
    const dm = fixture.service.createConversation(
      fixture.principal,
      fixture.workspaceId,
      { kind: 'dm', directWorkspaceMembershipIds: [fixture.agentMembershipId] },
      'restart-dm',
    );
    drainWorkspaceChanges(fixture, 'restart-dm-change');
    fixture.service.postMessage(fixture.principal, dm.id, { body: '重启前的消息' }, 'restart-message');
    const target = `conversation:${dm.id}`;
    fixture.service.claimComputerAgentInbox(fixture.computerId, fixture.agentId, {
      target,
      receipt: 'old-receipt',
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
      conversationId: dm.id,
      threadId: null,
      receipt: 'old-receipt',
      draftId: 'old-draft',
      expectedDiscussionFrontier: 1,
      body: '旧 receipt 不应继续发布',
      mode: 'check',
    }, 'old-receipt-send')).toThrow(/receipt|fenced/i);
    expect(fixture.service.claimComputerAgentInbox(fixture.computerId, fixture.agentId, {
      target,
      receipt: 'new-receipt',
    }).discussion?.messages.map((message) => message.body)).toContain('重启前的消息');
  });

  it('fences receipts and redelivers claimed events when the Runtime Binding is replaced', () => {
    const fixture = inboxFixture();
    fixture.service.postMessage(fixture.principal, fixture.channelId, {
      body: '@Researcher Binding 更新前的消息',
      mentionedActorIds: [fixture.agentId],
    }, 'rebind-message');
    const target = `conversation:${fixture.channelId}`;
    const claim = fixture.service.claimComputerAgentInbox(fixture.computerId, fixture.agentId, {
      target,
      receipt: 'rebind-old-receipt',
    });
    expect(fixture.service.bindAgentRuntime(fixture.principal, fixture.workspaceId, fixture.agentId, {
      computerId: fixture.computerId,
      runtimeId: 'generic-acp',
      expectedRevision: 1,
    }, 'replace-inbox-binding')).toMatchObject({ bindingRevision: 2 });
    expect(() => fixture.service.sendComputerAgentMessage(fixture.computerId, fixture.agentId, {
      conversationId: fixture.channelId,
      threadId: null,
      receipt: claim.receipt,
      draftId: 'rebind-old-draft',
      expectedDiscussionFrontier: claim.discussion!.throughPosition,
      body: '旧 Binding 不应发布',
      mode: 'check',
    }, 'rebind-old-send')).toThrow(/receipt|fenced/i);
    expect(fixture.service.claimComputerAgentInbox(fixture.computerId, fixture.agentId, {
      target,
      receipt: 'rebind-new-receipt',
    }).discussion?.messages.map((message) => message.body)).toContain('@Researcher Binding 更新前的消息');
  });

  it('atomically holds a stale candidate, returns the exact delta, and replays the held result', () => {
    const fixture = inboxFixture();
    const target = `conversation:${fixture.channelId}`;
    fixture.service.postMessage(
      fixture.principal,
      fixture.channelId,
      { body: '@Researcher 初始请求', mentionedActorIds: [fixture.agentId] },
      'freshness-initial',
    );
    const claim = fixture.service.claimComputerAgentInbox(fixture.computerId, fixture.agentId, {
      target,
      receipt: 'freshness-receipt',
    });
    const followUp = fixture.service.postMessage(
      fixture.principal,
      fixture.channelId,
      { body: '发送窗口内的普通补充' },
      'freshness-follow-up',
    );
    const input = {
      conversationId: fixture.channelId,
      threadId: null,
      receipt: claim.receipt,
      draftId: '11111111-1111-4111-8111-111111111111',
      expectedDiscussionFrontier: claim.discussion!.throughPosition,
      body: '旧候选',
      mode: 'check' as const,
    };
    const held = fixture.service.sendComputerAgentMessage(
      fixture.computerId, fixture.agentId, input, 'freshness-held',
    );
    expect(held).toMatchObject({
      status: 'held',
      draftId: input.draftId,
      expectedDiscussionFrontier: claim.discussion!.throughPosition,
      currentDiscussionFrontier: followUp.scopePosition,
      attention: [],
      discussionDelta: {
        sincePositionExclusive: claim.discussion!.throughPosition,
        throughPosition: followUp.scopePosition,
        messages: [{ id: followUp.id, body: '发送窗口内的普通补充' }],
      },
    });
    expect(fixture.service.sendComputerAgentMessage(
      fixture.computerId, fixture.agentId, input, 'freshness-held',
    )).toEqual(held);
    expect(fixture.service.listMessages(fixture.principal, fixture.channelId)
      .filter((message) => message.authorActorId === fixture.agentId)).toEqual([]);
    expect(fixture.workspaceDatabase.raw.prepare(
      "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'message.freshness_hold' AND target_id = ?",
    ).get(input.draftId)).toEqual({ count: 1 });

    const published = fixture.service.sendComputerAgentMessage(fixture.computerId, fixture.agentId, {
      ...input,
      expectedDiscussionFrontier: followUp.scopePosition,
    }, 'freshness-published');
    expect(published).toMatchObject({ status: 'published', message: { body: '旧候选' } });
    expect(fixture.service.sendComputerAgentMessage(fixture.computerId, fixture.agentId, {
      ...input,
      expectedDiscussionFrontier: followUp.scopePosition,
    }, 'freshness-published')).toEqual(published);
    expect(fixture.service.listMessages(fixture.principal, fixture.channelId)
      .filter((message) => message.authorActorId === fixture.agentId)).toHaveLength(1);
  });

  it('holds on a racing mention without claiming its separate Session', () => {
    const fixture = inboxFixture();
    const target = `conversation:${fixture.channelId}`;
    const initial = fixture.service.postMessage(
      fixture.principal,
      fixture.channelId,
      { body: '@Researcher 第一问', mentionedActorIds: [fixture.agentId] },
      'attention-initial',
    );
    const claim = fixture.service.claimComputerAgentInbox(fixture.computerId, fixture.agentId, {
      target,
      receipt: 'attention-receipt',
      agentRequestId: initial.mentionOutcomes[0]!.agentRequestId!,
    });
    const racing = fixture.service.postMessage(
      fixture.principal,
      fixture.channelId,
      { body: '@Researcher 追问', mentionedActorIds: [fixture.agentId] },
      'attention-racing',
    );
    const racingRequestId = racing.mentionOutcomes[0]!.agentRequestId!;
    const heldInput = {
      conversationId: fixture.channelId,
      threadId: null,
      receipt: claim.receipt,
      draftId: '22222222-2222-4222-8222-222222222222',
      expectedDiscussionFrontier: claim.discussion!.throughPosition,
      body: '第一版',
      mode: 'check',
    } as const;
    const held = fixture.service.sendComputerAgentMessage(
      fixture.computerId, fixture.agentId, heldInput, 'attention-held',
    );
    expect(held).toMatchObject({
      status: 'held',
      attention: [],
    });
    expect(fixture.service.sendComputerAgentMessage(
      fixture.computerId, fixture.agentId, heldInput, 'attention-held',
    )).toEqual(held);
    expect(fixture.workspaceDatabase.raw.prepare(
      "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'message.freshness_hold' AND target_id = ?",
    ).get(heldInput.draftId)).toEqual({ count: 1 });
    if (held.status !== 'held') throw new Error('Expected freshness hold.');
    expect(fixture.service.sendComputerAgentMessage(fixture.computerId, fixture.agentId, {
      conversationId: fixture.channelId,
      threadId: null,
      receipt: claim.receipt,
      draftId: held.draftId,
      expectedDiscussionFrontier: held.currentDiscussionFrontier,
      body: '结合追问后的修订版',
      mode: 'check',
    }, 'attention-revised')).toMatchObject({ status: 'published' });
    expect(fixture.service.getComputerAgentInbox(fixture.computerId, fixture.agentId).sessionTriggers)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ session: { kind: 'mention', key: racingRequestId }, requiresAction: true }),
      ]));
    expect(fixture.workspaceDatabase.raw.prepare(
      'SELECT state, claim_receipt FROM agent_inbox_items WHERE message_id = ?',
    ).get(racing.id)).toEqual({ state: 'pending', claim_receipt: null });
  });

  it('compares only the exact Discussion Scope and reholds when that scope advances again', () => {
    const fixture = inboxFixture();
    const root = fixture.service.postMessage(
      fixture.principal, fixture.channelId, { body: '线程根' }, 'scope-root',
    );
    fixture.service.replyToMessage(
      fixture.principal,
      root.id,
      { body: '@Researcher 线程任务', mentionedActorIds: [fixture.agentId] },
      'scope-thread-mention',
    );
    const timelineTarget = `conversation:${fixture.channelId}`;
    fixture.service.postMessage(
      fixture.principal,
      fixture.channelId,
      { body: '@Researcher Timeline 任务', mentionedActorIds: [fixture.agentId] },
      'scope-timeline-mention',
    );
    const claim = fixture.service.claimComputerAgentInbox(fixture.computerId, fixture.agentId, {
      target: timelineTarget,
      receipt: 'scope-receipt',
    });
    fixture.service.replyToMessage(fixture.principal, root.id, { body: '只推进 Thread' }, 'scope-thread-only');
    expect(fixture.service.sendComputerAgentMessage(fixture.computerId, fixture.agentId, {
      conversationId: fixture.channelId,
      threadId: null,
      receipt: claim.receipt,
      draftId: '33333333-3333-4333-8333-333333333333',
      expectedDiscussionFrontier: claim.discussion!.throughPosition,
      body: 'Timeline 回复',
      mode: 'check',
    }, 'scope-published')).toMatchObject({ status: 'published' });

    fixture.service.postMessage(
      fixture.principal,
      fixture.channelId,
      { body: '@Researcher 再处理一次', mentionedActorIds: [fixture.agentId] },
      'rehold-request',
    );
    const secondClaim = fixture.service.claimComputerAgentInbox(fixture.computerId, fixture.agentId, {
      target: timelineTarget,
      receipt: 'rehold-receipt',
    });
    const firstAdvance = fixture.service.postMessage(
      fixture.principal, fixture.channelId, { body: '第一次推进' }, 'rehold-first',
    );
    const firstHold = fixture.service.sendComputerAgentMessage(fixture.computerId, fixture.agentId, {
      conversationId: fixture.channelId,
      threadId: null,
      receipt: secondClaim.receipt,
      draftId: '44444444-4444-4444-8444-444444444444',
      expectedDiscussionFrontier: secondClaim.discussion!.throughPosition,
      body: '持续候选',
      mode: 'check',
    }, 'rehold-first-hold');
    if (firstHold.status !== 'held') throw new Error('Expected first hold.');
    const secondAdvance = fixture.service.postMessage(
      fixture.principal, fixture.channelId, { body: '第二次推进' }, 'rehold-second',
    );
    const secondHold = fixture.service.sendComputerAgentMessage(fixture.computerId, fixture.agentId, {
      conversationId: fixture.channelId,
      threadId: null,
      receipt: secondClaim.receipt,
      draftId: firstHold.draftId,
      expectedDiscussionFrontier: firstAdvance.scopePosition,
      body: '持续候选',
      mode: 'check',
    }, 'rehold-second-hold');
    expect(secondHold).toMatchObject({
      status: 'held',
      currentDiscussionFrontier: secondAdvance.scopePosition,
      discussionDelta: { messages: [{ id: secondAdvance.id }] },
    });
  });

  it('requires a prior hold for override and records informed override and discard audits', () => {
    const fixture = inboxFixture();
    const target = `conversation:${fixture.channelId}`;
    fixture.service.postMessage(
      fixture.principal,
      fixture.channelId,
      { body: '@Researcher 请求', mentionedActorIds: [fixture.agentId] },
      'override-initial',
    );
    const claim = fixture.service.claimComputerAgentInbox(fixture.computerId, fixture.agentId, {
      target,
      receipt: 'override-receipt',
    });
    const draftId = '55555555-5555-4555-8555-555555555555';
    expect(() => fixture.service.sendComputerAgentMessage(fixture.computerId, fixture.agentId, {
      conversationId: fixture.channelId,
      threadId: null,
      receipt: claim.receipt,
      draftId,
      expectedDiscussionFrontier: claim.discussion!.throughPosition,
      body: '未经 hold',
      mode: 'override',
    }, 'override-too-early')).toThrow(/freshness hold/i);
    fixture.service.postMessage(fixture.principal, fixture.channelId, { body: '推进' }, 'override-advance');
    const held = fixture.service.sendComputerAgentMessage(fixture.computerId, fixture.agentId, {
      conversationId: fixture.channelId,
      threadId: null,
      receipt: claim.receipt,
      draftId,
      expectedDiscussionFrontier: claim.discussion!.throughPosition,
      body: '可强发候选',
      mode: 'check',
    }, 'override-held');
    if (held.status !== 'held') throw new Error('Expected hold before override.');
    fixture.service.postMessage(fixture.principal, fixture.channelId, { body: '继续推进' }, 'override-again');
    expect(() => fixture.service.sendComputerAgentMessage(fixture.computerId, fixture.agentId, {
      conversationId: fixture.channelId,
      threadId: null,
      receipt: claim.receipt,
      draftId: '77777777-7777-4777-8777-777777777777',
      expectedDiscussionFrontier: held.currentDiscussionFrontier,
      body: '错误 draftId',
      mode: 'override',
    }, 'override-wrong-draft')).toThrow(/freshness hold/i);
    expect(fixture.service.sendComputerAgentMessage(fixture.computerId, fixture.agentId, {
      conversationId: fixture.channelId,
      threadId: null,
      receipt: claim.receipt,
      draftId,
      expectedDiscussionFrontier: held.currentDiscussionFrontier,
      body: '可强发候选',
      mode: 'override',
    }, 'override-published')).toMatchObject({ status: 'published' });
    expect(fixture.workspaceDatabase.raw.prepare(
      "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'message.freshness_override'",
    ).get()).toEqual({ count: 1 });

    fixture.service.postMessage(
      fixture.principal,
      fixture.channelId,
      { body: '@Researcher 新请求', mentionedActorIds: [fixture.agentId] },
      'discard-initial',
    );
    const discardClaim = fixture.service.claimComputerAgentInbox(fixture.computerId, fixture.agentId, {
      target,
      receipt: 'discard-receipt',
    });
    fixture.service.postMessage(fixture.principal, fixture.channelId, { body: '使草稿 hold' }, 'discard-advance');
    const discardHeld = fixture.service.sendComputerAgentMessage(fixture.computerId, fixture.agentId, {
      conversationId: fixture.channelId,
      threadId: null,
      receipt: discardClaim.receipt,
      draftId: '66666666-6666-4666-8666-666666666666',
      expectedDiscussionFrontier: discardClaim.discussion!.throughPosition,
      body: '准备丢弃',
      mode: 'check',
    }, 'discard-held');
    if (discardHeld.status !== 'held') throw new Error('Expected held draft for discard.');
    expect(fixture.service.completeComputerAgentInbox(fixture.computerId, fixture.agentId, {
      target,
      receipt: discardClaim.receipt,
      expectedDiscussionFrontier: discardHeld.currentDiscussionFrontier,
      draftId: discardHeld.draftId,
    }, 'discard-complete')).toMatchObject({ status: 'completed' });
    expect(fixture.workspaceDatabase.raw.prepare(
      "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'message.freshness_discard'",
    ).get()).toEqual({ count: 1 });
  });

  it('requires review before stale Discussion no-output completion and replays completed results', () => {
    const fixture = inboxFixture();
    const target = `conversation:${fixture.channelId}`;
    fixture.service.postMessage(
      fixture.principal,
      fixture.channelId,
      { body: '@Researcher 检查即可', mentionedActorIds: [fixture.agentId] },
      'no-output-initial',
    );
    const claim = fixture.service.claimComputerAgentInbox(fixture.computerId, fixture.agentId, {
      target,
      receipt: 'no-output-receipt',
    });
    const followUp = fixture.service.postMessage(
      fixture.principal, fixture.channelId, { body: '新的上下文' }, 'no-output-follow-up',
    );
    const review = fixture.service.completeComputerAgentInbox(fixture.computerId, fixture.agentId, {
      target,
      receipt: claim.receipt,
      expectedDiscussionFrontier: claim.discussion!.throughPosition,
    }, 'no-output-review');
    expect(review).toMatchObject({
      status: 'review_required',
      currentDiscussionFrontier: followUp.scopePosition,
      discussionDelta: { messages: [{ id: followUp.id }] },
    });
    const completedInput = {
      target,
      receipt: claim.receipt,
      expectedDiscussionFrontier: followUp.scopePosition,
    };
    const completed = fixture.service.completeComputerAgentInbox(
      fixture.computerId, fixture.agentId, completedInput, 'no-output-complete',
    );
    expect(completed).toMatchObject({ status: 'completed', receipt: claim.receipt });
    expect(fixture.service.completeComputerAgentInbox(
      fixture.computerId, fixture.agentId, completedInput, 'no-output-complete',
    )).toEqual(completed);
  });
});

function inboxFixture(): InboxFixture {
  const { service, workspaceDatabase } = createTestService();
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
  const channel = authorizeAgentInConversation(
    service,
    principal,
    workspaceGeneral(service, principal, workspace.id),
    agent.membershipId,
    'inbox-general-agent',
  );
  const fixture = {
    service,
    principal,
    workspaceId: workspace.id,
    agentId: agent.id,
    agentMembershipId: agent.membershipId,
    computerId: computer.computerId,
    channelId: channel.id,
    workspaceDatabase,
  };
  drainWorkspaceChanges(fixture, 'fixture-initial-changes');
  return fixture;
}

function drainWorkspaceChanges(
  fixture: InboxFixture,
  key: string,
): void {
  const target = `workspace:${fixture.workspaceId}`;
  const pending = fixture.service.getComputerAgentInbox(fixture.computerId, fixture.agentId).targets
    .find((item) => item.target === target);
  if (!pending) return;
  const claim = fixture.service.claimComputerAgentInbox(fixture.computerId, fixture.agentId, {
    target,
    receipt: `${key}-receipt`,
  });
  fixture.service.completeComputerAgentInbox(
    fixture.computerId,
    fixture.agentId,
    { target, receipt: claim.receipt },
    `${key}-complete`,
  );
}
