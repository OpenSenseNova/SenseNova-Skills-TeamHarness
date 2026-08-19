import { describe, expect, it } from 'vitest';
import { newId, nowMs } from '../src/lib/values.js';
import { DeliveryJobStore } from '../src/storage/delivery-job-store.js';
import { createTestService, reportReadyRuntime, testRuntimeConfigurationCapabilities } from './helpers.js';

describe('WorkspaceService', () => {
  it('atomically creates workspace, messages, versions, changes and audit records', () => {
    const { service, workspaceDatabase } = createTestService();
    const bootstrap = service.bootstrapHuman('Alice', 'alice@example.com');
    const principal = { kind: 'human' as const, actorId: bootstrap.humanId };

    const workspace = service.createWorkspace(principal, 'Product', 'workspace-1');
    const repeatedWorkspace = service.createWorkspace(principal, 'Product', 'workspace-1');
    expect(repeatedWorkspace.id).toBe(workspace.id);
    expect(workspace.membershipRole).toBe('owner');

    const conversation = service.createConversation(
      principal,
      workspace.id,
      { kind: 'channel', title: 'General' },
      'conversation-1',
    );
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
      'workspace_created',
      'conversation_created',
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

  it('requires ownership transfer before the Human Owner Membership can terminate', () => {
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

    const invitation = service.createInvitation(
      principal,
      workspace.id,
      { verifiedEmail: 'bob@example.com', membershipRole: 'owner' },
      'invite-second-owner',
    );
    const bobMembership = service.acceptInvitation(bobPrincipal, invitation.id, invitation.revision, 'accept-second-owner');
    expect(() => service.removeWorkspaceMember(
      bobPrincipal,
      workspace.id,
      workspace.membershipId,
      1,
      'remove-owner-before-transfer',
    )).toThrow(/transfer all owned Agents/);
    const transferred = service.transferAgentOwnership(
      bobPrincipal,
      workspace.id,
      agent.id,
      { newOwnerMembershipId: bobMembership.membershipId, expectedRevision: agent.revision },
      'transfer-agent-owner',
    );
    service.removeWorkspaceMember(bobPrincipal, workspace.id, workspace.membershipId, 1, 'remove-first-owner');

    expect(transferred).toMatchObject({
      createdByHumanId: alice.humanId,
      ownerHumanId: bob.humanId,
      ownerMembershipId: bobMembership.membershipId,
      revision: 2,
    });
    const ownershipHistory = workspaceDatabase.raw
      .prepare('SELECT owner_membership_id, ended_at FROM agent_ownership_history WHERE agent_id = ? ORDER BY started_at, id')
      .all(agent.id);
    expect(ownershipHistory).toEqual([
      { owner_membership_id: workspace.membershipId, ended_at: expect.any(Number) },
      { owner_membership_id: bobMembership.membershipId, ended_at: null },
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
          `INSERT INTO conversation_direct_memberships (
             id, workspace_id, conversation_id, membership_id, joined_at
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(newId(), first.id, conversation.id, second.membershipId, nowMs()),
    ).toThrow(/FOREIGN KEY/);
  });

  it('fences stale delivery workers while allowing expired jobs to recover', () => {
    const { service, workspaceDatabase } = createTestService();
    const alice = service.bootstrapHuman('Alice', 'alice@example.com');
    const principal = { kind: 'human' as const, actorId: alice.humanId };
    const workspace = service.createWorkspace(principal, 'Product', 'delivery-workspace');
    const conversation = service.createConversation(principal, workspace.id, { kind: 'channel' }, 'delivery-conversation');
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
