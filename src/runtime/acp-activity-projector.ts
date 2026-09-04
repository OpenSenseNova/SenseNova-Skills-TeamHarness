import type { RuntimeActivityEvent } from './runtime-integration.js';

type ActivityStatus = RuntimeActivityEvent['status'];

const ACTIVITY_TITLE_LIMIT = 500;
const TOOL_STATUSES = new Set<ActivityStatus>(['pending', 'in_progress', 'completed', 'failed']);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replaceAll(/\s+/gu, ' ');
  return normalized.length > 0 ? normalized.slice(0, ACTIVITY_TITLE_LIMIT) : null;
}

function toolStatus(value: unknown, fallback: ActivityStatus): ActivityStatus {
  return typeof value === 'string' && TOOL_STATUSES.has(value as ActivityStatus)
    ? value as ActivityStatus
    : fallback;
}

function toolTitle(value: Record<string, unknown>, prior?: string): string {
  return text(value.title)
    ?? (text(value.name) ? `调用 ${text(value.name)}` : null)
    ?? prior
    ?? '调用工具';
}

/** Projects ACP progress into a small, human-visible feed without exposing raw inputs, outputs, or thoughts. */
export class AcpActivityProjector {
  private thoughtReported = false;
  private messageReported = false;
  private readonly toolTitles = new Map<string, string>();
  private readonly toolSignatures = new Map<string, string>();

  resetTurn(): void {
    this.thoughtReported = false;
    this.messageReported = false;
    this.toolTitles.clear();
    this.toolSignatures.clear();
  }

  project(update: unknown): RuntimeActivityEvent[] {
    const value = record(update);
    if (!value) return [];
    if (value.sessionUpdate === 'agent_thought_chunk') {
      if (this.thoughtReported) return [];
      this.thoughtReported = true;
      return [this.event('thought', '正在分析', 'in_progress')];
    }
    if (value.sessionUpdate === 'agent_message_chunk') {
      if (this.messageReported) return [];
      this.messageReported = true;
      return [this.event('message', '正在组织回复', 'in_progress')];
    }
    if (value.sessionUpdate === 'tool_call') {
      return this.projectTool(value, 'pending');
    }
    if (value.sessionUpdate === 'tool_call_update') {
      return this.projectTool(value, 'in_progress');
    }
    if (value.sessionUpdate === 'plan') {
      const entries = Array.isArray(value.entries) ? value.entries.map(record).filter((entry) => entry !== null) : [];
      const selected = entries.find((entry) => entry.status === 'in_progress')
        ?? entries.find((entry) => entry.status === 'pending')
        ?? entries.at(-1);
      const content = selected ? text(selected.content) : null;
      if (!content) return [];
      const status = selected?.status === 'completed' ? 'completed'
        : selected?.status === 'pending' ? 'pending'
          : 'in_progress';
      return [this.event('plan', `计划：${content}`.slice(0, ACTIVITY_TITLE_LIMIT), status)];
    }
    return [];
  }

  projectPermission(toolCall: unknown): RuntimeActivityEvent[] {
    const value = record(toolCall);
    return value ? this.projectTool(value, 'pending') : [];
  }

  private projectTool(value: Record<string, unknown>, fallbackStatus: ActivityStatus): RuntimeActivityEvent[] {
    const toolCallId = text(value.toolCallId);
    if (!toolCallId) return [];
    const title = toolTitle(value, this.toolTitles.get(toolCallId));
    const status = toolStatus(value.status, fallbackStatus);
    const signature = `${title}\u0000${status}`;
    if (this.toolSignatures.get(toolCallId) === signature) return [];
    this.toolTitles.set(toolCallId, title);
    this.toolSignatures.set(toolCallId, signature);
    return [this.event('tool', title, status)];
  }

  private event(
    type: RuntimeActivityEvent['type'],
    title: string,
    status: RuntimeActivityEvent['status'],
  ): RuntimeActivityEvent {
    return { type, title, status, createdAt: Date.now() };
  }
}
