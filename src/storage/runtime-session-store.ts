import { createHash } from 'node:crypto';
import { newId, nowMs } from '../lib/values.js';
import { SqliteDatabase } from './database.js';

export interface RuntimeSessionRow {
  id: string;
  workspace_id: string;
  agent_id: string;
  adapter_instance_id: string;
  runtime_session_id: string;
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

  findActive(workspaceId: string, agentId: string, adapterInstanceId: string): RuntimeSessionRow | undefined {
    return this.database.raw.prepare(
      `SELECT id, workspace_id, agent_id, adapter_instance_id, runtime_session_id,
              initial_prompt_sent, last_seen_position, status, created_at, updated_at
       FROM runtime_sessions
       WHERE workspace_id = ? AND agent_id = ? AND adapter_instance_id = ? AND status = 'active'
       ORDER BY updated_at DESC LIMIT 1`,
    ).get(workspaceId, agentId, adapterInstanceId) as RuntimeSessionRow | undefined;
  }

  replaceActive(
    workspaceId: string,
    agentId: string,
    adapterInstanceId: string,
    runtimeSessionId: string,
    lastSeenPosition: number,
  ): RuntimeSessionRow {
    return this.database.transaction(() => {
      const timestamp = nowMs();
      this.database.raw.prepare(
        `UPDATE runtime_sessions SET status = 'lost', updated_at = ?
         WHERE workspace_id = ? AND agent_id = ? AND status = 'active'`,
      ).run(timestamp, workspaceId, agentId);
      const id = newId();
      this.database.raw.prepare(
        `INSERT INTO runtime_sessions (
           id, workspace_id, agent_id, adapter_instance_id, runtime_session_id,
           initial_prompt_sent, return_committed, last_seen_position, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 0, 0, ?, 'active', ?, ?)`,
      ).run(
        id, workspaceId, agentId, adapterInstanceId, runtimeSessionId,
        lastSeenPosition, timestamp, timestamp,
      );
      return this.findActive(workspaceId, agentId, adapterInstanceId)!;
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

  markLost(id: string): void {
    this.database.raw.prepare(
      `UPDATE runtime_sessions SET status = 'lost', updated_at = ?
       WHERE id = ? AND status = 'active'`,
    ).run(nowMs(), id);
  }
}
