import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AtomicJsonFileHealthSink,
  SupervisorHealthTracker,
  boundedExponentialBackoffMs,
  effectiveRetryDelayMs
} from "../dist/packages/core/index.js";

function clock(...values) {
  let index = 0;
  return () => new Date(values[Math.min(index++, values.length - 1)]);
}

test("bounded exponential backoff grows and caps", () => {
  const policy = { base_ms: 5_000, max_ms: 60_000 };
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6].map((failures) => boundedExponentialBackoffMs(failures, policy)),
    [5_000, 10_000, 20_000, 40_000, 60_000, 60_000]
  );
  assert.equal(effectiveRetryDelayMs(1, policy, 12_000), 12_000);
  assert.equal(effectiveRetryDelayMs(4, policy, 10_000), 40_000);
});

test("invalid health/backoff inputs fail before mutating state", () => {
  assert.throws(
    () => new SupervisorHealthTracker({ poll_backoff: { base_ms: 0, max_ms: 1_000 } }),
    /base_ms must be greater than zero/
  );
  assert.throws(
    () => new SupervisorHealthTracker({ worker_backoff: { base_ms: 10_000, max_ms: 5_000 } }),
    /max_ms must be >= base_ms/
  );
  const tracker = new SupervisorHealthTracker({ now: () => new Date("2026-01-01T00:00:00Z") });
  assert.throws(() => tracker.recordWorkerSpawnFailure("worker key with spaces"), /stable 1-160 character identifier/);
  assert.throws(() => tracker.recordPollSuccess(-1), /non-negative integer/);
  assert.throws(() => tracker.recordPollFailure(1.5), /non-negative safe integer/);
  assert.throws(() => tracker.recordWorkerSpawnFailure("worker-1", -1), /non-negative safe integer/);
  assert.throws(
    () => tracker.recordPollFailure(Number.MAX_SAFE_INTEGER),
    /invalid next_attempt_at/
  );
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.state, "healthy");
  assert.equal(snapshot.poll.consecutive_failures, 0);
  assert.deepEqual(snapshot.workers, []);
});

test("poll failures degrade health and poll success clears retry state", () => {
  const tracker = new SupervisorHealthTracker({
    now: clock("2026-01-01T00:00:00Z")
  });
  assert.equal(tracker.snapshot().state, "healthy");

  assert.equal(tracker.recordPollFailure(undefined, new Date("2026-01-01T00:00:01Z")), 3_000);
  assert.equal(tracker.recordPollFailure(10_000, new Date("2026-01-01T00:00:02Z")), 10_000);
  const degraded = tracker.snapshot();
  assert.equal(degraded.state, "degraded");
  assert.equal(degraded.poll.consecutive_failures, 2);
  assert.equal(degraded.poll.retry_delay_ms, 10_000);
  assert.equal(degraded.poll.next_attempt_at, "2026-01-01T00:00:12.000Z");

  tracker.recordPollSuccess(4, new Date("2026-01-01T00:00:20Z"));
  const recovered = tracker.snapshot();
  assert.equal(recovered.state, "healthy");
  assert.equal(recovered.poll.consecutive_failures, 0);
  assert.equal(recovered.poll.last_successful_poll_at, "2026-01-01T00:00:20.000Z");
  assert.equal(recovered.poll.last_update_at, "2026-01-01T00:00:20.000Z");
  assert.equal("retry_delay_ms" in recovered.poll, false);
  assert.equal("next_attempt_at" in recovered.poll, false);
});

test("worker failures track per-worker retry state and success clears stale retry indicators", () => {
  const tracker = new SupervisorHealthTracker({
    now: clock("2026-01-01T00:00:00Z")
  });
  const key = "account/consulting#42";
  assert.equal(tracker.recordWorkerSpawnFailure(key, undefined, new Date("2026-01-01T00:00:01Z")), 5_000);
  assert.equal(tracker.recordWorkerSpawnFailure(key, undefined, new Date("2026-01-01T00:00:02Z")), 10_000);
  tracker.recordWorkerSpawnFailure("account/consulting#99", undefined, new Date("2026-01-01T00:00:03Z"));

  const degraded = tracker.snapshot();
  assert.equal(degraded.state, "degraded");
  assert.deepEqual(degraded.workers.map((worker) => worker.worker_key), [
    "account/consulting#42",
    "account/consulting#99"
  ]);
  assert.equal(degraded.workers[0].consecutive_failures, 2);
  assert.equal(degraded.workers[0].retry_delay_ms, 10_000);

  tracker.recordWorkerSpawnSuccess(key, new Date("2026-01-01T00:00:20Z"));
  const partial = tracker.snapshot();
  const recovered = partial.workers.find((worker) => worker.worker_key === key);
  assert.equal(recovered.consecutive_failures, 0);
  assert.equal("retry_delay_ms" in recovered, false);
  assert.equal("next_attempt_at" in recovered, false);
  assert.equal(partial.state, "degraded");

  tracker.recordWorkerSpawnSuccess("account/consulting#99", new Date("2026-01-01T00:00:21Z"));
  assert.equal(tracker.snapshot().state, "healthy");
});

test("health snapshots expose metrics only and never accept raw error or message payloads", () => {
  const tracker = new SupervisorHealthTracker({ now: () => new Date("2026-01-01T00:00:00Z") });
  tracker.recordPollFailure(7_000, new Date("2026-01-01T00:00:01Z"));
  tracker.recordWorkerSpawnFailure("worker-42", undefined, new Date("2026-01-01T00:00:02Z"));
  const json = JSON.stringify(tracker.snapshot());
  assert.equal(json.includes("token"), false);
  assert.equal(json.includes("message"), false);
  assert.equal(json.includes("error"), false);
  assert.deepEqual(Object.keys(tracker.snapshot()).sort(), ["poll", "started_at", "state", "updated_at", "version", "workers"]);
});

test("snapshot copies cannot mutate tracker state", () => {
  const tracker = new SupervisorHealthTracker({ now: () => new Date("2026-01-01T00:00:00Z") });
  tracker.recordWorkerSpawnFailure("worker-1");
  const first = tracker.snapshot();
  first.poll.consecutive_failures = 99;
  first.workers[0].consecutive_failures = 99;
  const second = tracker.snapshot();
  assert.equal(second.poll.consecutive_failures, 0);
  assert.equal(second.workers[0].consecutive_failures, 1);
});

test("atomic JSON sink writes a private complete snapshot and leaves no temp file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-coordinator-health-"));
  const path = join(dir, "supervisor-health.json");
  const tracker = new SupervisorHealthTracker({ now: () => new Date("2026-01-01T00:00:00Z") });
  tracker.recordWorkerSpawnFailure("worker-1", undefined, new Date("2026-01-01T00:00:01Z"));
  const sink = new AtomicJsonFileHealthSink(path);
  const expected = await tracker.publish(sink);
  const actual = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(actual, expected);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(dir)).sort(), ["supervisor-health.json"]);
});

test("health tracker supports a pluggable sink", async () => {
  const writes = [];
  const tracker = new SupervisorHealthTracker({ now: () => new Date("2026-01-01T00:00:00Z") });
  await tracker.publish({ write: async (snapshot) => writes.push(snapshot) });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].state, "healthy");
});
