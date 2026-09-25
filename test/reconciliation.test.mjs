import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SqliteEventLedger, projectTask, reconcileTask } from "../dist/packages/core/index.js";

async function tempDb() {
  const dir = await mkdtemp(join(tmpdir(), "agent-coordinator-reconcile-"));
  return join(dir, "events.db");
}

function seedDispatchIntent(ledger, executionId = "e1") {
  ledger.append({ type: "task.prepared", task_id: "t1", execution_id: executionId });
  ledger.append({
    type: "topic.created",
    task_id: "t1",
    execution_id: executionId,
    data: { channel_id: "chat-1", topic_id: "42" }
  });
  ledger.append({ type: "dispatch.requested", task_id: "t1", execution_id: executionId });
}

function delivery(executionId = "e1", overrides = {}) {
  return {
    payload: {
      task_id: "t1",
      execution_id: executionId,
      status: "delivered",
      summary: "verified delivery",
      artifacts: [],
      checks: [],
      limitations: []
    },
    channel_id: "chat-1",
    topic_id: "42",
    sender_id: "worker-uid",
    delivery_id: `delivery-${executionId}`,
    ...overrides
  };
}

test("ambiguous dispatch remains blocked after restart and reconciliation is idempotent", async () => {
  const path = await tempDb();
  const first = new SqliteEventLedger(path);
  seedDispatchIntent(first);
  first.close();

  const ledger = new SqliteEventLedger(path);
  let observes = 0;
  const observers = {
    transport: {
      observeDispatch: async () => {
        observes += 1;
        return { state: "unknown", execution_id: "e1" };
      }
    }
  };

  const firstReport = await reconcileTask(ledger, "t1", observers);
  assert.equal(projectTask(ledger.list(), "t1")?.status, "dispatching");
  assert.match(firstReport.manual_actions.join("\n"), /do not resend automatically/i);
  assert.equal(ledger.list("t1").filter((event) => event.type === "reconciliation.recorded").length, 1);
  const count = ledger.list("t1").length;

  const secondReport = await reconcileTask(ledger, "t1", observers);
  assert.equal(ledger.list("t1").length, count);
  assert.equal(secondReport.appended_event_seqs.length, 0);
  assert.equal(observes, 2);
  ledger.close();
});

test("confirmed dispatch receipt advances durable state without sending again", async () => {
  const path = await tempDb();
  const ledger = new SqliteEventLedger(path);
  seedDispatchIntent(ledger);

  const report = await reconcileTask(ledger, "t1", {
    transport: {
      observeDispatch: async () => ({ state: "confirmed", execution_id: "e1", message_id: "dispatch-77" })
    }
  });
  assert.equal(projectTask(ledger.list(), "t1")?.status, "dispatched");
  assert.match(report.changes.join("\n"), /dispatch message dispatch-77/);
  const confirmed = ledger.list("t1").filter((event) => event.type === "dispatch.confirmed");
  assert.equal(confirmed.length, 1);
  assert.equal(confirmed[0].data.reconciled, true);

  await reconcileTask(ledger, "t1", {
    transport: {
      observeDispatch: async () => {
        throw new Error("dispatch observer must not be called after confirmation");
      }
    }
  });
  assert.equal(ledger.list("t1").filter((event) => event.type === "dispatch.confirmed").length, 1);
  ledger.close();
});

test("running worker evidence records worker start once and never starts a worker", async () => {
  const path = await tempDb();
  const ledger = new SqliteEventLedger(path);
  seedDispatchIntent(ledger);
  ledger.append({
    type: "dispatch.confirmed",
    task_id: "t1",
    execution_id: "e1",
    data: { message_id: "dispatch-1" }
  });
  let observations = 0;
  const observers = {
    worker: {
      observeWorker: async () => {
        observations += 1;
        return { state: "running", execution_id: "e1", worker_id: "worker-42" };
      }
    }
  };

  const first = await reconcileTask(ledger, "t1", observers);
  assert.match(first.changes.join("\n"), /worker-42/);
  assert.equal(ledger.list("t1").filter((event) => event.type === "worker.started").length, 1);

  await reconcileTask(ledger, "t1", observers);
  assert.equal(ledger.list("t1").filter((event) => event.type === "worker.started").length, 1);
  assert.equal(observations, 1);
  ledger.close();
});

