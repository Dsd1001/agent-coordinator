import assert from "node:assert/strict";
import test from "node:test";

import {
  SandboxUnavailableError,
  acquireReadySandbox,
  inspectReadySandbox,
  validateSandboxSpec
} from "../dist/packages/sandbox/index.js";

function spec(overrides = {}) {
  return {
    sandbox_id: "sandbox-1",
    task_id: "task-1",
    execution_id: "exec-1",
    capabilities: {
      workspace: {
        workspace_id: "workspace-1",
        guest_path: "/workspace/",
        access: "read_write"
      },
      network: { mode: "restricted", allowed_hosts: ["API.Example.COM"] }
    },
    ...overrides
  };
}

function status(state, overrides = {}) {
  return {
    sandbox_id: "sandbox-1",
    task_id: "task-1",
    execution_id: "exec-1",
    state,
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

test("sandbox descriptors normalize logical capabilities without host paths", () => {
  const value = validateSandboxSpec(spec());
  assert.equal(value.capabilities.workspace.guest_path, "/workspace");
  assert.deepEqual(value.capabilities.network, {
    mode: "restricted",
    allowed_hosts: ["api.example.com"]
  });
  const json = JSON.stringify(value);
  assert.equal(json.includes("host_path"), false);
  assert.equal(json.includes("secret"), false);
  assert.equal(json.includes("token"), false);
});

test("sandbox descriptors reject host paths, secret fields, traversal, and unsafe network entries", () => {
  assert.throws(
    () => validateSandboxSpec({ ...spec(), host_path: "/manager/private" }),
    /unsupported field host_path/
  );
  const forbiddenField = "se" + "cret";
  assert.throws(
    () => validateSandboxSpec({ ...spec(), [forbiddenField]: "do-not-accept" }),
    new RegExp(`unsupported field ${forbiddenField}`)
  );
  assert.throws(
    () => validateSandboxSpec({
      ...spec(),
      capabilities: {
        ...spec().capabilities,
        workspace: { ...spec().capabilities.workspace, guest_path: "/workspace/../manager" }
      }
    }),
    /normalized absolute guest path/
  );
  assert.throws(
    () => validateSandboxSpec({
      ...spec(),
      capabilities: {
        ...spec().capabilities,
        workspace: { ...spec().capabilities.workspace, guest_path: "/workspace//nested" }
      }
    }),
    /normalized absolute guest path/
  );
  assert.throws(
    () => validateSandboxSpec({
      ...spec(),
      capabilities: {
        ...spec().capabilities,
        network: { mode: "restricted", allowed_hosts: ["https://example.com/api"] }
      }
    }),
    /hostname, not a URL or path/
  );
  assert.throws(
    () => validateSandboxSpec({
      ...spec(),
      capabilities: { ...spec().capabilities, network: { mode: "restricted", allowed_hosts: [] } }
    }),
    /at least one hostname/
  );
});

test("creating sandbox waits for ready and returns a fail-closed lease", async () => {
  const calls = [];
  const backend = {
    async create(value) {
      calls.push(["create", value]);
      return status("creating");
    },
    async inspect() {
      throw new Error("not used");
    },
    async waitUntilReady(id, options) {
      calls.push(["wait", id, options]);
      return status("ready", { updated_at: "2026-01-01T00:00:01.000Z" });
    },
    async destroy() {}
  };
  const lease = await acquireReadySandbox(backend, spec(), { timeout_ms: 5_000 });
  assert.deepEqual(lease, {
    sandbox_id: "sandbox-1",
    task_id: "task-1",
    execution_id: "exec-1",
    workspace_id: "workspace-1",
    guest_path: "/workspace",
    workspace_access: "read_write",
    host_tool_fallback: false
  });
  assert.deepEqual(calls[1], ["wait", "sandbox-1", { timeout_ms: 5_000 }]);
});

test("failed or stopped sandbox fails immediately without waiting or host fallback", async () => {
  for (const stateName of ["failed", "stopped"]) {
    let waitCalls = 0;
    const backend = {
      async create() {
        return status(stateName, { reason_code: "BOOT_FAILED" });
      },
      async inspect() {
        return undefined;
      },
      async waitUntilReady() {
        waitCalls += 1;
        return status("ready");
      },
      async destroy() {}
    };
    await assert.rejects(
      () => acquireReadySandbox(backend, spec()),
      (error) =>
        error instanceof SandboxUnavailableError &&
        error.state === stateName &&
        error.message.includes("host tool fallback is disabled")
    );
    assert.equal(waitCalls, 0);
  }
});

test("sandbox that fails while waiting never produces a ready lease", async () => {
  const backend = {
    async create() {
      return status("creating");
    },
    async inspect() {
      return undefined;
    },
    async waitUntilReady() {
      return status("failed", { reason_code: "VM_BOOT_FAILED" });
    },
    async destroy() {}
  };
  await assert.rejects(
    () => acquireReadySandbox(backend, spec()),
    (error) => error instanceof SandboxUnavailableError && error.reason_code === "VM_BOOT_FAILED"
  );
});

test("sandbox backend identity/status is verified before a lease is returned", async () => {
  const backend = {
    async create() {
      return status("ready", { execution_id: "wrong-exec" });
    },
    async inspect() {
      return undefined;
    },
    async waitUntilReady() {
      throw new Error("not used");
    },
    async destroy() {}
  };
  await assert.rejects(() => acquireReadySandbox(backend, spec()), /mismatched execution_id/);

  const invalidState = {
    ...backend,
    create: async () => status("invented")
  };
  await assert.rejects(() => acquireReadySandbox(invalidState, spec()), /invalid state/);
});

test("ready options are validated before sandbox creation", async () => {
  let creates = 0;
  const backend = {
    async create() {
      creates += 1;
      return status("ready");
    },
    async inspect() {
      return undefined;
    },
    async waitUntilReady() {
      return status("ready");
    },
    async destroy() {}
  };
  await assert.rejects(() => acquireReadySandbox(backend, spec(), { timeout_ms: -1 }), /non-negative safe integer/);
  assert.equal(creates, 0);
});

test("inspectReadySandbox fails closed for absent and unready state", async () => {
  const absent = {
    async create() { return status("ready"); },
    async inspect() { return undefined; },
    async waitUntilReady() { return status("ready"); },
    async destroy() {}
  };
  await assert.rejects(
    () => inspectReadySandbox(absent, spec()),
    (error) => error instanceof SandboxUnavailableError && error.state === "absent"
  );

  const creating = { ...absent, inspect: async () => status("creating") };
  await assert.rejects(
    () => inspectReadySandbox(creating, spec()),
    (error) => error instanceof SandboxUnavailableError && error.state === "creating"
  );
});
