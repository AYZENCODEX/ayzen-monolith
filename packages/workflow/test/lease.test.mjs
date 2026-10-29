import assert from "node:assert/strict";
import test from "node:test";
import { createInMemoryWorkflowStore, createPostgresWorkflowStore, createWorkflowExecutor } from "../src/index.mjs";

const definition = {
  id: "lease-test",
  version: 1,
  owner: "platform",
  steps: [
    { id: "slow", type: "worker", action: "slow" },
    { id: "after", type: "worker", action: "after" },
  ],
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function countingWorker(counts, delayMs = 0) {
  return async ({ step }) => {
    counts[step.id] = (counts[step.id] ?? 0) + 1;
    if (delayMs) await sleep(delayMs);
    return { done: step.id };
  };
}

test("two replicas sharing a store never execute the same run twice", async () => {
  const store = createInMemoryWorkflowStore();
  const counts = {};
  const a = createWorkflowExecutor({ store, leaseOwner: "replica-a", worker: countingWorker(counts, 150) });
  const b = createWorkflowExecutor({ store, leaseOwner: "replica-b", worker: countingWorker(counts, 150) });
  const [ra, rb] = await Promise.all([
    a.run(definition, { runId: "run-1" }),
    (async () => { await sleep(20); return b.run(definition, { runId: "run-1" }); })(),
  ]);
  assert.equal(ra.run.status, "COMPLETED");
  assert.equal(rb.skipped, true);
  assert.equal(rb.reason, "LEASE_HELD");
  assert.deepEqual(counts, { slow: 1, after: 1 });
});

test("a redelivered event for a completed run is a no-op", async () => {
  const store = createInMemoryWorkflowStore();
  const counts = {};
  const executor = createWorkflowExecutor({ store, worker: countingWorker(counts) });
  await executor.run(definition, { runId: "run-2" });
  const again = await executor.run(definition, { runId: "run-2" });
  assert.equal(again.skipped, true);
  assert.equal(again.reason, "ALREADY_TERMINAL");
  assert.deepEqual(counts, { slow: 1, after: 1 });
});

test("an expired lease can be taken over and the run resumes from its checkpoint", async () => {
  const store = createInMemoryWorkflowStore();
  const counts = {};
  // Replica A "crashes" after the first step: it checkpointed, then died holding a short lease.
  const crashing = createWorkflowExecutor({
    store,
    leaseOwner: "replica-a",
    leaseTtlMs: 60,
    worker: async ({ step }) => {
      counts[step.id] = (counts[step.id] ?? 0) + 1;
      if (step.id === "after") throw Object.assign(new Error("boom"), { code: "WORKFLOW_LEASE_LOST" });
      return { done: step.id };
    },
  });
  await assert.rejects(crashing.run(definition, { runId: "run-3" }));
  await store.acquireLease("run-3", "replica-a", 60);
  await sleep(90);
  const b = createWorkflowExecutor({ store, leaseOwner: "replica-b", worker: countingWorker(counts) });
  const result = await b.run(definition, { runId: "run-3" });
  assert.equal(result.run.status, "COMPLETED");
  assert.equal(counts.slow, 1, "completed step must not re-run after takeover");
  assert.equal(counts.after, 2, "unfinished step runs on the new owner");
});

test("postgres store maps snake_case rows so the executor accepts its own runs", async () => {
  const rows = new Map();
  const query = async (rawText, params) => {
    const text = rawText.replace(/\s+/g, " ").trim();
    if (text.startsWith("INSERT INTO workflow_run")) {
      const row = { id: params[0], definition_id: params[1], definition_version: params[2], status: "PENDING", context: {}, execution_version: 0 };
      if (rows.has(params[0])) return { rows: [] };
      rows.set(params[0], row);
      return { rows: [row] };
    }
    if (text.startsWith("SELECT * FROM workflow_run")) return { rows: rows.has(params[0]) ? [rows.get(params[0])] : [] };
    if (text.startsWith("UPDATE workflow_run SET execution_owner = $2")) {
      const row = rows.get(params[0]);
      if (row.execution_owner && row.execution_owner !== params[1]) return { rows: [] };
      row.execution_owner = params[1];
      return { rows: [{ id: row.id }] };
    }
    if (text.startsWith("UPDATE workflow_run SET execution_lease_until")) return { rows: [{ id: params[0] }] };
    if (text.startsWith("UPDATE workflow_run SET execution_owner = NULL")) { delete rows.get(params[0]).execution_owner; return { rows: [] }; }
    if (text.startsWith("UPDATE workflow_run SET")) {
      const row = rows.get(params[0]);
      const assignments = text.match(/SET (.+?), updated_at/)[1].split(", ").map((part) => part.split(" = ")[0]);
      assignments.forEach((column, index) => { row[column] = params[index + 1]; });
      return { rows: [row] };
    }
    if (text.startsWith("SELECT * FROM workflow_checkpoint")) return { rows: [] };
    if (text.startsWith("INSERT INTO workflow_checkpoint") || text.startsWith("INSERT INTO workflow_step_run")) return { rows: [{}] };
    throw new Error(`unexpected query: ${text.slice(0, 60)}`);
  };
  const counts = {};
  const executor = createWorkflowExecutor({ store: createPostgresWorkflowStore({ query }), worker: countingWorker(counts) });
  const result = await executor.run(definition, { runId: "run-pg" });
  assert.equal(result.run.status, "COMPLETED");
  assert.deepEqual(counts, { slow: 1, after: 1 });
});
