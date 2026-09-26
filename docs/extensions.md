# Extension API 0.1

`EXTENSION_API_VERSION` is **0.1.1**. Extensions are in-process modules selected and imported by the embedding application; Agent Coordinator does not download or execute remote extension code.

## Manifest

Every extension declares:

- stable lowercase extension `id`
- extension `version`
- targeted `api_version`
- targeted coordination `protocol_version`
- every `(extension point, provider name)` it will register

For the pre-1.0 API, major+minor must match. 0.1.x extensions may load into the 0.1.x API; 0.2.x is rejected unless the host moves to that API line.

## Atomic registry

`ExtensionRegistry.install()` serializes concurrent installs, stages registrations privately, validates exact manifest conformance and provider ownership, and only commits after the whole registration callback succeeds. A failed extension cannot leave partial providers behind.

Built-in extension points are:

- `agent.manager` — `ManagerAdapter`
- `agent.transport` — `CoordinationTransport`
- `agent.codec` — `WorkOrderCodec`
- `agent.sandbox` — `SandboxBackend`
- `agent.worker` — `WorkerBackend`
- `agent.process-manager` — `WorkerProcessManager`
- `agent.health-sink` — `SupervisorHealthSink`
- `agent.event-ledger` — `EventLedger`
- `agent.progress-sink` — `ProgressSink`
- `agent.worker-control` — `WorkerControl`
- `agent.steering-policy` — `SteeringPolicy`
- `agent.annotation-store` — `TaskAnnotationStore`
- `agent.recovery-policy` — `RecoveryPolicy`
- `agent.result-publisher` — `ResultPublisher`

The 0.1.1 runtime points are optional and do not change the stable 0.1 task/delivery wire protocol. See `docs/runtime-extensions.md`.

Hosts can define additional typed points with `defineExtensionPoint()`.

## Security boundary

The standard extension context contains only API/protocol versions, a clock, and a host-provided logger. It does not expose credentials, manager memory, private configuration, filesystem handles, or a shell. If an extension needs additional capabilities, the embedding application must inject them explicitly and remains responsible for their trust boundary.
