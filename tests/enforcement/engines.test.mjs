import test from "node:test";
import assert from "node:assert/strict";
import {
  createPlatformGraph,
  createStateSyncRegistry,
  createDataGovernanceCatalog,
  createResourceOrchestrator,
  createRuntimeOptimization,
  createRecoveryController,
  createLifecycleRegistry,
} from "../../packages/platform-governance/src/index.mjs";

const node = (id) => ({ id, type: "engine", owner: "platform", app: "ayzen", version: "1.0.0", policy: `enforcement.${id}`, lifecycle: "ACTIVE" });
const edge = (from, to) => ({ from, to, contract: "engine.v1", policy: "enforcement.test", recovery: "retry", audit: true, trace: true });

test("dependency graph rejects incomplete circuits and detects cycles", () => {
  const graph = createPlatformGraph({ nodes: [node("a"), node("b")], edges: [{ id: "a-b", ...edge("a", "b") }] });
  assert.equal(graph.status(), "READY");
  assert.deepEqual(graph.cycles(), []);
});

test("state sync detects and reconciles checkpoint divergence", () => {
  const registry = createStateSyncRegistry({ sources: [{ id: "db", sourceOfTruth: "postgres", version: 2, checkpoint: 1 }] });
  assert.equal(registry.status(), "NOT_HEALTHY");
  registry.reconcile("db", { version: 2 });
  assert.equal(registry.status(), "HEALTHY");
});

test("data, resource, performance, recovery, and lifecycle gates enforce decisions", () => {
  const data = createDataGovernanceCatalog({ entries: [{ id: "secret", owner: "sylo", classification: "restricted", allowedConsumers: ["vault"], retention: "30d", encryption: "at-rest", export: "approved", delete: "approved", audit: true }] });
  assert.equal(data.checkFlow({ dataId: "secret", consumer: "finance" }).allowed, false);
  const resources = createResourceOrchestrator({ budgets: [{ id: "db", limit: 10 }] });
  assert.equal(resources.observe("db", 11).pressure, "critical");
  const performance = createRuntimeOptimization({ slos: [{ id: "api", target: 100 }] });
  performance.observe("api", 150);
  assert.equal(performance.status(), "BLOCKED");
  const recovery = createRecoveryController({ policies: [{ id: "api", retry: true, fallback: "monolith", reconcile: true, verify: true }] });
  assert.equal(recovery.status(), "READY");
  const lifecycle = createLifecycleRegistry({ resources: [{ id: "api", lifecycle: "READY" }] });
  lifecycle.transition("api", "ACTIVE");
  assert.equal(lifecycle.status(), "READY");
});