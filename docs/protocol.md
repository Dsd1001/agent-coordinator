# Coordination Protocol

## Identity

A task has a stable `task_id`. Each attempt has a unique `execution_id`. A transport-neutral `room_id` namespace is bound to the task. A worker process is bound to the current execution. Telegram maps that room to a forum `topic_id`.

## States

Suggested task states:

`prepared -> dispatching -> dispatched -> delivering -> delivered -> accepted`

Exceptional/review states include `blocked`, `failed`, `reworking`, and `cancelled`.

## Delivery verification

A manager must reject a delivery unless all configured identity checks pass:

- expected worker sender identity
- expected transport channel/chat
- expected room/thread
- matching task ID
- matching current execution ID
- task state allows delivery
- message/delivery has not already been consumed

## Rework and resume

Rework/resume creates a new `execution_id`. Stale deliveries from older executions remain auditable but cannot complete the current execution.

## Transport and codec boundary

The coordinator does not define how rooms or worker messages are represented externally. `CoordinationTransport` owns room lifecycle/message delivery and `WorkOrderCodec` owns work-order/reply representation. Identity checks happen after parsing and cannot be weakened by a codec.

The Telegram reference adapter maps `room_id` to its forum `topic_id`. The persisted `topic_id` compatibility field is still populated during the pre-1.0 migration.

## Telegram reference wire format

The Telegram adapter may render a work order as a human-readable command while preserving structured identity fields:

```text
/task@<worker-bot>
task: <task-id>
execution: <execution-id>
title: <title>

<brief>

acceptance criteria:
- <criterion>

Verified input files:
- <workspace path> (sha256: <digest>)
```

A worker reply is parsed permissively because a worker LLM may put the configured coordinator address inside surrounding prose. Both `/deliver@<coordinator> <task>` and `@<coordinator> deliver <task>` forms are accepted anywhere in the message, as are `blocked` and `failed`. Placeholder examples such as `<taskId>` are rejected. The execution ID remains mandatory.

This tolerant parsing is safe only together with the hard identity binding: sender authorization uses immutable platform user IDs, and the coordinator separately verifies channel, topic, task ID, current execution ID, and delivery/message ID. **Formatting is tolerant; identity is strict.**

## Rework and resume in a room

Rework/resume keeps the stable task and transport room but creates a new execution ID. In Telegram, this means retaining the same forum topic. The old execution remains auditable. Any late delivery carrying the previous execution ID is rejected for the current attempt. The same transport message/delivery ID must not be consumed twice.

## Manager review protocol

A manager review is bound to the current `task_id` and `execution_id`. The caller supplies a verification record only after delivery identity and artifact verification have passed. The manager returns explicit review evidence (`review_id`, timestamp, source) so accept/rework/resume/cancel decisions can be audited in the event ledger.

For `rework` and `resume`, the reviewed execution remains immutable and the decision supplies a distinct `next_execution_id` plus non-empty requirements. The coordinator reuses the stable task/room and dispatches the new execution. `accept` and `cancel` terminate the task and close its room; uncertain room-close outcomes remain recoverable through reconciliation.
