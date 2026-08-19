import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/http/app.js';
import { createTestService } from './helpers.js';

function addHumanToWorkspace(
  service: ReturnType<typeof createTestService>['service'],
  owner: { kind: 'human'; actorId: string },
  member: { kind: 'human'; actorId: string },
  workspaceId: string,
  email: string,
) {
  const invitation = service.createInvitation(
    owner,
    workspaceId,
    { verifiedEmail: email, membershipRole: 'member' },
    `invite-${email}`,
  );
  return service.acceptInvitation(member, invitation.id, invitation.revision, `accept-${email}`);
}

describe('Conversation lifecycle', () => {
  it('archives and restores through HTTP while keeping history readable and lists status-specific', async () => {
    const { service } = createTestService();
    const alice = service.bootstrapHuman('Alice', 'alice@example.com');
    const principal = { kind: 'human' as const, actorId: alice.humanId };
    const workspace = service.createWorkspace(principal, 'Product', 'conversation-lifecycle-workspace');
    const conversation = service.createConversation(
      principal,
      workspace.id,
      { kind: 'channel', title: 'Planning' },
      'conversation-lifecycle-create',
    );
    const message = service.postMessage(
      principal,
      conversation.id,
      { body: 'Keep this durable history.' },
      'conversation-lifecycle-message',
    );
    const app = await buildApp(service);
    const headers = { authorization: `Bearer ${alice.token}` };
    try {
      const archivedResponse = await app.inject({
        method: 'POST',
        url: `/v1/conversations/${conversation.id}/archive`,
        headers: { ...headers, 'idempotency-key': 'conversation-lifecycle-archive' },
        payload: { expectedRevision: conversation.revision },
      });
      expect(archivedResponse.statusCode).toBe(200);
      const archived = archivedResponse.json<{
        lifecycleStatus: string; revision: number; archivedAt: number | null; archivedByMembershipId: string | null;
      }>();
      expect(archived).toMatchObject({
        lifecycleStatus: 'archived',
        revision: 2,
        archivedAt: expect.any(Number),
        archivedByMembershipId: conversation.createdByMembershipId,
      });

      const activeList = await app.inject({
        method: 'GET', url: `/v1/workspaces/${workspace.id}/conversations`, headers,
      });
      expect(activeList.json<{ items: unknown[] }>().items).toEqual([]);
      const archivedList = await app.inject({
        method: 'GET',
        url: `/v1/workspaces/${workspace.id}/conversations?lifecycleStatus=archived`,
        headers,
      });
      expect(archivedList.json<{ items: Array<{ id: string }> }>().items).toEqual([
        expect.objectContaining({ id: conversation.id, lifecycleStatus: 'archived' }),
      ]);

      const history = await app.inject({
        method: 'GET', url: `/v1/conversations/${conversation.id}/messages`, headers,
      });
      expect(history.json<{ items: Array<{ id: string }> }>().items).toEqual([
        expect.objectContaining({ id: message.id }),
      ]);
      const rejectedWrite = await app.inject({
        method: 'POST',
        url: `/v1/conversations/${conversation.id}/messages`,
        headers: { ...headers, 'idempotency-key': 'conversation-lifecycle-rejected-message' },
        payload: { body: 'This must not be published.' },
      });
      expect(rejectedWrite.statusCode).toBe(409);
      expect(rejectedWrite.json<{ error: { code: string } }>().error.code).toBe('CONVERSATION_ARCHIVED');

      const restoredResponse = await app.inject({
        method: 'POST',
        url: `/v1/conversations/${conversation.id}/restore`,
        headers: { ...headers, 'idempotency-key': 'conversation-lifecycle-restore' },
        payload: { expectedRevision: archived.revision },
      });
      expect(restoredResponse.statusCode).toBe(200);
      expect(restoredResponse.json()).toMatchObject({
        lifecycleStatus: 'active', revision: 3, archivedAt: null, archivedByMembershipId: null,
      });
      const resumedWrite = await app.inject({
        method: 'POST',
        url: `/v1/conversations/${conversation.id}/messages`,
        headers: { ...headers, 'idempotency-key': 'conversation-lifecycle-resumed-message' },
        payload: { body: 'Conversation restored.' },
      });
      expect(resumedWrite.statusCode).toBe(201);
    } finally {
      await app.close();
    }
  });

  it('uses explicit lifecycle authority and refuses to archive pending Agent work', () => {
    const { service, workspaceDatabase } = createTestService();
    const alice = service.bootstrapHuman('Alice', 'alice@example.com');
    const bob = service.bootstrapHuman('Bob', 'bob@example.com');
    const alicePrincipal = { kind: 'human' as const, actorId: alice.humanId };
    const bobPrincipal = { kind: 'human' as const, actorId: bob.humanId };
    const workspace = service.createWorkspace(alicePrincipal, 'Product', 'conversation-authority-workspace');
    const bobMembership = addHumanToWorkspace(
      service, alicePrincipal, bobPrincipal, workspace.id, 'bob@example.com',
    );
    const channel = service.createConversation(
      alicePrincipal, workspace.id, { kind: 'channel', title: 'Team' }, 'conversation-authority-channel',
    );
    expect(() => workspaceDatabase.raw.prepare(
      "UPDATE conversations SET lifecycle_status = 'archived' WHERE id = ?",
    ).run(channel.id)).toThrow(/invalid conversation lifecycle state/);
    expect(() => service.archiveConversation(
      bobPrincipal, channel.id, channel.revision, 'conversation-authority-forbidden',
    )).toThrow(/Only a DM participant, Conversation creator/);

    const dm = service.createConversation(
      alicePrincipal,
      workspace.id,
      { kind: 'dm', directWorkspaceMembershipIds: [bobMembership.membershipId] },
      'conversation-authority-dm',
    );
    expect(service.archiveConversation(
      bobPrincipal, dm.id, dm.revision, 'conversation-authority-dm-archive',
    )).toMatchObject({ lifecycleStatus: 'archived', revision: 2 });

    const project = service.createProject(
      alicePrincipal, workspace.id, { name: 'Launch' }, 'conversation-authority-project',
    );
    const bobProjectMembership = service.addProjectMember(
      alicePrincipal,
      project.id,
      { workspaceMembershipId: bobMembership.membershipId, role: 'member' },
      'conversation-authority-project-member',
    );
    const projectConversation = service.createProjectConversation(
      alicePrincipal, project.id, { kind: 'channel', title: 'Launch plan' }, 'conversation-authority-project-channel',
    );
    expect(() => service.archiveConversation(
      bobPrincipal, projectConversation.id, projectConversation.revision, 'conversation-authority-project-forbidden',
    )).toThrow(/Project Manager/);
    service.updateProjectMember(
      alicePrincipal,
      project.id,
      bobProjectMembership.projectMembershipId,
      { role: 'manager', expectedRevision: bobProjectMembership.revision },
      'conversation-authority-project-promote',
    );
    expect(service.archiveConversation(
      bobPrincipal, projectConversation.id, projectConversation.revision, 'conversation-authority-project-archive',
    )).toMatchObject({ lifecycleStatus: 'archived', revision: 2 });
    expect(service.listProjectConversations(bobPrincipal, project.id).items).toEqual([]);
    expect(service.listProjectConversations(bobPrincipal, project.id, undefined, 100, 'archived').items).toEqual([
      expect.objectContaining({ id: projectConversation.id, lifecycleStatus: 'archived' }),
    ]);

    const agent = service.createAgent(
      alicePrincipal, workspace.id, { name: 'Researcher' }, 'conversation-authority-agent',
    );
    const requestMessage = service.postMessage(alicePrincipal, channel.id, {
      body: '@Researcher investigate', mentionedActorIds: [agent.id],
    }, 'conversation-authority-request');
    const requestId = requestMessage.mentionOutcomes[0]!.agentRequestId!;
    expect(() => service.archiveConversation(
      alicePrincipal, channel.id, channel.revision, 'conversation-authority-active-work',
    )).toThrow(/Cancel or finish pending Agent Requests/);
    service.cancelAgentRequest(
      alicePrincipal,
      requestId,
      { expectedVersion: 1 },
      'conversation-authority-cancel-request',
    );
    expect(service.archiveConversation(
      alicePrincipal, channel.id, channel.revision, 'conversation-authority-archive-after-cancel',
    )).toMatchObject({ lifecycleStatus: 'archived', revision: 2 });
  });

});
