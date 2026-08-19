import { createHash, randomBytes } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, relative, resolve } from 'node:path';
import type { ArtifactType, RuntimeReturnEnvelope } from '../domain/types.js';
import { invariant } from '../lib/errors.js';

const MAX_RETURN_COMMANDS = 151;
const MAX_FINAL_MESSAGE_BYTES = 100_000;
const MAX_IPC_REQUEST_BYTES = 512_000;

type MessageSendCommand = {
  kind: 'message.send';
  target: string;
  receipt: string;
  messageId: string;
};

type ArtifactPublishCommand = {
  kind: 'artifact.publish';
  filePath: string;
  name: string;
  artifactType: ArtifactType;
  mediaType: string;
  artifactId?: string;
  projectIds: string[];
  expectedCurrentRevision?: number;
  expectedContentDigest?: string;
  attachToFinalMessage: boolean;
  privateGrantIds: string[];
};

type NoOutputCommand = { kind: 'return.no_output'; runId: string };
type WorkspaceReturnCommand = MessageSendCommand | ArtifactPublishCommand | NoOutputCommand;

type InboxCheckCommand = { kind: 'inbox.check' };
type MessageCheckCommand = { kind: 'message.check'; target: string };
type MessageReadCommand = { kind: 'message.read'; target: string; before?: number; after?: number; limit?: number };
type MessageResolveCommand = { kind: 'message.resolve'; messageId: string };
type WorkspaceReadCommand = InboxCheckCommand | MessageCheckCommand | MessageReadCommand | MessageResolveCommand;

export interface WorkspaceAgentGatewayApi {
  request<T>(path: string, request: {
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    body?: unknown;
    idempotencyKey?: string;
  }): Promise<T>;
}

export interface WorkspaceReturnBindingEnvironment {
  env: Record<string, string>;
  instructions: string;
}

export interface StagedArtifactUpload {
  id: string;
}

export type StageArtifactFile = (
  path: string,
  input: { filePath: string; fileName: string; mediaType: string },
) => Promise<StagedArtifactUpload>;

/**
 * Agent-facing Local Computer gateway for bidirectional Workspace operations.
 *
 * Its local capability is fenced to the active Attempt and Binding revision;
 * the persistent Agent ACP session never receives a Computer token or a
 * writable journal path. The Local Computer validates and proxies every call.
 */
export class WorkspaceReturnBinding {
  private readonly outputRoot: string;
  private readonly journalPath: string;
  private readonly binRoot: string;
  private readonly socketPath: string;
  private readonly token = randomBytes(32).toString('hex');
  private readonly commands: WorkspaceReturnCommand[] = [];
  private readonly receipts = new Map<string, string>();
  private server: Server | null = null;
  private prepared = false;
  private terminalCommandRevision = 0;

  constructor(
    private readonly attemptRoot: string,
    private readonly workingDirectory: string,
    private readonly projectId: string | null,
    private readonly agentId: string,
    private readonly runId: string,
    private readonly api: WorkspaceAgentGatewayApi,
  ) {
    this.outputRoot = resolve(attemptRoot, 'output');
    this.journalPath = resolve(this.outputRoot, 'workspace-operations.jsonl');
    this.binRoot = resolve(attemptRoot, 'bin');
    this.socketPath = process.platform === 'win32'
      ? `\\\\.\\pipe\\anc-teamctl-${this.attemptId()}-${randomBytes(8).toString('hex')}`
      : resolve(tmpdir(), `anc-teamctl-${createHash('sha256').update(attemptRoot).digest('hex').slice(0, 24)}.sock`);
  }

