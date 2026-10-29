#!/usr/bin/env node
// Phase 01 — Canonical Component Registry.
//
// Reads every existing enumerable platform registry (services, workflows,
// worker pools, Telegram commands, features, domains, enforcement engines)
// and normalizes their entries into one machine-readable component catalog
// with a stable id, owner, app, environment and lifecycle per component.
//
// Writes:
//   infrastructure/platform/component-registry.json  — the canonical registry
//   reports/component-registry/completeness.json      — coverage + findings
//
// Exits non-zero if any declared source registry contributed zero
// components (SOURCE_REGISTRY_NOT_REPRESENTED), so silent drift between the
// bootstrap sources and this build script is caught rather than hidden.
import fs from "node:fs";
import path from "node:path";
import { createComponentCatalog } from "../../packages/component-registry/src/index.mjs";

const root = process.cwd();
const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));

// --- Source registries this build knows how to read. -----------------------
// Each entry maps one enumerable existing registry to a function that turns
// its list-shaped contents into canonical component definitions. Additional
// sources (individual events, UI routes, artifacts) should be added here as
// those registries gain enumerable entries — see Section 6 of the roadmap
// for the traceability this build is expected to eventually cover.
const SOURCES = [
  {
    registry: "infrastructure/platform/service-registry.json",
    extract: (doc) => doc.services.map((service) => ({
      id: `service:${service.id}`,
      kind: "service",
      owner: service.owner,
      app: service.owner,
      environment: "production",
      lifecycle: service.lifecycle ?? "ACTIVE",
      source: { registry: "infrastructure/platform/service-registry.json", originalId: service.id },
      metadata: { kind: service.kind, source: service.source, deploymentTarget: service.deploymentTarget },
    })),
  },
  {
    registry: "infrastructure/platform/workflow-registry.json",
    extract: (doc) => doc.workflows.map((workflow) => ({
      id: `workflow:${workflow.id}`,
      kind: "workflow",
      owner: workflow.owner,
      app: workflow.owner,
      environment: "production",
      lifecycle: "ACTIVE",
      source: { registry: "infrastructure/platform/workflow-registry.json", originalId: workflow.id },
      metadata: { steps: workflow.steps, requiresPolicy: workflow.requiresPolicy },
    })),
  },
  {
    registry: "infrastructure/platform/worker-pools.json",
    extract: (doc) => doc.pools.map((pool) => ({
      id: `worker-pool:${pool.id}`,
      kind: "worker-pool",
      owner: pool.owner,
      app: pool.owner,
      environment: "production",
      lifecycle: "ACTIVE",
      source: { registry: "infrastructure/platform/worker-pools.json", originalId: pool.id },
      metadata: { queue: pool.queue, backpressure: pool.backpressure },
    })),
  },
  {
    registry: "infrastructure/platform/telegram-command-registry.json",
    extract: (doc) => doc.commands.map((command) => ({
      id: `telegram-command:${command.bot}:${command.command}`,
      kind: "telegram-command",
      owner: command.bot,
      app: command.bot,
      environment: "production",
      lifecycle: "ACTIVE",
      source: { registry: "infrastructure/platform/telegram-command-registry.json", originalId: `${command.bot}:${command.command}` },
      metadata: { capability: command.capability, group: command.group, confirmation: command.confirmation === true },
    })),
  },
  {
    registry: "infrastructure/platform/feature-completeness.json",
    extract: (doc) => doc.features.map((feature) => ({
      id: `feature:${feature.id}`,
      kind: "feature",
      owner: feature.owner,
      app: feature.owner,
      environment: feature.status === "production" ? "production" : "staging",
      lifecycle: "ACTIVE",
      source: { registry: "infrastructure/platform/feature-completeness.json", originalId: feature.id },
      metadata: { status: feature.status, circuit: feature.circuit },
    })),
  },
  {
    registry: "infrastructure/platform/domain-registry.json",
    extract: (doc) => doc.domains.map((domain) => ({
      id: `domain:${domain.id}`,
      kind: "domain",
      owner: domain.owner,
      app: domain.owner,
      environment: domain.environment ?? "production",
      lifecycle: "ACTIVE",
      source: { registry: "infrastructure/platform/domain-registry.json", originalId: domain.id },
      metadata: { domain: domain.domain, target: domain.target, entryPoint: domain.entryPoint },
    })),
  },
  {
    registry: "infrastructure/platform/enforcement-registry.json",
    extract: (doc) => doc.nodes.map((node) => ({
      id: `${node.type}:${node.id}`,
      kind: node.type === "control-plane" ? "control-plane" : "engine",
      owner: node.owner,
      app: node.app,
      environment: "production",
      lifecycle: node.lifecycle ?? "ACTIVE",
      source: { registry: "infrastructure/platform/enforcement-registry.json", originalId: node.id },
      metadata: { policy: node.policy, version: node.version },
    })),
  },
];

const components = [];
const readErrors = [];
for (const { registry, extract } of SOURCES) {
  try {
    components.push(...extract(read(registry)));
  } catch (error) {
    readErrors.push({ registry, error: error.message });
  }
}

const catalog = createComponentCatalog({ components, expectedSources: SOURCES.map((s) => s.registry) });

const registryOutput = {
  schemaVersion: 1,
  registryId: "ayzen-component-registry",
  generatedAt: new Date().toISOString(),
  generatedBy: "tools/component-registry/build.mjs",
  schema: "schemas/platform/components/component.v1.json",
  sourceRegistries: SOURCES.map((s) => s.registry),
  components: catalog.list(),
};

const registryPath = path.join(root, "infrastructure/platform/component-registry.json");
fs.mkdirSync(path.dirname(registryPath), { recursive: true });
fs.writeFileSync(registryPath, `${JSON.stringify(registryOutput, null, 2)}\n`);

const findings = [...catalog.findings(), ...readErrors.map(({ registry, error }) => ({ severity: "critical", code: "SOURCE_REGISTRY_UNREADABLE", registry, error }))];
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  status: findings.some((f) => f.severity === "critical") ? "BLOCKED" : "READY",
  completeness: catalog.completeness(),
  findings,
  registry: "infrastructure/platform/component-registry.json",
};

const reportPath = path.join(root, "reports/component-registry/completeness.json");
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

console.log(JSON.stringify({
  status: report.status,
  totalComponents: report.completeness.totalComponents,
  sourceRegistries: `${report.completeness.representedSourceRegistries}/${report.completeness.totalSourceRegistries}`,
  findings: findings.length,
  registryOutput: "infrastructure/platform/component-registry.json",
  reportOutput: "reports/component-registry/completeness.json",
}, null, 2));

if (report.status !== "READY") process.exit(1);
