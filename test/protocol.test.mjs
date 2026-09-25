import assert from "node:assert/strict";
import test from "node:test";

import {
  assertTaskTransition,
  canTransitionTask,
  verifyDeliveryIdentity
} from "../dist/packages/protocol/src/index.js";

test("task state machine accepts normal dispatch and review flow", () => {
  assert.equal(canTransitionTask("prepared", "dispatching"), true);
  assert.equal(canTransitionTask("dispatching", "dispatched"), true);
  assert.equal(canTransitionTask("delivered", "accepted"), true);
  assert.equal(canTransitionTask("accepted", "dispatching"), false);
});

test("rework requires a new dispatch path", () => {
  assert.equal(canTransitionTask("delivered", "reworking"), true);
  assert.equal(canTransitionTask("reworking", "dispatching"), true);
  assert.throws(() => assertTaskTransition("reworking", "accepted"), /invalid task transition/);
});

test("delivery identity checks task, execution, channel, topic and sender", () => {
  const expected = {
    task_id: "task-example",
    execution_id: "exec-current",
    channel_id: "chat-example",
    topic_id: "topic-42",
    worker_sender_id: "worker-bot"
  };
  const payload = {
    task_id: "task-example",
    execution_id: "exec-current",
    status: "delivered",
    summary: "done",
    artifacts: [],
    checks: [],
    limitations: []
  };
  const observed = {
    payload,
    channel_id: "chat-example",
    topic_id: "topic-42",
    sender_id: "worker-bot",
    delivery_id: "message-9"
  };
  assert.deepEqual(verifyDeliveryIdentity(expected, observed), []);

  assert.deepEqual(
    verifyDeliveryIdentity(expected, {
      ...observed,
      payload: { ...payload, execution_id: "exec-stale" },
      sender_id: "other-bot"
    }),
    ["execution_id mismatch", "worker sender mismatch"]
  );
});
