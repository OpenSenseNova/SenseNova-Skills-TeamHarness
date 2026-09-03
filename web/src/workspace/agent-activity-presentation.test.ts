import { describe, expect, it } from 'vitest';
import type { AgentActivityEvent } from '../api/client';
import { agentActivityTone, collapseAgentActivityEvents } from './agent-activity-presentation';

function activity(overrides: Partial<AgentActivityEvent> = {}): AgentActivityEvent {
  return {
    eventId: '00000000-0000-0000-0000-000000000002',
    turnId: '00000000-0000-0000-0000-000000000001',
    sequence: 2,
    eventType: 'tool',
    title: '读取项目文件',
    status: 'completed',
    workspaceId: '00000000-0000-0000-0000-000000000003',
    agentId: '00000000-0000-0000-0000-000000000004',
    agentName: 'Designer',
    turnStatus: 'completed',
    turnStartedAt: 1,
    turnUpdatedAt: 3,
    turnFinishedAt: 3,
    createdAt: 3,
    ...overrides,
  };
}

describe('agent activity presentation', () => {
  it('collapses an in-progress event when its terminal update is present', () => {
    const terminal = activity({ eventId: 'terminal', status: 'completed' });
    const started = activity({ eventId: 'started', status: 'in_progress', sequence: 1, createdAt: 2 });
    expect(collapseAgentActivityEvents([terminal, started])).toEqual([terminal]);
  });

  it('renders stale in-progress events according to their finished turn', () => {
    expect(agentActivityTone(activity({ status: 'in_progress', turnStatus: 'completed' }))).toBe('success');
    expect(agentActivityTone(activity({ status: 'in_progress', turnStatus: 'failed' }))).toBe('failed');
  });
});
