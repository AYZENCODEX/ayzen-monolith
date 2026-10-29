import test from "node:test";
import assert from "node:assert/strict";
import { createLeaseStore } from "../../packages/leases/src/index.mjs";
import { createScheduler } from "../../services/scheduler/src/index.mjs";

test("scheduler uses a lease to prevent duplicate execution", async () => {
  const leases = createLeaseStore();
  let runs = 0;
  const scheduler = createScheduler({
    leases,
    schedules: [{ id: "daily", owner: "ryft", trigger: "0 0 * * *", lease: "daily", targetWorkflow: "daily-close" }],
    trigger: async () => { runs += 1; },
  });
  const [first, second] = await Promise.all([scheduler.run("daily", { owner: "worker-a" }), scheduler.run("daily", { owner: "worker-b" })]);
  assert.equal(runs, 1);
  assert.equal([first.status, second.status].sort().join(","), "skipped,triggered");
});