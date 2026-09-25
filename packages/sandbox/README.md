# sandbox

Transport- and runtime-neutral sandbox lifecycle contracts.

A remote worker receives a `ReadySandboxLease` only after a `SandboxBackend` confirms the sandbox is `ready`. There is no host-fallback callback in this API; failure, timeout, stopped, or absent state raises `SandboxUnavailableError`.

## Descriptor boundary

`SandboxSpec` contains only stable task/execution/sandbox identities plus logical capabilities:

- logical `workspace_id`
- guest-visible workspace path and read-only/read-write mode
- network mode `none` or `restricted` with hostname allowlist

Host workspace paths, credentials, tokens, secret material, arbitrary environment variables, and backend-specific configuration are deliberately not fields in the descriptor. Runtime implementations resolve a logical workspace ID internally.

## Lifecycle

`create(spec)` must be idempotent by stable `sandbox_id`. `waitUntilReady()` makes readiness explicit. `inspect()` is read-only. `destroy()` must be safe to repeat for an already absent/stopped sandbox so recovery code can reconcile teardown safely.
