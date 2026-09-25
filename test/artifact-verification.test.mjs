import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertDeliveryReadyForAcceptance,
  validateArtifactRefs,
  verifyArtifactRefs,
  verifyDeliveryForAcceptance
} from "../dist/packages/core/index.js";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function workspace() {
  return mkdtemp(join(tmpdir(), "agent-coordinator-artifacts-"));
}

function binding() {
  return {
    task_id: "task-1",
    execution_id: "exec-1",
    channel_id: "chat-1",
    room_id: "42",
    worker_sender_id: "worker-uid"
  };
}

function observed(artifacts, overrides = {}) {
  return {
    payload: {
      task_id: "task-1",
      execution_id: "exec-1",
      status: "delivered",
      summary: "complete",
      artifacts,
      checks: [{ name: "worker-test", result: "passed" }],
      limitations: [],
      ...(overrides.payload ?? {})
    },
    channel_id: "chat-1",
    room_id: "42",
    sender_id: "worker-uid",
    delivery_id: "delivery-1",
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "payload"))
  };
}

test("valid artifact manifests verify deterministic SHA-256 and size", async () => {
  const root = await workspace();
  await mkdir(join(root, "out"));
  const content = Buffer.from("verified output\n");
  await writeFile(join(root, "out", "result.txt"), content);
  const artifact = { path: "out/result.txt", sha256: sha256(content), description: "result" };

  const first = await verifyArtifactRefs(root, [artifact]);
  const second = await verifyArtifactRefs(root, [artifact]);
  assert.equal(first.ok, true);
  assert.deepEqual(first, second);
  assert.equal(first.artifacts[0].result, "passed");
  assert.equal(first.artifacts[0].actual_sha256, artifact.sha256);
  assert.equal(first.artifacts[0].size, content.length);
});

test("mutated and missing artifacts fail verification", async () => {
  const root = await workspace();
  await writeFile(join(root, "result.txt"), "mutated");

  const mutated = await verifyArtifactRefs(root, [
    { path: "result.txt", sha256: sha256("original") }
  ]);
  assert.equal(mutated.ok, false);
  assert.equal(mutated.artifacts[0].detail, "sha256 mismatch");

  const missing = await verifyArtifactRefs(root, [
    { path: "missing.txt", sha256: sha256("anything") }
  ]);
  assert.equal(missing.ok, false);
  assert.equal(missing.artifacts[0].detail, "artifact file is missing");
});

test("unsafe, malformed, and duplicate manifest entries are rejected before file IO", async () => {
  const digest = "a".repeat(64);
  const checks = validateArtifactRefs([
    { path: "../escape.txt", sha256: digest },
    { path: "/absolute.txt", sha256: digest },
    { path: "C:/windows.txt", sha256: digest },
    { path: "nested\\windows.txt", sha256: digest },
    { path: "duplicate.txt", sha256: "BAD" },
    { path: "duplicate.txt", sha256: digest }
  ]);
  assert.equal(checks.every((check) => check.result === "failed"), true);

  const root = await workspace();
  const report = await verifyArtifactRefs(root, [
    { path: "../escape.txt", sha256: digest },
    { path: "duplicate.txt", sha256: digest },
    { path: "duplicate.txt", sha256: digest }
  ]);
  assert.equal(report.ok, false);
  assert.equal(report.artifacts[0].result, "failed");
  assert.equal(report.artifacts[1].result, "not_run");
  assert.equal(report.artifacts[2].result, "failed");
});

test("symbolic links cannot escape or alias artifact verification", async () => {
  const root = await workspace();
  const outside = await workspace();
  await writeFile(join(outside, "secret.txt"), "outside");
  await symlink(join(outside, "secret.txt"), join(root, "linked.txt"));
  await symlink(outside, join(root, "linked-dir"));

  const fileLink = await verifyArtifactRefs(root, [
    { path: "linked.txt", sha256: sha256("outside") }
  ]);
  assert.equal(fileLink.ok, false);
  assert.equal(fileLink.artifacts[0].detail, "symbolic links are not allowed in artifact paths");

  const dirLink = await verifyArtifactRefs(root, [
    { path: "linked-dir/secret.txt", sha256: sha256("outside") }
  ]);
  assert.equal(dirLink.ok, false);
  assert.equal(dirLink.artifacts[0].detail, "symbolic links are not allowed in artifact paths");
});

test("delivery acceptance verifies identity before touching the workspace", async () => {
  const badIdentity = observed([], { sender_id: "attacker-uid" });
  await assert.rejects(
    () => verifyDeliveryForAcceptance(binding(), badIdentity, "/definitely/not/a/workspace"),
    /worker sender mismatch/
  );
});

test("delivery acceptance requires delivered status, declared checks, and artifacts to pass", async () => {
  const root = await workspace();
  const content = "approved";
  await writeFile(join(root, "result.txt"), content);
  const artifact = { path: "result.txt", sha256: sha256(content) };

  const ok = await verifyDeliveryForAcceptance(binding(), observed([artifact]), root);
  assert.equal(ok.ok, true);
  assert.equal(ok.identity_verified, true);

  const blocked = await verifyDeliveryForAcceptance(
    binding(),
    observed([artifact], { payload: { status: "blocked" } }),
    root
  );
  assert.equal(blocked.ok, false);
  assert.equal(blocked.checks.find((check) => check.name === "delivery.status")?.result, "failed");

  const failedCheck = await verifyDeliveryForAcceptance(
    binding(),
    observed([artifact], { payload: { checks: [{ name: "worker-test", result: "failed" }] } }),
    root
  );
  assert.equal(failedCheck.ok, false);
  assert.equal(
    failedCheck.checks.find((check) => check.name === "delivery.declared_checks")?.result,
    "failed"
  );

  await assert.rejects(
    () => assertDeliveryReadyForAcceptance(binding(), observed([
      { path: "result.txt", sha256: sha256("wrong") }
    ]), root),
    /delivery verification failed: artifact\[0\]\.sha256/
  );
});

test("artifact quotas reject excessive count before file IO", async () => {
  const root = await workspace();
  const report = await verifyArtifactRefs(
    root,
    [
      { path: "missing-1.txt", sha256: "a".repeat(64) },
      { path: "missing-2.txt", sha256: "b".repeat(64) }
    ],
    { max_artifact_count: 1 }
  );
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((check) => check.name === "artifact.quota.count")?.result, "failed");
  assert.equal(report.artifacts.every((artifact) => artifact.result === "not_run"), true);
});

test("artifact quotas enforce total verified bytes and stop later verification", async () => {
  const root = await workspace();
  await writeFile(join(root, "a.txt"), "123456");
  await writeFile(join(root, "b.txt"), "abcdef");
  const report = await verifyArtifactRefs(
    root,
    [
      { path: "a.txt", sha256: sha256("123456") },
      { path: "b.txt", sha256: sha256("abcdef") }
    ],
    { max_total_artifact_bytes: 5 }
  );
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((check) => check.name === "artifact.quota.bytes")?.result, "failed");
  assert.equal(report.artifacts[0].result, "failed");
  assert.equal(report.artifacts[0].detail, "artifact exceeds remaining byte quota");
  assert.equal(report.artifacts[1].result, "not_run");
});
