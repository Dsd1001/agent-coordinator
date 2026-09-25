import type { DeliveryEnvelope, TaskEnvelope } from "../protocol/src/index.js";

export type ReviewVerdict = "accept" | "rework" | "resume" | "cancel";

export interface ReviewResult {
  verdict: ReviewVerdict;
  summary: string;
  requirements?: string[];
}

export interface ManagerAdapter {
  prepareTask(task: TaskEnvelope): Promise<void>;
  reviewDelivery(delivery: DeliveryEnvelope): Promise<ReviewResult>;
}
