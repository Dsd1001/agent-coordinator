# Security Model

The manager and worker belong to different trust zones.

## Trust zones

1. **Manager control plane**: may be privileged and is responsible for policy, task creation, review, and lifecycle decisions.
2. **Worker runtime**: must run as a dedicated non-root operating-system identity with a narrow filesystem and credential scope.
3. **Execution sandbox**: untrusted model-driven code executes only inside the sandbox workspace.

## Required invariants

- Remote workers are **fail-closed**: if the sandbox is unavailable, host `read`, `write`, `edit`, and `bash` tools are denied.
- Worker messages are accepted only from configured coordinator/admin sender IDs.
- Worker **cold-start** is separately authorized: a forum update must come from a configured coordinator ID and explicitly address the worker bot before it may allocate a worker process. Runtime authorization remains mandatory after startup.
- A delivery must match task ID, execution ID, room ID, and expected worker identity.
- Input artifacts are copied into the worker workspace and hash-verified. Workers do not receive manager filesystem access.
- Delivery artifacts are accepted only as workspace-relative regular files with valid SHA-256 bindings; traversal and symbolic-link paths are rejected before acceptance.
- Secrets never belong in repository config, task payloads, logs, examples, or fixtures.
- Supervisor health snapshots contain counters/timestamps and stable identifiers only; raw errors, transport payloads, prompts, credentials, and provider configuration are excluded.
- Unknown network-send outcomes are not blindly retried when doing so can duplicate an external side effect.
- Recovery observers are read-only by contract; reconciliation may record positively observed outcomes but cannot send messages, start workers, or close rooms.
- Manager review accepts only a delivery explicitly marked identity/artifact verified, and the Hermes adapter rejects task/execution mismatches.
- The coordinator applies manager review only when its durable projection still shows that exact execution as `delivered`; premature or stale review results cannot trigger accept/rework/resume/cancel side effects.
- Unknown Hermes client failures are not declared safe to retry automatically because the remote operation may already have completed.
- Hermes client exceptions are converted to structured adapter errors without copying upstream exception text or private context.

- Resource admission is bounded by global/per-worker concurrency and queue limits; worker process managers must enforce runtime/memory limits or reject start.
- Delivery artifact count/byte quotas are enforced before or during verification so untrusted outputs cannot force unbounded filesystem hashing.
- Durable history is audited before/after reconciliation; hard semantic errors fail closed before external observers are called.
- Extensions are host-selected in-process code. Atomic registration prevents partial install, but the host remains responsible for trusting the extension module itself.
- Progress telemetry must be bounded/redacted operational state; raw prompts, model reasoning, tool arguments, credentials, and file contents do not belong in progress snapshots.
- Execution steering must be explicitly authorized and matched to the still-current task/execution before it reaches a worker. Steering is append-only intervention and must not silently create a new task or attempt.
- Task annotations are side-effect-free by contract; storing an annotation must not send a worker message or allocate execution resources.
- Result publication uses a frozen payload fingerprint. An uncertain external-send result must be inspected/reconciled before any retry; a partial result must not be represented as an accepted final result.

## Reporting

Do not publish security reports containing real tokens, chat IDs, customer data, or production session transcripts.
