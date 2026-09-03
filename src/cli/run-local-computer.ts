#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, openAsBlob, readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname, platform } from 'node:os';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import type {
  AgentInboxWakeBatchView,
} from '../domain/types.js';
import { invariant } from '../lib/errors.js';
import { LocalComputerWorker, type LocalComputerApiRequest } from '../runtime/local-computer-worker.js';
import {
  detectLocalRuntimes,
  inspectLocalRuntimeCapabilities,
  runtimeCatalogReport,
} from '../runtime/local-runtime-catalog.js';
import { AcpRuntimeIntegration } from '../runtime/acp-runtime-integration.js';
import { AttemptWorkspaceManager } from '../runtime/attempt-workspace.js';
import { SqliteDatabase } from '../storage/database.js';
import { LocalExecutionStore } from '../storage/local-execution-store.js';
import {
  acquireLocalComputerDaemonLock,
  LocalComputerServiceManager,
} from './local-computer-service.js';

interface ConnectionConfig {
  serverUrl: string;
  computerToken: string;
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
const agentRoot = resolve(localDataDirectory, 'agents');

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

function requestSignal(daemonSignal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(30_000);
  return daemonSignal ? AbortSignal.any([daemonSignal, timeout]) : timeout;
}

function createApi(config: ConnectionConfig, daemonSignal?: AbortSignal) {
  return async function apiRequest<T>(path: string, request: LocalComputerApiRequest): Promise<T> {
    const response = await fetch(`${config.serverUrl}${path}`, {
      method: request.method,
      headers: {
        authorization: `Bearer ${config.computerToken}`,
        ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(request.idempotencyKey === undefined ? {} : { 'idempotency-key': request.idempotencyKey }),
      },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      signal: requestSignal(daemonSignal),
    });
    if (!response.ok) {
      const body = await response.text();
      let parsed: { error?: { code?: string; message?: string; details?: unknown } } | undefined;
      try { parsed = JSON.parse(body) as typeof parsed; } catch { /* plain-text error */ }
      const error = new Error(parsed?.error?.message ?? `Computer connection request failed (${response.status})` ) as Error & { code?: string; details?: unknown; status?: number };
      if (parsed?.error?.code) error.code = parsed.error.code;
      if (parsed?.error?.details !== undefined) error.details = parsed.error.details;
      error.status = response.status;
      throw error;
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  };
}

function createFileUploadApi(config: ConnectionConfig, daemonSignal?: AbortSignal) {
  return async function uploadFile<T>(
    path: string,
    input: { filePath: string; fileName: string; mediaType: string; fields?: Record<string, string>; idempotencyKey?: string },
  ): Promise<T> {
    const form = new FormData();
    form.append('file', await openAsBlob(input.filePath, { type: input.mediaType }), input.fileName);
    for (const [name, value] of Object.entries(input.fields ?? {})) form.append(name, value);
    const response = await fetch(`${config.serverUrl}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.computerToken}`,
        ...(input.idempotencyKey ? { 'idempotency-key': input.idempotencyKey } : {}),
      },
      body: form,
      signal: requestSignal(daemonSignal),
    });
    if (!response.ok) {
      const body = await response.text();
      let parsed: { error?: { code?: string; message?: string; details?: unknown } } | undefined;
      try { parsed = JSON.parse(body) as typeof parsed; } catch { /* plain-text error */ }
      const error = new Error(parsed?.error?.message ?? `Computer file upload failed (${response.status})`) as Error & { code?: string; details?: unknown; status?: number };
      if (parsed?.error?.code) error.code = parsed.error.code;
      if (parsed?.error?.details !== undefined) error.details = parsed.error.details;
      error.status = response.status;
      throw error;
    }
    return response.json() as Promise<T>;
  };
}

