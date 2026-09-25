# Coordination Protocol 0.1

`PROTOCOL_VERSION` is **0.1.0**. The 0.1 line is the first tagged public protocol for Agent Coordinator.

## Compatibility

Before 1.0, protocol compatibility requires the same major **and minor** version. A 0.1.x peer is compatible with another 0.1.x peer; 0.2.x is not assumed compatible. Patch releases must preserve the 0.1 wire/state contract.

The public protocol is transport-neutral. `topic_id` is not a protocol field. Telegram maps its `message_thread_id`/topic identity to the protocol's `room_id` inside the Telegram adapter.

## Identity

A task has a stable `task_id`. Each attempt has a unique `execution_id`. A transport namespace is identified by `channel_id` + `room_id`. A worker process and every delivery are bound to the current execution.

A delivery is rejected unless all configured identity checks pass:

- expected immutable worker sender identity
- expected transport channel
- expected room
- matching task ID
- matching current execution ID
- task state allows delivery
- delivery/message ID has not already been consumed

## Durable events

The 0.1 event vocabulary is:

`task.prepared`, `room.created`, `input.attached`, `dispatch.requested`, `dispatch.confirmed`, `worker.started`, `worker.blocked`, `worker.failed`, `delivery.observed`, `review.rework`, `review.resume`, `review.accepted`, `task.cancelled`, `room.closed`, `reconciliation.recorded`.

Events carry a monotonically increasing sequence number, `task_id`, `execution_id`, and timestamp. `room.created` persists `channel_id` and `room_id`. Reconciliation audit records are state-neutral and must have stable decision keys when used for deduplication.

## Lifecycle

Normal flow:

`prepared -> dispatching -> dispatched -> delivering -> delivered -> accepted`

Exceptional/review states include `blocked`, `failed`, `reworking`, and `cancelled`.

Rework/resume preserves `task_id` and room, creates a distinct `execution_id`, and records the previous execution. Late deliveries from older executions remain auditable but cannot complete the current execution.

Manager review is accepted only for the current execution while its durable projection is `delivered`. A review returns explicit evidence (`review_id`, timestamp, source). Rework/resume requires non-empty requirements plus a new execution ID. Accept/cancel terminate the task and close its room.

## Transport and codec boundary

`CoordinationTransport` owns room lifecycle and message delivery. `WorkOrderCodec` owns the external work-order/reply representation. The coordinator performs identity checks after parsing, so a codec cannot weaken identity rules.

### Telegram reference wire format

Telegram maps one protocol room to one forum topic. Its work order may be rendered as:

```text
/task@<worker-bot>
task: <task-id>
execution: <execution-id>
title: <title>

<brief>

acceptance criteria:
- <criterion>
```

The Telegram reply parser tolerates surrounding prose, but task/execution/channel/room/sender/delivery identity remains strict. Formatting is tolerant; identity is strict.
