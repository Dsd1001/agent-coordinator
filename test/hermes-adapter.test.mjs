import assert from "node:assert/strict";
import test from "node:test";

import { HermesAdapterError, HermesManagerAdapter } from "../dist/packages/adapter-hermes/index.js";
import { MemoryEventLedger, projectTask } from "../dist/packages/core/index.js";
import { TaskCoordinator } from "../dist/packages/coordinator/index.js";

function task(executionId = "exec-1") {
  return {
    task_id: "task-1",
    execution_id: executionId,
    title: "Analyze the result",
    brief: "Produce a verified result.",
    acceptance: ["Result is correct", "Evidence is explicit"],
    inputs: [{ path: "input.txt", sha256: "a".repeat(64), description: "input" }]
  };
}

function delivery(executionId = "exec-1", overrides = {}) {
  return {
    task_id: "task-1",
    execution_id: executionId,
    status: "delivered",
    summary: "worker completed the task",
    artifacts: [],
    checks: [{ name: "worker-check", result: "passed" }],
    limitations: [],
    ...overrides
  };
}

function verification() {
  return {
    verification_id: "verify-1",
    verified_at: "2026-01-01T00:00:10.000Z",
    identity_verified: true,
    artifacts_verified: true
  };
}

function client(overrides = {}) {
  return {
    async prepareTask(request) {
      return {
        task_id: request.task_id,
        execution_id: request.execution_id,
        manager_reference: `manager-${request.task_id}`,
        prepared_at: "2026-01-01T00:00:00.000Z"
      };
    },
    async reviewDelivery(request) {
      return {
        task_id: request.task_id,
        execution_id: request.execution_id,
        verdict: "accept",
        summary: "Meets the acceptance criteria.",
        review_id: "review-1",
        reviewed_at: "2026-01-01T00:00:20.000Z"
      };
    },
    ...overrides
  };
}

test("Hermes adapter prepares a task through an injected client with stable identity", async () => {
  const calls = [];
  const adapter = new HermesManagerAdapter(client({
    async prepareTask(request) {
      calls.push(structuredClone(request));
      return {
        task_id: request.task_id,
        execution_id: request.execution_id,
        manager_reference: "manager-ref-1",
        prepared_at: "2026-01-01T00:00:00.000Z"
      };
    }
  }));
  const receipt = await adapter.prepareTask(task());
  assert.deepEqual(receipt, {
    task_id: "task-1",
    execution_id: "exec-1",
    manager_reference: "manager-ref-1",
    prepared_at: "2026-01-01T00:00:00.000Z"
  });
  assert.deepEqual(calls[0], {
    task_id: "task-1",
    execution_id: "exec-1",
    title: "Analyze the result",
    brief: "Produce a verified result.",
    acceptance: ["Result is correct", "Evidence is explicit"],
    inputs: [{ path: "input.txt", sha256: "a".repeat(64), description: "input" }]
  });
  assert.equal("room_id" in calls[0], false);
  assert.equal("topic_id" in calls[0], false);
});

test("Hermes adapter returns explicit review evidence for accept", async () => {
  const adapter = new HermesManagerAdapter(client());
  const result = await adapter.reviewDelivery({ task: task(), delivery: delivery(), verification: verification() });
  assert.deepEqual(result, {
    task_id: "task-1",
    execution_id: "exec-1",
    verdict: "accept",
    summary: "Meets the acceptance criteria.",
    evidence: {
      review_id: "review-1",
      reviewed_at: "2026-01-01T00:00:20.000Z",
      source: "hermes"
    }
  });
});

test("Hermes rework/resume decisions require requirements and a new execution", async () => {
  for (const verdict of ["rework", "resume"]) {
    const adapter = new HermesManagerAdapter(client({
      async reviewDelivery(request) {
        return {
          task_id: request.task_id,
          execution_id: request.execution_id,
          verdict,
          summary: `${verdict} requested`,
          requirements: [" clarify evidence ", "clarify evidence", "add validation"],
          next_execution_id: `exec-${verdict}`,
          review_id: `review-${verdict}`,
          reviewed_at: "2026-01-01T00:00:20.000Z"
        };
      }
    }));
    const result = await adapter.reviewDelivery({ task: task(), delivery: delivery(), verification: verification() });
    assert.equal(result.verdict, verdict);
    assert.equal(result.task_id, "task-1");
    assert.equal(result.execution_id, "exec-1");
    assert.equal(result.next_execution_id, `exec-${verdict}`);
    assert.deepEqual(result.requirements, ["clarify evidence", "add validation"]);
  }

  const sameExecution = new HermesManagerAdapter(client({
    async reviewDelivery(request) {
      return {
        task_id: request.task_id,
        execution_id: request.execution_id,
        verdict: "rework",
        summary: "retry",
        requirements: ["fix it"],
        next_execution_id: request.execution_id,
        review_id: "review-bad",
        reviewed_at: "2026-01-01T00:00:20.000Z"
      };
    }
  }));
  await assert.rejects(
    () => sameExecution.reviewDelivery({ task: task(), delivery: delivery(), verification: verification() }),
    (error) => error instanceof HermesAdapterError && error.code === "invalid_response"
  );
});

