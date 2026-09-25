export interface ResourceQuotaPolicy {
  max_active_executions: number;
  max_active_per_worker: number;
  max_queued_executions: number;
  max_execution_ms: number;
  max_memory_mb: number;
  max_artifact_count: number;
  max_total_artifact_bytes: number;
}

export const DEFAULT_RESOURCE_QUOTA_POLICY: ResourceQuotaPolicy = {
  max_active_executions: 4,
  max_active_per_worker: 1,
  max_queued_executions: 32,
  max_execution_ms: 60 * 60 * 1000,
  max_memory_mb: 2048,
  max_artifact_count: 64,
  max_total_artifact_bytes: 512 * 1024 * 1024
};

export interface ExecutionAdmissionRequest {
  task_id: string;
  execution_id: string;
  worker_key: string;
}

export interface ExecutionLease {
  lease_id: string;
  task_id: string;
  execution_id: string;
  worker_key: string;
  admitted_at: string;
  release(): void;
}

export interface AdmissionSnapshot {
  active: number;
  queued: number;
  active_by_worker: Record<string, number>;
  queued_by_worker: Record<string, number>;
  limits: Pick<ResourceQuotaPolicy, "max_active_executions" | "max_active_per_worker" | "max_queued_executions">;
}

export type ResourceQuotaErrorCode = "queue_full" | "duplicate_execution" | "queued_cancelled";

export class ResourceQuotaError extends Error {
  readonly code: ResourceQuotaErrorCode;
  readonly task_id: string;
  readonly execution_id: string;

  constructor(code: ResourceQuotaErrorCode, request: ExecutionAdmissionRequest) {
    super(`execution admission failed (${code}) for ${request.task_id}/${request.execution_id}`);
    this.name = "ResourceQuotaError";
    this.code = code;
    this.task_id = request.task_id;
    this.execution_id = request.execution_id;
  }
}

interface PendingRequest {
  request: ExecutionAdmissionRequest;
  resolve: (lease: ExecutionLease) => void;
  reject: (error: Error) => void;
}

