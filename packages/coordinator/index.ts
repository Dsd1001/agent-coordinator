import { projectTask, type EventLedger } from "../core/index.js";
import {
  assertDeliveryIdentity,
  type CoordinationMessage,
  type CoordinationRoom,
  type CoordinationTransport,
  type DeliveryEnvelope,
  type ExpectedDeliveryBinding,
  type ManagerReviewEvidence,
  type ManagerReviewResult,
  type TaskEnvelope,
  type WorkOrderCodec
} from "../protocol/src/index.js";

export interface CoordinatorOptions {
  worker_sender_id: string;
}

export interface DispatchReceipt {
  task: TaskEnvelope;
  room: CoordinationRoom;
  dispatch_message_id: string;
  binding: ExpectedDeliveryBinding;
}

export interface ObservedProtocolReply {
  delivery: DeliveryEnvelope;
  message_id: string;
}

function reviewEvidenceData(evidence?: ManagerReviewEvidence): Record<string, unknown> | undefined {
  if (!evidence) return undefined;
  return {
    review_id: evidence.review_id,
    reviewed_at: evidence.reviewed_at,
    source: evidence.source
  };
}

function assertReviewForReceipt(receipt: DispatchReceipt, review: ManagerReviewResult): void {
  if (!review || typeof review !== "object") throw new Error("manager review is invalid");
  if (typeof review.task_id !== "string" || review.task_id !== receipt.task.task_id) {
    throw new Error("manager review task_id mismatch");
  }
  if (typeof review.execution_id !== "string" || review.execution_id !== receipt.task.execution_id) {
    throw new Error("manager review execution_id mismatch");
  }
  if (typeof review.verdict !== "string" || !["accept", "rework", "resume", "cancel"].includes(review.verdict)) {
    throw new Error("manager review verdict is invalid");
  }
  if (typeof review.summary !== "string" || !review.summary.trim()) {
    throw new Error("manager review summary is required");
  }
  if (
    !review.evidence ||
    typeof review.evidence !== "object" ||
    typeof review.evidence.review_id !== "string" ||
    !review.evidence.review_id.trim() ||
    typeof review.evidence.source !== "string" ||
    !review.evidence.source.trim() ||
    typeof review.evidence.reviewed_at !== "string"
  ) {
    throw new Error("manager review evidence is incomplete");
  }
  if (!Number.isFinite(Date.parse(review.evidence.reviewed_at))) {
    throw new Error("manager review evidence reviewed_at is invalid");
  }
  if (review.verdict === "rework" || review.verdict === "resume") {
    if (typeof review.next_execution_id !== "string" || !review.next_execution_id.trim() || review.next_execution_id === review.execution_id) {
      throw new Error(`${review.verdict} review requires a new next_execution_id`);
    }
    if (
      !Array.isArray(review.requirements) ||
      review.requirements.length === 0 ||
      review.requirements.some((item) => typeof item !== "string" || !item.trim())
    ) {
      throw new Error(`${review.verdict} review requires non-empty requirements`);
    }
  } else if (review.next_execution_id !== undefined || review.requirements !== undefined) {
    throw new Error(`${review.verdict} review must not include rework fields`);
  }
}

export class TaskCoordinator {
  readonly #ledger: EventLedger;
  readonly #transport: CoordinationTransport;
  readonly #codec: WorkOrderCodec;
  readonly #options: CoordinatorOptions;

  constructor(
    ledger: EventLedger,
    transport: CoordinationTransport,
    codec: WorkOrderCodec,
    options: CoordinatorOptions
  ) {
    if (!options.worker_sender_id.trim()) throw new Error("worker_sender_id is required");
    this.#ledger = ledger;
    this.#transport = transport;
    this.#codec = codec;
    this.#options = options;
  }

