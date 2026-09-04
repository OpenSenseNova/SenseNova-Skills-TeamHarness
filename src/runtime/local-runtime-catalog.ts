import {
  accessSync,
  constants,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, resolve } from 'node:path';
import { RUNTIME_CATALOG } from '../domain/runtime-catalog.js';
import type {
  RuntimeAvailability,
  RuntimeCapabilityReport,
  RuntimeId,
  RuntimeSkillCatalog,
  RuntimeSkillSummary,
} from '../domain/types.js';
import { invariant } from '../lib/errors.js';
import type { RuntimeIntegration } from './runtime-integration.js';

export interface LocalRuntimeLaunchDescriptor {
  runtimeId: RuntimeId;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface LocalRuntimeDetection extends RuntimeCapabilityReport {
  launch: LocalRuntimeLaunchDescriptor | null;
}

const EMPTY_SKILL_CATALOG: RuntimeSkillCatalog = Object.freeze({ global: [], workspace: [] });
const MAX_SKILL_FILE_BYTES = 64 * 1024;
const MAX_SKILLS_PER_SCOPE = 2_000;

interface SkillRoot {
  path: string;
  source: string;
}

function parseSkillSummary(
  runtimeId: RuntimeId,
  scope: RuntimeSkillSummary['scope'],
  name: string,
  content: string,
  source: string,
): RuntimeSkillSummary {
  const summary: RuntimeSkillSummary = {
    id: createHash('sha256').update(`${runtimeId}\0${scope}\0${source}\0${name}`).digest('hex'),
    name,
    displayName: name,
    description: '',
    source,
    scope,
    installed: true,
    enabled: true,
    runtimeCompatible: true,
    version: null,
    revision: createHash('sha256').update(content).digest('hex'),
    userInvocable: false,
    unavailableReason: null,
  };
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u)?.[1];
  if (!frontmatter) return summary;
  for (const line of frontmatter.split(/\r?\n/u)) {
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^(['"])(.*)\1$/u, '$2');
    if (key === 'name' && value) summary.displayName = value.slice(0, 200);
    if (key === 'description') summary.description = value.slice(0, 2_000);
    if (key === 'version' && value) summary.version = value.slice(0, 120);
    if (key === 'user-invocable' || key === 'userInvocable') summary.userInvocable = value === 'true';
  }
  return summary;
}

function scanSkillRoot(
  runtimeId: RuntimeId,
  scope: RuntimeSkillSummary['scope'],
  root: SkillRoot,
): RuntimeSkillSummary[] {
  let entries;
  try {
    entries = readdirSync(root.path, { withFileTypes: true });
  } catch {
    return [];
  }
  const skills: RuntimeSkillSummary[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (skills.length >= MAX_SKILLS_PER_SCOPE) break;
    let skillName: string;
    let skillFile: string;
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      skillName = entry.name;
      skillFile = resolve(root.path, entry.name, 'SKILL.md');
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      skillName = entry.name.slice(0, -3);
      skillFile = resolve(root.path, entry.name);
    } else {
      continue;
    }
    try {
      const stat = lstatSync(skillFile);
      if (!stat.isFile() || stat.size > MAX_SKILL_FILE_BYTES) continue;
      skills.push(parseSkillSummary(runtimeId, scope, skillName, readFileSync(skillFile, 'utf8'), root.source));
    } catch {
      // A missing, unreadable, or malformed entry is not an installed Skill.
    }
  }
  return skills;
}

function deduplicateSkills(skills: RuntimeSkillSummary[]): RuntimeSkillSummary[] {
  const names = new Set<string>();
  return skills.filter((skill) => {
    if (names.has(skill.name)) return false;
    names.add(skill.name);
    return true;
  });
}

export function discoverLocalRuntimeSkills(
  runtimeId: RuntimeId,
  environment: NodeJS.ProcessEnv = process.env,
  options: { userHome?: string; workspaceDirectory?: string } = {},
): RuntimeSkillCatalog {
  const userHome = options.userHome ?? homedir();
  const codexHome = environment.CODEX_HOME?.trim() || resolve(userHome, '.codex');
  const globalRoots: SkillRoot[] = runtimeId === 'codex'
    ? [
        { path: resolve(codexHome, 'skills'), source: 'codex_user' },
        { path: resolve(codexHome, 'skills/.system'), source: 'codex_system' },
        { path: resolve(userHome, '.agents/skills'), source: 'agent_shared' },
      ]
    : runtimeId === 'claude'
      ? [
          { path: resolve(userHome, '.claude/skills'), source: 'claude_user' },
          { path: resolve(userHome, '.claude/commands'), source: 'claude_command' },
        ]
      : [];
  const workspaceRoot = options.workspaceDirectory;
  const workspaceRoots: SkillRoot[] = !workspaceRoot
    ? []
    : runtimeId === 'codex'
      ? [
          { path: resolve(workspaceRoot, '.codex/skills'), source: 'workspace_codex' },
          { path: resolve(workspaceRoot, '.agents/skills'), source: 'workspace_shared' },
        ]
      : runtimeId === 'claude'
        ? [
            { path: resolve(workspaceRoot, '.claude/skills'), source: 'workspace_claude' },
            { path: resolve(workspaceRoot, '.claude/commands'), source: 'workspace_command' },
          ]
        : [];
  return {
    global: deduplicateSkills(globalRoots.flatMap((root) => scanSkillRoot(runtimeId, 'global', root))),
    workspace: deduplicateSkills(workspaceRoots.flatMap((root) => scanSkillRoot(runtimeId, 'workspace', root))),
  };
}

interface LocalRuntimeDefinition {
  runtimeId: RuntimeId;
  commands: string[];
  args: string[];
  underlyingCommands?: string[];
  missingLaunchAvailability?: RuntimeAvailability;
  managedAdapter?: { packageName: string; binName: string };
}

const LOCAL_RUNTIME_DEFINITIONS: readonly LocalRuntimeDefinition[] = [
  {
    runtimeId: 'codex',
    commands: ['codex-acp'],
    args: [],
    underlyingCommands: ['codex'],
    missingLaunchAvailability: 'adapter_missing',
    managedAdapter: { packageName: '@agentclientprotocol/codex-acp', binName: 'codex-acp' },
  },
  {
    runtimeId: 'claude',
    commands: ['claude-agent-acp', 'claude-code-acp'],
    args: [],
    underlyingCommands: ['claude'],
    missingLaunchAvailability: 'adapter_missing',
    managedAdapter: { packageName: '@agentclientprotocol/claude-agent-acp', binName: 'claude-agent-acp' },
  },
  { runtimeId: 'gemini', commands: ['gemini'], args: ['--acp'] },
  { runtimeId: 'goose', commands: ['goose'], args: ['acp'] },
  { runtimeId: 'hermes', commands: ['hermes'], args: ['acp'] },
] as const;

function executableSuffixes(): string[] {
  if (process.platform !== 'win32') return [''];
  return (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
    .split(';')
    .filter(Boolean)
    .map((suffix) => suffix.toLowerCase());
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveExecutable(command: string, searchPath = process.env.PATH ?? ''): string | null {
  const trimmed = command.trim();
  if (!trimmed) return null;
  if (isAbsolute(trimmed) || trimmed.includes('/') || trimmed.includes('\\')) {
    return isExecutable(resolve(trimmed)) ? resolve(trimmed) : null;
  }
  const suffixes = executableSuffixes();
  for (const directory of searchPath.split(delimiter).filter(Boolean)) {
    for (const suffix of suffixes) {
      const candidate = resolve(directory, process.platform === 'win32' ? `${trimmed}${suffix}` : trimmed);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

function firstExecutable(commands: string[], searchPath: string): string | null {
  for (const command of commands) {
    const executable = resolveExecutable(command, searchPath);
    if (executable) return executable;
  }
  return null;
}

function runtimeSearchPath(
  environment: NodeJS.ProcessEnv,
  options: { includeStandardUserPaths?: boolean; userHome?: string },
): string {
  const directories = (environment.PATH ?? '').split(delimiter).filter(Boolean);
  if (options.includeStandardUserPaths !== false) {
    const userHome = options.userHome ?? homedir();
    directories.push(
      resolve(userHome, '.local/bin'),
      resolve(userHome, 'bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
    );
  }
  return [...new Set(directories)].join(delimiter);
}

function managedAdapterEntry(adapter: { packageName: string; binName: string }): string | null {
  try {
    const require = createRequire(import.meta.url);
    const packageJsonPath = require.resolve(`${adapter.packageName}/package.json`);
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      bin?: string | Record<string, string>;
    };
    const relativeEntry = typeof packageJson.bin === 'string'
      ? packageJson.bin
      : packageJson.bin?.[adapter.binName];
    if (!relativeEntry) return null;
    const entry = resolve(dirname(packageJsonPath), relativeEntry);
    accessSync(entry, constants.F_OK);
    return entry;
  } catch {
    return null;
  }
}

function genericAcpDetection(environment: NodeJS.ProcessEnv, searchPath: string): LocalRuntimeDetection {
  const configuredCommand = environment.ANC_GENERIC_ACP_COMMAND?.trim();
  if (!configuredCommand) {
    return { runtimeId: 'generic-acp', availability: 'not_installed', skills: EMPTY_SKILL_CATALOG, launch: null };
  }
  const executable = resolveExecutable(configuredCommand, searchPath);
  if (!executable) {
    return { runtimeId: 'generic-acp', availability: 'unhealthy', skills: EMPTY_SKILL_CATALOG, launch: null };
  }
  let args: string[] = [];
  if (environment.ANC_GENERIC_ACP_ARGS_JSON) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(environment.ANC_GENERIC_ACP_ARGS_JSON);
    } catch {
      throw new Error('ANC_GENERIC_ACP_ARGS_JSON must be valid JSON.');
    }
    invariant(
      Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string'),
      'INVALID_GENERIC_ACP_ARGS',
      'ANC_GENERIC_ACP_ARGS_JSON must be a JSON array of strings.',
    );
    args = parsed;
  }
  return {
    runtimeId: 'generic-acp',
    availability: 'ready',
    skills: EMPTY_SKILL_CATALOG,
    launch: { runtimeId: 'generic-acp', command: executable, args },
  };
}

function customAcpDetections(environment: NodeJS.ProcessEnv, searchPath: string): LocalRuntimeDetection[] {
  const raw = environment.ANC_CUSTOM_ACP_RUNTIMES_JSON?.trim();
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('ANC_CUSTOM_ACP_RUNTIMES_JSON must be valid JSON.');
  }
  invariant(Array.isArray(parsed), 'INVALID_CUSTOM_RUNTIME_CATALOG',
    'ANC_CUSTOM_ACP_RUNTIMES_JSON must be an array.');
  const reserved = new Set(RUNTIME_CATALOG.map((runtime) => runtime.id));
  const ids = new Set<string>();
  return parsed.map((entry) => {
    invariant(typeof entry === 'object' && entry !== null, 'INVALID_CUSTOM_RUNTIME',
      'Each custom ACP Runtime must be an object.');
    const value = entry as { runtimeId?: unknown; command?: unknown; args?: unknown };
    invariant(typeof value.runtimeId === 'string' && /^[a-z0-9._-]{1,80}$/u.test(value.runtimeId),
      'INVALID_CUSTOM_RUNTIME_ID', 'Custom Runtime runtimeId is invalid.');
    invariant(!reserved.has(value.runtimeId) && !ids.has(value.runtimeId), 'DUPLICATE_CUSTOM_RUNTIME_ID',
      'Custom Runtime runtimeId must be unique and may not replace a built-in Runtime.');
    invariant(typeof value.command === 'string' && value.command.trim().length > 0,
      'INVALID_CUSTOM_RUNTIME_COMMAND', 'Custom Runtime command is required.');
    invariant(value.args === undefined || (Array.isArray(value.args) && value.args.every((arg) => typeof arg === 'string')),
      'INVALID_CUSTOM_RUNTIME_ARGS', 'Custom Runtime args must be an array of strings.');
    ids.add(value.runtimeId);
    const command = resolveExecutable(value.command, searchPath);
    return command
      ? {
          runtimeId: value.runtimeId,
          availability: 'ready' as const,
          skills: EMPTY_SKILL_CATALOG,
          launch: { runtimeId: value.runtimeId, command, args: [...(value.args as string[] | undefined ?? [])] },
        }
      : { runtimeId: value.runtimeId, availability: 'unhealthy' as const, skills: EMPTY_SKILL_CATALOG, launch: null };
  });
}

/**
 * Detects launchable ACP runtimes from the Local Agent process environment.
 * Absolute executable paths remain in the local descriptor and are never part
 * of the report sent to Workspace Authority.
 */
export function detectLocalRuntimes(
  environment: NodeJS.ProcessEnv = process.env,
  options: {
    includeManagedAdapters?: boolean;
    includeStandardUserPaths?: boolean;
    userHome?: string;
    workspaceDirectory?: string;
  } = {},
): LocalRuntimeDetection[] {
  const searchPath = runtimeSearchPath(environment, options);
  const detections = new Map<RuntimeId, LocalRuntimeDetection>();
  for (const definition of LOCAL_RUNTIME_DEFINITIONS) {
    const executable = firstExecutable(definition.commands, searchPath);
    const managedEntry = options.includeManagedAdapters === false || !definition.managedAdapter
      ? null
      : managedAdapterEntry(definition.managedAdapter);
    if (executable || managedEntry) {
      detections.set(definition.runtimeId, {
        runtimeId: definition.runtimeId,
        availability: 'ready',
        skills: discoverLocalRuntimeSkills(definition.runtimeId, environment, options),
        launch: executable
          ? {
              runtimeId: definition.runtimeId,
              command: executable,
              args: [...definition.args],
            }
          : {
              runtimeId: definition.runtimeId,
              command: process.execPath,
              args: [managedEntry!, ...definition.args],
            },
      });
      continue;
    }
    const underlyingInstalled = definition.underlyingCommands
      ? firstExecutable(definition.underlyingCommands, searchPath) !== null
      : false;
    detections.set(definition.runtimeId, {
      runtimeId: definition.runtimeId,
      availability: underlyingInstalled
        ? (definition.missingLaunchAvailability ?? 'unhealthy')
        : 'not_installed',
      skills: discoverLocalRuntimeSkills(definition.runtimeId, environment, options),
      launch: null,
    });
  }
  const builtIns: LocalRuntimeDetection[] = RUNTIME_CATALOG.map((runtime) => detections.get(runtime.id) ?? {
    runtimeId: runtime.id,
    availability: 'not_installed' as const,
    skills: discoverLocalRuntimeSkills(runtime.id, environment, options),
    launch: null,
  });
  return [
    ...builtIns,
    ...customAcpDetections(environment, searchPath).sort((left, right) => left.runtimeId.localeCompare(right.runtimeId)),
  ];
}

export function runtimeCatalogReport(detections: LocalRuntimeDetection[]): {
  runtimes: RuntimeCapabilityReport[];
} {
  return {
    runtimes: detections.map(({ runtimeId, availability, detectedVersion, configuration, skills, unavailableReason }) => {
      invariant(
        availability !== 'ready' || configuration !== undefined,
        'RUNTIME_CAPABILITY_NOT_INSPECTED',
        `Runtime ${runtimeId} is launchable but its ACP configuration has not been inspected.`,
      );
      return {
        runtimeId,
        availability,
        skills,
        ...(detectedVersion ? { detectedVersion } : {}),
        ...(configuration ? { configuration } : {}),
        ...(unavailableReason ? { unavailableReason } : {
          ...(availability === 'ready' ? {} : { unavailableReason: defaultUnavailableReason(availability) }),
        }),
      };
    }),
  };
}

export async function inspectLocalRuntimeCapabilities(
  detections: LocalRuntimeDetection[],
  integration: Pick<RuntimeIntegration, 'inspectRuntime'>,
): Promise<LocalRuntimeDetection[]> {
  return Promise.all(detections.map(async (detection) => {
    if (detection.availability !== 'ready' || !detection.launch) {
      const { configuration: _configuration, ...withoutConfiguration } = detection;
      return {
        ...withoutConfiguration,
        unavailableReason: detection.unavailableReason
          ?? defaultUnavailableReason(detection.availability as Exclude<RuntimeAvailability, 'ready'>),
      };
    }
    const workingDirectory = mkdtempSync(resolve(tmpdir(), `anc-${safeRuntimeId(detection.runtimeId)}-probe-`));
    const {
      configuration: _configuration,
      unavailableReason: _unavailableReason,
      ...detectionIdentity
    } = detection;
    try {
      const inspected = await integration.inspectRuntime({
        ...detection.launch,
        workingDirectory,
      });
      return {
        ...detectionIdentity,
        ...(inspected.detectedVersion
          ? { detectedVersion: inspected.detectedVersion }
          : detection.detectedVersion ? { detectedVersion: detection.detectedVersion } : {}),
        configuration: inspected.configuration,
      };
    } catch (error) {
      return {
        ...detectionIdentity,
        availability: 'unhealthy' as const,
        unavailableReason: inspectionUnavailableReason(error),
      };
    } finally {
      rmSync(workingDirectory, { recursive: true, force: true });
    }
  }));
}

function safeRuntimeId(runtimeId: string): string {
  return runtimeId.replace(/[^a-z0-9._-]/gu, '-').slice(0, 40) || 'runtime';
}

function defaultUnavailableReason(availability: Exclude<RuntimeAvailability, 'ready'>) {
  switch (availability) {
    case 'not_installed':
      return { code: 'not_installed' as const, message: 'The Runtime is not installed on this Computer.' };
    case 'adapter_missing':
      return { code: 'adapter_missing' as const, message: 'The Runtime is installed but its ACP adapter is missing.' };
    case 'unauthenticated':
      return { code: 'unauthenticated' as const, message: 'The Runtime is not authenticated on this Computer.' };
    case 'unhealthy':
      return { code: 'runtime_unhealthy' as const, message: 'The Runtime is installed but is not healthy.' };
  }
}

function inspectionUnavailableReason(error: unknown) {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    const code = (current as Error & { code?: unknown }).code;
    if (code === 'ACP_PROTOCOL_VERSION_UNSUPPORTED') {
      return {
        code: 'version_unsupported' as const,
        message: 'The Runtime ACP protocol version is not supported.',
      };
    }
    current = current.cause;
  }
  return {
    code: 'capability_probe_failed' as const,
    message: 'The Runtime did not complete ACP capability discovery.',
  };
}

export function requireLocalRuntimeLaunch(
  runtimeId: RuntimeId,
  detections = detectLocalRuntimes(),
): LocalRuntimeLaunchDescriptor {
  const detection = detections.find((runtime) => runtime.runtimeId === runtimeId);
  invariant(
    detection?.availability === 'ready' && detection.launch,
    'LOCAL_RUNTIME_UNAVAILABLE',
    `Runtime ${runtimeId} is not launchable on this Computer.`,
    409,
  );
  return detection.launch;
}
