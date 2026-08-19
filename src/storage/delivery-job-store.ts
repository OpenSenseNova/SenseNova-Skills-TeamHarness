import { invariant } from '../lib/errors.js';
import { nowMs } from '../lib/values.js';
import { SqliteDatabase } from './database.js';

export interface ClaimedDeliveryJob {
  id: string;
  workspaceId: string;
  topic: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
  attempts: number;
  fencingToken: number;
  leaseExpiresAt: number;
}

export class DeliveryJobStore {
  constructor(readonly database: SqliteDatabase) {}

  claimNext(workerId: string, leaseDurationMs: number, timestamp = nowMs()): ClaimedDeliveryJob | null {
    invariant(workerId.length > 0, 'INVALID_WORKER', 'Worker id is required.');
    invariant(leaseDurationMs > 0, 'INVALID_LEASE', 'Lease duration must be positive.');
    return this.database.transaction(() => {
      const candidate = this.database.raw
        .prepare(
          `SELECT id FROM delivery_jobs
           WHERE (
             state IN ('pending', 'failed') AND next_attempt_at <= ?
           ) OR (
             state = 'processing' AND lease_expires_at <= ?
           )
           ORDER BY next_attempt_at, created_at, id
           LIMIT 1`,
        )
        .get(timestamp, timestamp) as { id: string } | undefined;
      if (!candidate) return null;
      const leaseExpiresAt = timestamp + leaseDurationMs;
      const row = this.database.raw
        .prepare(
          `UPDATE delivery_jobs
           SET state = 'processing', attempts = attempts + 1, lease_owner = ?,
               lease_expires_at = ?, fencing_token = fencing_token + 1
           WHERE id = ?
           RETURNING *`,
        )
        .get(workerId, leaseExpiresAt, candidate.id) as Record<string, unknown>;
      return {
        id: String(row.id),
        workspaceId: String(row.workspace_id),
        topic: String(row.topic),
        aggregateType: String(row.aggregate_type),
        aggregateId: String(row.aggregate_id),
        payload: JSON.parse(String(row.payload_json)),
        attempts: Number(row.attempts),
        fencingToken: Number(row.fencing_token),
        leaseExpiresAt,
      };
    });
  }

  markDelivered(jobId: string, workerId: string, fencingToken: number, timestamp = nowMs()): void {
    const result = this.database.raw
      .prepare(
        `UPDATE delivery_jobs
         SET state = 'delivered', delivered_at = ?, lease_owner = NULL, lease_expires_at = NULL
         WHERE id = ? AND state = 'processing' AND lease_owner = ? AND fencing_token = ?
           AND lease_expires_at > ?`,
      )
      .run(timestamp, jobId, workerId, fencingToken, timestamp);
    invariant(result.changes === 1, 'STALE_DELIVERY_LEASE', 'Delivery lease is stale.', 409);
  }

  markFailed(
    jobId: string,
    workerId: string,
    fencingToken: number,
    nextAttemptAt: number,
    timestamp = nowMs(),
  ): void {
    const result = this.database.raw
      .prepare(
        `UPDATE delivery_jobs
         SET state = 'failed', next_attempt_at = ?, lease_owner = NULL, lease_expires_at = NULL
         WHERE id = ? AND state = 'processing' AND lease_owner = ? AND fencing_token = ?
           AND lease_expires_at > ?`,
      )
      .run(nextAttemptAt, jobId, workerId, fencingToken, timestamp);
    invariant(result.changes === 1, 'STALE_DELIVERY_LEASE', 'Delivery lease is stale.', 409);
  }
}
