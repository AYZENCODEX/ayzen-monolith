#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBackboneRuntime } from "../packages/backbone/src/index.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};
const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(resolve(root, path), "utf8"));
  } catch (error) {
    failures.push(`${path}: ${error.message}`);
    return null;
  }
};
const readText = (path) => {
  try {
    return readFileSync(resolve(root, path), "utf8");
  } catch (error) {
    failures.push(`${path}: ${error.message}`);
    return "";
  }
};

const manifest = readJson("infrastructure/platform/roadmap-api-security-eventbus-workflow-1-50.json");
const circuit = readJson("config/circuit/platform-circuit.json");
const apiRegistry = readJson("config/api/app-registry.json");
const topology = readJson("config/eventbus/topology.json");
const eventSchema = readJson("schemas/events/envelope.v1.json");

check(manifest?.phaseRange?.join(",") === "1,50", "backbone roadmap must cover phases 1-50");
check(manifest?.phases?.length === 50, "backbone roadmap must contain exactly 50 phases");
check(manifest?.status === "implemented-and-governed", "backbone roadmap must be implemented-and-governed");
check(manifest?.phaseGate?.length === 6, "every phase must have the six-part completion gate");
check(JSON.stringify(manifest?.unifiedCircuit) === JSON.stringify(circuit?.stages), "unified circuit and circuit registry differ");
check(["STRA", "generated-from-endpoint-registry-and-event-catalog"].includes(circuit?.sourceOfTruth) && circuit?.orphanDetection === true && circuit?.missingLinkStatus === "fail", "circuit registry enforcement is incomplete");
check(apiRegistry?.crossAppDataAccess === "deny-by-default", "app registry must deny direct cross-app data access");
check(topology?.buses?.length === 5 && topology?.crossBus === "policy-required", "EventBus topology is incomplete");
check(eventSchema?.required?.includes("traceId") && eventSchema?.required?.includes("correlationId"), "event schema lacks traceability");

for (const [index, phase] of (manifest?.phases ?? []).entries()) {
  check(phase.phase === index + 1, `phase ordering is invalid at ${phase.phase}`);
  check(typeof phase.title === "string" && phase.title.length > 5, `phase ${phase.phase} title is missing`);
  check(typeof phase.owner === "string" && phase.owner.length > 1, `phase ${phase.phase} owner is missing`);
  check(phase.status === "implemented", `phase ${phase.phase} is not implemented`);
  for (const evidence of phase.evidence ?? []) {
    check(existsSync(resolve(root, evidence)), `phase ${phase.phase} evidence is missing: ${evidence}`);
  }
}

const requiredSourceMarkers = [
  ["packages/api-contracts/src/index.mjs", ["createApiRequest", "createApiError", "createPage"]],
  ["packages/app-api-security/src/index.mjs", ["createAppSecurityContext", "authorizeAppRequest", "verifySecurityMetadata"]],
  ["packages/connectors/src/index.mjs", ["register", "execute", "idempotencyKey"]],
  ["packages/idempotency/src/index.mjs", ["begin", "complete", "fingerprint"]],
  ["packages/outbox/src/index.mjs", ["append", "claim", "consumeOnce"]],
  ["packages/backbone/src/index.mjs", ["subscribe", "publish", "registerWorkflow", "replay"]],
  ["packages/events/src/index.mjs", ["createEventEnvelope", "assertEventEnvelope"]],
  ["packages/workflow/src/index.mjs", ["validateWorkflowDefinition", "createWorkflowRegistry"]],
  ["apps/api-gateway/src/index.mjs", ["requestContextFromHeaders", "assertSafeUpstreamUrl", "RATE_LIMITED"]],
];
for (const [path, markers] of requiredSourceMarkers) {
  const source = readText(path);
  for (const marker of markers) check(source.includes(marker), `${path} is missing ${marker}`);
}

const testFiles = [
  "packages/api-contracts/test/index.test.mjs",
  "packages/app-api-security/test/index.test.mjs",
  "packages/connectors/test/index.test.mjs",
  "packages/idempotency/test/index.test.mjs",
  "packages/outbox/test/index.test.mjs",
  "packages/resilience/test/index.test.mjs",
  "packages/service-auth/test/index.test.mjs",
  "packages/backbone/test/index.test.mjs",
  "tests/api/compatibility.test.mjs",
  "tests/security/backbone-security.test.mjs",
];
try {
  execFileSync(process.execPath, ["--test", ...testFiles], { cwd: root, stdio: "pipe", encoding: "utf8" });
} catch (error) {
  failures.push(`backbone test suite failed: ${error.stdout ?? error.message}`);
}

const runtime = createBackboneRuntime();
runtime.registerEvent({ type: "backbone.validation", version: 1, owner: "platform" });
let handled = 0;
runtime.subscribe({ eventType: "backbone.validation", consumer: "validator", handler: async () => { handled += 1; } });
await runtime.publish({
  eventId: "validation-event-1",
  eventType: "backbone.validation",
  eventVersion: 1,
  traceId: "validation-trace-1",
  correlationId: "validation-correlation-1",
  payload: { ok: true },
});
check(handled === 1, "backbone event delivery smoke test failed");
check(runtime.health().published === 1 && runtime.health().delivered === 1, "backbone health counters are invalid");

if (failures.length) {
  console.error(`API/security/backbone validation failed with ${failures.length} issue(s):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("API/security/backbone validation passed: 50 phases, app API contracts, security boundaries, connectivity, EventBus, workflow, outbox/inbox, replay, observability, and circuit evidence.");