import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/http/app.js';
import { createTestService, testRuntimeConfigurationCapabilities } from './helpers.js';

describe('Runtime configuration HTTP contract', () => {
  it('publishes inspected options and returns a revisioned effective Agent binding', async () => {
    const { service } = createTestService();
    const alice = service.bootstrapHuman('Alice', 'alice@example.com');
    const principal = { kind: 'human' as const, actorId: alice.humanId };
    const workspace = service.createWorkspace(principal, 'Product', 'runtime-contract-workspace');
    const agent = service.createAgent(principal, workspace.id, { name: 'Researcher' }, 'runtime-contract-agent');
    const computer = service.registerComputer(principal, { name: 'Alice Mac' }, 'runtime-contract-computer');
    const app = await buildApp(service);
    try {
      const catalog = await app.inject({
        method: 'PUT',
        url: '/v1/computers/self/runtime-catalog',
        headers: { authorization: `Bearer ${computer.token}` },
        payload: {
          runtimes: ['generic-acp', 'codex', 'claude', 'gemini', 'goose', 'hermes'].map((runtimeId) => ({
            runtimeId,
            availability: runtimeId === 'generic-acp' ? 'ready' : 'not_installed',
            skills: runtimeId === 'generic-acp'
              ? {
                  global: [{
                    id: 'a'.repeat(64), name: 'team-review', displayName: 'Team Review',
                    description: 'Review team changes.', source: 'agent_shared', scope: 'global',
                    installed: true, enabled: true, runtimeCompatible: true, version: null,
                    revision: 'b'.repeat(64), userInvocable: true, unavailableReason: null,
                  }],
                  workspace: [],
                }
              : { global: [], workspace: [] },
            ...(runtimeId === 'generic-acp'
              ? { detectedVersion: '1.0.0', configuration: testRuntimeConfigurationCapabilities() }
              : {
                  unavailableReason: {
                    code: 'not_installed',
                    message: 'The Runtime is not installed in this contract fixture.',
                  },
                }),
          })),
        },
      });
      expect(catalog.statusCode).toBe(200);

      const computers = await app.inject({
        method: 'GET',
        url: '/v1/computers',
        headers: { authorization: `Bearer ${alice.token}` },
      });
      expect(computers.statusCode).toBe(200);
      expect(computers.json()).toMatchObject({
        items: [{
          id: computer.computerId,
          runtimes: expect.arrayContaining([expect.objectContaining({
            runtimeId: 'generic-acp',
            detectedVersion: '1.0.0',
            configuration: expect.objectContaining({ defaultModelId: 'runtime-default' }),
            skills: {
              global: [expect.objectContaining({ name: 'team-review', displayName: 'Team Review' })],
              workspace: [],
            },
            unavailableReason: null,
          })]),
        }],
      });

      const binding = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${workspace.id}/agents/${agent.id}/runtime-bindings`,
        headers: {
          authorization: `Bearer ${alice.token}`,
          'idempotency-key': 'runtime-contract-binding',
        },
        payload: {
          computerId: computer.computerId,
          runtimeId: 'generic-acp',
          model: 'fake-pro',
          reasoningEffort: 'high',
          mode: 'autonomous',
          expectedRevision: 0,
        },
      });
      expect(binding.statusCode).toBe(201);
      expect(binding.json()).toMatchObject({
        computerConnectionStatus: 'online',
        runtimeAvailability: 'ready',
        detectedVersion: '1.0.0',
        validatedRuntimeCatalogRevision: 1,
        runtimeCatalogRevision: 1,
        bindingRevision: 1,
        configuration: {
          requested: { model: 'fake-pro', reasoningEffort: 'high', mode: 'autonomous' },
          effective: {
            model: { value: 'fake-pro', source: 'explicit' },
            reasoningEffort: { value: 'high', source: 'explicit' },
            mode: { value: 'autonomous', source: 'explicit' },
          },
          status: 'valid',
          invalidReason: null,
        },
      });
      const skills = await app.inject({
        method: 'GET',
        url: `/v1/workspaces/${workspace.id}/agents/${agent.id}/skills`,
        headers: { authorization: `Bearer ${alice.token}` },
      });
      expect(skills.statusCode).toBe(200);
      expect(skills.json()).toMatchObject({
        agentId: agent.id,
        computerId: computer.computerId,
        runtimeId: 'generic-acp',
        runtimeAvailability: 'ready',
        bindingRevision: 1,
        runtimeCatalogRevision: 1,
        items: [expect.objectContaining({ id: 'a'.repeat(64), name: 'team-review', enabled: true })],
      });
    } finally {
      await app.close();
    }
  });
});
