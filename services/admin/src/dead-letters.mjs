/**
 * Phase H11.1 — Season 2 finding #13: `event-client`'s `replayDeadLetter`
 * (and `deadLetters`) are fully implemented on `createRedisEventBus` but
 * were called from nowhere — not `admin`, not a script. Operators had no
 * way to actually see or replay a dead-lettered event.
 *
 * This is the route logic behind `GET /api/admin/events/dead-letters` and
 * `POST /api/admin/events/dead-letters/replay`, factored out of
 * `src/index.mjs` the same way `services/search/src/event-handlers.mjs`
 * factors its event handlers out of that service's `index.mjs` — so it
 * can be unit-tested against a fake bus instead of a live Redis broker
 * (see `dead-letters.test.mjs`), and so `index.mjs` stays a thin route
 * table.
 *
 * Deliberately conservative about the bulk case: replaying *every*
 * dead-lettered event with a single unscoped call is exactly the kind of
 * action this repo's own precedent (`admin.break-glass`, `admin/data/mutate`)
 * gates behind an explicit confirmation, not just the right scope — an
 * operator who fat-fingers a POST with no body should not accidentally
 * replay the entire dead-letter queue. `eventId` alone needs no such
 * confirmation: it can only ever replay the event(s) that specific ID
 * names.
 */
export function summarizeDeadLetters(entries = []) {
  return entries.map((entry) => ({
    eventId: entry.eventId,
    eventType: entry.eventType,
    consumer: entry.consumer,
    attempts: entry.attempts,
    error: entry.error,
    // The envelope's payload already went through H10.2's redaction at
    // publish time (including on every retry-republish), so it is safe
    // to surface here as-is — nothing further to strip.
    occurredAt: entry.envelope?.occurredAt,
    organizationId: entry.envelope?.organizationId,
    workspaceId: entry.envelope?.workspaceId,
  }));
}

export function createDeadLetterOperations({ getBus }) {
  if (typeof getBus !== "function") throw new Error("getBus is required");

  async function requireBus() {
    const bus = await getBus();
    if (!bus) {
      const error = new Error("The event bus is not configured (EVENT_BUS_REDIS_URL is unset)");
      error.code = "EVENT_BUS_NOT_CONFIGURED";
      throw error;
    }
    return bus;
  }

  return Object.freeze({
    async list({ eventType } = {}) {
      const bus = await requireBus();
      const entries = await bus.deadLetters();
      const filtered = eventType ? entries.filter((entry) => entry.eventType === eventType) : entries;
      return summarizeDeadLetters(filtered);
    },

    /**
     * `eventId` replays just that event (or every dead-lettered entry
     * sharing it, if it was retried under more than one consumer).
     * `all: true` is required to replay the whole queue with no filter —
     * the confirmation step `index.mjs` enforces before calling this.
     */
    async replay({ eventId, all = false } = {}) {
      if (!eventId && !all) {
        const error = new Error("Either eventId or all:true is required to replay dead letters");
        error.code = "DEAD_LETTER_REPLAY_TARGET_REQUIRED";
        throw error;
      }
      const bus = await requireBus();
      const replayed = await bus.replayDeadLetter(eventId ? { eventId } : {});
      return summarizeDeadLetters(replayed);
    },
  });
}
