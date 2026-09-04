import type { AgentActivityEventInput } from '../domain/types.js';
import { newId } from '../lib/values.js';
import type { RuntimeActivityEvent } from './runtime-integration.js';

interface AgentActivityApi {
  request<T>(path: string, request: {
    method: 'POST';
    body: unknown;
    idempotencyKey: string;
  }): Promise<T>;
}

interface ActiveTurn {
  id: string;
  sequence: number;
}

/** Serializes a Runtime's live ACP actions into the Workspace-visible Agent activity feed. */
export class AgentActivityReporter {
  private activeTurn: ActiveTurn | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly api: AgentActivityApi,
    private readonly agentId: string,
    private readonly onError?: (message: string) => void,
  ) {}

  begin(): void {
    this.activeTurn = { id: newId(), sequence: 0 };
    this.enqueue('turn_started', '已收到消息，开始处理', 'in_progress');
  }

  record(event: RuntimeActivityEvent): void {
    if (!this.activeTurn) return;
    this.enqueue(event.type, event.title, event.status);
  }

  async complete(): Promise<void> {
    if (!this.activeTurn) return;
    this.enqueue('turn_completed', '本轮处理完成', 'completed');
    this.activeTurn = null;
    await this.queue;
  }

  async fail(): Promise<void> {
    if (!this.activeTurn) return;
    this.enqueue('turn_failed', '本轮处理失败', 'failed');
    this.activeTurn = null;
    await this.queue;
  }

  private enqueue(
    eventType: AgentActivityEventInput['eventType'],
    title: string,
    status: AgentActivityEventInput['status'],
  ): void {
    const turn = this.activeTurn;
    if (!turn) return;
    turn.sequence += 1;
    const body: AgentActivityEventInput = {
      eventId: newId(),
      turnId: turn.id,
      sequence: turn.sequence,
      eventType,
      title: title.trim().slice(0, 500),
      status,
    };
    this.queue = this.queue.then(async () => {
      await this.api.request(
        `/v1/computers/self/agents/${this.agentId}/activity`,
        { method: 'POST', body, idempotencyKey: body.eventId },
      );
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.onError?.(`Agent ${this.agentId} activity update failed: ${message}`);
    });
  }
}
