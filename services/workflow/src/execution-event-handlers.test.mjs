import test from "node:test";
import assert from "node:assert/strict";
import { createWorkflowExecutionEventHandlers } from "./execution-event-handlers.mjs";

function makeExecutions(seed = {}) {
  return new Map(Object.entries(seed));
}

test("workflow.completed moves a queued execution to completed and records output", async () => {
  const executions = makeExecutions({ "exec-1": { id: "exec-1", status: "queued" } });
  const handlers = createWorkflowExecutionEventHandlers({ executions, audit: { record: () => {} } });

  const result = await handlers["workflow.completed"]({ payload: { executionId: "exec-1", values: { step1: "ok" } } });

  assert.equal(result.skipped, false);
  assert.equal(executions.get("exec-1").status, "completed");
  assert.deepEqual(executions.get("exec-1").output, { step1: "ok" });
});

test("workflow.failed moves a queued execution to failed and records the error", async () => {
  const executions = makeExecutions({ "exec-2": { id: "exec-2", status: "queued" } });
  const handlers = createWorkflowExecutionEventHandlers({ executions, audit: { record: () => {} } });

  await handlers["workflow.failed"]({ payload: { executionId: "exec-2", error: "boom" } });

  assert.equal(executions.get("exec-2").status, "failed");
  assert.equal(executions.get("exec-2").error, "boom");
});

test("a terminal execution is never overwritten by a later/redelivered event", async () => {
  const executions = makeExecutions({ "exec-3": { id: "exec-3", status: "cancelled" } });
  const handlers = createWorkflowExecutionEventHandlers({ executions, audit: { record: () => {} } });

  const result = await handlers["workflow.completed"]({ payload: { executionId: "exec-3" } });

  assert.equal(result.skipped, true);
  assert.equal(executions.get("exec-3").status, "cancelled");
});

test("an event for an unknown execution is skipped, not an error", async () => {
  const executions = makeExecutions();
  const handlers = createWorkflowExecutionEventHandlers({ executions, audit: { record: () => {} } });

  const result = await handlers["workflow.completed"]({ payload: { executionId: "does-not-exist" } });

  assert.equal(result.skipped, true);
  assert.equal(result.reason, "EXECUTION_NOT_FOUND");
});
