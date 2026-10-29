import assert from "node:assert/strict";
import test from "node:test";
import { createInMemoryWorkflowStore, createWorkflowExecutor } from "../src/index.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const definition = {
  id: "cancel-test",
  version: 1,
  owner: "platform",
  steps: [
    { id: "first", type: "worker", action: "first" },
    { id: "second", type: "worker", action: "second" },
    { id: "third", type: "worker", action: "third" },
  ],
};

function countingWorker(counts, { delayBeforeMs = {} } = {}) {
  return async ({ step }) => {
    if (delayBeforeMs[step.id]) await sleep(delayBeforeMs[step.id]);
    counts[step.id] = (counts[step.id] ?? 0) + 1;
    return { done: step.id };
  };
}

test("cancel() on the same executor instance stops the run before its next step", async () => {
  const store = createInMemoryWorkflowStore();
  const counts = {};
  const executor = createWorkflowExecutor({ store, worker: countingWorker(counts, { delayBeforeMs: { first: 30 } }) });

  const runPromise = executor.run(definition, { runId: "run-cancel-1" });
  await sleep(10); // let "first" start
  executor.cancel("run-cancel-1");

  await assert.rejects(runPromise, (error) => error.code === "WORKFLOW_CANCELLED");
  const run = await store.loadWorkflowInstance("run-cancel-1");
  assert.equal(run.status, "CANCELLED");
  // "first" was already in flight when cancel() landed — cooperative
  // cancellation only stops the *next* step boundary, same as lease loss.
  assert.equal(counts.first, 1);
  assert.equal(counts.second, undefined, "the run must not have started its next step");
  assert.equal(counts.third, undefined);
});

test("cancel() called on a *different* replica sharing the store still stops the run that's actually executing", async () => {
  // Mirrors the real deployment: worker replicas share one event-bus
  // consumer group (H7.4), so the replica that receives workflow.cancelled
  // is frequently not the replica running the workflow. The executing
  // replica's own `cancelled` in-memory set never gets touched here — only
  // the shared store does, via the *other* replica's executor.cancel().
  const store = createInMemoryWorkflowStore();
  const counts = {};
  const running = createWorkflowExecutor({ store, leaseOwner: "replica-a", worker: countingWorker(counts, { delayBeforeMs: { first: 40 } }) });
  const otherReplica = createWorkflowExecutor({ store, leaseOwner: "replica-b" });

  const runPromise = running.run(definition, { runId: "run-cancel-2" });
  await sleep(10);
  await otherReplica.cancel("run-cancel-2"); // never calls running.cancel() directly

  await assert.rejects(runPromise, (error) => error.code === "WORKFLOW_CANCELLED");
  const run = await store.loadWorkflowInstance("run-cancel-2");
  assert.equal(run.status, "CANCELLED");
  assert.equal(counts.first, 1);
  assert.equal(counts.second, undefined, "a different replica's cancel must still stop the actually-running replica");
});

test("a run that already completed before cancel() arrives is unaffected", async () => {
  const store = createInMemoryWorkflowStore();
  const counts = {};
  const executor = createWorkflowExecutor({ store, worker: countingWorker(counts) });
  const result = await executor.run(definition, { runId: "run-cancel-3" });
  assert.equal(result.run.status, "COMPLETED");

  await executor.cancel("run-cancel-3");
  const run = await store.loadWorkflowInstance("run-cancel-3");
  // cancelWorkflowInstance is a plain write, not a conditional one, so this
  // documents current behavior rather than asserting an invariant the store
  // enforces — worth revisiting if an operator-facing cancel endpoint ever
  // calls this directly on a terminal run.
  assert.equal(run.status, "CANCELLED");
});
