import test from "node:test";
import assert from "node:assert/strict";
import { createDeadLetterOperations, summarizeDeadLetters } from "./dead-letters.mjs";

function fakeBus(entries) {
  const replayed = [];
  return {
    calls: { deadLetters: 0, replayDeadLetter: [] },
    async deadLetters() {
      this.calls.deadLetters += 1;
      return entries;
    },
    async replayDeadLetter({ eventId } = {}) {
      this.calls.replayDeadLetter.push(eventId);
      const matches = entries.filter((entry) => !eventId || entry.eventId === eventId);
      replayed.push(...matches);
      return matches;
    },
  };
}

const SAMPLE = [
  { eventId: "evt-1", eventType: "finance.transaction.created", consumer: "notification", attempts: 5, error: "boom", envelope: { occurredAt: "2026-01-01T00:00:00.000Z", organizationId: "org-1" } },
  { eventId: "evt-2", eventType: "wisp.message.sent", consumer: "search", attempts: 5, error: "timeout", envelope: { occurredAt: "2026-01-02T00:00:00.000Z" } },
];

test("H11.1: list() returns every dead letter, summarized, when no filter is given", async () => {
  const bus = fakeBus(SAMPLE);
  const ops = createDeadLetterOperations({ getBus: () => bus });
  const items = await ops.list();
  assert.equal(items.length, 2);
  assert.equal(items[0].eventId, "evt-1");
  assert.equal(items[0].organizationId, "org-1");
  assert.equal(bus.calls.deadLetters, 1);
});

test("H11.1: list({ eventType }) filters to just that event type", async () => {
  const bus = fakeBus(SAMPLE);
  const ops = createDeadLetterOperations({ getBus: () => bus });
  const items = await ops.list({ eventType: "wisp.message.sent" });
  assert.equal(items.length, 1);
  assert.equal(items[0].eventId, "evt-2");
});

test("H11.1: replay({ eventId }) replays only the matching entry", async () => {
  const bus = fakeBus(SAMPLE);
  const ops = createDeadLetterOperations({ getBus: () => bus });
  const replayed = await ops.replay({ eventId: "evt-1" });
  assert.equal(replayed.length, 1);
  assert.equal(replayed[0].eventId, "evt-1");
  assert.deepEqual(bus.calls.replayDeadLetter, ["evt-1"]);
});

test("H11.1: replay() with neither eventId nor all:true is rejected before touching the bus", async () => {
  const bus = fakeBus(SAMPLE);
  const ops = createDeadLetterOperations({ getBus: () => bus });
  await assert.rejects(() => ops.replay(), (error) => error.code === "DEAD_LETTER_REPLAY_TARGET_REQUIRED");
  assert.equal(bus.calls.replayDeadLetter.length, 0, "a rejected request must never reach the bus");
});

test("H11.1: replay({ all: true }) replays the entire dead-letter queue", async () => {
  const bus = fakeBus(SAMPLE);
  const ops = createDeadLetterOperations({ getBus: () => bus });
  const replayed = await ops.replay({ all: true });
  assert.equal(replayed.length, 2);
  assert.deepEqual(bus.calls.replayDeadLetter, [undefined]);
});

test("H11.1: an unconfigured event bus fails clearly instead of throwing on a missing method", async () => {
  const ops = createDeadLetterOperations({ getBus: () => undefined });
  await assert.rejects(() => ops.list(), (error) => error.code === "EVENT_BUS_NOT_CONFIGURED");
  await assert.rejects(() => ops.replay({ all: true }), (error) => error.code === "EVENT_BUS_NOT_CONFIGURED");
});

test("summarizeDeadLetters: never re-exposes the raw envelope, only a safe projection", () => {
  const [summary] = summarizeDeadLetters([{ eventId: "e1", eventType: "vault.secret.accessed", consumer: "c", attempts: 1, error: "x", envelope: { occurredAt: "t", payload: { secretId: "s1" }, someInternalField: "z" } }]);
  assert.deepEqual(Object.keys(summary).sort(), ["attempts", "consumer", "error", "eventId", "eventType", "occurredAt", "organizationId", "workspaceId"]);
});
