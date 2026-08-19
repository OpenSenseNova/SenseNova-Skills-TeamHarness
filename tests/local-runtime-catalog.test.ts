import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  detectLocalRuntimes,
  discoverLocalRuntimeSkills,
  inspectLocalRuntimeCapabilities,
  requireLocalRuntimeLaunch,
  runtimeCatalogReport,
} from '../src/runtime/local-runtime-catalog.js';
import { AcpRuntimeIntegration } from '../src/runtime/acp-runtime-integration.js';
import { RUNTIME_CATALOG } from '../src/domain/runtime-catalog.js';
import { DomainError } from '../src/lib/errors.js';
import { testRuntimeConfigurationCapabilities } from './helpers.js';

function executable(directory: string, name: string): string {
  mkdirSync(directory, { recursive: true });
  const path = resolve(directory, name);
  writeFileSync(path, '#!/bin/sh\nexit 0\n');
  chmodSync(path, 0o700);
  return path;
}

describe('local Runtime catalog', () => {
  it('exposes the project-managed Codex and Claude ACP adapters as launchable runtimes', () => {
    const detections = detectLocalRuntimes({ PATH: '' }, { includeStandardUserPaths: false });
    expect(requireLocalRuntimeLaunch('codex', detections)).toMatchObject({
      runtimeId: 'codex', command: process.execPath,
    });
    expect(requireLocalRuntimeLaunch('claude', detections)).toMatchObject({
      runtimeId: 'claude', command: process.execPath,
    });
  });

  it('detects local ACP launch commands while reporting no private paths', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'anc-runtime-catalog-'));
    try {
      executable(directory, 'codex');
      executable(directory, 'gemini');
      executable(directory, 'goose');
      executable(directory, 'hermes');
      const detections = detectLocalRuntimes(
        { PATH: directory },
        { includeManagedAdapters: false, includeStandardUserPaths: false },
      );

      expect(detections).toEqual(expect.arrayContaining([
        expect.objectContaining({ runtimeId: 'codex', availability: 'adapter_missing', launch: null }),
        expect.objectContaining({ runtimeId: 'gemini', availability: 'ready' }),
        expect.objectContaining({ runtimeId: 'goose', availability: 'ready' }),
        expect.objectContaining({ runtimeId: 'hermes', availability: 'ready' }),
      ]));
      expect(requireLocalRuntimeLaunch('gemini', detections)).toMatchObject({
        runtimeId: 'gemini', args: ['--acp'],
      });
      expect(() => runtimeCatalogReport(detections)).toThrow(/has not been inspected/i);
      const inspected = detections.map((detection) => detection.availability === 'ready'
        ? { ...detection, configuration: testRuntimeConfigurationCapabilities() }
        : detection);
      const report = runtimeCatalogReport(inspected);
      expect(requireLocalRuntimeLaunch('hermes', detections)).toMatchObject({
        runtimeId: 'hermes', args: ['acp'],
      });
      expect(report.runtimes).toHaveLength(RUNTIME_CATALOG.length);
      expect(JSON.stringify(report)).not.toContain(directory);
      expect(JSON.stringify(report)).not.toContain('command');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('finds Hermes in the standard per-user install directory even when PATH omits it', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'anc-runtime-home-'));
    try {
      const command = executable(resolve(directory, '.local/bin'), 'hermes');
      const detections = detectLocalRuntimes(
        { PATH: '' },
        { includeManagedAdapters: false, userHome: directory },
      );
      expect(requireLocalRuntimeLaunch('hermes', detections)).toEqual({
        runtimeId: 'hermes', command, args: ['acp'],
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('returns installed Codex Skills as sanitized global and workspace metadata', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'anc-runtime-skills-'));
    const workspace = resolve(directory, 'workspace');
    try {
      const globalSkill = resolve(directory, '.codex/skills/research');
      const workspaceSkill = resolve(workspace, '.agents/skills/review');
      mkdirSync(globalSkill, { recursive: true });
      mkdirSync(workspaceSkill, { recursive: true });
      writeFileSync(resolve(globalSkill, 'SKILL.md'), [
        '---',
        'name: research',
        'description: Search and synthesize evidence.',
        'user-invocable: true',
        '---',
        '# Research',
      ].join('\n'));
      writeFileSync(resolve(workspaceSkill, 'SKILL.md'), [
        '---',
        'name: review',
        'description: Review this workspace.',
        '---',
      ].join('\n'));

      const catalog = discoverLocalRuntimeSkills('codex', { CODEX_HOME: resolve(directory, '.codex') }, {
        userHome: directory,
        workspaceDirectory: workspace,
      });
      expect(catalog.global).toEqual([expect.objectContaining({
          name: 'research',
          displayName: 'research',
          description: 'Search and synthesize evidence.',
          source: 'codex_user',
          scope: 'global',
          installed: true,
          enabled: true,
          runtimeCompatible: true,
          version: null,
          userInvocable: true,
          unavailableReason: null,
        })]);
      expect(catalog.global[0]!.id).toMatch(/^[a-f0-9]{64}$/u);
      expect(catalog.global[0]!.revision).toMatch(/^[a-f0-9]{64}$/u);
      expect(catalog.workspace).toEqual([expect.objectContaining({
          name: 'review',
          displayName: 'review',
          description: 'Review this workspace.',
          source: 'workspace_shared',
          scope: 'workspace',
          userInvocable: false,
        })]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('turns ACP session configuration into the sanitized Computer catalog report', async () => {
    const fixture = resolve(process.cwd(), 'tests/fixtures/fake-acp-agent.ts');
    const detections = [
      {
        runtimeId: 'generic-acp',
        availability: 'ready' as const,
        skills: { global: [], workspace: [] },
        launch: {
          runtimeId: 'generic-acp',
          command: process.execPath,
          args: ['--import', import.meta.resolve('tsx'), fixture],
        },
      },
      ...(['codex', 'claude', 'gemini', 'goose', 'hermes'] as const).map((runtimeId) => ({
        runtimeId,
        availability: 'not_installed' as const,
        skills: { global: [], workspace: [] },
        launch: null,
      })),
    ];
    const inspected = await inspectLocalRuntimeCapabilities(detections, new AcpRuntimeIntegration());
    const report = runtimeCatalogReport(inspected);
    expect(report.runtimes.find((runtime) => runtime.runtimeId === 'generic-acp')).toMatchObject({
      availability: 'ready',
      detectedVersion: '1.0.0',
      configuration: {
        defaultModelId: 'fake-default',
        defaultReasoningEffort: 'medium',
        defaultModeId: 'default',
      },
    });
    expect(JSON.stringify(report)).not.toContain(fixture);
    expect(JSON.stringify(report)).not.toContain('command');
  });

  it('reports an ACP protocol mismatch as a structured unavailable reason', async () => {
    const inspected = await inspectLocalRuntimeCapabilities([
      {
        runtimeId: 'generic-acp',
        availability: 'ready',
        skills: { global: [], workspace: [] },
        launch: { runtimeId: 'generic-acp', command: process.execPath, args: [] },
      },
    ], {
      inspectRuntime: async () => {
        throw new Error('inspection failed', {
          cause: new DomainError('ACP_PROTOCOL_VERSION_UNSUPPORTED', 'unsupported', 409),
        });
      },
    });
    expect(inspected[0]).toMatchObject({
      availability: 'unhealthy',
      unavailableReason: {
        code: 'version_unsupported',
        message: 'The Runtime ACP protocol version is not supported.',
      },
    });
  });

  it('loads additional explicit ACP harnesses without allowing them to replace built-ins', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'anc-custom-acp-'));
    try {
      const command = executable(directory, 'team-runtime');
      const detections = detectLocalRuntimes({
        PATH: directory,
        ANC_CUSTOM_ACP_RUNTIMES_JSON: JSON.stringify([
          { runtimeId: 'team-runtime', command, args: ['serve', '--acp'] },
        ]),
      }, { includeManagedAdapters: false, includeStandardUserPaths: false });
      expect(requireLocalRuntimeLaunch('team-runtime', detections)).toEqual({
        runtimeId: 'team-runtime', command, args: ['serve', '--acp'],
      });
      expect(() => detectLocalRuntimes({
        PATH: directory,
        ANC_CUSTOM_ACP_RUNTIMES_JSON: JSON.stringify([{ runtimeId: 'codex', command }]),
      })).toThrow(/replace a built-in/i);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
