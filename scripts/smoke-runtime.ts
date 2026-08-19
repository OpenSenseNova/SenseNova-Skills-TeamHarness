import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { AcpRuntimeIntegration } from '../src/runtime/acp-runtime-integration.js';
import { canonicalJson, sha256 } from '../src/lib/values.js';
import { localAttemptPermissionDecision } from '../src/runtime/local-attempt-permissions.js';
import { WorkspaceReturnBinding } from '../src/runtime/workspace-return-binding.js';
import type { RuntimeLaunchSpec } from '../src/runtime/runtime-integration.js';

const supportedRuntimeIds = new Set(['codex', 'claude', 'gemini', 'goose', 'hermes']);
const runtimeId = process.argv[2];
if (!runtimeId || !supportedRuntimeIds.has(runtimeId)) {
  throw new Error('Usage: npm run smoke:<codex|claude|gemini|goose|hermes>');
}

const command = process.env.ANC_RUNTIME_COMMAND?.trim();
if (!command) {
  throw new Error('Set ANC_RUNTIME_COMMAND to this Runtime\'s ACP v1 stdio command. No command is inferred from runtimeId.');
}

let args: string[] = [];
if (process.env.ANC_RUNTIME_ARGS_JSON) {
  const value: unknown = JSON.parse(process.env.ANC_RUNTIME_ARGS_JSON);
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error('ANC_RUNTIME_ARGS_JSON must be a JSON array of strings.');
  }
  args = value;
}

let runtimeConfiguration: RuntimeLaunchSpec['runtimeConfiguration'] = {
  model: null,
  reasoningEffort: null,
  mode: null,
};
if (process.env.ANC_RUNTIME_CONFIGURATION_JSON) {
  const value: unknown = JSON.parse(process.env.ANC_RUNTIME_CONFIGURATION_JSON);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('ANC_RUNTIME_CONFIGURATION_JSON must be a JSON object.');
  }
  const configuration = value as Record<string, unknown>;
  const efforts = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  if (
    !(configuration.model === null || typeof configuration.model === 'string')
    || !(configuration.reasoningEffort === null || efforts.has(String(configuration.reasoningEffort)))
    || !(configuration.mode === null || typeof configuration.mode === 'string')
  ) {
    throw new Error('ANC_RUNTIME_CONFIGURATION_JSON contains an invalid model, reasoningEffort, or mode.');
  }
  runtimeConfiguration = configuration as RuntimeLaunchSpec['runtimeConfiguration'];
}

const attemptRoot = mkdtempSync(resolve(tmpdir(), `anc-${runtimeId}-smoke-`));
const workingDirectory = resolve(attemptRoot, 'work');
const inputRoot = resolve(attemptRoot, 'input');
const sharedRoot = resolve(inputRoot, 'shared');
const marker = `reloadable-source:${runtimeId}:smoke`;
mkdirSync(workingDirectory, { recursive: true, mode: 0o700 });
const returnBinding = new WorkspaceReturnBinding(attemptRoot, workingDirectory, null);
const boundReturn = await returnBinding.prepare();
const instructions = [
  '# Immutable smoke instructions',
  '',
  'Read the Context Manifest and every listed source.',
  'Do not access files outside this isolated Attempt root.',
  '',
  boundReturn.instructions,
].join('\n');
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
mkdirSync(sharedRoot, { recursive: true, mode: 0o700 });
writeFileSync(resolve(inputRoot, 'runtime-instructions.md'), instructions, { mode: 0o600 });
writeFileSync(resolve(sharedRoot, 'smoke-source.md'), marker, { mode: 0o600 });

const manifestBody = {
  schemaVersion: 3,
  workspaceId: 'smoke-workspace',
  agentId: 'smoke-agent',
  runId: 'smoke-run',
  attemptId: 'smoke-attempt',
  snapshots: {
    runContextSnapshotId: 'smoke-run-context',
    initialContextSnapshotId: 'smoke-initial-context',
  },
  runtimeInstructions: {
    relativePath: 'runtime-instructions.md',
    mediaType: 'text/markdown; charset=utf-8',
    byteLength: Buffer.byteLength(instructions),
    digest: digest(instructions),
  },
  entries: [
    {
      source: {
        kind: 'conversation', sourceId: 'smoke-reloadable', sourceVersion: '1', sourceOrder: 0,
        contentDigest: digest(marker), metadata: { smoke: true },
      },
      relativePath: 'shared/smoke-source.md', mediaType: 'text/markdown; charset=utf-8',
      byteLength: Buffer.byteLength(marker), digest: digest(marker), visibility: 'shared',
      deliveryClass: 'reloadable', continuityClass: 'immutable',
    },
  ],
};
writeFileSync(resolve(inputRoot, 'context-manifest.json'), canonicalJson({
  ...manifestBody,
  manifestDigest: sha256(canonicalJson(manifestBody)),
}), { mode: 0o600 });

const events: string[] = [];
const startedAt = Date.now();
const integration = new AcpRuntimeIntegration();
let controller: Awaited<ReturnType<AcpRuntimeIntegration['openExecution']>> | undefined;
try {
  controller = await integration.openExecution({
    runtimeId,
    command,
    args,
    attemptId: 'smoke-attempt',
    attemptRoot,
    workingDirectory,
    executionKind: 'workspace_scratch',
    env: boundReturn.env,
    runtimeConfiguration,
    onEvent: (event) => events.push(event.type),
    requestPermission: async (request) => localAttemptPermissionDecision(request),
  });
  const initial = await controller.sendInput([
    `Smoke test: read ${resolve(inputRoot, 'context-manifest.json')}, the runtime invariant, and the reloadable source.`,
    'Do not publish externally. Finish this turn after reading them.',
  ].join('\n'));
  if (returnBinding.hasTerminalCommand) {
    throw new Error('Runtime published before the Addendum smoke input.');
  }
  const addendum = await controller.sendInput([
    'This is an ordered Addendum smoke input in the same ACP session.',
    'Run `teamctl return no-output` now, then finish this turn.',
  ].join('\n'));
  const envelope = await returnBinding.buildEnvelope(1, async () => {
    throw new Error('The no-output smoke return must not stage an Artifact.');
  });
  controller.markReturnCommitted();
  const result = {
    runtimeId,
    command: basename(command),
    passed: true,
    initialStopReason: initial.stopReason,
    addendumStopReason: addendum.stopReason,
    returnDisposition: envelope.disposition,
    capabilities: controller.capabilities,
    contextEvents: [...new Set(events)],
    runtimeConfiguration,
    durationMs: Date.now() - startedAt,
    completedAt: new Date().toISOString(),
  };
  const outputPath = resolve(process.env.ANC_SMOKE_OUTPUT
    ?? `artifacts/runtime-smoke/${runtimeId}-${Date.now()}.json`);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${outputPath}\n`);
} finally {
  await controller?.close();
  await returnBinding.close();
  rmSync(attemptRoot, { recursive: true, force: true });
}
