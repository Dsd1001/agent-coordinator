# Recovery and reconciliation

Recovery is evidence-driven. The reconciler never repeats an external side effect merely because the local ledger is incomplete.

## Principle

External sends, worker starts, and topic closes can have an **unknown outcome** when a process crashes or a network request loses its response. Repeating those operations blindly can duplicate work or messages. `reconcileTask()` therefore consumes **read-only observations** and only updates the local ledger when external evidence positively confirms an outcome.

The observer interfaces intentionally expose no `send`, `start`, or `close` method.

## Recoverable situations

| Local durable state | Observation | Reconciliation result |
| --- | --- | --- |
| `dispatch.requested`, no receipt | confirmed current-execution message | append `dispatch.confirmed` |
| `dispatch.requested`, no receipt | unknown/absent/stale | audit + manual action; never resend |
| confirmed dispatch, no worker record | current worker is running | append `worker.started` |
| confirmed dispatch, no worker record | unknown/absent/stale | audit + manual action; never start another worker |
| no terminal delivery | delivery matching task/execution/channel/topic/worker | append delivery/blocked/failed event |
| no terminal delivery | stale or wrongly routed delivery | reject + audit; current execution unchanged |
| delivered, no review | any | surface manager-review action; never auto-accept/rework |
| accepted, no `topic.closed` | current topic observed closed | append `topic.closed` |
| accepted, no `topic.closed` | open/unknown/stale | audit + manual action; never repeat close |

## Idempotency

Confirmed state events make their own reconciliation path ineligible on the next run. Unresolved decisions are recorded as `reconciliation.recorded` with stable `decision_key` values, so repeated reconciliation does not append duplicate audit events.

This makes `reconcileTask()` suitable for repeated operator use after process restarts.

## Library entry point

```ts
import { SqliteEventLedger, reconcileTask } from "@agent-coordinator/core";

const ledger = new SqliteEventLedger("./state/coordinator.db");
const report = await reconcileTask(
  ledger,
  "task-123",
  {
    transport: {
      observeDispatch: async (target) => lookupDispatchReceipt(target),
      observeDelivery: async (target) => lookupWorkerDelivery(target),
      observeTopic: async (target) => lookupTopicState(target)
    },
    worker: {
      observeWorker: async (target) => lookupWorkerRuntime(target)
    }
  },
  { worker_sender_id: "expected-worker-user-id" }
);

console.log(JSON.stringify(report, null, 2));
ledger.close();
```

The report separates `observations`, local `changes`, and `manual_actions`, and includes the sequence numbers of audit/state events appended during that run.

## Adapter requirements

Observers should return immutable platform/runtime evidence where possible: transport message IDs, execution IDs, worker process IDs, and topic state. Delivery observations are still subject to the normal task/execution/channel/topic/worker identity binding before they may change task state.

Observers are expected to be read-only. Mutating external systems from an observation method defeats the recovery safety model.
