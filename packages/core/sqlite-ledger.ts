import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { AppendEventInput, CoordinationEvent, EventLedger } from "./index.js";

const SCHEMA_VERSION = 1;
const BUSY_RETRY_SLEEP = new Int32Array(new SharedArrayBuffer(4));

interface EventRow {
  seq: number;
  type: string;
  task_id: string;
  execution_id: string;
  at: string;
  data_json: string | null;
}

export interface SqliteEventLedgerOptions {
  busy_timeout_ms?: number;
}

function assertAppendInput(input: AppendEventInput): void {
  if (!input.task_id.trim() || !input.execution_id.trim()) {
    throw new Error("task_id and execution_id are required");
  }
  if (input.at !== undefined && !input.at.trim()) throw new Error("event timestamp cannot be empty");
}

function parseRow(row: EventRow): CoordinationEvent {
  let data: Record<string, unknown> | undefined;
  if (row.data_json !== null) {
    try {
      const parsed = JSON.parse(row.data_json) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("event data must be a JSON object");
      }
      data = parsed as Record<string, unknown>;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`corrupt event data at seq ${row.seq}: ${detail}`);
    }
  }
  return {
    seq: Number(row.seq),
    type: row.type as CoordinationEvent["type"],
    task_id: row.task_id,
    execution_id: row.execution_id,
    at: row.at,
    ...(data === undefined ? {} : { data })
  };
}

function isSqliteBusy(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  return (error as { errcode?: unknown }).errcode === 5;
}

export class SqliteEventLedger implements EventLedger {
  readonly #db: DatabaseSync;
  readonly #busyTimeoutMs: number;

  constructor(path: string, options: SqliteEventLedgerOptions = {}) {
    if (!path.trim()) throw new Error("database path is required");
    if (path === ":memory:") throw new Error("SqliteEventLedger requires a file-backed database");
    const requestedTimeout = options.busy_timeout_ms ?? 5_000;
    if (!Number.isFinite(requestedTimeout) || requestedTimeout < 0) {
      throw new Error("busy_timeout_ms must be a finite non-negative number");
    }
    const timeout = Math.trunc(requestedTimeout);
    const databasePath = resolve(path);
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.#busyTimeoutMs = timeout;
    this.#db = new DatabaseSync(databasePath, { timeout });
    try {
      this.#db.exec(`PRAGMA busy_timeout = ${timeout};`);
      // WAL mode is persistent, but concurrent first-start processes can race
      // while one connection changes the database header. Some SQLite builds
      // return SQLITE_BUSY immediately for this pragma, so handle that case
      // explicitly within the configured timeout.
      const journal = this.#retryBusy(() =>
        this.#db.prepare("PRAGMA journal_mode = WAL").get() as { journal_mode?: string } | undefined
      );
      if (journal?.journal_mode?.toLowerCase() !== "wal") {
        throw new Error(`SQLite WAL mode is required; got ${journal?.journal_mode ?? "unknown"}`);
      }
      this.#db.exec(`
        PRAGMA synchronous = NORMAL;
        PRAGMA foreign_keys = ON;
        PRAGMA trusted_schema = OFF;
      `);
      this.#retryBusy(() => this.#bootstrap());
    } catch (error) {
      if (this.#db.isOpen) this.#db.close();
      throw error;
    }
  }

  #retryBusy<T>(operation: () => T): T {
    const deadline = Date.now() + this.#busyTimeoutMs;
    let delayMs = 5;
    for (;;) {
      try {
        return operation();
      } catch (error) {
        const remaining = deadline - Date.now();
        if (!isSqliteBusy(error) || remaining <= 0) throw error;
        Atomics.wait(BUSY_RETRY_SLEEP, 0, 0, Math.min(delayMs, remaining));
        delayMs = Math.min(delayMs * 2, 100);
      }
    }
  }

  #beginImmediate(): void {
    this.#retryBusy(() => this.#db.exec("BEGIN IMMEDIATE"));
  }

  #schemaVersion(): number {
    const row = this.#db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
    return Number(row?.user_version ?? 0);
  }

  #assertSupportedSchema(version: number): void {
    if (version > SCHEMA_VERSION) {
      throw new Error(`unsupported event ledger schema version ${version}; max supported is ${SCHEMA_VERSION}`);
    }
  }

  #bootstrap(): void {
    let version = this.#schemaVersion();
    this.#assertSupportedSchema(version);
    if (version === SCHEMA_VERSION) return;

    this.#beginImmediate();
    try {
      // Another process may have initialized or migrated the database while
      // this connection was waiting for the write lock. Re-read the version
      // under the lock before deciding which migration to apply.
      version = this.#schemaVersion();
      this.#assertSupportedSchema(version);
      if (version === 0) {
        this.#db.exec(`
          CREATE TABLE coordination_events (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT NOT NULL,
            task_id TEXT NOT NULL CHECK(length(task_id) > 0),
            execution_id TEXT NOT NULL CHECK(length(execution_id) > 0),
            at TEXT NOT NULL CHECK(length(at) > 0),
            data_json TEXT
          ) STRICT;
          CREATE INDEX coordination_events_task_seq
            ON coordination_events(task_id, seq);
          PRAGMA user_version = 1;
        `);
      } else if (version !== SCHEMA_VERSION) {
        throw new Error(`no migration path from event ledger schema version ${version}`);
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // Preserve the original migration/bootstrap error.
      }
      throw error;
    }
  }

  append(input: AppendEventInput): CoordinationEvent {
    assertAppendInput(input);
    const at = input.at ?? new Date().toISOString();
    const dataJson = input.data === undefined ? null : JSON.stringify(input.data);

    this.#beginImmediate();
    try {
      const result = this.#db
        .prepare(`
          INSERT INTO coordination_events(type, task_id, execution_id, at, data_json)
          VALUES (?, ?, ?, ?, ?)
        `)
        .run(input.type, input.task_id, input.execution_id, at, dataJson);
      const seq = Number(result.lastInsertRowid);
      this.#db.exec("COMMIT");
      return {
        ...input,
        seq,
        at
      };
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  list(taskId?: string): CoordinationEvent[] {
    const rows = (taskId === undefined
      ? this.#db
          .prepare("SELECT seq, type, task_id, execution_id, at, data_json FROM coordination_events ORDER BY seq")
          .all()
      : this.#db
          .prepare(
            "SELECT seq, type, task_id, execution_id, at, data_json FROM coordination_events WHERE task_id = ? ORDER BY seq"
          )
          .all(taskId)) as unknown as EventRow[];
    return rows.map(parseRow);
  }

  close(): void {
    if (this.#db.isOpen) this.#db.close();
  }
}
