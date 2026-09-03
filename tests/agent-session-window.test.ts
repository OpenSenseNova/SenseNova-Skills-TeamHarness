import { describe, expect, it } from 'vitest';
import {
  authorizeAgentInConversation,
  createTestService,
  reportReadyRuntime,
  workspaceGeneral,
} from './helpers.js';

describe('Agent Session windows', () => {
  it('caps a DM window at ten messages and leaves overflow for the next anchor', () => {
    const { service } = createTestService();
    const human = service.bootstrapHuman('Alice', 'alice@example.com');
    const principal = { kind: 'human' as const, actorId: human.humanId };
    const workspace = service.createWorkspace(principal, 'Product', 'window-workspace');
    const agent = service.createAgent(principal, workspace.id, { name: 'Researcher' }, 'window-agent');
    const computer = service.registerComputer(principal, { name: 'Alice Mac' }, 'window-computer');
    reportReadyRuntime(service, computer.computerId, human.humanId);
    service.bindAgentRuntime(principal, workspace.id, agent.id, {
      computerId: computer.computerId,
      runtimeId: 'generic-acp',
      expectedRevision: 0,
    }, 'window-binding');
    const dm = service.createConversation(principal, workspace.id, {
      kind: 'dm',
      directWorkspaceMembershipIds: [agent.membershipId],
    }, 'window-dm');
    const messages = Array.from({ length: 11 }, (_, index) => service.postMessage(
      principal,
      dm.id,
      { body: `dm-${index + 1}` },
      `window-message-${index + 1}`,
    ));
    const requests = messages.map((message) => message.mentionOutcomes[0]!.agentRequestId!);
    const firstInput = service.getComputerAgentSessionInput(computer.computerId, agent.id, {
      kind: 'mention',
      key: requests[0]!,
    });
    const firstClaim = service.claimComputerAgentInbox(computer.computerId, agent.id, {
      target: `conversation:${dm.id}`,
      receipt: 'window-first-receipt',
      agentRequestId: requests[0]!,
      initialDiscussionFrontier: firstInput.initialDiscussionFrontier!,
    });
    expect(firstClaim.attention).toHaveLength(10);
    expect(firstClaim.sessionWindow).toEqual({ mode: 'dm', acceptedMessages: 10, maxMessages: 10, status: 'frozen' });
    expect(firstClaim.discussion.messages.map((message) => message.id)).toEqual(
      messages.slice(1, 10).map((message) => message.id),
    );
    expect(service.getComputerAgentInbox(computer.computerId, agent.id).sessionTriggers)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ agentRequestId: requests[10], requiresAction: true }),
      ]));
    service.completeComputerAgentInbox(computer.computerId, agent.id, {
      target: `conversation:${dm.id}`,
      receipt: firstClaim.receipt,
      expectedDiscussionFrontier: firstClaim.discussion.throughPosition,
    }, 'window-first-complete');
    const nextInput = service.getComputerAgentSessionInput(computer.computerId, agent.id, {
      kind: 'mention',
      key: requests[10]!,
    });
    const nextClaim = service.claimComputerAgentInbox(computer.computerId, agent.id, {
      target: `conversation:${dm.id}`,
      receipt: 'window-next-receipt',
      agentRequestId: requests[10]!,
      initialDiscussionFrontier: nextInput.initialDiscussionFrontier!,
    });
    expect(nextClaim.attention.map((item) => item.messageId)).toEqual([messages[10]!.id]);
    expect(nextClaim.sessionWindow).toMatchObject({ mode: 'dm', acceptedMessages: 1, status: 'accepting' });
  });

  it('does not repeat a source mention in the first Discussion delta', () => {
    const { service } = createTestService();
    const human = service.bootstrapHuman('Alice', 'alice@example.com');
    const principal = { kind: 'human' as const, actorId: human.humanId };
    const workspace = service.createWorkspace(principal, 'Product', 'frontier-workspace');
    const agent = service.createAgent(principal, workspace.id, { name: 'Researcher' }, 'frontier-agent');
    const computer = service.registerComputer(principal, { name: 'Alice Mac' }, 'frontier-computer');
    reportReadyRuntime(service, computer.computerId, human.humanId);
    service.bindAgentRuntime(principal, workspace.id, agent.id, {
      computerId: computer.computerId,
      runtimeId: 'generic-acp',
      expectedRevision: 0,
    }, 'frontier-binding');
    const channel = authorizeAgentInConversation(
      service,
      principal,
      workspaceGeneral(service, principal, workspace.id),
      agent.membershipId,
      'frontier-channel-agent',
    );
    const mention = service.postMessage(principal, channel.id, {
      body: '@Researcher inspect this',
      mentionedActorIds: [agent.id],
    }, 'frontier-mention');
    const requestId = mention.mentionOutcomes[0]!.agentRequestId!;
    const input = service.getComputerAgentSessionInput(computer.computerId, agent.id, {
      kind: 'mention',
      key: requestId,
    });
    const claim = service.claimComputerAgentInbox(computer.computerId, agent.id, {
      target: `conversation:${channel.id}`,
      receipt: 'frontier-receipt',
      agentRequestId: requestId,
      initialDiscussionFrontier: input.initialDiscussionFrontier!,
    });
    expect(claim.attention.map((item) => item.messageId)).toEqual([mention.id]);
    expect(claim.discussion.messages).toEqual([]);
    expect(claim.discussion.sincePositionExclusive).toBe(input.initialDiscussionFrontier);
  });

  it('keeps two Group Mentions in separate isolated Sessions', () => {
    const { service } = createTestService();
    const human = service.bootstrapHuman('Alice', 'alice@example.com');
    const principal = { kind: 'human' as const, actorId: human.humanId };
    const workspace = service.createWorkspace(principal, 'Product', 'group-session-workspace');
    const agent = service.createAgent(principal, workspace.id, { name: 'Researcher' }, 'group-session-agent');
    const computer = service.registerComputer(principal, { name: 'Alice Mac' }, 'group-session-computer');
    reportReadyRuntime(service, computer.computerId, human.humanId);
    service.bindAgentRuntime(principal, workspace.id, agent.id, {
      computerId: computer.computerId,
      runtimeId: 'generic-acp',
      expectedRevision: 0,
    }, 'group-session-binding');
    const channel = authorizeAgentInConversation(
      service,
      principal,
      workspaceGeneral(service, principal, workspace.id),
      agent.membershipId,
      'group-session-channel',
    );
    const first = service.postMessage(principal, channel.id, {
      body: '@Researcher first',
      mentionedActorIds: [agent.id],
    }, 'group-session-first');
    const second = service.postMessage(principal, channel.id, {
      body: '@Researcher second',
      mentionedActorIds: [agent.id],
    }, 'group-session-second');
    const firstRequest = first.mentionOutcomes[0]!.agentRequestId!;
    const secondRequest = second.mentionOutcomes[0]!.agentRequestId!;
    expect(firstRequest).not.toBe(secondRequest);

    const summary = service.getComputerAgentInbox(computer.computerId, agent.id);
    expect(summary.sessionTriggers.filter((trigger) => trigger.target === `conversation:${channel.id}`))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ agentRequestId: firstRequest, session: { kind: 'mention', key: firstRequest } }),
        expect.objectContaining({ agentRequestId: secondRequest, session: { kind: 'mention', key: secondRequest } }),
      ]));

    const firstInput = service.getComputerAgentSessionInput(computer.computerId, agent.id, {
      kind: 'mention', key: firstRequest,
    });
    const firstClaim = service.claimComputerAgentInbox(computer.computerId, agent.id, {
      target: `conversation:${channel.id}`,
      receipt: 'group-session-first-receipt',
      agentRequestId: firstRequest,
      initialDiscussionFrontier: firstInput.initialDiscussionFrontier!,
    });
    expect(firstClaim.attention.map((item) => item.messageId)).toEqual([first.id]);
    expect(firstClaim.discussion.messages).toEqual([]);

    const secondInput = service.getComputerAgentSessionInput(computer.computerId, agent.id, {
      kind: 'mention', key: secondRequest,
    });
    const secondClaim = service.claimComputerAgentInbox(computer.computerId, agent.id, {
      target: `conversation:${channel.id}`,
      receipt: 'group-session-second-receipt',
      agentRequestId: secondRequest,
      initialDiscussionFrontier: secondInput.initialDiscussionFrontier!,
    });
    expect(secondClaim.attention.map((item) => item.messageId)).toEqual([second.id]);
    expect(secondClaim.discussion.messages).toEqual([]);
  });
});
