export const PROTOCOL_VERSION = "0.1.0" as const;

export interface ParsedProtocolVersion {
  major: number;
  minor: number;
  patch: number;
}

export function parseProtocolVersion(value: string): ParsedProtocolVersion {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) throw new Error(`invalid protocol version: ${value}`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function isProtocolCompatible(peerVersion: string, localVersion = PROTOCOL_VERSION): boolean {
  const peer = parseProtocolVersion(peerVersion);
  const local = parseProtocolVersion(localVersion);
  // Before 1.0, compatibility is scoped to the same major+minor line. Patch
  // releases must remain wire-compatible. At/after 1.0, semver-major governs.
  return local.major === 0
    ? peer.major === local.major && peer.minor === local.minor
    : peer.major === local.major;
}

export function assertProtocolCompatible(peerVersion: string, localVersion = PROTOCOL_VERSION): void {
  if (!isProtocolCompatible(peerVersion, localVersion)) {
    throw new Error(`incompatible protocol version: local=${localVersion} peer=${peerVersion}`);
  }
}

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
  room_id: string;
  worker_sender_id: string;
}

export interface ObservedDelivery {
  payload: DeliveryEnvelope;
  channel_id: string;
  room_id: string;
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
  if (observed.room_id !== expected.room_id) errors.push("room_id mismatch");
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

export interface WorkerResourceLimits {
  max_runtime_ms: number;
  max_memory_mb: number;
}

export interface WorkerBinding {
  task_id: string;
  execution_id: string;
  conversation_id: string;
  workspace: string;
  resource_limits: WorkerResourceLimits;
}

export interface WorkerStatus {
  state: "starting" | "running" | "stopped" | "failed";
  worker_id: string;
  updated_at: string;
  detail?: string;
}

export interface WorkerBackend {
  start(binding: WorkerBinding): Promise<WorkerStatus>;
  inspect(worker_id: string): Promise<WorkerStatus>;
  stop(worker_id: string, reason?: string): Promise<void>;
}

export interface ProcessSpec {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  worker_id: string;
  resource_limits: WorkerResourceLimits;
}

export interface ManagedProcess {
  worker_id: string;
  started_at: string;
}

export interface WorkerProcessManager {
  /** Implementations MUST enforce spec.resource_limits or reject the start. */
  start(spec: ProcessSpec): Promise<ManagedProcess>;
  inspect(workerId: string): Promise<WorkerStatus>;
  stop(workerId: string, reason?: string): Promise<void>;
}
