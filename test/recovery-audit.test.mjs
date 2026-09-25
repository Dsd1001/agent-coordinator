import assert from "node:assert/strict";
import test from "node:test";

import {
  MemoryEventLedger,
  assertRecoverySemantics,
  auditRecoverySemantics,
  reconcileTask
} from "../dist/packages/core/index.js";

function appendFlow(ledger) {
  ledger.append({ type: "task.prepared", task_id: "t1", execution_id: "e1", at: "2026-01-01T00:00:00Z" });
  ledger.append({ type: "room.created", task_id: "t1", execution_id: "e1", at: "2026-01-01T00:00:01Z", data: { channel_id: "c1", room_id: "r1" } });
  ledger.append({ type: "dispatch.requested", task_id: "t1", execution_id: "e1", at: "2026-01-01T00:00:02Z" });
  ledger.append({ type: "dispatch.confirmed", task_id: "t1", execution_id: "e1", at: "2026-01-01T00:00:03Z", data: { message_id: "m1" } });
  ledger.append({ type: "worker.started", task_id: "t1", execution_id: "e1", at: "2026-01-01T00:00:04Z", data: { worker_id: "w1" } });
  ledger.append({ type: "delivery.observed", task_id: "t1", execution_id: "e1", at: "2026-01-01T00:00:05Z", data: { message_id: "d1" } });
  ledger.append({ type: "review.accepted", task_id: "t1", execution_id: "e1", at: "2026-01-01T00:00:06Z" });
  ledger.append({ type: "room.closed", task_id: "t1", execution_id: "e1", at: "2026-01-01T00:00:07Z", data: { room_id: "r1" } });
}

test("recovery semantic audit accepts a complete valid lifecycle", () => {
  const ledger = new MemoryEventLedger();
  appendFlow(ledger);
  const report = auditRecoverySemantics(ledger.list());
  assert.equal(report.ok, true);
  assert.equal(report.event_count, 8);
  assert.equal(report.task_count, 1);
  assert.deepEqual(report.findings, []);
  assert.doesNotThrow(() => assertRecoverySemantics(ledger.list()));
});

test("audit catches side-effect ordering and duplicate delivery/reconciliation evidence", () => {
  const events = [
    { seq: 1, type: "task.prepared", task_id: "t1", execution_id: "e1", at: "2026-01-01T00:00:00Z" },
    { seq: 2, type: "room.created", task_id: "t1", execution_id: "e1", at: "2026-01-01T00:00:01Z", data: { room_id: "r1" } },
    { seq: 3, type: "dispatch.confirmed", task_id: "t1", execution_id: "e1", at: "2026-01-01T00:00:02Z" },
    { seq: 4, type: "delivery.observed", task_id: "t1", execution_id: "e1", at: "2026-01-01T00:00:03Z", data: { message_id: "d1" } },
    { seq: 5, type: "worker.failed", task_id: "t1", execution_id: "e1", at: "2026-01-01T00:00:04Z", data: { message_id: "d1" } },
    { seq: 6, type: "reconciliation.recorded", task_id: "t1", execution_id: "e1", at: "2026-01-01T00:00:05Z", data: { decision_key: "same" } },
    { seq: 7, type: "reconciliation.recorded", task_id: "t1", execution_id: "e1", at: "2026-01-01T00:00:06Z", data: { decision_key: "same" } }
  ];
  const report = auditRecoverySemantics(events);
  const codes = report.findings.filter((item) => item.severity === "error").map((item) => item.code);
  assert.equal(report.ok, false);
  assert.ok(codes.includes("dispatch_without_intent"));
  assert.ok(codes.includes("duplicate_execution_result"));
  assert.ok(codes.includes("duplicate_delivery_id"));
  assert.ok(codes.includes("duplicate_reconciliation_decision"));
});

test("audit enforces rework execution rotation and prior delivery", () => {
  const events = [
    { seq: 1, type: "task.prepared", task_id: "t1", execution_id: "e1", at: "2026-01-01T00:00:00Z" },
    { seq: 2, type: "review.rework", task_id: "t1", execution_id: "e1", at: "2026-01-01T00:00:01Z", data: { previous_execution_id: "e1" } }
  ];
  const codes = auditRecoverySemantics(events).findings.map((item) => item.code);
  assert.ok(codes.includes("review_reuses_execution"));
  assert.ok(codes.includes("review_without_delivery"));
});