const ID_PATTERN = /^[A-Za-z0-9._:#/-]{1,200}$/;

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer`);
  return value;
}

function nonNegativeSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return value;
}

export function validateResourceQuotaPolicy(policy: ResourceQuotaPolicy): ResourceQuotaPolicy {
  return {
    max_active_executions: positiveSafeInteger(policy.max_active_executions, "max_active_executions"),
    max_active_per_worker: positiveSafeInteger(policy.max_active_per_worker, "max_active_per_worker"),
    max_queued_executions: nonNegativeSafeInteger(policy.max_queued_executions, "max_queued_executions"),
    max_execution_ms: positiveSafeInteger(policy.max_execution_ms, "max_execution_ms"),
    max_memory_mb: positiveSafeInteger(policy.max_memory_mb, "max_memory_mb"),
    max_artifact_count: nonNegativeSafeInteger(policy.max_artifact_count, "max_artifact_count"),
    max_total_artifact_bytes: nonNegativeSafeInteger(policy.max_total_artifact_bytes, "max_total_artifact_bytes")
  };
}


export function artifactVerificationLimits(policy: ResourceQuotaPolicy): {
  max_artifact_count: number;
  max_total_artifact_bytes: number;
} {
  const validated = validateResourceQuotaPolicy(policy);
  return {
    max_artifact_count: validated.max_artifact_count,
    max_total_artifact_bytes: validated.max_total_artifact_bytes
  };
}

export function processResourceLimits(policy: ResourceQuotaPolicy): { max_runtime_ms: number; max_memory_mb: number } {
  const validated = validateResourceQuotaPolicy(policy);
  return {
    max_runtime_ms: validated.max_execution_ms,
    max_memory_mb: validated.max_memory_mb
  };
}

function validateRequest(request: ExecutionAdmissionRequest): ExecutionAdmissionRequest {
  for (const [label, value] of Object.entries(request)) {
    if (!ID_PATTERN.test(value)) throw new Error(`${label} contains unsupported characters`);
  }
  return { ...request };
}

function executionKey(request: ExecutionAdmissionRequest): string {
  return `${request.task_id}\u0000${request.execution_id}`;
}

export class ExecutionAdmissionController {
  readonly #policy: ResourceQuotaPolicy;
  readonly #now: () => Date;
  readonly #active = new Map<string, ExecutionAdmissionRequest>();
  readonly #queue: PendingRequest[] = [];
  #leaseSequence = 0;

  constructor(policy: ResourceQuotaPolicy, now: () => Date = () => new Date()) {
    this.#policy = validateResourceQuotaPolicy(policy);
    this.#now = now;
    const current = this.#now();
    if (!Number.isFinite(current.getTime())) throw new Error("now() must return a valid Date");
  }

  #workerActive(workerKey: string): number {
    let count = 0;
    for (const request of this.#active.values()) if (request.worker_key === workerKey) count += 1;
    return count;
  }

  #eligible(request: ExecutionAdmissionRequest): boolean {
    return (
      this.#active.size < this.#policy.max_active_executions &&
      this.#workerActive(request.worker_key) < this.#policy.max_active_per_worker
    );
  }

  #hasExecution(request: ExecutionAdmissionRequest): boolean {
    const key = executionKey(request);
    if (this.#active.has(key)) return true;
    return this.#queue.some((pending) => executionKey(pending.request) === key);
  }

  #lease(request: ExecutionAdmissionRequest): ExecutionLease {
    const key = executionKey(request);
    this.#active.set(key, request);
    const admitted = this.#now();
    if (!Number.isFinite(admitted.getTime())) {
      this.#active.delete(key);
      throw new Error("now() must return a valid Date");
    }
    const leaseId = `lease-${++this.#leaseSequence}`;
    let released = false;
    return {
      lease_id: leaseId,
      task_id: request.task_id,
      execution_id: request.execution_id,
      worker_key: request.worker_key,
      admitted_at: admitted.toISOString(),
      release: () => {
        if (released) return;
        released = true;
        this.#active.delete(key);
        this.#drain();
      }
    };
  }

  #drain(): void {
    while (this.#active.size < this.#policy.max_active_executions) {
      const index = this.#queue.findIndex((pending) => this.#eligible(pending.request));
      if (index < 0) return;
      const [pending] = this.#queue.splice(index, 1);
      try {
        pending.resolve(this.#lease(pending.request));
      } catch (error) {
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  acquire(input: ExecutionAdmissionRequest): Promise<ExecutionLease> {
    const request = validateRequest(input);
    if (this.#hasExecution(request)) return Promise.reject(new ResourceQuotaError("duplicate_execution", request));
    if (this.#eligible(request)) return Promise.resolve(this.#lease(request));
    if (this.#queue.length >= this.#policy.max_queued_executions) {
      return Promise.reject(new ResourceQuotaError("queue_full", request));
    }
    return new Promise<ExecutionLease>((resolve, reject) => {
      this.#queue.push({ request, resolve, reject });
    });
  }

  cancelQueued(taskId: string, executionId: string): boolean {
    const index = this.#queue.findIndex(
      (pending) => pending.request.task_id === taskId && pending.request.execution_id === executionId
    );
    if (index < 0) return false;
    const [pending] = this.#queue.splice(index, 1);
    pending.reject(new ResourceQuotaError("queued_cancelled", pending.request));
    return true;
  }

  snapshot(): AdmissionSnapshot {
    const activeByWorker: Record<string, number> = {};
    const queuedByWorker: Record<string, number> = {};
    for (const request of this.#active.values()) {
      activeByWorker[request.worker_key] = (activeByWorker[request.worker_key] ?? 0) + 1;
    }
    for (const { request } of this.#queue) {
      queuedByWorker[request.worker_key] = (queuedByWorker[request.worker_key] ?? 0) + 1;
    }
    return {
      active: this.#active.size,
      queued: this.#queue.length,
      active_by_worker: activeByWorker,
      queued_by_worker: queuedByWorker,
      limits: {
        max_active_executions: this.#policy.max_active_executions,
        max_active_per_worker: this.#policy.max_active_per_worker,
        max_queued_executions: this.#policy.max_queued_executions
      }
    };
  }
}
