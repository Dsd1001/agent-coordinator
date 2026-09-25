import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function schema(name) {
  return JSON.parse(await readFile(new URL(`../schemas/${name}`, import.meta.url), "utf8"));
}

test("task schema exposes generic room_id while retaining topic_id compatibility", async () => {
  const task = await schema("task-envelope.schema.json");
  assert.deepEqual(task.properties.room_id.type, ["string", "null"]);
  assert.deepEqual(task.properties.topic_id.type, ["string", "null"]);
});

test("task schema ArtifactRef fields stay aligned with the TypeScript contract", async () => {
  const task = await schema("task-envelope.schema.json");
  const artifact = task.properties.inputs.items;
  assert.equal(artifact.additionalProperties, false);
  assert.deepEqual(artifact.required, ["path", "sha256"]);
  assert.equal(artifact.properties.description.type, "string");
  assert.equal(artifact.properties.sha256.pattern, "^[a-f0-9]{64}$");
});
