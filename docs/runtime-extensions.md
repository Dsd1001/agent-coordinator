# Runtime control extensions

Agent Coordinator 0.1.1 adds optional in-process runtime contracts without changing the stable 0.1 coordination protocol or durable event vocabulary.

These contracts capture production patterns that are useful across transports and worker implementations while keeping transport syntax, UI rendering, manager sessions, and domain-specific policy outside coordinator core.

## Progress telemetry

`ProgressSnapshot` is bound to `task_id + execution_id` and can carry state, timestamps, heartbeat, a generic phase, a bounded/redacted latest action, numeric activity counters, and optional projection-surface status.

A `ProgressSink` receives snapshots. Producers should report only operational telemetry: do not copy prompts, chain-of-thought, raw tool arguments, credentials, file contents, or arbitrary provider errors into progress fields. A sink may project the same snapshot to Telegram, Slack, a web dashboard, or a local state file.

Progress freshness is deliberately a host policy. The contract carries timestamps; the host decides when a heartbeat or snapshot becomes stale.

## Execution steering

`ExecutionSteeringRequest` is an append-only intervention for the **current execution**. It is not a mutation of the original work order and it must not allocate a new task or attempt.

Recommended flow:

```text
human/operator input
  -> transport-specific parser
  -> SteeringPolicy.authorize()
  -> verify task_id + execution_id are still current
  -> WorkerControl.steer()
  -> auditable worker-control receipt
```

A transport may expose `/steer`, buttons, mentions, or another explicit UX. Those syntaxes do not belong in coordinator core.

## Task annotations

`TaskAnnotationStore` is for notes that must **not** change worker behavior. An annotation can be scoped to a task or execution and assigned a visibility such as operator/audit. `append()` must not send a transport message, start a worker, or steer an execution.

This creates a deliberate boundary:

```text
annotation != steering
```

Hosts should use annotations for audit/review notes and steering only for explicit authorized intervention.

## Structured review findings and recovery policy

`ReviewFinding` gives recovery policy machine-readable review evidence:

- stable finding id
- `blocking` or `advisory` severity
- finding type
- repair requirement

`RecoveryPolicy` receives the attempt budget, prior recovery actions and a review assessment. It returns one of `retry`, `repair`, `escalate`, or `stop`.

Core does not prescribe how many retries are allowed or whether a final-repair lane exists. The reference `@agent-coordinator/recovery-bounded-final-repair` package demonstrates a conservative policy: normal retry while budget remains, then at most one scope-locked `repair` action (used by this plugin as a final-repair lane) for a `bounded` review with structured blocking findings, otherwise escalation.

## Result publishing

`ResultPublisher` separates result publication from review and coordination state. Publication requests carry a frozen `payload_fingerprint` and are bound to task/execution identity.

Implementations must make identical publication id + fingerprint calls idempotent. If an external send result is uncertain, return `unknown`; callers should use `inspect()` before considering a retry. A changed payload under an existing publication id should be rejected by the implementation rather than silently resent.

`kind: "partial"` supports clearly labelled degraded/salvage delivery without changing the authoritative task state to accepted. The wording and allowed artifact policy belong to the publisher/deployment, not coordinator core.

## Compatibility

0.1.1 is a patch release:

- `PROTOCOL_VERSION` remains `0.1.0`.
- Existing 0.1.0 extension manifests remain compatible with `EXTENSION_API_VERSION = 0.1.1`.
- No 0.1 durable event is added, removed, or renamed.
- All new runtime extension points are optional.
