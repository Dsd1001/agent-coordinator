# Roadmap

## v0.1 - reference extraction — complete

- [x] protocol schemas
- [x] Telegram topic transport adapter
- [x] Pi worker adapter
- [x] sandbox fail-closed invariant
- [x] sender allowlist and authenticated worker cold-start
- [x] example systemd deployment
- [x] end-to-end task -> topic -> worker -> delivery -> review test

## v0.2 - durable coordination — complete

- [x] [#1](https://github.com/Dsd1001/agent-coordinator/issues/1) SQLite WAL task/event ledger
- [x] [#2](https://github.com/Dsd1001/agent-coordinator/issues/2) structured deliveries and artifact hash verification
- [x] [#3](https://github.com/Dsd1001/agent-coordinator/issues/3) supervisor health/backoff metrics
- [x] [#4](https://github.com/Dsd1001/agent-coordinator/issues/4) recovery/reconciliation tooling

## v0.3 - adapter architecture

- [ ] [#10](https://github.com/Dsd1001/agent-coordinator/issues/10) decouple coordinator core from Telegram transport and wire format
- [ ] [#11](https://github.com/Dsd1001/agent-coordinator/issues/11) define a replaceable fail-closed sandbox backend
- [ ] [#12](https://github.com/Dsd1001/agent-coordinator/issues/12) implement a clean Hermes manager adapter
- [x] replaceable worker process manager boundary (`WorkerProcessManager`)

The existing Pi worker remains the reference worker adapter. Once #10 and #12 land, Hermes + Pi + Telegram will be reference adapters around a transport/framework-neutral coordination core rather than dependencies of that core.

## v1.0

- stable protocol
- resource quotas and concurrency policy
- audited recovery semantics
- documented extension API
