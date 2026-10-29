/**
 * Phase H7.5 — before this, the record this service created at POST
 * /api/workflows/:id/executions time (status: "queued") was never touched
 * again. The worker's executor (apps/worker) owns the actual run state in
 * its own store (packages/workflow's workflow_run table) and drives it all
 * the way to COMPLETED/FAILED/CANCELLED, but nothing carried that outcome
 * back to *this* service's own `executions` record — so GET
 * /api/workflows/executions/:id would report "queued" forever, even for a
 * run that finished (or failed) minutes ago.
 *
 * This service owns the `workflow_executions` resource (see
 * packages/domain-boundaries), so the fix is not to reach across into the
 * worker's Postgres tables — it's to subscribe to the two terminal events
 * only the executor can know when to emit (workflow.completed,
 * workflow.failed; see apps/worker/src/index.mjs, which publishes them once
 * executor.run() settles) and update this service's own record when they
 * arrive.
 *
 * workflow.cancelled is deliberately NOT handled here: cancellation is
 * initiated by (and known immediately to) this service's own POST
 * .../cancel route, which already flips the record's status synchronously
 * before workflow.cancelled is even published — handling it again here
 * would be redundant, not incorrect, but the "already terminal" guard below
 * makes either order safe if that ever changes.
 */

function tenantOf(event) {
  return { organizationId: event.organizationId, workspaceId: event.workspaceId };
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

export function createWorkflowExecutionEventHandlers({ executions, audit }) {
  if (typeof executions?.get !== "function" || typeof executions?.set !== "function") {
    throw new Error("executions store is required");
  }

  function applyTerminalUpdate(event, status) {
    const executionId = event.payload?.executionId;
    if (!executionId) return { skipped: true, reason: "MISSING_EXECUTION_ID" };
    const execution = executions.get(executionId);
    // The execution record may not exist yet if this event was somehow
    // delivered before the create response was persisted, or belongs to a
    // run this replica's store doesn't know about; either way there's
    // nothing to update.
    if (!execution) return { skipped: true, reason: "EXECUTION_NOT_FOUND" };
    // Never let a redelivered or out-of-order terminal event overwrite a
    // status that already settled (including a cancel that raced ahead of
    // this event).
    if (TERMINAL_STATUSES.has(execution.status)) return { skipped: true, reason: "ALREADY_TERMINAL" };
    execution.status = status;
    execution.updatedAt = new Date().toISOString();
    if (status === "failed") execution.error = event.payload?.error ?? "Workflow execution failed";
    if (status === "completed") execution.output = event.payload?.values ?? event.payload?.output ?? null;
    executions.set(executionId, execution);
    audit?.record({ action: `workflow.execution.${status}`, tenant: tenantOf(event), resource: executionId });
    return { skipped: false };
  }

  return Object.freeze({
    "workflow.completed": async (event) => applyTerminalUpdate(event, "completed"),
    "workflow.failed": async (event) => applyTerminalUpdate(event, "failed"),
  });
}
