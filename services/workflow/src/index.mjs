import crypto from "node:crypto";
import {
  createAuditLog,
  createConfiguredAuthenticator,
  createServiceServer,
  readJsonBody,
  tenantScopeFromHeaders,
  requireTenantScope,
} from "@ayzen/service-runtime";
import { createHttpEnvelopeTransport, createRedisEventBus } from "@ayzen/event-client";
import { createTransactionalEventPublisher } from "@ayzen/outbox";
import { createIdempotencyKey } from "@ayzen/contracts";
import { createSharedIdempotencyStore } from "@ayzen/idempotency";
import { loadWorkflowSecurityPolicy, validateWorkflowDefinition } from "@ayzen/workflow";
import { createPostgresQuery, createStateStore } from "@ayzen/service-state";
import { createWorkflowExecutionEventHandlers } from "./execution-event-handlers.mjs";
import { createSchedule, applyScheduleUpdate, isDue, buildExecutionForSchedule, advanceSchedule } from "./schedules.mjs";

// Phase H8.4 — config/workflow/security.json's `workflowOwnerRequired` and
// `cancellationIsAudited` (Season 2 finding #9) were validated for shape
// only; nothing here ever read them, so any authenticated caller — not
// just a workflow's own owner — could execute or cancel someone else's
// workflow, and an unauthenticated request could create one at all (the
// `auth?.sub ?? auth?.subject ?? "workflow-api"` fallback below never
// noticed there was no real caller behind it). Loaded once at module scope,
// same as packages/workflow/src/executor.mjs's own
// `stepAuthorizationRequired` / `approvalForSensitiveSteps` read (H8.3) —
// one parse of the file, shared by every route below.
const securityPolicy = loadWorkflowSecurityPolicy();

// Phase H6.2: durable, Postgres-backed state instead of a plain
// Map() that a restart/redeploy would wipe. Falls back to an
// in-memory Map only when ALLOW_SERVICE_MEMORY_STORE=true (local dev);
// otherwise a missing DATABASE_URL is a boot-time error, not a silent
// data-loss risk.
const dbQuery = await createPostgresQuery();
const allowMemoryState = process.env.ALLOW_SERVICE_MEMORY_STORE === "true";
const workflows = await createStateStore({ service: "workflow", collection: "workflows", query: dbQuery, allowMemoryFallback: allowMemoryState });
const executions = await createStateStore({ service: "workflow", collection: "executions", query: dbQuery, allowMemoryFallback: allowMemoryState });
// Phase H8.1: durable queue backing the `approval` workflow step type — see
// the approval routes below and apps/worker/src/approval.mjs, which is what
// actually blocks a running workflow on the decision recorded here.
const approvals = await createStateStore({ service: "workflow", collection: "approvals", query: dbQuery, allowMemoryFallback: allowMemoryState });
// H13 — Season 2 audit finding §4: `workflow_schedules` has been declared
// in ownedResources (below) since before this phase, with no storage, no
// routes, and nothing anywhere that ever fires a workflow on a cron. See
// ./schedules.mjs for the record shape and CRUD/internal-firing logic;
// this is the same durable-Map pattern as `workflows`/`executions`/
// `approvals` above, just its own collection.
const schedules = await createStateStore({ service: "workflow", collection: "schedules", query: dbQuery, allowMemoryFallback: allowMemoryState });
// Phase H6.3: Postgres-backed (via the same dbQuery pool as the state
// stores above), so a replayed idempotency key is honored no matter which
// replica handles the retry, instead of only the one that saw the original.
const idempotency = await createSharedIdempotencyStore({ service: "workflow", query: dbQuery, allowMemoryFallback: allowMemoryState });
const audit = createAuditLog({ service: "workflow" });
// Phase H6.1: publish through the transactional outbox so the state
// write above and this event either both happen or neither does,
// instead of a bare HTTP publish that can fall out of sync with state
// on a crash or network blip between the two.
const publish = createTransactionalEventPublisher({ service: "workflow", transport: createHttpEnvelopeTransport({ service: "workflow" }) });

