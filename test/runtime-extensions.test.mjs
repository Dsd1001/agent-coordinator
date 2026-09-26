import assert from "node:assert/strict";
import test from "node:test";

import {
  PROGRESS_SINK_POINT,
  PROTOCOL_VERSION,
  RECOVERY_POLICY_POINT,
  RESULT_PUBLISHER_POINT,
  STEERING_POLICY_POINT,
  TASK_ANNOTATION_STORE_POINT,
  WORKER_CONTROL_POINT,
  ExtensionRegistry
} from "../dist/packages/extension-api/index.js";
import {
  BoundedFinalRepairPolicy,
  decideBoundedFinalRepair
} from "../dist/packages/recovery-bounded-final-repair/index.js";

function manifest(id, provides) {
  return { id, version: "0.1.1", api_version: "0.1.0", protocol_version: "0.1.0", provides };
}

test("0.1.1 runtime extension points register without changing the 0.1 protocol", async () => {
  assert.equal(PROTOCOL_VERSION, "0.1.0");
  const registry = new ExtensionRegistry();
  const providers = {
    progress: { async publish() {} },
    control: { async steer(input) { return { steering_id: input.steering_id, task_id: input.task_id, execution_id: input.execution_id, accepted_at: "2026-09-27T00:00:00Z" }; } },
    steering: { async authorize() { return { allowed: true, reason: "test" }; } },
    annotations: { async append() {}, async list() { return []; } },
    recovery: new BoundedFinalRepairPolicy(),
    publisher: { async publish(input) { return { publication_id: input.publication_id, state: "confirmed", confirmed_at: "2026-09-27T00:00:00Z" }; }, async inspect() { return undefined; } }
  };
  const declarations = [
    [PROGRESS_SINK_POINT, "progress", providers.progress],
    [WORKER_CONTROL_POINT, "control", providers.control],
    [STEERING_POLICY_POINT, "steering", providers.steering],
    [TASK_ANNOTATION_STORE_POINT, "annotations", providers.annotations],
    [RECOVERY_POLICY_POINT, "recovery", providers.recovery],
    [RESULT_PUBLISHER_POINT, "publisher", providers.publisher]
  ];
  await registry.install({
    manifest: manifest("example.runtime", declarations.map(([point, name]) => ({ point: point.id, name }))),
    register(registrar) {
      for (const [point, name, value] of declarations) registrar.provide(point, name, value);
    }
  });
  for (const [point, name, value] of declarations) assert.equal(registry.require(point, name), value);
});

test("bounded final repair uses normal retry budget before the limit", () => {
  const decision = decideBoundedFinalRepair({
    task_id: "t1",
    execution_id: "e1",
    attempt: 2,
    max_attempts: 3,
    prior_actions: [],
    review: { verdict: "rework", classification: "substantive", findings: [] }
  });
  assert.deepEqual(decision, { action: "retry", reason: "normal retry budget remains" });
});

test("bounded blocking findings unlock exactly one scope-locked final repair", () => {
  const decision = decideBoundedFinalRepair({
    task_id: "t1",
    execution_id: "e3",
    attempt: 3,
    max_attempts: 3,
    prior_actions: [],
    review: {
      verdict: "rework",
      classification: "bounded",
      findings: [
        { id: "F1", severity: "blocking", type: "evidence", requirement: "align evidence ids" },
        { id: "F2", severity: "advisory", type: "style", requirement: "tighten wording" },
        { id: "F3", severity: "blocking", type: "format", requirement: "fix final layout" }
      ]
    }
  });
  assert.equal(decision.action, "repair");
  assert.deepEqual(decision.scope_finding_ids, ["F1", "F3"]);
});

test("final repair escalates after use or without bounded blocking findings", () => {
  const base = {
    task_id: "t1",
    execution_id: "e3",
    attempt: 3,
    max_attempts: 3,
    review: { verdict: "rework", classification: "bounded", findings: [] }
  };
  assert.equal(decideBoundedFinalRepair({ ...base, prior_actions: [] }).action, "escalate");
  assert.equal(
    decideBoundedFinalRepair({
      ...base,
      prior_actions: ["repair"],
      review: { ...base.review, findings: [{ id: "F1", severity: "blocking", type: "format", requirement: "fix" }] }
    }).action,
    "escalate"
  );
});

test("bounded final repair rejects invalid retry counters", () => {
  assert.throws(
    () => decideBoundedFinalRepair({
      task_id: "t1", execution_id: "e1", attempt: 4, max_attempts: 3, prior_actions: [],
      review: { verdict: "rework", classification: "bounded", findings: [] }
    }),
    /attempt cannot exceed/
  );
});
