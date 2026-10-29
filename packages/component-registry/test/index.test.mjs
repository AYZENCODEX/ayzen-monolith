import test from "node:test";
import assert from "node:assert/strict";
import { createComponentCatalog, validateComponentDefinition } from "../src/index.mjs";

const component = (overrides = {}) => ({
  id: "service:api-gateway",
  kind: "service",
  owner: "platform",
  app: "ayzen",
  environment: "production",
  lifecycle: "ACTIVE",
  source: { registry: "infrastructure/platform/service-registry.json", originalId: "api-gateway" },
  ...overrides,
});

test("validateComponentDefinition requires id, kind, owner, app, environment and lifecycle", () => {
  const valid = validateComponentDefinition(component());
  assert.equal(valid.id, "service:api-gateway");
  assert.equal(valid.app, "ayzen");

  assert.throws(() => validateComponentDefinition(component({ owner: undefined })), /owner/i);
  assert.throws(() => validateComponentDefinition(component({ kind: "not-a-kind" })), /invalid component kind/);
  assert.throws(() => validateComponentDefinition(component({ environment: "prod" })), /invalid component environment/);
  assert.throws(() => validateComponentDefinition(component({ lifecycle: "RUNNING" })), /invalid component lifecycle/);
  assert.throws(() => validateComponentDefinition(component({ source: {} })), /source registry/i);
});

test("validateComponentDefinition defaults app to owner when app is absent", () => {
  const valid = validateComponentDefinition(component({ app: undefined, owner: "ryft" }));
  assert.equal(valid.app, "ryft");
});

test("createComponentCatalog registers, resolves and lists components", () => {
  const catalog = createComponentCatalog({ components: [component()] });
  assert.equal(catalog.list().length, 1);
  assert.equal(catalog.resolve("service:api-gateway").owner, "platform");
  assert.throws(() => catalog.resolve("service:missing"), /Unknown component/);
});

test("createComponentCatalog rejects duplicate ids (duplicate-id gate)", () => {
  const catalog = createComponentCatalog({ components: [component()] });
  assert.throws(() => catalog.register(component()), /Duplicate component id/);
});

test("createComponentCatalog rejects components missing an owner (owner-required gate)", () => {
  const catalog = createComponentCatalog({});
  assert.throws(() => catalog.register(component({ owner: undefined, app: undefined })), /owner/i);
});

test("byKind, byApp, byOwner and bySourceRegistry filter correctly", () => {
  const catalog = createComponentCatalog({
    components: [
      component(),
      component({ id: "workflow:deployment-promotion", kind: "workflow", owner: "platform", app: "ayzen", source: { registry: "infrastructure/platform/workflow-registry.json", originalId: "deployment-promotion" } }),
      component({ id: "service:finance", kind: "service", owner: "ryft", app: "ryft", source: { registry: "infrastructure/platform/service-registry.json", originalId: "finance" } }),
    ],
  });
  assert.equal(catalog.byKind("service").length, 2);
  assert.equal(catalog.byKind("workflow").length, 1);
  assert.equal(catalog.byApp("ayzen").length, 2);
  assert.equal(catalog.byOwner("ryft").length, 1);
  assert.equal(catalog.bySourceRegistry("infrastructure/platform/workflow-registry.json").length, 1);
});

test("findings reports source registries that contributed zero components", () => {
  const catalog = createComponentCatalog({
    components: [component()],
    expectedSources: ["infrastructure/platform/service-registry.json", "infrastructure/platform/workflow-registry.json"],
  });
  const findings = catalog.findings();
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, "SOURCE_REGISTRY_NOT_REPRESENTED");
  assert.equal(findings[0].registry, "infrastructure/platform/workflow-registry.json");
  assert.equal(catalog.status(), "BLOCKED");
});

test("findings reports quarantined components as a warning, not a block", () => {
  const catalog = createComponentCatalog({
    components: [component({ id: "service:legacy", lifecycle: "QUARANTINED" })],
  });
  const findings = catalog.findings();
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "warning");
  assert.equal(catalog.status(), "READY");
});

test("completeness reports coverage ratio and per-kind counts", () => {
  const catalog = createComponentCatalog({
    components: [component(), component({ id: "workflow:x", kind: "workflow", source: { registry: "infrastructure/platform/workflow-registry.json", originalId: "x" } })],
    expectedSources: ["infrastructure/platform/service-registry.json", "infrastructure/platform/workflow-registry.json"],
  });
  const report = catalog.completeness();
  assert.equal(report.totalComponents, 2);
  assert.equal(report.representedSourceRegistries, 2);
  assert.equal(report.ratio, 1);
  assert.equal(report.byKind.service, 1);
  assert.equal(report.byKind.workflow, 1);
});
