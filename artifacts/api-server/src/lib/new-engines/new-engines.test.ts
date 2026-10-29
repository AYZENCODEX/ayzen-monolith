import assert from "node:assert/strict";
import test from "node:test";
import {
  ConsentEngine,
  DataLineageEngine,
  DecisionIntelligenceEngine,
  DependencyGraphEngine,
  DependencyResolutionEngine,
  DigitalTwinEngine,
  GeoIntelligenceEngine,
  ImpactAnalysisEngine,
  InMemoryNewEngineStore,
  KnowledgeGraphEngine,
  OptimizationEngine,
  ProvenanceEngine,
  RemediationEngine,
  SchemaRegistryEngine,
  SearchIndexEngine,
  TimeSeriesEngine,
  type SearchDocument,
} from "./index";
import { AdvancedEngineStore } from "./advanced-store";

test("N1 indexes idempotently, ranks, filters permissions, and resumes rebuilds", () => {
  const store = new InMemoryNewEngineStore();
  const engine = new SearchIndexEngine(store);
  const document: SearchDocument = { indexName: "docs", entityType: "article", entityId: "1", title: "Access policy", text: "policy authorization", permissions: ["user:7"] };
  const first = engine.index(document);
  assert.equal(engine.index(document).indexedAt, first.indexedAt);
  assert.equal(engine.search({ indexName: "docs", query: "policy", canRead: (item) => item.permissions?.includes("user:7") }).total, 1);
  assert.equal(engine.search({ indexName: "docs", query: "policy", canRead: () => false }).total, 0);
  const job = engine.startRebuild("docs", [document, { ...document, entityId: "2" }], 2);
  assert.equal(engine.resumeRebuild(job.id, 1).status, "RUNNING");
  assert.equal(engine.resumeRebuild(job.id, 1).status, "COMPLETED");
});

test("N2 graph updates are idempotent and authorization-aware", () => {
  const store = new InMemoryNewEngineStore();
  const engine = new KnowledgeGraphEngine(store);
  engine.upsertNode({ id: "a", entityType: "user", sourceRefs: ["audit:1"], version: 1 });
  engine.upsertNode({ id: "b", entityType: "service", sourceRefs: ["audit:2"], version: 1, properties: { private: true, ownerId: 7 } });
  const edge = engine.upsertEdge({ from: "a", to: "b", relationship: "owns", sourceRefs: ["audit:3"], version: 1 });
  assert.equal(engine.upsertEdge({ ...edge, version: 0 }).version, 1);
  assert.equal(engine.traverse("a", { canRead: (node) => node.id !== "b" }).nodes.length, 1);
  assert.equal(engine.traverse("a", { canRead: (node) => node.id === "a" || node.properties?.ownerId === 7 }).edges.length, 1);
});

test("N3 validates explicit schema versions and detects breaking changes", () => {
  const engine = new SchemaRegistryEngine(new InMemoryNewEngineStore());
  engine.register({ name: "event", version: 1, fields: { id: { type: "string", required: true }, count: { type: "integer" } } });
  const result = engine.register({ name: "event", version: 2, fields: { id: { type: "number", required: true } } });
  assert.equal(result.compatibility.compatible, false);
  assert.throws(() => engine.validate("event", { id: "ok" }, 2));
});

test("N4 lineage is queryable and N5 provenance detects tampering", () => {
  const store = new InMemoryNewEngineStore();
  const lineage = new DataLineageEngine(store);
  lineage.record({ source: { type: "raw", id: "a" }, destination: { type: "model", id: "b" } });
  lineage.record({ source: { type: "model", id: "b" }, destination: { type: "report", id: "c" } });
  assert.equal(lineage.impact("c").sources.length, 2);
  const provenance = new ProvenanceEngine(store);
  const record = provenance.append({ subject: { type: "report", id: "c" }, action: "publish", evidence: { lineage: true } });
  assert.equal(provenance.verify({ type: "report", id: "c" }).valid, true);
  store.provenance.set(record.id, { ...record, hash: "tampered" });
  assert.equal(provenance.verify({ type: "report", id: "c" }).valid, false);
});

