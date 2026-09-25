import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface BackoffPolicy {
  base_ms: number;
  max_ms: number;
}

export interface PollHealth {
  consecutive_failures: number;
  last_successful_poll_at?: string;
  last_update_at?: string;
  last_failure_at?: string;
  retry_delay_ms?: number;
  next_attempt_at?: string;
}

export interface WorkerSpawnHealth {
  worker_key: string;
  consecutive_failures: number;
  last_successful_spawn_at?: string;
  last_failure_at?: string;
  retry_delay_ms?: number;
  next_attempt_at?: string;
}

export interface SupervisorHealthSnapshot {
  version: 1;
  state: "healthy" | "degraded";
  started_at: string;
  updated_at: string;
  poll: PollHealth;
  workers: WorkerSpawnHealth[];
}

export interface SupervisorHealthTrackerOptions {
  now?: () => Date;
  poll_backoff?: BackoffPolicy;
  worker_backoff?: BackoffPolicy;
}

export interface SupervisorHealthSink {
  write(snapshot: SupervisorHealthSnapshot): Promise<void>;
}

const DEFAULT_POLL_BACKOFF: BackoffPolicy = { base_ms: 3_000, max_ms: 60_000 };
const DEFAULT_WORKER_BACKOFF: BackoffPolicy = { base_ms: 5_000, max_ms: 60_000 };
const WORKER_KEY_PATTERN = /^[A-Za-z0-9._:/#-]{1,160}$/;

function assertDelay(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
}

function normalizePolicy(label: string, policy: BackoffPolicy): BackoffPolicy {
  assertDelay(`${label}.base_ms`, policy.base_ms);
  assertDelay(`${label}.max_ms`, policy.max_ms);
  if (policy.base_ms <= 0) throw new Error(`${label}.base_ms must be greater than zero`);
  if (policy.max_ms < policy.base_ms) throw new Error(`${label}.max_ms must be >= base_ms`);
  return { ...policy };
}

function assertWorkerKey(workerKey: string): void {
  if (!WORKER_KEY_PATTERN.test(workerKey)) {
    throw new Error("worker_key must be a stable 1-160 character identifier");
  }
}

function isoAt(base: Date, delayMs: number): string {
  const next = new Date(base.getTime() + delayMs);
  if (!Number.isFinite(next.getTime())) throw new Error("retry delay produces an invalid next_attempt_at");
  return next.toISOString();
}

function clonePoll(value: PollHealth): PollHealth {
  return { ...value };
}

function cloneWorker(value: WorkerSpawnHealth): WorkerSpawnHealth {
  return { ...value };
}

export function boundedExponentialBackoffMs(failures: number, policy: BackoffPolicy): number {
  if (!Number.isInteger(failures) || failures < 1) throw new Error("failures must be a positive integer");
  const normalized = normalizePolicy("backoff", policy);
  const exponent = Math.min(failures - 1, 30);
  return Math.min(normalized.max_ms, normalized.base_ms * 2 ** exponent);
}

export function effectiveRetryDelayMs(
  failures: number,
  policy: BackoffPolicy,
  retryAfterMs?: number
): number {
  const localDelay = boundedExponentialBackoffMs(failures, policy);
  if (retryAfterMs === undefined) return localDelay;
  assertDelay("retry_after_ms", retryAfterMs);
  return Math.max(localDelay, retryAfterMs);
}

export class SupervisorHealthTracker {
  readonly #now: () => Date;
  readonly #pollBackoff: BackoffPolicy;
  readonly #workerBackoff: BackoffPolicy;
  readonly #startedAt: string;
  readonly #poll: PollHealth = { consecutive_failures: 0 };
  readonly #workers = new Map<string, WorkerSpawnHealth>();
  #updatedAt: string;

  constructor(options: SupervisorHealthTrackerOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#pollBackoff = normalizePolicy("poll_backoff", options.poll_backoff ?? DEFAULT_POLL_BACKOFF);
    this.#workerBackoff = normalizePolicy("worker_backoff", options.worker_backoff ?? DEFAULT_WORKER_BACKOFF);
    const started = this.#now();
    if (!Number.isFinite(started.getTime())) throw new Error("now() must return a valid Date");
    this.#startedAt = started.toISOString();
    this.#updatedAt = this.#startedAt;
  }

  #eventTime(at?: Date): Date {
    const value = at ?? this.#now();
    if (!Number.isFinite(value.getTime())) throw new Error("health event time must be a valid Date");
    return value;
  }

  #touch(time: Date): void {
    this.#updatedAt = time.toISOString();
  }

  recordPollSuccess(updateCount = 0, at?: Date): void {
    if (!Number.isInteger(updateCount) || updateCount < 0) {
      throw new Error("update_count must be a non-negative integer");
    }
    const time = this.#eventTime(at);
    this.#poll.consecutive_failures = 0;
    this.#poll.last_successful_poll_at = time.toISOString();
    if (updateCount > 0) this.#poll.last_update_at = time.toISOString();
    delete this.#poll.retry_delay_ms;
    delete this.#poll.next_attempt_at;
    this.#touch(time);
  }

  recordPollFailure(retryAfterMs?: number, at?: Date): number {
    const time = this.#eventTime(at);
    const failures = this.#poll.consecutive_failures + 1;
    const retryDelay = effectiveRetryDelayMs(failures, this.#pollBackoff, retryAfterMs);
    const nextAttemptAt = isoAt(time, retryDelay);
    this.#poll.consecutive_failures = failures;
    this.#poll.last_failure_at = time.toISOString();
    this.#poll.retry_delay_ms = retryDelay;
    this.#poll.next_attempt_at = nextAttemptAt;
    this.#touch(time);
    return retryDelay;
  }

  recordWorkerSpawnFailure(workerKey: string, retryAfterMs?: number, at?: Date): number {
    assertWorkerKey(workerKey);
    const time = this.#eventTime(at);
    const previous = this.#workers.get(workerKey);
    const failures = (previous?.consecutive_failures ?? 0) + 1;
    const retryDelay = effectiveRetryDelayMs(failures, this.#workerBackoff, retryAfterMs);
    const current: WorkerSpawnHealth = {
      ...(previous ?? { worker_key: workerKey }),
      worker_key: workerKey,
      consecutive_failures: failures,
      last_failure_at: time.toISOString(),
      retry_delay_ms: retryDelay,
      next_attempt_at: isoAt(time, retryDelay)
    };
    this.#workers.set(workerKey, current);
    this.#touch(time);
    return retryDelay;
  }

  recordWorkerSpawnSuccess(workerKey: string, at?: Date): void {
    assertWorkerKey(workerKey);
    const time = this.#eventTime(at);
    const current = this.#workers.get(workerKey) ?? { worker_key: workerKey, consecutive_failures: 0 };
    current.consecutive_failures = 0;
    current.last_successful_spawn_at = time.toISOString();
    delete current.retry_delay_ms;
    delete current.next_attempt_at;
    this.#workers.set(workerKey, current);
    this.#touch(time);
  }

  forgetWorker(workerKey: string, at?: Date): void {
    assertWorkerKey(workerKey);
    const time = this.#eventTime(at);
    this.#workers.delete(workerKey);
    this.#touch(time);
  }

  snapshot(): SupervisorHealthSnapshot {
    const workers = [...this.#workers.values()]
      .sort((a, b) => a.worker_key.localeCompare(b.worker_key))
      .map(cloneWorker);
    const degraded = this.#poll.consecutive_failures > 0 || workers.some((worker) => worker.consecutive_failures > 0);
    return {
      version: 1,
      state: degraded ? "degraded" : "healthy",
      started_at: this.#startedAt,
      updated_at: this.#updatedAt,
      poll: clonePoll(this.#poll),
      workers
    };
  }

  async publish(sink: SupervisorHealthSink): Promise<SupervisorHealthSnapshot> {
    const snapshot = this.snapshot();
    await sink.write(snapshot);
    return snapshot;
  }
}

export class AtomicJsonFileHealthSink implements SupervisorHealthSink {
  readonly #path: string;
  #sequence = 0;

  constructor(path: string) {
    if (!path.trim()) throw new Error("health snapshot path is required");
    this.#path = resolve(path);
  }

  async write(snapshot: SupervisorHealthSnapshot): Promise<void> {
    const parent = dirname(this.#path);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const temp = `${this.#path}.${process.pid}.${++this.#sequence}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
      await rename(temp, this.#path);
    } catch (error) {
      try {
        await unlink(temp);
      } catch {
        // Best effort cleanup. The original write/rename error is authoritative.
      }
      throw error;
    }
  }
}
