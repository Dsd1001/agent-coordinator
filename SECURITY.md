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
- A delivery must match task ID, execution ID, topic/thread ID, and expected worker identity.
- Input artifacts are copied into the worker workspace and hash-verified. Workers do not receive manager filesystem access.
- Delivery artifacts are accepted only as workspace-relative regular files with valid SHA-256 bindings; traversal and symbolic-link paths are rejected before acceptance.
- Secrets never belong in repository config, task payloads, logs, examples, or fixtures.
- Supervisor health snapshots contain counters/timestamps and stable identifiers only; raw errors, transport payloads, prompts, credentials, and provider configuration are excluded.
- Unknown network-send outcomes are not blindly retried when doing so can duplicate an external side effect.
- Recovery observers are read-only by contract; reconciliation may record positively observed outcomes but cannot send messages, start workers, or close topics.
- Manager review accepts only a delivery explicitly marked identity/artifact verified, and the Hermes adapter rejects task/execution mismatches.
- The coordinator applies manager review only when its durable projection still shows that exact execution as `delivered`; premature or stale review results cannot advance task state.
- Unknown Hermes client failures are not declared safe to retry automatically because the remote operation may already have completed.
- The coordinator applies a manager review only to the current execution while its durable task projection is `delivered`; stale or premature reviews cannot trigger accept/rework/resume/cancel side effects.
- Hermes client exceptions are converted to structured adapter errors without copying upstream exception text or private context.

## Reporting

Do not publish security reports containing real tokens, chat IDs, customer data, or production session transcripts.
