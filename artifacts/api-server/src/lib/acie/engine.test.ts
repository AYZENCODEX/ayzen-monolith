import assert from "node:assert/strict";
import test from "node:test";
import { AcieEngine } from "./engine";

const context = { tenantId: "tenant:test", traceId: "trace:test" };

test("ACIE produces observation, anomaly, forecast, and maintenance intelligence", () => {
  const engine = new AcieEngine();
  const results = engine.analyze({
    context,
    observations: [
      { subjectId: "worker-1", metric: "latency", value: 10, occurredAt: "2026-01-01T00:00:00.000Z" },
      { subjectId: "worker-1", metric: "latency", value: 12, occurredAt: "2026-01-01T00:01:00.000Z" },
      { subjectId: "worker-1", metric: "latency", value: 80, occurredAt: "2026-01-01T00:02:00.000Z" },
    ],
  });
  assert.ok(results.some((result) => result.type === "ANOMALY"));
  assert.ok(results.some((result) => result.type === "FORECAST"));
  assert.ok(results.some((result) => result.type === "MAINTENANCE"));
  assert.ok(results.every((result) => result.policyContext.authorized === false));
});

test("ACIE isolates tenants and deduplicates event ingestion", () => {
  const engine = new AcieEngine();
  const event = {
    id: "event-1",
    type: "task.failed",
    version: 1,
    occurredAt: "2026-01-01T00:00:00.000Z",
    actor: { organizationId: 42 },
    traceId: "trace:event",
    payload: { subjectId: "task-1", value: 1 },
  };
  assert.ok(engine.ingest(event).length > 0);
  assert.equal(engine.ingest(event).length, 0);
  assert.ok(engine.listResults("tenant:42").length > 0);
  assert.equal(engine.listResults("tenant:other").length, 0);
});

test("closed loop records a pending decision without executing it", () => {
  const engine = new AcieEngine();
  const loop = engine.closeLoop({
    context,
    observations: [{ subjectId: "queue-1", metric: "depth", value: 10 }],
    decision: { decision: "investigate", action: "open-incident", expectedOutcome: "queue returns to baseline" },
  });
  assert.equal(loop.nextStep, "POLICY_SIORA_VALIDATION");
  assert.equal(loop.decision?.outcomeStatus, "PENDING");
  assert.ok(loop.recommendations.length > 0);
});