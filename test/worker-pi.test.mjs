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

import {
  PiWorkerBackend,
  buildPiWorkerProcessSpec,
  prepareRemotePiSandbox
} from "../dist/packages/worker-pi/index.js";

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


const piSandboxSpec = {
  sandbox_id: "sandbox-task-1-exec-1",
  task_id: "task-1",
  execution_id: "exec-1",
  capabilities: {
    workspace: { workspace_id: "workspace-1", guest_path: "/workspace", access: "read_write" },
    network: { mode: "none" }
  }
};

test("Pi remote sandbox preparation depends on SandboxBackend and never derives manager paths", async () => {
  const seen = [];
  const backend = {
    async create(spec) {
      seen.push(structuredClone(spec));
      return {
        sandbox_id: spec.sandbox_id, task_id: spec.task_id, execution_id: spec.execution_id,
        state: "ready", updated_at: "2026-01-01T00:00:00.000Z"
      };
    },
    async inspect() { return undefined; },
    async waitUntilReady() { throw new Error("not used"); },
    async destroy() {}
  };
  const privateBinding = { ...binding, workspace: "/manager/private/task-1" };
  const lease = await prepareRemotePiSandbox(privateBinding, backend, piSandboxSpec);
  assert.equal(lease.host_tool_fallback, false);
  assert.equal(JSON.stringify(seen).includes(privateBinding.workspace), false);
  assert.equal(seen[0].capabilities.workspace.workspace_id, "workspace-1");
});

test("Pi remote sandbox preparation rejects task/execution mismatch before backend create", async () => {
  let creates = 0;
  const backend = {
    async create() { creates += 1; throw new Error("must not run"); },
    async inspect() { return undefined; },
    async waitUntilReady() { throw new Error("must not run"); },
    async destroy() {}
  };
  await assert.rejects(
    () => prepareRemotePiSandbox(binding, backend, { ...piSandboxSpec, execution_id: "other-exec" }),
    /execution_id must match worker execution_id/
  );
  assert.equal(creates, 0);
});

test("Pi remote sandbox preparation fails closed when backend reports failure", async () => {
  const backend = {
    async create(spec) {
      return {
        sandbox_id: spec.sandbox_id, task_id: spec.task_id, execution_id: spec.execution_id,
        state: "failed", updated_at: "2026-01-01T00:00:00.000Z", reason_code: "BOOT_FAILED"
      };
    },
    async inspect() { return undefined; },
    async waitUntilReady() { throw new Error("must not run after terminal failure"); },
    async destroy() {}
  };
  await assert.rejects(
    () => prepareRemotePiSandbox(binding, backend, piSandboxSpec),
    /host tool fallback is disabled/
  );
});
