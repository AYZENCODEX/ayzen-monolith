import test from "node:test";
import assert from "node:assert/strict";
import { createOutboxInbox } from "../src/index.mjs";

test("supports publish acknowledgement, retry, dead-letter, and inbox deduplication", () => {
  const store = createOutboxInbox({ maxAttempts: 1 });
  const record = store.append({ aggregateId: "order:1", event: { type: "order.created" } });
  assert.equal(store.claim(1)[0].id, record.id);
  store.fail(record.id, "downstream unavailable");
  assert.equal(store.deadLetters().length, 1);
  assert.equal(store.consumeOnce("event-1"), true);
  assert.equal(store.consumeOnce("event-1"), false);
});