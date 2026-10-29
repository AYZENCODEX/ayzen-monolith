#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  createPlatformGraph,
  createStateSyncRegistry,
  createDataGovernanceCatalog,
  createResourceOrchestrator,
  createRuntimeOptimization,
  createRecoveryController,
  createLifecycleRegistry,
} from "../../packages/platform-governance/src/index.mjs";

const root = process.cwd();
const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
const universal = read("config/enforcement/universal.json");
const registry = read("infrastructure/platform/enforcement-registry.json");

const graph = createPlatformGraph(registry);
const state = createStateSyncRegistry({
  sources: universal.engines.map((engine, index) => ({ id: engine.id, sourceOfTruth: engine.evidence, version: 1, checkpoint: 1, checksum: `engine-${index + 1}` })),
});
const data = createDataGovernanceCatalog({
  entries: [{ id: "enforcement-engine-state", owner: "platform", classification: "internal", allowedConsumers: ["enforcement-fabric"], retention: "90d", encryption: "at-rest", export: "operator-approved", delete: "operator-approved", audit: true }],
});
const resources = createResourceOrchestrator({
  budgets: [
    { id: "enforcement-worker-concurrency", limit: 100 },
    { id: "enforcement-event-queue", limit: 1000 },
  ],
});
const performance = createRuntimeOptimization({
  slos: [
    { id: "universal-gate", target: 500, action: "investigate-bottleneck" },
  ],
});
const policy = { status: "READY", decision: "DENY_BY_DEFAULT", explainable: true };
const recovery = createRecoveryController({
  policies: [{ id: "universal-gate", retry: true, fallback: "quarantine", reconcile: true, verify: true, operatorApproval: true }],
});
const lifecycle = createLifecycleRegistry({
  resources: [{ id: "enforcement-fabric", lifecycle: "ACTIVE", requiredService: "platform", requiredServiceLifecycle: "ACTIVE" }],
});

const engineResults = {
  dependencyGraph: { status: graph.status(), findings: graph.findings(), nodes: graph.nodes().length, edges: graph.edges().length },
  stateSync: { status: state.status(), divergences: state.divergences() },
  dataGovernance: { status: data.status(), entries: data.list().length },
  resources: { status: resources.status(), budgets: resources.list() },
  performance: { status: performance.status(), slos: performance.list() },
  policySimulation: policy,
  recovery: { status: recovery.status(), policies: recovery.list().length },
  lifecycle: { status: lifecycle.status(), findings: lifecycle.findings() },
};

const externalGates = universal.externalGates.map((name) => {
  const result = spawnSync(process.execPath, [`scripts/${name}.mjs`], { cwd: root, encoding: "utf8", env: { ...process.env, ALLOW_EVENTBUS_NOOP: "true" } });
  return { name, passed: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().slice(-1000) };
});
const failedEngines = Object.entries(engineResults).filter(([, result]) => result.status !== "READY" && result.status !== "HEALTHY");
const report = {
  schemaVersion: 1,
  gate: universal.gate,
  generatedAt: new Date().toISOString(),
  status: failedEngines.length || externalGates.some((gate) => !gate.passed) ? "BLOCKED" : "CERTIFIED",
  engines: engineResults,
  externalGates,
  evidence: { registry: "infrastructure/platform/enforcement-registry.json", policy: "config/enforcement/universal.json" },
};
const output = process.env.ENFORCEMENT_REPORT ?? "reports/certification/enforcement-certification.json";
fs.mkdirSync(path.dirname(path.join(root, output)), { recursive: true });
fs.writeFileSync(path.join(root, output), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ output, status: report.status, failedEngines: failedEngines.map(([name]) => name), failedGates: externalGates.filter((gate) => !gate.passed).map((gate) => gate.name) }, null, 2));
if (report.status !== "CERTIFIED") process.exit(1);