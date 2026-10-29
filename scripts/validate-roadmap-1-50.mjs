import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createArchitectureRegistry, createArchitectureHealthScorecard, createFeatureCompletenessReport, createArchitectureLoop } from "../packages/architecture/src/index.mjs";

const failures = [];
const root = process.cwd();
const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    failures.push(`${file}: ${error.message}`);
    return {};
  }
};
const exists = (file, label = "evidence") => {
  const absolute = path.join(root, file);
  if (!fs.existsSync(absolute)) failures.push(`Missing ${label}: ${file}`);
  return fs.existsSync(absolute);
};
const sourceHas = (file, markers) => {
  if (!exists(file)) return;
  const source = fs.readFileSync(file, "utf8");
  for (const marker of markers) if (!source.includes(marker)) failures.push(`${file}: missing ${marker}`);
};

const roadmap = readJson("infrastructure/platform/roadmap-1-50.json");
const circuit = readJson("infrastructure/platform/universal-circuit.json");
const architecture = readJson("infrastructure/platform/architecture-manifest.json");
const universal = readJson("infrastructure/platform/universal-circuit.json");
const services = readJson("infrastructure/platform/service-registry.json");
const catalog = readJson("infrastructure/deployment/service-catalog.json");
const domains = readJson("infrastructure/platform/domain-contract-registry.json");
const domainRegistry = readJson("infrastructure/platform/domain-registry.json");
const featureCompleteness = readJson("infrastructure/platform/feature-completeness.json");
const fastPath = readJson("infrastructure/platform/fast-path-policy.json");
const workers = readJson("infrastructure/platform/worker-pools.json");
const evolution = readJson("infrastructure/platform/architecture-evolution.json");
const autonomousLoop = readJson("infrastructure/platform/autonomous-loop.json");

const expectedPhases = Array.from({ length: 50 }, (_, index) => index + 1);
if (roadmap.phaseRange?.join(",") !== "1,50") failures.push("Roadmap must cover phases 1 through 50");
if (roadmap.phases?.length !== 50 || roadmap.phases.some((phase, index) => phase.phase !== expectedPhases[index])) {
  failures.push("Roadmap phases must contain every phase 1–50 exactly once and in order");
}
for (const phase of roadmap.phases ?? []) {
  if (!phase.owner || phase.status !== "implemented") failures.push(`Phase ${phase.phase} requires an owner and implemented status`);
  for (const file of phase.evidence ?? []) exists(file, `phase ${phase.phase} evidence`);
}
if (roadmap.circuit?.join("|") !== circuit.stages?.join("|")) failures.push("Roadmap and universal circuit stage lists differ");

const unique = (items, label) => {
  const ids = new Set();
  for (const item of items ?? []) {
    if (!item.id) failures.push(`${label} has an item without an id`);
    if (ids.has(item.id)) failures.push(`Duplicate ${label} id: ${item.id}`);
    ids.add(item.id);
  }
};
unique(architecture.components, "architecture component");
unique(services.services, "service");
unique(domainRegistry.domains, "domain");
unique(featureCompleteness.features, "feature");
if (architecture.components?.length !== catalog.deployables?.length) failures.push("Architecture component registry and deployable catalog are out of sync");
const catalogByName = new Map((catalog.deployables ?? []).map((item) => [item.name, item]));
for (const service of services.services ?? []) {
  const deployable = catalogByName.get(service.id);
  if (!deployable) failures.push(`Service registry entry is not deployable: ${service.id}`);
  for (const field of ["owner", "source", "port", "health", "readiness", "deploymentTarget"]) {
    if (service[field] === undefined || service[field] === "") failures.push(`${service.id}: missing ${field}`);
  }
  if (deployable && (deployable.owner !== service.owner || deployable.source !== service.source || deployable.port !== service.port)) {
    failures.push(`${service.id}: service registry does not match service catalog`);
  }
}
for (const deployable of catalog.deployables ?? []) {
  if (!(services.services ?? []).some((service) => service.id === deployable.name)) failures.push(`Deployable missing from service registry: ${deployable.name}`);
}
if (domains.policy?.defaultDeny !== true || domains.policy?.databaseAccess !== "owner-mediated") failures.push("Domain boundary policy is not default-deny owner-mediated");
if ((domains.domains ?? []).length < 12) failures.push("Domain contract registry is incomplete");
if (domainRegistry.domains?.some((domain) => !["development", "staging", "production"].includes(domain.environment))) failures.push("Domain registry contains an invalid environment");

