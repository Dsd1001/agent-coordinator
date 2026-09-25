# Roadmap

The earlier v0.1/v0.2/v0.3 labels used during repository construction were **internal pre-release milestones**, not public semantic versions. The first tagged public release is `0.1.0`.

## Pre-release milestones — complete

### Reference extraction

- [x] protocol schemas and executable core
- [x] Telegram forum-topic reference transport
- [x] Pi worker reference adapter
- [x] fail-closed sandbox invariant
- [x] sender/cold-start authorization
- [x] end-to-end task -> room -> worker -> delivery -> review flow

### Durable coordination

- [x] SQLite WAL event ledger
- [x] structured delivery/artifact hash verification
- [x] supervisor health/backoff metrics
- [x] recovery/reconciliation tooling

### Adapter architecture

- [x] transport-independent coordinator and codec ports
- [x] replaceable fail-closed sandbox backend
- [x] clean Hermes manager adapter
- [x] replaceable worker process manager boundary

## Release 0.1.0 — complete

- [x] stabilize protocol 0.1 and canonical `room_id` events/identity
- [x] resource quotas and concurrency admission policy
- [x] audit and enforce recovery semantic invariants
- [x] publish extension API 0.1 with atomic registration
- [x] version all workspace packages consistently
- [x] document compatibility, security, resources, recovery, and extensions

## Next

Future minor releases can add additional transports/backends, distributed admission control, richer observability, and protocol extensions. Before 1.0, a minor version may intentionally revise public contracts; patch releases within a minor line should remain compatible.
