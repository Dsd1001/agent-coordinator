# extension-api

Versioned extension surface for Agent Coordinator 0.1.

Extensions are ordinary modules loaded by the host application. This package deliberately does not implement remote code download or filesystem plugin discovery. The host chooses which code to import, then passes an `AgentCoordinatorExtension` object to `ExtensionRegistry.install()`.

## Compatibility

Every manifest declares both:

- `api_version`: the extension API line it targets.
- `protocol_version`: the coordination protocol line it targets.

For pre-1.0 releases, major **and minor** must match; patch releases remain compatible. The 0.1.0 API therefore accepts 0.1.x extensions/protocols and rejects 0.2.x.

## Atomic registration

A manifest declares every `(extension point, provider name)` it will register. Installation stages providers privately, validates exact manifest conformance and duplicate ownership, and commits them only if the entire register callback succeeds. Failed installation never leaves a partially registered extension.

## Built-in extension points

- `agent.manager` — `ManagerAdapter`
- `agent.transport` — `CoordinationTransport`
- `agent.codec` — `WorkOrderCodec`
- `agent.sandbox` — `SandboxBackend`
- `agent.worker` — `WorkerBackend`
- `agent.process-manager` — `WorkerProcessManager`
- `agent.health-sink` — `SupervisorHealthSink`
- `agent.event-ledger` — `EventLedger`

`defineExtensionPoint()` supports additional typed in-process extension points without changing the registry implementation.

## Security boundary

The extension context exposes only protocol/API versions, a clock, and a caller-provided logger. It does not expose credentials, manager memory, raw private configuration, host filesystem handles, or a shell. Extensions that need such capabilities must receive them explicitly from the embedding application through their own factory/provider values.
