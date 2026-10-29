import assert from "node:assert/strict";
import test from "node:test";
import { createInMemoryWorkflowStore, createWorkflowExecutor } from "../src/index.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A minimal stand-in for apps/worker/src/wait-for-event.mjs's
 * createEventWaiter(), just enough to prove
 * packages/workflow/src/executor.mjs's own side of Phase H8.2: that an
 * "event" step with `awaitEventType` genuinely calls the configured
 * `waitForEvent` and blocks on its promise, instead of resolving
 * immediately with the envelope it just published (the pre-fix behavior —
 * see the last test below).
 */
function fakeWaiter() {
  const pending = new Map();
  return {
    resolve(correlationId, event) {
      pending.get(correlationId)?.(event);
      pending.delete(correlationId);
    },
    waitForEvent(eventType, { correlationId, timeoutMs } = {}) {
      return new Promise((resolve, reject) => {
        pending.set(correlationId, resolve);
        if (timeoutMs) {
          setTimeout(() => {
            if (!pending.has(correlationId)) return;
            pending.delete(correlationId);
            const error = new Error(`timed out waiting for ${eventType}`);
            error.code = "WORKFLOW_WAIT_FOR_EVENT_TIMEOUT";
            reject(error);
          }, timeoutMs);
        }
      });
    },
  };
}

function definitionWithAwait({ timeoutMs } = {}) {
  return {
    id: "await-event-test",
    version: 1,
    owner: "platform",
    steps: [
      { id: "before", type: "worker", action: "before" },
      { id: "ping", type: "event", eventType: "workflow.completed", awaitEventType: "workflow.completed", ...(timeoutMs ? { timeoutMs } : {}) },
      { id: "after", type: "worker", action: "after" },
    ],
  };
}

test("an event step with awaitEventType blocks until the correlated event arrives", async () => {
  const store = createInMemoryWorkflowStore();
  const waiter = fakeWaiter();
  const published = [];
  const order = [];
  const executor = createWorkflowExecutor({
    store,
    publish: async (envelope) => { published.push(envelope); },
    waitForEvent: waiter.waitForEvent,
    worker: async ({ step }) => { order.push(step.id); return { done: step.id }; },
  });

  const runPromise = executor.run(definitionWithAwait(), { runId: "run-await", correlationId: "corr-await" });

  // Give the run time to reach and start blocking on the awaited event.
  await sleep(30);
  assert.deepEqual(order, ["before"]);
  assert.equal((await store.loadWorkflowInstance("run-await")).status, "RUNNING");
  assert.equal(published.length, 1);
  assert.equal(published[0].eventType, "workflow.completed");

  waiter.resolve("corr-await", { eventType: "workflow.completed", correlationId: "corr-await", payload: { unblocked: true } });
  const result = await runPromise;

  assert.deepEqual(order, ["before", "after"]);
  assert.equal(result.run.status, "COMPLETED");
  assert.equal(result.values.ping.payload.unblocked, true);
});

test("awaitEventType respects the step's own timeoutMs when nothing correlated ever arrives", async () => {
  const store = createInMemoryWorkflowStore();
  const waiter = fakeWaiter();
  const executor = createWorkflowExecutor({
    store,
    publish: async () => {},
    waitForEvent: waiter.waitForEvent,
    worker: async () => ({}),
  });

  await assert.rejects(
    executor.run(definitionWithAwait({ timeoutMs: 200 }), { runId: "run-timeout", correlationId: "corr-timeout" }),
    (error) => error.code === "WORKFLOW_STEP_TIMEOUT" || error.code === "WORKFLOW_WAIT_FOR_EVENT_TIMEOUT",
  );
  const run = await store.loadWorkflowInstance("run-timeout");
  assert.equal(run.status, "FAILED");
});

test("with no waitForEvent configured (pre-H8.2 behavior), awaitEventType is silently skipped", async () => {
  const store = createInMemoryWorkflowStore();
  const order = [];
  const executor = createWorkflowExecutor({
    store,
    publish: async () => {},
    // No waitForEvent passed at all.
    worker: async ({ step }) => { order.push(step.id); return { done: step.id }; },
  });

  const result = await executor.run(definitionWithAwait(), { runId: "run-no-waiter", correlationId: "corr-none" });
  assert.equal(result.run.status, "COMPLETED");
  assert.deepEqual(order, ["before", "after"]);
  // The "ping" step resolved with the published envelope itself, not a
  // correlated response — documenting the exact gap H8.2 closes.
  assert.equal(result.values.ping.eventType, "workflow.completed");
});
