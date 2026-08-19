import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Readable, Transform, Writable } from 'node:stream';
import {
  PROTOCOL_VERSION,
  client,
  methods,
  ndJsonStream,
  type ClientConnection,
  type ClientContext,
  type LoadSessionResponse,
  type NewSessionResponse,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionId,
  type SessionModeState,
} from '@agentclientprotocol/sdk';
import { invariant } from '../lib/errors.js';
import { runtimeContextProfile } from './runtime-profiles.js';
import type {
  RuntimeContextCapabilities,
  RuntimeExecutionController,
  RuntimeInspectionResult,
  RuntimeInspectionSpec,
  RuntimeIntegration,
  RuntimeLaunchSpec,
} from './runtime-integration.js';
import type { ReasoningEffort, RuntimeConfigurationOption } from '../domain/types.js';

interface PromptState {
  active: boolean;
  cancelled: boolean;
  output: string;
}

interface RuntimeSessionState {
  configOptions?: SessionConfigOption[] | null;
  modes?: SessionModeState | null;
  models?: {
    currentModelId: string;
    availableModels: Array<{
      modelId: string;
      name?: string | null;
      description?: string | null;
    }>;
  } | null;
}

const MAX_ACP_FRAME_BYTES = 16 * 1024 * 1024;

function acpFrameGuard(): Transform {
  let pending = Buffer.alloc(0);
  const validate = (line: Buffer): void => {
    if (line.byteLength === 0) return;
    invariant(line.byteLength <= MAX_ACP_FRAME_BYTES, 'ACP_FRAME_TOO_LARGE', 'ACP frame exceeds the transport limit.', 409);
    const text = line.toString('utf8').trim();
    if (text.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('ACP process emitted an invalid newline-delimited JSON frame.');
    }
    invariant((typeof parsed === 'object' && parsed !== null) || Array.isArray(parsed),
      'ACP_FRAME_INVALID', 'ACP frames must be JSON objects or batches.', 409);
  };
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        pending = Buffer.concat([pending, chunk]);
        invariant(pending.byteLength <= MAX_ACP_FRAME_BYTES || pending.includes(0x0a),
          'ACP_FRAME_TOO_LARGE', 'ACP frame exceeds the transport limit.', 409);
        let newline = pending.indexOf(0x0a);
        while (newline >= 0) {
          validate(pending.subarray(0, newline));
          pending = pending.subarray(newline + 1);
          newline = pending.indexOf(0x0a);
        }
        invariant(pending.byteLength <= MAX_ACP_FRAME_BYTES,
          'ACP_FRAME_TOO_LARGE', 'ACP frame exceeds the transport limit.', 409);
        callback(null, chunk);
      } catch (error) {
        callback(error as Error);
      }
    },
    flush(callback) {
      try {
        validate(pending);
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
  });
}

