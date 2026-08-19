#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, openAsBlob, readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname, platform } from 'node:os';
import { basename, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type {
  AgentInboxWakeBatchView,
  ProjectRepositoryView,
  ProjectView,
  ProjectWorkingCopyReport,
} from '../domain/types.js';
import { invariant } from '../lib/errors.js';
import { LocalComputerWorker, type LocalComputerApiRequest } from '../runtime/local-computer-worker.js';
import {
  detectLocalRuntimes,
  inspectLocalRuntimeCapabilities,
  runtimeCatalogReport,
} from '../runtime/local-runtime-catalog.js';
import { AcpRuntimeIntegration } from '../runtime/acp-runtime-integration.js';
import {
  AttemptWorkspaceManager,
  cloneGitRepository,
  inspectGitWorkingCopy,
  ProjectWorkingCopyStore,
  workingCopyReport,
} from '../runtime/project-working-copy.js';
import { SqliteDatabase } from '../storage/database.js';
import { LocalExecutionStore } from '../storage/local-execution-store.js';

interface ConnectionConfig {
  serverUrl: string;
  computerToken: string;
}

interface RepositoryEnvelope {
  projectId: string;
  workspaceId: string;
  repository: ProjectRepositoryView;
}

function defaultLocalDataDirectory(): string {
  if (platform() === 'darwin') {
    return resolve(homedir(), 'Library', 'Application Support', 'AI Native Collaboration', 'Local Computer');
  }
  if (platform() === 'win32') {
    return resolve(
      process.env.LOCALAPPDATA?.trim() || resolve(homedir(), 'AppData', 'Local'),
      'AI Native Collaboration',
      'Local Computer',
    );
  }
  return resolve(
    process.env.XDG_STATE_HOME?.trim() || resolve(homedir(), '.local', 'state'),
    'ai-native-collaboration',
    'local-computer',
  );
}

const localDataDirectory = resolve(process.env.ANC_LOCAL_DATA_DIR?.trim() || defaultLocalDataDirectory());
const configPath = resolve(localDataDirectory, 'connection.json');
const attemptRoot = resolve(localDataDirectory, 'attempts');

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requireOption(name: string): string {
  const value = option(name)?.trim();
  invariant(value, 'CLI_OPTION_REQUIRED', `--${name} is required.`);
  return value;
}

function writeConnectionConfig(config: ConnectionConfig): void {
  mkdirSync(localDataDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(configPath, 0o600);
}

function readConnectionConfig(): ConnectionConfig {
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as Partial<ConnectionConfig>;
    invariant(parsed.serverUrl && parsed.computerToken, 'COMPUTER_NOT_CONNECTED',
      'Run anc-computer connect --server <url> --token <token> first.');
    return { serverUrl: parsed.serverUrl, computerToken: parsed.computerToken };
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new Error('Computer is not connected. Run anc-computer connect --server <url> --token <token> first.');
    }
    throw error;
  }
}

function createApi(config: ConnectionConfig) {
  return async function apiRequest<T>(path: string, request: LocalComputerApiRequest): Promise<T> {
    const response = await fetch(`${config.serverUrl}${path}`, {
      method: request.method,
      headers: {
        authorization: `Bearer ${config.computerToken}`,
        ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(request.idempotencyKey === undefined ? {} : { 'idempotency-key': request.idempotencyKey }),
      },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Computer connection request failed (${response.status}): ${body.slice(0, 1000)}`);
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  };
}

function createFileUploadApi(config: ConnectionConfig) {
  return async function uploadFile<T>(
    path: string,
    input: { filePath: string; fileName: string; mediaType: string },
  ): Promise<T> {
    const form = new FormData();
    form.append('file', await openAsBlob(input.filePath, { type: input.mediaType }), input.fileName);
    const response = await fetch(`${config.serverUrl}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.computerToken}` },
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Computer file upload failed (${response.status}): ${body.slice(0, 1000)}`);
    }
    return response.json() as Promise<T>;
  };
}

function openLocalState(): {
  database: SqliteDatabase;
  executions: LocalExecutionStore;
  workingCopies: ProjectWorkingCopyStore;
} {
  const database = SqliteDatabase.open(resolve(localDataDirectory, 'local-node.sqlite'), 'local-node');
  return {
    database,
    executions: new LocalExecutionStore(database),
    workingCopies: new ProjectWorkingCopyStore(database),
  };
}

async function promptValue(label: string, current?: string): Promise<string> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await terminal.question(`${label}${current ? ` [${current}]` : ''}: `)).trim();
    return answer || current || '';
  } finally {
    terminal.close();
  }
}

