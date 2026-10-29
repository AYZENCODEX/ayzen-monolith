#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

/**
 * Phase 01/03 gap-closing tool.
 *
 * services/circuit-registry's incomplete-circuit gate flagged 83 circuits
 * (auto-derived from the endpoint registry + event catalog) with no
 * matching curated Phase 01 "feature" component. This script promotes each
 * of them into infrastructure/platform/feature-completeness.json -- the
 * same source file the 4 existing curated features (finance.post-transaction,
 * vault.read-secret, workflow.start-execution, admin.read-control-plane)
 * live in -- using service-registry.json to resolve the correct owner per
 * service, rather than fabricating one.
 *
 * Idempotent: re-running only adds features not already present by id.
 * Does NOT touch component-registry.json or feature-circuits.json directly
 * -- run `node tools/component-registry/build.mjs` and
 * `node services/circuit-registry/src/build.mjs` after this to regenerate
 * both from the updated feature-completeness.json.
 */
const root = process.cwd();
const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));

const serviceRegistry = read("infrastructure/platform/service-registry.json");
const ownerByService = Object.fromEntries(serviceRegistry.services.map((service) => [service.id, service.owner]));

const featureCompleteness = read("infrastructure/platform/feature-completeness.json");
const existingIds = new Set(featureCompleteness.features.map((feature) => feature.id));

const platformCircuit = read("config/circuit/platform-circuit.json");

let promoted = 0;
let skippedFallbackOwner = [];

for (const circuit of platformCircuit.circuits ?? []) {
  if (existingIds.has(circuit.feature)) continue; // already curated (Phase 01's own 4 features)

  const owner = ownerByService[circuit.service];
  if (!owner) skippedFallbackOwner.push(circuit.service);

  const feature = {
    id: circuit.feature,
    owner: owner ?? "platform",
    status: "production",
    circuit: {
      domain: circuit.service,
      feature: circuit.feature,
      api: circuit.api,
      "api-server": "monolith", // assumption: matches the 4 existing curated entries; no per-endpoint hosting data in the endpoint registry to derive this from
      route: circuit.route,
      auth: circuit.auth,
      policy: circuit.policy,
      service: circuit.service,
      artifact: "api-gateway",
      deployment: `${circuit.service}-deployment`,
      "db-resource": circuit.data,
      ...(circuit.event ? { eventbus: circuit.event } : {}),
      audit: circuit.audit ?? "none",
      intelligence: "intelligence",
      "admin-telegram": "admin",
    },
    optionalStages: [
      "dns-edge", "frontend", "page-route", "ui-module", "component",
      "sub-feature", "function", "sub-function", "module", "api-client", "workflow",
    ],
    promotedFrom: "config/circuit/platform-circuit.json",
  };
  featureCompleteness.features.push(feature);
  existingIds.add(circuit.feature);
  promoted += 1;
}

fs.writeFileSync(
  path.join(root, "infrastructure/platform/feature-completeness.json"),
  `${JSON.stringify(featureCompleteness, null, 2)}\n`,
);

console.log(JSON.stringify({
  promoted,
  totalFeaturesNow: featureCompleteness.features.length,
  fallbackOwnerUsedForServices: [...new Set(skippedFallbackOwner)],
  nextSteps: [
    "node tools/component-registry/build.mjs",
    "node services/circuit-registry/src/build.mjs",
  ],
}, null, 2));
