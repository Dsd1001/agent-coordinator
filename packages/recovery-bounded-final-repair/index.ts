import type { RecoveryDecision, RecoveryPolicy, RecoveryPolicyContext } from "../extension-api/index.js";

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
}

export function decideBoundedFinalRepair(context: RecoveryPolicyContext): RecoveryDecision {
  assertPositiveInteger(context.attempt, "attempt");
  assertPositiveInteger(context.max_attempts, "max_attempts");
  if (context.attempt > context.max_attempts) throw new Error("attempt cannot exceed max_attempts");

  if (context.review.verdict !== "rework") {
    return { action: "stop", reason: `bounded final repair applies only to rework, got ${context.review.verdict}` };
  }

  if (context.attempt < context.max_attempts) {
    return { action: "retry", reason: "normal retry budget remains" };
  }

  if (context.prior_actions.includes("repair")) {
    return { action: "escalate", reason: "the one-shot final repair lane was already used" };
  }

  const blocking = context.review.findings.filter((finding) => finding.severity === "blocking");
  if (context.review.classification === "bounded" && blocking.length > 0) {
    return {
      action: "repair",
      reason: "bounded blocking findings can be addressed in one scope-locked final repair",
      scope_finding_ids: blocking.map((finding) => finding.id)
    };
  }

  return {
    action: "escalate",
    reason:
      context.review.classification === "bounded"
        ? "bounded final repair requires at least one structured blocking finding"
        : "review did not classify the remaining work as bounded"
  };
}

export class BoundedFinalRepairPolicy implements RecoveryPolicy {
  async evaluate(context: RecoveryPolicyContext): Promise<RecoveryDecision> {
    return decideBoundedFinalRepair(context);
  }
}
