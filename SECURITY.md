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
- Secrets never belong in repository config, task payloads, logs, examples, or fixtures.
- Unknown network-send outcomes are not blindly retried when doing so can duplicate an external side effect.

## Reporting

Do not publish security reports containing real tokens, chat IDs, customer data, or production session transcripts.
