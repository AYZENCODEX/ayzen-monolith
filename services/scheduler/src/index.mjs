import { createLeaseStore } from "@ayzen/leases";
import { validateScheduleDefinition } from "@ayzen/platform-governance";

export function createScheduler({ schedules = [], leases = createLeaseStore(), trigger = async () => {}, audit = () => {}, nowMs = () => Date.now() } = {}) {
  const registry = new Map(schedules.map((schedule) => {
    const valid = validateScheduleDefinition(schedule);
    return [valid.id, { ...valid, status: "active", missedRunPolicy: schedule.missedRunPolicy ?? "coalesce" }];
  }));
  async function run(id, { now = new Date().toISOString(), owner = "scheduler" } = {}) {
    const schedule = registry.get(id);
    if (!schedule) throw new Error(`Unknown schedule: ${id}`);
    const lease = leases.acquire(schedule.lease, { owner });
    if (!lease.acquired) {
      audit({ action: "scheduler.skipped", schedule: id, reason: "LEASE_HELD" });
      return { status: "skipped", reason: "LEASE_HELD" };
    }
    if (schedule.status !== "active") return { status: "skipped", reason: "SCHEDULE_PAUSED" };
    const runId = `${id}:${now}`;
    try {
      const result = await trigger(schedule.targetWorkflow, { schedule, runId, now });
      audit({ action: "scheduler.triggered", schedule: id, runId });
      return { status: "triggered", runId, result };
    } finally {
      lease.release();
    }
  }
  function pause(id, reason = "operator") {
    const schedule = registry.get(id);
    if (!schedule) throw new Error(`Unknown schedule: ${id}`);
    registry.set(id, { ...schedule, status: "paused", pausedAt: new Date(nowMs()).toISOString(), pauseReason: reason });
    audit({ action: "scheduler.paused", schedule: id, reason });
    return registry.get(id);
  }
  function resume(id) {
    const schedule = registry.get(id);
    if (!schedule) throw new Error(`Unknown schedule: ${id}`);
    registry.set(id, { ...schedule, status: "active", resumedAt: new Date(nowMs()).toISOString() });
    audit({ action: "scheduler.resumed", schedule: id });
    return registry.get(id);
  }
  return Object.freeze({ schedules: () => [...registry.values()], run, pause, resume });
}