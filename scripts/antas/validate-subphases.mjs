#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const manifestPath = "config/antas/subphases.json";
const manifest = JSON.parse(fs.readFileSync(path.join(root, manifestPath), "utf8"));
const failures = [];
const phaseIds = new Set();

const exists = (file) => fs.existsSync(path.join(root, file));
const expectedCount = 69;
if (manifest.subphases?.length !== expectedCount) {
  failures.push(`expected ${expectedCount} ANTAS sub-phases, found ${manifest.subphases?.length ?? 0}`);
}

for (const subphase of manifest.subphases ?? []) {
  if (!/^(?:0[0-9]|1[0-8])\.[1-4]$/.test(subphase.id)) {
    failures.push(`invalid sub-phase id: ${subphase.id}`);
  }
  if (phaseIds.has(subphase.id)) failures.push(`duplicate sub-phase id: ${subphase.id}`);
  phaseIds.add(subphase.id);
  if (!Number.isInteger(subphase.phase) || subphase.phase < 0 || subphase.phase > 18) {
    failures.push(`${subphase.id} has an invalid phase number`);
  }
  if (!subphase.name || !Array.isArray(subphase.evidence) || !subphase.evidence.length) {
    failures.push(`${subphase.id} must declare a name and repository evidence`);
  }
  for (const evidence of subphase.evidence ?? []) {
    if (!exists(evidence)) failures.push(`ANTAS-${subphase.id} missing evidence: ${evidence}`);
  }

  const directory = `reports/antas/ANTAS-${String(subphase.phase).padStart(2, "0")}/subphases`;
  fs.mkdirSync(path.join(root, directory), { recursive: true });
  const missingEvidence = (subphase.evidence ?? []).filter((evidence) => !exists(evidence));
  const report = {
    schemaVersion: 1,
    subphase: `ANTAS-${subphase.id}`,
    phase: `ANTAS-${String(subphase.phase).padStart(2, "0")}`,
    name: subphase.name,
    generatedAt: new Date().toISOString(),
    repositoryStatus: missingEvidence.length ? "BLOCKED" : "PASS",
    runtimeStatus: "UNVERIFIED",
    productionStatus: "UNVERIFIED",
    requiredEvidence: subphase.evidence,
    missingEvidence,
    productionReady: false,
    rule: "Repository evidence does not establish runtime, staging, provider, or production behavior."
  };
  fs.writeFileSync(path.join(root, directory, `${subphase.id}.json`), `${JSON.stringify(report, null, 2)}\n`);
}

const byPhase = Array.from({ length: 19 }, (_, phase) => {
  const items = (manifest.subphases ?? []).filter((subphase) => subphase.phase === phase);
  return {
    phase: `ANTAS-${String(phase).padStart(2, "0")}`,
    subphases: items.length,
    passed: items.filter((subphase) => subphase.evidence.every(exists)).length,
    runtimeUnverified: items.length,
  };
});
for (const phase of byPhase) {
  const directory = `reports/antas/${phase.phase}`;
  fs.mkdirSync(path.join(root, directory), { recursive: true });
  fs.writeFileSync(path.join(root, directory, "subphases-summary.json"), `${JSON.stringify(phase, null, 2)}\n`);
}

const summary = {
  schemaVersion: 1,
  roadmap: "ANTAS",
  generatedAt: new Date().toISOString(),
  subphases: manifest.subphases?.length ?? 0,
  repositoryStatus: failures.length ? "failed" : "implemented",
  runtimeStatus: "UNVERIFIED",
  productionReadiness: "UNVERIFIED",
  failures
};
fs.mkdirSync(path.join(root, "reports/antas"), { recursive: true });
fs.writeFileSync(path.join(root, "reports/antas/subphase-validation.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({
  output: "reports/antas/subphase-validation.json",
  status: summary.repositoryStatus,
  subphases: summary.subphases,
  failures: failures.length
}, null, 2));
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}