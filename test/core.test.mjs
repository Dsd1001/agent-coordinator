import assert from "node:assert/strict";
import test from "node:test";

import { MemoryEventLedger, projectTask } from "../dist/packages/core/index.js";

test("event ledger projects room, execution and current status", () => {
  const ledger = new MemoryEventLedger();
  ledger.append({ type: "task.prepared", task_id: "t1", execution_id: "e1" });
  ledger.append({ type: "room.created", task_id: "t1", execution_id: "e1", data: { room_id: "42" } });
  ledger.append({ type: "dispatch.requested", task_id: "t1", execution_id: "e1" });
  ledger.append({ type: "dispatch.confirmed", task_id: "t1", execution_id: "e1" });
  ledger.append({ type: "delivery.observed", task_id: "t1", execution_id: "e1" });
  assert.deepEqual(projectTask(ledger.list(), "t1"), {
    task_id: "t1",
    execution_id: "e1",
    status: "delivered",
    room_id: "42",
    last_event_seq: 5
  });
});

test("rework projection follows the newest execution", () => {
  const ledger = new MemoryEventLedger();
  ledger.append({ type: "task.prepared", task_id: "t1", execution_id: "e1" });
  ledger.append({ type: "delivery.observed", task_id: "t1", execution_id: "e1" });
  ledger.append({ type: "review.rework", task_id: "t1", execution_id: "e2" });
  ledger.append({ type: "dispatch.requested", task_id: "t1", execution_id: "e2" });
  assert.equal(projectTask(ledger.list(), "t1")?.execution_id, "e2");
  assert.equal(projectTask(ledger.list(), "t1")?.status, "dispatching");
});
