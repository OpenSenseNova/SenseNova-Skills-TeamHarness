import { describe, expect, it } from 'vitest';
import { newId, nowMs, sha256 } from '../src/lib/values.js';
import { DeliveryJobStore } from '../src/storage/delivery-job-store.js';
import {
  createTestService,
  reportReadyRuntime,
  testRuntimeConfigurationCapabilities,
  workspaceGeneral,
} from './helpers.js';

describe('WorkspaceService', () => {
  it('lets members view and copy encrypted Workspace links while only owners create or revoke them', () => {
    const { service, workspaceDatabase } = createTestService();
    const alice = service.bootstrapHuman('Alice', 'alice@example.com');
    const bob = service.bootstrapHuman('Bob', 'bob@example.com');
    const charlie = service.bootstrapHuman('Charlie', 'charlie@example.com');
    const alicePrincipal = { kind: 'human' as const, actorId: alice.humanId };
    const bobPrincipal = { kind: 'human' as const, actorId: bob.humanId };
    const charliePrincipal = { kind: 'human' as const, actorId: charlie.humanId };
    const workspace = service.createWorkspace(alicePrincipal, 'Product', 'join-link-workspace');

    const joinLink = service.createWorkspaceJoinLink(alicePrincipal, workspace.id);
    expect(joinLink.token).toMatch(/^anc_[A-Za-z0-9_-]{43}$/u);
    const storedToken = workspaceDatabase.raw.prepare(
      'SELECT token_hash, token_ciphertext FROM workspace_join_links WHERE id = ?',
    ).get(joinLink.id) as { token_hash: string; token_ciphertext: string };
    expect(storedToken.token_hash).toBe(sha256(joinLink.token));
    expect(storedToken.token_ciphertext).not.toBe(joinLink.token);
    expect(storedToken.token_ciphertext).not.toContain(joinLink.token);
    expect((workspaceDatabase.raw.prepare("PRAGMA table_info('workspace_join_links')").all() as Array<{ name: string }>)
      .map((column) => column.name)).not.toContain('verified_email');

    expect(service.previewWorkspaceJoinLink(bobPrincipal, joinLink.token)).toMatchObject({
      workspaceId: workspace.id,
      workspaceName: 'Product',
      status: 'active',
      alreadyMember: false,
    });
    expect(service.acceptWorkspaceJoinLink(bobPrincipal, joinLink.token, 'join-link-bob')).toMatchObject({
      actorId: bob.humanId,
      membershipRole: 'member',
    });
    expect(service.acceptWorkspaceJoinLink(charliePrincipal, joinLink.token, 'join-link-charlie')).toMatchObject({
      actorId: charlie.humanId,
      membershipRole: 'member',
    });
    expect(() => service.createWorkspaceJoinLink(bobPrincipal, workspace.id)).toThrow(/Workspace Owner/);
    expect(service.listWorkspaceJoinLinks(bobPrincipal, workspace.id).items).toEqual([
      expect.objectContaining({ id: joinLink.id, token: joinLink.token, status: 'active', useCount: 2 }),
    ]);
    expect(() => service.revokeWorkspaceJoinLink(
      bobPrincipal,
      joinLink.id,
      joinLink.revision,
      'member-cannot-revoke-link',
    )).toThrow(/Workspace Owner/);

    expect(service.revokeWorkspaceJoinLink(
      alicePrincipal,
      joinLink.id,
      joinLink.revision,
      'revoke-join-link',
    )).toMatchObject({ id: joinLink.id, token: null, status: 'revoked' });
    expect(workspaceDatabase.raw.prepare(
      'SELECT token_ciphertext FROM workspace_join_links WHERE id = ?',
    ).get(joinLink.id)).toEqual({ token_ciphertext: null });
    expect(service.listWorkspaceJoinLinks(bobPrincipal, workspace.id).items).toEqual([
      expect.objectContaining({ id: joinLink.id, token: null, status: 'revoked' }),
    ]);
    expect(service.followChanges(bobPrincipal, workspace.id).items.map((change) => change.changeType))
      .toContain('workspace_join_link_revoked');
    const dave = service.bootstrapHuman('Dave', 'dave@example.com');
    expect(() => service.listWorkspaceJoinLinks(
      { kind: 'human', actorId: dave.humanId },
      workspace.id,
    )).toThrow(/Workspace Membership/);
    expect(() => service.acceptWorkspaceJoinLink(
      { kind: 'human', actorId: dave.humanId },
      joinLink.token,
      'join-link-dave',
    )).toThrow(/revoked/);
  });

  it('atomically creates workspace, messages, versions, changes and audit records', () => {
    const { service, workspaceDatabase } = createTestService();
    const bootstrap = service.bootstrapHuman('Alice', 'alice@example.com');
    const principal = { kind: 'human' as const, actorId: bootstrap.humanId };

    const workspace = service.createWorkspace(principal, 'Product', 'workspace-1');
    const repeatedWorkspace = service.createWorkspace(principal, 'Product', 'workspace-1');
    expect(repeatedWorkspace.id).toBe(workspace.id);
    expect(workspace.membershipRole).toBe('owner');

    const conversation = workspaceGeneral(service, principal, workspace.id);
    const message = service.postMessage(principal, conversation.id, { body: 'hello' }, 'message-1');
    const repeatedMessage = service.postMessage(principal, conversation.id, { body: 'hello' }, 'message-1');

    expect(repeatedMessage.id).toBe(message.id);
    expect(message.conversationVersion).toBe(2);
    expect(service.getConversation(principal, conversation.id).contextVersion).toBe(2);
    expect(service.listMessages(principal, conversation.id)).toEqual([message]);
    expect(() => service.postMessage(principal, conversation.id, { body: 'different' }, 'message-1')).toThrow(
      /different request/,
    );

    const changes = service.followChanges(principal, workspace.id);
    expect(changes.items.map((change) => change.changeType)).toEqual([
      'conversation_created',
      'workspace_created',
      'message_created',
    ]);
    expect(service.verifyAuditChain(workspace.id)).toBe(true);

    workspaceDatabase.raw
      .prepare("UPDATE audit_events SET details_json = '{\"tampered\":true}' WHERE workspace_id = ? AND seq = 2")
      .run(workspace.id);
    expect(service.verifyAuditChain(workspace.id)).toBe(false);
  });

  it('uses only owner/member Workspace roles and preserves the last owner in SQLite', () => {
    const { service, workspaceDatabase } = createTestService();
    const alice = service.bootstrapHuman('Alice', 'alice@example.com');
    const bob = service.bootstrapHuman('Bob', 'bob@example.com');
    const principal = { kind: 'human' as const, actorId: alice.humanId };
    const workspace = service.createWorkspace(principal, 'Product', 'workspace-roles');
    const timestamp = nowMs();

    const columns = workspaceDatabase.raw.prepare("PRAGMA table_info('workspace_memberships')").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).not.toContain('permission_level');

    const bobMembershipId = newId();
    workspaceDatabase.raw
      .prepare(
        `INSERT INTO workspace_memberships (
           id, workspace_id, actor_id, membership_role, status, revision, joined_at, updated_at
         ) VALUES (?, ?, ?, 'member', 'active', 1, ?, ?)`,
      )
      .run(bobMembershipId, workspace.id, bob.humanId, timestamp, timestamp);
    const bobRow = workspaceDatabase.raw
      .prepare('SELECT membership_role FROM workspace_memberships WHERE id = ?')
      .get(bobMembershipId) as { membership_role: string };
    expect(bobRow).toEqual({ membership_role: 'member' });

    expect(() =>
      workspaceDatabase.raw
        .prepare("UPDATE workspace_memberships SET status = 'removed', removed_at = ? WHERE id = ?")
        .run(timestamp, workspace.membershipId),
    ).toThrow(/retain an active owner/);
  });

  it('suspends an owned Agent when its Human Owner leaves the Workspace', () => {
    const { service, workspaceDatabase } = createTestService();
    const alice = service.bootstrapHuman('Alice', 'alice@example.com');
    const bob = service.bootstrapHuman('Bob', 'bob@example.com');
    const principal = { kind: 'human' as const, actorId: alice.humanId };
    const bobPrincipal = { kind: 'human' as const, actorId: bob.humanId };
    const workspace = service.createWorkspace(principal, 'Product', 'workspace-agent');
    const agent = service.createAgent(principal, workspace.id, { name: 'Researcher' }, 'agent-1');

    expect(() =>
      workspaceDatabase.raw.prepare('UPDATE agents SET created_by_human_id = ? WHERE actor_id = ?').run(bob.humanId, agent.id),
    ).toThrow(/immutable/);

    const joinLink = service.createWorkspaceJoinLink(principal, workspace.id);
    const joinedBobMembership = service.acceptWorkspaceJoinLink(bobPrincipal, joinLink.token, 'accept-second-owner');
    const bobMembership = service.updateWorkspaceMember(
      principal,
      workspace.id,
      joinedBobMembership.membershipId,
      { membershipRole: 'owner', expectedRevision: joinedBobMembership.revision },
      'promote-second-owner',
    );
    service.removeWorkspaceMember(
      bobPrincipal,
      workspace.id,
      workspace.membershipId,
      1,
      'remove-agent-owner',
    );
    expect(service.getAgent(bobPrincipal, workspace.id, agent.id)).toMatchObject({
      createdByHumanId: alice.humanId,
      ownerHumanId: alice.humanId,
      ownerMembershipId: workspace.membershipId,
      lifecycleStatus: 'suspended',
      membershipStatus: 'removed',
      revision: 2,
    });
    const ownershipHistory = workspaceDatabase.raw
      .prepare('SELECT owner_membership_id, ended_at FROM agent_ownership_history WHERE agent_id = ? ORDER BY started_at, id')
      .all(agent.id);
    expect(ownershipHistory).toEqual([
      { owner_membership_id: workspace.membershipId, ended_at: null },
    ]);
  });

  it('creates an Agent and its explicit ready Runtime binding atomically', () => {
    const { service, workspaceDatabase } = createTestService();
    const alice = service.bootstrapHuman('Alice', 'alice@example.com');
    const principal = { kind: 'human' as const, actorId: alice.humanId };
    const workspace = service.createWorkspace(principal, 'Product', 'runtime-workspace');
    const computer = service.registerComputer(principal, { name: 'Alice Mac' }, 'runtime-computer');
    service.heartbeatComputer({ kind: 'computer', computerId: computer.computerId, ownerHumanId: alice.humanId });

    expect(() => service.createAgent(principal, workspace.id, {
      name: 'Unlaunchable',
      runtimeBinding: { computerId: computer.computerId, runtimeId: 'codex' },
    }, 'unlaunchable-agent')).toThrow(/not ready/i);
    expect((workspaceDatabase.raw.prepare('SELECT COUNT(*) AS count FROM agents').get() as { count: number }).count).toBe(0);

    reportReadyRuntime(service, computer.computerId, alice.humanId, 'codex');
    const agent = service.createAgent(principal, workspace.id, {
      name: 'Researcher',
      runtimeBinding: {
        computerId: computer.computerId,
        runtimeId: 'codex',
        model: 'gpt-5.6-codex',
        reasoningEffort: 'high',
        mode: 'default',
      },
    }, 'bound-agent');
    expect(agent.runtimeBinding).toMatchObject({
      computerId: computer.computerId,
      computerName: 'Alice Mac',
      runtimeId: 'codex',
      computerConnectionStatus: 'online',
      runtimeAvailability: 'ready',
      configuration: {
        requested: {
          model: 'gpt-5.6-codex',
          reasoningEffort: 'high',
          mode: 'default',
        },
        effective: {
          model: { value: 'gpt-5.6-codex', source: 'explicit' },
          reasoningEffort: { value: 'high', source: 'explicit' },
          mode: { value: 'default', source: 'explicit' },
        },
        status: 'valid',
        invalidReason: null,
      },
      bindingRevision: 1,
    });
    expect(service.listComputers(principal)[0]).toMatchObject({
      connectionStatus: 'online',
      runtimeCatalogRevision: 1,
      runtimes: expect.arrayContaining([
        expect.objectContaining({ runtimeId: 'codex', availability: 'ready' }),
      ]),
    });
  });

  it('resumes a live Agent activity turn when its initial event was missed', () => {
    const { service } = createTestService();
    const alice = service.bootstrapHuman('Alice', 'alice@example.com');
    const principal = { kind: 'human' as const, actorId: alice.humanId };
    const workspace = service.createWorkspace(principal, 'Product', 'activity-recovery-workspace');
    const computer = service.registerComputer(principal, { name: 'Alice Mac' }, 'activity-recovery-computer');
    reportReadyRuntime(service, computer.computerId, alice.humanId, 'codex');
    const agent = service.createAgent(principal, workspace.id, {
      name: 'Designer',
      runtimeBinding: { computerId: computer.computerId, runtimeId: 'codex' },
    }, 'activity-recovery-agent');

    const recovered = service.recordComputerAgentActivity(computer.computerId, agent.id, {
      eventId: 'activity-recovery-tool',
      turnId: 'activity-recovery-turn',
      sequence: 18,
      eventType: 'tool',
      title: '生成演示文稿',
      status: 'in_progress',
    });

    expect(recovered).toMatchObject({ sequence: 18, title: '生成演示文稿', turnStatus: 'active' });
    expect(service.listAgentActivity(principal, workspace.id, agent.id)).toEqual([
      expect.objectContaining({ sequence: 18, title: '生成演示文稿', turnStatus: 'active' }),
      expect.objectContaining({ sequence: 17, title: '动态连接已恢复，继续处理', eventType: 'turn_started' }),
    ]);
  });

  it('finishes live Activity Turns when an Agent membership is terminated and hides deleted Agents', () => {
    const { service } = createTestService();
    const alice = service.bootstrapHuman('Alice', 'alice@example.com');
    const principal = { kind: 'human' as const, actorId: alice.humanId };
    const workspace = service.createWorkspace(principal, 'Product', 'activity-cleanup-workspace');
    const computer = service.registerComputer(principal, { name: 'Alice Mac' }, 'activity-cleanup-computer');
    reportReadyRuntime(service, computer.computerId, alice.humanId, 'codex');
    const agent = service.createAgent(principal, workspace.id, {
      name: 'To Delete',
      runtimeBinding: { computerId: computer.computerId, runtimeId: 'codex' },
    }, 'activity-cleanup-agent');

    service.recordComputerAgentActivity(computer.computerId, agent.id, {
      eventId: 'activity-cleanup-start',
      turnId: 'activity-cleanup-turn',
      sequence: 1,
      eventType: 'turn_started',
      title: '已收到消息，开始处理',
      status: 'in_progress',
    });
    expect(service.listAgentActivity(principal, workspace.id)).toHaveLength(1);

    service.terminateAgentMembership(principal, workspace.id, agent.id, agent.revision, 'activity-cleanup-terminate');
    expect(service.listAgentActivity(principal, workspace.id, agent.id)[0]).toMatchObject({
      eventType: 'turn_failed',
      status: 'failed',
      turnStatus: 'failed',
      title: 'Agent 动态连接中断',
    });

    service.deleteAgent(principal, workspace.id, agent.id, 2, 'activity-cleanup-delete');
    expect(service.listAgentActivity(principal, workspace.id)).toEqual([]);
  });

  it('validates Runtime selections, exposes defaults, and fences binding updates by revision', () => {
    const { service, workspaceDatabase } = createTestService();
    const alice = service.bootstrapHuman('Alice', 'alice@example.com');
    const principal = { kind: 'human' as const, actorId: alice.humanId };
    const workspace = service.createWorkspace(principal, 'Product', 'runtime-config-workspace');
    const computer = service.registerComputer(principal, { name: 'Alice Mac' }, 'runtime-config-computer');
    reportReadyRuntime(service, computer.computerId, alice.humanId, 'codex');

    const agent = service.createAgent(principal, workspace.id, {
      name: 'Researcher',
      runtimeBinding: { computerId: computer.computerId, runtimeId: 'codex' },
    }, 'runtime-config-agent');
    expect(agent.runtimeBinding).toMatchObject({
      bindingRevision: 1,
      configuration: {
        requested: { model: null, reasoningEffort: null, mode: null },
        effective: {
          model: { value: 'runtime-default', source: 'runtime_default' },
          reasoningEffort: { value: 'medium', source: 'runtime_default' },
          mode: { value: 'default', source: 'runtime_default' },
        },
        status: 'valid',
      },
    });
    expect(workspaceDatabase.raw.prepare(
      "SELECT COUNT(*) AS count FROM workspace_document_versions WHERE content_markdown LIKE '%runtime.model%'",
    ).get()).toEqual({ count: 0 });

    expect(() => service.bindAgentRuntime(principal, workspace.id, agent.id, {
      computerId: computer.computerId,
      runtimeId: 'codex',
      model: 'missing-model',
      expectedRevision: 1,
    }, 'runtime-config-invalid')).toThrow(/does not offer model/i);
    expect(service.getAgent(principal, workspace.id, agent.id).runtimeBinding?.bindingRevision).toBe(1);

    expect(() => service.bindAgentRuntime(principal, workspace.id, agent.id, {
      computerId: computer.computerId,
      runtimeId: 'codex',
      model: 'gpt-5.6-codex',
      reasoningEffort: 'ultra',
      expectedRevision: 1,
    }, 'runtime-config-unsupported-effort')).toThrow(/does not support reasoning effort/i);
    expect(service.getAgent(principal, workspace.id, agent.id).runtimeBinding?.bindingRevision).toBe(1);

    const updated = service.bindAgentRuntime(principal, workspace.id, agent.id, {
      computerId: computer.computerId,
      runtimeId: 'codex',
      model: 'fake-pro',
      reasoningEffort: 'high',
      expectedRevision: 1,
    }, 'runtime-config-update');
    expect(updated).toMatchObject({
      bindingRevision: 2,
      configuration: {
        requested: { model: 'fake-pro', reasoningEffort: 'high', mode: null },
        status: 'valid',
      },
    });
    expect(() => service.bindAgentRuntime(principal, workspace.id, agent.id, {
      computerId: computer.computerId,
      runtimeId: 'codex',
      expectedRevision: 1,
    }, 'runtime-config-stale')).toThrow(/revision changed/i);

    const changedCapabilities = testRuntimeConfigurationCapabilities();
    changedCapabilities.models = changedCapabilities.models.filter((model) => model.id !== 'fake-pro');
    service.reportComputerRuntimeCatalog(
      { kind: 'computer', computerId: computer.computerId, ownerHumanId: alice.humanId },
      {
        runtimes: ['generic-acp', 'codex', 'claude', 'gemini', 'goose', 'hermes'].map((runtimeId) => ({
          runtimeId,
          availability: runtimeId === 'codex' ? 'ready' as const : 'not_installed' as const,
          skills: { global: [], workspace: [] },
          ...(runtimeId === 'codex'
            ? { configuration: changedCapabilities }
            : {
                unavailableReason: {
                  code: 'not_installed' as const,
                  message: 'The Runtime is not installed in this test fixture.',
                },
              }),
        })),
      },
    );
    expect(service.getAgent(principal, workspace.id, agent.id).runtimeBinding).toMatchObject({
      validatedRuntimeCatalogRevision: 1,
      runtimeCatalogRevision: 2,
      configuration: {
        status: 'selection_unavailable',
        invalidReason: { code: 'runtime_model_unavailable' },
      },
    });
  });

  it('rejects cross-Workspace references at the SQLite boundary', () => {
    const { service, workspaceDatabase } = createTestService();
    const alice = service.bootstrapHuman('Alice', 'alice@example.com');
    const principal = { kind: 'human' as const, actorId: alice.humanId };
    const first = service.createWorkspace(principal, 'First', 'first-workspace');
    const second = service.createWorkspace(principal, 'Second', 'second-workspace');
    const agent = service.createAgent(principal, first.id, { name: 'Researcher' }, 'first-agent');
    const conversation = service.createConversation(
      principal,
      first.id,
      { kind: 'dm', directWorkspaceMembershipIds: [agent.membershipId] },
      'first-conversation',
    );

    expect(() =>
      workspaceDatabase.raw
        .prepare(
          `INSERT INTO conversation_memberships (
             id, workspace_id, conversation_id, project_id, scope_membership_id,
             workspace_membership_id, project_membership_id, joined_at
           ) VALUES (?, ?, ?, NULL, ?, ?, NULL, ?)`,
        )
        .run(newId(), first.id, conversation.id, second.membershipId, second.membershipId, nowMs()),
    ).toThrow(/FOREIGN KEY/);
  });

  it('fences stale delivery workers while allowing expired jobs to recover', () => {
    const { service, workspaceDatabase } = createTestService();
    const alice = service.bootstrapHuman('Alice', 'alice@example.com');
    const principal = { kind: 'human' as const, actorId: alice.humanId };
    const workspace = service.createWorkspace(principal, 'Product', 'delivery-workspace');
    const conversation = workspaceGeneral(service, principal, workspace.id);
    service.postMessage(principal, conversation.id, { body: 'wake agent' }, 'delivery-message');

    const jobs = new DeliveryJobStore(workspaceDatabase);
    const base = nowMs() + 1;
    const first = jobs.claimNext('worker-a', 10, base);
    expect(first).not.toBeNull();
    expect(() => jobs.markDelivered(first!.id, 'worker-a', first!.fencingToken, base + 11)).toThrow(/stale/i);
    const second = jobs.claimNext('worker-b', 10, base + 11);
    expect(second?.id).toBe(first?.id);
    expect(second?.fencingToken).toBe((first?.fencingToken ?? 0) + 1);
    expect(() => jobs.markDelivered(first!.id, 'worker-a', first!.fencingToken, base + 12)).toThrow(/stale/i);
    jobs.markDelivered(second!.id, 'worker-b', second!.fencingToken, base + 12);
  });
});
