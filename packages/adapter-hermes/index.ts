import type {
  DeliveryEnvelope,
  DeliveryVerificationEvidence,
  ManagerAdapter,
  ManagerPreparationReceipt,
  ManagerReviewRequest,
  ManagerReviewResult,
  ReviewVerdict,
  TaskEnvelope
} from "../protocol/src/index.js";

export interface HermesPrepareTaskRequest {
  task_id: string;
  execution_id: string;
  title: string;
  brief: string;
  acceptance: string[];
  inputs: Array<{ path: string; sha256: string; description?: string }>;
}

export interface HermesPrepareTaskResponse {
  task_id: string;
  execution_id: string;
  manager_reference: string;
  prepared_at: string;
}

export interface HermesReviewDeliveryRequest {
  task_id: string;
  execution_id: string;
  task: {
    title: string;
    brief: string;
    acceptance: string[];
  };
  delivery: {
    status: DeliveryEnvelope["status"];
    summary: string;
    artifacts: DeliveryEnvelope["artifacts"];
    checks: DeliveryEnvelope["checks"];
    limitations: string[];
  };
  verification: DeliveryVerificationEvidence;
}

export interface HermesReviewDeliveryResponse {
  task_id: string;
  execution_id: string;
  verdict: ReviewVerdict;
  summary: string;
  requirements?: string[];
  next_execution_id?: string;
  review_id: string;
  reviewed_at: string;
}

export interface HermesManagerClient {
  prepareTask(request: HermesPrepareTaskRequest): Promise<HermesPrepareTaskResponse>;
  reviewDelivery(request: HermesReviewDeliveryRequest): Promise<HermesReviewDeliveryResponse>;
}

export type HermesAdapterOperation = "prepare_task" | "review_delivery";
export type HermesAdapterErrorCode =
  | "client_failure"
  | "invalid_response"
  | "identity_mismatch"
  | "invalid_request";

export class HermesAdapterError extends Error {
  readonly code: HermesAdapterErrorCode;
  readonly operation: HermesAdapterOperation;
  readonly task_id: string;
  readonly execution_id: string;
  readonly retryable: boolean;

  constructor(input: {
    code: HermesAdapterErrorCode;
    operation: HermesAdapterOperation;
    task_id: string;
    execution_id: string;
    retryable?: boolean;
  }) {
    super(`Hermes manager adapter ${input.operation} failed (${input.code})`);
    this.name = "HermesAdapterError";
    this.code = input.code;
    this.operation = input.operation;
    this.task_id = input.task_id;
    this.execution_id = input.execution_id;
    this.retryable = input.retryable ?? false;
  }
}

