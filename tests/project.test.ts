import { describe, expect, it } from 'vitest';
import {
  authorizeAgentInConversation,
  createTestService,
  projectMain,
  reportReadyRuntime,
  workspaceGeneral,
} from './helpers.js';

const repositoryProject = (name: string) => ({
  name,
  description: `${name} repository`,
  repository: { cloneUrl: `git@github.com:example/${name}.git`, defaultBranch: 'main' },
});

function addHumanToWorkspace(
  service: ReturnType<typeof createTestService>['service'],
  owner: { kind: 'human'; actorId: string },
  member: { kind: 'human'; actorId: string },
  workspaceId: string,
  key: string,
) {
  const joinLink = service.createWorkspaceJoinLink(owner, workspaceId);
  return service.acceptWorkspaceJoinLink(member, joinLink.token, `accept-${key}`);
}

describe('Project collaboration boundary', () => {
  it('keeps direct messages at Workspace scope instead of creating Project DMs', () => {
    const { service } = createTestService();
    const alice = service.bootstrapHuman('Alice', 'alice@example.com');
    const principal = { kind: 'human' as const, actorId: alice.humanId };
    const workspace = service.createWorkspace(principal, 'Workspace', 'dm-scope-workspace');
    const project = service.createProject(principal, workspace.id, { name: 'Planning' }, 'dm-scope-project');

    expect(() => service.createProjectConversation(principal, project.id, {
      kind: 'dm',
    } as never, 'dm-scope-conversation')).toThrow(/Direct messages belong to the Workspace/);
  });

  it('creates exactly one Workspace general group and automatically includes every Human member', () => {
    const { service } = createTestService();
    const alice = service.bootstrapHuman('Alice', 'alice@example.com');
    const bob = service.bootstrapHuman('Bob', 'bob@example.com');
    const alicePrincipal = { kind: 'human' as const, actorId: alice.humanId };
    const bobPrincipal = { kind: 'human' as const, actorId: bob.humanId };
    const workspace = service.createWorkspace(alicePrincipal, 'Workspace', 'workspace');
    addHumanToWorkspace(service, alicePrincipal, bobPrincipal, workspace.id, 'bob');
    expect(() => service.createConversation(
      bobPrincipal,
      workspace.id,
      { kind: 'channel', visibility: 'public', title: 'Bob private' },
      'bob-conversation',
    )).toThrow(/exactly one system-created general group/);
    expect(() => service.createConversation(
      alicePrincipal,
      workspace.id,
      { kind: 'channel', visibility: 'public', title: 'Team' },
      'alice-conversation',
    )).toThrow(/exactly one system-created general group/);
    const conversation = workspaceGeneral(service, alicePrincipal, workspace.id);

    expect(service.getConversation(alicePrincipal, conversation.id).id).toBe(conversation.id);
    expect(service.listConversationParticipants(alicePrincipal, conversation.id).map((member) => member.actorId))
      .toEqual(expect.arrayContaining([alice.humanId, bob.humanId]));
  });

  it('separates Project discovery from Workspace governance inventory', () => {
    const { service } = createTestService();
    const alice = service.bootstrapHuman('Alice', 'alice@example.com');
    const bob = service.bootstrapHuman('Bob', 'bob@example.com');
    const alicePrincipal = { kind: 'human' as const, actorId: alice.humanId };
    const bobPrincipal = { kind: 'human' as const, actorId: bob.humanId };
    const workspace = service.createWorkspace(alicePrincipal, 'Workspace', 'workspace');
    addHumanToWorkspace(service, alicePrincipal, bobPrincipal, workspace.id, 'bob');

    const project = service.createProject(bobPrincipal, workspace.id, repositoryProject('Launch'), 'project');
    expect(project).toMatchObject({ name: 'Launch', role: 'owner', governanceOnly: false });
    expect(service.listProjects(bobPrincipal, workspace.id).items).toHaveLength(1);

    const governanceInventory = service.listProjects(alicePrincipal, workspace.id).items;
    expect(governanceInventory).toEqual([
      expect.objectContaining({
        id: project.id, membershipId: null, role: null, governanceOnly: true,
      }),
    ]);
    expect(() => service.listProjectMembers(alicePrincipal, project.id)).toThrow(/not accessible/);
    expect(() => service.listProjectConversations(alicePrincipal, project.id)).toThrow(/not accessible/);
  });

  it('keeps Workspace and Project Conversations separate while deriving members from their scopes', () => {
    const { service } = createTestService();
    const alice = service.bootstrapHuman('Alice', 'alice@example.com');
    const bob = service.bootstrapHuman('Bob', 'bob@example.com');
    const alicePrincipal = { kind: 'human' as const, actorId: alice.humanId };
    const bobPrincipal = { kind: 'human' as const, actorId: bob.humanId };
    const workspace = service.createWorkspace(alicePrincipal, 'Workspace', 'workspace');
    const bobWorkspaceMembership = addHumanToWorkspace(
      service,
      alicePrincipal,
      bobPrincipal,
      workspace.id,
      'bob',
    );
    const project = service.createProject(alicePrincipal, workspace.id, repositoryProject('Launch'), 'project');
    const bobProjectMembership = service.addProjectMember(
      alicePrincipal,
      project.id,
      { workspaceMembershipId: bobWorkspaceMembership.membershipId, role: 'member' },
      'add-bob',
    );

    const workspaceConversation = workspaceGeneral(service, alicePrincipal, workspace.id);
    const projectConversation = projectMain(service, alicePrincipal, project.id);

    expect(workspaceConversation.projectId).toBeNull();
    expect(projectConversation.projectId).toBe(project.id);
    expect(service.listConversations(alicePrincipal, workspace.id).items.map((item) => item.id)).toEqual([
      workspaceConversation.id,
    ]);
    expect(service.listProjectConversations(alicePrincipal, project.id).items.map((item) => item.id)).toEqual([
      projectConversation.id,
    ]);
    expect(service.listProjectConversations(bobPrincipal, project.id).items.map((item) => item.id)).toEqual([
      projectConversation.id,
    ]);
    expect(service.getConversation(bobPrincipal, projectConversation.id).id).toBe(projectConversation.id);

    const bobManager = service.updateProjectMember(
      alicePrincipal,
      project.id,
      bobProjectMembership.projectMembershipId,
      { role: 'manager', expectedRevision: bobProjectMembership.revision },
      'promote-bob',
    );
    expect(bobManager.role).toBe('manager');
    expect(service.getConversation(bobPrincipal, projectConversation.id).id).toBe(projectConversation.id);
    expect(service.listConversationParticipants(bobPrincipal, projectConversation.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workspaceMembershipId: bobWorkspaceMembership.membershipId,
          projectMembershipId: bobProjectMembership.projectMembershipId,
        }),
      ]),
    );
  });

  it('revokes Project Channel authority on removal and restores it on rejoin', () => {
    const { service } = createTestService();
    const alice = service.bootstrapHuman('Alice', 'alice@example.com');
    const bob = service.bootstrapHuman('Bob', 'bob@example.com');
    const alicePrincipal = { kind: 'human' as const, actorId: alice.humanId };
    const bobPrincipal = { kind: 'human' as const, actorId: bob.humanId };
    const workspace = service.createWorkspace(alicePrincipal, 'Workspace', 'workspace');
    const bobWorkspaceMembership = addHumanToWorkspace(
      service,
      alicePrincipal,
      bobPrincipal,
      workspace.id,
      'bob',
    );
    const project = service.createProject(alicePrincipal, workspace.id, repositoryProject('Launch'), 'project');
    const firstMembership = service.addProjectMember(
      alicePrincipal,
      project.id,
      { workspaceMembershipId: bobWorkspaceMembership.membershipId, role: 'member' },
      'add-bob-first',
    );
    const conversation = projectMain(service, alicePrincipal, project.id);
    expect(service.getConversation(bobPrincipal, conversation.id).id).toBe(conversation.id);

    service.removeProjectMember(
      alicePrincipal,
      project.id,
      firstMembership.projectMembershipId,
      firstMembership.revision,
      'remove-bob',
    );
    expect(() => service.getConversation(bobPrincipal, conversation.id)).toThrow(/not accessible/);

    const secondMembership = service.addProjectMember(
      alicePrincipal,
      project.id,
      { workspaceMembershipId: bobWorkspaceMembership.membershipId, role: 'member' },
      'add-bob-second',
    );
    expect(secondMembership.projectMembershipId).not.toBe(firstMembership.projectMembershipId);
    expect(service.listProjectConversations(bobPrincipal, project.id).items.map((item) => item.id)).toEqual([
      conversation.id,
    ]);
    expect(service.getConversation(bobPrincipal, conversation.id).id).toBe(conversation.id);
    expect(() => service.leaveProject(alicePrincipal, project.id, 1, 'project-owner-leave')).toThrow(
      /Transfer Project ownership/,
    );
  });

  it('rejects a structured mention for an Agent outside the Project conversation', () => {
    const { service } = createTestService();
    const alice = service.bootstrapHuman('Alice', 'alice@example.com');
    const principal = { kind: 'human' as const, actorId: alice.humanId };
    const workspace = service.createWorkspace(principal, 'Workspace', 'workspace');
    const project = service.createProject(principal, workspace.id, repositoryProject('Launch'), 'project');
    const agent = service.createAgent(principal, workspace.id, { name: 'Researcher' }, 'agent');
    const conversation = projectMain(service, principal, project.id);

    expect(() => service.postMessage(
      principal,
      conversation.id,
      { body: '@Researcher', mentionedActorIds: [agent.id] },
      'message',
    )).toThrowError(expect.objectContaining({ code: 'MENTION_TARGET_NOT_IN_CONVERSATION' }));
  });
});
