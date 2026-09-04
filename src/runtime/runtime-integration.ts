import type {
  ReasoningEffort,
  RuntimeConfigurationCapabilities,
} from '../domain/types.js';

export type RuntimeContextEventType =
  | 'context_usage'
  | 'context_compaction_started'
  | 'context_compaction_completed'
  | 'context_reloaded'
  | 'context_continuity_unknown';

export interface RuntimeContextEvent {
  type: RuntimeContextEventType;
  executionId: string;
  details: Record<string, unknown>;
  createdAt: number;
}

export interface RuntimeActivityEvent {
  type: 'thought' | 'tool' | 'plan' | 'message';
  title: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  createdAt: number;
}

export interface RuntimeContextCapabilities {
  protocol: 'acp-v1';
  prompt: boolean;
  mcpStdio: boolean;
  loadSession: boolean;
  resumeSession: boolean;
  compaction: 'observable' | 'opaque';
  invariantContinuity: 'profile_reloaded' | 'opaque';
}

export interface RuntimeLaunchSpec {
  runtimeId: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  executionId: string;
  executionRoot: string;
  workingDirectory: string;
  executionKind: 'agent_session' | 'workspace_scratch' | 'project_scratch';
  runtimeConfiguration: {
    model: string | null;
    reasoningEffort: ReasoningEffort | null;
    mode: string | null;
  };
  priorSessionId?: string;
  developerInstructions?: string;
  mcpServers?: Array<{ name: string; command: string; args: string[]; env?: Array<{ name: string; value: string }> }>;
  onEvent?: (event: RuntimeContextEvent) => void;
  onActivity?: (event: RuntimeActivityEvent) => void;
  requestPermission?: (request: unknown) => Promise<'allow_once' | 'allow_always' | 'reject' | 'cancelled'>;
}

export interface RuntimeInspectionSpec {
  runtimeId: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  workingDirectory: string;
  timeoutMs?: number;
}

export interface RuntimeInspectionResult {
  detectedVersion: string | null;
  configuration: RuntimeConfigurationCapabilities;
}

export interface RuntimeExecutionController {
  readonly runtimeId: string;
  readonly sessionId: string;
  readonly capabilities: RuntimeContextCapabilities;
  sendInput(prompt: string): Promise<{ stopReason: string; output: string }>;
  cancel(): Promise<void>;
  markReturnCommitted(): void;
  close(): Promise<void>;
}

export interface RuntimeIntegration {
  inspectRuntime(spec: RuntimeInspectionSpec): Promise<RuntimeInspectionResult>;
  openExecution(spec: RuntimeLaunchSpec): Promise<RuntimeExecutionController>;
}

export interface RuntimeContextProfile {
  readonly runtimeId: string;
  readonly capabilities: Pick<RuntimeContextCapabilities, 'compaction' | 'invariantContinuity'>;
  normalizeUpdate(executionId: string, update: unknown): RuntimeContextEvent[];
}