export class AcpRuntimeIntegration implements RuntimeIntegration {
  async inspectRuntime(spec: RuntimeInspectionSpec): Promise<RuntimeInspectionResult> {
    const child = spawn(spec.command, spec.args, {
      cwd: spec.workingDirectory,
      env: { ...process.env, ...spec.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const guardedStdout = child.stdout.pipe(acpFrameGuard());
    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(guardedStdout) as ReadableStream<Uint8Array>,
    );
    const connection = client({ name: 'ai-native-collaboration-runtime-inspector' }).connect(stream);
    const context = connection.agent;
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-16_384); });
    const timeoutMs = spec.timeoutMs ?? 15_000;
    const timeout = <T>(operation: Promise<T>, label: string): Promise<T> => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)), timeoutMs);
      operation.then(
        (value) => { clearTimeout(timer); resolve(value); },
        (error: unknown) => { clearTimeout(timer); reject(error); },
      );
    });
    try {
      const initialized = await timeout(context.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: 'ai-native-collaboration', version: '1.0.0' },
      }), 'ACP initialize');
      invariant(initialized.protocolVersion === PROTOCOL_VERSION, 'ACP_PROTOCOL_VERSION_UNSUPPORTED',
        `ACP Agent negotiated unsupported protocol version ${initialized.protocolVersion}.`, 409);
      invariant(initialized.agentCapabilities?.loadSession === true, 'ACP_LOAD_SESSION_UNAVAILABLE',
        'ACP Runtime cannot preserve one persistent session per Agent because it does not advertise session/load.', 409);
      const session = await timeout(context.request<NewSessionResponse & RuntimeSessionState>(
        methods.agent.session.new,
        { cwd: spec.workingDirectory, mcpServers: [] },
      ), 'ACP session/new');
      return {
        detectedVersion: initialized.agentInfo?.version ?? null,
        configuration: this.configurationCapabilities(session),
      };
    } catch (error) {
      throw new Error(`ACP Runtime capability inspection failed${stderr ? `: ${stderr}` : ''}`, { cause: error });
    } finally {
      connection.close();
      child.kill('SIGTERM');
    }
  }

  async openExecution(spec: RuntimeLaunchSpec): Promise<RuntimeExecutionController> {
    const profile = runtimeContextProfile(spec.runtimeId);
    const child = spawn(spec.command, spec.args, {
      cwd: spec.workingDirectory,
      env: { ...process.env, ...spec.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const guardedStdout = child.stdout.pipe(acpFrameGuard());
    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(guardedStdout) as ReadableStream<Uint8Array>,
    );
    const promptState: PromptState = { active: false, cancelled: false, output: '' };
    let replaying = false;
    const app = client({ name: 'ai-native-collaboration-local-agent' })
      .onRequest(methods.client.session.requestPermission, async ({ params }) => {
        if (promptState.cancelled) return { outcome: { outcome: 'cancelled' } };
        const decision = await spec.requestPermission?.(params) ?? 'reject';
        if (decision === 'cancelled') return { outcome: { outcome: 'cancelled' } };
        const requestedKind = decision === 'reject' ? 'reject_once' : decision;
        const option = params.options.find((candidate) => candidate.optionId === decision)
          ?? params.options.find((candidate) => candidate.kind === requestedKind);
        invariant(option, 'ACP_PERMISSION_OPTION_UNAVAILABLE', 'Requested permission decision is not offered by the ACP Agent.', 409);
        return { outcome: { outcome: 'selected', optionId: option.optionId } } satisfies RequestPermissionResponse;
      })
      .onNotification(methods.client.session.update, ({ params }) => {
        const update = params.update as Record<string, unknown>;
        const content = update.content as Record<string, unknown> | undefined;
        if (
          promptState.active
          && update.sessionUpdate === 'agent_message_chunk'
          && content?.type === 'text'
          && typeof content.text === 'string'
        ) {
          promptState.output += content.text;
        }
        for (const event of profile.normalizeUpdate(spec.attemptId, params.update)) {
          spec.onEvent?.(event);
        }
        if (replaying) {
          spec.onEvent?.({
            type: 'context_reloaded',
            attemptId: spec.attemptId,
            details: { sessionId: params.sessionId, localViewOnly: true },
            createdAt: Date.now(),
          });
        }
      });
    const connection = app.connect(stream);
    const context = connection.agent;
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-16_384); });
    try {
      const initialized = await context.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: 'ai-native-collaboration', version: '1.0.0' },
      });
      invariant(initialized.protocolVersion === PROTOCOL_VERSION, 'ACP_PROTOCOL_VERSION_UNSUPPORTED',
        `ACP Agent negotiated unsupported protocol version ${initialized.protocolVersion}.`, 409);
      let sessionId: SessionId;
      let sessionState: RuntimeSessionState;
      if (spec.priorSessionId !== undefined) {
        invariant(initialized.agentCapabilities?.loadSession === true, 'ACP_LOAD_SESSION_UNAVAILABLE',
          'ACP Agent does not advertise session/load.', 409);
        replaying = true;
        sessionState = await context.request<LoadSessionResponse & RuntimeSessionState>(methods.agent.session.load, {
          sessionId: spec.priorSessionId,
          cwd: spec.workingDirectory,
          mcpServers: spec.mcpServers ?? [],
        });
        replaying = false;
        sessionId = spec.priorSessionId;
      } else {
        const created = await context.request<NewSessionResponse & RuntimeSessionState>(methods.agent.session.new, {
          cwd: spec.workingDirectory,
          mcpServers: spec.mcpServers ?? [],
        });
        sessionId = created.sessionId;
        sessionState = created;
      }
      await this.applyRuntimeConfiguration(context, sessionId, sessionState, spec.runtimeConfiguration);
      const capabilities: RuntimeContextCapabilities = {
        protocol: 'acp-v1',
        prompt: true,
        mcpStdio: true,
        loadSession: initialized.agentCapabilities?.loadSession === true,
        resumeSession: initialized.agentCapabilities?.sessionCapabilities?.resume !== undefined,
        ...profile.capabilities,
      };
      if (capabilities.invariantContinuity === 'opaque') {
        spec.onEvent?.({
          type: 'context_continuity_unknown', attemptId: spec.attemptId,
          details: { runtimeId: spec.runtimeId }, createdAt: Date.now(),
        });
      }
      return new AcpExecutionController(
        spec, child, connection, context, sessionId, capabilities, promptState, () => stderr,
      );
    } catch (error) {
      connection.close(error);
      child.kill('SIGTERM');
      throw new Error(`ACP execution failed during launch${stderr ? `: ${stderr}` : ''}`, { cause: error });
    }
  }

  private async applyRuntimeConfiguration(
    context: ClientContext,
    sessionId: SessionId,
    state: RuntimeSessionState,
    configuration: RuntimeLaunchSpec['runtimeConfiguration'],
  ): Promise<void> {
    if (configuration.model !== null) {
      const option = this.findConfigOption(state.configOptions, ['model'], 'model');
      if (option) {
        this.requireSelectValue(option, configuration.model);
        await context.request(methods.agent.session.setConfigOption, {
          sessionId, configId: option.id, value: configuration.model,
        });
      } else {
        invariant(
          state.models?.availableModels.some((model) => model.modelId === configuration.model),
          'RUNTIME_MODEL_UNSUPPORTED',
          'The selected Runtime does not expose this model through ACP.',
          409,
        );
        await context.request('session/set_model', { sessionId, modelId: configuration.model });
      }
    }
    if (configuration.reasoningEffort !== null) {
      const option = this.findConfigOption(
        state.configOptions,
        ['reasoning_effort', 'reasoningEffort', 'thinking_effort', 'thinkingEffort'],
        'thought_level',
      );
      invariant(option, 'RUNTIME_REASONING_EFFORT_UNSUPPORTED',
        'The selected Runtime does not expose a reasoning-effort control.', 409);
      this.requireSelectValue(option, configuration.reasoningEffort);
      await context.request(methods.agent.session.setConfigOption, {
        sessionId, configId: option.id, value: configuration.reasoningEffort,
      });
    }
    if (configuration.mode !== null) {
      const modes = state.modes?.availableModes ?? [];
      invariant(modes.some((mode) => mode.id === configuration.mode),
        'RUNTIME_MODE_UNAVAILABLE', `Runtime does not offer mode ${configuration.mode}.`, 409);
      await context.request(methods.agent.session.setMode, { sessionId, modeId: configuration.mode });
    }
  }

  private findConfigOption(
    options: SessionConfigOption[] | null | undefined,
    ids: string[],
    category: string,
  ): SessionConfigOption | undefined {
    return options?.find((option) => ids.includes(option.id))
      ?? options?.find((option) => option.category === category);
  }

  private requireSelectValue(option: SessionConfigOption, value: string): void {
    invariant(option.type === 'select', 'RUNTIME_CONFIG_TYPE_UNSUPPORTED',
      `Runtime configuration ${option.id} is not a select control.`, 409);
    const values = option.options.flatMap((candidate) => (
      'group' in candidate ? candidate.options.map((nested) => nested.value) : [candidate.value]
    ));
    invariant(values.includes(value), 'RUNTIME_CONFIG_VALUE_UNAVAILABLE',
      `Runtime configuration ${option.id} does not offer ${value}.`, 409);
  }

  private configurationCapabilities(state: RuntimeSessionState) {
    const modelOption = this.findConfigOption(state.configOptions, ['model'], 'model');
    const reasoningOption = this.findConfigOption(
      state.configOptions,
      ['reasoning_effort', 'reasoningEffort', 'thinking_effort', 'thinkingEffort'],
      'thought_level',
    );
    const stableModels = this.selectOptions(modelOption).map((option) => ({
      ...option,
      supportedReasoningEfforts: null,
    }));
    const legacyModels = (state.models?.availableModels ?? []).map((model) => ({
      id: model.modelId,
      label: model.name?.trim() || model.modelId,
      description: model.description?.trim() || null,
      supportedReasoningEfforts: null,
    }));
    const models = stableModels.length > 0 ? stableModels : legacyModels;
    const validEfforts = new Set<ReasoningEffort>([
      'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
    ]);
    const reasoningEfforts = this.selectOptions(reasoningOption)
      .filter((option): option is RuntimeConfigurationOption & { id: ReasoningEffort } => validEfforts.has(option.id as ReasoningEffort));
    const modes = (state.modes?.availableModes ?? []).map((mode) => ({
      id: mode.id,
      label: mode.name,
      description: mode.description ?? null,
    }));
    const defaultModelId = modelOption?.type === 'select'
      && models.some((option) => option.id === modelOption.currentValue)
      ? modelOption.currentValue
      : state.models && models.some((option) => option.id === state.models!.currentModelId)
        ? state.models.currentModelId
        : null;
    const defaultReasoningEffort = reasoningOption?.type === 'select'
      && validEfforts.has(reasoningOption.currentValue as ReasoningEffort)
      && reasoningEfforts.some((option) => option.id === reasoningOption.currentValue)
      ? reasoningOption.currentValue as ReasoningEffort
      : null;
    const defaultModeId = state.modes
      && modes.some((mode) => mode.id === state.modes!.currentModeId)
      ? state.modes.currentModeId
      : null;
    return {
      models,
      defaultModelId,
      reasoningEfforts,
      defaultReasoningEffort,
      modes,
      defaultModeId,
    };
  }

  private selectOptions(option: SessionConfigOption | undefined): RuntimeConfigurationOption[] {
    if (!option || option.type !== 'select') return [];
    return option.options.flatMap((candidate) => (
      'group' in candidate ? candidate.options : [candidate]
    )).map((candidate) => ({
      id: candidate.value,
      label: candidate.name,
      description: candidate.description ?? null,
    }));
  }
}

