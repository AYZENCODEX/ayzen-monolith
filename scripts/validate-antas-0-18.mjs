#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const manifestPath = "config/antas/roadmap-0-18.json";
const manifest = JSON.parse(fs.readFileSync(path.join(root, manifestPath), "utf8"));
const failures = [];
const notices = [];

const exists = (file) => fs.existsSync(path.join(root, file));
const read = (file) => {
  try {
    return fs.readFileSync(path.join(root, file), "utf8");
  } catch {
    return "";
  }
};
const json = (file) => {
  try {
    return JSON.parse(read(file));
  } catch (error) {
    failures.push(`${file}: invalid JSON (${error.message})`);
    return undefined;
  }
};
const check = (condition, message) => {
  if (!condition) failures.push(message);
};
const run = (command, args, label) => {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ALLOW_EVENTBUS_NOOP: "true" },
  });
  if (result.status !== 0) failures.push(`${label} failed: ${(result.stderr || result.stdout || "").trim().slice(-600)}`);
  return result;
};
const phaseDirectory = (phase) => `reports/antas/ANTAS-${String(phase).padStart(2, "0")}`;

if (manifest.phaseRange?.join(",") !== "0,18") failures.push("ANTAS manifest must cover phases 0 through 18");
const phaseNumbers = manifest.phases?.map((phase) => phase.phase) ?? [];
if (phaseNumbers.join(",") !== Array.from({ length: 19 }, (_, index) => index).join(",")) {
  failures.push("ANTAS manifest must contain every phase 0–18 exactly once and in order");
}

const baselineRequired = [
  "reports/antas/baseline/repository-inventory.json",
  "reports/antas/baseline/routes.json",
  "reports/antas/baseline/services.json",
  "reports/antas/baseline/environment.json",
  "reports/antas/baseline/metrics.json",
  "reports/antas/baseline/claim-reality.json",
];
if (process.argv.includes("--refresh-baseline") || baselineRequired.some((file) => !exists(file))) {
  run(process.execPath, ["scripts/antas/baseline.mjs"], "ANTAS baseline");
}
for (const file of baselineRequired) check(exists(file), `missing generated baseline evidence: ${file}`);
const subphaseRun = run(process.execPath, ["scripts/antas/validate-subphases.mjs"], "ANTAS sub-phases");
if (subphaseRun.status !== 0) {
  for (const line of `${subphaseRun.stderr ?? ""}\n${subphaseRun.stdout ?? ""}`.split("\n")) {
    if (line.startsWith("ANTAS-") || line.startsWith("expected ") || line.startsWith("invalid ")) failures.push(line.trim());
  }
}

const sourceMarkers = new Map([
  [0, [["reports/antas/baseline/claim-reality.json", "\"UNVERIFIED\""], ["reports/antas/baseline/metrics.json", "\"sourceFiles\""]]],
  [1, [["package.json", "\"packageManager\": \"pnpm@10.26.1\""], ["pnpm-workspace.yaml", "minimumReleaseAge"], [".nvmrc", "24"]]],
  [2, [["config/antas/domain-ownership.json", "\"oneOwnerPerResource\": true"], ["packages/domain-boundaries/src/index.mjs", "DOMAIN_CONTRACTS"]]],
  [3, [["packages/auth-client/src/index.mjs", "stepUp"], ["packages/identity/src/index.mjs", "IDENTITY_TYPES"]]],
  [4, [["config/antas/authorization-matrix.json", "\"defaultDecision\": \"deny\""], ["packages/authorization/src/index.mjs", "authorizeCapability"]]],
  [5, [["config/antas/database-ownership.json", "requiredMigrationMetadata"], ["packages/domain-boundaries/src/index.mjs", "DATABASE_OWNERSHIP"]]],
  [6, [["services/finance/src/index.mjs", "ledger"], ["scripts/antas/finance/reconcile.mjs", "UNVERIFIED"]]],
  [7, [["config/security/key-management.json", "\"rotation\""], ["services/vault/src/index.mjs", "encrypt"]]],
  [8, [["config/antas/event-envelope.json", "eventId"], ["packages/events/src/index.mjs", "createEventEnvelope"], ["packages/event-client/src/index.mjs", "replay"]]],
  [9, [["config/antas/api-policy.json", "errorRedaction"], ["apps/api-gateway/src/index.mjs", "http.createServer"]]],
  [10, [["docs/antas/architecture/extraction-exit-criteria.md", "rollback"], ["infrastructure/deployment/service-catalog.json", "deployables"]]],
  [11, [["docs/antas/testing/test-pyramid.md", "chaos"], ["tests/security/backbone-security.test.mjs", "test("]]],
  [12, [["config/slo/gates.json", "p95LatencyMs"], ["packages/telemetry/src/index.mjs", "createMetrics"]]],
  [13, [["infrastructure/platform/backup-policy.json", "isolatedTargetRequired"], ["scripts/backup-restore-check.mjs", "restoreVerification"]]],
  [14, [["infrastructure/platform/capacity-plan.json", "scenarios"], ["config/slo/gates.json", "queueLagSeconds"]]],
  [15, [[".github/workflows/security.yml", "pnpm audit"], [".github/workflows/release.yml", "provenance: true"]]],
  [16, [["scripts/antas/maintainability.mjs", "anyOccurrences"], ["reports/antas/baseline/metrics.json", "todoFixmeOccurrences"]]],
  [17, [["scripts/validate-ui-circuit.mjs", "registry"], ["tests/ui-circuit/registry.test.mjs", "test("]]],
  [18, [["docs/operations/go-live-checklist.md", "rollback"], ["services/certification-registry/src/index.mjs", "certify"]]],
]);

