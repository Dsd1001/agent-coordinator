# core

The core package contains coordination event types, task projection, and two `EventLedger` implementations. The SQLite implementation requires Node.js 22.13 or newer.

- `MemoryEventLedger` for tests and ephemeral embedding.
- `SqliteEventLedger` for durable local coordination state.

## SQLite ledger

`SqliteEventLedger` uses Node's built-in `node:sqlite` module, requires a file-backed database, verifies WAL mode, stores an ordered append-only event stream, and uses `PRAGMA user_version` for schema evolution.

```ts
import { SqliteEventLedger } from "@agent-coordinator/core";

const ledger = new SqliteEventLedger("./state/coordinator.db");
ledger.append({
  type: "task.prepared",
  task_id: "task-123",
  execution_id: "exec-1"
});

const events = ledger.list("task-123");
ledger.close();
```

The implementation rejects database schema versions newer than it understands instead of attempting a destructive downgrade.
