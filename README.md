# Agent Coordinator

[![CI](https://github.com/Dsd1001/agent-coordinator/actions/workflows/ci.yml/badge.svg)](https://github.com/Dsd1001/agent-coordinator/actions/workflows/ci.yml)

An open-source manager/worker agent coordination framework.

The reference architecture keeps a privileged manager agent in control of task planning and review while delegating execution to short-lived, isolated worker agents. Telegram forum topics are used as human-visible task rooms in the first adapter, but the coordination protocol is transport-independent.

## Core model

- **Manager**: creates tasks, defines acceptance criteria, reviews deliveries, and decides accept/rework/resume/cancel.
- **Task**: stable identity for one unit of work.
- **Execution**: one attempt of a task. Rework/resume creates a new execution identity.
- **Topic**: optional human-visible collaboration namespace. In the Telegram adapter, one task maps to one forum topic.
- **Worker**: isolated execution runtime bound to a task topic and current execution.
- **Delivery**: structured worker handoff containing summary, artifacts, checks, and limitations.

## Reference deployment

`Hermes manager -> coordination layer -> Telegram forum topic -> Pi worker -> Gondolin VM`

The public project will not contain production credentials, chat IDs, historical sessions, user data, or private Consultant source code.

## Status

Public early-stage v0.1. The repository contains a clean implementation of the protocol and security invariants extracted from a running reference architecture; production state and private coordination source are intentionally excluded.

## Current v0.1 staging capabilities

The staging tree now contains executable TypeScript for:

- task lifecycle transitions with in-memory and SQLite WAL event ledgers
- task/execution/channel/topic/worker delivery identity verification
- SHA-256 verification for workspace-scoped delivery artifacts
- Telegram forum topic creation, sending, and closing
- coordinator/administrator sender allowlists based on immutable user IDs
- the reference `/task` dispatch and `deliver|blocked|failed` reply protocol
- a minimal coordinator that runs task -> topic -> dispatch -> delivery -> accept
- Pi remote-worker fail-closed policy helpers
- a hardened systemd worker-supervisor example

Run `npm test` and `npm run release-check` before any public push.

## License

Apache-2.0. See `LICENSE` and `THIRD_PARTY_NOTICES.md`.
