#!/usr/bin/env node

/**
 * ZIOX-A through ZIOX-J certification harness.
 *
 * This command is intentionally evidence-producing, not a static "file exists"
 * score. Each check records the command or repository invariant it evaluated,
 * its output, and whether it was pass, fail, or blocked by an external
 * prerequisite. A production gate cannot be marked PASS when a required
 * check is blocked.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";

const root = process.cwd();
const registryPath = "config/ziox/roadmap.json";
const reportDir = path.join(root, "reports/ziox");
const registry = JSON.parse(fs.readFileSync(path.join(root, registryPath), "utf8"));
const failures = [];
const allChecks = [];

const now = () => new Date().toISOString();
const exists = (file) => fs.existsSync(path.join(root, file));
const readText = (file) => fs.readFileSync(path.join(root, file), "utf8");
const readJson = (file) => JSON.parse(readText(file));
const writeJson = (file, value) => {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
};

function check(id, description, passed, details = {}, options = {}) {
  const status = options.blocked ? "BLOCKED" : passed ? "PASS" : "FAIL";
  const result = { id, description, status, ...details };
  allChecks.push(result);
  if (status !== "PASS") failures.push({ id, description, status, ...details });
  return result;
}

function command(id, description, executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: root,
    encoding: "utf8",
    timeout: options.timeout ?? 300_000,
    env: { ...process.env, ALLOW_EVENTBUS_NOOP: "true" },
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return check(id, description, result.status === 0, {
    command: [executable, ...args].join(" "),
    exitCode: result.status,
    output: output.slice(-4000),
  }, result.error?.code === "ETIMEDOUT" ? { blocked: true } : {});
}

function files(id, description, required) {
  const missing = required.filter((file) => !exists(file));
  return check(id, description, missing.length === 0, {
    required,
    missing,
  });
}

function phaseReport(phase, checks) {
  const phaseFailures = checks.filter((item) => item.status !== "PASS");
  return {
    schemaVersion: 1,
    roadmap: registry.roadmap,
    phase: phase.id,
    name: phase.name,
    generatedAt: now(),
    status: phaseFailures.length ? "BLOCKED" : "PASS",
    implementation: phaseFailures.length ? "blocked" : "complete",
    subphases: phase.subphases,
    checks,
    failures: phaseFailures,
    evidence: {
      sourceDocument: registry.sourceDocument,
      validator: "scripts/validate-ziox.mjs",
    },
  };
}

function runPhase(phase, fn) {
  const start = allChecks.length;
  fn();
  const checks = allChecks.slice(start);
  writeJson(`reports/ziox/${phase.id}-certification.json`, phaseReport(phase, checks));
}

const phase = (id) => registry.phases.find((item) => item.id === id);

runPhase(phase("A"), () => {
  const packageJson = readJson("package.json");
  const lock = readText("pnpm-lock.yaml");
  const workspace = readText("pnpm-workspace.yaml");
  const workspacePackages = packageJson.name && workspace.includes("packages:");
  const runtimeDependencies = Object.keys(packageJson.dependencies ?? {});
  const devDependencies = Object.keys(packageJson.devDependencies ?? {});
  writeJson("reports/ziox/A1-dependency-inventory.json", {
    schemaVersion: 1,
    generatedAt: now(),
    packageManager: packageJson.packageManager,
    runtimeDependencies,
    devDependencies,
    workspace: workspacePackages,
    lockfileSha256: crypto.createHash("sha256").update(lock).digest("hex"),
    reproducible: Boolean(packageJson.packageManager && lock.length > 0 && workspacePackages),
  });
  check("A1", "Dependency inventory is reproducible", Boolean(packageJson.packageManager && lock.length > 0 && workspacePackages), { runtimeDependencies: runtimeDependencies.length, devDependencies: devDependencies.length });
  command("A2", "Frozen dependency install", "pnpm", ["install", "--frozen-lockfile", "--offline"], { timeout: 300_000 });
  command("A3", "Full production-relevant typecheck", "pnpm", ["run", "typecheck"], { timeout: 300_000 });
  const apiBuild = command("A4-api", "API production build", "pnpm", ["--filter", "@workspace/api-server", "build"]);
  const uiBuild = command("A4-ui", "Frontend production build", "pnpm", ["--filter", "@workspace/ayzen", "build"]);
  writeJson("artifacts/release/build-manifest.json", {
    schemaVersion: 1,
    generatedAt: now(),
    status: apiBuild.status === "PASS" && uiBuild.status === "PASS" ? "PASS" : "BLOCKED",
    artifacts: [
      { name: "api-server", path: "artifacts/api-server/dist/index.mjs", exists: exists("artifacts/api-server/dist/index.mjs") },
      { name: "ayzen", path: "artifacts/ayzen/dist/public/index.html", exists: exists("artifacts/ayzen/dist/public/index.html") },
    ],
  });
  check("A4", "Build artifacts are present", exists("artifacts/api-server/dist/index.mjs") && exists("artifacts/ayzen/dist/public/index.html"));
  files("A5", "Clean startup evidence and probes are defined", [
    "docs/operations/build-verification.md",
    "docs/operations/runtime-recovery-runbook.md",
    "apps/api-gateway/src/index.mjs",
    "apps/worker/src/index.mjs",
  ]);
  check("A6", "ZIOX-A certification", allChecks.slice(-6).every((item) => item.status === "PASS"));
});

runPhase(phase("B"), () => {
  command("B1", "Shared platform validator", "pnpm", ["run", "validate:shared-platform-1-30"]);
  command("B2", "API security backbone validator", "pnpm", ["run", "validate:api-security-backbone-1-50"]);
  command("B3", "Policy contract validator", "pnpm", ["run", "validate:policy-contract"]);
  command("B4", "Capability and enforcement validator", "pnpm", ["run", "validate:enforcement"]);
  files("B5", "SIORA boundary is documented", ["docs/security/siora-boundary.md", "packages/authorization/src/index.mjs"]);
  command("B6", "Tenant isolation regression suite", "node", ["--test", "tests/security/tenant-scope.test.mjs", "tests/admin-enforcement/admin-boundary.test.mjs"]);
  command("B7", "Security regression suite", "node", ["--test", "tests/security/backbone-security.test.mjs", "tests/security/step-up-token.test.mjs"]);
  check("B8", "ZIOX-B certification", allChecks.slice(-7).every((item) => item.status === "PASS"));
});

runPhase(phase("C"), () => {
  const migrations = fs.readdirSync(path.join(root, "migrations")).filter((file) => file.endsWith(".sql")).sort();
  const duplicatePrefixes = migrations.map((file) => file.split("_")[0]).filter((value, index, list) => list.indexOf(value) !== index);
  check("C1", "Schema and migration inventory", migrations.length > 0 && duplicatePrefixes.length === 0, { migrationCount: migrations.length, duplicatePrefixes });
  files("C2", "Migration safety runbook and ledger exist", ["docs/operations/migration-runbook.md", "infrastructure/migrations/ledger.json"]);
  files("C3", "Backfill evidence contract exists", ["docs/operations/migration-runbook.md", "tests/restore/restore-evidence.test.mjs"]);
  files("C4", "Backup policy and runbook exist", ["infra/backup/policy.json", "docs/operations/backup-restore-runbook.md"]);
  command("C5", "Restore evidence regression", "node", ["--test", "tests/restore/restore-evidence.test.mjs"]);
  files("C6", "Rollback runbook exists", ["docs/operations/rollback-runbook.md", "infrastructure/deployment/promotion-policy.json"]);
  check("C7", "ZIOX-C certification", allChecks.slice(-6).every((item) => item.status === "PASS"));
});

runPhase(phase("D"), () => {
  command("D1", "Event and backbone contract tests", "node", ["--test", "tests/contracts/platform-contracts.test.mjs", "tests/event-contracts/compatibility.test.mjs"]);
  command("D2", "Workflow and scheduler tests", "node", ["--test", "tests/scheduler/shared-scheduler.test.mjs", "apps/worker/src/schedule-trigger.test.mjs", "apps/worker/src/wait-for-event.test.mjs"]);
  files("D3", "Scheduler reliability implementation exists", ["apps/worker/src/schedule-trigger.mjs", "services/workflow/src/schedules.mjs"]);
  files("D4", "Worker recovery runbook exists", ["docs/operations/runtime-recovery-runbook.md", "apps/worker/src/index.mjs"]);
  files("D5", "Failure drill matrix exists", ["docs/operations/failure-drill-matrix.md", "config/chaos/matrix.json"]);
  files("D6", "Idempotency and resilience contracts exist", ["packages/idempotency/src/index.mjs", "packages/resilience/src/index.mjs"]);
  check("D7", "ZIOX-D certification", allChecks.slice(-6).every((item) => item.status === "PASS"));
});

runPhase(phase("E"), () => {
  const gateway = readText("apps/api-gateway/src/index.mjs");
  const runtime = readText("packages/service-runtime/src/index.mjs");
  check("E1", "Health and metrics probes are implemented", ["/live", "/ready", "/metrics"].every((marker) => gateway.includes(marker) || runtime.includes(marker)));
  check("E2", "Trace and correlation propagation is implemented", exists("packages/tracing/src/index.mjs") && readText("artifacts/api-server/src/lib/trace-context.ts").includes("AsyncLocalStorage"));
  files("E3", "Audit integrity contract exists", ["docs/security/audit-integrity.md", "packages/audit/src/index.mjs"]);
  files("E4", "Intelligence and alerting registry exists", ["config/observability/coverage.json", "infrastructure/platform/alert-routing.json"]);
  files("E5", "Alerting runbook exists", ["docs/operations/alert-runbook.md", "infrastructure/monitoring/alerts.yml"]);
  files("E6", "Admin operations contract exists", ["infrastructure/platform/admin-operations.json", "services/admin/src/index.mjs"]);
  check("E7", "ZIOX-E certification", allChecks.slice(-6).every((item) => item.status === "PASS"));
});

runPhase(phase("F"), () => {
  command("F1", "Cloud hardening validator", "pnpm", ["run", "validate:cloud-phases"]);
  files("F2", "Production configuration contract exists", ["infrastructure/deployment/environment.schema.json", ".env.example"]);
  files("F3", "Deployment topology is defined", ["infrastructure/deployment/topology.yaml", "infrastructure/deployment/service-catalog.json", "infrastructure/docker/docker-compose.yml"]);
  files("F4", "Runtime security controls exist", ["config/cloud/runtime-security.json", "infrastructure/docker/Dockerfile", ".dockerignore"]);
  command("F5", "CI/CD promotion validator", "pnpm", ["run", "validate:cicd-phases"]);
  check("F6", "ZIOX-F certification", allChecks.slice(-5).every((item) => item.status === "PASS"));
});

runPhase(phase("G"), () => {
  files("G1", "Performance baseline is defined", ["docs/operations/performance-baseline.md", "config/slo/gates.json"]);
  files("G2-evidence", "Load and failure matrix evidence is defined", ["tests/load/backbone/README.md", "tests/load/gateway-smoke.js"]);
  command("G2", "Failure-injection contract tests", "node", ["--test", "tests/failure-injection/matrix.test.mjs"], { timeout: 30_000 });
  files("G3", "Backpressure policy exists", ["config/limits/backpressure.json", "packages/backpressure/src/index.mjs"]);
  files("G4", "Abuse protection is documented and implemented", ["docs/security/abuse-protection.md", "packages/rate-limit/src/index.mjs"]);
  files("G5", "AI/resource cost controls exist", ["config/cost-budgets/policy.json", "config/resources/budgets.json"]);
  files("G6", "Capacity model exists", ["docs/operations/capacity-plan.md", "infrastructure/platform/capacity-plan.json"]);
  check("G7", "ZIOX-G certification", allChecks.slice(-6).every((item) => item.status === "PASS"));
});

runPhase(phase("H"), () => {
  const journeys = [
    ["H1", "Identity", "tests/security/backbone-security.test.mjs"],
    ["H2", "Organization and tenant", "tests/security/tenant-scope.test.mjs"],
    ["H3", "Policy and security", "tests/policy/platform-policy.test.mjs"],
    ["H4", "Project and task", "tests/api/compatibility.test.mjs"],
    ["H5", "Event workflow scheduler", "tests/scheduler/shared-scheduler.test.mjs"],
    ["H6", "Credits and subscription", "reports/product-readiness/phase-1-40.json"],
    ["H7", "Vault Telegram Astra", "H7_5_H8_1_SUMMARY.md"],
    ["H8", "Intelligence", "reports/integration/integration-1-30.json"],
    ["H9", "Notification", "config/observability/coverage.json"],
  ];
  for (const [id, name, evidence] of journeys) files(id, `${name} journey evidence`, [evidence]);
  command("H10", "Full regression and UI circuit validator", "pnpm", ["run", "validate:ui-circuit"]);
  files("H11", "E2E certification contract exists", ["tests/e2e/shared-platform/README.md", "tests/e2e/integration/README.md"]);
});

runPhase(phase("I"), () => {
  command("I1", "Immutable release manifest generation", "node", ["scripts/release-manifest.mjs", "--service=monolith", "--output=artifacts/release/release-manifest.json"]);
  files("I2", "Release governance policy exists", ["infrastructure/deployment/promotion-policy.json", "config/release/promotion.json"]);
  files("I3", "Rollout and rollback runbooks exist", ["docs/operations/rollback-runbook.md", "docs/operations/deployment-runbook.md"]);
  files("I4", "Database drill evidence contract exists", ["docs/operations/backup-restore-runbook.md", "tests/restore/restore-evidence.test.mjs"]);
  files("I5", "Runtime drill evidence contract exists", ["docs/operations/failure-drill-matrix.md", "config/chaos/matrix.json"]);
  files("I6", "Identity/security drill evidence contract exists", ["docs/security/incident-response.md", "tests/security/backbone-security.test.mjs"]);
  files("I7", "External dependency drill evidence contract exists", ["docs/operations/failure-drill-matrix.md", "config/chaos/matrix.json"]);
  files("I8", "On-call runbook exists", ["docs/operations/on-call-runbook.md", "docs/operations/production-runbook.md"]);
  check("I9", "ZIOX-I certification", allChecks.slice(-8).every((item) => item.status === "PASS"));
});

runPhase(phase("J"), () => {
  const previous = registry.executionOrder.slice(0, -1).map((id) => readJson(`reports/ziox/${id}-certification.json`));
  const phaseStatuses = Object.fromEntries(previous.map((report) => [report.phase, report.status]));
  check("J1", "Full validator sweep has run", allChecks.length > 0, { phaseStatuses });
  check("J2", "No unresolved critical blocker", failures.length === 0, { blockerCount: failures.length });
  files("J3", "Final security evidence contract exists", ["docs/security/security-model.md", "docs/security/tenant-isolation.md", "docs/security/audit-integrity.md"]);
  files("J4", "Final data safety evidence contract exists", ["docs/operations/backup-restore-runbook.md", "docs/operations/migration-runbook.md", "docs/operations/rollback-runbook.md"]);
  files("J5", "Final runtime evidence contract exists", ["docs/operations/runtime-recovery-runbook.md", "config/resilience/defaults.json"]);
  files("J6", "Final observability evidence contract exists", ["config/observability/coverage.json", "infrastructure/monitoring/prometheus.yml", "infrastructure/monitoring/alerts.yml"]);
  files("J7", "Final performance evidence contract exists", ["docs/operations/performance-baseline.md", "docs/operations/capacity-plan.md"]);
  files("J8", "Final E2E evidence contract exists", ["tests/e2e/shared-platform/README.md", "reports/product-readiness/phase-1-40.json"]);
  files("J9", "Go-live checklist exists", ["docs/operations/go-live-checklist.md"]);
  files("J10", "Canary launch contract exists", ["infrastructure/deployment/promotion-policy.json", "docs/operations/deployment-runbook.md"]);
  files("J11", "Post-launch verification contract exists", ["docs/operations/production-runbook.md", "docs/operations/go-live-checklist.md"]);
  check("J12", "ZIOX final certification", failures.length === 0, { blockerCount: failures.length });
});

const phaseReports = registry.executionOrder.map((id) => readJson(`reports/ziox/${id}-certification.json`));
const finalStatus = phaseReports.every((report) => report.status === "PASS") ? "PASS" : "BLOCKED";
const summary = {
  schemaVersion: 1,
  roadmap: registry.roadmap,
  generatedAt: now(),
  status: finalStatus,
  implementation: finalStatus === "PASS" ? "complete" : "blocked",
  phases: phaseReports.map((report) => ({ phase: report.phase, name: report.name, status: report.status, failures: report.failures.length })),
  failures,
  nextActions: failures.map((item) => ({ id: item.id, action: item.status === "BLOCKED" ? "supply external prerequisite and rerun" : "fix reported failure and rerun" })),
  validator: "scripts/validate-ziox.mjs",
};
writeJson("reports/ziox/J1-final-validator-sweep.json", summary);
writeJson("reports/ziox/final-certification.json", summary);
console.log(JSON.stringify({ status: finalStatus, phases: summary.phases, failures: failures.length, report: "reports/ziox/final-certification.json" }, null, 2));
if (finalStatus !== "PASS") process.exit(1);