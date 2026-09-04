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
