import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { SqliteEventLedger, projectTask } from "../dist/packages/core/index.js";

const execFileAsync = promisify(execFile);
const writerFixture = fileURLToPath(new URL("./fixtures/sqlite-writer.mjs", import.meta.url));

async function tempDatabase(name = "events.db") {
  const dir = await mkdtemp(join(tmpdir(), "agent-coordinator-sqlite-"));
  return join(dir, name);
}

test("SQLite ledger uses WAL and survives close/reopen", async () => {
  const path = await tempDatabase();
  const first = new SqliteEventLedger(path);
  assert.equal(
    first.append({
      type: "task.prepared",
      task_id: "t1",
      execution_id: "e1",
      at: "2026-01-01T00:00:00.000Z",
      data: { source: "test" }
    }).seq,
    1
  );
  first.append({
    type: "room.created",
    task_id: "t1",
    execution_id: "e1",
    data: { room_id: "42" }
  });
  first.close();

  const raw = new DatabaseSync(path);
  assert.equal(raw.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  assert.equal(raw.prepare("PRAGMA user_version").get().user_version, 1);
  raw.close();

  const reopened = new SqliteEventLedger(path);
  assert.deepEqual(reopened.list("t1").map((event) => event.seq), [1, 2]);
  assert.equal(reopened.list("t1")[0].data.source, "test");
  assert.deepEqual(projectTask(reopened.list(), "t1"), {
    task_id: "t1",
    execution_id: "e1",
    status: "prepared",
    room_id: "42",
    last_event_seq: 2
  });
  reopened.close();
});

test("two SQLite ledger connections share one monotonic sequence", async () => {
  const path = await tempDatabase();
  const a = new SqliteEventLedger(path);
  const b = new SqliteEventLedger(path);
  assert.equal(a.append({ type: "task.prepared", task_id: "t1", execution_id: "e1" }).seq, 1);
  assert.equal(b.append({ type: "task.prepared", task_id: "t2", execution_id: "e2" }).seq, 2);
  assert.equal(a.append({ type: "dispatch.requested", task_id: "t1", execution_id: "e1" }).seq, 3);
  assert.deepEqual(b.list().map((event) => event.seq), [1, 2, 3]);
  assert.deepEqual(b.list("t1").map((event) => event.seq), [1, 3]);
  a.close();
  b.close();
});

test("concurrent writer processes preserve one gap-free global sequence", async () => {
  const path = await tempDatabase();
  const writerCount = 4;
  const eventsPerWriter = 20;
  await Promise.all(
    Array.from({ length: writerCount }, (_, index) =>
      execFileAsync(process.execPath, [writerFixture, path, `writer-${index}`, String(eventsPerWriter)])
    )
  );

  const ledger = new SqliteEventLedger(path);
  const events = ledger.list();
  const expectedCount = writerCount * eventsPerWriter;
  assert.equal(events.length, expectedCount);
  assert.deepEqual(events.map((event) => event.seq), Array.from({ length: expectedCount }, (_, index) => index + 1));
  assert.equal(new Set(events.map((event) => event.task_id)).size, expectedCount);
  ledger.close();
});

test("failed event serialization leaves no partial row or consumed sequence", async () => {
  const path = await tempDatabase();
  const ledger = new SqliteEventLedger(path);
  assert.throws(
    () => ledger.append({ type: "task.prepared", task_id: "t1", execution_id: "e1", data: { bad: 1n } }),
    /BigInt/
  );
  assert.deepEqual(ledger.list(), []);
  assert.equal(ledger.append({ type: "task.prepared", task_id: "t1", execution_id: "e1" }).seq, 1);
  ledger.close();
});

test("a database write failure rolls back without consuming a sequence", async () => {
  const path = await tempDatabase();
  const ledger = new SqliteEventLedger(path);
  assert.throws(
    () => ledger.append({ type: null, task_id: "t1", execution_id: "e1" }),
    /NOT NULL/
  );
  assert.deepEqual(ledger.list(), []);
  assert.equal(ledger.append({ type: "task.prepared", task_id: "t1", execution_id: "e1" }).seq, 1);
  ledger.close();
});

test("corrupt persisted event JSON fails loudly with its sequence", async () => {
  const path = await tempDatabase();
  const ledger = new SqliteEventLedger(path);
  ledger.append({ type: "task.prepared", task_id: "t1", execution_id: "e1", data: { ok: true } });
  ledger.close();

  const raw = new DatabaseSync(path);
  raw.prepare("UPDATE coordination_events SET data_json = ? WHERE seq = 1").run("{");
  raw.close();

  const reopened = new SqliteEventLedger(path);
  assert.throws(() => reopened.list(), /corrupt event data at seq 1/);
  reopened.close();
});

test("a database from a newer schema version is rejected", async () => {
  const path = await tempDatabase();
  const raw = new DatabaseSync(path);
  raw.exec("PRAGMA user_version = 99");
  raw.close();
  assert.throws(() => new SqliteEventLedger(path), /unsupported event ledger schema version 99/);
});

test("SQLite durable ledger rejects in-memory and invalid timeout configurations", () => {
  assert.throws(() => new SqliteEventLedger(":memory:"), /file-backed database/);
  assert.throws(
    () => new SqliteEventLedger("unused.db", { busy_timeout_ms: -1 }),
    /finite non-negative number/
  );
});

test("SQLite ledger validates required identities before writing", async () => {
  const path = await tempDatabase();
  const ledger = new SqliteEventLedger(path);
  assert.throws(
    () => ledger.append({ type: "task.prepared", task_id: "", execution_id: "e1" }),
    /task_id and execution_id are required/
  );
  assert.deepEqual(ledger.list(), []);
  ledger.close();
});
