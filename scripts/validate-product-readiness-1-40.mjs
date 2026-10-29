#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { calculateReadinessScore } from "../tools/readiness-score/index.mjs";

const root = process.cwd();
const registryPath = "config/product-readiness/roadmap-1-40.json";
const reportPath = "reports/product-readiness/phase-1-40.json";
const failures = [];
const providerGated = [];
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
const registry = readJson(registryPath);
const expected = Array.from({ length: 40 }, (_, index) => index + 1);

if (registry.phaseRange?.join(",") !== "1,40") failures.push("Product readiness registry must cover phases 1 through 40");
if (registry.phases?.map((phase) => phase.phase).join(",") !== expected.join(",")) {
  failures.push("Product readiness registry must contain every phase 1–40 exactly once and in order");
}

for (const phase of registry.phases ?? []) {
  if (phase.status !== registry.completionContract.requiredStatus) failures.push(`Phase ${phase.phase} is not implemented`);
  if (!phase.owner) failures.push(`Phase ${phase.phase} has no owner`);
  for (const evidence of phase.evidence ?? []) {
    if (!fs.existsSync(path.join(root, evidence))) failures.push(`Phase ${phase.phase} missing evidence: ${evidence}`);
  }
  if (registry.completionContract.providerGatedPhases.includes(phase.phase)) providerGated.push(phase.phase);
}

const validators = [
  ["phase-1-15", [process.execPath, "scripts/validate-phase-1-15.mjs"]],
  ["phase-16-25", [process.execPath, "scripts/validate-phase-16-25.mjs"]],
  ["platform", [process.execPath, "scripts/validate-platform-phases.mjs"]],
  ["roadmap-1-50", [process.execPath, "scripts/validate-roadmap-1-50.mjs"]],
  ["enforcement-7-40", [process.execPath, "scripts/validate-enforcement-phases.mjs"]],
  ["cicd", [process.execPath, "scripts/validate-cicd-phases.mjs"]],
  ["api-security-backbone", [process.execPath, "scripts/validate-api-security-backbone-1-50.mjs"]],
  ["production-readiness-evidence", [process.execPath, "scripts/production-readiness-check.mjs"]],
  ["ui-circuit", [process.execPath, "scripts/validate-ui-circuit.mjs"]],
  ["typecheck-libraries", ["pnpm", "typecheck:libs"]],
  ["typecheck-scripts", ["pnpm", "--filter", "@workspace/scripts", "run", "typecheck"]],
];

const validatorResults = validators.map(([name, command]) => {
  const result = spawnSync(command[0], command.slice(1), {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ALLOW_EVENTBUS_NOOP: "true" },
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  const passed = result.status === 0;
  if (!passed) failures.push(`Validator failed: ${name}`);
  return { name, passed, exitCode: result.status, output: output.slice(-1200) };
});

const categories = [
  { id: "architecture-and-circuits", weight: 20, status: validatorResults.find((result) => result.name === "roadmap-1-50")?.passed ? "PASS" : "FAIL" },
  { id: "security-and-authorization", weight: 20, status: validatorResults.find((result) => result.name === "api-security-backbone")?.passed ? "PASS" : "FAIL" },
  { id: "operations-and-recovery", weight: 20, status: validatorResults.find((result) => result.name === "enforcement-7-40")?.passed ? "PASS" : "FAIL" },
  { id: "ui-and-business-journeys", weight: 20, status: validatorResults.find((result) => result.name === "ui-circuit")?.passed ? "PASS" : "FAIL" },
  { id: "build-and-delivery", weight: 20, status: validatorResults.every((result) => result.passed) ? "PASS" : "FAIL" },
];
const scorecard = calculateReadinessScore(categories, failures.length ? [{ type: "build-failure", reason: failures.join("; ") }] : []);
const report = {
  schemaVersion: 1,
  roadmap: registry.roadmap,
  generatedAt: new Date().toISOString(),
  status: failures.length ? "BLOCKED" : scorecard.status,
  score: failures.length ? Math.min(scorecard.score, 99) : scorecard.score,
  implementation: failures.length ? "blocked" : "complete",
  providerGatedPhases: providerGated,
  phaseCount: registry.phases?.length ?? 0,
  failures,
  validators: validatorResults,
  scorecard,
  evidence: { registry: registryPath, sourceDocument: registry.sourceDocument },
};

fs.mkdirSync(path.dirname(path.join(root, reportPath)), { recursive: true });
fs.writeFileSync(path.join(root, reportPath), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({
  status: report.status,
  score: report.score,
  phases: report.phaseCount,
  providerGatedPhases: providerGated,
  failedValidators: validatorResults.filter((result) => !result.passed).map((result) => result.name),
  report: reportPath,
}, null, 2));
if (report.status !== "PASS") process.exit(1);