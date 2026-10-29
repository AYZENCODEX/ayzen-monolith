import { createEventEnvelope } from "@ayzen/events";

/**
 * Phase H11.2 — Season 2 finding #14: `workflow.stalled` is a registered
 * event type (`packages/events/src/index.mjs`) with no publisher anywhere.
 * `store.listActiveInstances()` (see ./store.mjs) enumerates every
 * non-terminal run; this is the poller that turns a run whose `updatedAt`
 * hasn't moved in longer than `thresholdMs` into that missing event.
 *
 * Alert state is tracked per run id, mirroring ../../event-client's
 * consumer-lag monitor: a run stuck at the same stale `updatedAt` doesn't
 * republish `workflow.stalled` on every poll (that would just be noise
 * once the first alert has fired), but a run that makes progress again
 * (its `updatedAt` moves forward) clears the alert, and a later re-stall
 * alerts a second time. A run that disappears from `listActiveInstances`
 * between polls — it finished, one way or another — also clears its
 * alert state, since there's nothing left to keep flagging.
 */
export function createStalledWorkflowMonitor({
  store,
  publish,
  thresholdMs = Number(process.env.WORKFLOW_STALL_THRESHOLD_MS ?? 5 * 60_000),
  now = () => Date.now(),
  log = (fields) => console.log(JSON.stringify({ timestamp: new Date().toISOString(), ...fields })),
} = {}) {
  if (!store || typeof store.listActiveInstances !== "function") throw new Error("A store with listActiveInstances() is required");
  if (typeof publish !== "function") throw new Error("A publish function is required");
  const alerted = new Set();

  /** One pass over every active run. A run whose `updatedAt` can't be
   * parsed is skipped rather than treated as infinitely stale or
   * aborting the whole pass. */
  async function checkOnce() {
    const runs = await store.listActiveInstances();
    const seen = new Set();
    const stalled = [];
    const nowMs = now();
    for (const run of runs) {
      const runId = run.id;
      seen.add(runId);
      const updatedAtMs = Date.parse(run.updatedAt);
      if (Number.isNaN(updatedAtMs)) continue;
      const staleForMs = nowMs - updatedAtMs;
      if (staleForMs < thresholdMs) {
        alerted.delete(runId);
        continue;
      }
      stalled.push(run);
      if (alerted.has(runId)) continue;
      alerted.add(runId);
      const envelope = createEventEnvelope({
        eventType: "workflow.stalled",
        payload: {
          executionId: runId,
          workflowId: run.definitionId,
          currentStepId: run.currentStepId ?? null,
          status: run.status,
          staleForMs,
          threshold: thresholdMs,
          detectedAt: new Date(nowMs).toISOString(),
        },
      });
      try {
        await publish(envelope);
      } catch (error) {
        // Publishing the alert failed; don't let that also suppress the
        // next poll's attempt to re-alert (the run isn't any less stalled
        // just because we couldn't say so).
        alerted.delete(runId);
        log({ level: "error", event: "workflow.stalled.publish.error", execution_id: runId, error: String(error?.message ?? error) });
      }
    }
    // A run no longer active (completed/failed/cancelled/etc. between
    // polls, so it dropped out of listActiveInstances) can't keep being
    // stalled; forget it so a future run reusing patterns doesn't inherit
    // stale alert state.
    for (const runId of alerted) if (!seen.has(runId)) alerted.delete(runId);
    return stalled;
  }

  return Object.freeze({
    checkOnce,
    isAlerted: (runId) => alerted.has(runId),
    /** Runs `checkOnce` on an interval; returns a stopper. Errors inside a
     * single pass are already handled by `checkOnce` itself, so the
     * interval keeps running rather than the process crashing on an
     * unhandled rejection from one bad poll. */
    start(intervalMs = Number(process.env.WORKFLOW_STALL_CHECK_INTERVAL_MS ?? 30_000)) {
      const timer = setInterval(() => {
        checkOnce().catch((error) => log({ level: "error", event: "workflow.stalled.monitor.error", error: String(error?.message ?? error) }));
      }, intervalMs);
      timer.unref?.();
      return () => clearInterval(timer);
    },
  });
}
