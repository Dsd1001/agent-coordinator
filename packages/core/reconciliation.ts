import {
  type EventLedger,
  type CoordinationEvent,
  projectTask
} from "./index.js";
import {
  type ExpectedDeliveryBinding,
  type ObservedDelivery,
  type TaskStatus,
  verifyDeliveryIdentity
} from "../protocol/src/index.js";

export interface ReconciliationTarget {
  task_id: string;
  execution_id: string;
  status: TaskStatus;
  channel_id?: string;
  topic_id?: string;
}

export interface DispatchObservation {
  state: "confirmed" | "unknown" | "absent";
  execution_id: string;
  message_id?: string;
}

export interface WorkerObservation {
  state: "running" | "stopped" | "unknown" | "absent";
  execution_id: string;
  worker_id?: string;
}

export interface TopicObservation {
  state: "closed" | "open" | "unknown";
  execution_id: string;
}

export interface ReconciliationTransportObserver {
  observeDispatch?(target: ReconciliationTarget): Promise<DispatchObservation | undefined>;
  observeDelivery?(target: ReconciliationTarget): Promise<ObservedDelivery | undefined>;
  observeTopic?(target: ReconciliationTarget): Promise<TopicObservation | undefined>;
}

export interface ReconciliationWorkerObserver {
  observeWorker?(target: ReconciliationTarget): Promise<WorkerObservation | undefined>;
}

export interface ReconciliationObservers {
  transport?: ReconciliationTransportObserver;
  worker?: ReconciliationWorkerObserver;
}

export interface ReconciliationOptions {
  worker_sender_id?: string;
}

export interface ReconciliationReport {
  task_id: string;
  execution_id: string;
  status_before: TaskStatus;
  status_after: TaskStatus;
  observations: string[];
  changes: string[];
  manual_actions: string[];
  appended_event_seqs: number[];
}

type ReconciliationKind = "dispatch" | "worker" | "delivery" | "review" | "topic";

function latestTopic(events: readonly CoordinationEvent[]): { channel_id?: string; topic_id?: string } {
  const event = [...events].reverse().find((candidate) => candidate.type === "topic.created");
  return {
    channel_id: typeof event?.data?.channel_id === "string" ? event.data.channel_id : undefined,
    topic_id: typeof event?.data?.topic_id === "string" ? event.data.topic_id : undefined
  };
}

function hasCurrentEvent(
  events: readonly CoordinationEvent[],
  executionId: string,
  types: readonly CoordinationEvent["type"][]
): boolean {
  return events.some((event) => event.execution_id === executionId && types.includes(event.type));
}

function latestCurrentEvent(
  events: readonly CoordinationEvent[],
  executionId: string,
  types: readonly CoordinationEvent["type"][]
): CoordinationEvent | undefined {
  return [...events]
    .reverse()
    .find((event) => event.execution_id === executionId && types.includes(event.type));
}

function decisionAlreadyRecorded(events: readonly CoordinationEvent[], executionId: string, decisionKey: string): boolean {
  return events.some(
    (event) =>
      event.execution_id === executionId &&
      event.type === "reconciliation.recorded" &&
      event.data?.decision_key === decisionKey
  );
}

function appendManualDecision(
  ledger: EventLedger,
  events: CoordinationEvent[],
  target: ReconciliationTarget,
  report: ReconciliationReport,
  kind: ReconciliationKind,
  decisionKey: string,
  observationState: string,
  message: string
): void {
  report.manual_actions.push(message);
  if (decisionAlreadyRecorded(events, target.execution_id, decisionKey)) return;
  const event = ledger.append({
    type: "reconciliation.recorded",
    task_id: target.task_id,
    execution_id: target.execution_id,
    data: {
      decision_key: decisionKey,
      kind,
      outcome: "manual_required",
      observation_state: observationState
    }
  });
  events.push(event);
  report.appended_event_seqs.push(event.seq);
}

function appendStateEvent(
  ledger: EventLedger,
  events: CoordinationEvent[],
  report: ReconciliationReport,
  input: Parameters<EventLedger["append"]>[0],
  change: string
): CoordinationEvent {
  const event = ledger.append(input);
  events.push(event);
  report.appended_event_seqs.push(event.seq);
  report.changes.push(change);
  return event;
}

function currentTarget(events: readonly CoordinationEvent[], taskId: string): ReconciliationTarget {
  const projection = projectTask(events, taskId);
  if (!projection) throw new Error(`task ${taskId} not found`);
  const topic = latestTopic(events);
  return {
    task_id: taskId,
    execution_id: projection.execution_id,
    status: projection.status,
    ...topic
  };
}

