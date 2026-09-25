import type { EventLedger } from "../core/index.js";
import {
  assertDeliveryIdentity,
  type CoordinationMessage,
  type CoordinationRoom,
  type CoordinationTransport,
  type DeliveryEnvelope,
  type ExpectedDeliveryBinding,
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
    requirements: readonly string[] = []
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
      data: { previous_execution_id: receipt.task.execution_id, requirements: [...requirements] }
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

  async accept(receipt: DispatchReceipt, summary = "accepted"): Promise<void> {
    this.#ledger.append({
      type: "review.accepted",
      task_id: receipt.task.task_id,
      execution_id: receipt.task.execution_id,
      data: { summary }
    });
    await this.#transport.closeRoom(receipt.room);
    this.#ledger.append({
      type: "topic.closed",
      task_id: receipt.task.task_id,
      execution_id: receipt.task.execution_id,
      data: { room_id: receipt.room.room_id, topic_id: receipt.room.room_id }
    });
  }
}
