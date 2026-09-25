import {
  type SandboxBackend,
  type SandboxReadyOptions,
  type SandboxSpec,
  type SandboxState,
  type SandboxStatus,
  validateSandboxSpec
} from "../sandbox/index.js";

export interface GondolinSandboxRequest {
  sandbox_id: string;
  task_id: string;
  execution_id: string;
  workspace_id: string;
  guest_workspace: string;
  workspace_access: "read_only" | "read_write";
  network: { mode: "none" } | { mode: "restricted"; allowed_hosts: string[] };
}

export interface GondolinRuntimeStatus {
  runtime_id: string;
  task_id: string;
  execution_id: string;
  state: SandboxState;
  updated_at: string;
  reason_code?: string;
}

export interface GondolinRuntime {
  /** Idempotently ensure a runtime exists for request.sandbox_id. */
  create(request: GondolinSandboxRequest): Promise<GondolinRuntimeStatus>;
  inspect(runtimeId: string): Promise<GondolinRuntimeStatus | undefined>;
  waitUntilReady(runtimeId: string, options?: SandboxReadyOptions): Promise<GondolinRuntimeStatus>;
  /** Idempotent runtime teardown. */
  destroy(runtimeId: string, reason?: string): Promise<void>;
}

function requestFor(spec: SandboxSpec): GondolinSandboxRequest {
  return {
    sandbox_id: spec.sandbox_id,
    task_id: spec.task_id,
    execution_id: spec.execution_id,
    workspace_id: spec.capabilities.workspace.workspace_id,
    guest_workspace: spec.capabilities.workspace.guest_path,
    workspace_access: spec.capabilities.workspace.access,
    network: spec.capabilities.network
  };
}


function validateRuntimeStatus(status: GondolinRuntimeStatus): GondolinRuntimeStatus {
  if (!status.runtime_id.trim() || !status.task_id.trim() || !status.execution_id.trim()) {
    throw new Error("Gondolin runtime returned incomplete identity");
  }
  if (!["creating", "ready", "stopped", "failed"].includes(status.state)) {
    throw new Error("Gondolin runtime returned invalid state");
  }
  if (!Number.isFinite(Date.parse(status.updated_at))) {
    throw new Error("Gondolin runtime returned invalid updated_at");
  }
  if (status.reason_code !== undefined && !/^[A-Za-z0-9._:-]{1,96}$/.test(status.reason_code)) {
    throw new Error("Gondolin runtime returned invalid reason_code");
  }
  return status;
}

function statusFor(input: GondolinRuntimeStatus): SandboxStatus {
  const status = validateRuntimeStatus(input);
  return {
    sandbox_id: status.runtime_id,
    task_id: status.task_id,
    execution_id: status.execution_id,
    state: status.state,
    updated_at: status.updated_at,
    ...(status.reason_code === undefined ? {} : { reason_code: status.reason_code })
  };
}

export class GondolinSandboxBackend implements SandboxBackend {
  readonly #runtime: GondolinRuntime;

  constructor(runtime: GondolinRuntime) {
    this.#runtime = runtime;
  }

  async create(input: SandboxSpec): Promise<SandboxStatus> {
    const spec = validateSandboxSpec(input);
    const status = statusFor(await this.#runtime.create(requestFor(spec)));
    if (status.sandbox_id !== spec.sandbox_id) throw new Error("Gondolin runtime returned mismatched runtime_id");
    if (status.task_id !== spec.task_id) throw new Error("Gondolin runtime returned mismatched task_id");
    if (status.execution_id !== spec.execution_id) throw new Error("Gondolin runtime returned mismatched execution_id");
    return status;
  }

  async inspect(sandboxId: string): Promise<SandboxStatus | undefined> {
    const status = await this.#runtime.inspect(sandboxId);
    if (!status) return undefined;
    if (status.runtime_id !== sandboxId) throw new Error("Gondolin runtime returned mismatched runtime_id");
    return statusFor(status);
  }

  async waitUntilReady(sandboxId: string, options?: SandboxReadyOptions): Promise<SandboxStatus> {
    const status = await this.#runtime.waitUntilReady(sandboxId, options);
    if (status.runtime_id !== sandboxId) throw new Error("Gondolin runtime returned mismatched runtime_id");
    return statusFor(status);
  }

  async destroy(sandboxId: string, reason?: string): Promise<void> {
    await this.#runtime.destroy(sandboxId, reason);
  }
}
