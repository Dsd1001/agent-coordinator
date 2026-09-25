import assert from "node:assert/strict";
import test from "node:test";

import { MemoryEventLedger, projectTask } from "../dist/packages/core/index.js";
import { TaskCoordinator } from "../dist/packages/coordinator/index.js";

class FakeNonTelegramTransport {
  sent = [];
  closed = [];

  async createRoom(title) {
    this.createdTitle = title;
    return { channel_id: "queue-demo", room_id: "room-101" };
  }

  async send(room, text) {
    this.sent.push({ room, text });
    return { message_id: `message-${this.sent.length}` };
  }

  async closeRoom(room) {
    this.closed.push(room);
  }
}

class JsonWorkOrderCodec {
  roomTitle(task) {
    return `Task ${task.task_id}: ${task.title}`;
  }

  renderTask(task) {
    return JSON.stringify({
      type: "work-order",
      task_id: task.task_id,
      execution_id: task.execution_id,
      title: task.title,
      brief: task.brief,
      acceptance: task.acceptance
    });
  }

  parseWorkerReply(text) {
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      return undefined;
    }
    if (!value || !["deliver", "blocked", "failed"].includes(value.kind)) return undefined;
    if (![value.task_id, value.execution_id, value.summary].every((item) => typeof item === "string" && item.length > 0)) {
      return undefined;
    }
    return value;
  }
}

function task() {
  return {
    task_id: "task-demo",
    execution_id: "exec-1",
    title: "Demo task",
    brief: "Produce the requested result.",
    acceptance: ["Return a verified delivery"],
    inputs: []
  };
}

function coordinatorFixture() {
  const ledger = new MemoryEventLedger();
  const transport = new FakeNonTelegramTransport();
  const codec = new JsonWorkOrderCodec();
  const coordinator = new TaskCoordinator(ledger, transport, codec, { worker_sender_id: "worker-uid" });
  return { ledger, transport, codec, coordinator };
}

function reply(executionId = "exec-1", overrides = {}) {
  return JSON.stringify({
    kind: "deliver",
    task_id: "task-demo",
    execution_id: executionId,
    summary: "completed",
    ...overrides
  });
}

test("coordinator runs task -> generic room -> dispatch -> delivery -> accept without Telegram", async () => {
  const { ledger, transport, coordinator } = coordinatorFixture();
  const receipt = await coordinator.dispatch(task());

  assert.deepEqual(receipt.room, { channel_id: "queue-demo", room_id: "room-101" });
  assert.equal(transport.createdTitle, "Task task-demo: Demo task");
  assert.deepEqual(JSON.parse(transport.sent[0].text), {
    type: "work-order",
    task_id: "task-demo",
    execution_id: "exec-1",
    title: "Demo task",
    brief: "Produce the requested result.",
    acceptance: ["Return a verified delivery"]
  });
  assert.equal(projectTask(ledger.list(), "task-demo")?.status, "dispatched");
  const topicEvent = ledger.list("task-demo").find((event) => event.type === "room.created");
  assert.equal(topicEvent.data.room_id, "room-101");

  const observed = coordinator.observeWorkerReply(receipt, {
    message_id: "delivery-1",
    channel_id: "queue-demo",
    room_id: "room-101",
    sender_id: "worker-uid",
    text: reply()
  });
  assert.equal(observed?.delivery.status, "delivered");
  assert.equal(projectTask(ledger.list(), "task-demo")?.status, "delivered");

  await coordinator.accept(receipt, "meets acceptance criteria");
  assert.equal(projectTask(ledger.list(), "task-demo")?.status, "accepted");
  assert.deepEqual(transport.closed, [{ channel_id: "queue-demo", room_id: "room-101" }]);
});

test("coordinator keeps task/execution/channel/room/sender identity checks with a non-Telegram transport", async () => {
  const { coordinator } = coordinatorFixture();
  const receipt = await coordinator.dispatch(task());

  assert.throws(
    () => coordinator.observeWorkerReply(receipt, {
      message_id: "delivery-wrong-task",
      channel_id: "queue-demo",
      room_id: "room-101",
      sender_id: "worker-uid",
      text: reply("exec-1", { task_id: "other-task" })
    }),
    /task_id mismatch/
  );
  assert.throws(
    () => coordinator.observeWorkerReply(receipt, {
      message_id: "delivery-stale",
      channel_id: "queue-demo",
      room_id: "room-101",
      sender_id: "worker-uid",
      text: reply("exec-old")
    }),
    /execution_id mismatch/
  );
  assert.throws(
    () => coordinator.observeWorkerReply(receipt, {
      message_id: "delivery-wrong-channel",
      channel_id: "other-queue",
      room_id: "room-101",
      sender_id: "worker-uid",
      text: reply()
    }),
    /channel_id mismatch/
  );
  assert.throws(
    () => coordinator.observeWorkerReply(receipt, {
      message_id: "delivery-wrong-room",
      channel_id: "queue-demo",
      room_id: "room-999",
      sender_id: "worker-uid",
      text: reply()
    }),
    /room_id mismatch/
  );
  assert.throws(
    () => coordinator.observeWorkerReply(receipt, {
      message_id: "delivery-wrong-sender",
      channel_id: "queue-demo",
      room_id: "room-101",
      sender_id: "other-uid",
      text: reply()
    }),
    /worker sender mismatch/
  );
});

