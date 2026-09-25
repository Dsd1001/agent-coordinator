# Roadmap

## v0.1 - reference extraction

- protocol schemas
- Telegram topic transport adapter
- Pi worker adapter
- sandbox fail-closed invariant
- sender allowlist
- example systemd deployment
- end-to-end task -> topic -> worker -> delivery -> review test

## v0.2 - durable coordination

- SQLite WAL task/event ledger
- structured deliveries and artifact hashes
- supervisor health/backoff metrics
- recovery/reconciliation tooling

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
