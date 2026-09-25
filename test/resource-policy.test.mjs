import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_RESOURCE_QUOTA_POLICY,
  ExecutionAdmissionController,
  ResourceQuotaError,
  artifactVerificationLimits,
  processResourceLimits,
  validateResourceQuotaPolicy
} from "../dist/packages/core/index.js";

const policy = {
  ...DEFAULT_RESOURCE_QUOTA_POLICY,
  max_active_executions: 2,
  max_active_per_worker: 1,
  max_queued_executions: 2,
  max_execution_ms: 10_000,
  max_memory_mb: 512,
  max_artifact_count: 2,
  max_total_artifact_bytes: 1024
};

function request(task_id, execution_id, worker_key) {
  return { task_id, execution_id, worker_key };
}

test("resource policy validates hard limits and derives process limits", () => {
  assert.deepEqual(validateResourceQuotaPolicy(policy), policy);
  assert.deepEqual(processResourceLimits(policy), { max_runtime_ms: 10_000, max_memory_mb: 512 });
  assert.deepEqual(artifactVerificationLimits(policy), { max_artifact_count: 2, max_total_artifact_bytes: 1024 });
  assert.throws(() => validateResourceQuotaPolicy({ ...policy, max_active_executions: 0 }), /positive safe integer/);
  assert.throws(() => validateResourceQuotaPolicy({ ...policy, max_total_artifact_bytes: -1 }), /non-negative safe integer/);
});

test("admission controller enforces global and per-worker concurrency with eligible FIFO draining", async () => {
  let tick = 0;
  const controller = new ExecutionAdmissionController(policy, () => new Date(1_700_000_000_000 + tick++));
  const a1 = await controller.acquire(request("t1", "e1", "worker-a"));
  const b1 = await controller.acquire(request("t2", "e1", "worker-b"));
  const a2Promise = controller.acquire(request("t3", "e1", "worker-a"));
  const c1Promise = controller.acquire(request("t4", "e1", "worker-c"));
  assert.deepEqual(controller.snapshot(), {
    active: 2,
    queued: 2,
    active_by_worker: { "worker-a": 1, "worker-b": 1 },
    queued_by_worker: { "worker-a": 1, "worker-c": 1 },
    limits: { max_active_executions: 2, max_active_per_worker: 1, max_queued_executions: 2 }
  });

  // Releasing B leaves worker A saturated, so the later C request is the first
  // eligible item and must not be blocked behind A2.
  b1.release();
  const c1 = await c1Promise;
  assert.equal(c1.worker_key, "worker-c");
  assert.equal(controller.snapshot().queued, 1);

  a1.release();
  const a2 = await a2Promise;
  assert.equal(a2.worker_key, "worker-a");
  a2.release();
  c1.release();
  assert.equal(controller.snapshot().active, 0);
});

test("admission queue is bounded, duplicate executions are rejected, and release is idempotent", async () => {
  const one = { ...policy, max_active_executions: 1, max_queued_executions: 1 };
  const controller = new ExecutionAdmissionController(one);
  const active = await controller.acquire(request("t1", "e1", "worker-a"));
  const queued = controller.acquire(request("t2", "e1", "worker-b"));
  await assert.rejects(
    () => controller.acquire(request("t2", "e1", "worker-b")),
    (error) => error instanceof ResourceQuotaError && error.code === "duplicate_execution"
  );
  await assert.rejects(
    () => controller.acquire(request("t3", "e1", "worker-c")),
    (error) => error instanceof ResourceQuotaError && error.code === "queue_full"
  );
  active.release();
  active.release();
  const promoted = await queued;
  assert.equal(promoted.task_id, "t2");
  promoted.release();
});

test("queued execution can be cancelled without consuming a slot", async () => {
  const controller = new ExecutionAdmissionController({ ...policy, max_active_executions: 1 });
  const active = await controller.acquire(request("t1", "e1", "worker-a"));
  const queued = controller.acquire(request("t2", "e1", "worker-b"));
  assert.equal(controller.cancelQueued("t2", "e1"), true);
  await assert.rejects(queued, (error) => error instanceof ResourceQuotaError && error.code === "queued_cancelled");
  assert.equal(controller.snapshot().queued, 0);
  active.release();
});
