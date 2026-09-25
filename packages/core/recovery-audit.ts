import type { CoordinationEvent, CoordinationEventType } from "./index.js";

export type RecoveryAuditSeverity = "error" | "warning";

export interface RecoveryAuditFinding {
  severity: RecoveryAuditSeverity;
  code: string;
  message: string;
  task_id?: string;
  execution_id?: string;
  seq?: number;
}

export interface RecoveryAuditReport {
  ok: boolean;
  event_count: number;
  task_count: number;
  findings: RecoveryAuditFinding[];
}


const KNOWN_EVENT_TYPES = new Set<string>([
  "task.prepared",
  "room.created",
  "input.attached",
  "dispatch.requested",
  "dispatch.confirmed",
  "worker.started",
  "worker.blocked",
  "worker.failed",
  "delivery.observed",
  "review.rework",
  "review.resume",
  "review.accepted",
  "task.cancelled",
  "room.closed",
  "reconciliation.recorded"
]);

const DELIVERY_TYPES = new Set<CoordinationEventType>(["delivery.observed", "worker.blocked", "worker.failed"]);
const TERMINAL_TASK_TYPES = new Set<CoordinationEventType>(["review.accepted", "task.cancelled"]);

function stringData(event: CoordinationEvent, key: string): string | undefined {
  const value = event.data?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function finding(
  findings: RecoveryAuditFinding[],
  severity: RecoveryAuditSeverity,
  code: string,
  event: CoordinationEvent | undefined,
  message: string,
  taskId?: string,
  executionId?: string
): void {
  findings.push({
    severity,
    code,
    message,
    ...(event ? { task_id: event.task_id, execution_id: event.execution_id, seq: event.seq } : {}),
    ...(!event && taskId ? { task_id: taskId } : {}),
    ...(!event && executionId ? { execution_id: executionId } : {})
  });
}

export function auditRecoverySemantics(
  input: readonly CoordinationEvent[],
  taskId?: string
): RecoveryAuditReport {
  const filtered = input.filter((event) => taskId === undefined || event.task_id === taskId);
  const findings: RecoveryAuditFinding[] = [];
  let inputPreviousSeq = -1;
  for (const event of filtered) {
    if (event.seq <= inputPreviousSeq) {
      finding(findings, "error", "non_monotonic_seq", event, "event sequence is not monotonic in ledger order");
    }
    inputPreviousSeq = event.seq;
  }
  const events = filtered.slice().sort((a, b) => a.seq - b.seq);
  const tasks = new Map<string, CoordinationEvent[]>();
  const seenSeq = new Set<number>();

  for (const event of events) {
    if (!Number.isSafeInteger(event.seq) || event.seq <= 0) {
      finding(findings, "error", "invalid_seq", event, "event sequence must be a positive safe integer");
    }
    if (seenSeq.has(event.seq)) finding(findings, "error", "duplicate_seq", event, "event sequence is duplicated");
    seenSeq.add(event.seq);
    if (!KNOWN_EVENT_TYPES.has(event.type)) {
      finding(findings, "error", "unknown_event_type", event, `unknown event type ${String(event.type)}`);
    }
    if (!event.task_id || !event.execution_id) {
      finding(findings, "error", "missing_identity", event, "event must carry task_id and execution_id");
    }
    if (!Number.isFinite(Date.parse(event.at))) {
      finding(findings, "error", "invalid_timestamp", event, "event timestamp is invalid");
    }
    const list = tasks.get(event.task_id) ?? [];
    list.push(event);
    tasks.set(event.task_id, list);
  }

  for (const [currentTaskId, taskEvents] of tasks) {
    const firstState = taskEvents.find((event) => event.type !== "reconciliation.recorded");
    if (firstState && firstState.type !== "task.prepared") {
      finding(findings, "error", "task_not_prepared_first", firstState, "first task event must be task.prepared");
    }

    const roomCreated = taskEvents.filter((event) => event.type === "room.created");
    if (roomCreated.length > 1) {
      for (const event of roomCreated.slice(1)) {
        finding(findings, "error", "duplicate_room", event, "a task may have only one stable room");
      }
    }

    const requested = new Set<string>();
    const confirmed = new Set<string>();
    const started = new Set<string>();
    const delivered = new Set<string>();
    const terminalExecutions = new Set<string>();
    const deliveryMessageIds = new Set<string>();
    const decisionKeys = new Set<string>();
    let terminalTaskEvent: CoordinationEvent | undefined;
    let currentExecution = firstState?.execution_id;

    for (const event of taskEvents) {
      if (terminalTaskEvent && event.seq > terminalTaskEvent.seq) {
        const allowedAfterTerminal = event.type === "room.closed" || event.type === "reconciliation.recorded";
        if (!allowedAfterTerminal) {
          finding(
            findings,
            "error",
            "event_after_terminal_task",
            event,
            `event ${event.type} occurs after terminal ${terminalTaskEvent.type}`
          );
        }
      }

      const rotatesExecution = event.type === "review.rework" || event.type === "review.resume";
      const executionNeutral = event.type === "reconciliation.recorded";
      if (
        currentExecution &&
        event.type !== "task.prepared" &&
        !rotatesExecution &&
        !executionNeutral &&
        event.execution_id !== currentExecution
      ) {
        finding(
          findings,
          "error",
          "stale_execution_event",
          event,
          `event ${event.type} belongs to ${event.execution_id}, current execution is ${currentExecution}`
        );
      }

      switch (event.type) {
        case "dispatch.requested":
          requested.add(event.execution_id);
          break;
        case "dispatch.confirmed":
          if (!requested.has(event.execution_id)) {
            finding(findings, "error", "dispatch_without_intent", event, "dispatch.confirmed requires prior dispatch.requested");
          }
          if (confirmed.has(event.execution_id)) {
            finding(findings, "error", "duplicate_dispatch_confirmation", event, "dispatch is confirmed more than once for one execution");
          }
          confirmed.add(event.execution_id);
          break;
        case "worker.started":
          if (!confirmed.has(event.execution_id)) {
            finding(findings, "error", "worker_before_dispatch", event, "worker.started requires confirmed dispatch");
          }
          if (started.has(event.execution_id)) {
            finding(findings, "error", "duplicate_worker_start", event, "worker.started is duplicated for one execution");
          }
          started.add(event.execution_id);
          break;
        case "delivery.observed":
        case "worker.blocked":
        case "worker.failed": {
          if (!confirmed.has(event.execution_id)) {
            finding(findings, "error", "result_before_dispatch", event, `${event.type} requires confirmed dispatch`);
          }
          if (terminalExecutions.has(event.execution_id)) {
            finding(findings, "error", "duplicate_execution_result", event, "execution has more than one terminal worker result");
          }
          terminalExecutions.add(event.execution_id);
          if (event.type === "delivery.observed") delivered.add(event.execution_id);
          const messageId = stringData(event, "message_id");
          if (messageId) {
            if (deliveryMessageIds.has(messageId)) {
              finding(findings, "error", "duplicate_delivery_id", event, "delivery/message id is reused within a task");
            }
            deliveryMessageIds.add(messageId);
          }
          break;
        }
        case "review.rework":
        case "review.resume": {
          const previousExecution = stringData(event, "previous_execution_id");
          if (!previousExecution) {
            finding(findings, "error", "review_missing_previous_execution", event, `${event.type} requires previous_execution_id`);
          } else {
            if (previousExecution === event.execution_id) {
              finding(findings, "error", "review_reuses_execution", event, `${event.type} must create a new execution`);
            }
            if (currentExecution && previousExecution !== currentExecution) {
              finding(findings, "error", "review_stale_previous_execution", event, `${event.type} previous_execution_id must match current execution`);
            }
            if (!delivered.has(previousExecution)) {
              finding(findings, "error", "review_without_delivery", event, `${event.type} requires delivered previous execution`);
            }
          }
          if (previousExecution && previousExecution !== event.execution_id && previousExecution === currentExecution) {
            currentExecution = event.execution_id;
          }
          break;
        }
        case "review.accepted":
          if (!delivered.has(event.execution_id)) {
            finding(findings, "error", "accept_without_delivery", event, "review.accepted requires delivered current execution");
          }
          terminalTaskEvent = event;
          break;
        case "task.cancelled":
          terminalTaskEvent = event;
          break;
        case "room.closed":
          if (!taskEvents.some((candidate) => candidate.seq < event.seq && TERMINAL_TASK_TYPES.has(candidate.type))) {
            finding(findings, "error", "room_closed_before_terminal", event, "room.closed requires accepted or cancelled task");
          }
          break;
        case "reconciliation.recorded": {
          const key = stringData(event, "decision_key");
          if (!key) {
            finding(findings, "warning", "reconciliation_missing_decision_key", event, "reconciliation audit event has no decision_key");
          } else {
            const scoped = `${event.execution_id}\u0000${key}`;
            if (decisionKeys.has(scoped)) {
              finding(findings, "error", "duplicate_reconciliation_decision", event, "reconciliation decision_key is duplicated");
            }
            decisionKeys.add(scoped);
          }
          break;
        }
        default:
          break;
      }
    }

    if (taskEvents.some((event) => DELIVERY_TYPES.has(event.type)) && roomCreated.length === 0) {
      finding(findings, "warning", "delivery_without_room", undefined, "task has worker result but no room.created event", currentTaskId);
    }
  }

  return {
    ok: !findings.some((item) => item.severity === "error"),
    event_count: events.length,
    task_count: tasks.size,
    findings
  };
}

export function assertRecoverySemantics(events: readonly CoordinationEvent[], taskId?: string): RecoveryAuditReport {
  const report = auditRecoverySemantics(events, taskId);
  const errors = report.findings.filter((item) => item.severity === "error");
  if (errors.length > 0) {
    throw new Error(`recovery semantic audit failed: ${errors.map((item) => item.code).join(", ")}`);
  }
  return report;
}
