import { describe, expect, it } from 'vitest';
import type { HumanPrincipal } from '../src/domain/types.js';
import { buildApp } from '../src/http/app.js';
import { createTestService, reportReadyRuntime, workspaceGeneral } from './helpers.js';

function addHuman(
  service: ReturnType<typeof createTestService>['service'],
  owner: HumanPrincipal,
  member: HumanPrincipal,
  workspaceId: string,
  key: string,
) {
  const joinLink = service.createWorkspaceJoinLink(owner, workspaceId);
  return service.acceptWorkspaceJoinLink(member, joinLink.token, `${key}-accept`);
}

describe('Conversation visibility and private audience governance', () => {
  it('exposes revisioned, idempotent private participant commands over HTTP', async () => {
    const { service } = createTestService();
    const alice = service.bootstrapHuman('Alice', 'alice@example.com');
    const bob = service.bootstrapHuman('Bob', 'bob@example.com');
    const alicePrincipal = { kind: 'human' as const, actorId: alice.humanId };
    const bobPrincipal = { kind: 'human' as const, actorId: bob.humanId };
    const workspace = service.createWorkspace(alicePrincipal, 'Product', 'http-visibility-workspace');
    const bobMembership = addHuman(service, alicePrincipal, bobPrincipal, workspace.id, 'http-bob');
    const project = service.createProject(alicePrincipal, workspace.id, { name: 'Secret project' }, 'http-private-project');
    const bobProjectMembership = service.addProjectMember(alicePrincipal, project.id, {
      workspaceMembershipId: bobMembership.membershipId, role: 'member',
    }, 'http-private-project-bob');
    const app = await buildApp(service);
    const aliceHeaders = { authorization: `Bearer ${alice.token}` };
    const bobHeaders = { authorization: `Bearer ${bob.token}` };
    try {
      const createdResponse = await app.inject({
        method: 'POST',
        url: `/v1/projects/${project.id}/conversations`,
        headers: { ...aliceHeaders, 'idempotency-key': 'http-private-create' },
        payload: {
          kind: 'channel',
          title: 'Secret',
          participantProjectMembershipIds: [bobProjectMembership.projectMembershipId],
        },
      });
      expect(createdResponse.statusCode, createdResponse.body).toBe(201);
      const created = createdResponse.json<{ id: string; revision: number; visibility: string; accessMode: string }>();
      expect(created).toMatchObject({ revision: 1, visibility: 'private', accessMode: 'content' });

      const removedResponse = await app.inject({
        method: 'DELETE',
        url: `/v1/conversations/${created.id}/participants/${bobProjectMembership.projectMembershipId}`,
        headers: { ...aliceHeaders, 'idempotency-key': 'http-private-remove' },
        payload: { expectedRevision: created.revision },
      });
      expect(removedResponse.statusCode, removedResponse.body).toBe(200);
      expect(removedResponse.json()).toMatchObject({
        scopeMembershipId: bobProjectMembership.projectMembershipId,
        revision: 2,
      });
      const forbidden = await app.inject({
        method: 'GET',
        url: `/v1/conversations/${created.id}/messages`,
        headers: bobHeaders,
      });
      expect(forbidden.statusCode).toBe(404);

      const addRequest = {
        method: 'PUT' as const,
        url: `/v1/conversations/${created.id}/participants/${bobProjectMembership.projectMembershipId}`,
        headers: { ...aliceHeaders, 'idempotency-key': 'http-private-add' },
        payload: { expectedRevision: 2 },
      };
      const addedResponse = await app.inject(addRequest);
      expect(addedResponse.statusCode, addedResponse.body).toBe(200);
      expect(addedResponse.json()).toMatchObject({ scopeMembershipId: bobProjectMembership.projectMembershipId });
      const replayResponse = await app.inject(addRequest);
      expect(replayResponse.statusCode, replayResponse.body).toBe(200);
      expect(replayResponse.json()).toEqual(addedResponse.json());
      const staleResponse = await app.inject({
        ...addRequest,
        headers: { ...aliceHeaders, 'idempotency-key': 'http-private-add-stale' },
      });
      expect(staleResponse.statusCode).toBe(409);
    } finally {
      await app.close();
    }
  });

  it('projects public scope dynamically and gives a removed private administrator governance-only access', () => {
    const { service } = createTestService();
    const alice = service.bootstrapHuman('Alice', 'alice@example.com');
    const bob = service.bootstrapHuman('Bob', 'bob@example.com');
    const charlie = service.bootstrapHuman('Charlie', 'charlie@example.com');
    const alicePrincipal = { kind: 'human' as const, actorId: alice.humanId };
    const bobPrincipal = { kind: 'human' as const, actorId: bob.humanId };
    const charliePrincipal = { kind: 'human' as const, actorId: charlie.humanId };
    const workspace = service.createWorkspace(alicePrincipal, 'Product', 'visibility-workspace');
    const bobMembership = addHuman(service, alicePrincipal, bobPrincipal, workspace.id, 'visibility-bob');

    const publicChannel = workspaceGeneral(service, alicePrincipal, workspace.id);
    service.postMessage(alicePrincipal, publicChannel.id, { body: 'public history' }, 'public-history');
    const firstCharlieMembership = addHuman(
      service, alicePrincipal, charliePrincipal, workspace.id, 'visibility-charlie-first',
    );
    expect(service.listMessages(charliePrincipal, publicChannel.id).map((item) => item.body)).toEqual(['public history']);
    service.removeWorkspaceMember(
      alicePrincipal,
      workspace.id,
      firstCharlieMembership.membershipId,
      firstCharlieMembership.revision,
      'visibility-charlie-remove',
    );
    const charlieMembership = addHuman(
      service, alicePrincipal, charliePrincipal, workspace.id, 'visibility-charlie-second',
    );
    expect(charlieMembership.membershipId).not.toBe(firstCharlieMembership.membershipId);
    expect(service.listMessages(charliePrincipal, publicChannel.id).map((item) => item.body)).toEqual(['public history']);
    expect(service.getConversation(bobPrincipal, publicChannel.id)).toMatchObject({
      visibility: 'public',
      accessMode: 'content',
    });
    expect(service.listConversationParticipants(bobPrincipal, publicChannel.id).map((item) => item.actorId))
      .toEqual(expect.arrayContaining([alice.humanId, bob.humanId, charlie.humanId]));
    expect(() => service.createConversation(
      bobPrincipal,
      workspace.id,
      { kind: 'channel', visibility: 'public', title: 'Forbidden' },
      'member-channel',
    )).toThrow(/exactly one system-created general group/);
    expect(() => service.createConversation(
      alicePrincipal,
      workspace.id,
      {
        kind: 'channel',
        visibility: 'public',
        title: 'Invalid audience',
        participantWorkspaceMembershipIds: [bobMembership.membershipId],
      },
      'public-with-audience',
    )).toThrow(/exactly one system-created general group/);

    const project = service.createProject(alicePrincipal, workspace.id, { name: 'Private' }, 'private-project');
    const bobProjectMembership = service.addProjectMember(alicePrincipal, project.id, {
      workspaceMembershipId: bobMembership.membershipId, role: 'member',
    }, 'private-project-bob');
    const charlieProjectMembership = service.addProjectMember(alicePrincipal, project.id, {
      workspaceMembershipId: charlieMembership.membershipId, role: 'member',
    }, 'private-project-charlie');
    const privateChannel = service.createProjectConversation(
      alicePrincipal,
      project.id,
      {
        kind: 'channel',
        title: 'Secret',
        participantProjectMembershipIds: [bobProjectMembership.projectMembershipId],
      },
      'private-channel',
    );
    service.postMessage(alicePrincipal, privateChannel.id, { body: 'classified' }, 'private-message');
    expect(service.getConversation(bobPrincipal, privateChannel.id).accessMode).toBe('content');
    expect(() => service.getConversation(charliePrincipal, privateChannel.id)).toThrow(/not accessible/);
    expect(() => service.addConversationParticipant(
      bobPrincipal,
      privateChannel.id,
      charlieProjectMembership.projectMembershipId,
      privateChannel.revision,
      'private-member-cannot-govern',
    )).toThrow(/group creator or a Project Owner or Manager/);

    const removedSelf = service.removeConversationParticipant(
      alicePrincipal,
      privateChannel.id,
      project.membershipId!,
      privateChannel.revision,
      'private-remove-owner',
    );
    expect(removedSelf).toMatchObject({ revision: 2, contextVersion: 3 });
    expect(service.getConversation(alicePrincipal, privateChannel.id).accessMode).toBe('governance');
    expect(() => service.listMessages(alicePrincipal, privateChannel.id)).toThrow(/governance access only/);
    expect(service.followChanges(alicePrincipal, workspace.id, 0, 200).items
      .some((change) => change.conversationId === privateChannel.id)).toBe(false);
    expect(service.listConversationParticipants(alicePrincipal, privateChannel.id).map((item) => item.actorId))
      .toEqual([bob.humanId]);

    service.addConversationParticipant(
      alicePrincipal,
      privateChannel.id,
      project.membershipId!,
      removedSelf.revision,
      'private-readd-owner',
    );
    expect(service.getConversation(alicePrincipal, privateChannel.id)).toMatchObject({
      revision: 3,
      accessMode: 'content',
    });
    expect(service.listMessages(alicePrincipal, privateChannel.id).map((item) => item.body)).toEqual(['classified']);
  });

  it('binds explicit Project group history to an exact Project Membership tenure', () => {
    const { service } = createTestService();
    const alice = service.bootstrapHuman('Alice', 'alice@example.com');
    const bob = service.bootstrapHuman('Bob', 'bob@example.com');
    const alicePrincipal = { kind: 'human' as const, actorId: alice.humanId };
    const bobPrincipal = { kind: 'human' as const, actorId: bob.humanId };
    const workspace = service.createWorkspace(alicePrincipal, 'Product', 'tenure-workspace');
    const firstMembership = addHuman(service, alicePrincipal, bobPrincipal, workspace.id, 'first-bob');
    const project = service.createProject(alicePrincipal, workspace.id, { name: 'Tenure' }, 'tenure-project');
    const firstProjectMembership = service.addProjectMember(alicePrincipal, project.id, {
      workspaceMembershipId: firstMembership.membershipId, role: 'member',
    }, 'tenure-project-bob-first');
    const privateChannel = service.createProjectConversation(
      alicePrincipal,
      project.id,
      {
        kind: 'channel',
        participantProjectMembershipIds: [firstProjectMembership.projectMembershipId],
      },
      'tenure-private-channel',
    );
    service.postMessage(alicePrincipal, privateChannel.id, { body: 'old history' }, 'tenure-message');

    service.removeWorkspaceMember(
      alicePrincipal,
      workspace.id,
      firstMembership.membershipId,
      firstMembership.revision,
      'remove-first-bob',
    );
    const secondMembership = addHuman(service, alicePrincipal, bobPrincipal, workspace.id, 'second-bob');
    expect(secondMembership.membershipId).not.toBe(firstMembership.membershipId);
    expect(() => service.getConversation(bobPrincipal, privateChannel.id)).toThrow(/not accessible/);

    const secondProjectMembership = service.addProjectMember(alicePrincipal, project.id, {
      workspaceMembershipId: secondMembership.membershipId, role: 'member',
    }, 'tenure-project-bob-second');
    service.addConversationParticipant(
      alicePrincipal,
      privateChannel.id,
      secondProjectMembership.projectMembershipId,
      privateChannel.revision,
      'add-second-bob',
    );
    expect(service.listMessages(bobPrincipal, privateChannel.id).map((item) => item.body)).toEqual(['old history']);
  });

  it('uses exact Project Memberships and rejects Workspace or cross-Project IDs', () => {
    const { service } = createTestService();
    const alice = service.bootstrapHuman('Alice', 'alice@example.com');
    const bob = service.bootstrapHuman('Bob', 'bob@example.com');
    const alicePrincipal = { kind: 'human' as const, actorId: alice.humanId };
    const bobPrincipal = { kind: 'human' as const, actorId: bob.humanId };
    const workspace = service.createWorkspace(alicePrincipal, 'Product', 'project-audience-workspace');
    const bobWorkspaceMembership = addHuman(
      service, alicePrincipal, bobPrincipal, workspace.id, 'project-bob',
    );
    const project = service.createProject(alicePrincipal, workspace.id, { name: 'Alpha' }, 'alpha-project');
    const otherProject = service.createProject(alicePrincipal, workspace.id, { name: 'Beta' }, 'beta-project');
    const bobProjectMembership = service.addProjectMember(
      alicePrincipal,
      project.id,
      { workspaceMembershipId: bobWorkspaceMembership.membershipId, role: 'member' },
      'alpha-bob',
    );
    const bobOtherProjectMembership = service.addProjectMember(
      alicePrincipal,
      otherProject.id,
      { workspaceMembershipId: bobWorkspaceMembership.membershipId, role: 'member' },
      'beta-bob',
    );
    const privateChannel = service.createProjectConversation(
      alicePrincipal,
      project.id,
      {
        kind: 'channel',
        visibility: 'private',
        participantProjectMembershipIds: [bobProjectMembership.projectMembershipId],
      },
      'alpha-private-channel',
    );
    expect(service.getConversation(bobPrincipal, privateChannel.id).accessMode).toBe('content');
    expect(() => service.addConversationParticipant(
      alicePrincipal,
      privateChannel.id,
      bobWorkspaceMembership.membershipId,
      privateChannel.revision,
      'workspace-id-as-project-participant',
    )).toThrow(/Project Membership/);
    expect(() => service.addConversationParticipant(
      alicePrincipal,
      privateChannel.id,
      bobOtherProjectMembership.projectMembershipId,
      privateChannel.revision,
      'cross-project-participant',
    )).toThrow(/Project Membership/);
    expect(() => service.createProjectConversation(
      bobPrincipal,
      project.id,
      { kind: 'channel', title: 'Bob group' },
      'project-member-channel',
    )).not.toThrow();

    service.removeProjectMember(
      alicePrincipal,
      project.id,
      bobProjectMembership.projectMembershipId,
      bobProjectMembership.revision,
      'remove-alpha-bob',
    );
    expect(() => service.addConversationParticipant(
      alicePrincipal,
      privateChannel.id,
      bobProjectMembership.projectMembershipId,
      privateChannel.revision,
      'inactive-project-participant',
    )).toThrow(/Active Project Membership/);
    expect(() => service.addConversationParticipant(
      alicePrincipal,
      privateChannel.id,
      '00000000-0000-4000-8000-000000000000',
      privateChannel.revision,
      'missing-project-participant',
    )).toThrow(/Active Project Membership/);
    const rejoined = service.addProjectMember(
      alicePrincipal,
      project.id,
      { workspaceMembershipId: bobWorkspaceMembership.membershipId, role: 'member' },
      'rejoin-alpha-bob',
    );
    expect(rejoined.projectMembershipId).not.toBe(bobProjectMembership.projectMembershipId);
    expect(() => service.getConversation(bobPrincipal, privateChannel.id)).toThrow(/not accessible/);
    service.addConversationParticipant(
      alicePrincipal,
      privateChannel.id,
      rejoined.projectMembershipId,
      privateChannel.revision,
      'readd-alpha-bob',
    );
    expect(service.getConversation(bobPrincipal, privateChannel.id).accessMode).toBe('content');
  });

  it('fences pending Requests, active Runs, attempts, messages, changes, and Agent inbox access on removal', () => {
    const { service, workspaceDatabase } = createTestService();
    const alice = service.bootstrapHuman('Alice', 'alice@example.com');
    const alicePrincipal = { kind: 'human' as const, actorId: alice.humanId };
    const workspace = service.createWorkspace(alicePrincipal, 'Product', 'fencing-workspace');
    const runningAgent = service.createAgent(alicePrincipal, workspace.id, { name: 'Runner' }, 'running-agent');
    const pendingAgent = service.createAgent(alicePrincipal, workspace.id, { name: 'Pending' }, 'pending-agent');
    const computer = service.registerComputer(alicePrincipal, { name: 'Alice Mac' }, 'fencing-computer');
    reportReadyRuntime(service, computer.computerId, alice.humanId);
    service.bindAgentRuntime(
      alicePrincipal,
      workspace.id,
      runningAgent.id,
      { computerId: computer.computerId, runtimeId: 'generic-acp', expectedRevision: 0 },
      'running-agent-binding',
    );
    const project = service.createProject(alicePrincipal, workspace.id, { name: 'Fencing' }, 'fencing-project');
    const runningProjectMembership = service.addProjectMember(alicePrincipal, project.id, {
      workspaceMembershipId: runningAgent.membershipId, role: 'member',
    }, 'fencing-running-project');
    const pendingProjectMembership = service.addProjectMember(alicePrincipal, project.id, {
      workspaceMembershipId: pendingAgent.membershipId, role: 'member',
    }, 'fencing-pending-project');
    const channel = service.createProjectConversation(
      alicePrincipal,
      project.id,
      {
        kind: 'channel',
        participantProjectMembershipIds: [
          runningProjectMembership.projectMembershipId,
          pendingProjectMembership.projectMembershipId,
        ],
      },
      'fencing-channel',
    );
    service.postMessage(alicePrincipal, channel.id, {
      body: '@Runner @Pending investigate',
      mentionedActorIds: [runningAgent.id, pendingAgent.id],
    }, 'fencing-message');
    const requests = service.listAgentRequests(alicePrincipal, channel.id);
    const runningRequest = requests.find((request) => request.targetAgentId === runningAgent.id)!;
    const pendingRequest = requests.find((request) => request.targetAgentId === pendingAgent.id)!;
    const run = service.acceptAgentRequest(
      computer.computerId,
      runningRequest.id,
      { expectedVersion: runningRequest.version },
      'accept-running-request',
    );
    const attempt = service.createAttempt(computer.computerId, run.id, 'fencing-attempt');

    const firstRemoval = service.removeConversationParticipant(
      alicePrincipal,
      channel.id,
      pendingProjectMembership.projectMembershipId,
      channel.revision,
      'remove-pending-agent',
    );
    expect(firstRemoval.cancelledAgentRequestIds).toEqual([pendingRequest.id]);
    expect(service.getAgentRequest(alicePrincipal, pendingRequest.id)).toMatchObject({
      status: 'cancelled',
      terminalReason: { code: 'authority_revoked' },
    });
    const secondRemoval = service.removeConversationParticipant(
      alicePrincipal,
      channel.id,
      runningProjectMembership.projectMembershipId,
      firstRemoval.revision,
      'remove-running-agent',
    );
    expect(secondRemoval.cancelledRunIds).toEqual([run.id]);
    expect(workspaceDatabase.raw.prepare('SELECT status, outcome FROM runs WHERE id = ?').get(run.id))
      .toEqual({ status: 'terminal', outcome: 'cancelled' });
    expect(workspaceDatabase.raw.prepare('SELECT status FROM attempts WHERE id = ?').get(attempt.id))
      .toEqual({ status: 'cancelled' });
    expect(() => service.readComputerAgentMessages(computer.computerId, runningAgent.id, {
      conversationId: channel.id,
      threadId: null,
    })).toThrow(/not accessible/);
    expect(service.getComputerAgentInbox(computer.computerId, runningAgent.id).targets)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ conversationId: channel.id })]));
  });

  it('keeps DM private and rejects every participant-management command for DM and public Channels', () => {
    const { service } = createTestService();
    const alice = service.bootstrapHuman('Alice', 'alice@example.com');
    const bob = service.bootstrapHuman('Bob', 'bob@example.com');
    const alicePrincipal = { kind: 'human' as const, actorId: alice.humanId };
    const bobPrincipal = { kind: 'human' as const, actorId: bob.humanId };
    const workspace = service.createWorkspace(alicePrincipal, 'Product', 'preset-workspace');
    const bobMembership = addHuman(service, alicePrincipal, bobPrincipal, workspace.id, 'preset-bob');
    const dm = service.createConversation(
      alicePrincipal,
      workspace.id,
      { kind: 'dm', directWorkspaceMembershipIds: [bobMembership.membershipId] },
      'private-dm',
    );
    expect(dm.visibility).toBe('private');
    expect(() => service.createConversation(
      alicePrincipal,
      workspace.id,
      { kind: 'dm', visibility: 'public', directWorkspaceMembershipIds: [bobMembership.membershipId] } as never,
      'public-dm',
    )).toThrow(/must be private/);
    expect(() => service.removeConversationParticipant(
      alicePrincipal,
      dm.id,
      bobMembership.membershipId,
      dm.revision,
      'mutate-dm',
    )).toThrow(/fixed/);

    const publicChannel = workspaceGeneral(service, alicePrincipal, workspace.id);
    expect(() => service.addConversationParticipant(
      alicePrincipal,
      publicChannel.id,
      bobMembership.membershipId,
      publicChannel.revision,
      'mutate-public-channel',
    )).toThrow(/group creator or a Project Owner or Manager/);
  });
});
