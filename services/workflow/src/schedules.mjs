import crypto from "node:crypto";
import { nextRunAfter, parseCron } from "@ayzen/workflow";

/**
 * H13 — Season 2 audit finding §4: "Scheduler — does not exist anywhere in
 * the new services architecture." `workflow_schedules` has been declared
 * in services/workflow's `ownedResources` since before this phase, with
 * no storage, no routes, and nothing anywhere that ever fires a workflow
 * on a cron/interval basis.
 *
 * This module holds the pure record-shaping and firing logic; ./index.mjs
 * owns the HTTP routing, auth/ownership checks, state-store reads/writes,
 * and the actual publish() call — same split as ./execution-event-handlers.mjs
 * (HTTP plumbing stays in index.mjs, the rules that plumbing calls live
 * here so they can be unit-tested against plain objects, no HTTP server or
 * database required).
 *
 * A schedule record's shape:
 *   { id, workflowId, owner, cron, input, active,
 *     organizationId?, workspaceId?,
 *     nextRunAt, lastRunAt, lastExecutionId,
 *     createdAt, updatedAt }
 *
 * `owner` is copied from the workflow definition at creation time (not
 * re-read from it later) so a schedule's own ownership check
 * (enforceWorkflowOwner in index.mjs) doesn't have to look up the
 * workflow on every schedule route — same reasoning as `execution.owner`
 * would have, had executions needed one.
 */

/** Wraps parseCron/nextRunAfter's plain Errors with a stable error code
 * index.mjs's route handlers can map to a 400, instead of every call site
 * re-deriving "was this a cron problem" from the message text. */
function computeNextRunAt(cron, now) {
  try {
    parseCron(cron);
    return nextRunAfter(cron, now).toISOString();
  } catch (error) {
    const wrapped = new Error(error.message);
    wrapped.code = "INVALID_CRON_EXPRESSION";
    throw wrapped;
  }
}

/**
 * Builds a new schedule record for `workflow`. Throws INVALID_CRON_EXPRESSION
 * (400-worthy) if `body.cron` doesn't parse — validated here, at creation
 * time, rather than left to fail silently at the worker's next poll (see
 * ./cron.mjs's own header on this).
 */
export function createSchedule({ workflow, body, tenant = {}, now = new Date() }) {
  if (typeof body?.cron !== "string" || !body.cron.trim()) {
    const error = new Error("cron is required");
    error.code = "INVALID_SCHEDULE";
    throw error;
  }
  const nextRunAt = computeNextRunAt(body.cron, now);
  const nowIso = now.toISOString();
  return Object.freeze({
    id: crypto.randomUUID(),
    workflowId: workflow.id,
    owner: workflow.owner,
    cron: body.cron,
    input: body.input ?? {},
    active: body.active !== false,
    ...tenant,
    nextRunAt,
    lastRunAt: null,
    lastExecutionId: null,
    createdAt: nowIso,
    updatedAt: nowIso,
  });
}

/**
 * Applies a partial update to an existing schedule. `nextRunAt` is
 * recomputed whenever the cron expression changes, and also whenever the
 * schedule is (re)active with a `nextRunAt` already in the past — the
 * latter closes the case where a schedule was paused for a while: without
 * this, reactivating it would look immediately "due" (nextRunAt <= now)
 * instead of resuming cleanly from whatever the cron's next real
 * occurrence is from right now.
 */
export function applyScheduleUpdate(schedule, body = {}, { now = new Date() } = {}) {
  const updated = { ...schedule };
  if (body.cron !== undefined) {
    if (typeof body.cron !== "string" || !body.cron.trim()) {
      const error = new Error("cron must be a non-empty string");
      error.code = "INVALID_SCHEDULE";
      throw error;
    }
    updated.cron = body.cron;
  }
  if (body.input !== undefined) updated.input = body.input;
  if (body.active !== undefined) updated.active = Boolean(body.active);
  const wentStale = updated.active && Date.parse(updated.nextRunAt) < now.getTime();
  if (body.cron !== undefined || wentStale) {
    updated.nextRunAt = computeNextRunAt(updated.cron, now);
  }
  updated.updatedAt = now.toISOString();
  return updated;
}

/** Whether a schedule is both active and past its own `nextRunAt`. */
export function isDue(schedule, now = new Date()) {
  return Boolean(schedule?.active) && Date.parse(schedule.nextRunAt) <= now.getTime();
}

/** The execution record a fire produces — same shape the POST
 * .../executions route builds for a directly-invoked run, minus the
 * idempotency-key handling (a schedule fire is deduped one level up, in
 * index.mjs, via the schedule's own id + due `nextRunAt` slot — see that
 * route's comment). */
export function buildExecutionForSchedule({ schedule, workflow, now = new Date() }) {
  const nowIso = now.toISOString();
  return {
    id: crypto.randomUUID(),
    workflowId: workflow.id,
    status: "queued",
    currentStep: 0,
    input: schedule.input ?? {},
    ...(schedule.organizationId ? { organizationId: schedule.organizationId } : {}),
    ...(schedule.workspaceId ? { workspaceId: schedule.workspaceId } : {}),
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

/**
 * Advances a fired schedule to its next occurrence, computed from `now`
 * (the actual fire time) rather than from the missed `nextRunAt` slot.
 * Deliberate: for a schedule the worker fires on time, `nextRunAfter`
 * lands on the same calendar-aligned instant either way (a cron
 * expression's next match doesn't drift based on what `from` was), so
 * this costs nothing in the common case — but after a period of downtime
 * it means one catch-up run per missed tick is NOT queued; the schedule
 * just resumes from the next real occurrence after whenever the worker
 * came back. A backlog-replaying scheduler is a real, different design
 * (and a bigger one); this is the same "best effort, no catch-up
 * stampede" choice most cron-like systems default to.
 */
export function advanceSchedule(schedule, { executionId, now = new Date() }) {
  const nowIso = now.toISOString();
  return {
    ...schedule,
    lastRunAt: nowIso,
    lastExecutionId: executionId,
    nextRunAt: nextRunAfter(schedule.cron, now).toISOString(),
    updatedAt: nowIso,
  };
}
