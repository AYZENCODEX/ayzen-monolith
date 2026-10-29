import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createIntegrationGraph, validateEventContract, validateWorkflowContract, validateNotificationContract, validateScheduleDefinition } from "../packages/platform-governance/src/index.mjs";
import { createLeaseStore } from "../packages/leases/src/index.mjs";
import { createQuotaLimiter } from "../packages/rate-limit/src/index.mjs";
import { validateIntegration } from "../tools/integration-validator/index.mjs";

const root = process.cwd();
const failures = [];
const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(path.join(root, file), "utf8")); }
  catch (error) { failures.push(`${file}: ${error.message}`); return {}; }
};
const exists = (file) => {
  if (!fs.existsSync(path.join(root, file))) failures.push(`Missing evidence: ${file}`);
};
const roadmap = readJson("infrastructure/platform/shared-platform-roadmap-1-30.json");
const catalog = readJson("infrastructure/platform/shared-service-catalog.json");
const services = readJson("infrastructure/platform/service-registry.json");
const graphDefinition = readJson("infrastructure/platform/integration-graph.json");
const fabric = readJson("infrastructure/platform/event-fabric.json");
const eventOps = readJson("infrastructure/platform/event-operations.json");
const policy = readJson("infrastructure/platform/policy-registry.json");
const config = readJson("infrastructure/platform/config-registry.json");
const extraction = readJson("infrastructure/platform/extraction-rules.json");
const enforcement = readJson("config/enforcement/policy.json");

if (roadmap.phaseRange?.join(",") !== "1,30" || roadmap.phases?.length !== 30) failures.push("Shared platform roadmap must contain phases 1–30");
for (const phase of roadmap.phases ?? []) for (const file of phase.evidence ?? []) exists(file);
if (!catalog.defaultDeny || catalog.rules?.onePhysicalRuntimePerCapability !== true || catalog.rules?.crossAppDatabaseAccess !== "deny-by-default") failures.push("Shared service catalog is not default-deny and single-runtime governed");
const serviceIds = new Set((services.services ?? []).map((service) => service.id));
if (serviceIds.size !== (services.services ?? []).length) failures.push("Service registry contains duplicate IDs");
for (const service of services.services ?? []) for (const key of ["id", "owner", "source", "port", "health", "readiness", "deploymentTarget"]) if (service[key] === undefined || service[key] === "") failures.push(`Service ${service.id} missing ${key}`);
if (fabric.isolation?.directDatabaseAccess !== false || fabric.defaultDelivery !== "at-least-once") failures.push("Event fabric isolation or delivery policy is incomplete");
if (eventOps.deadLetter?.operatorApprovalForReplay !== true || eventOps.idempotency?.required !== true) failures.push("Event operations replay/idempotency controls are incomplete");
if (policy.defaultDeny !== true || policy.enforcedSurfaces?.length < 6) failures.push("Policy registry is incomplete");
if (config.drift?.blockProductionActivation !== true || config.secretValues !== "reference-only") failures.push("Config control plane is not drift-blocking/reference-only");
if (!Array.isArray(extraction.qualifyingReasons) || extraction.requiredApprovals?.length !== 3) failures.push("Extraction rules are incomplete");
if (enforcement.default !== "quarantine" || enforcement.auditEveryDecision !== true) failures.push("Runtime enforcement is not fail-closed and audited");

