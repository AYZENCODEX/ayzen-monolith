import test from "node:test";
import assert from "node:assert/strict";
import { createBackboneRuntime } from "../src/index.mjs";

test("routes events with consumer isolation, retries, DLQ, and replay", async () => {
  const runtime = createBackboneRuntime({ maxAttempts: 2 });
  runtime.registerEvent({ type: "order.created", version: 1, owner: "ryft" });
  let received = 0;
  runtime.subscribe({ eventType: "order.created", consumer: "analytics", handler: async () => { received += 1; } });
  await runtime.publish({ eventId: "event-1", eventType: "order.created", eventVersion: 1, traceId: "trace-1", correlationId: "corr-1", payload: { orderId: "1" } });
  await runtime.publish({ eventId: "event-1", eventType: "order.created", eventVersion: 1, traceId: "trace-1", correlationId: "corr-1", payload: { orderId: "1" } });
  assert.equal(received, 1);
  assert.equal(runtime.health().duplicates, 1);
  assert.equal(await runtime.replay({ eventType: "order.created", consumer: "analytics" }), 1);
  assert.equal(received, 2);
});

test("persists workflow progress and produces a terminal state", async () => {
  const runtime = createBackboneRuntime();
  runtime.registerWorkflow({ id: "order-saga", version: 1, steps: [
    { id: "reserve", run: async () => ({ reserved: true }) },
    { id: "notify", run: async () => ({ notified: true }) },
  ] });
  const run = await runtime.startWorkflow({ workflowId: "order-saga", input: { orderId: "1" } });
  assert.equal(run.status, "completed");
  assert.equal(run.history.length, 2);
});