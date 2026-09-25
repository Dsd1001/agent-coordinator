# adapter-hermes

Clean manager-side adapter for integrating Hermes with Agent Coordinator.

This package does not import or copy the private Consultant coordination implementation. A deployment injects a `HermesManagerClient` with exactly two operations:

- `prepareTask(request)` — make the current task/execution available to the manager and return a manager reference.
- `reviewDelivery(request)` — review an already verified delivery and return `accept`, `rework`, `resume`, or `cancel`.

Every request and response carries `task_id` and `execution_id`. The adapter rejects mismatched identities and malformed review decisions. Rework/resume must include both a **new** `next_execution_id` and non-empty requirements.

## Verified-delivery boundary

`reviewDelivery()` requires `DeliveryVerificationEvidence` with both identity and artifact verification set to literal `true`. A deployment should obtain that evidence only after the coordinator's delivery identity and artifact verification steps have passed.

## Error boundary

`HermesAdapterError` exposes only structured operation/code/task/execution/retryability fields. Errors thrown by the injected Hermes client are intentionally not copied into the public error message or `cause`, so credentials, prompts, memories, or other private context in upstream exceptions cannot leak through this adapter.

## Real deployment responsibility

A real Hermes integration supplies the `HermesManagerClient` implementation and privately handles authentication, sessions, prompts, memory, model configuration, and any framework-specific APIs. None of those belong in the public coordination protocol.
