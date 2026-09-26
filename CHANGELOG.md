# Changelog

## 0.1.1 - 2026-09-27

Backward-compatible runtime-extension release. The stable coordination protocol remains `0.1.0`; no durable event is added, removed, or renamed.

### Runtime extension contracts

- Added optional `ProgressSink` / `ProgressSnapshot` contracts with heartbeat and transport-neutral projection-surface observability.
- Added current-execution `WorkerControl` and `SteeringPolicy` contracts for explicit append-only human/operator steering without creating a new task or attempt.
- Added side-effect-free `TaskAnnotationStore` so audit/review notes are distinct from worker steering.
- Added structured `ReviewFinding` and pluggable `RecoveryPolicy` contracts.
- Added `ResultPublisher` with frozen payload fingerprints, `unknown` delivery state, and inspect-before-retry semantics for external publication.

### Reference policy

- Added `@agent-coordinator/recovery-bounded-final-repair`, a replaceable recovery policy that permits one scope-locked final repair only for bounded structured blocking findings at the normal retry limit.

### Compatibility and security

- Extension API advanced to `0.1.1`; existing 0.1.x extension manifests remain compatible.
- Progress data is explicitly operational/redacted, steering must bind to the current task/execution, annotations cannot cause worker side effects, and uncertain publications must be reconciled before retry.

## 0.1.0 - 2026-09-25

First tagged public release.

> Pre-release state note: untagged development snapshots used `topic.created`/`topic.closed` and public `topic_id` aliases. They are not part of the 0.1 stable contract. Migrate such local state to `room.created`/`room.closed` + `room_id`, or start with a fresh state database before adopting 0.1.0.

### Protocol and core

- Stable transport-neutral protocol line `0.1.x` with canonical `room_id` identity and version compatibility checks.
- Durable SQLite WAL event ledger and explicit task/execution lifecycle events.
- Strict task/execution/channel/room/worker/delivery identity verification.
- SHA-256 artifact verification with traversal/symlink defenses and bounded artifact I/O.

### Resource policy

- Bounded global/per-worker execution admission and queueing.
- Runtime and memory limits propagated to worker process managers for enforcement.
- Artifact count and total-byte quotas.

### Reliability and recovery

- Supervisor health snapshots and bounded exponential backoff.
- Idempotent evidence-driven reconciliation for ambiguous sends, worker starts, deliveries, reviews, and room closure.
- Offline recovery semantic audit that fails closed on invalid durable history.

### Extension and reference adapters

- Versioned atomic extension registry with typed manager, transport, codec, sandbox, worker, process-manager, health-sink, and event-ledger points.
- Clean Hermes manager adapter, Telegram forum transport/codec, Pi worker adapter, Gondolin sandbox boundary, and replaceable worker process manager contract.
- Fail-closed remote sandbox policy with no host-tool fallback.
