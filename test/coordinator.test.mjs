import assert from "node:assert/strict";
import test from "node:test";

import { MemoryEventLedger, projectTask } from "../dist/packages/core/index.js";
import { TaskCoordinator } from "../dist/packages/coordinator/index.js";

class FakeTransport {
  sent = [];
  closed = [];
  async createTaskRoom() {
    return { channel_id: "chat-demo", topic_id: "101" };
  }
  async send(room, text) {
    this.sent.push({ room, text });
    return { message_id: "dispatch-1" };
  }
  async closeTaskRoom(room) {
    this.closed.push(room);
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

test("coordinator runs task -> topic -> dispatch -> delivery -> accept lifecycle", async () => {
  const ledger = new MemoryEventLedger();
  const transport = new FakeTransport();
  const coordinator = new TaskCoordinator(ledger, transport, {
    worker_bot_username: "Worker_Bot",
    coordinator_bot_username: "Coordinator_Bot",
    worker_sender_id: "worker-uid"
  });

  const receipt = await coordinator.dispatch(task());
  assert.equal(receipt.room.topic_id, "101");
  assert.match(transport.sent[0].text, /^\/task@Worker_Bot/m);
  assert.equal(projectTask(ledger.list(), "task-demo")?.status, "dispatched");

  const observed = coordinator.observeWorkerReply(receipt, {
    message_id: "delivery-1",
    channel_id: "chat-demo",
    topic_id: "101",
    sender_id: "worker-uid",
    text: "@Coordinator_Bot deliver task-demo completed execution: exec-1"
  });
  assert.equal(observed?.delivery.status, "delivered");
  assert.equal(projectTask(ledger.list(), "task-demo")?.status, "delivered");

  await coordinator.accept(receipt, "meets acceptance criteria");
  assert.equal(projectTask(ledger.list(), "task-demo")?.status, "accepted");
  assert.deepEqual(transport.closed, [{ channel_id: "chat-demo", topic_id: "101" }]);
});

test("coordinator rejects stale execution, wrong topic, and wrong sender", async () => {
  const ledger = new MemoryEventLedger();
  const transport = new FakeTransport();
  const coordinator = new TaskCoordinator(ledger, transport, {
    worker_bot_username: "Worker_Bot",
    coordinator_bot_username: "Coordinator_Bot",
    worker_sender_id: "worker-uid"
  });
  const receipt = await coordinator.dispatch(task());

  assert.throws(
    () => coordinator.observeWorkerReply(receipt, {
      message_id: "delivery-stale",
      channel_id: "chat-demo",
      topic_id: "101",
      sender_id: "worker-uid",
      text: "@Coordinator_Bot deliver task-demo old execution: exec-old"
    }),
    /execution_id mismatch/
  );
  assert.throws(
    () => coordinator.observeWorkerReply(receipt, {
      message_id: "delivery-wrong-topic",
      channel_id: "chat-demo",
      topic_id: "999",
      sender_id: "worker-uid",
      text: "@Coordinator_Bot deliver task-demo done execution: exec-1"
    }),
    /topic_id mismatch/
  );
  assert.throws(
    () => coordinator.observeWorkerReply(receipt, {
      message_id: "delivery-wrong-sender",
      channel_id: "chat-demo",
      topic_id: "101",
      sender_id: "other-uid",
      text: "@Coordinator_Bot deliver task-demo done execution: exec-1"
    }),
    /worker sender mismatch/
  );
});

test("rework reuses the same topic, creates a new execution, and rejects the old execution", async () => {
  const ledger = new MemoryEventLedger();
  const transport = new FakeTransport();
  const coordinator = new TaskCoordinator(ledger, transport, {
    worker_bot_username: "Worker_Bot",
    coordinator_bot_username: "Coordinator_Bot",
    worker_sender_id: "worker-uid"
  });
  const first = await coordinator.dispatch(task());
  coordinator.observeWorkerReply(first, {
    message_id: "delivery-1",
    channel_id: "chat-demo",
    topic_id: "101",
    sender_id: "worker-uid",
    text: "@Coordinator_Bot deliver task-demo draft execution: exec-1"
  });

  const second = await coordinator.redispatch(first, "exec-2", "rework", ["Address reviewer comments"]);
  assert.equal(second.room.topic_id, first.room.topic_id);
  assert.equal(second.task.execution_id, "exec-2");
  assert.equal(projectTask(ledger.list(), "task-demo")?.status, "dispatched");
  assert.match(transport.sent.at(-1).text, /^execution: exec-2$/m);
  assert.match(transport.sent.at(-1).text, /rework requirements:/);

  assert.throws(
    () => coordinator.observeWorkerReply(second, {
      message_id: "late-old-delivery",
      channel_id: "chat-demo",
      topic_id: "101",
      sender_id: "worker-uid",
      text: "@Coordinator_Bot deliver task-demo stale execution: exec-1"
    }),
    /execution_id mismatch/
  );
});

test("the same delivery message cannot be consumed twice", async () => {
  const ledger = new MemoryEventLedger();
  const transport = new FakeTransport();
  const coordinator = new TaskCoordinator(ledger, transport, {
    worker_bot_username: "Worker_Bot",
    coordinator_bot_username: "Coordinator_Bot",
    worker_sender_id: "worker-uid"
  });
  const receipt = await coordinator.dispatch(task());
  const message = {
    message_id: "delivery-repeat",
    channel_id: "chat-demo",
    topic_id: "101",
    sender_id: "worker-uid",
    text: "@Coordinator_Bot deliver task-demo done execution: exec-1"
  };
  coordinator.observeWorkerReply(receipt, message);
  assert.throws(() => coordinator.observeWorkerReply(receipt, message), /duplicate delivery message/);
});
