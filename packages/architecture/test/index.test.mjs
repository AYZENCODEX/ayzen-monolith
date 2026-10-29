import test from "node:test";
import assert from "node:assert/strict";
import {
  createArchitectureRegistry,
  createFeatureCompletenessReport,
  diffArchitectureSnapshots,
  createArchitectureLoop,
  createStraGraphRegistry,
  createStraHealthScorecard,
} from "../src/index.mjs";

function fixture() {
  return createArchitectureRegistry({
    components: [
      { id: "service-a", owner: "platform", type: "service" },
      { id: "audit", owner: "platform", type: "platform" },
      { id: "api-server", owner: "platform", type: "api-server" },
      { id: "artifact", owner: "platform", type: "artifact" },
    ],
    domains: [{ id: "domain-a", owner: "platform", type: "domain" }],
    features: [{
      id: "feature-a",
      owner: "platform",
      circuit: {
        domain: "domain-a",
        feature: "feature-a",
        "api-server": "api-server",
        service: "service-a",
        artifact: "artifact",
        audit: "audit",
      },
      optionalStages: [
        "dns-edge", "frontend", "page-route", "ui-module", "component",
        "sub-feature", "function", "sub-function", "module", "api-client",
        "api", "deployment", "db-resource", "eventbus", "workflow",
        "intelligence", "admin-telegram",
      ],
    }],
  });
}

test("traces a complete circuit and scores it", () => {
  const registry = fixture();
  const report = createFeatureCompletenessReport(registry, "feature-a");
  assert.equal(report.status, "COMPLETE");
  assert.equal(report.score, 100);
});

test("finds snapshot changes", () => {
  const registry = fixture();
  const before = registry.snapshot();
  const after = { ...before, components: [...before.components, { id: "service-b", owner: "platform", type: "service" }] };
  assert.deepEqual(diffArchitectureSnapshots(before, after).components.added, ["service-b"]);
});

test("keeps architecture recommendations approval-controlled", () => {
  const loop = createArchitectureLoop(fixture());
  const recommendation = loop.propose({ title: "Review a change", reason: "Evidence is required before applying changes." });
  assert.equal(recommendation.status, "awaiting_approval");
  assert.throws(() => loop.approve(recommendation.id), /Approver is required/);
  assert.equal(loop.approve(recommendation.id, { approver: "operator" }).status, "approved");
});

test("traces independent STRA local circuits and compares runtime paths", () => {
  const registry = createStraGraphRegistry({
    nodes: [
      { id: "domain", stage: "domain", kind: "domain", owner: "platform" },
      { id: "app", stage: "app", kind: "app", owner: "platform" },
      { id: "feature", stage: "feature", kind: "feature", owner: "platform" },
    ],
    edges: [
      { id: "contains-domain-app", from: "domain", to: "app", type: "contains" },
      { id: "contains-app-feature", from: "app", to: "feature", type: "contains" },
    ],
    localCircuits: [
      { id: "feature-a-circuit", owner: "platform", nodeIds: ["domain", "app", "feature"] },
      { id: "feature-b-circuit", owner: "platform", nodeIds: ["domain", "app", "feature"] },
    ],
  });
  assert.equal(registry.traceLocalCircuit("feature-a-circuit").status, "COMPLETE");
  assert.equal(registry.compareRuntimePath("feature-a-circuit", ["domain", "app", "feature"]).matches, true);
  assert.equal(createStraHealthScorecard(registry).circuitScore, 100);
});

test("rejects invalid STRA edge types and reports impact", () => {
  assert.throws(() => createStraGraphRegistry({
    nodes: [
      { id: "a", stage: "domain", kind: "domain", owner: "platform" },
      { id: "b", stage: "app", kind: "app", owner: "platform" },
    ],
    edges: [{ id: "bad", from: "a", to: "b", type: "arbitrary" }],
    localCircuits: [{ id: "circuit", owner: "platform", nodeIds: ["a", "b"] }],
  }), /Unknown STRA edge type/);

  const registry = createStraGraphRegistry({
    nodes: [
      { id: "service", stage: "service", kind: "service", owner: "platform" },
      { id: "db", stage: "db-resource", kind: "db-resource", owner: "platform" },
    ],
    edges: [{ id: "persist", from: "service", to: "db", type: "persists-to" }],
    localCircuits: [{ id: "circuit", owner: "platform", nodeIds: ["service", "db"] }],
  });
  assert.deepEqual(registry.findImpacted(["db"]).map((node) => node.id), ["db", "service"]);
});