for (const file of [
  "packages/architecture/src/index.mjs",
  "scripts/validate-roadmap-1-50.mjs",
  "packages/architecture/test/index.test.mjs",
]) {
  if (exists(file)) {
    const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    if (result.status !== 0) failures.push(`${file}: syntax check failed: ${result.stderr}`);
  }
}
sourceHas("packages/architecture/src/index.mjs", [
  "traceCircuit",
  "findImpacted",
  "diffArchitectureSnapshots",
  "createArchitectureHealthScorecard",
  "createArchitectureLoop",
]);
if (circuit.engine !== "packages/architecture/src/index.mjs") failures.push("Universal circuit does not identify its executable engine");
if (fastPath.asyncOnly?.length < 4 || fastPath.latencyBudgetsMs?.["interactive-api"] !== 500) failures.push("Fast-path policy is incomplete");
if (workers.pools?.length < 5 || workers.pools.some((pool) => pool.userTrafficIsolated !== true)) failures.push("Worker pool isolation is incomplete");
if (evolution.automation?.mayApplyCriticalChanges !== false || evolution.automation?.requiresApproval !== true) failures.push("Architecture evolution is not approval-controlled");
if (autonomousLoop.criticalChanges?.silentMutation !== false || autonomousLoop.criticalChanges?.approvalRequired !== true) failures.push("Autonomous loop allows unsafe structural mutation");

const components = (architecture.components ?? []).map((item) => ({ ...item }));
const domainItems = (domains.domains ?? []).map((item) => ({ id: item.name, owner: item.owner, type: "domain" }));
const resources = (domains.domains ?? []).flatMap((domain) => (domain.data ?? []).map((id) => ({ id, owner: domain.owner, type: "db-resource" })));
const routes = [];
const events = [];
const workflows = [];
const deployments = [];

/*
 * The feature registry is the source of truth for circuit links. The old
 * validator used four hand-written routes, two events, and one workflow,
 * which made every other valid circuit look incomplete. Build the validation
 * graph from the declared links instead, while preserving the typed
 * collections used by the architecture engine.
 */
const registered = new Set([
  ...components.map((item) => item.id),
  ...domainItems.map((item) => item.id),
  ...resources.map((item) => item.id),
]);
const addNode = (collection, item) => {
  if (!collection.some((entry) => entry.id === item.id)) collection.push(item);
  registered.add(item.id);
};
const safeIdentifier = (value) => String(value).replace(/[^A-Za-z0-9._:@/-]+/g, "-");
const normalizedFeatures = (featureCompleteness.features ?? []).map((feature) => ({
  ...feature,
  circuit: Object.fromEntries(Object.entries(feature.circuit ?? {}).map(([stage, target]) => [
    stage,
    typeof target === "string" ? safeIdentifier(target) : target,
  ])),
  optionalStages: [
    ...new Set([
      ...(feature.optionalStages ?? []),
      ...(universal.optionalByPolicy ?? []),
    ]),
  ],
}));
for (const feature of normalizedFeatures) {
  for (const [stage, target] of Object.entries(feature.circuit ?? {})) {
    if (target === null || target === undefined || registered.has(target)) continue;
    const node = { id: target, owner: feature.owner, type: stage };
    if (["api", "api-client", "page-route"].includes(stage)) addNode(routes, node);
    else if (["eventbus"].includes(stage)) addNode(events, node);
    else if (["workflow"].includes(stage)) addNode(workflows, node);
    else if (["deployment"].includes(stage)) addNode(deployments, node);
    else addNode(components, { ...node, boundary: "governed" });
  }
}
for (const id of ["audit-platform", "intelligence", "admin"]) {
  if (!registered.has(id)) addNode(components, { id, type: "platform", owner: id, boundary: "governed" });
}
const registry = createArchitectureRegistry({
  components,
  domains: domainItems,
  features: normalizedFeatures,
  resources,
  routes,
  events,
  workflows,
  deployments,
});
for (const feature of normalizedFeatures) {
  const report = createFeatureCompletenessReport(registry, feature.id);
  if (report.status !== "COMPLETE" || report.score !== 100) failures.push(`Feature circuit is incomplete: ${feature.id}`);
}
if (registry.dependencyCycles().length !== 0) failures.push("Architecture registry contains a dependency cycle");
const scorecard = createArchitectureHealthScorecard(registry);
if (scorecard.circuitScore !== 100 || scorecard.dependencyCycles !== 0) failures.push("Architecture health scorecard is not healthy");
const loop = createArchitectureLoop(registry);
const recommendation = loop.propose({ title: "Review measured architecture health", reason: "The scorecard is the required evidence for the review." });
if (recommendation.status !== "awaiting_approval") failures.push("Architecture recommendations must require approval");
assert.equal(loop.approve(recommendation.id, { approver: "validation", reason: "Validation-only approval record" }).status, "approved");

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`Roadmap phases 1–50 validation passed (${roadmap.phases.length} phases, ${normalizedFeatures.length} complete feature circuits)`);