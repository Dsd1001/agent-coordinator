export type {
  ManagedProcess,
  ProcessSpec,
  WorkerBackend,
  WorkerBinding,
  WorkerProcessManager,
  WorkerResourceLimits,
  WorkerStatus
} from "../protocol/src/index.js";

import {
  acquireReadySandbox,
  type ReadySandboxLease,
  type SandboxBackend,
  type SandboxReadyOptions,
  type SandboxSpec,
  validateSandboxSpec
} from "../sandbox/index.js";

import type {
  ManagedProcess,
  ProcessSpec,
  WorkerBackend,
  WorkerBinding,
  WorkerProcessManager,
  WorkerResourceLimits,
  WorkerStatus
} from "../protocol/src/index.js";

export interface SandboxPolicy {
  fail_closed: true;
  allow_host_tool_fallback: false;
}

export const REMOTE_WORKER_SANDBOX_POLICY: SandboxPolicy = {
  fail_closed: true,
  allow_host_tool_fallback: false
};

export function assertRemoteWorkerSandboxReady(remoteWorkerMode: boolean, sandboxReady: boolean): void {
  if (remoteWorkerMode && !sandboxReady) {
    throw new Error("remote worker sandbox is not ready; host tool fallback is disabled");
  }
}

export function canUseHostTools(remoteWorkerMode: boolean, sandboxReady: boolean): boolean {
  if (remoteWorkerMode) return false;
  return !sandboxReady;
}


export async function prepareRemotePiSandbox(
  binding: WorkerBinding,
  backend: SandboxBackend,
  input: SandboxSpec,
  options: SandboxReadyOptions = {}
): Promise<ReadySandboxLease> {
  const spec = validateSandboxSpec(input);
  if (spec.task_id !== binding.task_id) throw new Error("sandbox task_id must match worker task_id");
  if (spec.execution_id !== binding.execution_id) {
    throw new Error("sandbox execution_id must match worker execution_id");
  }
  // Deliberately do not derive the sandbox workspace from binding.workspace: the
  // sandbox contract accepts a logical workspace_id and guest path, never the
  // manager/host filesystem path used by the process manager.
  return acquireReadySandbox(backend, spec, options);
}

export interface PiWorkerRuntimeConfig {
  pi_binary: string;
  provider: string;
  model: string;
  extension_path: string;
  home: string;
  session_root: string;
  cwd: string;
}

function safeSessionId(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  if (!normalized) throw new Error("conversation id cannot produce an empty session id");
  return normalized.slice(0, 120);
}

function assertAbsolutePath(label: string, value: string): void {
  if (!value.startsWith("/")) throw new Error(`${label} must be an absolute path`);
}

export function buildPiWorkerProcessSpec(
  binding: WorkerBinding,
  config: PiWorkerRuntimeConfig
): ProcessSpec {
  if (!binding.task_id.trim() || !binding.execution_id.trim() || !binding.conversation_id.trim()) {
    throw new Error("task, execution and conversation identities are required");
  }
  if (!Number.isSafeInteger(binding.resource_limits.max_runtime_ms) || binding.resource_limits.max_runtime_ms <= 0) {
    throw new Error("max_runtime_ms must be a positive safe integer");
  }
  if (!Number.isSafeInteger(binding.resource_limits.max_memory_mb) || binding.resource_limits.max_memory_mb <= 0) {
    throw new Error("max_memory_mb must be a positive safe integer");
  }
  assertAbsolutePath("pi_binary", config.pi_binary);
  assertAbsolutePath("extension_path", config.extension_path);
  assertAbsolutePath("home", config.home);
  assertAbsolutePath("session_root", config.session_root);
  assertAbsolutePath("cwd", config.cwd);
  if (!config.provider.trim() || !config.model.trim()) throw new Error("provider and model are required");

  const sessionId = safeSessionId(binding.conversation_id);
  const sessionDir = `${config.session_root.replace(/\/+$/, "")}/${sessionId}`;
  return {
    command: config.pi_binary,
    args: [
      "--provider",
      config.provider,
      "--model",
      config.model,
      "--session-dir",
      sessionDir,
      "--extension",
      config.extension_path,
      "--session-id",
      sessionId,
      "--chat-conversation",
      binding.conversation_id
    ],
    cwd: config.cwd,
    env: { HOME: config.home },
    worker_id: `pi-${sessionId}`,
    resource_limits: { ...binding.resource_limits }
  };
}

export class PiWorkerBackend implements WorkerBackend {
  readonly #config: PiWorkerRuntimeConfig;
  readonly #manager: WorkerProcessManager;

  constructor(config: PiWorkerRuntimeConfig, manager: WorkerProcessManager) {
    this.#config = config;
    this.#manager = manager;
  }

  async start(binding: WorkerBinding): Promise<WorkerStatus> {
    // The launcher creates no shell command string. A concrete manager receives
    // argv separately and is responsible for process lifecycle/durability.
    const spec = buildPiWorkerProcessSpec(binding, this.#config);
    const started = await this.#manager.start(spec);
    return { state: "starting", worker_id: started.worker_id, updated_at: started.started_at };
  }

  inspect(workerId: string): Promise<WorkerStatus> {
    return this.#manager.inspect(workerId);
  }

  stop(workerId: string, reason?: string): Promise<void> {
    return this.#manager.stop(workerId, reason);
  }
}