test("audit rejects room close before a terminal manager decision", () => {
  const events = [
    { seq: 1, type: "task.prepared", task_id: "t1", execution_id: "e1", at: "2026-01-01T00:00:00Z" },
    { seq: 2, type: "room.created", task_id: "t1", execution_id: "e1", at: "2026-01-01T00:00:01Z", data: { room_id: "r1" } },
    { seq: 3, type: "room.closed", task_id: "t1", execution_id: "e1", at: "2026-01-01T00:00:02Z", data: { room_id: "r1" } }
  ];
  assert.ok(auditRecoverySemantics(events).findings.some((item) => item.code === "room_closed_before_terminal"));
});

test("reconcile refuses a corrupt durable history before calling observers", async () => {
  const ledger = new MemoryEventLedger();
  ledger.append({ type: "task.prepared", task_id: "t1", execution_id: "e1" });
  ledger.append({ type: "dispatch.confirmed", task_id: "t1", execution_id: "e1" });
  let observerCalls = 0;
  await assert.rejects(
    () => reconcileTask(ledger, "t1", {
      transport: {
        observeDelivery: async () => {
          observerCalls += 1;
          return undefined;
        }
      }
    }),
    /recovery semantic audit failed: dispatch_without_intent/
  );
  assert.equal(observerCalls, 0);
});


test("audit rejects unknown persisted event types", () => {
  const events = [
    { seq: 1, type: "task.prepared", task_id: "t1", execution_id: "e1", at: "2026-01-01T00:00:00Z" },
    { seq: 2, type: "invented.event", task_id: "t1", execution_id: "e1", at: "2026-01-01T00:00:01Z" }
  ];
  assert.ok(auditRecoverySemantics(events).findings.some((item) => item.code === "unknown_event_type"));
});


test("audit detects non-monotonic ledger input order", () => {
  const events = [
    { seq: 2, type: "task.prepared", task_id: "t1", execution_id: "e1", at: "2026-01-01T00:00:01Z" },
    { seq: 1, type: "reconciliation.recorded", task_id: "t1", execution_id: "e1", at: "2026-01-01T00:00:00Z", data: { decision_key: "x" } }
  ];
  assert.ok(auditRecoverySemantics(events).findings.some((item) => item.code === "non_monotonic_seq"));
});


test("audit rejects stale execution events after rework rotation", () => {
  const events = [
    { seq: 1, type: "task.prepared", task_id: "t1", execution_id: "e1", at: "2026-01-01T00:00:00Z" },
    { seq: 2, type: "room.created", task_id: "t1", execution_id: "e1", at: "2026-01-01T00:00:01Z", data: { room_id: "r1" } },
    { seq: 3, type: "dispatch.requested", task_id: "t1", execution_id: "e1", at: "2026-01-01T00:00:02Z" },
    { seq: 4, type: "dispatch.confirmed", task_id: "t1", execution_id: "e1", at: "2026-01-01T00:00:03Z" },
    { seq: 5, type: "delivery.observed", task_id: "t1", execution_id: "e1", at: "2026-01-01T00:00:04Z", data: { message_id: "d1" } },
    { seq: 6, type: "review.rework", task_id: "t1", execution_id: "e2", at: "2026-01-01T00:00:05Z", data: { previous_execution_id: "e1" } },
    { seq: 7, type: "dispatch.requested", task_id: "t1", execution_id: "e2", at: "2026-01-01T00:00:06Z" },
    { seq: 8, type: "delivery.observed", task_id: "t1", execution_id: "e1", at: "2026-01-01T00:00:07Z", data: { message_id: "late" } }
  ];
  assert.ok(auditRecoverySemantics(events).findings.some((item) => item.code === "stale_execution_event"));
});

test("audit requires rework previous_execution_id to be the current execution", () => {
  const events = [
    { seq: 1, type: "task.prepared", task_id: "t1", execution_id: "e1", at: "2026-01-01T00:00:00Z" },
    { seq: 2, type: "dispatch.requested", task_id: "t1", execution_id: "e1", at: "2026-01-01T00:00:01Z" },
    { seq: 3, type: "dispatch.confirmed", task_id: "t1", execution_id: "e1", at: "2026-01-01T00:00:02Z" },
    { seq: 4, type: "delivery.observed", task_id: "t1", execution_id: "e1", at: "2026-01-01T00:00:03Z", data: { message_id: "d1" } },
    { seq: 5, type: "review.rework", task_id: "t1", execution_id: "e2", at: "2026-01-01T00:00:04Z", data: { previous_execution_id: "e0" } }
  ];
  assert.ok(auditRecoverySemantics(events).findings.some((item) => item.code === "review_stale_previous_execution"));
});
