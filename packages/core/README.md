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

## Delivery artifact verification

`verifyArtifactRefs()` verifies workspace-relative regular files against declared SHA-256 digests. Manifest validation rejects traversal, absolute/Windows-style paths, backslash separators, malformed digests, and duplicate paths before file I/O. Symlink components are rejected, files are opened with `O_NOFOLLOW`, and file identity is checked before and after hashing.

`verifyDeliveryForAcceptance()` first enforces task/execution/channel/topic/worker identity, then requires a `delivered` status, all worker-declared checks to pass, and all declared artifacts to verify. `assertDeliveryReadyForAcceptance()` provides the fail-fast form for review pipelines.
