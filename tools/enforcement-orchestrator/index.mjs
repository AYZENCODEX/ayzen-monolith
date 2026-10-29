import { readJson, writeReport } from "../enforcement-lib.mjs";

const registry = readJson("infrastructure/platform/phase-7-40.json");
const checks = registry.phases.map((phase) => ({
  phase: phase.phase,
  name: phase.name,
  passed: phase.evidence.every((file) => {
    try { readJson(file); return true; } catch { return false; }
  }),
  evidence: phase.evidence,
}));
const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), status: checks.every((check) => check.passed) ? "passed" : "failed", checks };
writeReport("reports/ci-gates/phase-7-40.json", report);
console.log(JSON.stringify({ status: report.status, phases: checks.length, output: "reports/ci-gates/phase-7-40.json" }, null, 2));
if (report.status !== "passed") process.exit(1);