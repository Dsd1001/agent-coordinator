export type TaskStatus =
  | "prepared"
  | "dispatching"
  | "dispatched"
  | "delivering"
  | "delivered"
  | "blocked"
  | "failed"
  | "reworking"
  | "accepted"
  | "cancelled";

export interface ArtifactRef {
  path: string;
  sha256: string;
  description?: string;
}

export interface TaskEnvelope {
  task_id: string;
  execution_id: string;
  title: string;
  brief: string;
  acceptance: string[];
  topic_id?: string | null;
  inputs?: ArtifactRef[];
}

export interface DeliveryCheck {
  name: string;
  result: "passed" | "failed" | "not_run";
  detail?: string;
}

export interface DeliveryEnvelope {
  task_id: string;
  execution_id: string;
  status: "delivered" | "blocked" | "failed";
  summary: string;
  artifacts: ArtifactRef[];
  checks: DeliveryCheck[];
  limitations: string[];
}

export interface ExpectedDeliveryBinding {
  task_id: string;
  execution_id: string;
  channel_id: string;
  topic_id: string;
  worker_sender_id: string;
}

export interface ObservedDelivery {
  payload: DeliveryEnvelope;
  channel_id: string;
  topic_id: string;
  sender_id: string;
  delivery_id: string;
}

const transitions: Record<TaskStatus, readonly TaskStatus[]> = {
  prepared: ["dispatching", "cancelled"],
  dispatching: ["dispatched", "failed", "cancelled"],
  dispatched: ["delivering", "blocked", "failed", "cancelled"],
  delivering: ["delivered", "blocked", "failed", "cancelled"],
  delivered: ["accepted", "reworking", "cancelled"],
  blocked: ["dispatching", "cancelled"],
  failed: ["dispatching", "cancelled"],
  reworking: ["dispatching", "cancelled"],
  accepted: [],
  cancelled: []
};

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return transitions[from].includes(to);
}

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransitionTask(from, to)) {
    throw new Error(`invalid task transition: ${from} -> ${to}`);
  }
}

export function verifyDeliveryIdentity(
  expected: ExpectedDeliveryBinding,
  observed: ObservedDelivery
): string[] {
  const errors: string[] = [];
  if (observed.payload.task_id !== expected.task_id) errors.push("task_id mismatch");
  if (observed.payload.execution_id !== expected.execution_id) errors.push("execution_id mismatch");
  if (observed.channel_id !== expected.channel_id) errors.push("channel_id mismatch");
  if (observed.topic_id !== expected.topic_id) errors.push("topic_id mismatch");
  if (observed.sender_id !== expected.worker_sender_id) errors.push("worker sender mismatch");
  if (!observed.delivery_id) errors.push("delivery_id missing");
  return errors;
}

export function assertDeliveryIdentity(
  expected: ExpectedDeliveryBinding,
  observed: ObservedDelivery
): void {
  const errors = verifyDeliveryIdentity(expected, observed);
  if (errors.length > 0) throw new Error(`delivery rejected: ${errors.join(", ")}`);
}
