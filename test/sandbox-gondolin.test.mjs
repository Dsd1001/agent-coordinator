import assert from "node:assert/strict";
import test from "node:test";

import { GondolinSandboxBackend } from "../dist/packages/sandbox-gondolin/index.js";
import { acquireReadySandbox } from "../dist/packages/sandbox/index.js";

function spec() {
  return {
    sandbox_id: "sandbox-1",
    task_id: "task-1",
    execution_id: "exec-1",
    capabilities: {
      workspace: { workspace_id: "workspace-1", guest_path: "/workspace", access: "read_write" },
      network: { mode: "none" }
    }
  };
}

class FakeGondolinRuntime {
  requests = [];
  destroyed = [];
  states = new Map();

  async create(request) {
    this.requests.push(structuredClone(request));
    let current = this.states.get(request.sandbox_id);
    if (!current) {
      current = {
        runtime_id: request.sandbox_id,
        task_id: request.task_id,
        execution_id: request.execution_id,
        state: "creating",
        updated_at: "2026-01-01T00:00:00.000Z"
      };
      this.states.set(request.sandbox_id, current);
    }
    return { ...current };
  }

  async inspect(runtimeId) {
    const current = this.states.get(runtimeId);
    return current ? { ...current } : undefined;
  }

  async waitUntilReady(runtimeId) {
    const current = this.states.get(runtimeId);
    if (!current) throw new Error("runtime missing");
    const ready = { ...current, state: "ready", updated_at: "2026-01-01T00:00:01.000Z" };
    this.states.set(runtimeId, ready);
    return { ...ready };
  }

  async destroy(runtimeId, reason) {
    this.destroyed.push([runtimeId, reason]);
    this.states.delete(runtimeId);
  }
}

test("Gondolin adapter maps only logical sandbox capabilities", async () => {
  const runtime = new FakeGondolinRuntime();
  const backend = new GondolinSandboxBackend(runtime);
  const lease = await acquireReadySandbox(backend, spec());
  assert.equal(lease.host_tool_fallback, false);
  assert.deepEqual(runtime.requests[0], {
    sandbox_id: "sandbox-1",
    task_id: "task-1",
    execution_id: "exec-1",
    workspace_id: "workspace-1",
    guest_workspace: "/workspace",
    workspace_access: "read_write",
    network: { mode: "none" }
  });
  const requestJson = JSON.stringify(runtime.requests[0]);
  assert.equal(requestJson.includes("host_path"), false);
  assert.equal(requestJson.includes("token"), false);
  assert.equal(requestJson.includes("secret"), false);
});

test("a new Gondolin adapter instance can inspect an existing runtime after restart", async () => {
  const runtime = new FakeGondolinRuntime();
  const first = new GondolinSandboxBackend(runtime);
  await acquireReadySandbox(first, spec());

  const afterRestart = new GondolinSandboxBackend(runtime);
  assert.deepEqual(await afterRestart.inspect("sandbox-1"), {
    sandbox_id: "sandbox-1",
    task_id: "task-1",
    execution_id: "exec-1",
    state: "ready",
    updated_at: "2026-01-01T00:00:01.000Z"
  });
});

test("Gondolin teardown is safely repeatable when runtime destroy is idempotent", async () => {
  const runtime = new FakeGondolinRuntime();
  const backend = new GondolinSandboxBackend(runtime);
  await acquireReadySandbox(backend, spec());
  await backend.destroy("sandbox-1", "done");
  await backend.destroy("sandbox-1", "done-again");
  assert.deepEqual(runtime.destroyed, [
    ["sandbox-1", "done"],
    ["sandbox-1", "done-again"]
  ]);
  assert.equal(await backend.inspect("sandbox-1"), undefined);
});

test("Gondolin adapter rejects runtime identity and unsafe reason-code output", async () => {
  const mismatch = {
    async create(request) {
      return {
        runtime_id: "other-runtime",
        task_id: request.task_id,
        execution_id: request.execution_id,
        state: "ready",
        updated_at: "2026-01-01T00:00:00.000Z"
      };
    },
    async inspect() { return undefined; },
    async waitUntilReady() { throw new Error("not used"); },
    async destroy() {}
  };
  await assert.rejects(() => new GondolinSandboxBackend(mismatch).create(spec()), /mismatched runtime_id/);

  const unsafe = {
    ...mismatch,
    async create(request) {
      return {
        runtime_id: request.sandbox_id,
        task_id: request.task_id,
        execution_id: request.execution_id,
        state: "failed",
        updated_at: "2026-01-01T00:00:00.000Z",
        reason_code: "provider token leaked here"
      };
    }
  };
  await assert.rejects(() => new GondolinSandboxBackend(unsafe).create(spec()), /invalid reason_code/);
});
