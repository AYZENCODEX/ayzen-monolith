import assert from "node:assert/strict";
import test from "node:test";
import { buildCreateValues, buildUpdateFields, formatCreatedProject, formatProject, formatUpdatedProject, parsePagination, toJsonText } from "./project";

// PRJ-03: pins the core-CRUD rules moved out of routes/projects.ts.

test("formatProject adds counts and ISO createdAt", () => {
  const d = new Date("2026-01-01T00:00:00Z");
  assert.deepEqual(formatProject({ id: 1, createdAt: d }), { id: 1, createdAt: d.toISOString(), taskCount: 0, completedTaskCount: 0, activeUserCount: 0 });
  assert.deepEqual(formatProject({ id: 1, createdAt: d }, 3, 1, 9), { id: 1, createdAt: d.toISOString(), taskCount: 3, completedTaskCount: 1, activeUserCount: 9 });
});

test("parsePagination defaults, caps the limit at 200, and keeps NaN behavior", () => {
  assert.deepEqual(parsePagination({}), { pageNum: 1, limitNum: 20, offset: 0 });
  assert.deepEqual(parsePagination({ page: "3", limit: "10" }), { pageNum: 3, limitNum: 10, offset: 20 });
  assert.equal(parsePagination({ limit: "999" }).limitNum, 200);
  assert.ok(Number.isNaN(parsePagination({ limit: "abc" }).limitNum));
  assert.equal(parsePagination({ page: "0", limit: "2" }).offset, -2);
});

test("toJsonText passes strings through and stringifies the rest", () => {
  assert.equal(toJsonText("[1]"), "[1]");
  assert.equal(toJsonText([1, { a: 2 }]), '[1,{"a":2}]');
});

test("buildCreateValues applies the documented defaults", () => {
  const v = buildCreateValues({ name: "N" });
  assert.equal(v.xpName, null);
  assert.equal(v.xpPrice, undefined);
  assert.equal(v.tutorialSteps, null);
  assert.equal(v.badges, null);
  assert.equal(v.experienceLevel, "Beginner");
  assert.equal(v.tier, "1");
  assert.equal(v.fundingAmount, 0);
  assert.equal(v.rewardEstimate, 0);
  const full = buildCreateValues({ name: "N", xpName: "", xpPrice: "2.5", tutorialSteps: [1], badges: "b", tier: "3", fundingAmount: "10" });
  assert.equal(full.xpName, null);
  assert.equal(full.xpPrice, 2.5);
  assert.equal(full.tutorialSteps, "[1]");
  assert.equal(full.badges, "b");
  assert.equal(full.tier, "3");
  assert.equal(full.fundingAmount, 10);
  assert.equal(buildCreateValues({ name: "N", xpPrice: 0 }).xpPrice, 0);
  assert.equal(buildCreateValues({ name: "N", xpPrice: "" }).xpPrice, undefined);
  assert.equal(buildCreateValues({ name: "N", xpPrice: null }).xpPrice, undefined);
});

test("buildUpdateFields only includes fields present in the body", () => {
  assert.deepEqual(buildUpdateFields({}), {});
  assert.deepEqual(buildUpdateFields({ name: "x", tier: "2", ignored: 1, tutorialSteps: [1], badges: "b" }), { name: "x", tier: "2", tutorialSteps: "[1]", badges: "b" });
  assert.deepEqual(buildUpdateFields({ description: null }), { description: null });
});

test("formatUpdatedProject handles typed and raw rows", () => {
  const d = new Date("2026-01-01T00:00:00Z");
  assert.deepEqual(formatUpdatedProject({ id: 1, createdAt: d, deadline: d, started_at: d, status: "live" }),
    { id: 1, createdAt: d.toISOString(), deadline: d.toISOString(), startedAt: d.toISOString(), started_at: d, status: "live" });
  // `...p` keeps the raw started_at key next to startedAt, exactly as the route did.
  const raw = formatUpdatedProject({ id: 1, created_at: d });
  assert.equal(raw.createdAt, undefined);
  assert.equal(raw.deadline, null);
  assert.equal(raw.startedAt, null);
  assert.equal(raw.status, "active");
});

// PRJ-ISSUE-2: POST /projects with raw-only fields (category, deadline, ...) used to format the snake_case
// `UPDATE ... RETURNING *` row, whose `createdAt` is undefined, and threw after the project was inserted.
test("formatCreatedProject survives a snake_case raw row (PRJ-ISSUE-2)", () => {
  const d = new Date("2026-01-01T00:00:00Z");
  const typed = { id: 7, name: "P", tier: "1", createdAt: d };
  const raw = { id: 7, name: "P", created_at: d, category: "defi", project_type: "airdrop", deadline: d };
  // The old behavior: formatting the raw row threw.
  assert.throws(() => formatProject(raw as any), TypeError);
  const out = formatCreatedProject(typed, raw) as any;
  assert.equal(out.createdAt, d.toISOString());
  assert.equal(out.category, "defi");
  assert.equal(out.project_type, "airdrop");
  assert.equal(out.id, 7);
  assert.equal(out.taskCount, 0);
});

test("formatCreatedProject without a raw row equals formatProject", () => {
  const d = new Date("2026-01-01T00:00:00Z");
  const typed = { id: 1, createdAt: d };
  assert.deepEqual(formatCreatedProject(typed), formatProject(typed));
  assert.deepEqual(formatCreatedProject(typed, null), formatProject(typed));
});

test("formatCreatedProject: the typed row wins over same-named raw keys", () => {
  const d = new Date("2026-01-01T00:00:00Z");
  const out = formatCreatedProject({ id: 1, name: "typed", createdAt: d }, { id: 1, name: "raw", created_at: d }) as any;
  assert.equal(out.name, "typed");
  assert.equal(out.createdAt, d.toISOString());
});
