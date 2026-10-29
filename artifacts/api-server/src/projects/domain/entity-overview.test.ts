import assert from "node:assert/strict";
import test from "node:test";
import { buildEntityLeaderboard, buildEntityOverview, emptyEntityOverview } from "./entity-overview";

test("emptyEntityOverview is the silent-deny shape", () => {
  assert.deepEqual(emptyEntityOverview(7), { entity: null, vaultEntryId: 7, projects: [], activity: [], summary: { totalProjects: 0, completedProjects: 0, ongoingProjects: 0, totalRoi: 0, totalProfit: 0, totalCost: 0 } });
});

test("buildEntityOverview maps rows, derives progress/roi and splits completed vs ongoing", () => {
  const rows = [
    { project_id: 1, project_name: "A", project_type: null, category: "c", thumbnail_url: "t", total_tasks: 4, completed_tasks: 3, total_profit: "30.5", total_cost: "10", enrollment_id: 1, enrolled_at: "d1", enrollment_status: "active" },
    { project_id: 2, project_name: "B", project_type: "quest", category: null, thumbnail_url: null, total_tasks: 0, completed_tasks: 0, total_profit: 0, total_cost: 5, enrollment_id: 3, enrolled_at: "d2", enrollment_status: "completed" },
    { project_id: 3, project_name: "C", project_type: "x", category: "c", thumbnail_url: null, total_tasks: 3, completed_tasks: 1, total_profit: 1, total_cost: 0, enrollment_id: 9, enrolled_at: "d3", enrollment_status: null },
  ];
  const o = buildEntityOverview(10, rows, [{ entity_serial: "E" }], [{ day: "2026-01-01", count: "2" }]);
  assert.equal(o.projects[0].projectType, "protocol");
  assert.equal(o.projects[0].progress, 75);
  assert.equal(o.projects[0].roi, 20.5);
  assert.equal(o.projects[1].progress, 0);
  assert.equal(o.projects[2].enrollmentStatus, "active");
  assert.equal(o.projects[2].progress, 33);
  assert.deepEqual(o.summary, { totalProjects: 3, completedProjects: 1, ongoingProjects: 2, totalRoi: 20.5 - 5 + 1, totalProfit: 31.5, totalCost: 15 });
  assert.deepEqual(o.activity, [{ day: "2026-01-01", count: 2 }]);
  assert.deepEqual(o.entity, { entity_serial: "E" });
  assert.equal(buildEntityOverview(10, [], [], []).entity, null);
});

test("buildEntityLeaderboard ranks by ROI descending and keeps order for ties", () => {
  const row = (id: number, profit: number, cost: number) => ({ vault_entry_id: id, entity_serial: null, entity_name: null, category: null, total_projects: 1, completed_projects: 0, ongoing_projects: 1, active_projects: 1, disqualified_projects: 0, banned_projects: 0, cancelled_projects: 0, total_completions: 2, total_profit: profit, total_cost: cost });
  const lb = buildEntityLeaderboard([row(1, 3, 3), row(2, 10.5, 2), row(3, 3, 3)]);
  assert.deepEqual(lb.map((e) => [e.vaultEntryId, e.rank, e.totalRoi]), [[2, 1, 8.5], [1, 2, 0], [3, 3, 0]]);
});
