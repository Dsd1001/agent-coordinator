# protocol

Stable transport/framework-neutral contracts for the Agent Coordinator 0.1 protocol line.

`PROTOCOL_VERSION` is `0.1.0`. Before 1.0, patch releases within the same major+minor line are wire-compatible; a minor version change may change the protocol. `assertProtocolCompatible()` enforces this rule.

## Core identities

- `task_id`: stable work identity.
- `execution_id`: one attempt; rework/resume creates a new value.
- `channel_id` + `room_id`: transport-neutral routing identity.
- `worker_sender_id`: immutable expected worker identity.
- `delivery_id`: unique transport delivery/message identity.

`topic_id` is not part of the public 0.1 protocol. Telegram keeps its forum-topic identifier inside the Telegram adapter and maps it to `room_id`.

## Adapter contracts

- `CoordinationTransport`: create/send/close a room.
- `WorkOrderCodec`: render work orders and parse worker replies.
- `ManagerAdapter`: task preparation and verified-delivery review.
- `WorkerBackend` / `WorkerProcessManager`: worker lifecycle and process launch.

Adapters cannot weaken task/execution/channel/room/sender identity verification.
