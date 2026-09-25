# sandbox-gondolin

Gondolin-oriented reference adapter boundary for the generic `SandboxBackend` contract.

This package intentionally does **not** contain production Gondolin configuration, host workspace paths, VM images, credentials, network endpoints, or private deployment logic. A deployment injects a `GondolinRuntime` implementation. That runtime receives only the logical workspace ID, guest mount path/access mode, task/execution identities, and explicit network policy.

The runtime is responsible for privately resolving `workspace_id` to its deployment-specific storage and for making create/destroy idempotent.
