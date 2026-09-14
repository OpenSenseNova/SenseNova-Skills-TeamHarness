import {
  BulbOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  LoadingOutlined,
  MessageOutlined,
  OrderedListOutlined,
  ToolOutlined,
} from '@ant-design/icons';
import type { AgentActivityEvent } from '../api/client';

const transientStatuses = new Set(['pending', 'in_progress']);

/**
 * Backend-generated runtime activity titles. The runtime emits these fixed
 * phrases in Chinese and persists them, so they are localized only for
 * display. Dynamic titles (a tool's own name, plan content) pass through
 * untouched — only the leading verb the runtime added is translated.
 */
const ACTIVITY_TITLES: Record<string, string> = {
  '调用工具': 'Calling tool',
  '正在分析': 'Analyzing',
  '正在组织回复': 'Composing reply',
  '已收到消息，开始处理': 'Message received, processing',
  '本轮处理完成': 'Turn completed',
  '本轮处理失败': 'Turn failed',
  '动态连接已恢复，继续处理': 'Activity connection restored, resuming',
  'Agent 动态连接中断': 'Agent activity connection lost',
};

/** Localize a runtime activity title for display; leaves dynamic agent text unchanged. */
export function localizeActivityTitle(title: string, isEnglish: boolean): string {
  if (!isEnglish) return title;
  const exact = ACTIVITY_TITLES[title];
  if (exact) return exact;
  if (title.startsWith('调用 ')) return `Call ${title.slice(3)}`;
  if (title.startsWith('计划：')) return `Plan: ${title.slice(3)}`;
  return title;
}

/**
 * The runtime reports an activity twice as it moves from in-progress to a
 * terminal state. Keep the terminal record (the API is newest-first) and
 * collapse the older lifecycle record from the user-facing timeline.
 */
export function collapseAgentActivityEvents(events: AgentActivityEvent[]): AgentActivityEvent[] {
  const collapsed: AgentActivityEvent[] = [];
  for (const event of events) {
    const newer = collapsed[collapsed.length - 1];
    if (
      newer
      && newer.turnId === event.turnId
      && newer.eventType === event.eventType
      && newer.title === event.title
      && (newer.status === 'completed' || newer.status === 'failed')
      && transientStatuses.has(event.status)
    ) {
      continue;
    }
    collapsed.push(event);
  }
  return collapsed;
}

function effectiveActivityStatus(activity: AgentActivityEvent): AgentActivityEvent['status'] {
  if (transientStatuses.has(activity.status)) {
    if (activity.turnStatus === 'completed') return 'completed';
    if (activity.turnStatus === 'failed') return 'failed';
  }
  return activity.status;
}

export function agentActivityIcon(activity: AgentActivityEvent): React.ReactNode {
  const status = effectiveActivityStatus(activity);
  if (status === 'completed' && transientStatuses.has(activity.status)) return <CheckCircleOutlined />;
  if (status === 'failed' && transientStatuses.has(activity.status)) return <CloseCircleOutlined />;
  if (activity.eventType === 'turn_completed') return <CheckCircleOutlined />;
  if (activity.eventType === 'turn_failed') return <CloseCircleOutlined />;
  if (activity.eventType === 'tool') return <ToolOutlined />;
  if (activity.eventType === 'plan') return <OrderedListOutlined />;
  if (activity.eventType === 'thought') return <BulbOutlined />;
  if (activity.eventType === 'message') return <MessageOutlined />;
  return <LoadingOutlined spin />;
}

export function agentActivityTone(activity: AgentActivityEvent): 'running' | 'success' | 'failed' | 'waiting' {
  const status = effectiveActivityStatus(activity);
  if (status === 'failed') return 'failed';
  if (status === 'completed') return 'success';
  if (status === 'pending') return 'waiting';
  return 'running';
}
