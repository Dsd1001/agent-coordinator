import type { EventLedger } from "../core/index.js";
import {
  assertDeliveryIdentity,
  type DeliveryEnvelope,
  type ExpectedDeliveryBinding,
  type TaskEnvelope
} from "../protocol/src/index.js";
import {
  parseWorkerReply,
  renderTaskDispatch,
  taskTopicTitle,
  type TaskRoom,
  type TransportAdapter,
  type TransportMessage
} from "../transport-telegram/index.js";

export interface CoordinatorOptions {
  worker_bot_username: string;
  coordinator_bot_username: string;
  worker_sender_id: string;
}

export interface DispatchReceipt {
  task: TaskEnvelope;
  room: TaskRoom;
  dispatch_message_id: string;
  binding: ExpectedDeliveryBinding;
}

export interface ObservedProtocolReply {
  delivery: DeliveryEnvelope;
  message_id: string;
}

export class TaskCoordinator {
  readonly #ledger: EventLedger;
  readonly #transport: TransportAdapter;
  readonly #options: CoordinatorOptions;

  constructor(ledger: EventLedger, transport: TransportAdapter, options: CoordinatorOptions) {
    this.#ledger = ledger;
    this.#transport = transport;
    this.#options = options;
  }

  async dispatch(task: TaskEnvelope): Promise<DispatchReceipt> {
    this.#ledger.append({ type: "task.prepared", task_id: task.task_id, execution_id: task.execution_id });
    const room = await this.#transport.createTaskRoom(taskTopicTitle(task.title, task.task_id));
    this.#ledger.append({
      type: "topic.created",
      task_id: task.task_id,
      execution_id: task.execution_id,
      data: { channel_id: room.channel_id, topic_id: room.topic_id }
    });
    this.#ledger.append({ type: "dispatch.requested", task_id: task.task_id, execution_id: task.execution_id });
    const message = renderTaskDispatch(
      {
        task_id: task.task_id,
        execution_id: task.execution_id,
        title: task.title,
        brief: task.brief,
        acceptance: task.acceptance,
        inputs: task.inputs
      },
      this.#options.worker_bot_username,
      this.#options.coordinator_bot_username
    );
    const sent = await this.#transport.send(room, message);
    this.#ledger.append({
      type: "dispatch.confirmed",
      task_id: task.task_id,
      execution_id: task.execution_id,
      data: { message_id: sent.message_id }
    });
    return {
      task: { ...task, topic_id: room.topic_id },
      room,
      dispatch_message_id: sent.message_id,
      binding: {
        task_id: task.task_id,
        execution_id: task.execution_id,
        channel_id: room.channel_id,
        topic_id: room.topic_id,
        worker_sender_id: this.#options.worker_sender_id
      }
    };
  }

  observeWorkerReply(receipt: DispatchReceipt, message: TransportMessage): ObservedProtocolReply | undefined {
    const parsed = parseWorkerReply(message.text, this.#options.coordinator_bot_username);
    if (!parsed) return undefined;
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
      topic_id: message.topic_id ?? "",
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
    this.#ledger.append({
      type: mode === "rework" ? "review.rework" : "review.resume",
      task_id: receipt.task.task_id,
      execution_id: newExecutionId,
      data: { previous_execution_id: receipt.task.execution_id, requirements: [...requirements] }
    });
    const task: TaskEnvelope = {
      ...receipt.task,
      execution_id: newExecutionId,
      brief: requirements.length > 0
        ? `${receipt.task.brief}\n\n${mode} requirements:\n${requirements.map((item) => `- ${item}`).join("\n")}`
        : receipt.task.brief
    };
    this.#ledger.append({ type: "dispatch.requested", task_id: task.task_id, execution_id: task.execution_id });
    const text = renderTaskDispatch(
      {
        task_id: task.task_id,
        execution_id: task.execution_id,
        title: task.title,
        brief: task.brief,
        acceptance: task.acceptance,
        inputs: task.inputs
      },
      this.#options.worker_bot_username,
      this.#options.coordinator_bot_username
    );
    const sent = await this.#transport.send(receipt.room, text);
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
    await this.#transport.closeTaskRoom(receipt.room);
    this.#ledger.append({
      type: "topic.closed",
      task_id: receipt.task.task_id,
      execution_id: receipt.task.execution_id,
      data: { topic_id: receipt.room.topic_id }
    });
  }
}
