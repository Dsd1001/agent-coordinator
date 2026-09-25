import type { TaskStatus } from "../protocol/src/index.js";

export type CoordinationEventType =
  | "task.prepared"
  | "topic.created"
  | "input.attached"
  | "dispatch.requested"
  | "dispatch.confirmed"
  | "worker.started"
  | "worker.blocked"
  | "worker.failed"
  | "delivery.observed"
  | "review.rework"
  | "review.resume"
  | "review.accepted"
  | "task.cancelled"
  | "topic.closed";

export interface CoordinationEvent {
  seq: number;
  type: CoordinationEventType;
  task_id: string;
  execution_id: string;
  at: string;
  data?: Record<string, unknown>;
}

export interface AppendEventInput extends Omit<CoordinationEvent, "seq" | "at"> {
  at?: string;
}

export interface TaskProjection {
  task_id: string;
  execution_id: string;
  status: TaskStatus;
  topic_id?: string;
  last_event_seq: number;
}

const statusByEvent: Partial<Record<CoordinationEventType, TaskStatus>> = {
  "task.prepared": "prepared",
  "dispatch.requested": "dispatching",
  "dispatch.confirmed": "dispatched",
  "worker.blocked": "blocked",
  "worker.failed": "failed",
  "delivery.observed": "delivered",
  "review.rework": "reworking",
  "review.resume": "reworking",
  "review.accepted": "accepted",
  "task.cancelled": "cancelled"
};

export interface EventLedger {
  append(input: AppendEventInput): CoordinationEvent;
  list(taskId?: string): CoordinationEvent[];
}

export class MemoryEventLedger implements EventLedger {
  readonly #events: CoordinationEvent[] = [];

  append(input: AppendEventInput): CoordinationEvent {
    if (!input.task_id || !input.execution_id) throw new Error("task_id and execution_id are required");
    const event: CoordinationEvent = {
      ...input,
      seq: this.#events.length + 1,
      at: input.at ?? new Date().toISOString()
    };
    this.#events.push(event);
    return event;
  }

  list(taskId?: string): CoordinationEvent[] {
    return this.#events.filter((event) => taskId === undefined || event.task_id === taskId).map((event) => ({ ...event }));
  }
}

export function projectTask(events: readonly CoordinationEvent[], taskId: string): TaskProjection | undefined {
  const relevant = events.filter((event) => event.task_id === taskId).sort((a, b) => a.seq - b.seq);
  if (relevant.length === 0) return undefined;
  let status: TaskStatus | undefined;
  let topicId: string | undefined;
  let executionId = relevant[0].execution_id;
  for (const event of relevant) {
    executionId = event.execution_id;
    const nextStatus = statusByEvent[event.type];
    if (nextStatus) status = nextStatus;
    if (event.type === "topic.created") {
      const value = event.data?.topic_id;
      if (typeof value === "string" && value) topicId = value;
    }
  }
  if (!status) throw new Error(`task ${taskId} has events but no state-bearing event`);
  return {
    task_id: taskId,
    execution_id: executionId,
    status,
    topic_id: topicId,
    last_event_seq: relevant.at(-1)?.seq ?? 0
  };
}

export { SqliteEventLedger, type SqliteEventLedgerOptions } from "./sqlite-ledger.js";

export {
  assertDeliveryReadyForAcceptance,
  validateArtifactRefs,
  verifyArtifactRefs,
  verifyDeliveryForAcceptance,
  type ArtifactVerificationReport,
  type ArtifactVerificationResult,
  type DeliveryAcceptanceReport
} from "./artifact-verification.js";