  async dispatch(task: TaskEnvelope): Promise<DispatchReceipt> {
    const roomTitle = this.#codec.roomTitle(task);
    const workOrder = this.#codec.renderTask(task);
    if (!roomTitle.trim()) throw new Error("work-order codec returned an empty room title");
    if (!workOrder.trim()) throw new Error("work-order codec returned an empty work order");
    this.#ledger.append({ type: "task.prepared", task_id: task.task_id, execution_id: task.execution_id });
    const room = await this.#transport.createRoom(roomTitle);
    if (!room.channel_id.trim() || !room.room_id.trim()) {
      throw new Error("transport returned an invalid room identity");
    }
    this.#ledger.append({
      type: "topic.created",
      task_id: task.task_id,
      execution_id: task.execution_id,
      data: { channel_id: room.channel_id, room_id: room.room_id, topic_id: room.room_id }
    });
    this.#ledger.append({ type: "dispatch.requested", task_id: task.task_id, execution_id: task.execution_id });
    const sent = await this.#transport.send(room, workOrder);
    this.#ledger.append({
      type: "dispatch.confirmed",
      task_id: task.task_id,
      execution_id: task.execution_id,
      data: { message_id: sent.message_id }
    });
    return {
      task: { ...task, room_id: room.room_id, topic_id: room.room_id },
      room,
      dispatch_message_id: sent.message_id,
      binding: {
        task_id: task.task_id,
        execution_id: task.execution_id,
        channel_id: room.channel_id,
        topic_id: room.room_id,
        worker_sender_id: this.#options.worker_sender_id
      }
    };
  }

  observeWorkerReply(receipt: DispatchReceipt, message: CoordinationMessage): ObservedProtocolReply | undefined {
    const parsed = this.#codec.parseWorkerReply(message.text);
    if (!parsed) return undefined;
    if (
      !["deliver", "blocked", "failed"].includes(parsed.kind) ||
      !parsed.task_id?.trim() ||
      !parsed.execution_id?.trim() ||
      typeof parsed.summary !== "string"
    ) {
      throw new Error("work-order codec returned an invalid worker reply");
    }
    const alreadyConsumed = this.#ledger
      .list(receipt.task.task_id)
      .some((event) =>
        (event.type === "delivery.observed" || event.type === "worker.blocked" || event.type === "worker.failed") &&
        event.data?.message_id === message.message_id
      );
    if (alreadyConsumed) throw new Error(`duplicate delivery message: ${message.message_id}`);
    const delivery: DeliveryEnvelope = {
      task_id: parsed.task_id,
      execution_id: parsed.execution_id,
      status: parsed.kind === "deliver" ? "delivered" : parsed.kind,
      summary: parsed.summary,
      artifacts: [],
      checks: [],
      limitations: []
    };
    assertDeliveryIdentity(receipt.binding, {
      payload: delivery,
      channel_id: message.channel_id,
      topic_id: message.room_id ?? "",
      sender_id: message.sender_id,
      delivery_id: message.message_id
    });
    const type = parsed.kind === "deliver" ? "delivery.observed" : parsed.kind === "blocked" ? "worker.blocked" : "worker.failed";
    this.#ledger.append({
      type,
      task_id: delivery.task_id,
      execution_id: delivery.execution_id,
      data: { message_id: message.message_id, summary: delivery.summary }
    });
    return { delivery, message_id: message.message_id };
  }

  async redispatch(
    receipt: DispatchReceipt,
    newExecutionId: string,
    mode: "rework" | "resume",
    requirements: readonly string[] = [],
    evidence?: ManagerReviewEvidence
  ): Promise<DispatchReceipt> {
    if (!newExecutionId.trim() || newExecutionId === receipt.task.execution_id) {
      throw new Error("redispatch requires a new execution id");
    }
    const task: TaskEnvelope = {
      ...receipt.task,
      execution_id: newExecutionId,
      brief: requirements.length > 0
        ? `${receipt.task.brief}\n\n${mode} requirements:\n${requirements.map((item) => `- ${item}`).join("\n")}`
        : receipt.task.brief
    };
    const workOrder = this.#codec.renderTask(task);
    if (!workOrder.trim()) throw new Error("work-order codec returned an empty work order");
    this.#ledger.append({
      type: mode === "rework" ? "review.rework" : "review.resume",
      task_id: receipt.task.task_id,
      execution_id: newExecutionId,
      data: {
        previous_execution_id: receipt.task.execution_id,
        requirements: [...requirements],
        ...(evidence ? { review_evidence: reviewEvidenceData(evidence) } : {})
      }
    });
    this.#ledger.append({ type: "dispatch.requested", task_id: task.task_id, execution_id: task.execution_id });
    const sent = await this.#transport.send(receipt.room, workOrder);
    this.#ledger.append({
      type: "dispatch.confirmed",
      task_id: task.task_id,
      execution_id: task.execution_id,
      data: { message_id: sent.message_id, mode }
    });
    return {
      task,
      room: receipt.room,
      dispatch_message_id: sent.message_id,
      binding: { ...receipt.binding, execution_id: newExecutionId }
    };
  }

  async accept(
    receipt: DispatchReceipt,
    summary = "accepted",
    evidence?: ManagerReviewEvidence
  ): Promise<void> {
    this.#ledger.append({
      type: "review.accepted",
      task_id: receipt.task.task_id,
      execution_id: receipt.task.execution_id,
      data: {
        summary,
        ...(evidence ? { review_evidence: reviewEvidenceData(evidence) } : {})
      }
    });
    await this.#transport.closeRoom(receipt.room);
    this.#ledger.append({
      type: "topic.closed",
      task_id: receipt.task.task_id,
      execution_id: receipt.task.execution_id,
      data: { room_id: receipt.room.room_id, topic_id: receipt.room.room_id }
    });
  }

  async cancel(
    receipt: DispatchReceipt,
    summary = "cancelled",
    evidence?: ManagerReviewEvidence
  ): Promise<void> {
    this.#ledger.append({
      type: "task.cancelled",
      task_id: receipt.task.task_id,
      execution_id: receipt.task.execution_id,
      data: {
        summary,
        ...(evidence ? { review_evidence: reviewEvidenceData(evidence) } : {})
      }
    });
    await this.#transport.closeRoom(receipt.room);
    this.#ledger.append({
      type: "topic.closed",
      task_id: receipt.task.task_id,
      execution_id: receipt.task.execution_id,
      data: { room_id: receipt.room.room_id, topic_id: receipt.room.room_id }
    });
  }

  async applyManagerReview(
    receipt: DispatchReceipt,
    review: ManagerReviewResult
  ): Promise<DispatchReceipt | undefined> {
    assertReviewForReceipt(receipt, review);
    const current = projectTask(this.#ledger.list(receipt.task.task_id), receipt.task.task_id);
    if (!current || current.execution_id !== receipt.task.execution_id || current.status !== "delivered") {
      throw new Error("manager review requires the current execution to be delivered");
    }
    if (review.verdict === "accept") {
      await this.accept(receipt, review.summary, review.evidence);
      return undefined;
    }
    if (review.verdict === "cancel") {
      await this.cancel(receipt, review.summary, review.evidence);
      return undefined;
    }
    return this.redispatch(
      receipt,
      review.next_execution_id as string,
      review.verdict,
      review.requirements ?? [],
      review.evidence
    );
  }
}