  async prepare(): Promise<WorkspaceReturnBindingEnvironment> {
    invariant(!this.prepared, 'TEAMCTL_BINDING_ALREADY_PREPARED', 'Attempt Workspace gateway is already prepared.', 409);
    this.prepared = true;
    mkdirSync(this.outputRoot, { recursive: true, mode: 0o700 });
    mkdirSync(this.binRoot, { recursive: true, mode: 0o700 });
    if (existsSync(this.journalPath)) {
      const lines = readFileSync(this.journalPath, 'utf8').split(/\r?\n/u).filter(Boolean);
      lines.forEach((line, index) => this.commands.push(this.validateCommand(JSON.parse(line) as unknown, index)));
      this.commands.forEach((command) => {
        if (command.kind === 'message.send') this.receipts.set(command.target, command.receipt);
      });
      this.terminalCommandRevision = this.commands.filter((command) => this.isTerminal(command)).length;
    } else {
      writeFileSync(this.journalPath, '', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    }
    const executablePath = resolve(this.binRoot, process.platform === 'win32' ? 'teamctl.mjs' : 'teamctl');
    if (!existsSync(executablePath)) {
      writeFileSync(executablePath, this.cliSource(), { encoding: 'utf8', mode: 0o700, flag: 'wx' });
      if (process.platform !== 'win32') chmodSync(executablePath, 0o700);
    }
    if (process.platform === 'win32') {
      const cmdPath = resolve(this.binRoot, 'teamctl.cmd');
      if (!existsSync(cmdPath)) {
        const node = process.execPath.replaceAll('"', '""');
        writeFileSync(cmdPath, `@"${node}" "%~dp0teamctl.mjs" %*\r\n`, { encoding: 'utf8', mode: 0o700, flag: 'wx' });
      }
    }
    if (process.platform !== 'win32') rmSync(this.socketPath, { force: true });
    this.server = createServer((socket) => this.handleConnection(socket));
    await new Promise<void>((resolveListen, rejectListen) => {
      const server = this.server!;
      const onError = (error: Error): void => rejectListen(error);
      server.once('error', onError);
      server.listen(this.socketPath, () => {
        server.off('error', onError);
        resolveListen();
      });
    });
    return {
      env: {
        PATH: `${this.binRoot}${delimiter}${process.env.PATH ?? ''}`,
        ANC_TEAMCTL_SOCKET: this.socketPath,
        ANC_TEAMCTL_TOKEN: this.token,
        ANC_TEAMCTL_WORK_DIR: realpathSync(this.workingDirectory),
        ...(this.projectId ? { ANC_TEAMCTL_PROJECT_ID: this.projectId } : {}),
      },
      instructions: [
        '## Agent Workspace Gateway',
        '',
        '`teamctl` is available on PATH. It talks to the Local Computer without exposing Computer credentials.',
        '- on every wake, run `teamctl inbox check` first;',
        '- claim a pending scope with `teamctl message check --target <scope>`;',
        '- in that result, `attention` explains why you were woken; read and answer the ordered `discussion.messages` as one conversation input;',
        '- Message bodies appear only in `discussion`; do not answer each attention item separately;',
        '- read older messages only when needed with `teamctl message read --target <scope> [--before <position>|--after <position>]`;',
        '- resolve one referenced message with `teamctl message resolve <message-id>`;',
        '- reply with `teamctl message send --target <scope> --body <text>`; this immediately publishes a normal Conversation Message;',
        '- publish or update deliverables with `teamctl artifact publish --file <work-file> --name <name> --type markdown|file`;',
        '- use `--artifact-id`, `--expected-current-revision` and `--expected-content-digest` when updating an Artifact;',
        `- use teamctl return no-output --run ${this.runId} only when intentionally returning no shared output.`,
        'ACP output text is diagnostic only and is never auto-published.',
      ].join('\n'),
    };
  }

  get terminalRevision(): number {
    return this.terminalCommandRevision;
  }

  get hasTerminalCommand(): boolean {
    return this.terminalCommandRevision > 0;
  }

  async buildEnvelope(
    stageFile: StageArtifactFile,
  ): Promise<RuntimeReturnEnvelope> {
    invariant(this.commands.length > 0, 'RUNTIME_MISSING_FINAL_PUBLICATION',
      'Runtime stopped without an explicit teamctl final publication.', 409);
    const noOutput = this.commands.filter((command): command is NoOutputCommand => command.kind === 'return.no_output');
    if (noOutput.length > 0) {
      invariant(this.commands.length === 1, 'INVALID_WORKSPACE_RETURN_COMMANDS',
        'no-output cannot be combined with Message or Artifact publications.', 409);
      return { disposition: 'no_output', messages: [], artifactPublications: [] };
    }
    const messages = this.commands.filter((command): command is MessageSendCommand => command.kind === 'message.send');
    invariant(messages.length > 0, 'RUNTIME_FINAL_MESSAGE_REQUIRED',
      'Runtime must publish a final Conversation Message.', 409);
    const artifacts = this.commands.filter((command): command is ArtifactPublishCommand => command.kind === 'artifact.publish');
    const artifactPublications: RuntimeReturnEnvelope['artifactPublications'] = [];
    for (const artifact of artifacts) {
      const staged = await stageFile(`/v1/attempts/${this.attemptId()}/staged-blobs`, {
        filePath: artifact.filePath,
        fileName: artifact.name,
        mediaType: artifact.mediaType,
      });
      artifactPublications.push({
        stagedBlobId: staged.id,
        ...(artifact.artifactId ? { artifactId: artifact.artifactId } : {}),
        name: artifact.name,
        artifactType: artifact.artifactType,
        ...(artifact.projectIds.length > 0 ? { projectIds: artifact.projectIds } : {}),
        ...(artifact.expectedCurrentRevision === undefined ? {} : {
          expectedCurrentRevision: artifact.expectedCurrentRevision,
          expectedContentDigest: artifact.expectedContentDigest,
        }),
        ...(artifact.privateGrantIds.length > 0 ? { privateGrantIds: artifact.privateGrantIds } : {}),
      });
    }
    return {
      disposition: 'publish',
      messages: [],
      artifactPublications,
    };
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server?.listening) {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
    if (process.platform !== 'win32') rmSync(this.socketPath, { force: true });
  }

  private handleConnection(socket: Socket): void {
    let body = '';
    let handled = false;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      if (handled) return;
      body += chunk;
      if (Buffer.byteLength(body, 'utf8') > MAX_IPC_REQUEST_BYTES) {
        this.reply(socket, { ok: false, error: 'teamctl request exceeds the IPC limit.' });
        socket.destroy();
        return;
      }
      const newline = body.indexOf('\n');
      if (newline < 0) return;
      handled = true;
      const line = body.slice(0, newline);
      body = '';
      void (async () => {
        const request = JSON.parse(line) as { token?: unknown; command?: unknown };
        invariant(request.token === this.token, 'TEAMCTL_IPC_UNAUTHORIZED', 'teamctl Attempt capability is invalid.', 403);
        const result = await this.executeCommand(request.command);
        this.reply(socket, { ok: true, ...result });
      })().catch((error: unknown) => {
        this.reply(socket, { ok: false, error: error instanceof Error ? error.message : String(error) });
      });
    });
  }

  private async executeCommand(value: unknown): Promise<Record<string, unknown>> {
    invariant(typeof value === 'object' && value !== null, 'INVALID_WORKSPACE_COMMAND',
      'Workspace command must be an object.', 409);
    const raw = value as Record<string, unknown>;
    if (raw.kind === 'inbox.check') {
      const summary = await this.api.request<Record<string, unknown>>(
        `/v1/computers/self/agents/${this.agentId}/inbox`,
        { method: 'GET' },
      );
      return { kind: raw.kind, result: summary };
    }
    if (raw.kind === 'message.check') {
      invariant(typeof raw.target === 'string', 'INVALID_WORKSPACE_COMMAND', 'message check requires target.', 400);
      const scope = this.parseTarget(raw.target);
      const receipt = this.receiptFor(raw.target);
      const claim = await this.api.request<Record<string, unknown>>(
        `/v1/computers/self/agents/${this.agentId}/inbox/claim`,
        {
          method: 'POST',
          body: { attemptId: this.attemptId(), ...scope, receipt },
          idempotencyKey: `claim:${receipt}`,
        },
      );
      this.receipts.set(raw.target, receipt);
      return { kind: raw.kind, result: claim };
    }
    if (raw.kind === 'message.read') {
      invariant(typeof raw.target === 'string', 'INVALID_WORKSPACE_COMMAND', 'message read requires target.', 400);
      const scope = this.parseTarget(raw.target);
      const params = new URLSearchParams({
        attemptId: this.attemptId(),
        conversationId: scope.conversationId,
        ...(scope.threadId ? { threadId: scope.threadId } : {}),
      });
      if (raw.before !== undefined) params.set('before', String(raw.before));
      if (raw.after !== undefined) params.set('after', String(raw.after));
      if (raw.limit !== undefined) params.set('limit', String(raw.limit));
      const history = await this.api.request<Record<string, unknown>>(
        `/v1/computers/self/agents/${this.agentId}/messages?${params.toString()}`,
        { method: 'GET' },
      );
      return { kind: raw.kind, result: history };
    }
    if (raw.kind === 'message.resolve') {
      invariant(typeof raw.messageId === 'string', 'INVALID_WORKSPACE_COMMAND', 'message resolve requires messageId.', 400);
      const target = this.onlyClaimedTarget();
      const scope = this.parseTarget(target);
      const params = new URLSearchParams({
        attemptId: this.attemptId(),
        conversationId: scope.conversationId,
        ...(scope.threadId ? { threadId: scope.threadId } : {}),
      });
      const message = await this.api.request<Record<string, unknown>>(
        `/v1/computers/self/agents/${this.agentId}/messages/${raw.messageId}?${params.toString()}`,
        { method: 'GET' },
      );
      return { kind: raw.kind, result: message };
    }
    if (raw.kind === 'message.send') {
      invariant(typeof raw.target === 'string' && typeof raw.body === 'string' && raw.body.trim().length > 0,
        'INVALID_WORKSPACE_COMMAND', 'message send requires target and non-empty body.', 400);
      invariant(Buffer.byteLength(raw.body, 'utf8') <= MAX_FINAL_MESSAGE_BYTES,
        'INVALID_WORKSPACE_COMMAND', 'Message exceeds the publication limit.', 400);
      const receipt = this.receipts.get(raw.target);
      invariant(receipt, 'INBOX_TARGET_NOT_CLAIMED', 'Run message check for this target before sending.', 409);
      const scope = this.parseTarget(raw.target);
      const message = await this.api.request<{ id: string }>(
        `/v1/computers/self/agents/${this.agentId}/messages`,
        {
          method: 'POST',
          body: { attemptId: this.attemptId(), ...scope, receipt, body: raw.body },
          idempotencyKey: `message-send:${this.attemptId()}:${createHash('sha256').update(`${raw.target}\0${raw.body}`).digest('hex')}`,
        },
      );
      const command: MessageSendCommand = { kind: 'message.send', target: raw.target, receipt, messageId: message.id };
      this.appendCommand(command);
      return { kind: raw.kind, result: message, terminalRevision: this.terminalCommandRevision };
    }
    invariant(this.commands.length < MAX_RETURN_COMMANDS, 'WORKSPACE_RETURN_COMMAND_LIMIT',
      'Runtime exceeded the Workspace operation limit.', 409);
    const command = this.validateCommand(raw, this.commands.length);
    this.appendCommand(command);
    return { kind: command.kind, terminalRevision: this.terminalCommandRevision };
  }

  private appendCommand(command: WorkspaceReturnCommand): void {
    this.commands.push(command);
    appendFileSync(this.journalPath, `${JSON.stringify(command)}\n`, { encoding: 'utf8' });
    if (this.isTerminal(command)) this.terminalCommandRevision += 1;
  }

  private reply(socket: Socket, response: Record<string, unknown>): void {
    if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`);
  }

  private isTerminal(command: WorkspaceReturnCommand): command is MessageSendCommand | NoOutputCommand {
    return command.kind === 'message.send' || command.kind === 'return.no_output';
  }

  private attemptId(): string {
    return this.attemptRoot.split(/[\\/]/u).at(-1)!;
  }

  private parseTarget(target: string): { conversationId: string; threadId: string | null } {
    const match = /^conversation:([^:]+)(?::thread:([^:]+))?$/u.exec(target);
    invariant(match?.[1], 'INVALID_DISCUSSION_TARGET', 'Target must be conversation:<id>[:thread:<id>].', 400);
    return { conversationId: match[1], threadId: match[2] ?? null };
  }

  private receiptFor(target: string): string {
    return `${this.attemptId()}:${createHash('sha256').update(target).digest('hex').slice(0, 32)}`;
  }

  private onlyClaimedTarget(): string {
    invariant(this.receipts.size === 1, 'MESSAGE_TARGET_REQUIRED',
      'Resolve a message after checking exactly one Discussion Scope.', 409);
    return this.receipts.keys().next().value as string;
  }

  private validateCommand(value: unknown, index: number): WorkspaceReturnCommand {
    invariant(typeof value === 'object' && value !== null, 'INVALID_WORKSPACE_RETURN_COMMAND',
      `Workspace operation ${index + 1} must be an object.`, 409);
    const command = value as Record<string, unknown>;
    if (command.kind === 'return.no_output') {
      invariant(command.runId === this.runId, 'INVALID_WORKSPACE_RETURN_COMMAND',
        'no-output must name the active Run.', 409);
      return { kind: 'return.no_output', runId: this.runId };
    }
    if (command.kind === 'message.send') {
      invariant(
        typeof command.target === 'string'
        && typeof command.receipt === 'string'
        && typeof command.messageId === 'string',
        'INVALID_WORKSPACE_RETURN_COMMAND',
        'Persisted Message publication is invalid.',
        409,
      );
      return {
        kind: 'message.send', target: command.target, receipt: command.receipt, messageId: command.messageId,
      };
    }
    invariant(command.kind === 'artifact.publish', 'INVALID_WORKSPACE_RETURN_COMMAND',
      `Workspace operation ${index + 1} has an unsupported kind.`, 409);
    invariant(typeof command.filePath === 'string' && typeof command.name === 'string' && command.name.trim().length > 0,
      'INVALID_WORKSPACE_RETURN_COMMAND', 'Artifact publication requires filePath and name.', 409);
    invariant(command.artifactType === 'markdown' || command.artifactType === 'file',
      'INVALID_WORKSPACE_RETURN_COMMAND', 'Artifact publication type is invalid.', 409);
    invariant(typeof command.mediaType === 'string' && command.mediaType.length > 0,
      'INVALID_WORKSPACE_RETURN_COMMAND', 'Artifact publication media type is required.', 409);
    const filePath = realpathSync(command.filePath);
    const workRoot = realpathSync(this.workingDirectory);
    const relativePath = relative(workRoot, filePath);
    invariant(relativePath !== '..' && !relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`),
      'ARTIFACT_FILE_OUTSIDE_WORKDIR', 'Artifact publication file must be inside the Attempt work directory.', 409);
    const expectedCurrentRevision = command.expectedCurrentRevision;
    invariant(expectedCurrentRevision === undefined
      || (Number.isSafeInteger(expectedCurrentRevision) && Number(expectedCurrentRevision) >= 0),
    'INVALID_WORKSPACE_RETURN_COMMAND', 'Artifact expectedCurrentRevision is invalid.', 409);
    const expectedContentDigest = typeof command.expectedContentDigest === 'string'
      ? command.expectedContentDigest
      : undefined;
    invariant(expectedContentDigest === undefined || /^[a-f0-9]{64}$/u.test(expectedContentDigest),
      'INVALID_WORKSPACE_RETURN_COMMAND', 'Artifact expectedContentDigest is invalid.', 409);
    invariant((expectedCurrentRevision === undefined) === (expectedContentDigest === undefined),
      'INVALID_WORKSPACE_RETURN_COMMAND', 'Artifact current revision and content digest must be supplied together.', 409);
    return {
      kind: 'artifact.publish',
      filePath,
      name: command.name,
      artifactType: command.artifactType,
      mediaType: command.mediaType,
      ...(typeof command.artifactId === 'string' ? { artifactId: command.artifactId } : {}),
      projectIds: this.stringArray(command.projectIds, 'projectIds'),
      ...(expectedCurrentRevision === undefined ? {} : {
        expectedCurrentRevision: Number(expectedCurrentRevision),
        expectedContentDigest: expectedContentDigest!,
      }),
      attachToFinalMessage: command.attachToFinalMessage === true,
      privateGrantIds: this.stringArray(command.privateGrantIds, 'privateGrantIds'),
    };
  }

  private stringArray(value: unknown, name: string): string[] {
    invariant(value === undefined || (Array.isArray(value) && value.every((entry) => typeof entry === 'string')),
      'INVALID_WORKSPACE_RETURN_COMMAND', `${name} must be a string array.`, 409);
    return [...new Set((value ?? []) as string[])];
  }

  private cliSource(): string {
    return `#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { createConnection } from 'node:net';
import { relative } from 'node:path';
const args = process.argv.slice(2);
const socketPath = process.env.ANC_TEAMCTL_SOCKET;
const token = process.env.ANC_TEAMCTL_TOKEN;
const workRoot = process.env.ANC_TEAMCTL_WORK_DIR;
if (!socketPath || !token || !workRoot) throw new Error('teamctl is not bound to an active Attempt.');
const values = (name) => {
  const found = [];
  for (let i = 0; i < args.length; i += 1) if (args[i] === '--' + name) found.push(args[i + 1]);
  return found.filter((value) => typeof value === 'string');
};
const value = (name) => values(name).at(-1);
const required = (name) => {
  const found = value(name);
  if (!found) throw new Error('--' + name + ' is required.');
  return found;
};
const send = (command) => new Promise((resolveSend, rejectSend) => {
  const socket = createConnection(socketPath);
  let response = '';
  socket.setEncoding('utf8');
  socket.on('connect', () => socket.write(JSON.stringify({ token, command }) + '\\n'));
  socket.on('data', (chunk) => { response += chunk; });
  socket.on('error', rejectSend);
  socket.on('end', () => {
    try {
      const result = JSON.parse(response.trim());
      if (!result.ok) throw new Error(result.error || 'Workspace operation failed.');
      process.stdout.write(JSON.stringify(result) + '\\n');
      resolveSend();
    } catch (error) { rejectSend(error); }
  });
});
let command;
if (args[0] === 'inbox' && args[1] === 'check') {
  command = { kind: 'inbox.check' };
} else if (args[0] === 'message' && args[1] === 'check') {
  command = { kind: 'message.check', target: required('target') };
} else if (args[0] === 'message' && args[1] === 'read') {
  const before = value('before');
  const after = value('after');
  if (before && after) throw new Error('--before and --after cannot be used together.');
  command = {
    kind: 'message.read', target: required('target'),
    ...(before ? { before: Number(before) } : {}),
    ...(after ? { after: Number(after) } : {}),
    ...(value('limit') ? { limit: Number(value('limit')) } : {}),
  };
} else if (args[0] === 'message' && args[1] === 'resolve') {
  if (!args[2] || args[2].startsWith('--')) throw new Error('message resolve requires a Message ID.');
  command = { kind: 'message.resolve', messageId: args[2] };
} else if (args[0] === 'return' && args[1] === 'no-output') {
  command = { kind: 'return.no_output', runId: required('run') };
} else if (args[0] === 'message' && args[1] === 'send') {
  const bodyFile = value('body-file');
  const body = value('body') ?? (bodyFile ? readFileSync(realpathSync(bodyFile), 'utf8') : '');
  if (!body.trim()) throw new Error('--body or --body-file is required.');
  command = { kind: 'message.send', target: required('target'), body };
} else if (args[0] === 'artifact' && args[1] === 'publish') {
  const filePath = realpathSync(required('file'));
  const rel = relative(realpathSync(workRoot), filePath);
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\\\')) {
    throw new Error('Artifact file must be inside the Attempt work directory.');
  }
  const artifactType = required('type');
  if (artifactType !== 'markdown' && artifactType !== 'file') throw new Error('--type must be markdown or file.');
  const artifactId = value('artifact-id');
  if (artifactId && value('expected-current-revision') === undefined) {
    throw new Error('Updating an Artifact requires --expected-current-revision.');
  }
  if (artifactId && value('expected-content-digest') === undefined) {
    throw new Error('Updating an Artifact requires --expected-content-digest.');
  }
  const explicitProjects = values('project-id');
  const projectIds = explicitProjects.length > 0
    ? explicitProjects
    : (process.env.ANC_TEAMCTL_PROJECT_ID ? [process.env.ANC_TEAMCTL_PROJECT_ID] : []);
  command = {
    kind: 'artifact.publish', filePath, name: required('name'), artifactType,
    mediaType: value('media-type') ?? (artifactType === 'markdown' ? 'text/markdown; charset=utf-8' : 'application/octet-stream'),
    ...(artifactId ? { artifactId } : {}), projectIds,
    ...(artifactId ? {
      expectedCurrentRevision: Number(required('expected-current-revision')),
      expectedContentDigest: required('expected-content-digest'),
    } : {}),
    attachToFinalMessage: args.includes('--attach-to-final-message'),
    privateGrantIds: values('private-grant-id'),
  };
} else {
  process.stderr.write('Usage:\\n  teamctl inbox check\\n  teamctl message check --target <scope>\\n  teamctl message read --target <scope> [--before <position>|--after <position>]\\n  teamctl message resolve <message-id>\\n  teamctl message send --target <scope> --body <text>\\n  teamctl artifact publish --file <path> --name <name> --type markdown|file [baseline options]\\n  teamctl return no-output --run <run-id>\\n');
  process.exit(2);
}
await send(command);
`;
  }
}
