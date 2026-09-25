import assert from "node:assert/strict";
import test from "node:test";

import {
  PROTOCOL_VERSION,
  assertProtocolCompatible,
  assertTaskTransition,
  canTransitionTask,
  isProtocolCompatible,
  parseProtocolVersion,
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

test("delivery identity checks task, execution, channel, room and sender", () => {
  const expected = {
    task_id: "task-example",
    execution_id: "exec-current",
    channel_id: "chat-example",
    room_id: "topic-42",
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
    room_id: "topic-42",
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


test("protocol 0.1 patch releases are compatible but other minor lines are not", () => {
  assert.equal(PROTOCOL_VERSION, "0.1.0");
  assert.deepEqual(parseProtocolVersion("0.1.7"), { major: 0, minor: 1, patch: 7 });
  assert.equal(isProtocolCompatible("0.1.9"), true);
  assert.equal(isProtocolCompatible("0.2.0"), false);
  assert.equal(isProtocolCompatible("1.0.0"), false);
  assert.doesNotThrow(() => assertProtocolCompatible("0.1.99"));
  assert.throws(() => assertProtocolCompatible("0.2.0"), /incompatible protocol version/);
  assert.throws(() => parseProtocolVersion("v0.1"), /invalid protocol version/);
});
