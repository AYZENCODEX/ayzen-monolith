import test from "node:test";
import assert from "node:assert/strict";
import { createFeatureCircuitCatalog, validateCircuitDefinition, REQUIRED_STAGES } from "../src/index.mjs";

const circuit = (overrides = {}) => ({
  id: "circuit:finance.post-transaction",
  feature: "finance.post-transaction",
  componentId: "feature:finance.post-transaction",
  api: "finance-api",
  service: "finance",
  data: "finance_transactions",
  audit: "audit-platform",
  stages: ["feature", "api", "service", "data", "audit"],
  source: { kind: "curated-feature-component", registry: "infrastructure/platform/feature-completeness.json" },
  ...overrides,
});

test("validateCircuitDefinition requires id, feature, api, service, data, audit and source", () => {
  const valid = validateCircuitDefinition(circuit());
  assert.equal(valid.id, "circuit:finance.post-transaction");
  assert.equal(valid.componentId, "feature:finance.post-transaction");

  assert.throws(() => validateCircuitDefinition(circuit({ api: undefined })), /Circuit api is required/);
  assert.throws(() => validateCircuitDefinition(circuit({ id: "not-prefixed" })), /must start with "circuit:"/);
  assert.throws(() => validateCircuitDefinition(circuit({ source: { kind: "made-up", registry: "x" } })), /invalid source kind/);
});

test("validateCircuitDefinition defaults audit to 'none' rather than leaving it unset", () => {
  const valid = validateCircuitDefinition(circuit({ audit: undefined }));
  assert.equal(valid.audit, "none");
});

test("createFeatureCircuitCatalog registers, resolves by id and by feature, and rejects duplicate ids", () => {
  const catalog = createFeatureCircuitCatalog({ circuits: [circuit()] });
  assert.equal(catalog.list().length, 1);
  assert.equal(catalog.resolve("circuit:finance.post-transaction").service, "finance");
  assert.equal(catalog.resolveByFeature("finance.post-transaction").api, "finance-api");
  assert.equal(catalog.resolveByFeature("no-such-feature"), null);
  assert.throws(() => catalog.register(circuit()), /Duplicate circuit id/);
});

test("REQUIRED_STAGES gate: a circuit missing a required stage is a critical REQUIRED_STAGE_MISSING finding (missing-edge gate)", () => {
  const incomplete = circuit({ id: "circuit:x", feature: "x", stages: ["feature", "api", "service"] }); // no data/audit stage
  const catalog = createFeatureCircuitCatalog({ circuits: [incomplete] });
  const findings = catalog.findings();
  assert.equal(findings.some((f) => f.code === "REQUIRED_STAGE_MISSING"), true);
  const finding = findings.find((f) => f.code === "REQUIRED_STAGE_MISSING");
  assert.deepEqual(finding.missingStages.sort(), ["audit", "data"]);
  assert.equal(catalog.status(), "BLOCKED");
});

test("a circuit whose stages already cover REQUIRED_STAGES has zero missing-edge findings", () => {
  const catalog = createFeatureCircuitCatalog({ circuits: [circuit()] });
  assert.equal(catalog.findings().some((f) => f.code === "REQUIRED_STAGE_MISSING"), false);
});

test("a circuit with no componentId is a warning CIRCUIT_MISSING_FEATURE_COMPONENT, not critical (status stays READY)", () => {
  const endpointDerived = circuit({ id: "circuit:identity.get.health", feature: "identity.get.health", componentId: null, source: { kind: "endpoint-registry", registry: "config/circuit/platform-circuit.json" } });
  const catalog = createFeatureCircuitCatalog({ circuits: [endpointDerived] });
  const findings = catalog.findings();
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, "CIRCUIT_MISSING_FEATURE_COMPONENT");
  assert.equal(findings[0].severity, "warning");
  assert.equal(catalog.status(), "READY");
});

test("a known Phase 01 feature component with no matching circuit is a critical FEATURE_COMPONENT_UNTRACED finding (incomplete-circuit gate)", () => {
  const catalog = createFeatureCircuitCatalog({
    circuits: [circuit()],
    knownFeatureComponentIds: ["feature:finance.post-transaction", "feature:vault.read-secret"],
  });
  const findings = catalog.findings();
  const untraced = findings.find((f) => f.code === "FEATURE_COMPONENT_UNTRACED");
  assert.ok(untraced);
  assert.equal(untraced.componentId, "feature:vault.read-secret");
  assert.equal(catalog.status(), "BLOCKED");
});

test("completeness() reports required-stage ratio and feature-component traceability ratio", () => {
  const traced = circuit();
  const untraced = circuit({ id: "circuit:identity.get.health", feature: "identity.get.health", componentId: null });
  const catalog = createFeatureCircuitCatalog({ circuits: [traced, untraced], knownFeatureComponentIds: ["feature:finance.post-transaction"] });
  const completeness = catalog.completeness();
  assert.equal(completeness.totalCircuits, 2);
  assert.equal(completeness.requiredStageComplete, 2);
  assert.equal(completeness.requiredStageRatio, 1);
  assert.equal(completeness.tracedToFeatureComponent, 1);
  assert.equal(completeness.featureComponentRatio, 0.5);
});

test("a fully clean registry (every known feature component traced, every circuit stage-complete) is READY with zero findings", () => {
  const catalog = createFeatureCircuitCatalog({ circuits: [circuit()], knownFeatureComponentIds: ["feature:finance.post-transaction"] });
  assert.deepEqual(catalog.findings(), []);
  assert.equal(catalog.status(), "READY");
});

test("REQUIRED_STAGES matches the roadmap's currently-sourceable stages", () => {
  assert.deepEqual(REQUIRED_STAGES, ["feature", "api", "service", "data", "audit"]);
});
