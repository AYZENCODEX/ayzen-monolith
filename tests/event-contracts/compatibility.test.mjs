import test from "node:test";
import assert from "node:assert/strict";
import { checkEventCompatibility } from "../../services/event-operations/src/index.mjs";

test("event compatibility rejects removed required fields", () => {
  const producer = { eventType: "finance.transaction.created", version: 2, fields: { id: { required: true } } };
  const consumer = { eventType: "finance.transaction.created", version: 1, fields: { id: { required: true }, amount: { required: true } } };
  assert.equal(checkEventCompatibility(producer, consumer).compatible, false);
});