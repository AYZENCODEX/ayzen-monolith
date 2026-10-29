import assert from "node:assert/strict";
import test from "node:test";
import { createInMemoryWorkflowStore, createWorkflowExecutor } from "../src/index.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function definitionWithApproval() {
  return {
    id: "approval-test",
    version: 1,
    owner: "platform",
    steps: [
      { id: "before", type: "worker", action: "before" },
      { id: "gate", type: "approval" },
      { id: "after", type: "worker", action: "after" },
    ],
  };
}

/**
 * Stands in for apps/worker/src/approval.mjs + services/workflow's
 * /api/workflows/approvals endpoints, without any HTTP or Postgres: a
 * pending decision map the test flips, and a poller matching the real
 * handler's wait-until-decided shape.
 */
function fakeApprovalQueue({ pollIntervalMs = 5 } = {}) {
  const decisions = new Map();
  return {
    decide(runId, decision, reason) {
      decisions.set(runId, { decision, reason });
    },
    async approval({ context }) {
      for (;;) {
        const decision = decisions.get(context.runId);
        if (decision?.decision === "approved") return { approved: true };
        if (decision?.decision === "rejected") {
          const error = new Error(decision.reason ?? "rejected");
          error.code = "WORKFLOW_APPROVAL_REJECTED";
          throw error;
        }
        await sleep(pollIntervalMs);
      }
    },
  };
}

test("an approval step pauses the run and only proceeds once approved", async () => {
  const store = createInMemoryWorkflowStore();
  const queue = fakeApprovalQueue();
  const order = [];
  const executor = createWorkflowExecutor({
    store,
    approval: queue.approval,
    worker: async ({ step }) => { order.push(step.id); return { done: step.id }; },
  });

  const runPromise = executor.run(definitionWithApproval(), { runId: "run-approve" });

  // Give the run time to reach and start blocking on the approval step.
  await sleep(30);
  assert.deepEqual(order, ["before"]);
  assert.equal((await store.loadWorkflowInstance("run-approve")).status, "RUNNING");

  queue.decide("run-approve", "approved");
  const result = await runPromise;

  assert.deepEqual(order, ["before", "after"]);
  assert.equal(result.run.status, "COMPLETED");
});

test("a rejected approval fails the run instead of letting it continue", async () => {
  const store = createInMemoryWorkflowStore();
  const queue = fakeApprovalQueue();
  const order = [];
  const executor = createWorkflowExecutor({
    store,
    approval: queue.approval,
    worker: async ({ step }) => { order.push(step.id); return { done: step.id }; },
  });

  const runPromise = executor.run(definitionWithApproval(), { runId: "run-reject" });
  await sleep(30);
  queue.decide("run-reject", "rejected", "not authorized");

  await assert.rejects(runPromise, (error) => error.code === "WORKFLOW_APPROVAL_REJECTED");
  assert.deepEqual(order, ["before"]);
  const run = await store.loadWorkflowInstance("run-reject");
  assert.equal(run.status, "FAILED");
  assert.match(run.lastError, /not authorized/);
});

test("with no approval handler configured, an approval step still fails clearly (pre-H8.1 behavior)", async () => {
  const store = createInMemoryWorkflowStore();
  const executor = createWorkflowExecutor({ store, worker: async () => ({}) });

  await assert.rejects(
    executor.run(definitionWithApproval(), { runId: "run-no-handler" }),
    /Workflow approval step requires an approval handler/,
  );
});