test("valid current delivery is recovered after restart and then waits for manager review", async () => {
  const path = await tempDb();
  const first = new SqliteEventLedger(path);
  seedDispatchIntent(first);
  first.append({ type: "dispatch.confirmed", task_id: "t1", execution_id: "e1", data: { message_id: "dispatch-1" } });
  first.append({ type: "worker.started", task_id: "t1", execution_id: "e1", data: { worker_id: "worker-42" } });
  first.close();

  const ledger = new SqliteEventLedger(path);
  const observers = {
    transport: {
      observeDelivery: async () => delivery("e1")
    }
  };
  const report = await reconcileTask(ledger, "t1", observers, { worker_sender_id: "worker-uid" });
  assert.equal(report.status_after, "delivered");
  assert.equal(projectTask(ledger.list(), "t1")?.status, "delivered");
  assert.match(report.changes.join("\n"), /delivery-e1/);
  assert.match(report.manual_actions.join("\n"), /awaiting manager review/i);
  assert.equal(ledger.list("t1").filter((event) => event.type === "delivery.observed").length, 1);
  assert.equal(ledger.list("t1").filter((event) => event.type === "reconciliation.recorded").length, 1);
  const count = ledger.list("t1").length;

  const second = await reconcileTask(ledger, "t1", observers, { worker_sender_id: "worker-uid" });
  assert.equal(ledger.list("t1").length, count);
  assert.equal(second.appended_event_seqs.length, 0);
  ledger.close();
});

test("stale execution delivery cannot reconcile into the current execution", async () => {
  const path = await tempDb();
  const ledger = new SqliteEventLedger(path);
  seedDispatchIntent(ledger, "e1");
  ledger.append({ type: "dispatch.confirmed", task_id: "t1", execution_id: "e1", data: { message_id: "d1" } });
  ledger.append({ type: "delivery.observed", task_id: "t1", execution_id: "e1", data: { message_id: "old" } });
  ledger.append({ type: "review.rework", task_id: "t1", execution_id: "e2", data: { previous_execution_id: "e1" } });
  ledger.append({ type: "dispatch.requested", task_id: "t1", execution_id: "e2" });
  ledger.append({ type: "dispatch.confirmed", task_id: "t1", execution_id: "e2", data: { message_id: "d2" } });
  ledger.append({ type: "worker.started", task_id: "t1", execution_id: "e2", data: { worker_id: "worker-2" } });

  const report = await reconcileTask(
    ledger,
    "t1",
    { transport: { observeDelivery: async () => delivery("e1") } },
    { worker_sender_id: "worker-uid" }
  );
  assert.equal(report.execution_id, "e2");
  assert.equal(projectTask(ledger.list(), "t1")?.execution_id, "e2");
  assert.equal(ledger.list("t1").filter((event) => event.execution_id === "e2" && event.type === "delivery.observed").length, 0);
  assert.match(report.observations.join("\n"), /execution_id mismatch/);
  assert.match(report.manual_actions.join("\n"), /failed current task\/execution/i);
  ledger.close();
});

test("accepted task records observed topic closure once but never closes it itself", async () => {
  const path = await tempDb();
  const ledger = new SqliteEventLedger(path);
  seedDispatchIntent(ledger);
  ledger.append({ type: "dispatch.confirmed", task_id: "t1", execution_id: "e1", data: { message_id: "d1" } });
  ledger.append({ type: "delivery.observed", task_id: "t1", execution_id: "e1", data: { message_id: "delivery-1" } });
  ledger.append({ type: "review.accepted", task_id: "t1", execution_id: "e1", data: { summary: "ok" } });

  let observed = 0;
  const observers = {
    transport: {
      observeTopic: async () => {
        observed += 1;
        return { state: "closed", execution_id: "e1" };
      }
    }
  };
  const report = await reconcileTask(ledger, "t1", observers);
  assert.match(report.changes.join("\n"), /topic closure/i);
  assert.equal(ledger.list("t1").filter((event) => event.type === "topic.closed").length, 1);
  await reconcileTask(ledger, "t1", observers);
  assert.equal(ledger.list("t1").filter((event) => event.type === "topic.closed").length, 1);
  assert.equal(observed, 1);
  ledger.close();
});

test("open topic after accept remains a manual action and does not repeat close", async () => {
  const path = await tempDb();
  const ledger = new SqliteEventLedger(path);
  seedDispatchIntent(ledger);
  ledger.append({ type: "dispatch.confirmed", task_id: "t1", execution_id: "e1", data: { message_id: "d1" } });
  ledger.append({ type: "delivery.observed", task_id: "t1", execution_id: "e1", data: { message_id: "delivery-1" } });
  ledger.append({ type: "review.accepted", task_id: "t1", execution_id: "e1", data: { summary: "ok" } });

  const observers = {
    transport: {
      observeTopic: async () => ({ state: "open", execution_id: "e1" })
    }
  };
  const first = await reconcileTask(ledger, "t1", observers);
  assert.match(first.manual_actions.join("\n"), /will not repeat the close side effect/i);
  assert.equal(ledger.list("t1").filter((event) => event.type === "topic.closed").length, 0);
  const count = ledger.list("t1").length;
  await reconcileTask(ledger, "t1", observers);
  assert.equal(ledger.list("t1").length, count);
  ledger.close();
});
