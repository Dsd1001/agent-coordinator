# Agent Coordinator

[![CI](https://github.com/Dsd1001/agent-coordinator/actions/workflows/ci.yml/badge.svg)](https://github.com/Dsd1001/agent-coordinator/actions/workflows/ci.yml)

An open-source manager/worker agent coordination framework.

**Current release: 0.1.0** · Protocol: `0.1.x` · Extension API: `0.1.x` · Node.js >= 22.13

The architecture keeps a manager agent in control of task planning and review while delegating execution to short-lived isolated workers. The coordination core is transport/framework neutral; Telegram, Hermes, Pi, and Gondolin are reference adapters/boundaries.

## Core model

- **Manager**: creates tasks, acceptance criteria, and review decisions.
- **Task**: stable identity for one unit of work.
- **Execution**: one attempt; rework/resume creates a new execution ID.
- **Room**: transport-neutral collaboration/routing namespace.
- **Worker**: isolated execution runtime bound to task + current execution.
- **Delivery**: structured handoff containing summary, artifacts, checks, and limitations.

## 0.1.0 capabilities

- stable versioned protocol with canonical task/execution/channel/room/worker identity
- SQLite WAL durable event ledger
- SHA-256 artifact verification with path/symlink defenses and artifact quotas
- global/per-worker concurrency admission with a bounded queue
- runtime/memory limits propagated to worker process managers
- framework-neutral manager review with explicit review evidence
- evidence-driven reconciliation plus offline recovery semantic audit
- supervisor health/backoff model
- versioned atomic extension API and registry
- fail-closed sandbox backend and Gondolin reference boundary
- Telegram forum transport/codec reference adapter
- Pi worker reference adapter
- clean injected Hermes manager adapter

Reference deployment mapping:

`Hermes manager -> coordinator -> Telegram room/topic -> Pi worker -> Gondolin sandbox`

Production credentials, chat IDs, historical sessions, user data, manager memories, and private Consultant source are intentionally excluded.

## Development

```text
npm ci
npm test
npm run release-check
```

See `docs/protocol.md`, `docs/resource-policy.md`, `docs/recovery.md`, `docs/extensions.md`, `docs/architecture.md`, and `SECURITY.md`.

## License

Apache-2.0. See `LICENSE` and `THIRD_PARTY_NOTICES.md`.
