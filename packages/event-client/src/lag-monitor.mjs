import { createEventEnvelope } from "@ayzen/events";

/**
 * Phase H11.2 — Season 2 finding #14: `event.consumer.lag` is a registered
 * event type (`packages/events/src/index.mjs`) with no publisher anywhere.
 * `createRedisEventBus`'s `consumerLag(eventType)` (see index.mjs) turns
 * `XPENDING` into a per-type backlog reading; this is the poller that
 * turns a backlog crossing a threshold into that missing event.
 *
 * Alert state is tracked per event type so a consumer stuck at a steady
 * backlog doesn't republish `event.consumer.lag` on every poll (that would
 * just be noise once the first alert has fired), but also so a backlog
 * that drains back under the threshold and later grows again *does* alert
 * a second time — `alerted` is cleared the moment a type reports back
 * under threshold, not left permanently set after the first firing.
 */
export function createConsumerLagMonitor({
  bus,
  eventTypes,
  publish = (envelope) => bus.publish(envelope),
  threshold = Number(process.env.EVENT_BUS_LAG_THRESHOLD ?? 100),
  now = () => new Date().toISOString(),
  log = (fields) => console.log(JSON.stringify({ timestamp: new Date().toISOString(), ...fields })),
} = {}) {
  if (!bus || typeof bus.consumerLag !== "function") throw new Error("A bus with consumerLag(eventType) is required");
  if (!Array.isArray(eventTypes) || eventTypes.length === 0) throw new Error("eventTypes is required");
  if (typeof publish !== "function") throw new Error("A publish function is required");
  const alerted = new Set();

  /** One pass over every watched event type. Errors reading one type's
   * lag (e.g. a transient Redis blip) are logged and skipped rather than
   * aborting the whole pass — one unreachable stream shouldn't blind the
   * monitor to every other type's genuine backlog. */
  async function checkOnce() {
    const readings = [];
    for (const eventType of eventTypes) {
      let lag;
      try {
        lag = await bus.consumerLag(eventType);
      } catch (error) {
        log({ level: "error", event: "event.consumer.lag.check.error", event_type: eventType, error: String(error?.message ?? error) });
        continue;
      }
      const pending = lag.pending ?? 0;
      readings.push({ eventType, pending, bus: lag.bus, consumerGroup: lag.consumerGroup });
      if (pending < threshold) {
        alerted.delete(eventType);
        continue;
      }
      if (alerted.has(eventType)) continue;
      alerted.add(eventType);
      const envelope = createEventEnvelope({
        eventType: "event.consumer.lag",
        payload: {
          laggingEventType: eventType,
          bus: lag.bus,
          consumerGroup: lag.consumerGroup,
          pending,
          threshold,
          detectedAt: now(),
        },
      });
      try {
        await publish(envelope);
      } catch (error) {
        // Publishing the alert failed; don't let that also suppress the
        // next poll's attempt to re-alert (the actual backlog didn't go
        // away just because we couldn't say so).
        alerted.delete(eventType);
        log({ level: "error", event: "event.consumer.lag.publish.error", event_type: eventType, error: String(error?.message ?? error) });
      }
    }
    return readings;
  }

  return Object.freeze({
    checkOnce,
    isAlerted: (eventType) => alerted.has(eventType),
    /** Runs `checkOnce` on an interval; returns a stopper. Errors inside a
     * single pass are already handled by `checkOnce` itself, so the
     * interval keeps running rather than the process crashing on an
     * unhandled rejection from one bad poll. */
    start(intervalMs = Number(process.env.EVENT_BUS_LAG_CHECK_INTERVAL_MS ?? 30_000)) {
      const timer = setInterval(() => {
        checkOnce().catch((error) => log({ level: "error", event: "event.consumer.lag.monitor.error", error: String(error?.message ?? error) }));
      }, intervalMs);
      timer.unref?.();
      return () => clearInterval(timer);
    },
  });
}