function openLocalState(): {
  database: SqliteDatabase;
  executions: LocalExecutionStore;
} {
  const database = SqliteDatabase.open(resolve(localDataDirectory, 'local-node.sqlite'), 'local-node');
  return {
    database,
    executions: new LocalExecutionStore(database),
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

async function runDaemon(): Promise<void> {
  const releaseLock = acquireLocalComputerDaemonLock(localDataDirectory);
  const daemonController = new AbortController();
  let resolveStop!: () => void;
  const stopRequested = new Promise<void>((resolveStopRequest) => { resolveStop = resolveStopRequest; });
  const stop = (): void => {
    if (daemonController.signal.aborted) return;
    daemonController.abort();
    resolveStop();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let state: ReturnType<typeof openLocalState> | undefined;
  let worker: LocalComputerWorker | undefined;
  const backgroundLoops: Promise<void>[] = [];
  try {
    const config = readConnectionConfig();
    const api = createApi(config, daemonController.signal);
    const uploadFile = createFileUploadApi(config, daemonController.signal);
    state = openLocalState();
    const integration = new AcpRuntimeIntegration();
    let detections = await inspectLocalRuntimeCapabilities(detectLocalRuntimes(), integration);
    if (daemonController.signal.aborted) return;

    const reportRuntimes = async (): Promise<void> => {
      await api('/v1/computers/self/heartbeat', { method: 'POST', body: {} });
      await api('/v1/computers/self/runtime-catalog', { method: 'PUT', body: runtimeCatalogReport(detections) });
      const ready = detections.filter((runtime) => runtime.availability === 'ready').map((runtime) => runtime.runtimeId);
      process.stdout.write(`Computer ${hostname()} connected; ready runtimes: ${ready.join(', ') || 'none'}\n`);
    };
    worker = new LocalComputerWorker({
      api: { request: api, uploadFile },
      localExecutions: state.executions,
      agentRoot,
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
          await worker!.runOnce();
        } while (wakePending && !daemonController.signal.aborted);
      } finally {
        workCycleActive = false;
      }
    };

    const connected = await retryUntilSuccess(async () => {
      await reportRuntimes();
      await runWorkCycle();
    }, 'Local Computer connection', daemonController.signal);
    if (!connected) return;

    const heartbeatLoop = async (): Promise<void> => {
      while (await waitFor(30_000, daemonController.signal)) {
        try {
          await api('/v1/computers/self/heartbeat', { method: 'POST', body: {} });
        } catch (error) {
          if (daemonController.signal.aborted) return;
          process.stderr.write(`Heartbeat failed: ${String(error)}\n`);
        }
      }
    };
    const catalogLoop = async (): Promise<void> => {
      while (await waitFor(5 * 60_000, daemonController.signal)) {
        try {
          detections = await inspectLocalRuntimeCapabilities(detectLocalRuntimes(), integration);
          worker!.updateDetections(detections);
          await reportRuntimes();
        } catch (error) {
          if (daemonController.signal.aborted) return;
          process.stderr.write(`Runtime catalog refresh failed: ${String(error)}\n`);
        }
      }
    };
    let wakeCursor: Record<string, number> = {};
    const wakeLoop = async (): Promise<void> => {
      let retryDelayMs = 2_000;
      while (!daemonController.signal.aborted) {
        try {
          const batch = await api<AgentInboxWakeBatchView>('/v1/computers/self/agent-inbox-wakes', {
            method: 'POST',
            body: { after: wakeCursor },
          });
          wakeCursor = batch.cursor;
          retryDelayMs = 2_000;
          if (batch.events.length > 0) await runWorkCycle();
        } catch (error) {
          if (daemonController.signal.aborted) return;
          process.stderr.write(`Inbox wake failed: ${String(error)}\n`);
          if (!await waitFor(retryDelayMs, daemonController.signal)) return;
          retryDelayMs = Math.min(retryDelayMs * 2, 60_000);
        }
      }
    };
    backgroundLoops.push(heartbeatLoop(), catalogLoop(), wakeLoop());
    await stopRequested;
  } finally {
    daemonController.abort();
    await Promise.allSettled(backgroundLoops);
    await worker?.close();
    state?.database.close();
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    releaseLock();
  }
}

async function retryUntilSuccess(
  operation: () => Promise<void>,
  label: string,
  signal: AbortSignal,
): Promise<boolean> {
  let retryDelayMs = 2_000;
  while (!signal.aborted) {
    try {
      await operation();
      return true;
    } catch (error) {
      if (signal.aborted) return false;
      process.stderr.write(`${label} failed: ${String(error)}\n`);
      if (!await waitFor(retryDelayMs, signal)) return false;
      retryDelayMs = Math.min(retryDelayMs * 2, 60_000);
    }
  }
  return false;
}

function waitFor(milliseconds: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolveWait) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolveWait(true);
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolveWait(false);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function cleanupAttempt(): void {
  const attemptId = requireOption('attempt');
  const state = openLocalState();
  try {
    const execution = state.executions.get(attemptId);
    invariant(execution, 'LOCAL_EXECUTION_NOT_FOUND', 'Local Attempt does not exist.', 404);
    invariant(execution.execution_kind === 'project_scratch' || execution.execution_kind === 'workspace_scratch',
      'PROJECT_ATTEMPT_REQUIRED', 'Only scratch executions can be cleaned up.', 409);
    new AttemptWorkspaceManager().cleanup(execution.attempt_root);
    process.stdout.write(`Removed retained scratch directory for Attempt ${attemptId}.\n`);
  } finally {
    state.database.close();
  }
}

function localComputerServiceManager(): LocalComputerServiceManager {
  const logsDirectory = resolve(localDataDirectory, 'logs');
  return new LocalComputerServiceManager({
    nodePath: process.execPath,
    entryPath: fileURLToPath(import.meta.url),
    workingDirectory: localDataDirectory,
    stdoutPath: resolve(logsDirectory, 'service.stdout.log'),
    stderrPath: resolve(logsDirectory, 'service.stderr.log'),
    pathEnvironment: process.env.PATH?.trim() || '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
  });
}

function manageService(action: string | undefined): void {
  const manager = localComputerServiceManager();
  if (action === 'install') {
    readConnectionConfig();
    manager.install();
  } else if (action === 'start') {
    readConnectionConfig();
    manager.start();
  } else if (action === 'stop') {
    manager.stop();
  } else if (action === 'restart') {
    readConnectionConfig();
    manager.restart();
  } else if (action === 'status') {
    manager.status();
  } else if (action === 'logs') {
    manager.logs();
  } else if (action === 'uninstall') {
    manager.uninstall();
  } else {
    throw new Error('Service action must be install, start, stop, restart, status, logs, or uninstall.');
  }
}

function printUsage(): void {
  process.stdout.write([
    'anc-computer connect --server <url> --token <token>',
    'anc-computer run',
    'anc-computer service install|start|stop|restart|status|logs|uninstall',
    'anc-computer project cleanup --attempt <id>',
    '',
  ].join('\n'));
}

const [command, subcommand] = process.argv.slice(2);
if (command === 'connect') {
  const serverUrl = requireOption('server').replace(/\/$/u, '');
  const computerToken = requireOption('token');
  writeConnectionConfig({ serverUrl, computerToken });
  process.stdout.write(
    `Connection saved to ${configPath}. Run anc-computer service install for login startup, or anc-computer run for foreground use.\n`,
  );
} else if (command === 'run') {
  await runDaemon();
} else if (command === '__service') {
  await runDaemon();
} else if (command === 'service') {
  manageService(subcommand);
} else if (command === 'project' && subcommand === 'cleanup') {
  cleanupAttempt();
} else {
  printUsage();
  if (command !== undefined) process.exitCode = 1;
}
