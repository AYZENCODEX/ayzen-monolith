#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const failures = [];
const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(path.join(root, file), "utf8")); }
  catch (error) { failures.push(`${file}: ${error.message}`); return undefined; }
};
const exists = (file) => fs.existsSync(path.join(root, file));
const registry = readJson("infrastructure/platform/phase-7-40.json");
const expected = Array.from({ length: 34 }, (_, index) => index + 7);
if (!registry || registry.phaseRange?.join(",") !== "7,40") failures.push("Phase registry must cover 7 through 40");
if (registry?.phases?.map((phase) => phase.phase).join(",") !== expected.join(",")) failures.push("Phase registry must contain every phase 7–40 exactly once and in order");
for (const phase of registry?.phases ?? []) for (const evidence of phase.evidence ?? []) if (!exists(evidence)) failures.push(`Phase ${phase.phase} missing evidence: ${evidence}`);

const jsonFiles = [
  "config/capabilities/registry.json", "config/cross-app/matrix.json", "config/scheduler/policy.json",
  "config/events/registry.json", "schemas/events/compatibility.v1.json", "schemas/workflow/recovery.v1.json",
  "schemas/data-lineage/record.v1.json", "config/limits/backpressure.json", "config/resources/budgets.json",
  "config/slo/gates.json", "schemas/provenance/record.v1.json", "schemas/architecture/version.v1.json",
  "config/chaos/matrix.json", "config/observability/coverage.json", "config/environments/parity.json",
  "infrastructure/secrets/registry.json", "infrastructure/migrations/ledger.json", "policy/admin-scopes/registry.json",
  "schemas/gap-lifecycle/gap.v1.json", "infra/backup/policy.json", "config/cost-budgets/policy.json", "config/release/promotion.json",
];
for (const file of jsonFiles) readJson(file);
const secrets = readJson("infrastructure/secrets/registry.json");
if (secrets?.valuesNeverStored !== true) failures.push("Secret registry must not store values");
const crossApp = readJson("config/cross-app/matrix.json");
for (const edge of crossApp?.edges ?? []) if (!edge.owner || !edge.actions?.length || !edge.dataScopes?.length) failures.push(`Cross-app edge is incomplete: ${edge.from}->${edge.to}`);
const adminScopes = readJson("policy/admin-scopes/registry.json");
for (const scope of adminScopes?.adminOperations ?? []) if (scope.audit !== true) failures.push(`Admin scope lacks audit: ${scope.capability}`);
const release = readJson("config/release/promotion.json");
if (release?.immutableArtifactRequired !== true || release.rollback?.auditRequired !== true) failures.push("Release governance must require immutable artifacts and rollback audit");
const chaos = readJson("config/chaos/matrix.json");
if (chaos?.environment !== "staging-only" || chaos?.syntheticDataOnly !== true) failures.push("Failure injection must be staging-only with synthetic data");

const syntaxTargets = [
  "packages/enforcement-core/src/index.mjs", "packages/backpressure/src/index.mjs", "packages/secrets/src/index.mjs",
  "packages/coordination/src/index.mjs", "packages/notification/src/index.mjs", "services/app-access-gateway/src/index.mjs",
  "services/migration-governance/src/index.mjs", "services/runtime-graph/src/index.mjs", "services/artifact-registry/src/index.mjs",
  "services/architecture-versioning/src/index.mjs", "services/incident-correlation/src/index.mjs", "services/gap-registry/src/index.mjs",
  "services/cost-governance/src/index.mjs", "services/release-governance/src/index.mjs", "services/certification-registry/src/index.mjs",
  "services/admin-gateway/src/index.mjs",
];
for (const file of syntaxTargets) {
  if (!exists(file)) continue;
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) failures.push(`${file}: syntax check failed ${result.stderr}`);
}

const report = {
  schemaVersion: 1,
  roadmap: "phases-7-40",
  generatedAt: new Date().toISOString(),
  status: failures.length ? "failed" : "passed",
  phases: registry?.phases?.length ?? 0,
  failures,
};
fs.mkdirSync(path.join(root, "reports/full-circuit-certification"), { recursive: true });
fs.writeFileSync(path.join(root, "reports/full-circuit-certification/phase-7-40-validation.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
if (failures.length) process.exit(1);