test("Hermes cancel decision has no rework fields", async () => {
  const adapter = new HermesManagerAdapter(client({
    async reviewDelivery(request) {
      return {
        task_id: request.task_id,
        execution_id: request.execution_id,
        verdict: "cancel",
        summary: "Cancel this task.",
        review_id: "review-cancel",
        reviewed_at: "2026-01-01T00:00:20.000Z"
      };
    }
  }));
  const result = await adapter.reviewDelivery({ task: task(), delivery: delivery(), verification: verification() });
  assert.equal(result.verdict, "cancel");
  assert.equal(result.requirements, undefined);
  assert.equal(result.next_execution_id, undefined);
});

test("Hermes adapter rejects unverified or non-delivered work before calling the client", async () => {
  let reviewCalls = 0;
  const adapter = new HermesManagerAdapter(client({
    async reviewDelivery() {
      reviewCalls += 1;
      throw new Error("must not run");
    }
  }));
  await assert.rejects(
    () => adapter.reviewDelivery({
      task: task(),
      delivery: delivery("exec-1", { status: "blocked" }),
      verification: verification()
    }),
    (error) => error instanceof HermesAdapterError && error.code === "invalid_request"
  );
  await assert.rejects(
    () => adapter.reviewDelivery({
      task: task(),
      delivery: delivery("exec-1", { checks: [{ name: "worker-check", result: "failed" }] }),
      verification: verification()
    }),
    (error) => error instanceof HermesAdapterError && error.code === "invalid_request"
  );
  await assert.rejects(
    () => adapter.reviewDelivery({
      task: task(),
      delivery: delivery(),
      verification: { ...verification(), identity_verified: false }
    }),
    (error) => error instanceof HermesAdapterError && error.code === "invalid_request"
  );
  assert.equal(reviewCalls, 0);
});

test("Hermes adapter rejects task/execution identity mismatches", async () => {
  const prepareMismatch = new HermesManagerAdapter(client({
    async prepareTask(request) {
      return {
        task_id: "other-task",
        execution_id: request.execution_id,
        manager_reference: "manager-ref",
        prepared_at: "2026-01-01T00:00:00.000Z"
      };
    }
  }));
  await assert.rejects(
    () => prepareMismatch.prepareTask(task()),
    (error) => error instanceof HermesAdapterError && error.code === "identity_mismatch"
  );

  const reviewMismatch = new HermesManagerAdapter(client({
    async reviewDelivery(request) {
      return {
        task_id: request.task_id,
        execution_id: "other-exec",
        verdict: "accept",
        summary: "ok",
        review_id: "review-mismatch",
        reviewed_at: "2026-01-01T00:00:20.000Z"
      };
    }
  }));
  await assert.rejects(
    () => reviewMismatch.reviewDelivery({ task: task(), delivery: delivery(), verification: verification() }),
    (error) => error instanceof HermesAdapterError && error.code === "identity_mismatch"
  );
});

test("Hermes adapter turns malformed runtime responses into structured errors", async () => {
  const adapter = new HermesManagerAdapter(client({
    async prepareTask() {
      return undefined;
    },
    async reviewDelivery() {
      return { unexpected: true };
    }
  }));
  await assert.rejects(
    () => adapter.prepareTask(task()),
    (error) => error instanceof HermesAdapterError && error.code === "invalid_response"
  );
  await assert.rejects(
    () => adapter.reviewDelivery({ task: task(), delivery: delivery(), verification: verification() }),
    (error) => error instanceof HermesAdapterError && error.code === "invalid_response"
  );
});

test("Hermes client exception details are not leaked through adapter errors", async () => {
  const privateValue = "upstream-private-value-abc123";
  const adapter = new HermesManagerAdapter(client({
    async prepareTask() {
      throw new Error(`connection failed with ${privateValue}`);
    }
  }));
  await assert.rejects(
    () => adapter.prepareTask(task()),
    (error) =>
      error instanceof HermesAdapterError &&
      error.code === "client_failure" &&
      error.retryable === true &&
      !error.message.includes(privateValue) &&
      !("cause" in error)
  );
});

class FakeTransport {
  sent = [];
  closed = [];
  async createRoom() {
    return { channel_id: "channel-1", room_id: "room-1" };
  }
  async send(room, text) {
    this.sent.push({ room, text });
    return { message_id: `message-${this.sent.length}` };
  }
  async closeRoom(room) {
    this.closed.push(room);
  }
}

class JsonCodec {
  roomTitle(current) {
    return `${current.task_id}: ${current.title}`;
  }
  renderTask(current) {
    return JSON.stringify({
      task_id: current.task_id,
      execution_id: current.execution_id,
      brief: current.brief
    });
  }
  parseWorkerReply(text) {
    return JSON.parse(text);
  }
}

