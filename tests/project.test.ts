import { describe, expect, it } from 'vitest';
import { createTestService, reportReadyRuntime } from './helpers.js';

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
  email: string,
  key: string,
) {
  const invitation = service.createInvitation(
    owner,
    workspaceId,
    { verifiedEmail: email, membershipRole: 'member' },
    `invite-${key}`,
  );
  return service.acceptInvitation(member, invitation.id, invitation.revision, `accept-${key}`);
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

  it('runs repository-less Projects in scratch and switches new Runs with Repository attachment state', () => {
    const { service, workspaceDatabase } = createTestService();
    const alice = service.bootstrapHuman('Alice', 'alice@example.com');
    const principal = { kind: 'human' as const, actorId: alice.humanId };
    const workspace = service.createWorkspace(principal, 'Workspace', 'scratch-workspace');
    const computer = service.registerComputer(principal, { name: 'Alice Mac' }, 'scratch-computer');
    reportReadyRuntime(service, computer.computerId, alice.humanId);
    const agent = service.createAgent(principal, workspace.id, {
      name: 'Builder',
      runtimeBinding: { computerId: computer.computerId, runtimeId: 'generic-acp' },
    }, 'scratch-agent');
    const project = service.createProject(principal, workspace.id, { name: 'Planning' }, 'scratch-project');
    expect(project.repository).toBeNull();
    const agentProjectMembership = service.addProjectMember(
      principal,
      project.id,
      { workspaceMembershipId: agent.membershipId, role: 'member' },
      'scratch-agent-project',
    );
    const conversation = service.createProjectConversation(principal, project.id, {
      kind: 'channel',
    }, 'scratch-conversation');
    const request = service.postMessage(principal, conversation.id, {
      body: '@Builder draft a plan',
      mentionedActorIds: [agent.id],
    }, 'scratch-request').mentionOutcomes[0]!.agentRequestId!;
    expect(service.getAgentRequest(principal, request).intake).toEqual({ disposition: 'ready', reasons: [] });
    const scratchRun = service.acceptAgentRequest(computer.computerId, request, { expectedVersion: 1 }, 'scratch-accept');
    expect(service.getRunContextSnapshot(scratchRun.id)).toMatchObject({
      projectId: project.id,
      repositoryId: null,
      repositoryIdentity: null,
      repositoryBaseCommit: null,
    });
    const scratchAttempt = service.createAttempt(computer.computerId, scratchRun.id, 'scratch-attempt');
    expect(service.getAttemptExecutionInput(computer.computerId, scratchAttempt.id).executionScope)
      .toEqual({ kind: 'workspace_scratch' });
    service.failAttempt(computer.computerId, scratchAttempt.id, 'fixture complete', 'scratch-fail');
    expect(service.getAgentRequest(principal, request).run?.attempt?.failureReason).toEqual({
      code: 'runtime_failure',
      message: 'fixture complete',
    });

    const withRepository = service.putProjectRepository(principal, project.id, {
      cloneUrl: 'https://github.com/example/planning.git',
      defaultBranch: 'main',
      expectedProjectRevision: project.revision,
    }, 'scratch-attach-repository');
    expect(withRepository.repository).toMatchObject({ defaultBranch: 'main' });
    const computerPrincipal = {
      kind: 'computer' as const,
      computerId: computer.computerId,
      ownerHumanId: alice.humanId,
    };
    service.reportProjectWorkingCopy(computerPrincipal, project.id, {
      repositoryId: withRepository.repository!.id,
      repositoryIdentity: withRepository.repository!.repositoryIdentity,
      availability: 'ready',
      branch: 'main',
      headCommit: 'c'.repeat(40),
      dirty: false,
    }, 'scratch-repository-ready');
    const repositoryRequest = service.postMessage(principal, conversation.id, {
      body: '@Builder inspect the repository',
      mentionedActorIds: [agent.id],
    }, 'repository-request').mentionOutcomes[0]!.agentRequestId!;
    const repositoryRun = service.acceptAgentRequest(
      computer.computerId,
      repositoryRequest,
      { expectedVersion: 1 },
      'repository-accept',
    );
    const repositoryAttempt = service.createAttempt(computer.computerId, repositoryRun.id, 'repository-attempt');
    expect(service.getAttemptExecutionInput(computer.computerId, repositoryAttempt.id).executionScope)
      .toMatchObject({ kind: 'project_repository', repositoryId: withRepository.repository!.id });
    expect(() => service.deleteProjectRepository(principal, project.id, {
      expectedProjectRevision: withRepository.revision,
      expectedRepositoryRevision: withRepository.repository!.revision,
    }, 'repository-detach-active')).toThrow(/Attempt is active/);
    service.failAttempt(computer.computerId, repositoryAttempt.id, 'fixture complete', 'repository-fail');

    const detached = service.deleteProjectRepository(principal, project.id, {
      expectedProjectRevision: withRepository.revision,
      expectedRepositoryRevision: withRepository.repository!.revision,
    }, 'repository-detach');
    expect(detached.repository).toBeNull();
    expect(service.getRunContextSnapshot(repositoryRun.id).repositoryId).toBe(withRepository.repository!.id);
    expect(workspaceDatabase.raw.prepare(
      'SELECT status FROM project_repositories WHERE id = ?',
    ).get(withRepository.repository!.id)).toEqual({ status: 'detached' });
  });

  it('enforces Resource Link URL, revision and creator-or-manager permissions', () => {
    const { service } = createTestService();
    const alice = service.bootstrapHuman('Alice', 'alice@example.com');
    const bob = service.bootstrapHuman('Bob', 'bob@example.com');
    const alicePrincipal = { kind: 'human' as const, actorId: alice.humanId };
    const bobPrincipal = { kind: 'human' as const, actorId: bob.humanId };
    const workspace = service.createWorkspace(alicePrincipal, 'Workspace', 'resource-workspace');
    const bobWorkspaceMembership = addHumanToWorkspace(
      service,
      alicePrincipal,
      bobPrincipal,
      workspace.id,
      'bob@example.com',
      'resource-bob',
    );
    const project = service.createProject(alicePrincipal, workspace.id, { name: 'Resources' }, 'resource-project');
    service.addProjectMember(alicePrincipal, project.id, {
      workspaceMembershipId: bobWorkspaceMembership.membershipId,
      role: 'member',
    }, 'resource-project-bob');
    expect(() => service.createProjectResourceLink(bobPrincipal, project.id, {
      title: 'Invalid',
      url: 'file:///tmp/private',
    }, 'resource-invalid')).toThrow(/http or https/);

    const bobLink = service.createProjectResourceLink(bobPrincipal, project.id, {
      title: 'Spec',
      url: 'https://example.com/spec',
      description: 'External reference',
    }, 'resource-create-bob');
    const updatedByCreator = service.updateProjectResourceLink(bobPrincipal, project.id, bobLink.id, {
      title: 'Spec v2',
      url: 'https://example.com/spec-v2',
      expectedRevision: bobLink.revision,
    }, 'resource-update-bob');
    expect(updatedByCreator).toMatchObject({ title: 'Spec v2', revision: 2 });
    expect(() => service.updateProjectResourceLink(bobPrincipal, project.id, bobLink.id, {
      title: 'Stale',
      url: 'https://example.com/stale',
      expectedRevision: bobLink.revision,
    }, 'resource-update-stale')).toThrow(/revision changed/);

    const aliceLink = service.createProjectResourceLink(alicePrincipal, project.id, {
      title: 'Roadmap',
      url: 'http://example.com/roadmap',
    }, 'resource-create-alice');
    expect(() => service.updateProjectResourceLink(bobPrincipal, project.id, aliceLink.id, {
      title: 'No access',
      url: aliceLink.url,
      expectedRevision: aliceLink.revision,
    }, 'resource-update-forbidden')).toThrow(/creator or a Project Manager/);
    const managerUpdated = service.updateProjectResourceLink(alicePrincipal, project.id, bobLink.id, {
      title: 'Manager edit',
      url: updatedByCreator.url,
      expectedRevision: updatedByCreator.revision,
    }, 'resource-manager-update');
    service.deleteProjectResourceLink(alicePrincipal, project.id, bobLink.id, managerUpdated.revision, 'resource-manager-delete');
    expect(service.listProjectResourceLinks(alicePrincipal, project.id)).toEqual([
      expect.objectContaining({ id: aliceLink.id, title: 'Roadmap' }),
    ]);
  });

  it('waits for a fresh matching Working Copy and pins Repository execution input', () => {
    const { service } = createTestService();
    const alice = service.bootstrapHuman('Alice', 'alice@example.com');
    const principal = { kind: 'human' as const, actorId: alice.humanId };
    const workspace = service.createWorkspace(principal, 'Workspace', 'workspace-repository-run');
    const computer = service.registerComputer(principal, { name: 'Alice Mac' }, 'project-computer');
    reportReadyRuntime(service, computer.computerId, alice.humanId);
    const agent = service.createAgent(principal, workspace.id, {
      name: 'Builder',
      runtimeBinding: { computerId: computer.computerId, runtimeId: 'generic-acp' },
    }, 'project-agent');
    const project = service.createProject(principal, workspace.id, repositoryProject('Runtime'), 'project-runtime');
    const agentProjectMembership = service.addProjectMember(
      principal,
      project.id,
      { workspaceMembershipId: agent.membershipId, role: 'member' },
      'project-add-agent',
    );
    const conversation = service.createProjectConversation(principal, project.id, {
      kind: 'channel',
    }, 'project-conversation-runtime');
    const message = service.postMessage(principal, conversation.id, {
      body: '@Builder inspect this Repository',
      mentionedActorIds: [agent.id],
    }, 'project-message-runtime');
    const requestId = message.mentionOutcomes[0]!.agentRequestId!;
    expect(service.getAgentRequest(principal, requestId).intake).toEqual({
      disposition: 'waiting', reasons: ['project_working_copy_unavailable'],
    });

    const computerPrincipal = {
      kind: 'computer' as const,
      computerId: computer.computerId,
      ownerHumanId: alice.humanId,
    };
    service.reportProjectWorkingCopy(computerPrincipal, project.id, {
      repositoryId: project.repository!.id,
      repositoryIdentity: project.repository!.repositoryIdentity,
      availability: 'ready',
      branch: 'main',
      headCommit: 'a'.repeat(40),
      dirty: true,
    }, 'project-working-copy-ready');
    expect(service.getAgentRequest(principal, requestId).intake).toEqual({ disposition: 'ready', reasons: [] });

    const run = service.acceptAgentRequest(computer.computerId, requestId, { expectedVersion: 1 }, 'project-accept');
    const snapshot = service.getRunContextSnapshot(run.id);
    expect(snapshot).toMatchObject({
      projectId: project.id,
      repositoryId: project.repository!.id,
      repositoryIdentity: project.repository!.repositoryIdentity,
      repositoryBaseCommit: 'a'.repeat(40),
    });
    service.removeProjectWorkingCopy(computerPrincipal, project.id, 'project-working-copy-remove');
    expect(() => service.createAttempt(computer.computerId, run.id, 'project-attempt-blocked'))
      .toThrow(/fresh matching Project Working Copy/);
    service.reportProjectWorkingCopy(computerPrincipal, project.id, {
      repositoryId: project.repository!.id,
      repositoryIdentity: project.repository!.repositoryIdentity,
      availability: 'ready',
      branch: 'main',
      headCommit: 'b'.repeat(40),
      dirty: false,
    }, 'project-working-copy-rebound');
    const attempt = service.createAttempt(computer.computerId, run.id, 'project-attempt-ready');
    expect(service.getAttemptExecutionInput(computer.computerId, attempt.id).executionScope).toEqual({
      kind: 'project_repository',
      projectId: project.id,
      repositoryId: project.repository!.id,
      repositoryIdentity: project.repository!.repositoryIdentity,
      baseCommit: 'a'.repeat(40),
    });
  });

  it('makes every Workspace Channel visible to all active Workspace members', () => {
    const { service } = createTestService();
    const alice = service.bootstrapHuman('Alice', 'alice@example.com');
    const bob = service.bootstrapHuman('Bob', 'bob@example.com');
    const alicePrincipal = { kind: 'human' as const, actorId: alice.humanId };
    const bobPrincipal = { kind: 'human' as const, actorId: bob.humanId };
    const workspace = service.createWorkspace(alicePrincipal, 'Workspace', 'workspace');
    addHumanToWorkspace(service, alicePrincipal, bobPrincipal, workspace.id, 'bob@example.com', 'bob');
    const conversation = service.createConversation(
      bobPrincipal,
      workspace.id,
      { kind: 'channel', title: 'Bob private' },
      'bob-conversation',
    );

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
    addHumanToWorkspace(service, alicePrincipal, bobPrincipal, workspace.id, 'bob@example.com', 'bob');

    const project = service.createProject(bobPrincipal, workspace.id, repositoryProject('Launch'), 'project');
    expect(project).toMatchObject({ name: 'Launch', role: 'manager', governanceOnly: false });
    expect(service.listProjects(bobPrincipal, workspace.id).items).toHaveLength(1);

    const governanceInventory = service.listProjects(alicePrincipal, workspace.id).items;
    expect(governanceInventory).toEqual([
      expect.objectContaining({
        id: project.id, membershipId: null, role: null, governanceOnly: true, repository: null,
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
      'bob@example.com',
      'bob',
    );
    const project = service.createProject(alicePrincipal, workspace.id, repositoryProject('Launch'), 'project');
    const bobProjectMembership = service.addProjectMember(
      alicePrincipal,
      project.id,
      { workspaceMembershipId: bobWorkspaceMembership.membershipId, role: 'member' },
      'add-bob',
    );

    const workspaceConversation = service.createConversation(
      alicePrincipal,
      workspace.id,
      { kind: 'channel', title: 'Workspace only' },
      'workspace-conversation',
    );
    const projectConversation = service.createProjectConversation(
      alicePrincipal,
      project.id,
      { kind: 'channel', title: 'Project private' },
      'project-conversation',
    );

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
      'bob@example.com',
      'bob',
    );
    const project = service.createProject(alicePrincipal, workspace.id, repositoryProject('Launch'), 'project');
    const firstMembership = service.addProjectMember(
      alicePrincipal,
      project.id,
      { workspaceMembershipId: bobWorkspaceMembership.membershipId, role: 'member' },
      'add-bob-first',
    );
    const conversation = service.createProjectConversation(
      alicePrincipal,
      project.id,
      {
        kind: 'channel',
      },
      'project-conversation',
    );
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
    expect(() => service.leaveProject(alicePrincipal, project.id, 1, 'last-manager-leave')).toThrow(
      /retain an active Human Manager/,
    );
  });

  it('rejects a structured mention for an Agent outside the Project conversation', () => {
    const { service } = createTestService();
    const alice = service.bootstrapHuman('Alice', 'alice@example.com');
    const principal = { kind: 'human' as const, actorId: alice.humanId };
    const workspace = service.createWorkspace(principal, 'Workspace', 'workspace');
    const project = service.createProject(principal, workspace.id, repositoryProject('Launch'), 'project');
    const agent = service.createAgent(principal, workspace.id, { name: 'Researcher' }, 'agent');
    const conversation = service.createProjectConversation(
      principal,
      project.id,
      { kind: 'channel' },
      'conversation',
    );

    expect(() => service.postMessage(
      principal,
      conversation.id,
      { body: '@Researcher', mentionedActorIds: [agent.id] },
      'message',
    )).toThrowError(expect.objectContaining({ code: 'MENTION_TARGET_NOT_IN_CONVERSATION' }));
  });
});
