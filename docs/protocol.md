# Coordination Protocol

## Identity

A task has a stable `task_id`. Each attempt has a unique `execution_id`. A transport namespace such as `topic_id` is bound to the task. A worker process is bound to the current execution.

## States

Suggested task states:

`prepared -> dispatching -> dispatched -> delivering -> delivered -> accepted`

Exceptional/review states include `blocked`, `failed`, `reworking`, and `cancelled`.

## Delivery verification

A manager must reject a delivery unless all configured identity checks pass:

- expected worker sender identity
- expected transport channel/chat
- expected topic/thread
- matching task ID
- matching current execution ID
- task state allows delivery
- message/delivery has not already been consumed

## Rework and resume

Rework/resume creates a new `execution_id`. Stale deliveries from older executions remain auditable but cannot complete the current execution.

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

## Rework and resume on a topic

Rework/resume keeps the stable task and transport topic but creates a new execution ID. The old execution remains auditable. Any late delivery carrying the previous execution ID is rejected for the current attempt. The same transport message/delivery ID must not be consumed twice.
