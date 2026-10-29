import assert from "node:assert/strict";
import test from "node:test";
import { buildRawCreateSets, buildRawUpdateSets } from "./project-raw-sets";

// PRJ-03/PRJ-06: the SQL fragments moved out of routes/projects.ts (escaping fixed in PRJ-06).

test("create sets escape single quotes", () => {
  assert.deepEqual(buildRawCreateSets({}), []);
  assert.deepEqual(buildRawCreateSets({ category: "c'at", projectType: "q", deadline: "2026-12-01", costType: "free" }),
    ["category = 'c''at'", "project_type = 'q'", "deadline = '2026-12-01'", "cost_type = 'free'"]);
});

test("FIXED in PRJ-06 (PRJ-ISSUE-1): deadline and startedAt are escaped like every other field", () => {
  assert.deepEqual(buildRawCreateSets({ deadline: "x'; DROP TABLE t; --" }), ["deadline = 'x''; DROP TABLE t; --'"]);
  assert.deepEqual(buildRawUpdateSets({ deadline: "x'y", startedAt: "z'w" }), ["deadline = 'x''y'", "started_at = 'z''w'"]);
  // Valid date strings are unaffected, so normal requests generate the same SQL as before the fix.
  assert.deepEqual(buildRawCreateSets({ deadline: "2026-12-01T10:00:00Z" }), ["deadline = '2026-12-01T10:00:00Z'"]);
  assert.deepEqual(buildRawUpdateSets({ deadline: "2026-12-01", startedAt: "2026-11-01" }), ["deadline = '2026-12-01'", "started_at = '2026-11-01'"]);
});

test("update sets: NULL for falsy dates, escaping elsewhere, JSON for custom categories", () => {
  assert.deepEqual(buildRawUpdateSets({}), []);
  assert.deepEqual(buildRawUpdateSets({ deadline: null, startedAt: "" }), ["deadline = NULL", "started_at = NULL"]);
  assert.deepEqual(buildRawUpdateSets({ status: "pa'used", exchangeCustomCategories: ["a'b"] }),
    ["status = 'pa''used'", `exchange_custom_categories = '["a''b"]'`]);
  assert.deepEqual(buildRawUpdateSets({ exchangeCustomCategories: null }), ["exchange_custom_categories = NULL"]);
});