// Phase H7.5 — subscribe to the terminal events only the worker's executor
// can know when to emit (see apps/worker/src/index.mjs) so this service's
// own execution record actually reflects reality instead of sitting at
// "queued" forever. See ./execution-event-handlers.mjs for why this is a
// subscription rather than the worker reaching back over HTTP or this
// service reading the worker's own Postgres tables.
const executionEventHandlers = createWorkflowExecutionEventHandlers({ executions, audit });
if (process.env.EVENT_BUS_REDIS_URL || process.env.EVENT_BUS_URL) {
  const eventBus = createRedisEventBus({ consumer: process.env.EVENT_BUS_CONSUMER ?? `workflow-${process.pid}` });
  for (const [eventType, eventHandler] of Object.entries(executionEventHandlers)) {
    eventBus.subscribe(eventType, async (event) => {
      try {
        await eventHandler(event);
      } catch (error) {
        console.error(JSON.stringify({ timestamp: new Date().toISOString(), service: "workflow", event: "event.consumer.failed", type: eventType, event_id: event?.eventId, error: String(error?.message ?? error) }));
        throw error;
      }
    });
  }
} else if (process.env.ALLOW_EVENTBUS_NOOP !== "true") {
  throw new Error("workflow requires EVENT_BUS_REDIS_URL to consume workflow.completed/workflow.failed; set ALLOW_EVENTBUS_NOOP=true only for local development");
}

// Phase H8.3 — widened to also carry `scopes`/`roles`/`stepUpAt` when the
// authenticator provided them (a verified JWT's own claims — see
// @ayzen/auth-client's createJwksAuthenticator, whose payload passes
// straight through as `auth` here). Every existing caller of actorFrom()
// (audit records, other event `actor` fields) is unaffected: those still
// only ever read `.subject`/`.actorType` off the result. The one new
// caller is the `workflow.started` event below, whose `actor` field is
// where apps/worker/src/index.mjs's authContextFrom() reads these from to
// run packages/workflow/src/executor.mjs's step-boundary capability gate
// against the real caller's identity instead of no identity at all.
function actorFrom(auth) {
  if (!auth) return undefined;
  const subject = auth.sub ?? auth.subject;
  const scopes = Array.isArray(auth.scopes) ? auth.scopes : undefined;
  const roles = Array.isArray(auth.roles) ? auth.roles : undefined;
  return {
    subject,
    actorType: auth.actorType ?? "user",
    ...(scopes ? { scopes } : {}),
    ...(roles ? { roles } : {}),
    ...(auth.stepUpAt ? { stepUpAt: auth.stepUpAt } : {}),
  };
}

/**
 * Phase H8.4 — the one gate for `workflowOwnerRequired` across all three
 * routes the roadmap names: create, execute, cancel.
 *
 * `owner` is the identity the caller must match — the workflow's own
 * `owner` field (set once, at creation, from whoever created it) for
 * execute and cancel; `undefined` for create, where there's no prior owner
 * to match against and the check collapses to "is someone actually
 * authenticated" (closing the other half of the gap: the `"workflow-api"`
 * fallback in the create route below used to let an anonymous request
 * create a workflow that then claimed to be owned by nobody in particular).
 *
 * Denials are audited the same as a decision (outcome: "denied") rather
 * than silently returned — an operator watching /internal/audit should see
 * a rejected cancel/execute attempt exactly as clearly as an accepted one,
 * which is also most of what makes `cancellationIsAudited` real: every
 * cancel attempt, not just the ones that succeed, leaves a record.
 */
function enforceWorkflowOwner({ owner, auth, action, resource, tenant, requestId }) {
  if (!securityPolicy.workflowOwnerRequired) return undefined;
  const subject = auth?.sub ?? auth?.subject;
  if (!subject) {
    audit.record({ action: `${action}.denied`, actor: actorFrom(auth), tenant, resource, outcome: "denied", requestId, metadata: { reason: "WORKFLOW_OWNER_REQUIRED" } });
    return { status: 401, body: { error: "Authentication is required", code: "WORKFLOW_OWNER_REQUIRED" } };
  }
  if (owner !== undefined && subject !== owner) {
    audit.record({ action: `${action}.denied`, actor: actorFrom(auth), tenant, resource, outcome: "denied", requestId, metadata: { reason: "WORKFLOW_OWNER_MISMATCH" } });
    return { status: 403, body: { error: "This action is restricted to the workflow's owner", code: "WORKFLOW_OWNER_MISMATCH" } };
  }
  return undefined;
}

