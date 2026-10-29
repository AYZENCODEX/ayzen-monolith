import test from "node:test";
import assert from "node:assert/strict";
import { createSchedule, applyScheduleUpdate, isDue, buildExecutionForSchedule, advanceSchedule } from "./schedules.mjs";

const WORKFLOW = { id: "wf-1", owner: "user-1", steps: [{ id: "s1", type: "http", url: "https://example.com" }] };

test("createSchedule computes nextRunAt from the cron expression and copies the workflow's owner", () => {
  const now = new Date(Date.UTC(2026, 0, 15, 9, 0, 0));
  const schedule = createSchedule({ workflow: WORKFLOW, body: { cron: "0 * * * *" }, now });
  assert.equal(schedule.workflowId, "wf-1");
  assert.equal(schedule.owner, "user-1");
  assert.equal(schedule.active, true);
  assert.equal(schedule.nextRunAt, "2026-01-15T10:00:00.000Z");
  assert.deepEqual(schedule.input, {});
  assert.equal(schedule.lastRunAt, null);
});

test("createSchedule respects an explicit active:false and a custom input", () => {
  const schedule = createSchedule({ workflow: WORKFLOW, body: { cron: "* * * * *", active: false, input: { foo: "bar" } } });
  assert.equal(schedule.active, false);
  assert.deepEqual(schedule.input, { foo: "bar" });
});

test("createSchedule rejects a missing or malformed cron expression", () => {
  assert.throws(() => createSchedule({ workflow: WORKFLOW, body: {} }), (error) => error.code === "INVALID_SCHEDULE");
  assert.throws(() => createSchedule({ workflow: WORKFLOW, body: { cron: "not a cron" } }), (error) => error.code === "INVALID_CRON_EXPRESSION");
});

test("createSchedule carries tenant scope onto the record", () => {
  const schedule = createSchedule({ workflow: WORKFLOW, body: { cron: "0 0 * * *" }, tenant: { organizationId: "org-1", workspaceId: "ws-1" } });
  assert.equal(schedule.organizationId, "org-1");
  assert.equal(schedule.workspaceId, "ws-1");
});

test("applyScheduleUpdate recomputes nextRunAt when the cron changes", () => {
  const now = new Date(Date.UTC(2026, 0, 15, 9, 0, 0));
  const schedule = createSchedule({ workflow: WORKFLOW, body: { cron: "0 * * * *" }, now });
  const updated = applyScheduleUpdate(schedule, { cron: "*/15 * * * *" }, { now });
  assert.equal(updated.cron, "*/15 * * * *");
  assert.equal(updated.nextRunAt, "2026-01-15T09:15:00.000Z");
});

test("applyScheduleUpdate leaves nextRunAt untouched for an unrelated field change on an active, still-future schedule", () => {
  const now = new Date(Date.UTC(2026, 0, 15, 9, 0, 0));
  const schedule = createSchedule({ workflow: WORKFLOW, body: { cron: "0 * * * *" }, now });
  const updated = applyScheduleUpdate(schedule, { input: { x: 1 } }, { now });
  assert.equal(updated.nextRunAt, schedule.nextRunAt);
  assert.deepEqual(updated.input, { x: 1 });
});

test("applyScheduleUpdate refreshes a stale nextRunAt when a paused schedule is reactivated", () => {
  const pausedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
  const schedule = { ...createSchedule({ workflow: WORKFLOW, body: { cron: "0 0 * * *", active: false }, now: pausedAt }), nextRunAt: "2026-01-02T00:00:00.000Z" };
  const reactivateAt = new Date(Date.UTC(2026, 0, 20, 12, 0, 0)); // long after the stale nextRunAt
  const updated = applyScheduleUpdate(schedule, { active: true }, { now: reactivateAt });
  assert.equal(updated.active, true);
  assert.equal(updated.nextRunAt, "2026-01-21T00:00:00.000Z", "resumes from now, not from the missed slot");
});

test("applyScheduleUpdate rejects an invalid cron on update the same way creation does", () => {
  const schedule = createSchedule({ workflow: WORKFLOW, body: { cron: "0 0 * * *" } });
  assert.throws(() => applyScheduleUpdate(schedule, { cron: "garbage" }), (error) => error.code === "INVALID_CRON_EXPRESSION");
});

test("isDue is false for an inactive schedule even if nextRunAt is in the past", () => {
  const schedule = { active: false, nextRunAt: "2020-01-01T00:00:00.000Z" };
  assert.equal(isDue(schedule, new Date(Date.UTC(2026, 0, 1))), false);
});

test("isDue is true exactly at and after nextRunAt, false strictly before it", () => {
  const schedule = { active: true, nextRunAt: "2026-01-15T09:00:00.000Z" };
  assert.equal(isDue(schedule, new Date(Date.UTC(2026, 0, 15, 8, 59, 59))), false);
  assert.equal(isDue(schedule, new Date(Date.UTC(2026, 0, 15, 9, 0, 0))), true);
  assert.equal(isDue(schedule, new Date(Date.UTC(2026, 0, 15, 9, 0, 1))), true);
});

test("buildExecutionForSchedule copies the schedule's input and carries tenant scope only when present", () => {
  const schedule = { input: { a: 1 }, organizationId: "org-1" };
  const execution = buildExecutionForSchedule({ schedule, workflow: WORKFLOW });
  assert.equal(execution.workflowId, "wf-1");
  assert.equal(execution.status, "queued");
  assert.deepEqual(execution.input, { a: 1 });
  assert.equal(execution.organizationId, "org-1");
  assert.equal("workspaceId" in execution, false);
});

test("advanceSchedule records the firing and moves nextRunAt to the next occurrence after `now`", () => {
  const schedule = createSchedule({ workflow: WORKFLOW, body: { cron: "0 * * * *" }, now: new Date(Date.UTC(2026, 0, 15, 8, 0, 0)) });
  const firedAt = new Date(Date.UTC(2026, 0, 15, 9, 0, 5)); // fired slightly after the hour mark
  const advanced = advanceSchedule(schedule, { executionId: "exec-1", now: firedAt });
  assert.equal(advanced.lastExecutionId, "exec-1");
  assert.equal(advanced.lastRunAt, firedAt.toISOString());
  assert.equal(advanced.nextRunAt, "2026-01-15T10:00:00.000Z");
});
