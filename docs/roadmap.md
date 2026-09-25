# Roadmap

## v0.1 - reference extraction — complete

- [x] protocol schemas
- [x] Telegram topic transport adapter
- [x] Pi worker adapter
- [x] sandbox fail-closed invariant
- [x] sender allowlist and authenticated worker cold-start
- [x] example systemd deployment
- [x] end-to-end task -> topic -> worker -> delivery -> review test

## v0.2 - durable coordination

- [#1](https://github.com/Dsd1001/agent-coordinator/issues/1) SQLite WAL task/event ledger
- [#2](https://github.com/Dsd1001/agent-coordinator/issues/2) structured deliveries and artifact hash verification
- [#3](https://github.com/Dsd1001/agent-coordinator/issues/3) supervisor health/backoff metrics
- [#4](https://github.com/Dsd1001/agent-coordinator/issues/4) recovery/reconciliation tooling

## v0.3 - adapters

- transport-independent core
- additional manager/worker adapters
- replaceable sandbox backend
- replaceable worker process manager

## v1.0

- stable protocol
- resource quotas and concurrency policy
- audited recovery semantics
- documented extension API
