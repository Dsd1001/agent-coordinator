export interface WorkerBinding {
  task_id: string;
  execution_id: string;
  conversation_id: string;
  workspace: string;
}

export interface WorkerStatus {
  state: "starting" | "running" | "stopped" | "failed";
  worker_id: string;
  updated_at: string;
  detail?: string;
}

export interface WorkerBackend {
  start(binding: WorkerBinding): Promise<WorkerStatus>;
  inspect(worker_id: string): Promise<WorkerStatus>;
  stop(worker_id: string, reason?: string): Promise<void>;
}

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

export interface PiWorkerRuntimeConfig {
  pi_binary: string;
  provider: string;
  model: string;
  extension_path: string;
  home: string;
  session_root: string;
  cwd: string;
}

export interface ProcessSpec {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  worker_id: string;
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
    worker_id: `pi-${sessionId}`
  };
}

export interface ManagedProcess {
  worker_id: string;
  started_at: string;
}

export interface WorkerProcessManager {
  start(spec: ProcessSpec): Promise<ManagedProcess>;
  inspect(workerId: string): Promise<WorkerStatus>;
  stop(workerId: string, reason?: string): Promise<void>;
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