async function handle({ req, url, requestId, auth }) {
  const tenant = tenantScopeFromHeaders(req.headers, { auth });
  if (url.pathname === "/api/workflows" && req.method === "GET") {
    return { status: 200, body: { items: [...workflows.values()].filter((workflow) => (!tenant.workspaceId || workflow.workspaceId === tenant.workspaceId) && (!tenant.organizationId || workflow.organizationId === tenant.organizationId)) } };
  }
  if (url.pathname === "/api/workflows" && req.method === "POST") {
    // Phase H8.4 — checked before the body is even read: creating a
    // workflow is what assigns its `owner` (below), so there is no prior
    // owner to match — this only closes the "nobody authenticated at all"
    // half of the gap (see enforceWorkflowOwner's own comment).
    const createDenied = enforceWorkflowOwner({ auth, action: "workflow.create", resource: undefined, tenant, requestId });
    if (createDenied) return createDenied;
    const body = await readJsonBody(req);
    if (!body.name || !Array.isArray(body.steps)) return { status: 400, body: { error: "name and steps are required", code: "INVALID_WORKFLOW" } };
    const workflow = {
      id: crypto.randomUUID(),
      name: body.name,
      version: 1,
      steps: body.steps,
      owner: auth?.sub ?? auth?.subject ?? "workflow-api",
      status: "active",
      // Phase H8.3 — validateWorkflowDefinition() below has always
      // preserved a `policyContext` field on whatever record it's given
      // (see @ayzen/workflow's ./index.mjs), but until now nothing ever
      // put one on the record in the first place: this handler built
      // `workflow` without copying `body.policyContext` at all, so no
      // workflow created through this route could ever declare one
      // (Season 1 finding #5's other half — "validated and stored" was
      // only true for a policyContext no caller could actually attach).
      ...(body.policyContext !== undefined ? { policyContext: body.policyContext } : {}),
      ...tenant,
      createdAt: new Date().toISOString(),
    };
    try {
      validateWorkflowDefinition(workflow);
    } catch (error) {
      return { status: 400, body: { error: error.message, code: "INVALID_WORKFLOW_DEFINITION" } };
    }
    workflows.set(workflow.id, workflow);
    audit.record({ action: "workflow.create", actor: actorFrom(auth), tenant, resource: workflow.id, requestId });
    return { status: 201, body: workflow };
  }
  const executeMatch = url.pathname.match(/^\/api\/workflows\/([^/]+)\/executions$/);
  if (executeMatch && req.method === "POST") {
    const workflow = workflows.get(executeMatch[1]);
    if (!workflow) return { status: 404, body: { error: "Workflow not found", code: "WORKFLOW_NOT_FOUND" } };
    // Phase H8.4 — before this, any authenticated caller (not just the
    // workflow's own owner) could start an execution of someone else's
    // workflow definition; there was no check against `workflow.owner` at
    // all here.
    const executeDenied = enforceWorkflowOwner({ owner: workflow.owner, auth, action: "workflow.execute", resource: workflow.id, tenant, requestId });
    if (executeDenied) return executeDenied;
    const headerKey = req.headers["idempotency-key"];
    const key = headerKey ? createIdempotencyKey({ scope: `workflow:${workflow.id}`, key: headerKey }) : undefined;
    const previous = await idempotency.get(key);
    if (previous) return previous;
    const execution = { id: crypto.randomUUID(), workflowId: workflow.id, status: "queued", currentStep: 0, input: (await readJsonBody(req)).input ?? {}, ...tenant, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    executions.set(execution.id, execution);
    const response = { status: 202, body: execution };
    await idempotency.set(key, response);
    audit.record({ action: "workflow.execute", actor: actorFrom(auth), tenant, resource: execution.id, requestId });
    await publish.publish({
      eventType: "workflow.started",
      payload: {
        workflowId: workflow.id,
        executionId: execution.id,
        stepCount: workflow.steps.length,
        definition: workflow,
        input: execution.input,
      },
      actor: actorFrom(auth),
      ...tenant,
      aggregate: { type: "workflow_execution", id: execution.id },
    });
    return response;
  }
  // Phase H7.5 — this route was declared in packages/capabilities
  // ("workflow.get-execution") but never implemented, so there was no way
  // to observe an execution's status at all, let alone see it change.
  const getExecutionMatch = url.pathname.match(/^\/api\/workflows\/executions\/([^/]+)$/);
  if (getExecutionMatch && req.method === "GET") {
    const execution = executions.get(getExecutionMatch[1]);
    if (!execution) return { status: 404, body: { error: "Execution not found", code: "EXECUTION_NOT_FOUND" } };
    if (tenant.workspaceId && execution.workspaceId !== tenant.workspaceId) return { status: 404, body: { error: "Execution not found", code: "EXECUTION_NOT_FOUND" } };
    if (tenant.organizationId && execution.organizationId !== tenant.organizationId) return { status: 404, body: { error: "Execution not found", code: "EXECUTION_NOT_FOUND" } };
    return { status: 200, body: execution };
  }
  const cancelMatch = url.pathname.match(/^\/api\/workflows\/executions\/([^/]+)\/cancel$/);
  if (cancelMatch && req.method === "POST") {
    const execution = executions.get(cancelMatch[1]);
    if (!execution) return { status: 404, body: { error: "Execution not found", code: "EXECUTION_NOT_FOUND" } };
    // Phase H8.4 — a cancel is scoped to the workflow definition's owner,
    // same identity execute checks above, fetched via the execution's own
    // workflowId. Before this, any authenticated caller could cancel any
    // execution — cancel was open to everyone, not just whoever owned the
    // workflow being cancelled.
    const owningWorkflow = workflows.get(execution.workflowId);
    const cancelDenied = enforceWorkflowOwner({ owner: owningWorkflow?.owner, auth, action: "workflow.cancel", resource: execution.id, tenant, requestId });
    if (cancelDenied) return cancelDenied;
    if (["completed", "failed", "cancelled"].includes(execution.status)) return { status: 409, body: { error: "Execution is already terminal", code: "EXECUTION_TERMINAL" } };
    // Phase H8.4 — `cancellationIsAudited` fail-closed: the audit write
    // happens, and is checked, before any state changes below. An audit
    // write was already made unconditionally here before this phase, but
    // nothing guaranteed the cancel itself wouldn't still go through if it
    // failed. When the policy requires cancellation to be audited, a cancel
    // whose audit record can't be written never mutates `execution` or
    // publishes `workflow.cancelled` at all — the same fail-closed posture
    // ./security-policy.mjs takes on a missing/misreadable config file.
    try {
      audit.record({ action: "workflow.cancel", actor: actorFrom(auth), tenant, resource: execution.id, requestId });
    } catch (error) {
      if (securityPolicy.cancellationIsAudited) {
        return { status: 500, body: { error: "Cancellation could not be audited", code: "WORKFLOW_CANCEL_AUDIT_FAILED" } };
      }
    }
    execution.status = "cancelled";
    execution.updatedAt = new Date().toISOString();
    await publish.publish({ eventType: "workflow.cancelled", payload: { workflowId: execution.workflowId, executionId: execution.id }, actor: actorFrom(auth), ...tenant, aggregate: { type: "workflow_execution", id: execution.id } });
    return { status: 200, body: execution };
  }

  // ---------------------------------------------------------------------
  // Phase H8.1 — approval queue backing the workflow "approval" step type.
  // packages/workflow/src/executor.mjs's `approval` step calls whatever
  // `approval` handler createWorkflowExecutor was given; before this, the
  // production worker (apps/worker) never supplied one, so any workflow
  // with an approval step threw the moment it reached that step. Now the
  // worker's handler (apps/worker/src/approval.mjs) creates a record here
  // and polls it until a decision is recorded via POST .../decision below —
  // that's what makes the step genuinely pause the run instead of skipping
  // or throwing.
  // ---------------------------------------------------------------------
  if (url.pathname === "/api/workflows/approvals" && req.method === "POST") {
    requireTenantScope(tenant);
    const body = await readJsonBody(req);
    if (!body.executionId || !body.stepId) return { status: 400, body: { error: "executionId and stepId are required", code: "INVALID_APPROVAL_REQUEST" } };
    const execution = executions.get(body.executionId);
    const approval = {
      id: crypto.randomUUID(),
      executionId: body.executionId,
      workflowId: execution?.workflowId ?? body.workflowId,
      stepId: body.stepId,
      correlationId: body.correlationId,
      description: body.description,
      input: body.input ?? {},
      status: "pending",
      ...tenant,
      requestedBy: actorFrom(auth),
      createdAt: new Date().toISOString(),
    };
    approvals.set(approval.id, approval);
    audit.record({ action: "workflow.approval.requested", actor: actorFrom(auth), tenant, resource: approval.id, requestId });
    return { status: 201, body: approval };
  }
  if (url.pathname === "/api/workflows/approvals" && req.method === "GET") {
    const statusFilter = url.searchParams.get("status");
    const items = [...approvals.values()].filter((approval) => (!statusFilter || approval.status === statusFilter) && (!tenant.workspaceId || approval.workspaceId === tenant.workspaceId) && (!tenant.organizationId || approval.organizationId === tenant.organizationId));
    return { status: 200, body: { items } };
  }
  const approvalMatch = url.pathname.match(/^\/api\/workflows\/approvals\/([^/]+)$/);
  if (approvalMatch && req.method === "GET") {
    const approval = approvals.get(approvalMatch[1]);
    if (!approval) return { status: 404, body: { error: "Approval not found", code: "APPROVAL_NOT_FOUND" } };
    return { status: 200, body: approval };
  }
  const approvalDecisionMatch = url.pathname.match(/^\/api\/workflows\/approvals\/([^/]+)\/decision$/);
  if (approvalDecisionMatch && req.method === "POST") {
    const approval = approvals.get(approvalDecisionMatch[1]);
    if (!approval) return { status: 404, body: { error: "Approval not found", code: "APPROVAL_NOT_FOUND" } };
    if (approval.status !== "pending") return { status: 409, body: { error: "Approval has already been decided", code: "APPROVAL_ALREADY_DECIDED" } };
    const approver = auth?.sub ?? auth?.subject;
    const approvalTenantMatches = approval.organizationId === tenant.organizationId && approval.workspaceId === tenant.workspaceId;
    const canApprove = Array.isArray(auth?.scopes) && auth.scopes.includes("workflow:approve")
      || Array.isArray(auth?.roles) && auth.roles.some((role) => ["owner", "operator", "admin"].includes(role));
    if (!approver) return { status: 401, body: { error: "An authenticated approver is required", code: "APPROVER_REQUIRED" } };
    if (!approvalTenantMatches || !canApprove) {
      audit.record({ action: "workflow.approval.denied", actor: actorFrom(auth), tenant, resource: approval.id, outcome: "denied", requestId, metadata: { reason: !approvalTenantMatches ? "APPROVAL_TENANT_MISMATCH" : "APPROVAL_CAPABILITY_REQUIRED" } });
      return { status: 403, body: { error: "Approval capability and tenant binding are required", code: !approvalTenantMatches ? "APPROVAL_TENANT_MISMATCH" : "APPROVAL_CAPABILITY_REQUIRED" } };
    }
    const body = await readJsonBody(req);
    if (!["approved", "rejected"].includes(body.decision)) return { status: 400, body: { error: "decision must be 'approved' or 'rejected'", code: "INVALID_DECISION" } };
    approval.status = body.decision;
    approval.reason = body.reason;
    approval.decidedBy = actorFrom(auth);
    approval.version = (approval.version ?? 0) + 1;
    approval.decidedAt = new Date().toISOString();
    approvals.set(approval.id, approval);
    audit.record({ action: `workflow.approval.${body.decision}`, actor: actorFrom(auth), tenant, resource: approval.id, requestId });
    return { status: 200, body: approval };
  }

  // ---------------------------------------------------------------------
  // H13 — Season 2 audit finding §4: `workflow_schedules` CRUD. Ownership
  // is gated the same way as the workflow-definition routes above
  // (enforceWorkflowOwner), since a schedule is nothing more than "run
  // this workflow automatically" and the same policy that restricts who
  // may execute a workflow directly should restrict who may make it
  // execute itself. See ./schedules.mjs for the record shape and the
  // create/update/fire logic; the /internal/workflows/schedules/* routes
  // further below are what apps/worker's cron-trigger poller
  // (./schedule-trigger.mjs) actually calls — not policy-gated, same
  // convention as /internal/audit and /internal/jobs elsewhere in this
  // repo (see @ayzen/capabilities' matchCapabilityRoute: an unregistered
  // /internal/* path is "not_gated", not "denied").
  // ---------------------------------------------------------------------
  const workflowSchedulesMatch = url.pathname.match(/^\/api\/workflows\/([^/]+)\/schedules$/);
  if (workflowSchedulesMatch && req.method === "POST") {
    const workflow = workflows.get(workflowSchedulesMatch[1]);
    if (!workflow) return { status: 404, body: { error: "Workflow not found", code: "WORKFLOW_NOT_FOUND" } };
    const scheduleDenied = enforceWorkflowOwner({ owner: workflow.owner, auth, action: "workflow.schedule.create", resource: workflow.id, tenant, requestId });
    if (scheduleDenied) return scheduleDenied;
    const body = await readJsonBody(req);
    let schedule;
    try {
      schedule = createSchedule({ workflow, body, tenant });
    } catch (error) {
      return { status: 400, body: { error: error.message, code: error.code ?? "INVALID_SCHEDULE" } };
    }
    schedules.set(schedule.id, schedule);
    audit.record({ action: "workflow.schedule.create", actor: actorFrom(auth), tenant, resource: schedule.id, requestId });
    return { status: 201, body: schedule };
  }
  if (workflowSchedulesMatch && req.method === "GET") {
    const items = [...schedules.values()].filter((schedule) => schedule.workflowId === workflowSchedulesMatch[1] && (!tenant.workspaceId || schedule.workspaceId === tenant.workspaceId) && (!tenant.organizationId || schedule.organizationId === tenant.organizationId));
    return { status: 200, body: { items } };
  }
  const scheduleMatch = url.pathname.match(/^\/api\/workflows\/schedules\/([^/]+)$/);
  if (scheduleMatch && req.method === "GET") {
    const schedule = schedules.get(scheduleMatch[1]);
    if (!schedule) return { status: 404, body: { error: "Schedule not found", code: "SCHEDULE_NOT_FOUND" } };
    if (tenant.workspaceId && schedule.workspaceId !== tenant.workspaceId) return { status: 404, body: { error: "Schedule not found", code: "SCHEDULE_NOT_FOUND" } };
    if (tenant.organizationId && schedule.organizationId !== tenant.organizationId) return { status: 404, body: { error: "Schedule not found", code: "SCHEDULE_NOT_FOUND" } };
    return { status: 200, body: schedule };
  }
  if (scheduleMatch && req.method === "PATCH") {
    const schedule = schedules.get(scheduleMatch[1]);
    if (!schedule) return { status: 404, body: { error: "Schedule not found", code: "SCHEDULE_NOT_FOUND" } };
    const scheduleDenied = enforceWorkflowOwner({ owner: schedule.owner, auth, action: "workflow.schedule.update", resource: schedule.id, tenant, requestId });
    if (scheduleDenied) return scheduleDenied;
    const body = await readJsonBody(req);
    let updated;
    try {
      updated = applyScheduleUpdate(schedule, body);
    } catch (error) {
      return { status: 400, body: { error: error.message, code: error.code ?? "INVALID_SCHEDULE" } };
    }
    schedules.set(updated.id, updated);
    audit.record({ action: "workflow.schedule.update", actor: actorFrom(auth), tenant, resource: updated.id, requestId });
    return { status: 200, body: updated };
  }
  if (scheduleMatch && req.method === "DELETE") {
    const schedule = schedules.get(scheduleMatch[1]);
    if (!schedule) return { status: 404, body: { error: "Schedule not found", code: "SCHEDULE_NOT_FOUND" } };
    const scheduleDenied = enforceWorkflowOwner({ owner: schedule.owner, auth, action: "workflow.schedule.delete", resource: schedule.id, tenant, requestId });
    if (scheduleDenied) return scheduleDenied;
    schedules.delete(schedule.id);
    audit.record({ action: "workflow.schedule.delete", actor: actorFrom(auth), tenant, resource: schedule.id, requestId });
    return { status: 200, body: { deleted: true, id: schedule.id } };
  }

  // Internal — apps/worker's poller only, no human/API caller. See the
  // block comment above for why these two routes are intentionally
  // outside the capability gate.
  if (url.pathname === "/internal/workflows/schedules" && req.method === "GET") {
    const items = [...schedules.values()].filter((schedule) => schedule.active);
    return { status: 200, body: { items } };
  }
  const scheduleFireMatch = url.pathname.match(/^\/internal\/workflows\/schedules\/([^/]+)\/fire$/);
  if (scheduleFireMatch && req.method === "POST") {
    const schedule = schedules.get(scheduleFireMatch[1]);
    if (!schedule) return { status: 404, body: { error: "Schedule not found", code: "SCHEDULE_NOT_FOUND" } };
    if (!isDue(schedule)) return { status: 200, body: { fired: false, reason: schedule.active ? "NOT_DUE" : "SCHEDULE_INACTIVE" } };
    const workflow = workflows.get(schedule.workflowId);
    if (!workflow) {
      // The workflow this schedule points at is gone. Deactivating here
      // (rather than leaving it active) stops the poller from re-offering
      // the same permanently-unfireable schedule to /fire on every future
      // tick — same "don't keep retrying something that can't succeed"
      // instinct as the H7.1 dispatch table's acknowledgeOnly() entries.
      schedules.set(schedule.id, { ...schedule, active: false, updatedAt: new Date().toISOString() });
      return { status: 200, body: { fired: false, reason: "WORKFLOW_NOT_FOUND" } };
    }
    // Dedup key: this schedule's id + the exact due slot it's firing for.
    // Two worker replicas (or two overlapping poll ticks) racing to fire
    // the same due schedule both call this route; the second one to reach
    // idempotency.set() below sees the first one's stored response instead
    // of creating a second execution — same shared-Postgres idempotency
    // mechanism the POST .../executions route above already relies on for
    // the identical reason (H6.3).
    const key = createIdempotencyKey({ scope: `workflow-schedule:${schedule.id}`, key: schedule.nextRunAt });
    const previous = await idempotency.get(key);
    if (previous) return previous;
    const execution = buildExecutionForSchedule({ schedule, workflow });
    executions.set(execution.id, execution);
    const actor = { subject: schedule.owner, actorType: "user" };
    const response = { status: 200, body: { fired: true, scheduleId: schedule.id, workflowId: workflow.id, executionId: execution.id } };
    await idempotency.set(key, response);
    const advanced = advanceSchedule(schedule, { executionId: execution.id });
    schedules.set(advanced.id, advanced);
    audit.record({ action: "workflow.schedule.fire", actor, tenant: { ...(schedule.organizationId ? { organizationId: schedule.organizationId } : {}), ...(schedule.workspaceId ? { workspaceId: schedule.workspaceId } : {}) }, resource: schedule.id, metadata: { executionId: execution.id }, requestId });
    await publish.publish({
      eventType: "workflow.started",
      payload: {
        workflowId: workflow.id,
        executionId: execution.id,
        stepCount: workflow.steps.length,
        definition: workflow,
        input: execution.input,
      },
      actor,
      ...(schedule.organizationId ? { organizationId: schedule.organizationId } : {}),
      ...(schedule.workspaceId ? { workspaceId: schedule.workspaceId } : {}),
      aggregate: { type: "workflow_execution", id: execution.id },
    });
    return response;
  }

  if (url.pathname === "/internal/audit" && req.method === "GET") return { status: 200, body: { items: audit.list() } };
  return { status: 404, body: { error: "Route not found", code: "NOT_FOUND" } };
}

createServiceServer({
  service: "workflow",
  displayName: "Workflow / SKARN",
  port: Number(process.env.PORT ?? 8105),
  routePrefixes: ["/api/workflows"],
  handle,
  authenticate: createConfiguredAuthenticator({ service: "workflow" }),
  domain: "workflow",
  owner: "SKARN",
  ownedResources: ["workflows", "workflow_versions", "workflow_executions", "workflow_steps", "workflow_schedules", "workflow_approvals"],
  emittedEvents: ["workflow.started", "workflow.completed", "workflow.failed", "workflow.cancelled"],
  // Phase H7.5: this service now also consumes its own domain's terminal
  // events (workflow.completed/failed) to keep its execution record honest
  // — see ./execution-event-handlers.mjs for why that's not a contradiction
  // (this process only emits workflow.started/cancelled; the worker process
  // is the one that emits workflow.completed/failed, since it's the only
  // process that knows when a run actually finishes).
  consumedEvents: ["finance.transaction.created", "wisp.message.received", "workflow.completed", "workflow.failed"],
  rollbackStrategy: "stop workers, keep execution state, route API to monolith",
  dependencies: { configuration: true, queue: true, stateStore: true, eventBus: true },
}).start();