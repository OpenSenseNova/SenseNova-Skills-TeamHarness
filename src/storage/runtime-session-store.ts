import { createHash } from 'node:crypto';
import { newId, nowMs } from '../lib/values.js';
import { SqliteDatabase } from './database.js';

export interface RuntimeSessionRow {
  id: string;
  workspace_id: string;
  agent_id: string;
  adapter_instance_id: string;
  runtime_session_id: string;
  session_kind: 'mention' | 'work_item';
  session_key: string;
  context_hash: string;
  context_jsonl: string;
  session_target: string | null;
  window_mode: 'dm' | 'isolated';
  window_initial_frontier: number;
  window_message_count: number;
  window_status: 'accepting' | 'frozen' | 'completed';
  initial_prompt_sent: 0 | 1;
  last_seen_position: number;
  status: 'active' | 'closed' | 'lost';
  created_at: number;
  updated_at: number;
}

export function runtimeAdapterInstanceId(
  runtimeId: string,
  transport: string,
  developerInstructions: string,
): string {
  const revision = createHash('sha256')
    .update(`${runtimeId}\0${transport}\0${developerInstructions}`)
    .digest('hex');
  return `${runtimeId}:${transport}:${revision}`;
}

/** Local custody for a persistent Runtime conversation belonging to one Agent. */
export class RuntimeSessionStore {
  constructor(private readonly database: SqliteDatabase) {}

  findActive(
    workspaceId: string,
    agentId: string,
    adapterInstanceId: string,
    sessionKind: RuntimeSessionRow['session_kind'],
    sessionKey: string,
    contextHash: string,
  ): RuntimeSessionRow | undefined {
    return this.database.raw.prepare(
      `SELECT id, workspace_id, agent_id, adapter_instance_id, runtime_session_id,
              session_kind, session_key, context_hash,
              context_jsonl,
              session_target, window_mode, window_initial_frontier,
              window_message_count, window_status,
              initial_prompt_sent, last_seen_position, status, created_at, updated_at
       FROM runtime_sessions
       WHERE workspace_id = ? AND agent_id = ? AND adapter_instance_id = ?
         AND session_kind = ? AND session_key = ? AND status = 'active'
       ORDER BY updated_at DESC LIMIT 1`,
    ).get(workspaceId, agentId, adapterInstanceId, sessionKind, sessionKey) as RuntimeSessionRow | undefined;
  }

  replaceActive(
    workspaceId: string,
    agentId: string,
    adapterInstanceId: string,
    runtimeSessionId: string,
    sessionKind: RuntimeSessionRow['session_kind'],
    sessionKey: string,
    contextHash: string,
    lastSeenPosition: number,
    contextJsonl = '',
    window: {
      target: string | null;
      mode: 'dm' | 'isolated';
      initialFrontier: number;
      acceptedMessages: number;
      status: 'accepting' | 'frozen' | 'completed';
    } = {
      target: null,
      mode: 'isolated',
      initialFrontier: 0,
      acceptedMessages: 0,
      status: 'accepting',
    },
  ): RuntimeSessionRow {
    return this.database.transaction(() => {
      const timestamp = nowMs();
      this.database.raw.prepare(
        `UPDATE runtime_sessions SET status = 'lost', updated_at = ?
         WHERE workspace_id = ? AND agent_id = ? AND session_kind = ? AND session_key = ? AND status = 'active'`,
      ).run(timestamp, workspaceId, agentId, sessionKind, sessionKey);
      const id = newId();
      this.database.raw.prepare(
        `INSERT INTO runtime_sessions (
           id, workspace_id, agent_id, adapter_instance_id, runtime_session_id,
           session_kind, session_key, context_hash,
           context_jsonl,
           session_target, window_mode, window_initial_frontier,
           window_message_count, window_status,
           initial_prompt_sent, return_committed, last_seen_position, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 'active', ?, ?)`,
      ).run(
        id, workspaceId, agentId, adapterInstanceId, runtimeSessionId,
        sessionKind, sessionKey, contextHash, contextJsonl,
        window.target, window.mode, window.initialFrontier, window.acceptedMessages, window.status,
        lastSeenPosition, timestamp, timestamp,
      );
      return this.findActive(workspaceId, agentId, adapterInstanceId, sessionKind, sessionKey, contextHash)!;
    });
  }

