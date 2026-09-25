# Reference Deployment

The reference security model deliberately keeps a privileged manager separate from a non-root worker runtime.

## Host identities

- Manager: deployment-defined; may be privileged when its responsibilities require it.
- Worker supervisor and worker processes: dedicated non-root account such as `agent-worker`.
- Worker account needs only its state/workspace paths, required credentials, the worker runtime, and sandbox device access such as KVM when applicable.

## Secrets

Keep transport and model-provider credentials outside repository configuration. Prefer root-owned files readable only by the service group or a platform secret manager. Example configuration files must contain placeholders only.

## Remote worker invariant

A remotely dispatched worker must not fall back to host `read`, `write`, `edit`, or `bash` tools when sandbox initialization fails. Fail the job instead.

## Telegram reference mapping

A newly prepared task creates one forum topic. The topic/thread ID becomes a routing namespace for a worker conversation. Rework/resume creates a new execution ID while retaining the task/room relationship.

## Supervisor health

Expose reliability state through the transport/runtime-neutral `SupervisorHealthTracker`. Operators should be able to inspect the last successful poll, consecutive poll failures, effective retry delay, and per-worker cold-start retry state without reading process logs.

The health sink must not contain bot/model credentials, provider configuration, raw transport messages, prompts, or exception text. Use stable opaque worker/room identifiers only. The bundled atomic JSON sink writes private mode-0600 snapshots; deployments may replace it with a metrics/backend adapter.
