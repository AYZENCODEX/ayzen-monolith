import test from "node:test";
import assert from "node:assert/strict";
import { validatePlatformContract } from "../../packages/contracts/src/platform.mjs";

test("platform contracts require ownership, policy and recovery metadata", () => {
  assert.equal(validatePlatformContract("event", {
    id: "finance.transaction.created",
    producer: "finance",
    consumers: ["notification"],
    version: 1,
    delivery: "at-least-once",
    idempotencyKey: "eventId",
    securityScope: "workspace",
    failurePolicy: "retry-dlq",
    audit: true,
  }).producer, "finance");
  assert.throws(() => validatePlatformContract("schedule", { id: "bad" }), /required|invalid/);
});