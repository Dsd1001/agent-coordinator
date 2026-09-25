# protocol

Transport-neutral contracts and identity rules shared by the coordinator and adapters.

## Adapter contracts

- `CoordinationRoom`: stable `channel_id` + `room_id` routing namespace.
- `CoordinationMessage`: inbound message identity, sender identity, room identity, and text.
- `CoordinationTransport`: create room, send into room, close room.
- `WorkOrderCodec`: derive a room title, render a task work order, and parse a worker protocol reply.

The coordinator owns task/execution lifecycle and identity enforcement. A transport or codec may choose its own external representation but cannot weaken the coordinator's worker sender, channel/room, task, execution, or delivery-id checks.

`TaskEnvelope.topic_id` and delivery-binding `topic_id` remain compatibility fields from the Telegram-first v0.1 protocol. New adapter code should use `room_id`; the coordinator maps a generic room into those persisted compatibility fields while the pre-1.0 protocol evolves.

## Manager contracts

`ManagerAdapter` is framework-neutral. A manager adapter prepares a task/execution and reviews a delivery only after the caller supplies `DeliveryVerificationEvidence`. Review results always preserve the reviewed `task_id` and `execution_id`, include explicit `ManagerReviewEvidence`, and may return `accept`, `cancel`, `rework`, or `resume`. Rework/resume also carry a new execution ID and requirements.