for (const phase of manifest.phases) {
  for (const evidence of phase.evidence ?? []) {
    // The phase 18 certification file is generated after all phase reports exist.
    if (phase.phase === 18 && evidence === "reports/antas/ANTAS-18/certification.json") continue;
    check(exists(evidence), `ANTAS-${String(phase.phase).padStart(2, "0")} missing evidence: ${evidence}`);
  }
  for (const [file, marker] of sourceMarkers.get(phase.phase) ?? []) {
    check(read(file).includes(marker), `ANTAS-${String(phase.phase).padStart(2, "0")} missing marker ${marker} in ${file}`);
  }
}

run(process.execPath, ["scripts/antas/verify-toolchain.mjs"], "ANTAS toolchain");
run(process.execPath, ["scripts/validate-domain-boundaries.mjs"], "ANTAS boundary validation");
run(process.execPath, ["scripts/backup-restore-check.mjs"], "ANTAS backup policy");
run(process.execPath, ["scripts/antas/security/test-identity-controls.mjs"], "ANTAS identity controls");
run(process.execPath, ["scripts/antas/security/test-ssrf-policy.mjs"], "ANTAS vault controls");
run(process.execPath, ["scripts/antas/finance/reconcile.mjs"], "ANTAS finance controls");
run(process.execPath, ["scripts/antas/maintainability.mjs"], "ANTAS maintainability inventory");

const commandLog = [
  "pnpm antas:baseline",
  "pnpm antas:subphases",
  "node scripts/antas/verify-toolchain.mjs",
  "node scripts/validate-domain-boundaries.mjs",
  "node scripts/backup-restore-check.mjs",
  "node scripts/antas/security/test-identity-controls.mjs",
  "node scripts/antas/security/test-ssrf-policy.mjs",
  "node scripts/antas/finance/reconcile.mjs",
  "node scripts/antas/maintainability.mjs",
].join("\n");

for (const phase of manifest.phases) {
  const directory = phaseDirectory(phase.phase);
  fs.mkdirSync(path.join(root, directory, "screenshots"), { recursive: true });
  fs.mkdirSync(path.join(root, directory, "artifacts"), { recursive: true });
  const phaseFailures = failures.filter((failure) => failure.startsWith(`ANTAS-${String(phase.phase).padStart(2, "0")}`));
  const report = {
    schemaVersion: 1,
    phase: `ANTAS-${String(phase.phase).padStart(2, "0")}`,
    name: phase.name,
    owner: phase.owner,
    priority: phase.priority,
    generatedAt: new Date().toISOString(),
    status: phaseFailures.length ? "BLOCKED" : "PASS",
    required: (phase.evidence ?? []).length,
    passed: Math.max(0, (phase.evidence ?? []).length - phaseFailures.length),
    failed: phaseFailures.length,
    waived: 0,
    criticalFailures: phaseFailures.length && phase.priority === "P0" ? phaseFailures.length : 0,
    productionReady: false,
    externalGates: (phase.externalGates ?? []).map((gate) => ({ gate, status: "UNVERIFIED" })),
    findings: phaseFailures,
    note: "PASS means repository evidence and static controls are present; it does not certify runtime or production behavior.",
  };
  fs.writeFileSync(path.join(root, directory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(root, directory, "commands.txt"), `${commandLog}\n`);
  fs.writeFileSync(path.join(root, directory, "stdout.log"), "Static repository evidence generated by validate-antas-0-18.mjs.\n");
  fs.writeFileSync(path.join(root, directory, "stderr.log"), phaseFailures.length ? `${phaseFailures.join("\n")}\n` : "");
  fs.writeFileSync(path.join(root, directory, "metrics.json"), `${JSON.stringify({ evidenceCount: phase.evidence.length, externalGateCount: phase.externalGates.length }, null, 2)}\n`);
  fs.writeFileSync(path.join(root, directory, "findings.json"), `${JSON.stringify({ failures: phaseFailures, externalGates: report.externalGates }, null, 2)}\n`);
}

run(process.execPath, ["scripts/antas/certification.mjs"], "ANTAS certification assembly");
check(exists("reports/antas/ANTAS-18/certification.json"), "ANTAS-18 certification report was not generated");
const certification = json("reports/antas/ANTAS-18/certification.json");
if (certification?.productionReady !== false) failures.push("ANTAS certification must remain false until runtime gates and sign-off exist");

const summary = {
  schemaVersion: 1,
  roadmap: "ANTAS",
  phaseRange: [0, 18],
  generatedAt: new Date().toISOString(),
  repositoryStatus: failures.length ? "failed" : "implemented",
  productionReadiness: "UNVERIFIED",
  phases: manifest.phases.length,
  failures,
  notices: [
    ...notices,
    "Runtime, provider, staging, production, and release-owner gates remain UNVERIFIED.",
  ],
};
fs.mkdirSync(path.join(root, "reports/antas"), { recursive: true });
fs.writeFileSync(path.join(root, "reports/antas/antas-0-18-validation.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({ output: "reports/antas/antas-0-18-validation.json", status: summary.repositoryStatus, productionReadiness: summary.productionReadiness, phases: summary.phases, failures: failures.length }, null, 2));
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}