  markInitialPromptSent(id: string): void {
    this.database.raw.prepare(
      `UPDATE runtime_sessions SET initial_prompt_sent = 1, updated_at = ?
       WHERE id = ? AND status = 'active'`,
    ).run(nowMs(), id);
  }

  touch(id: string, lastSeenPosition: number): void {
    this.database.raw.prepare(
      `UPDATE runtime_sessions
       SET last_seen_position = MAX(last_seen_position, ?), updated_at = ?
       WHERE id = ? AND status = 'active'`,
    ).run(lastSeenPosition, nowMs(), id);
  }

  updateWindow(
    id: string,
    window: {
      target?: string | null;
      mode?: 'dm' | 'isolated';
      initialFrontier?: number;
      acceptedMessages?: number;
      status?: 'accepting' | 'frozen' | 'completed';
    },
  ): void {
    const assignments: string[] = [];
    const values: unknown[] = [];
    if (window.target !== undefined) { assignments.push('session_target = ?'); values.push(window.target); }
    if (window.mode !== undefined) { assignments.push('window_mode = ?'); values.push(window.mode); }
    if (window.initialFrontier !== undefined) { assignments.push('window_initial_frontier = ?'); values.push(window.initialFrontier); }
    if (window.acceptedMessages !== undefined) {
      assignments.push('window_message_count = ?');
      values.push(Math.min(Math.max(window.acceptedMessages, 0), 10));
    }
    if (window.status !== undefined) { assignments.push('window_status = ?'); values.push(window.status); }
    if (assignments.length === 0) return;
    values.push(nowMs(), id);
    this.database.raw.prepare(
      `UPDATE runtime_sessions SET ${assignments.join(', ')}, updated_at = ?
       WHERE id = ? AND status = 'active'`,
    ).run(...(values as any[]));
  }

  listActive(agentId?: string): RuntimeSessionRow[] {
    const query = agentId === undefined
      ? `SELECT id, workspace_id, agent_id, adapter_instance_id, runtime_session_id,
                session_kind, session_key, context_hash, context_jsonl,
                session_target, window_mode, window_initial_frontier,
                window_message_count, window_status,
                initial_prompt_sent, last_seen_position, status, created_at, updated_at
         FROM runtime_sessions
         WHERE status = 'active' AND window_status <> 'completed'
         ORDER BY updated_at DESC`
      : `SELECT id, workspace_id, agent_id, adapter_instance_id, runtime_session_id,
                session_kind, session_key, context_hash, context_jsonl,
                session_target, window_mode, window_initial_frontier,
                window_message_count, window_status,
                initial_prompt_sent, last_seen_position, status, created_at, updated_at
         FROM runtime_sessions
         WHERE agent_id = ? AND status = 'active' AND window_status <> 'completed'
         ORDER BY updated_at DESC`;
    return this.database.raw.prepare(query).all(...(agentId === undefined ? [] : [agentId])) as unknown as RuntimeSessionRow[];
  }

  markLost(id: string): void {
    this.database.raw.prepare(
      `UPDATE runtime_sessions SET status = 'lost', updated_at = ?
       WHERE id = ? AND status = 'active'`,
    ).run(nowMs(), id);
  }

  markClosed(id: string): void {
    this.database.raw.prepare(
      `UPDATE runtime_sessions SET status = 'closed', updated_at = ?
       WHERE id = ? AND status = 'active'`,
    ).run(nowMs(), id);
  }
}
