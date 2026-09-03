import type { RuntimeContextEvent, RuntimeContextProfile } from './runtime-integration.js';

abstract class BaseProfile implements RuntimeContextProfile {
  abstract readonly runtimeId: string;
  abstract readonly capabilities: RuntimeContextProfile['capabilities'];

  normalizeUpdate(executionId: string, update: unknown): RuntimeContextEvent[] {
    const value = update as Record<string, unknown> | null;
    if (value?.sessionUpdate === 'usage_update') {
      return [{ type: 'context_usage', executionId, details: value, createdAt: Date.now() }];
    }
    const metadata = value?._meta as Record<string, unknown> | undefined;
    const observed = metadata?.aiNativeContextEvent;
    if (
      observed === 'context_compaction_started'
      || observed === 'context_compaction_completed'
      || observed === 'context_reloaded'
    ) {
      return [{ type: observed, executionId, details: value ?? {}, createdAt: Date.now() }];
    }
    return [];
  }

}

class GenericAcpProfile extends BaseProfile {
  readonly runtimeId = 'generic-acp';
  readonly capabilities = { compaction: 'opaque', invariantContinuity: 'opaque' } as const;
}

class CodexProfile extends BaseProfile {
  readonly runtimeId = 'codex';
  readonly capabilities = { compaction: 'observable', invariantContinuity: 'profile_reloaded' } as const;
}

class ClaudeProfile extends BaseProfile {
  readonly runtimeId = 'claude';
  readonly capabilities = { compaction: 'observable', invariantContinuity: 'profile_reloaded' } as const;
}

class GeminiProfile extends BaseProfile {
  readonly runtimeId = 'gemini';
  readonly capabilities = { compaction: 'observable', invariantContinuity: 'profile_reloaded' } as const;
}

class GooseProfile extends BaseProfile {
  readonly runtimeId = 'goose';
  readonly capabilities = { compaction: 'opaque', invariantContinuity: 'opaque' } as const;
}

const profiles = new Map<string, RuntimeContextProfile>([
  ['generic-acp', new GenericAcpProfile()],
  ['codex', new CodexProfile()],
  ['claude', new ClaudeProfile()],
  ['gemini', new GeminiProfile()],
  ['goose', new GooseProfile()],
]);

export function runtimeContextProfile(runtimeId: string): RuntimeContextProfile {
  return profiles.get(runtimeId) ?? profiles.get('generic-acp')!;
}
