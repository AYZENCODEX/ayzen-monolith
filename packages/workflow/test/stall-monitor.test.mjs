import assert from "node:assert/strict";
import test from "node:test";
import { createStalledWorkflowMonitor } from "../src/stall-monitor.mjs";
import { createInMemoryWorkflowStore } from "../src/store.mjs";

function fakeStore(runs) {
  return {
    async listActiveInstances() {
      return runs;
    },
  };
}

test("H11.2: a run updated recently is not stalled", async () => {
  const store = fakeStore([{ id: "run-1", definitionId: "wf-a", status: "RUNNING", currentStepId: "step-1", updatedAt: new Date().toISOString() }]);
  const published = [];
  const monitor = createStalledWorkflowMonitor({ store, publish: (e) => published.push(e), thresholdMs: 60_000 });
  const stalled = await monitor.checkOnce();
  assert.equal(stalled.length, 0);
  assert.equal(published.length, 0);
});

test("H11.2: a run with no progress past the threshold publishes workflow.stalled with the run's identity", async () => {
  const staleUpdatedAt = new Date(Date.now() - 10 * 60_000).toISOString();
  const store = fakeStore([{ id: "run-1", definitionId: "wf-a", status: "RUNNING", currentStepId: "step-3", updatedAt: staleUpdatedAt }]);
  const published = [];
  const monitor = createStalledWorkflowMonitor({ store, publish: (e) => published.push(e), thresholdMs: 5 * 60_000 });
  const stalled = await monitor.checkOnce();
  assert.equal(stalled.length, 1);
  assert.equal(published.length, 1);
  assert.equal(published[0].eventType, "workflow.stalled");
  assert.equal(published[0].payload.executionId, "run-1");
  assert.equal(published[0].payload.workflowId, "wf-a");
  assert.equal(published[0].payload.currentStepId, "step-3");
  assert.ok(published[0].payload.staleForMs >= 10 * 60_000 - 1_000);
});

test("H11.2: a still-stalled run does not re-alert on every subsequent poll", async () => {
  const staleUpdatedAt = new Date(Date.now() - 10 * 60_000).toISOString();
  const store = fakeStore([{ id: "run-1", definitionId: "wf-a", status: "RUNNING", updatedAt: staleUpdatedAt }]);
  const published = [];
  const monitor = createStalledWorkflowMonitor({ store, publish: (e) => published.push(e), thresholdMs: 5 * 60_000 });
  await monitor.checkOnce();
  await monitor.checkOnce();
  await monitor.checkOnce();
  assert.equal(published.length, 1);
});

test("H11.2: a run that makes progress again clears the alert, and a later re-stall alerts again", async () => {
  const runs = [{ id: "run-1", definitionId: "wf-a", status: "RUNNING", updatedAt: new Date(Date.now() - 10 * 60_000).toISOString() }];
  const store = { async listActiveInstances() { return runs; } };
  const published = [];
  const monitor = createStalledWorkflowMonitor({ store, publish: (e) => published.push(e), thresholdMs: 5 * 60_000 });
  await monitor.checkOnce();
  assert.equal(monitor.isAlerted("run-1"), true);

  runs[0] = { ...runs[0], updatedAt: new Date().toISOString() };
  await monitor.checkOnce();
  assert.equal(monitor.isAlerted("run-1"), false);
  assert.equal(published.length, 1, "recovering does not itself publish anything");

  runs[0] = { ...runs[0], updatedAt: new Date(Date.now() - 10 * 60_000).toISOString() };
  await monitor.checkOnce();
  assert.equal(published.length, 2, "stalling again after recovering alerts a second time");
});

test("H11.2: a run that finishes between polls (and drops out of listActiveInstances) clears its alert state", async () => {
  const runs = [{ id: "run-1", definitionId: "wf-a", status: "RUNNING", updatedAt: new Date(Date.now() - 10 * 60_000).toISOString() }];
  const store = { async listActiveInstances() { return runs; } };
  const published = [];
  const monitor = createStalledWorkflowMonitor({ store, publish: (e) => published.push(e), thresholdMs: 5 * 60_000 });
  await monitor.checkOnce();
  assert.equal(monitor.isAlerted("run-1"), true);
  runs.length = 0;
  await monitor.checkOnce();
  assert.equal(monitor.isAlerted("run-1"), false);
});

test("H11.2: several stalled runs each alert independently", async () => {
  const staleUpdatedAt = new Date(Date.now() - 10 * 60_000).toISOString();
  const store = fakeStore([
    { id: "run-1", definitionId: "wf-a", status: "RUNNING", updatedAt: staleUpdatedAt },
    { id: "run-2", definitionId: "wf-b", status: "RUNNING", updatedAt: staleUpdatedAt },
    { id: "run-3", definitionId: "wf-a", status: "RUNNING", updatedAt: new Date().toISOString() },
  ]);
  const published = [];
  const monitor = createStalledWorkflowMonitor({ store, publish: (e) => published.push(e), thresholdMs: 5 * 60_000 });
  const stalled = await monitor.checkOnce();
  assert.equal(stalled.length, 2);
  assert.deepEqual(published.map((e) => e.payload.executionId).sort(), ["run-1", "run-2"]);
});

test("H11.2: a publish failure does not suppress the next poll's re-alert attempt", async () => {
  const staleUpdatedAt = new Date(Date.now() - 10 * 60_000).toISOString();
  const store = fakeStore([{ id: "run-1", definitionId: "wf-a", status: "RUNNING", updatedAt: staleUpdatedAt }]);
  let attempts = 0;
  const monitor = createStalledWorkflowMonitor({
    store,
    thresholdMs: 5 * 60_000,
    publish: () => {
      attempts += 1;
      if (attempts === 1) throw new Error("transport down");
    },
    log: () => {},
  });
  await monitor.checkOnce();
  assert.equal(monitor.isAlerted("run-1"), false);
  await monitor.checkOnce();
  assert.equal(attempts, 2);
  assert.equal(monitor.isAlerted("run-1"), true);
});

test("H11.2: integrates with the real in-memory store's listActiveInstances output", async () => {
  const store = createInMemoryWorkflowStore();
  await store.createWorkflowInstance({ id: "run-1", definitionId: "wf-a" });
  // Backdate updatedAt directly via updateWorkflowInstance's own patch, since
  // the store always stamps "now" — simulate staleness with a low threshold
  // and a real elapsed wait instead.
  const published = [];
  const monitor = createStalledWorkflowMonitor({ store, publish: (e) => published.push(e), thresholdMs: 10 });
  await new Promise((resolve) => setTimeout(resolve, 25));
  const stalled = await monitor.checkOnce();
  assert.equal(stalled.length, 1);
  assert.equal(published[0].payload.executionId, "run-1");
});

test("H11.2: constructor validates its required inputs", () => {
  assert.throws(() => createStalledWorkflowMonitor({ publish: () => {} }), /listActiveInstances/);
  assert.throws(() => createStalledWorkflowMonitor({ store: fakeStore([]) }), /publish/);
});