const graph = createIntegrationGraph(graphDefinition);
const graphResult = graph.status();
if (graphResult !== "READY") failures.push(`Integration graph is ${graphResult}: ${JSON.stringify(graph.findings())}`);
const contractResult = validateIntegration({
  graphDefinition,
  contracts: {
    events: [{
      id: "finance.transaction.created", producer: "finance", consumers: ["notification"], version: 1,
      delivery: "at-least-once", idempotencyKey: "eventId", securityScope: "workspace", failurePolicy: "retry-dlq", audit: true,
    }],
    workflows: [{
      id: "daily-close", owner: "ryft", trigger: "finance.transaction.created", steps: ["close"], completionEvent: "workflow.completed", policy: "ryft.workflow.execute",
    }],
    schedules: [{ id: "daily-close-schedule", owner: "ryft", trigger: "0 0 * * *", lease: "daily-close", targetWorkflow: "daily-close" }],
    notifications: [{ id: "transaction-alert", owner: "notification", source: "finance.transaction.created", recipientScope: "workspace", channel: "in-app", policy: "notification.send", template: "transaction-alert" }],
  },
});
if (contractResult.status !== "READY") failures.push(`Contract validation failed: ${JSON.stringify(contractResult)}`);

const lease = createLeaseStore();
const ownerA = lease.acquire("phase-9", { owner: "a" });
if (!ownerA.acquired || lease.acquire("phase-9", { owner: "b" }).acquired) failures.push("Lease coordination does not prevent duplicate ownership");
if (!lease.release("phase-9", "a")) failures.push("Lease release failed");
const limiter = createQuotaLimiter({ rules: { ryft: { limit: 1, windowMs: 60_000 } } });
if (!limiter.check({ app: "ryft" }).allowed || limiter.check({ app: "ryft" }).allowed) failures.push("Quota limiter does not enforce shared limits");
for (const [file, markers] of Object.entries({
  "packages/events/src/index.mjs": ["createEventEnvelope", "assertEventEnvelope"],
  "packages/event-client/src/index.mjs": ["enforceProducerIdentity", "enforcePayloadPolicy"],
  "services/workflow/src/index.mjs": ["createServiceServer"],
  "services/notification/src/index.mjs": ["notification.sent", "notification.failed"],
  "services/admin/src/index.mjs": ["/api/admin/health", "persistState"],
})) {
  const source = fs.existsSync(path.join(root, file)) ? fs.readFileSync(path.join(root, file), "utf8") : "";
  for (const marker of markers) if (!source.includes(marker)) failures.push(`${file} missing ${marker}`);
}
for (const file of [
  "packages/platform-governance/src/index.mjs",
  "packages/service-registry/src/index.mjs",
  "packages/leases/src/index.mjs",
  "packages/rate-limit/src/index.mjs",
  "services/service-discovery/src/index.mjs",
  "services/event-operations/src/index.mjs",
  "services/scheduler/src/index.mjs",
  "services/policy/src/index.mjs",
  "services/policy-simulation/src/index.mjs",
  "services/config-control/src/index.mjs",
  "services/coordination/src/index.mjs",
  "services/platform-health/src/index.mjs",
  "services/enforcement-fabric/src/index.mjs",
  "tools/circuit-validator/index.mjs",
  "tools/contract-validator/index.mjs",
  "tools/integration-validator/index.mjs",
]) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) failures.push(`${file}: syntax check failed: ${result.stderr}`);
}
for (const [name, fn, input] of [
  ["event", validateEventContract, { id: "x.y", producer: "x", consumers: ["y"], version: 1, delivery: "at-least-once", idempotencyKey: "eventId", securityScope: "tenant", failurePolicy: "retry-dlq", audit: true }],
  ["workflow", validateWorkflowContract, { id: "w", owner: "x", trigger: "x.y", steps: ["run"], completionEvent: "workflow.completed", policy: "x.run" }],
  ["schedule", validateScheduleDefinition, { id: "s", owner: "x", trigger: "* * * * *", lease: "s", targetWorkflow: "w" }],
  ["notification", validateNotificationContract, { id: "n", owner: "notification", source: "x.y", recipientScope: "workspace", channel: "in-app", policy: "notification.send", template: "x" }],
]) {
  try { fn(input); } catch (error) { failures.push(`${name} contract fixture failed: ${error.message}`); }
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`Shared platform phases 1–30 validation passed (${roadmap.phases.length} phases, ${graph.nodes().length} graph nodes, ${graph.edges().length} graph edges)`);