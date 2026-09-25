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
  /** Transport-neutral collaboration namespace assigned by the coordinator. */
  room_id?: string | null;
  /** @deprecated Telegram-first v0.1 compatibility alias for room_id. */
  topic_id?: string | null;
  inputs?: ArtifactRef[];
}

export interface CoordinationRoom {
  channel_id: string;
  room_id: string;
}

export interface CoordinationMessage {
  message_id: string;
  channel_id: string;
  room_id?: string;
  sender_id: string;
  text: string;
}

export interface CoordinationTransport {
  createRoom(title: string): Promise<CoordinationRoom>;
  send(room: CoordinationRoom, text: string): Promise<{ message_id: string }>;
  closeRoom(room: CoordinationRoom): Promise<void>;
}

export interface WorkerProtocolReply {
  kind: "deliver" | "blocked" | "failed";
  task_id: string;
  execution_id: string;
  summary: string;
}

export interface WorkOrderCodec {
  roomTitle(task: TaskEnvelope): string;
  renderTask(task: TaskEnvelope): string;
  parseWorkerReply(text: string): WorkerProtocolReply | undefined;
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

export type ReviewVerdict = "accept" | "rework" | "resume" | "cancel";

export interface DeliveryVerificationEvidence {
  verification_id: string;
  verified_at: string;
  identity_verified: true;
  artifacts_verified: true;
}

export interface ManagerPreparationReceipt {
  task_id: string;
  execution_id: string;
  manager_reference: string;
  prepared_at: string;
}

export interface ManagerReviewRequest {
  task: TaskEnvelope;
  delivery: DeliveryEnvelope;
  verification: DeliveryVerificationEvidence;
}

export interface ManagerReviewEvidence {
  review_id: string;
  reviewed_at: string;
  source: string;
}

export interface ManagerReviewResult {
  task_id: string;
  execution_id: string;
  verdict: ReviewVerdict;
  summary: string;
  requirements?: string[];
  next_execution_id?: string;
  evidence: ManagerReviewEvidence;
}

export interface ManagerAdapter {
  prepareTask(task: TaskEnvelope): Promise<ManagerPreparationReceipt>;
  reviewDelivery(request: ManagerReviewRequest): Promise<ManagerReviewResult>;
}
