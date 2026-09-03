import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AcpRuntimeIntegration } from '../src/runtime/acp-runtime-integration.js';
import { runtimeContextProfile } from '../src/runtime/runtime-profiles.js';

describe('runtime integration', () => {
  it('discovers and applies the legacy ACP model selector used by Hermes', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'anc-acp-legacy-model-'));
    const fixture = resolve(process.cwd(), 'tests/fixtures/fake-acp-agent.ts');
    const integration = new AcpRuntimeIntegration();
    const command = process.execPath;
    const args = ['--import', import.meta.resolve('tsx'), fixture];
    const env = { FAKE_ACP_LEGACY_MODELS: '1', FAKE_ACP_ECHO_CONFIG: '1' };
    try {
      const inspected = await integration.inspectRuntime({
        runtimeId: 'hermes', command, args, env, workingDirectory: root,
      });
      expect(inspected.configuration).toMatchObject({
        defaultModelId: 'fake-legacy-default',
        models: expect.arrayContaining([
          expect.objectContaining({ id: 'fake-legacy-pro', label: 'Fake legacy pro' }),
        ]),
      });
      const controller = await integration.openExecution({
        runtimeId: 'hermes', command, args, env,
        executionId: 'attempt-legacy-model',
        executionRoot: root,
        workingDirectory: root,
        executionKind: 'workspace_scratch',
        runtimeConfiguration: { model: 'fake-legacy-pro', reasoningEffort: null, mode: null },
      });
      expect(JSON.parse((await controller.sendInput('initial')).output)).toMatchObject({ model: 'fake-legacy-pro' });
      await controller.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns the ACP Runtime version and configuration options before Agent creation', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'anc-acp-inspect-'));
    const fixture = resolve(process.cwd(), 'tests/fixtures/fake-acp-agent.ts');
    const integration = new AcpRuntimeIntegration();
    try {
      const inspected = await integration.inspectRuntime({
        runtimeId: 'generic-acp',
        command: process.execPath,
        args: ['--import', import.meta.resolve('tsx'), fixture],
        workingDirectory: root,
      });
      expect(inspected).toEqual({
        detectedVersion: '1.0.0',
        configuration: {
          models: [
            {
              id: 'fake-default', label: 'Fake default', description: null,
              supportedReasoningEfforts: ['low', 'medium'],
            },
            {
              id: 'fake-pro', label: 'Fake pro', description: null,
              supportedReasoningEfforts: ['high'],
            },
          ],
          defaultModelId: 'fake-default',
          reasoningEfforts: [
            { id: 'low', label: 'low', description: null },
            { id: 'medium', label: 'medium', description: null },
            { id: 'high', label: 'high', description: null },
          ],
          defaultReasoningEffort: 'medium',
          modes: [
            { id: 'default', label: 'Default', description: null },
            { id: 'autonomous', label: 'Autonomous', description: null },
          ],
          defaultModeId: 'default',
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('applies model, reasoning effort, and mode before the first prompt', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'anc-acp-config-'));
    const fixture = resolve(process.cwd(), 'tests/fixtures/fake-acp-agent.ts');
    const integration = new AcpRuntimeIntegration();
    try {
      const controller = await integration.openExecution({
        runtimeId: 'generic-acp',
        command: process.execPath,
        args: ['--import', import.meta.resolve('tsx'), fixture],
        env: { FAKE_ACP_ECHO_CONFIG: '1' },
        executionId: 'attempt-config',
        executionRoot: root,
        workingDirectory: root,
        executionKind: 'workspace_scratch',
        runtimeConfiguration: { model: 'fake-pro', reasoningEffort: 'high', mode: 'autonomous' },
      });
      expect(JSON.parse((await controller.sendInput('initial')).output)).toEqual({
        model: 'fake-pro', reasoningEffort: 'high', mode: 'autonomous',
      });
      await controller.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps one ACP session open for ordered runtime inputs', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'anc-acp-'));
    const events: string[] = [];
    const fixture = resolve(process.cwd(), 'tests/fixtures/fake-acp-agent.ts');
    const integration = new AcpRuntimeIntegration();
    try {
      const controller = await integration.openExecution({
        runtimeId: 'generic-acp',
        command: process.execPath,
        args: ['--import', import.meta.resolve('tsx'), fixture],
        executionId: 'attempt-1',
        executionRoot: root,
        workingDirectory: root,
        executionKind: 'workspace_scratch',
        runtimeConfiguration: { model: null, reasoningEffort: null, mode: null },
        onEvent: (event) => events.push(event.type),
      });
      expect(controller.sessionId).toBe('fake-session-1');
      expect(await controller.sendInput('initial')).toEqual({ stopReason: 'end_turn', output: 'prompt-1' });
      expect(await controller.sendInput('inbox changed')).toEqual({ stopReason: 'end_turn', output: 'prompt-2' });
      expect(await controller.sendInput('follow-up wake')).toEqual({ stopReason: 'end_turn', output: 'prompt-3' });
      controller.markReturnCommitted();
      expect(events).toContain('context_continuity_unknown');
      await controller.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('projects ACP plans and tool calls into safe human-visible activity', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'anc-acp-activity-'));
    const fixture = resolve(process.cwd(), 'tests/fixtures/fake-acp-agent.ts');
    const activities: Array<{ type: string; title: string; status: string }> = [];
    const integration = new AcpRuntimeIntegration();
    try {
      const controller = await integration.openExecution({
        runtimeId: 'generic-acp',
        command: process.execPath,
        args: ['--import', import.meta.resolve('tsx'), fixture],
        env: { FAKE_ACP_EMIT_ACTIVITY: '1' },
        executionId: 'agent-session-activity',
        executionRoot: root,
        workingDirectory: root,
        executionKind: 'agent_session',
        runtimeConfiguration: { model: null, reasoningEffort: null, mode: null },
        onActivity: (event) => activities.push(event),
      });
      await controller.sendInput('show activity');
      expect(activities.map(({ type, title, status }) => ({ type, title, status }))).toEqual([
        { type: 'plan', title: '计划：检查项目文件', status: 'in_progress' },
        { type: 'thought', title: '正在分析', status: 'in_progress' },
        { type: 'tool', title: '读取项目文件', status: 'in_progress' },
        { type: 'tool', title: '读取项目文件', status: 'completed' },
        { type: 'message', title: '正在组织回复', status: 'in_progress' },
      ]);
      expect(JSON.stringify(activities)).not.toMatch(/private reasoning|private tool output|private\/example/iu);
      await controller.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('loads a prior session as a local replay without publishing Workspace facts', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'anc-acp-load-'));
    const events: string[] = [];
    const fixture = resolve(process.cwd(), 'tests/fixtures/fake-acp-agent.ts');
    const integration = new AcpRuntimeIntegration();
    try {
      const controller = await integration.openExecution({
        runtimeId: 'generic-acp',
        command: process.execPath,
        args: ['--import', import.meta.resolve('tsx'), fixture],
        executionId: 'attempt-load',
        executionRoot: root,
        workingDirectory: root,
        executionKind: 'workspace_scratch',
        priorSessionId: 'fake-session-1',
        runtimeConfiguration: { model: null, reasoningEffort: null, mode: null },
        onEvent: (event) => events.push(event.type),
      });
      expect(controller.sessionId).toBe('fake-session-1');
      expect(events).toContain('context_reloaded');
      await controller.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('cancels an active runtime input through ACP', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'anc-acp-cancel-'));
    const fixture = resolve(process.cwd(), 'tests/fixtures/fake-acp-agent.ts');
    const integration = new AcpRuntimeIntegration();
    let promptReady!: () => void;
    const ready = new Promise<void>((resolveReady) => { promptReady = resolveReady; });
    try {
      const controller = await integration.openExecution({
        runtimeId: 'generic-acp',
        command: process.execPath,
        args: ['--import', import.meta.resolve('tsx'), fixture],
        env: { FAKE_ACP_WAIT_FOR_CANCEL: '1' },
        executionId: 'attempt-cancel',
        executionRoot: root,
        workingDirectory: root,
        executionKind: 'workspace_scratch',
        runtimeConfiguration: { model: null, reasoningEffort: null, mode: null },
        onEvent: (event) => {
          if (event.type === 'context_usage') promptReady();
        },
      });
      await controller.sendInput('initial');
      const pending = controller.sendInput('wait for cancellation');
      await ready;
      await controller.cancel();
      await expect(pending).resolves.toEqual({ stopReason: 'cancelled', output: 'prompt-2' });
      await controller.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when an ACP process emits a corrupt frame', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'anc-acp-corrupt-'));
    const fixture = resolve(process.cwd(), 'tests/fixtures/corrupt-acp-agent.ts');
    const integration = new AcpRuntimeIntegration();
    try {
      await expect(integration.openExecution({
        runtimeId: 'generic-acp',
        command: process.execPath,
        args: ['--import', import.meta.resolve('tsx'), fixture],
        executionId: 'attempt-corrupt',
        executionRoot: root,
        workingDirectory: root,
        executionKind: 'workspace_scratch',
        runtimeConfiguration: { model: null, reasoningEffort: null, mode: null },
      })).rejects.toThrow(/ACP execution failed during launch/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('selects runtime profiles without writing context-control files', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'anc-profiles-'));
    try {
      expect(runtimeContextProfile('unknown-runtime').runtimeId).toBe('generic-acp');
      expect(runtimeContextProfile('codex').normalizeUpdate('attempt-1', {
        sessionUpdate: 'agent_message_chunk',
        _meta: { aiNativeContextEvent: 'context_compaction_completed' },
      })[0]?.type).toBe('context_compaction_completed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
