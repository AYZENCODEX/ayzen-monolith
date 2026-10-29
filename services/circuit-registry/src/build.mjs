#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFeatureCircuitCatalog } from "./index.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../../../");

/**
 * Builds infrastructure/platform/feature-circuits.json (Phase 03) from the
 * two registries that already carry circuit-shaped data, without
 * duplicating either:
 *
 *  1. Phase 01's component registry "feature" kind components -- these are
 *     curated, carry the full universal-circuit metadata (domain, workflow,
 *     eventbus, admin-telegram, ...) by hand, and become
 *     source.kind = "curated-feature-component" entries.
 *  2. tools/circuit-registry/build.mjs's generated
 *     config/circuit/platform-circuit.json -- auto-derived from every
 *     registered endpoint + event, already covers Definition-of-Done-shaped
 *     stages (feature/api/service/data/route/auth/policy/audit or
 *     feature/event/consumers), and becomes source.kind =
 *     "endpoint-registry" / "event-catalog" entries.
 *
 * A feature present in both sources keeps the curated entry (richer,
 * hand-verified) and only borrows stage data the curated entry is missing.
 */
function loadJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function stagesOf(circuit) {
  const stages = [];
  if (circuit.feature) stages.push("feature");
  if (circuit.subFeature) stages.push("sub-feature");
  if (circuit.function) stages.push("function");
  if (circuit.module) stages.push("module");
  if (circuit.api) stages.push("api");
  if (circuit.service) stages.push("service");
  if (circuit.data) stages.push("data");
  if (circuit.outbox) stages.push("outbox");
  if (circuit.event) stages.push("event");
  if (circuit.workflow) stages.push("workflow");
  if (circuit.worker) stages.push("worker");
  if (circuit.scheduler) stages.push("scheduler");
  if (circuit.notification) stages.push("notification");
  if (circuit.audit) stages.push("audit"); // "none" is a valid, explicit value
  if (circuit.telemetry) stages.push("telemetry");
  if (circuit.intelligence) stages.push("intelligence");
  if (circuit.recovery) stages.push("recovery");
  if (circuit.lifecycle) stages.push("lifecycle");
  if (circuit.artifact) stages.push("artifact");
  if (circuit.deployment) stages.push("deployment");
  if (circuit.adminTelegram) stages.push("admin-telegram");
  return stages;
}

function fromCuratedFeatureComponent(component) {
  const circuitMeta = component.metadata?.circuit ?? {};
  const definition = {
    id: `circuit:${component.source.originalId}`,
    feature: circuitMeta.feature ?? component.source.originalId,
    componentId: component.id,
    domain: circuitMeta.domain,
    api: circuitMeta.api,
    service: circuitMeta.service,
    data: circuitMeta["db-resource"],
    outbox: Boolean(circuitMeta.eventbus),
    event: circuitMeta.eventbus,
    audit: circuitMeta.audit ?? "none",
    intelligence: circuitMeta.intelligence,
    artifact: circuitMeta.artifact,
    deployment: circuitMeta.deployment,
    adminTelegram: circuitMeta["admin-telegram"],
    source: { kind: "curated-feature-component", registry: component.source.registry },
  };
  definition.stages = stagesOf(definition);
  return definition;
}

function fromEndpointCircuit(circuit) {
  const definition = {
    id: `circuit:${circuit.feature}`,
    feature: circuit.feature,
    componentId: null,
    api: circuit.api,
    route: circuit.route,
    auth: circuit.auth,
    policy: circuit.policy,
    service: circuit.service,
    data: circuit.data,
    audit: circuit.audit ?? "none",
    source: { kind: circuit.event ? "event-catalog" : "endpoint-registry", registry: "config/circuit/platform-circuit.json" },
  };
  if (circuit.event) {
    definition.event = circuit.event;
    definition.outbox = true;
    definition.consumers = circuit.consumers;
  }
  definition.stages = stagesOf(definition);
  return definition;
}

function build() {
  const componentRegistry = loadJson("infrastructure/platform/component-registry.json");
  const platformCircuit = loadJson("config/circuit/platform-circuit.json");

  const featureComponents = componentRegistry.components.filter((component) => component.kind === "feature");
  const knownFeatureComponentIds = featureComponents.map((component) => component.id);

  const catalog = createFeatureCircuitCatalog({ knownFeatureComponentIds });
  const registeredFeatures = new Set();

  // Curated Phase 01 feature components take priority -- richer, hand-verified.
  for (const component of featureComponents) {
    const definition = fromCuratedFeatureComponent(component);
    catalog.register(definition);
    registeredFeatures.add(definition.feature);
  }

  // Endpoint/event-derived circuits fill in every feature not already curated.
  for (const circuit of platformCircuit.circuits ?? []) {
    if (registeredFeatures.has(circuit.feature)) continue; // already have the curated version
    catalog.register(fromEndpointCircuit(circuit));
    registeredFeatures.add(circuit.feature);
  }

  const output = {
    schemaVersion: 1,
    registryId: "feature-circuit-registry",
    generatedAt: new Date().toISOString().slice(0, 10),
    generatedBy: "services/circuit-registry/src/build.mjs",
    schema: "schemas/circuit/feature-circuit.v1.json",
    sourceRegistries: [
      "infrastructure/platform/component-registry.json (kind: feature)",
      "config/circuit/platform-circuit.json",
    ],
    requiredStages: catalog.list().length ? [...new Set(["feature", "api", "service", "data", "audit"])] : [],
    completeness: catalog.completeness(),
    findings: catalog.findings(),
    circuits: catalog.list(),
  };

  const outputPath = path.join(root, "infrastructure/platform/feature-circuits.json");
  if (process.argv.includes("--check")) {
    const committed = loadJson("infrastructure/platform/feature-circuits.json");
    if (JSON.stringify(committed.circuits ?? []) !== JSON.stringify(output.circuits)) {
      console.error("Feature circuit registry is stale. Run: node services/circuit-registry/src/build.mjs");
      process.exit(1);
    }
  } else {
    fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  }
  console.log(JSON.stringify({ output: "infrastructure/platform/feature-circuits.json", completeness: output.completeness, findingCount: output.findings.length }, null, 2));
  return output;
}

build();