test("rework reuses the generic room, creates a new execution, and rejects old execution replies", async () => {
  const { ledger, transport, coordinator } = coordinatorFixture();
  const first = await coordinator.dispatch(task());
  coordinator.observeWorkerReply(first, {
    message_id: "delivery-1",
    channel_id: "queue-demo",
    room_id: "room-101",
    sender_id: "worker-uid",
    text: reply()
  });

  const second = await coordinator.redispatch(first, "exec-2", "rework", ["Address reviewer comments"]);
  assert.equal(second.room.room_id, first.room.room_id);
  assert.equal(second.task.execution_id, "exec-2");
  assert.equal(projectTask(ledger.list(), "task-demo")?.status, "dispatched");
  const workOrder = JSON.parse(transport.sent.at(-1).text);
  assert.equal(workOrder.execution_id, "exec-2");
  assert.match(workOrder.brief, /rework requirements:/);

  assert.throws(
    () => coordinator.observeWorkerReply(second, {
      message_id: "late-old-delivery",
      channel_id: "queue-demo",
      room_id: "room-101",
      sender_id: "worker-uid",
      text: reply("exec-1", { summary: "stale" })
    }),
    /execution_id mismatch/
  );
});

test("the same generic delivery message cannot be consumed twice", async () => {
  const { coordinator } = coordinatorFixture();
  const receipt = await coordinator.dispatch(task());
  const message = {
    message_id: "delivery-repeat",
    channel_id: "queue-demo",
    room_id: "room-101",
    sender_id: "worker-uid",
    text: reply()
  };
  coordinator.observeWorkerReply(receipt, message);
  assert.throws(() => coordinator.observeWorkerReply(receipt, message), /duplicate delivery message/);
});

test("coordinator rejects an invalid room returned by a transport", async () => {
  const ledger = new MemoryEventLedger();
  const codec = new JsonWorkOrderCodec();
  const transport = {
    createRoom: async () => ({ channel_id: "queue-demo", room_id: "" }),
    send: async () => ({ message_id: "never" }),
    closeRoom: async () => {}
  };
  const coordinator = new TaskCoordinator(ledger, transport, codec, { worker_sender_id: "worker-uid" });
  await assert.rejects(() => coordinator.dispatch(task()), /invalid room identity/);
});

test("coordinator rejects an empty expected worker identity", () => {
  const ledger = new MemoryEventLedger();
  const transport = new FakeNonTelegramTransport();
  const codec = new JsonWorkOrderCodec();
  assert.throws(() => new TaskCoordinator(ledger, transport, codec, { worker_sender_id: "" }), /worker_sender_id is required/);
});


test("coordinator validates codec output before transport side effects", async () => {
  const ledger = new MemoryEventLedger();
  let createCalls = 0;
  const transport = {
    createRoom: async () => { createCalls += 1; return { channel_id: "c", room_id: "r" }; },
    send: async () => ({ message_id: "m" }),
    closeRoom: async () => {}
  };
  const emptyCodec = {
    roomTitle: () => "room",
    renderTask: () => "",
    parseWorkerReply: () => undefined
  };
  const coordinator = new TaskCoordinator(ledger, transport, emptyCodec, { worker_sender_id: "worker-uid" });
  await assert.rejects(() => coordinator.dispatch(task()), /empty work order/);
  assert.equal(createCalls, 0);
  assert.deepEqual(ledger.list(), []);
});

test("coordinator rejects malformed runtime reply objects from a codec", async () => {
  const ledger = new MemoryEventLedger();
  const transport = new FakeNonTelegramTransport();
  const codec = new JsonWorkOrderCodec();
  const coordinator = new TaskCoordinator(ledger, transport, codec, { worker_sender_id: "worker-uid" });
  const receipt = await coordinator.dispatch(task());
  codec.parseWorkerReply = () => ({
    kind: "invented-kind",
    task_id: "task-demo",
    execution_id: "exec-1",
    summary: "bad"
  });
  assert.throws(
    () => coordinator.observeWorkerReply(receipt, {
      message_id: "m-bad",
      channel_id: "queue-demo",
      room_id: "room-101",
      sender_id: "worker-uid",
      text: "ignored"
    }),
    /invalid worker reply/
  );
  assert.equal(
    ledger.list("task-demo").some((event) => ["delivery.observed", "worker.blocked", "worker.failed"].includes(event.type)),
    false
  );
});
