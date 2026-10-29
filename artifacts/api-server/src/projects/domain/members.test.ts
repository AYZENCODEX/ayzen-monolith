import assert from "node:assert/strict";
import test from "node:test";
import { buildStats, mapEntityTaskEnrollment, mapMembers, mapTaskStatus } from "./members";

test("mapMembers computes progress and tolerates null counts", () => {
  const m = mapMembers([{ user_id: 7, joined_at: "d", username: "a", email: "e", tasks_completed: 2, total_tasks: 4 }, { user_id: 8, joined_at: "d", username: "b", email: "f", tasks_completed: null, total_tasks: 0 }]);
  assert.deepEqual(m.map((x) => [x.tasksCompleted, x.totalTasks, x.progress]), [[2, 4, 50], [0, 0, 0]]);
  assert.equal(mapMembers([{ tasks_completed: 1, total_tasks: 3 }])[0].progress, 33);
});

test("buildStats keeps completedTasks at 0 and coerces counts", () => {
  assert.deepEqual(buildStats("3", 2, 12.5), { totalTasks: 3, completedTasks: 0, activeUsers: 2, totalRoiDistributed: 12.5 });
  assert.equal(buildStats(0, 0, undefined).totalRoiDistributed, 0);
  assert.equal(buildStats(0, 0, null).totalRoiDistributed, 0);
});

test("task status and per-entity completion", () => {
  const t1 = mapTaskStatus({ id: 1, name: "T1", task_type: "social", reward_amount: 5, cost: null, profit: 2 }, { status: "approved" });
  const t2 = mapTaskStatus({ id: 2, name: "T2", task_type: "onchain", reward_amount: 0, cost: 1, profit: null }, undefined);
  assert.deepEqual([t1.status, t1.cost, t2.status, t2.profit], ["approved", 0, null, 0]);
  const e = mapEntityTaskEnrollment({ id: 1, vault_entry_id: 10, status: "active", entity_serial: "S" }, [t1, t2], 2);
  assert.equal(e.completedTasks, 1);
  assert.equal(e.totalTasks, 2);
  assert.equal(mapEntityTaskEnrollment({ id: 2 }, [mapTaskStatus({ id: 1 }, { status: "completed" })], 1).completedTasks, 1);
  assert.equal(mapEntityTaskEnrollment({ id: 2 }, [mapTaskStatus({ id: 1 }, { status: "pending" })], 1).completedTasks, 0);
});
