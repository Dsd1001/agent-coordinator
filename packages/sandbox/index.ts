export type SandboxState = "creating" | "ready" | "stopped" | "failed";

export interface SandboxWorkspacePolicy {
  workspace_id: string;
  guest_path: string;
  access: "read_only" | "read_write";
}

export type SandboxNetworkPolicy =
  | { mode: "none" }
  | { mode: "restricted"; allowed_hosts: string[] };

export interface SandboxCapabilities {
  workspace: SandboxWorkspacePolicy;
  network: SandboxNetworkPolicy;
}

export interface SandboxSpec {
  sandbox_id: string;
  task_id: string;
  execution_id: string;
  capabilities: SandboxCapabilities;
}

export interface SandboxStatus {
  sandbox_id: string;
  task_id: string;
  execution_id: string;
  state: SandboxState;
  updated_at: string;
  reason_code?: string;
}

export interface ReadySandboxLease {
  sandbox_id: string;
  task_id: string;
  execution_id: string;
  workspace_id: string;
  guest_path: string;
  workspace_access: "read_only" | "read_write";
  host_tool_fallback: false;
}

export interface SandboxReadyOptions {
  timeout_ms?: number;
}

export interface SandboxBackend {
  /** Ensure the stable sandbox identity exists. Implementations must make this idempotent by sandbox_id. */
  create(spec: SandboxSpec): Promise<SandboxStatus>;
  inspect(sandboxId: string): Promise<SandboxStatus | undefined>;
  /** Wait for a creating sandbox to become ready, failed, stopped, or time out. */
  waitUntilReady(sandboxId: string, options?: SandboxReadyOptions): Promise<SandboxStatus>;
  /** Idempotent teardown: destroying an already absent/stopped sandbox must not recreate or restart it. */
  destroy(sandboxId: string, reason?: string): Promise<void>;
}

export class SandboxUnavailableError extends Error {
  readonly sandbox_id: string;
  readonly state: SandboxState | "absent";
  readonly reason_code?: string;

  constructor(sandboxId: string, state: SandboxState | "absent", reasonCode?: string) {
    super(`sandbox ${sandboxId} is not ready (${state}); host tool fallback is disabled`);
    this.name = "SandboxUnavailableError";
    this.sandbox_id = sandboxId;
    this.state = state;
    this.reason_code = reasonCode;
  }
}

const ID_PATTERN = /^[A-Za-z0-9._:#/-]{1,160}$/;
const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;
const HOST_PATTERN = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?)$/;
const TOP_LEVEL_KEYS = new Set(["sandbox_id", "task_id", "execution_id", "capabilities"]);
const CAPABILITY_KEYS = new Set(["workspace", "network"]);
const WORKSPACE_KEYS = new Set(["workspace_id", "guest_path", "access"]);

function assertExactKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unsupported field ${key}`);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function validateStableId(value: unknown, label: string): string {
  const text = nonEmptyString(value, label);
  if (!ID_PATTERN.test(text)) throw new Error(`${label} contains unsupported characters`);
  return text;
}

function validateGuestPath(value: unknown): string {
  const path = nonEmptyString(value, "capabilities.workspace.guest_path");
  const segments = path.split("/").slice(1);
  if (
    !path.startsWith("/") ||
    path === "/" ||
    path.includes("\\") ||
    segments.some((segment, index) =>
      segment === "." || segment === ".." || (segment === "" && index !== segments.length - 1)
    )
  ) {
    throw new Error("capabilities.workspace.guest_path must be a normalized absolute guest path below /");
  }
  return path.replace(/\/+$/, "");
}

function validateNetwork(value: unknown): SandboxNetworkPolicy {
  const network = record(value, "capabilities.network");
  const mode = nonEmptyString(network.mode, "capabilities.network.mode");
  if (mode === "none") {
    assertExactKeys(network, new Set(["mode"]), "capabilities.network");
    return { mode: "none" };
  }
  if (mode !== "restricted") throw new Error("capabilities.network.mode must be none or restricted");
  assertExactKeys(network, new Set(["mode", "allowed_hosts"]), "capabilities.network");
  if (!Array.isArray(network.allowed_hosts)) {
    throw new Error("capabilities.network.allowed_hosts must be an array");
  }
  if (network.allowed_hosts.length === 0) {
    throw new Error("capabilities.network.allowed_hosts must contain at least one hostname");
  }
  const hosts = network.allowed_hosts.map((host, index) => {
    const text = nonEmptyString(host, `capabilities.network.allowed_hosts[${index}]`);
    if (text.includes("://") || text.includes("/") || !HOST_PATTERN.test(text)) {
      throw new Error(`capabilities.network.allowed_hosts[${index}] must be a hostname, not a URL or path`);
    }
    return text.toLowerCase();
  });
  if (new Set(hosts).size !== hosts.length) throw new Error("capabilities.network.allowed_hosts must be unique");
  return { mode: "restricted", allowed_hosts: hosts };
}

export function validateSandboxSpec(input: unknown): SandboxSpec {
  const spec = record(input, "sandbox spec");
  assertExactKeys(spec, TOP_LEVEL_KEYS, "sandbox spec");
  const capabilities = record(spec.capabilities, "capabilities");
  assertExactKeys(capabilities, CAPABILITY_KEYS, "capabilities");
  const workspace = record(capabilities.workspace, "capabilities.workspace");
  assertExactKeys(workspace, WORKSPACE_KEYS, "capabilities.workspace");

  const workspaceId = nonEmptyString(workspace.workspace_id, "capabilities.workspace.workspace_id");
  if (!WORKSPACE_ID_PATTERN.test(workspaceId)) {
    throw new Error("capabilities.workspace.workspace_id contains unsupported characters");
  }
  if (workspace.access !== "read_only" && workspace.access !== "read_write") {
    throw new Error("capabilities.workspace.access must be read_only or read_write");
  }

  return {
    sandbox_id: validateStableId(spec.sandbox_id, "sandbox_id"),
    task_id: validateStableId(spec.task_id, "task_id"),
    execution_id: validateStableId(spec.execution_id, "execution_id"),
    capabilities: {
      workspace: {
        workspace_id: workspaceId,
        guest_path: validateGuestPath(workspace.guest_path),
        access: workspace.access
      },
      network: validateNetwork(capabilities.network)
    }
  };
}

function assertStatusIdentity(spec: SandboxSpec, status: SandboxStatus): void {
  if (status.sandbox_id !== spec.sandbox_id) throw new Error("sandbox backend returned mismatched sandbox_id");
  if (status.task_id !== spec.task_id) throw new Error("sandbox backend returned mismatched task_id");
  if (status.execution_id !== spec.execution_id) throw new Error("sandbox backend returned mismatched execution_id");
  if (!["creating", "ready", "stopped", "failed"].includes(status.state)) {
    throw new Error("sandbox backend returned invalid state");
  }
  if (!Number.isFinite(Date.parse(status.updated_at))) throw new Error("sandbox backend returned invalid updated_at");
  if (status.reason_code !== undefined && !/^[A-Za-z0-9._:-]{1,96}$/.test(status.reason_code)) {
    throw new Error("sandbox backend returned invalid reason_code");
  }
}

function validateReadyOptions(options: SandboxReadyOptions): SandboxReadyOptions {
  if (options.timeout_ms === undefined) return {};
  if (!Number.isSafeInteger(options.timeout_ms) || options.timeout_ms < 0) {
    throw new Error("timeout_ms must be a non-negative safe integer");
  }
  return { timeout_ms: options.timeout_ms };
}

export async function acquireReadySandbox(
  backend: SandboxBackend,
  input: SandboxSpec,
  options: SandboxReadyOptions = {}
): Promise<ReadySandboxLease> {
  const spec = validateSandboxSpec(input);
  const readyOptions = validateReadyOptions(options);
  const created = await backend.create(spec);
  assertStatusIdentity(spec, created);
  let status = created;
  if (status.state === "creating") {
    status = await backend.waitUntilReady(spec.sandbox_id, readyOptions);
    assertStatusIdentity(spec, status);
  }
  if (status.state !== "ready") {
    throw new SandboxUnavailableError(spec.sandbox_id, status.state, status.reason_code);
  }
  return {
    sandbox_id: spec.sandbox_id,
    task_id: spec.task_id,
    execution_id: spec.execution_id,
    workspace_id: spec.capabilities.workspace.workspace_id,
    guest_path: spec.capabilities.workspace.guest_path,
    workspace_access: spec.capabilities.workspace.access,
    host_tool_fallback: false
  };
}

export async function inspectReadySandbox(
  backend: SandboxBackend,
  input: SandboxSpec
): Promise<ReadySandboxLease> {
  const spec = validateSandboxSpec(input);
  const status = await backend.inspect(spec.sandbox_id);
  if (!status) throw new SandboxUnavailableError(spec.sandbox_id, "absent");
  assertStatusIdentity(spec, status);
  if (status.state !== "ready") {
    throw new SandboxUnavailableError(spec.sandbox_id, status.state, status.reason_code);
  }
  return {
    sandbox_id: spec.sandbox_id,
    task_id: spec.task_id,
    execution_id: spec.execution_id,
    workspace_id: spec.capabilities.workspace.workspace_id,
    guest_path: spec.capabilities.workspace.guest_path,
    workspace_access: spec.capabilities.workspace.access,
    host_tool_fallback: false
  };
}
