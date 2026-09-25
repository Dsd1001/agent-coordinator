# Resource quotas and concurrency

Agent Coordinator 0.1 defines explicit resource-policy building blocks for dispatchers and worker process managers.

## Default policy

`DEFAULT_RESOURCE_QUOTA_POLICY` currently sets:

| Limit | Default |
| --- | ---: |
| Active executions, global | 4 |
| Active executions per worker key | 1 |
| Queued executions | 32 |
| Execution runtime | 1 hour |
| Worker memory | 2048 MB |
| Delivery artifact count | 64 |
| Total delivery artifact bytes | 512 MiB |

Defaults are reference values, not a promise that every deployment has the same capacity. Validate an explicit policy at startup and tune it for the deployment.

## Admission strategy

`ExecutionAdmissionController` grants an `ExecutionLease` before worker start. It rejects duplicate task/execution identities and bounds the queue. When a slot opens, it selects the earliest queued request that is **currently eligible** under both global and per-worker limits. This avoids head-of-line blocking when one worker key is saturated while another can run.

A lease release is idempotent. Queued work can be cancelled before admission. The in-memory controller is a single-process reference implementation; a multi-process dispatcher must provide equivalent atomic semantics using a shared store/lock.

## Runtime and memory enforcement

`processResourceLimits()` derives `max_runtime_ms` and `max_memory_mb` for `WorkerBinding`/`ProcessSpec`. A `WorkerProcessManager` **must enforce these limits or reject the worker start**. Merely recording the numbers is not enforcement.

For systemd-based managers, suitable mechanisms include runtime timeouts and memory limits. Container/Kubernetes implementations should map the same contract to their native resource controls.

## Artifact quotas

`verifyArtifactRefs()` can enforce both artifact count and total bytes. Count is checked before filesystem I/O. Each file's size is checked against the remaining byte budget before hashing; bytes actually hashed count against the budget even when the digest is wrong. Once the byte budget is exhausted, later artifacts are not read.

Use `artifactVerificationLimits()` to derive verification options from the shared resource policy.