async function bindWorkingCopy(
  api: ReturnType<typeof createApi>,
  workingCopies: ProjectWorkingCopyStore,
  projectId: string,
  inputPath: string,
): Promise<void> {
  const descriptor = await api<RepositoryEnvelope>(`/v1/computers/self/projects/${projectId}/repository`, { method: 'GET' });
  const inspected = inspectGitWorkingCopy(inputPath);
  const report = workingCopyReport(descriptor.repository.id, descriptor.repository.repositoryIdentity, inspected);
  invariant(report.availability === 'ready', 'PROJECT_REPOSITORY_MISMATCH',
    `Local Repository ${inspected.repositoryIdentity} does not match ${descriptor.repository.repositoryIdentity}.`, 409);
  workingCopies.bind({
    project_id: projectId,
    workspace_id: descriptor.workspaceId,
    repository_id: descriptor.repository.id,
    repository_identity: descriptor.repository.repositoryIdentity,
    absolute_path: inspected.absolutePath,
  });
  await api(`/v1/computers/self/projects/${projectId}/working-copy`, {
    method: 'PUT',
    body: report,
    idempotencyKey: randomUUID(),
  });
  process.stdout.write(`Project ${projectId} is connected to ${inspected.absolutePath}.\n`);
}

async function reportWorkingCopies(
  api: ReturnType<typeof createApi>,
  workingCopies: ProjectWorkingCopyStore,
): Promise<void> {
  for (const binding of workingCopies.list()) {
    let report: ProjectWorkingCopyReport;
    try {
      report = workingCopyReport(
        binding.repository_id,
        binding.repository_identity,
        inspectGitWorkingCopy(binding.absolute_path),
      );
      workingCopies.touch(binding.project_id);
    } catch {
      report = {
        repositoryId: binding.repository_id,
        repositoryIdentity: binding.repository_identity,
        availability: 'unavailable',
        branch: null,
        headCommit: null,
        dirty: null,
      };
    }
    await api(`/v1/computers/self/projects/${binding.project_id}/working-copy`, {
      method: 'PUT',
      body: report,
      idempotencyKey: randomUUID(),
    });
  }
}

