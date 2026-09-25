import assert from "node:assert/strict";
import test from "node:test";

import {
  REMOTE_WORKER_SANDBOX_POLICY,
  assertRemoteWorkerSandboxReady,
  canUseHostTools
} from "../dist/packages/worker-pi/index.js";

test("remote worker policy is fail-closed", () => {
  assert.equal(REMOTE_WORKER_SANDBOX_POLICY.fail_closed, true);
  assert.equal(REMOTE_WORKER_SANDBOX_POLICY.allow_host_tool_fallback, false);
  assert.throws(() => assertRemoteWorkerSandboxReady(true, false), /host tool fallback is disabled/);
  assert.doesNotThrow(() => assertRemoteWorkerSandboxReady(true, true));
});

test("remote workers never use host tools", () => {
  assert.equal(canUseHostTools(true, true), false);
  assert.equal(canUseHostTools(true, false), false);
  assert.equal(canUseHostTools(false, false), true);
});

import { PiWorkerBackend, buildPiWorkerProcessSpec } from "../dist/packages/worker-pi/index.js";

const runtime = {
  pi_binary: "/usr/local/bin/pi",
  provider: "example-provider",
  model: "example-model:low",
  extension_path: "/opt/agent-coordinator/pi-chat/index.ts",
  home: "/var/lib/agent-worker",
  session_root: "/var/lib/agent-worker/sessions",
  cwd: "/var/lib/agent-worker"
};

const binding = {
  task_id: "task-1",
  execution_id: "exec-1",
  conversation_id: "account/consulting#42",
  workspace: "/var/lib/agent-worker/workspaces/task-1"
};

test("Pi launch spec uses argv boundaries and binds the remote conversation", () => {
  const spec = buildPiWorkerProcessSpec(binding, runtime);
  assert.equal(spec.command, "/usr/local/bin/pi");
  assert.equal(spec.env.HOME, "/var/lib/agent-worker");
  assert.deepEqual(spec.args.slice(-2), ["--chat-conversation", "account/consulting#42"]);
  assert.ok(spec.args.includes("account_consulting_42"));
  assert.ok(!spec.args.some((value) => value.includes(";")));
});

test("Pi launch spec rejects relative runtime paths", () => {
  assert.throws(
    () => buildPiWorkerProcessSpec(binding, { ...runtime, pi_binary: "pi" }),
    /absolute path/
  );
});

test("Pi backend delegates lifecycle to a process manager without a shell", async () => {
  const calls = [];
  const manager = {
    async start(spec) {
      calls.push(spec);
      return { worker_id: spec.worker_id, started_at: "2026-01-01T00:00:00Z" };
    },
    async inspect(worker_id) {
      return { state: "running", worker_id, updated_at: "2026-01-01T00:00:01Z" };
    },
    async stop(worker_id, reason) {
      calls.push({ worker_id, reason });
    }
  };
  const backend = new PiWorkerBackend(runtime, manager);
  const started = await backend.start(binding);
  assert.equal(started.state, "starting");
  assert.equal((await backend.inspect(started.worker_id)).state, "running");
  await backend.stop(started.worker_id, "done");
  assert.equal(calls.length, 2);
});
