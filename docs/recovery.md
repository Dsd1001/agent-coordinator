# Recovery and reconciliation

Recovery is evidence-driven. The reconciler never repeats an external side effect merely because the local ledger is incomplete.

## Recovery invariant audit

`auditRecoverySemantics()` performs an offline audit of durable event history. Hard errors include invalid/duplicate/non-monotonic sequences, unknown event types, dispatch confirmation without intent, duplicate worker starts or terminal results, duplicate delivery IDs, invalid rework execution rotation, acceptance without delivery, duplicate reconciliation decision keys, and room closure before task termination.

`reconcileTask()` calls `assertRecoverySemantics()` **before** observer access and again after appending reconciled events. Corrupt history therefore fails closed before transport/worker observers are called.

Warnings report suspicious but not necessarily invalid histories, such as a worker result with no recorded room.

## Ambiguous external side effects

External sends, worker starts, and room closes can have an unknown outcome when a process crashes or a network response is lost. Repeating them blindly can duplicate work or messages. Reconciliation consumes read-only observations and only appends local state when evidence positively confirms the outcome.

The observer interfaces intentionally expose no `send`, `start`, or `close` method.

| Durable state | Observation | Reconciliation result |
| --- | --- | --- |
| `dispatch.requested`, no receipt | confirmed current-execution message | append `dispatch.confirmed` |
| `dispatch.requested`, no receipt | unknown/absent/stale | audit + manual action; never resend |
| confirmed dispatch, no worker record | current worker running | append `worker.started` |
| confirmed dispatch, no worker record | unknown/absent/stale | audit + manual action; never start another worker |
| no terminal result | delivery matching task/execution/channel/room/worker | append delivery/blocked/failed event |
| no terminal result | stale/wrongly routed delivery | reject + audit; current execution unchanged |
| delivered, no review | any | surface manager-review action; never auto-accept/rework |
| accepted/cancelled, no `room.closed` | room observed closed | append `room.closed` |
| accepted/cancelled, no `room.closed` | open/unknown/stale | audit + manual action; never repeat close |

## Idempotency

Confirmed state events make the corresponding recovery path ineligible on the next run. Unresolved decisions use stable `reconciliation.recorded` decision keys, so repeated reconciliation does not append duplicate audit decisions.

## Library entry point

```ts
const report = await reconcileTask(
  ledger,
  "task-123",
  {
    transport: {
      observeDispatch: async (target) => lookupDispatchReceipt(target),
      observeDelivery: async (target) => lookupWorkerDelivery(target),
      observeRoom: async (target) => lookupRoomState(target)
    },
    worker: {
      observeWorker: async (target) => lookupWorkerRuntime(target)
    }
  },
  { worker_sender_id: "expected-worker-user-id" }
);
```

The report separates observations, local changes, and manual actions, and includes appended event sequence numbers. Observer evidence should use immutable message/runtime identities where possible.