function deliveryBinding(target: ReconciliationTarget, workerSenderId?: string): ExpectedDeliveryBinding | undefined {
  if (!workerSenderId || !target.channel_id || !target.topic_id) return undefined;
  return {
    task_id: target.task_id,
    execution_id: target.execution_id,
    channel_id: target.channel_id,
    topic_id: target.topic_id,
    worker_sender_id: workerSenderId
  };
}

export async function reconcileTask(
  ledger: EventLedger,
  taskId: string,
  observers: ReconciliationObservers,
  options: ReconciliationOptions = {}
): Promise<ReconciliationReport> {
  const events = ledger.list(taskId);
  const initial = currentTarget(events, taskId);
  const report: ReconciliationReport = {
    task_id: taskId,
    execution_id: initial.execution_id,
    status_before: initial.status,
    status_after: initial.status,
    observations: [],
    changes: [],
    manual_actions: [],
    appended_event_seqs: []
  };

  // Dispatch intent without a receipt is ambiguous. We only advance when the
  // transport can positively confirm the current execution's external message.
  if (
    hasCurrentEvent(events, initial.execution_id, ["dispatch.requested"]) &&
    !hasCurrentEvent(events, initial.execution_id, ["dispatch.confirmed", "worker.failed", "task.cancelled"])
  ) {
    const observation = await observers.transport?.observeDispatch?.(initial);
    if (!observation) {
      appendManualDecision(
        ledger,
        events,
        initial,
        report,
        "dispatch",
        `dispatch:${initial.execution_id}:unobserved`,
        "unobserved",
        "Dispatch intent has no external receipt evidence; do not resend automatically."
      );
    } else if (observation.execution_id !== initial.execution_id) {
      report.observations.push(`Dispatch evidence belongs to stale execution ${observation.execution_id}.`);
      appendManualDecision(
        ledger,
        events,
        initial,
        report,
        "dispatch",
        `dispatch:${initial.execution_id}:stale:${observation.execution_id}`,
        "stale_execution",
        "Dispatch evidence is for a stale execution; current dispatch remains unresolved."
      );
    } else if (observation.state === "confirmed" && observation.message_id) {
      report.observations.push(`Transport confirms dispatch message ${observation.message_id}.`);
      appendStateEvent(
        ledger,
        events,
        report,
        {
          type: "dispatch.confirmed",
          task_id: initial.task_id,
          execution_id: initial.execution_id,
          data: {
            message_id: observation.message_id,
            reconciled: true,
            evidence: "transport_receipt"
          }
        },
        `Recorded confirmed dispatch message ${observation.message_id}.`
      );
    } else {
      report.observations.push(`Transport reports dispatch state ${observation.state}.`);
      appendManualDecision(
        ledger,
        events,
        initial,
        report,
        "dispatch",
        `dispatch:${initial.execution_id}:${observation.state}`,
        observation.state,
        "Dispatch outcome is not positively confirmed; do not resend automatically."
      );
    }
  }

  let target = currentTarget(events, taskId);

  // A confirmed dispatch with no terminal result can have an uncertain worker
  // start after a supervisor crash. A read-only worker observation may confirm
  // the start; absence never triggers an automatic restart.
  if (
    hasCurrentEvent(events, target.execution_id, ["dispatch.confirmed"]) &&
    !hasCurrentEvent(events, target.execution_id, ["worker.started", "delivery.observed", "worker.blocked", "worker.failed"])
  ) {
    const observation = await observers.worker?.observeWorker?.(target);
    if (!observation) {
      appendManualDecision(
        ledger,
        events,
        target,
        report,
        "worker",
        `worker:${target.execution_id}:unobserved`,
        "unobserved",
        "Worker start has no runtime evidence; do not restart automatically."
      );
    } else if (observation.execution_id !== target.execution_id) {
      report.observations.push(`Worker evidence belongs to stale execution ${observation.execution_id}.`);
      appendManualDecision(
        ledger,
        events,
        target,
        report,
        "worker",
        `worker:${target.execution_id}:stale:${observation.execution_id}`,
        "stale_execution",
        "Worker evidence is stale; current worker start remains unresolved."
      );
    } else if (observation.state === "running" && observation.worker_id) {
      report.observations.push(`Runtime confirms worker ${observation.worker_id} is running.`);
      appendStateEvent(
        ledger,
        events,
        report,
        {
          type: "worker.started",
          task_id: target.task_id,
          execution_id: target.execution_id,
          data: {
            worker_id: observation.worker_id,
            reconciled: true,
            evidence: "worker_runtime"
          }
        },
        `Recorded running worker ${observation.worker_id}.`
      );
    } else {
      report.observations.push(`Runtime reports worker state ${observation.state}.`);
      appendManualDecision(
        ledger,
        events,
        target,
        report,
        "worker",
        `worker:${target.execution_id}:${observation.state}`,
        observation.state,
        "Worker start is not positively confirmed; do not start another worker automatically."
      );
    }
  }

  target = currentTarget(events, taskId);

  // Recover a delivery that exists externally but was not committed locally.
  // Identity binding must pass against the current execution before any state
  // change is accepted.
  if (!hasCurrentEvent(events, target.execution_id, ["delivery.observed", "worker.blocked", "worker.failed"])) {
    const observation = await observers.transport?.observeDelivery?.(target);
    if (observation) {
      const binding = deliveryBinding(target, options.worker_sender_id);
      if (!binding) {
        appendManualDecision(
          ledger,
          events,
          target,
          report,
          "delivery",
          `delivery:${target.execution_id}:binding_unavailable`,
          "binding_unavailable",
          "Delivery evidence cannot be reconciled without channel/topic and expected worker identity."
        );
      } else {
        const errors = verifyDeliveryIdentity(binding, observation);
        if (errors.length > 0) {
          report.observations.push(`Delivery evidence rejected: ${errors.join(", ")}.`);
          appendManualDecision(
            ledger,
            events,
            target,
            report,
            "delivery",
            `delivery:${target.execution_id}:rejected:${errors.join("+")}`,
            "identity_rejected",
            "Delivery evidence failed current task/execution/channel/topic/worker identity checks."
          );
        } else {
          const type =
            observation.payload.status === "delivered"
              ? "delivery.observed"
              : observation.payload.status === "blocked"
                ? "worker.blocked"
                : "worker.failed";
          report.observations.push(`Transport confirms ${observation.payload.status} delivery ${observation.delivery_id}.`);
          appendStateEvent(
            ledger,
            events,
            report,
            {
              type,
              task_id: target.task_id,
              execution_id: target.execution_id,
              data: {
                message_id: observation.delivery_id,
                summary: observation.payload.summary,
                reconciled: true,
                evidence: "transport_delivery"
              }
            },
            `Recorded ${observation.payload.status} delivery ${observation.delivery_id}.`
          );
        }
      }
    }
  }

  target = currentTarget(events, taskId);

  // Delivered work requires a manager review. Recovery never fabricates an
  // accept/rework decision; it surfaces the pending human/control-plane step.
  const delivery = latestCurrentEvent(events, target.execution_id, ["delivery.observed"]);
  if (
    delivery &&
    !hasCurrentEvent(events, target.execution_id, ["review.accepted", "review.rework", "review.resume", "task.cancelled"])
  ) {
    appendManualDecision(
      ledger,
      events,
      target,
      report,
      "review",
      `review:${target.execution_id}:delivery:${delivery.seq}`,
      "delivery_unreviewed",
      "A delivered result is awaiting manager review; reconcile does not auto-accept or auto-rework."
    );
  }

  target = currentTarget(events, taskId);

  // Acceptance may have succeeded before a crash while topic closure was still
  // uncertain. Only an observed closed topic is committed; open/unknown states
  // never call close again from reconciliation.
  if (
    hasCurrentEvent(events, target.execution_id, ["review.accepted", "task.cancelled"]) &&
    !hasCurrentEvent(events, target.execution_id, ["topic.closed"])
  ) {
    const observation = await observers.transport?.observeTopic?.(target);
    if (!observation) {
      appendManualDecision(
        ledger,
        events,
        target,
        report,
        "topic",
        `topic:${target.execution_id}:unobserved`,
        "unobserved",
        "Terminal task has no topic-close evidence; do not repeat the close side effect automatically."
      );
    } else if (observation.execution_id !== target.execution_id) {
      report.observations.push(`Topic evidence belongs to stale execution ${observation.execution_id}.`);
      appendManualDecision(
        ledger,
        events,
        target,
        report,
        "topic",
        `topic:${target.execution_id}:stale:${observation.execution_id}`,
        "stale_execution",
        "Topic-close evidence is stale; current close outcome remains unresolved."
      );
    } else if (observation.state === "closed") {
      report.observations.push("Transport confirms the task topic is closed.");
      appendStateEvent(
        ledger,
        events,
        report,
        {
          type: "topic.closed",
          task_id: target.task_id,
          execution_id: target.execution_id,
          data: {
            topic_id: target.topic_id ?? "",
            reconciled: true,
            evidence: "transport_topic_state"
          }
        },
        "Recorded confirmed topic closure."
      );
    } else {
      report.observations.push(`Transport reports topic state ${observation.state}.`);
      appendManualDecision(
        ledger,
        events,
        target,
        report,
        "topic",
        `topic:${target.execution_id}:${observation.state}`,
        observation.state,
        "Topic is not confirmed closed; reconciliation will not repeat the close side effect automatically."
      );
    }
  }

  const finalProjection = projectTask(events, taskId);
  if (!finalProjection) throw new Error(`task ${taskId} disappeared during reconciliation`);
  report.status_after = finalProjection.status;
  return report;
}
