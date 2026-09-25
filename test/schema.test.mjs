import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function schema(name) {
  return JSON.parse(await readFile(new URL(`../schemas/${name}`, import.meta.url), "utf8"));
}

test("task schema exposes only the stable transport-neutral room_id", async () => {
  const task = await schema("task-envelope.schema.json");
  assert.deepEqual(task.properties.room_id.type, ["string", "null"]);
  assert.equal("topic_id" in task.properties, false);
});

test("task schema ArtifactRef fields stay aligned with the TypeScript contract", async () => {
  const task = await schema("task-envelope.schema.json");
  const artifact = task.properties.inputs.items;
  assert.equal(artifact.additionalProperties, false);
  assert.deepEqual(artifact.required, ["path", "sha256"]);
  assert.equal(artifact.properties.description.type, "string");
  assert.equal(artifact.properties.sha256.pattern, "^[a-f0-9]{64}$");
});

test("0.1 public schemas use stable versioned ids", async () => {
  for (const name of [
    "task-envelope.schema.json",
    "delivery-envelope.schema.json",
    "coordination-event.schema.json",
    "extension-manifest.schema.json",
    "resource-quota-policy.schema.json"
  ]) {
    const value = await schema(name);
    assert.match(value.$id, /\/schemas\/0\.1\//);
  }
});

test("resource quota schema matches the 0.1 policy surface", async () => {
  const value = await schema("resource-quota-policy.schema.json");
  assert.deepEqual(value.required, [
    "max_active_executions",
    "max_active_per_worker",
    "max_queued_executions",
    "max_execution_ms",
    "max_memory_mb",
    "max_artifact_count",
    "max_total_artifact_bytes"
  ]);
  assert.equal(value.additionalProperties, false);
});


test("coordination event schema freezes the stable 0.1 event vocabulary", async () => {
  const value = await schema("coordination-event.schema.json");
  assert.deepEqual(value.properties.type.enum, [
    "task.prepared",
    "room.created",
    "input.attached",
    "dispatch.requested",
    "dispatch.confirmed",
    "worker.started",
    "worker.blocked",
    "worker.failed",
    "delivery.observed",
    "review.rework",
    "review.resume",
    "review.accepted",
    "task.cancelled",
    "room.closed",
    "reconciliation.recorded"
  ]);
});
