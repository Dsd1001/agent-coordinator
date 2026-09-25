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

## Supervisor health and backoff

`SupervisorHealthTracker` models poll and worker cold-start reliability without accepting raw errors, transport payloads, credentials, or provider configuration. Its snapshot contains timestamps, counters, retry delays, and stable worker identifiers only.

Default bounded exponential backoff mirrors the reference deployment:

- poll failures: 3s, 6s, 12s, 24s, 48s, then 60s cap
- worker spawn failures: 5s, 10s, 20s, 40s, then 60s cap
- an explicit `retry_after` delay is treated as a lower bound when larger than local backoff

A successful poll resets the poll failure counter and clears poll retry fields. A successful worker start resets that worker's failure counter and clears its retry fields. Overall state is `degraded` while either the poller or any tracked worker has unresolved failures.

`AtomicJsonFileHealthSink` writes a mode-0600 temporary file in the destination directory and atomically renames it into place. Custom sinks can implement the same `SupervisorHealthSink` interface for metrics systems or platform-specific stores.