test("N6 supports historical queries, aggregation, and retention", () => {
  const engine = new TimeSeriesEngine(new InMemoryNewEngineStore());
  engine.append({ id: "old", series: "latency", timestamp: "2020-01-01T00:00:00.000Z", value: 10 });
  engine.append({ id: "new", series: "latency", timestamp: "2020-01-01T00:00:01.000Z", value: 20 });
  assert.equal(engine.aggregate({ series: "latency", from: "2020-01-01T00:00:00.000Z", bucketMs: 2000 }).at(0)?.average, 15);
  assert.equal(engine.applyRetention("latency", 500, new Date("2020-01-01T00:00:01.000Z").getTime()), 1);
});

test("N7 versions, grants, withdrawal, expiry, and scope checks are auditable", () => {
  const engine = new ConsentEngine(new InMemoryNewEngineStore());
  engine.registerVersion({ consentType: "analytics", version: 1, purpose: "Product analytics", requiredScopes: ["events"] });
  const grant = engine.grant({ subjectId: "u1", consentType: "analytics", version: 1, scopes: ["events"], expiresAt: "2030-01-01T00:00:00.000Z" });
  assert.equal(engine.check("u1", "analytics", ["events"]).granted, true);
  assert.equal(engine.check("u1", "analytics", ["billing"]).reason, "SCOPE_MISSING");
  engine.withdraw(grant.id);
  assert.equal(engine.check("u1", "analytics").reason, "WITHDRAWN");
  assert.equal(engine.history("u1").length, 1);
});

test("N8-N15 provide geo, dependency, twin, remediation, impact, optimization, and decisions", async () => {
  const geoStore = new AdvancedEngineStore();
  const geo = new GeoIntelligenceEngine(geoStore);
  geo.registerRegion({ id: "region", name: "Region", polygon: [{ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 2 }, { latitude: 2, longitude: 0 }] });
  assert.deepEqual(geo.evaluate("u1", { latitude: 0.5, longitude: 0.5 }).regionIds, ["region"]);

  const graph = new DependencyGraphEngine(geoStore);
  graph.upsertNode({ id: "source", entityType: "service", sourceRefs: [], version: 1, updatedAt: new Date().toISOString() });
  graph.upsertNode({ id: "target", entityType: "workflow", sourceRefs: [], version: 1, updatedAt: new Date().toISOString() });
  graph.upsertEdge({ id: "edge", from: "source", to: "target", relationship: "requires", sourceRefs: [], version: 1, updatedAt: new Date().toISOString() });
  const plan = new DependencyResolutionEngine(graph, geoStore).plan(["target"]);
  assert.deepEqual(plan.orderedNodes, ["source", "target"]);
  assert.equal(new ImpactAnalysisEngine(graph, geoStore).analyze({ id: "change", nodeIds: ["source"] }).transitive[0], "target");

  const twin = new DigitalTwinEngine(geoStore);
  twin.append({ id: "event-1", aggregateType: "job", aggregateId: "1", type: "started", version: 1, payload: { status: "running" }, occurredAt: new Date().toISOString() });
  assert.equal(twin.project("job", "1", (state, event) => ({ ...state, ...event.payload })).state.status, "running");

  const remediation = new RemediationEngine(geoStore);
  remediation.registerAction({ id: "restart", name: "Restart", risk: "HIGH", execute: () => ({ restarted: true }) });
  remediation.registerPolicy({ id: "approved-restart", actionId: "restart", approved: true, requiresApproval: true, maxExecutions: 1, windowMs: 60_000 });
  assert.equal((await remediation.execute("approved-restart", {}, { dryRun: true })).status, "DRY_RUN");
  assert.equal((await remediation.execute("approved-restart", {}, { approved: false })).status, "PENDING_APPROVAL");
  assert.equal((await remediation.execute("approved-restart", {}, { approved: true })).status, "COMPLETED");

  const optimization = new OptimizationEngine(geoStore);
  const optimized = optimization.optimize({ candidates: [{ id: "a", plan: {}, metrics: { cost: 10 }, violations: [] }, { id: "b", plan: {}, metrics: { cost: 5 }, violations: [] }], objectives: [{ name: "cost", direction: "minimize", weight: 1 }] });
  assert.equal(optimized.selected?.id, "b");
  const decision = new DecisionIntelligenceEngine(geoStore).decide({ context: { change: "c" }, evidence: [{ id: "e", source: "rule", value: "allow", weight: 1 }], outcomes: ["allow", "deny"], authorizationRequired: true });
  assert.equal(decision.outcome, "allow");
  assert.equal(decision.authorizationRequired, true);
});