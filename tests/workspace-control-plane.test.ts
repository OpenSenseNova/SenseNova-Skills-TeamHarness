import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/http/app.js';
import { createTestService, reportReadyRuntime } from './helpers.js';

describe('Workspace control plane', () => {
  it('discovers and governs Workspace resources through the HTTP contract', async () => {
    const { service } = createTestService();
    const alice = service.bootstrapHuman('Alice', 'alice@example.com');
    const bob = service.bootstrapHuman('Bob', 'bob@example.com');
    const charlie = service.bootstrapHuman('Charlie', 'charlie@example.com');
    const app = await buildApp(service);
    const aliceHeaders = { authorization: `Bearer ${alice.token}` };
    const bobHeaders = { authorization: `Bearer ${bob.token}` };
    const charlieHeaders = { authorization: `Bearer ${charlie.token}` };

    const createdWorkspace = await app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: { ...aliceHeaders, 'idempotency-key': 'workspace-create' },
      payload: { name: 'Product' },
    });
    expect(createdWorkspace.statusCode).toBe(201);
    const workspace = createdWorkspace.json<{ id: string; revision: number; contextVersion: number }>();

    const discovered = await app.inject({ method: 'GET', url: '/v1/workspaces', headers: aliceHeaders });
    expect(discovered.statusCode).toBe(200);
    expect(discovered.json<{ items: Array<{ id: string }>; nextCursor: string | null }>()).toEqual({
      items: [expect.objectContaining({ id: workspace.id, revision: 1 })],
      nextCursor: null,
    });

    const bootstrap = await app.inject({
      method: 'GET', url: `/v1/workspaces/${workspace.id}/bootstrap`, headers: aliceHeaders,
    });
    expect(bootstrap.statusCode).toBe(200);
    const initialCursor = bootstrap.json<{ changeCursor: number }>().changeCursor;
    expect(initialCursor).toBeGreaterThan(0);

    const invitationResponse = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspace.id}/invitations`,
      headers: { ...aliceHeaders, 'idempotency-key': 'invite-bob' },
      payload: { verifiedEmail: 'BOB@example.com ', membershipRole: 'member' },
    });
    expect(invitationResponse.statusCode).toBe(201);
    const invitation = invitationResponse.json<{ id: string; revision: number; verifiedEmail: string }>();
    expect(invitation.verifiedEmail).toBe('bob@example.com');

    const wrongHuman = await app.inject({
      method: 'POST',
      url: `/v1/invitations/${invitation.id}/accept`,
      headers: { ...charlieHeaders, 'idempotency-key': 'wrong-accept' },
      payload: { expectedRevision: invitation.revision },
    });
    expect(wrongHuman.statusCode).toBe(404);

    const accepted = await app.inject({
      method: 'POST',
      url: `/v1/invitations/${invitation.id}/accept`,
      headers: { ...bobHeaders, 'idempotency-key': 'bob-accept' },
      payload: { expectedRevision: invitation.revision },
    });
    expect(accepted.statusCode).toBe(200);
    const bobMembership = accepted.json<{ membershipId: string; revision: number }>();

    const promoted = await app.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${workspace.id}/members/${bobMembership.membershipId}`,
      headers: { ...aliceHeaders, 'idempotency-key': 'promote-bob' },
      payload: { membershipRole: 'owner', expectedRevision: bobMembership.revision },
    });
    expect(promoted.statusCode).toBe(200);
    expect(promoted.json<{ membershipRole: string; revision: number }>()).toMatchObject({ membershipRole: 'owner', revision: 2 });

    const renamed = await app.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${workspace.id}`,
      headers: { ...bobHeaders, 'idempotency-key': 'rename-workspace' },
      payload: { name: 'Product Team', expectedRevision: workspace.revision },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json<{ name: string; revision: number }>()).toMatchObject({ name: 'Product Team', revision: 2 });

    const staleRename = await app.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${workspace.id}`,
      headers: { ...bobHeaders, 'idempotency-key': 'stale-rename' },
      payload: { name: 'Stale Name', expectedRevision: workspace.revision },
    });
    expect(staleRename.statusCode).toBe(409);
    expect(staleRename.json<{ error: { code: string } }>().error.code).toBe('STALE_REVISION');

    const conversationResponse = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspace.id}/conversations`,
      headers: { ...aliceHeaders, 'idempotency-key': 'private-conversation' },
      payload: { kind: 'channel', title: 'Private' },
    });
    const conversation = conversationResponse.json<{ id: string }>();
    const visibleConversations = await app.inject({
      method: 'GET', url: `/v1/workspaces/${workspace.id}/conversations`, headers: bobHeaders,
    });
    expect(visibleConversations.json<{ items: Array<{ id: string }> }>().items).toEqual([
      expect.objectContaining({ id: conversation.id }),
    ]);

    const agentResponse = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspace.id}/agents`,
      headers: { ...aliceHeaders, 'idempotency-key': 'create-agent' },
      payload: { name: 'Researcher' },
    });
    const agent = agentResponse.json<{ id: string; revision: number }>();
    const workspaceOwnerCannotImpersonateAgentOwner = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspace.id}/agents/${agent.id}/suspend`,
      headers: { ...bobHeaders, 'idempotency-key': 'wrong-owner-suspend-agent' },
      payload: { expectedRevision: agent.revision },
    });
    expect(workspaceOwnerCannotImpersonateAgentOwner.statusCode).toBe(403);
    const ownerTransferred = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspace.id}/agents/${agent.id}/ownership`,
      headers: { ...aliceHeaders, 'idempotency-key': 'transfer-agent-owner' },
      payload: { newOwnerMembershipId: bobMembership.membershipId, expectedRevision: agent.revision },
    });
    expect(ownerTransferred.statusCode).toBe(200);
    expect(ownerTransferred.json<{ ownerHumanId: string; revision: number }>()).toMatchObject({
      ownerHumanId: bob.humanId,
      revision: 2,
    });
    const suspended = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspace.id}/agents/${agent.id}/suspend`,
      headers: { ...bobHeaders, 'idempotency-key': 'suspend-agent' },
      payload: { expectedRevision: 2 },
    });
    expect(suspended.statusCode).toBe(200);
    expect(suspended.json<{ lifecycleStatus: string; revision: number }>()).toMatchObject({
      lifecycleStatus: 'suspended',
      revision: 3,
    });

    const resumed = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspace.id}/agents/${agent.id}/resume`,
      headers: { ...bobHeaders, 'idempotency-key': 'resume-agent' },
      payload: { expectedRevision: 3 },
    });
    expect(resumed.json<{ lifecycleStatus: string; revision: number }>()).toMatchObject({
      lifecycleStatus: 'active',
      revision: 4,
    });
    const terminated = await app.inject({
      method: 'DELETE',
      url: `/v1/workspaces/${workspace.id}/agents/${agent.id}/membership`,
      headers: { ...bobHeaders, 'idempotency-key': 'terminate-agent-membership' },
      payload: { expectedRevision: 4 },
    });
    expect(terminated.statusCode).toBe(200);
    expect(terminated.json<{ agentId: string; membershipId: string; terminatedAt: number }>()).toMatchObject({
      agentId: agent.id,
      terminatedAt: expect.any(Number),
    });

    const agentList = await app.inject({
      method: 'GET', url: `/v1/workspaces/${workspace.id}/agents`, headers: bobHeaders,
    });
    expect(agentList.json<{ items: Array<{ id: string; membershipStatus: string }> }>().items).toEqual([
      expect.objectContaining({ id: agent.id, membershipStatus: 'removed' }),
    ]);
    const inactiveAgent = await app.inject({
      method: 'GET', url: `/v1/workspaces/${workspace.id}/agents/${agent.id}`, headers: bobHeaders,
    });
    expect(inactiveAgent.statusCode).toBe(200);
    const memberList = await app.inject({
      method: 'GET', url: `/v1/workspaces/${workspace.id}/members`, headers: bobHeaders,
    });
    expect(memberList.json<{ items: Array<{ actorId: string }> }>().items.map((member) => member.actorId)).not.toContain(agent.id);

    const changes = await app.inject({
      method: 'GET', url: `/v1/workspaces/${workspace.id}/changes?after=${initialCursor}`, headers: aliceHeaders,
    });
    expect(changes.statusCode).toBe(200);
    const changePage = changes.json<{ items: Array<{ changeType: string }>; nextCursor: number }>();
    expect(changePage.items.map((change) => change.changeType)).toEqual(expect.arrayContaining([
      'invitation_created',
      'workspace_member_joined',
      'workspace_member_updated',
      'workspace_updated',
      'agent_created',
      'agent_ownership_transferred',
      'agent_suspended',
      'agent_resumed',
      'agent_membership_terminated',
      'workspace_member_removed',
    ]));
    expect(changePage.nextCursor).toBeGreaterThan(initialCursor);

    await app.close();
  });

  it('terminates and readmits Agent Membership without deleting identity, ownership, or DM history', () => {
    const { service, workspaceDatabase } = createTestService();
    const alice = service.bootstrapHuman('Alice', 'alice@example.com');
    const principal = { kind: 'human' as const, actorId: alice.humanId };
    const workspace = service.createWorkspace(principal, 'Product', 'terminate-workspace');
    const agent = service.createAgent(principal, workspace.id, { name: 'Researcher' }, 'terminate-agent-create');
    const project = service.createProject(principal, workspace.id, { name: 'Launch' }, 'terminate-agent-project');
    const projectMembership = service.addProjectMember(
      principal,
      project.id,
      { workspaceMembershipId: agent.membershipId, role: 'member' },
      'terminate-agent-project-membership',
    );
    const computer = service.registerComputer(principal, { name: 'Alice Mac' }, 'terminate-agent-computer');
    reportReadyRuntime(service, computer.computerId, alice.humanId);
    service.bindAgentRuntime(
      principal,
      workspace.id,
      agent.id,
      { computerId: computer.computerId, runtimeId: 'generic-acp', expectedRevision: 0 },
      'terminate-agent-binding',
    );
    const directMessage = service.createConversation(
      principal,
      workspace.id,
      { kind: 'dm', directWorkspaceMembershipIds: [agent.membershipId] },
      'terminate-agent-dm',
    );
    const message = service.postMessage(
      principal,
      directMessage.id,
      { body: '@Researcher investigate this', mentionedActorIds: [agent.id] },
      'terminate-agent-message',
    );
    const request = service.listAgentRequests(principal, directMessage.id)[0]!;
    expect(request.status).toBe('pending');

    const receipt = service.terminateAgentMembership(
      principal,
      workspace.id,
      agent.id,
      agent.revision,
      'terminate-agent-membership',
    );

    expect(receipt).toMatchObject({ agentId: agent.id, membershipId: agent.membershipId });
    expect(service.listAgents(principal, workspace.id).items).toEqual([
      expect.objectContaining({ id: agent.id, membershipStatus: 'removed', ownerHumanId: alice.humanId }),
    ]);
    expect(service.listWorkspaceMembers(principal, workspace.id).items.map((member) => member.actorId)).not.toContain(agent.id);
    expect(service.listConversations(principal, workspace.id).items).toEqual([]);
    expect(service.getAgent(principal, workspace.id, agent.id)).toMatchObject({ membershipStatus: 'removed' });

    expect(service.getConversation(principal, directMessage.id).id).toBe(directMessage.id);
    expect(service.listMessages(principal, directMessage.id).map((item) => item.id)).toEqual([message.id]);
    expect(service.listConversationParticipants(principal, directMessage.id).map((item) => item.actorId)).toEqual([alice.humanId]);
    expect(service.getAgentRequest(principal, request.id)).toMatchObject({
      status: 'cancelled',
      terminalReason: { code: 'authority_revoked', detail: null },
    });
    expect(() => service.postMessage(principal, directMessage.id, { body: 'hello?' }, 'closed-dm-message'))
      .toThrow(/read-only/);

    expect(workspaceDatabase.raw.prepare('SELECT lifecycle_status, owner_membership_id FROM agents WHERE actor_id = ?').get(agent.id))
      .toMatchObject({ lifecycle_status: 'suspended', owner_membership_id: workspace.membershipId });
    expect(workspaceDatabase.raw.prepare('SELECT status FROM workspace_memberships WHERE id = ?').get(agent.membershipId))
      .toEqual({ status: 'removed' });
    expect(workspaceDatabase.raw.prepare('SELECT status FROM project_memberships WHERE id = ?').get(projectMembership.projectMembershipId))
      .toEqual({ status: 'removed' });
    expect(workspaceDatabase.raw.prepare('SELECT status FROM agent_runtime_bindings WHERE agent_id = ?').get(agent.id))
      .toEqual({ status: 'disabled' });
    const readmitted = service.readmitAgentMembership(
      principal,
      workspace.id,
      agent.id,
      agent.revision + 1,
      'readmit-agent-membership',
    );
    expect(readmitted).toMatchObject({
      id: agent.id,
      membershipStatus: 'active',
      lifecycleStatus: 'suspended',
      ownerHumanId: alice.humanId,
    });
    expect(readmitted.membershipId).not.toBe(agent.membershipId);
    expect(service.listConversationParticipants(principal, directMessage.id).map((item) => item.actorId)).toEqual([alice.humanId]);
    expect(service.verifyAuditChain(workspace.id)).toBe(true);
  });

  it('permanently deletes an Agent while retaining past messages with a deleted-author marker', () => {
    const { service, workspaceDatabase } = createTestService();
    const alice = service.bootstrapHuman('Alice', 'alice@example.com');
    const principal = { kind: 'human' as const, actorId: alice.humanId };
    const workspace = service.createWorkspace(principal, 'Product', 'delete-workspace');
    const computer = service.registerComputer(principal, { name: 'Alice Mac' }, 'delete-agent-computer');
    reportReadyRuntime(service, computer.computerId, alice.humanId);
    const agent = service.createAgent(principal, workspace.id, {
      name: 'Researcher',
      runtimeBinding: { computerId: computer.computerId, runtimeId: 'generic-acp' },
    }, 'delete-agent-create');
    const directMessage = service.createConversation(
      principal,
      workspace.id,
      { kind: 'dm', directWorkspaceMembershipIds: [agent.membershipId] },
      'delete-agent-dm',
    );
    const message = service.postMessage(
      principal,
      directMessage.id,
      { body: '@Researcher keep this history', mentionedActorIds: [agent.id] },
      'delete-agent-message',
    );
    const requestId = message.mentionOutcomes[0]!.agentRequestId!;
    const run = service.acceptAgentRequest(computer.computerId, requestId, { expectedVersion: 1 }, 'delete-agent-accept');
    const attempt = service.createAttempt(computer.computerId, run.id, 'delete-agent-attempt');
    const input = service.getAttemptExecutionInput(computer.computerId, attempt.id);
    service.localExecutions.start(attempt.id, input.workspaceId, input.runId);
    const returned = service.returnAttempt(computer.computerId, attempt.id, {
      disposition: 'publish',
      messages: [{ body: 'Past Agent reply' }],
      artifactPublications: [],
    }, 'delete-agent-return');
    const agentMessage = returned.publishedMessages[0]!;

    service.terminateAgentMembership(
      principal,
      workspace.id,
      agent.id,
      agent.revision,
      'delete-agent-membership',
    );
    const receipt = service.deleteAgent(
      principal,
      workspace.id,
      agent.id,
      agent.revision + 1,
      'delete-agent',
    );

    expect(receipt).toMatchObject({ agentId: agent.id, deletedAt: expect.any(Number) });
    expect(service.listAgents(principal, workspace.id).items).toEqual([]);
    expect(() => service.getAgent(principal, workspace.id, agent.id)).toThrow(/does not exist/);
    expect(() => service.readmitAgentMembership(
      principal,
      workspace.id,
      agent.id,
      agent.revision + 2,
      'deleted-agent-readmit',
    )).toThrow(/does not exist/);
    expect(service.listMessages(principal, directMessage.id)).toEqual([
      expect.objectContaining({
        id: message.id,
        body: '@Researcher keep this history',
        authorDisplayName: 'Alice',
        authorDeleted: false,
      }),
      expect.objectContaining({
        id: agentMessage.id,
        body: 'Past Agent reply',
        authorDisplayName: 'Researcher',
        authorDeleted: true,
      }),
    ]);
    expect(workspaceDatabase.raw.prepare('SELECT deleted_at FROM agents WHERE actor_id = ?').get(agent.id))
      .toEqual({ deleted_at: receipt.deletedAt });
    expect(service.verifyAuditChain(workspace.id)).toBe(true);
  });

  it('revokes Workspace Channel access when the Workspace Membership is removed', () => {
    const { service } = createTestService();
    const alice = service.bootstrapHuman('Alice', 'alice@example.com');
    const bob = service.bootstrapHuman('Bob', 'bob@example.com');
    const alicePrincipal = { kind: 'human' as const, actorId: alice.humanId };
    const bobPrincipal = { kind: 'human' as const, actorId: bob.humanId };
    const workspace = service.createWorkspace(alicePrincipal, 'Product', 'removal-workspace');
    const invitation = service.createInvitation(
      alicePrincipal,
      workspace.id,
      { verifiedEmail: 'bob@example.com', membershipRole: 'member' },
      'removal-invite',
    );
    const bobMembership = service.acceptInvitation(
      bobPrincipal,
      invitation.id,
      invitation.revision,
      'removal-accept',
    );
    const conversation = service.createConversation(
      alicePrincipal,
      workspace.id,
      { kind: 'channel' },
      'removal-conversation',
    );
    const cursor = service.bootstrapWorkspace(alicePrincipal, workspace.id).changeCursor;
    service.postMessage(alicePrincipal, conversation.id, { body: 'workspace update' }, 'removal-message');
    service.removeWorkspaceMember(
      alicePrincipal,
      workspace.id,
      bobMembership.membershipId,
      bobMembership.revision,
      'remove-bob-from-workspace',
    );

    const changes = service.followChanges(alicePrincipal, workspace.id, cursor);
    expect(changes.items.map((change) => change.changeType)).toEqual([
      'message_created',
      'workspace_member_removed',
    ]);
    expect(() => service.getConversation(bobPrincipal, conversation.id)).toThrow(/active Workspace Membership/);
  });

  it('keeps operational Runtime binding changes out of Agent context versions', () => {
    const { service } = createTestService();
    const alice = service.bootstrapHuman('Alice', 'alice@example.com');
    const principal = { kind: 'human' as const, actorId: alice.humanId };
    const workspace = service.createWorkspace(principal, 'Product', 'version-workspace');
    const agent = service.createAgent(principal, workspace.id, { name: 'Researcher' }, 'version-agent');
    const contextBeforeBinding = service.getWorkspace(principal, workspace.id).contextVersion;
    const computer = service.registerComputer(principal, { name: 'Alice Mac' }, 'version-computer');
    reportReadyRuntime(service, computer.computerId, alice.humanId);
    service.bindAgentRuntime(
      principal,
      workspace.id,
      agent.id,
      { computerId: computer.computerId, runtimeId: 'generic-acp', expectedRevision: 0 },
      'version-binding',
    );
    expect(service.getWorkspace(principal, workspace.id).contextVersion).toBe(contextBeforeBinding);
    service.suspendAgent(principal, workspace.id, agent.id, agent.revision, 'version-suspend');
    expect(service.getWorkspace(principal, workspace.id).contextVersion).toBe(contextBeforeBinding + 1);
  });
});