async function runDaemon(): Promise<void> {
  const config = readConnectionConfig();
  const api = createApi(config);
  const uploadFile = createFileUploadApi(config);
  const state = openLocalState();
  const integration = new AcpRuntimeIntegration();
  let detections = await inspectLocalRuntimeCapabilities(detectLocalRuntimes(), integration);

  const reportRuntimes = async (): Promise<void> => {
    await api('/v1/computers/self/runtime-catalog', { method: 'PUT', body: runtimeCatalogReport(detections) });
    await reportWorkingCopies(api, state.workingCopies);
    const ready = detections.filter((runtime) => runtime.availability === 'ready').map((runtime) => runtime.runtimeId);
    process.stdout.write(`Computer ${hostname()} connected; ready runtimes: ${ready.join(', ') || 'none'}\n`);
  };
  const worker = new LocalComputerWorker({
    api: { request: api, uploadFile },
    localExecutions: state.executions,
    attemptRoot,
    detections,
    integration,
    onLog: (message) => process.stdout.write(`${message}\n`),
  });
  let workCycleActive = false;
  let wakePending = false;
  const runWorkCycle = async (): Promise<void> => {
    if (workCycleActive) {
      wakePending = true;
      return;
    }
    workCycleActive = true;
    try {
      do {
        wakePending = false;
        await worker.runOnce();
      } while (wakePending);
    } finally {
      workCycleActive = false;
    }
  };

  await reportRuntimes();
  await runWorkCycle();
  const heartbeatTimer = setInterval(() => {
    void (async () => {
      await api('/v1/computers/self/heartbeat', { method: 'POST', body: {} });
      await reportWorkingCopies(api, state.workingCopies);
    })().catch((error: unknown) => process.stderr.write(`${String(error)}\n`));
  }, 30_000);
  const catalogTimer = setInterval(() => {
    void (async () => {
      detections = await inspectLocalRuntimeCapabilities(detectLocalRuntimes(), integration);
      worker.updateDetections(detections);
      await reportRuntimes();
    })().catch((error: unknown) => process.stderr.write(`${String(error)}\n`));
  }, 5 * 60_000);
  let stopped = false;
  let wakeCursor: Record<string, number> = {};
  const wakeLoop = async (): Promise<void> => {
    while (!stopped) {
      try {
        const batch = await api<AgentInboxWakeBatchView>('/v1/computers/self/agent-inbox-wakes', {
          method: 'POST',
          body: { after: wakeCursor },
        });
        wakeCursor = batch.cursor;
        if (!stopped && batch.events.length > 0) await runWorkCycle();
      } catch (error) {
        if (stopped) return;
        process.stderr.write(`${String(error)}\n`);
        await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 2_000));
      }
    }
  };
  void wakeLoop();
  const stop = (): void => {
    stopped = true;
    clearInterval(heartbeatTimer);
    clearInterval(catalogTimer);
    state.database.close();
    process.exitCode = 0;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

async function createLocalProject(): Promise<void> {
  const workspaceId = requireOption('workspace');
  const config = readConnectionConfig();
  const api = createApi(config);
  const inputPath = option('path') ?? await promptValue('Local Git checkout');
  const inspected = inspectGitWorkingCopy(inputPath);
  const name = option('name') ?? await promptValue('Project name', basename(inspected.absolutePath));
  const description = option('description') ?? await promptValue('Description (optional)');
  const project = await api<ProjectView>('/v1/computers/self/projects', {
    method: 'POST',
    body: {
      workspaceId,
      name,
      description: description || null,
      repository: {
        cloneUrl: inspected.cloneUrl,
        repositoryIdentity: inspected.repositoryIdentity,
        defaultBranch: inspected.defaultBranch,
      },
      workingCopy: {
        repositoryIdentity: inspected.repositoryIdentity,
        availability: 'ready',
        branch: inspected.branch,
        headCommit: inspected.headCommit,
        dirty: inspected.dirty,
      },
    },
    idempotencyKey: randomUUID(),
  });
  invariant(project.repository, 'PROJECT_REPOSITORY_NOT_FOUND', 'Created Project has no Repository.');
  const state = openLocalState();
  try {
    state.workingCopies.bind({
      project_id: project.id,
      workspace_id: project.workspaceId,
      repository_id: project.repository.id,
      repository_identity: project.repository.repositoryIdentity,
      absolute_path: inspected.absolutePath,
    });
  } finally {
    state.database.close();
  }
  process.stdout.write(`Created Project ${project.name} (${project.id}) from ${inspected.repositoryIdentity}.\n`);
}

async function bindLocalProject(): Promise<void> {
  const projectId = requireOption('project');
  const inputPath = option('path') ?? await promptValue('Local Git checkout');
  const api = createApi(readConnectionConfig());
  const state = openLocalState();
  try {
    await bindWorkingCopy(api, state.workingCopies, projectId, inputPath);
  } finally {
    state.database.close();
  }
}

async function cloneLocalProject(): Promise<void> {
  const projectId = requireOption('project');
  const api = createApi(readConnectionConfig());
  const descriptor = await api<RepositoryEnvelope>(`/v1/computers/self/projects/${projectId}/repository`, { method: 'GET' });
  const suggested = resolve(process.cwd(), descriptor.repository.repositoryIdentity.split('/').at(-1) ?? projectId);
  const destination = option('destination') ?? await promptValue('Clone destination', suggested);
  cloneGitRepository(descriptor.repository.cloneUrl, descriptor.repository.defaultBranch, destination);
  const state = openLocalState();
  try {
    await bindWorkingCopy(api, state.workingCopies, projectId, destination);
  } finally {
    state.database.close();
  }
}

function cleanupAttempt(): void {
  const attemptId = requireOption('attempt');
  const state = openLocalState();
  try {
    const execution = state.executions.get(attemptId);
    invariant(execution, 'LOCAL_EXECUTION_NOT_FOUND', 'Local Attempt does not exist.', 404);
    invariant(execution.execution_kind === 'project_repository' && execution.project_id,
      'PROJECT_ATTEMPT_REQUIRED', 'Only Project worktrees require explicit Git cleanup.', 409);
    new AttemptWorkspaceManager(state.workingCopies).cleanup(execution.project_id, execution.attempt_root);
    process.stdout.write(`Removed retained worktree for Attempt ${attemptId}.\n`);
  } finally {
    state.database.close();
  }
}

function printUsage(): void {
  process.stdout.write([
    'anc-computer connect --server <url> --token <token>',
    'anc-computer run',
    'anc-computer project create --workspace <id> [--path <checkout>] [--name <name>]',
    'anc-computer project bind --project <id> [--path <checkout>]',
    'anc-computer project clone --project <id> [--destination <directory>]',
    'anc-computer project cleanup --attempt <id>',
    '',
  ].join('\n'));
}

const [command, subcommand] = process.argv.slice(2);
if (command === 'connect') {
  const serverUrl = requireOption('server').replace(/\/$/u, '');
  const computerToken = requireOption('token');
  writeConnectionConfig({ serverUrl, computerToken });
  process.stdout.write(`Connection saved to ${configPath}. You can now run anc-computer run from any directory.\n`);
} else if (command === 'run') {
  await runDaemon();
} else if (command === 'project' && subcommand === 'create') {
  await createLocalProject();
} else if (command === 'project' && subcommand === 'bind') {
  await bindLocalProject();
} else if (command === 'project' && subcommand === 'clone') {
  await cloneLocalProject();
} else if (command === 'project' && subcommand === 'cleanup') {
  cleanupAttempt();
} else {
  printUsage();
  if (command !== undefined) process.exitCode = 1;
}
