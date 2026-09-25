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

The first reference adapter uses Telegram forum topics. A topic is a task room and routing namespace, not the source of truth for task state.

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
- `Transport`: create topic/channel, send messages, observe messages, close topic/channel.
- `WorkerBackend`: start, stop, inspect, and resume workers.
- `SandboxBackend`: create isolated execution environment and mount workspace/shared storage.
- `Ledger`: durable task/execution/event/artifact state.

## Pi worker launch boundary

The Pi adapter builds an argv-based process specification containing provider/model, session directory, extension, session ID, and `--chat-conversation`. It does not own tmux/systemd/container policy. A separate `WorkerProcessManager` owns start/inspect/stop semantics. This keeps the coordination protocol portable while avoiding shell-string construction at the security boundary.