class AcpExecutionController implements RuntimeExecutionController {
  private returnCommitted = false;
  private promptQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly spec: RuntimeLaunchSpec,
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly connection: ClientConnection,
    private readonly context: ClientContext,
    readonly sessionId: string,
    readonly capabilities: RuntimeContextCapabilities,
    private readonly promptState: PromptState,
    private readonly stderr: () => string,
  ) {}

  get runtimeId(): string { return this.spec.runtimeId; }

  sendInput(prompt: string): Promise<{ stopReason: string; output: string }> {
    invariant(prompt.trim().length > 0, 'ACP_PROMPT_REQUIRED', 'Runtime input may not be empty.', 409);
    invariant(!this.returnCommitted, 'RUNTIME_RETURN_ALREADY_COMMITTED', 'Runtime return is already committed.', 409);
    const operation = this.promptQueue.then(async () => {
      invariant(!this.returnCommitted, 'RUNTIME_RETURN_ALREADY_COMMITTED', 'Runtime return is already committed.', 409);
      this.promptState.active = true;
      this.promptState.cancelled = false;
      this.promptState.output = '';
      try {
        const response = await this.context.request(methods.agent.session.prompt, {
          sessionId: this.sessionId,
          prompt: [{ type: 'text', text: prompt }],
        });
        return { stopReason: response.stopReason, output: this.promptState.output.trim() };
      } catch (error) {
        throw new Error(`ACP Runtime input failed${this.stderr() ? `: ${this.stderr()}` : ''}`, { cause: error });
      } finally {
        this.promptState.active = false;
      }
    });
    this.promptQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async cancel(): Promise<void> {
    this.promptState.cancelled = true;
    await this.context.notify(methods.agent.session.cancel, { sessionId: this.sessionId });
  }

  markReturnCommitted(): void {
    invariant(!this.returnCommitted, 'RUNTIME_RETURN_ALREADY_COMMITTED', 'Runtime return was already committed.', 409);
    this.returnCommitted = true;
  }

  async close(): Promise<void> {
    this.connection.close();
    if (this.child.exitCode === null) {
      this.child.kill('SIGTERM');
    }
    await Promise.race([
      new Promise<void>((resolveClose) => this.child.once('close', () => resolveClose())),
      new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 5_000)),
    ]);
    if (this.child.exitCode === null) this.child.kill('SIGKILL');
  }
}