const ID_PATTERN = /^[A-Za-z0-9._:#/-]{1,200}$/;
const SOURCE = "hermes";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidResponse(operation: HermesAdapterOperation, task: TaskEnvelope): HermesAdapterError {
  return new HermesAdapterError({
    code: "invalid_response",
    operation,
    task_id: task.task_id,
    execution_id: task.execution_id
  });
}

function validId(value: string): boolean {
  return ID_PATTERN.test(value);
}

function validTimestamp(value: string): boolean {
  return Boolean(value) && Number.isFinite(Date.parse(value));
}

function cleanRequirements(values?: string[]): string[] | undefined {
  if (values === undefined) return undefined;
  if (!Array.isArray(values)) return undefined;
  const cleaned = values.map((value) => (typeof value === "string" ? value.trim() : ""));
  if (cleaned.some((value) => !value)) return undefined;
  return [...new Set(cleaned)];
}

function assertTask(task: TaskEnvelope, operation: HermesAdapterOperation): void {
  if (!validId(task.task_id) || !validId(task.execution_id) || !task.title.trim() || !task.brief.trim()) {
    throw new HermesAdapterError({
      code: "invalid_request",
      operation,
      task_id: task.task_id,
      execution_id: task.execution_id
    });
  }
  if (!Array.isArray(task.acceptance) || task.acceptance.some((item) => typeof item !== "string" || !item.trim())) {
    throw new HermesAdapterError({
      code: "invalid_request",
      operation,
      task_id: task.task_id,
      execution_id: task.execution_id
    });
  }
}

function assertVerifiedRequest(request: ManagerReviewRequest): void {
  assertTask(request.task, "review_delivery");
  if (
    request.delivery.task_id !== request.task.task_id ||
    request.delivery.execution_id !== request.task.execution_id
  ) {
    throw new HermesAdapterError({
      code: "identity_mismatch",
      operation: "review_delivery",
      task_id: request.task.task_id,
      execution_id: request.task.execution_id
    });
  }
  if (
    request.delivery.status !== "delivered" ||
    request.delivery.checks.some((check) => check.result !== "passed")
  ) {
    throw new HermesAdapterError({
      code: "invalid_request",
      operation: "review_delivery",
      task_id: request.task.task_id,
      execution_id: request.task.execution_id
    });
  }
  if (
    request.verification.identity_verified !== true ||
    request.verification.artifacts_verified !== true ||
    !validId(request.verification.verification_id) ||
    !validTimestamp(request.verification.verified_at)
  ) {
    throw new HermesAdapterError({
      code: "invalid_request",
      operation: "review_delivery",
      task_id: request.task.task_id,
      execution_id: request.task.execution_id
    });
  }
}

function clientFailure(operation: HermesAdapterOperation, task: TaskEnvelope): HermesAdapterError {
  return new HermesAdapterError({
    code: "client_failure",
    operation,
    task_id: task.task_id,
    execution_id: task.execution_id,
    retryable: true
  });
}

export class HermesManagerAdapter implements ManagerAdapter {
  readonly #client: HermesManagerClient;

  constructor(client: HermesManagerClient) {
    this.#client = client;
  }

  async prepareTask(task: TaskEnvelope): Promise<ManagerPreparationReceipt> {
    assertTask(task, "prepare_task");
    let response: unknown;
    try {
      response = await this.#client.prepareTask({
        task_id: task.task_id,
        execution_id: task.execution_id,
        title: task.title,
        brief: task.brief,
        acceptance: [...task.acceptance],
        inputs: (task.inputs ?? []).map((artifact) => ({ ...artifact }))
      });
    } catch {
      throw clientFailure("prepare_task", task);
    }
    if (
      !isRecord(response) ||
      typeof response.task_id !== "string" ||
      typeof response.execution_id !== "string"
    ) {
      throw invalidResponse("prepare_task", task);
    }
    if (response.task_id !== task.task_id || response.execution_id !== task.execution_id) {
      throw new HermesAdapterError({
        code: "identity_mismatch",
        operation: "prepare_task",
        task_id: task.task_id,
        execution_id: task.execution_id
      });
    }
    if (
      typeof response.manager_reference !== "string" ||
      typeof response.prepared_at !== "string" ||
      !validId(response.manager_reference) ||
      !validTimestamp(response.prepared_at)
    ) {
      throw invalidResponse("prepare_task", task);
    }
    return {
      task_id: task.task_id,
      execution_id: task.execution_id,
      manager_reference: response.manager_reference,
      prepared_at: response.prepared_at
    };
  }

  async reviewDelivery(request: ManagerReviewRequest): Promise<ManagerReviewResult> {
    assertVerifiedRequest(request);
    let response: unknown;
    try {
      response = await this.#client.reviewDelivery({
        task_id: request.task.task_id,
        execution_id: request.task.execution_id,
        task: {
          title: request.task.title,
          brief: request.task.brief,
          acceptance: [...request.task.acceptance]
        },
        delivery: {
          status: request.delivery.status,
          summary: request.delivery.summary,
          artifacts: request.delivery.artifacts.map((artifact) => ({ ...artifact })),
          checks: request.delivery.checks.map((check) => ({ ...check })),
          limitations: [...request.delivery.limitations]
        },
        verification: { ...request.verification }
      });
    } catch {
      throw clientFailure("review_delivery", request.task);
    }

    if (
      !isRecord(response) ||
      typeof response.task_id !== "string" ||
      typeof response.execution_id !== "string"
    ) {
      throw invalidResponse("review_delivery", request.task);
    }
    if (response.task_id !== request.task.task_id || response.execution_id !== request.task.execution_id) {
      throw new HermesAdapterError({
        code: "identity_mismatch",
        operation: "review_delivery",
        task_id: request.task.task_id,
        execution_id: request.task.execution_id
      });
    }
    if (
      typeof response.verdict !== "string" ||
      !["accept", "rework", "resume", "cancel"].includes(response.verdict) ||
      typeof response.summary !== "string" ||
      !response.summary.trim() ||
      typeof response.review_id !== "string" ||
      !validId(response.review_id) ||
      typeof response.reviewed_at !== "string" ||
      !validTimestamp(response.reviewed_at)
    ) {
      throw invalidResponse("review_delivery", request.task);
    }

    const verdict = response.verdict as ReviewVerdict;
    const rawRequirements = response.requirements;
    if (rawRequirements !== undefined && !Array.isArray(rawRequirements)) {
      throw invalidResponse("review_delivery", request.task);
    }
    const requirements = cleanRequirements(rawRequirements as string[] | undefined);
    const requiresNext = verdict === "rework" || verdict === "resume";
    if (requiresNext) {
      if (
        typeof response.next_execution_id !== "string" ||
        !validId(response.next_execution_id) ||
        response.next_execution_id === request.task.execution_id ||
        requirements === undefined ||
        requirements.length === 0
      ) {
        throw new HermesAdapterError({
          code: "invalid_response",
          operation: "review_delivery",
          task_id: request.task.task_id,
          execution_id: request.task.execution_id
        });
      }
    } else if (response.next_execution_id !== undefined || response.requirements !== undefined) {
      throw new HermesAdapterError({
        code: "invalid_response",
        operation: "review_delivery",
        task_id: request.task.task_id,
        execution_id: request.task.execution_id
      });
    }

    return {
      task_id: response.task_id,
      execution_id: response.execution_id,
      verdict,
      summary: response.summary.trim(),
      ...(requirements === undefined ? {} : { requirements }),
      ...(response.next_execution_id === undefined
        ? {}
        : { next_execution_id: response.next_execution_id as string }),
      evidence: {
        review_id: response.review_id,
        reviewed_at: response.reviewed_at,
        source: SOURCE
      }
    };
  }
}
