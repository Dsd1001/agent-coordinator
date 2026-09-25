# Architecture

## Components

```text
User
  |
  v
Manager Agent (control plane)
  |
  v
Coordinator / Task Ledger
  |                    \
  |                     -> Human-visible transport adapter
  v
Worker Dispatcher
  |
  v
Worker Runtime (non-root)
  |
  v
Execution Sandbox
```

The coordinator uses a transport-neutral room abstraction. The first reference adapter maps one room to one Telegram forum topic. A room/topic is a human-visible routing namespace, not the source of truth for task state.

## Recommended trust boundary

```text
privileged manager
      |
      | structured task + copied inputs
      v
non-root worker runtime
      |
      v
sandboxed execution
```

Manager privilege is never inherited by the worker.

## Adapter boundaries

- `ManagerAdapter`: task/review integration with a manager agent.
- `CoordinationTransport`: create a room, send messages, and close a room.
- `WorkOrderCodec`: render task work orders and parse worker protocol replies without coupling the coordinator to a transport wire format.
- `WorkerBackend`: start, stop, inspect, and resume workers.
- `SandboxBackend`: create isolated execution environment and mount workspace/shared storage.
- `Ledger`: durable task/execution/event/artifact state.

## Pi worker launch boundary

The Pi adapter builds an argv-based process specification containing provider/model, session directory, extension, session ID, and `--chat-conversation`. It does not own tmux/systemd/container policy. A separate `WorkerProcessManager` owns start/inspect/stop semantics. This keeps the coordination protocol portable while avoiding shell-string construction at the security boundary.

## Dependency direction

```text
protocol contracts <- coordinator
        ^                 ^
        |                 |
Telegram adapter ---------+  (injected at runtime, never imported by coordinator)
```

`packages/coordinator` has no compile-time dependency on `transport-telegram`. A transport adapter implements `CoordinationTransport`; a wire-format adapter implements `WorkOrderCodec`. The Telegram package supplies both reference implementations.

The generic adapter contract uses `room_id`. The older `topic_id` field remains in persisted v0.1 protocol structures for compatibility and is populated from the generic room ID until the stable protocol migration is complete.
