import assert from "node:assert/strict";
import test from "node:test";

import {
  isAdministrativeSender,
  isCoordinatorSender,
  taskTopicTitle,
  topicConversationId
} from "../dist/packages/transport-telegram/index.js";

test("coordinator allowlist does not trust display names or unknown senders", () => {
  const policy = { coordinator_ids: ["coordinator-uid"], admin_ids: ["admin-uid"] };
  assert.equal(isCoordinatorSender("coordinator-uid", policy), true);
  assert.equal(isCoordinatorSender("admin-uid", policy), false);
  assert.equal(isCoordinatorSender("same-display-name-different-uid", policy), false);
  assert.equal(isAdministrativeSender("admin-uid", policy), true);
});

test("topic conversation identity is deterministic and rejects malformed topic ids", () => {
  assert.equal(topicConversationId("account", "consulting", "42"), "account/consulting#42");
  assert.throws(() => topicConversationId("account", "consulting", "general"), /invalid topic/);
});

test("topic titles retain task identity within a length bound", () => {
  const value = taskTopicTitle("A very long consulting task title that should be truncated", "task-123", 36);
  assert.ok(value.endsWith("[task-123]"));
  assert.ok(value.length <= 36);
});

import {
  parseWorkerReply,
  renderTaskDispatch,
  TelegramWorkOrderCodec,
  toCoordinationMessage
} from "../dist/packages/transport-telegram/index.js";

test("task dispatch renders stable task and execution identity", () => {
  const text = renderTaskDispatch(
    {
      task_id: "t-example",
      execution_id: "e-current",
      title: "Example task",
      brief: "Do the work.",
      acceptance: ["Return a verified result"],
      inputs: [{ path: "/workspace/incoming/input.pdf", sha256: "a".repeat(64) }]
    },
    "Worker_Bot",
    "Coordinator_Bot"
  );
  assert.match(text, /^\/task@Worker_Bot/m);
  assert.match(text, /^task: t-example$/m);
  assert.match(text, /^execution: e-current$/m);
  assert.match(text, /@Coordinator_Bot deliver t-example/);
});

test("worker reply parser is format-tolerant but identity-strict", () => {
  assert.deepEqual(
    parseWorkerReply("@Coordinator_Bot deliver t-example finished execution: e-current", "Coordinator_Bot"),
    { kind: "deliver", task_id: "t-example", execution_id: "e-current", summary: "finished" }
  );
  assert.deepEqual(
    parseWorkerReply("Work is complete; @Coordinator_Bot deliver t-example verified. execution: e-current", "Coordinator_Bot"),
    { kind: "deliver", task_id: "t-example", execution_id: "e-current", summary: "Work is complete; verified." }
  );
  assert.equal(
    parseWorkerReply("When finished I will reply: @Coordinator_Bot deliver <taskId> <summary> execution: e-current", "Coordinator_Bot"),
    undefined
  );
  assert.equal(parseWorkerReply("@Other_Bot deliver t-example done execution: e-current", "Coordinator_Bot"), undefined);
  assert.equal(parseWorkerReply("@Coordinator_Bot deliver t-example finished", "Coordinator_Bot"), undefined);
});

import { shouldColdStartWorker } from "../dist/packages/transport-telegram/index.js";

test("worker cold-start requires coordinator uid, topic, and explicit worker address", () => {
  const policy = { coordinator_ids: ["coordinator-uid"], admin_ids: ["admin-uid"] };
  const base = {
    sender_id: "coordinator-uid",
    channel_id: "chat-example",
    topic_id: "42",
    text: "/task@Worker_Bot do work"
  };
  assert.equal(shouldColdStartWorker(base, policy, "Worker_Bot"), true);
  assert.equal(shouldColdStartWorker({ ...base, sender_id: "unknown-uid" }, policy, "Worker_Bot"), false);
  assert.equal(shouldColdStartWorker({ ...base, sender_id: "admin-uid" }, policy, "Worker_Bot"), false);
  assert.equal(shouldColdStartWorker({ ...base, text: "ordinary topic message" }, policy, "Worker_Bot"), false);
  assert.equal(shouldColdStartWorker({ ...base, topic_id: undefined }, policy, "Worker_Bot"), false);
});


test("Telegram codec implements the generic work-order codec boundary", () => {
  const codec = new TelegramWorkOrderCodec("Worker_Bot", "Coordinator_Bot", 64);
  const task = {
    task_id: "t-codec",
    execution_id: "e-codec",
    title: "Codec task",
    brief: "Do it.",
    acceptance: ["Verified"],
    inputs: []
  };
  assert.ok(codec.roomTitle(task).endsWith("[t-codec]"));
  assert.match(codec.renderTask(task), /^\/task@Worker_Bot/m);
  assert.deepEqual(
    codec.parseWorkerReply("@Coordinator_Bot deliver t-codec done execution: e-codec"),
    { kind: "deliver", task_id: "t-codec", execution_id: "e-codec", summary: "done" }
  );
});

test("Telegram inbound messages adapt topic_id to generic room_id", () => {
  assert.deepEqual(
    toCoordinationMessage({
      message_id: "m1",
      channel_id: "chat-1",
      topic_id: "77",
      sender_id: "worker-1",
      text: "hello"
    }),
    {
      message_id: "m1",
      channel_id: "chat-1",
      room_id: "77",
      sender_id: "worker-1",
      text: "hello"
    }
  );
});