function workerReply(executionId, summary) {
  return JSON.stringify({
    kind: "deliver",
    task_id: "task-1",
    execution_id: executionId,
    summary
  });
}

test("Hermes adapter participates in task -> delivery -> rework -> delivery -> accept lifecycle", async () => {
  const reviewResponses = [
    {
      verdict: "rework",
      summary: "Needs another pass.",
      requirements: ["Add independent validation"],
      next_execution_id: "exec-2",
      review_id: "review-1"
    },
    {
      verdict: "accept",
      summary: "Verified and accepted.",
      review_id: "review-2"
    }
  ];
  const hermesCalls = [];
  const manager = new HermesManagerAdapter(client({
    async prepareTask(request) {
      hermesCalls.push(["prepare", structuredClone(request)]);
      return {
        task_id: request.task_id,
        execution_id: request.execution_id,
        manager_reference: "manager-task-1",
        prepared_at: "2026-01-01T00:00:00.000Z"
      };
    },
    async reviewDelivery(request) {
      hermesCalls.push(["review", structuredClone(request)]);
      const next = reviewResponses.shift();
      return {
        task_id: request.task_id,
        execution_id: request.execution_id,
        ...next,
        reviewed_at: next.review_id === "review-1"
          ? "2026-01-01T00:01:00.000Z"
          : "2026-01-01T00:02:00.000Z"
      };
    }
  }));
  const ledger = new MemoryEventLedger();
  const transport = new FakeTransport();
  const coordinator = new TaskCoordinator(ledger, transport, new JsonCodec(), { worker_sender_id: "worker-uid" });

  const initialTask = task();
  await manager.prepareTask(initialTask);
  const first = await coordinator.dispatch(initialTask);
  const firstObserved = coordinator.observeWorkerReply(first, {
    message_id: "delivery-1",
    channel_id: "channel-1",
    room_id: "room-1",
    sender_id: "worker-uid",
    text: workerReply("exec-1", "first result")
  });
  const firstReview = await manager.reviewDelivery({
    task: first.task,
    delivery: firstObserved.delivery,
    verification: verification()
  });
  const second = await coordinator.applyManagerReview(first, firstReview);
  assert.equal(second.task.task_id, "task-1");
  assert.equal(second.task.execution_id, "exec-2");
  assert.equal(second.room.room_id, "room-1");
  assert.match(JSON.parse(transport.sent.at(-1).text).brief, /Add independent validation/);

  const secondObserved = coordinator.observeWorkerReply(second, {
    message_id: "delivery-2",
    channel_id: "channel-1",
    room_id: "room-1",
    sender_id: "worker-uid",
    text: workerReply("exec-2", "second result")
  });
  const secondReview = await manager.reviewDelivery({
    task: second.task,
    delivery: secondObserved.delivery,
    verification: { ...verification(), verification_id: "verify-2", verified_at: "2026-01-01T00:01:50.000Z" }
  });
  assert.equal(await coordinator.applyManagerReview(second, secondReview), undefined);
  assert.equal(projectTask(ledger.list(), "task-1")?.status, "accepted");
  assert.deepEqual(transport.closed, [{ channel_id: "channel-1", room_id: "room-1" }]);

  const reworkEvent = ledger.list("task-1").find((event) => event.type === "review.rework");
  const acceptEvent = ledger.list("task-1").find((event) => event.type === "review.accepted");
  assert.deepEqual(reworkEvent.data.review_evidence, {
    review_id: "review-1",
    reviewed_at: "2026-01-01T00:01:00.000Z",
    source: "hermes"
  });
  assert.deepEqual(acceptEvent.data.review_evidence, {
    review_id: "review-2",
    reviewed_at: "2026-01-01T00:02:00.000Z",
    source: "hermes"
  });
  assert.equal(hermesCalls.filter(([kind]) => kind === "review").length, 2);
});

test("Coordinator applies cancel and closes the room with review evidence", async () => {
  const ledger = new MemoryEventLedger();
  const transport = new FakeTransport();
  const coordinator = new TaskCoordinator(ledger, transport, new JsonCodec(), { worker_sender_id: "worker-uid" });
  const receipt = await coordinator.dispatch(task());
  coordinator.observeWorkerReply(receipt, {
    message_id: "delivery-cancel",
    channel_id: "channel-1",
    room_id: "room-1",
    sender_id: "worker-uid",
    text: workerReply("exec-1", "result")
  });
  await coordinator.applyManagerReview(receipt, {
    task_id: "task-1",
    execution_id: "exec-1",
    verdict: "cancel",
    summary: "No longer needed.",
    evidence: {
      review_id: "review-cancel",
      reviewed_at: "2026-01-01T00:03:00.000Z",
      source: "test-manager"
    }
  });
  assert.equal(projectTask(ledger.list(), "task-1")?.status, "cancelled");
  assert.equal(transport.closed.length, 1);
  const event = ledger.list("task-1").find((item) => item.type === "task.cancelled");
  assert.equal(event.data.review_evidence.review_id, "review-cancel");
});
