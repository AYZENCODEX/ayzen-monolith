#!/usr/bin/env node
// VLT-GAP-13-C — CI enforcement wiring.
// Proves the route-thinness scan is a BLOCKING step in every CI pipeline: package scripts point at the real
// scanner, each workflow runs them as plain `run:` steps (no continue-on-error / if / `|| true` / path filter),
// and the job containing them is itself non-skippable.   node validate-vlt-gap-13-C.mjs
import fs from "node:fs";
import path from "node:path";
import { ROOT, rel, rejectBypass, sha256File, binding } from "./gap-common.mjs";

const GAP = "VLT-GAP-13", SUB = "VLT-GAP-13-C";
const OUT = path.join(ROOT, "reports/antas/vault/gap", GAP);
const fail = (m) => { console.error(`${SUB} FAIL — ${m}`); process.exit(1); };
const bad = rejectBypass([]);
if (bad.length) fail(`bypass rejected: ${bad.join(", ")}`);

const SCANNER = "scripts/antas/vault/gap/validate-vlt-gap-13.mjs";
const GATE = "scripts/antas/vault/gap/validate-vlt-gap-13-D.mjs";
const SCRIPTS = {
  "validate:vault-routes": `node ${SCANNER}`,
  "validate:vault-routes:self-test": `node ${SCANNER} --self-test`,
  "validate:vault-routes:differential": "node scripts/antas/vault/gap/differential-vlt-gap-13-E.mjs",
  "validate:vault-routes:ci-wiring": "node scripts/antas/vault/gap/validate-vlt-gap-13-C.mjs",
  "validate:vault-routes:gate": `node ${GATE}`,
};
const WORKFLOWS = [".github/workflows/ci.yml", "ci/enforcement-pipeline.yml"];
const UNSAFE_STEP = /continue-on-error|^\s*(-\s+)?if:|\|\|\s*(true|:|exit\s+0)|;\s*(true|exit\s+0)\s*$|\bset\s+\+e\b/;
const errors = [];

// 1. package.json scripts are exactly the expected commands and the targets exist
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
for (const [name, cmd] of Object.entries(SCRIPTS)) if (pkg.scripts?.[name] !== cmd) errors.push(`package.json script "${name}" is ${JSON.stringify(pkg.scripts?.[name])}, expected ${JSON.stringify(cmd)}`);
for (const f of [SCANNER, GATE, "scripts/antas/vault/gap/differential-vlt-gap-13-E.mjs", "scripts/antas/vault/gap/validate-vlt-gap-13-C.mjs"]) if (!fs.existsSync(path.join(ROOT, f))) errors.push(`missing ${f}`);

// 2. every workflow runs every script as a blocking step
const wfReport = {};
for (const wf of WORKFLOWS) {
  const abs = path.join(ROOT, wf);
  if (!fs.existsSync(abs)) { errors.push(`workflow missing: ${wf}`); continue; }
  const lines = fs.readFileSync(abs, "utf8").split("\n");
  const indentOf = (l) => l.match(/^ */)[0].length;
  // workflow-level: no path filters that could skip the run, and it triggers on PRs
  const text = lines.join("\n");
  if (/^\s+paths(-ignore)?:/m.test(text)) errors.push(`${wf}: a paths/paths-ignore filter can skip the gate`);
  if (!/^\s*pull_request:/m.test(text)) errors.push(`${wf}: does not trigger on pull_request`);
  const found = {};
  for (const name of Object.keys(SCRIPTS)) {
    const want = `pnpm ${name}`;
    const idx = lines.findIndex((l) => new RegExp(`^\\s*-\\s+run:\\s+${want.replace(/[:.]/g, "\\$&")}\\s*$`).test(l));
    if (idx < 0) { errors.push(`${wf}: no \`- run: ${want}\` step`); continue; }
    // step block = this line + following lines indented deeper than the "-"
    const stepIndent = indentOf(lines[idx]);
    const block = [lines[idx]];
    for (let i = idx + 1; i < lines.length && lines[i].trim() !== "" && indentOf(lines[i]) > stepIndent; i++) block.push(lines[i]);
    // a preceding `- name:`/`- if:` item belongs to a different step; but a step whose `run` is a key of a larger map shows up as an indented sibling
    if (block.some((l) => UNSAFE_STEP.test(l))) errors.push(`${wf}: step "${want}" can be skipped/ignored (${block.find((l) => UNSAFE_STEP.test(l)).trim()})`);
    // job block: walk up to `jobs:` child key, then check job-level keys
    let j = idx; while (j >= 0 && !(indentOf(lines[j]) === 2 && /^\s{2}[\w-]+:\s*$/.test(lines[j]))) j--;
    if (j < 0) { errors.push(`${wf}: cannot find job for step "${want}"`); continue; }
    const jobIndent = 2; let k = j + 1;
    for (; k < lines.length && !(lines[k].trim() !== "" && indentOf(lines[k]) <= jobIndent); k++)
      if (indentOf(lines[k]) === jobIndent + 2 && /^\s+(continue-on-error|if):/.test(lines[k])) errors.push(`${wf}: job ${lines[j].trim()} has job-level ${lines[k].trim()} — gate can be skipped`);
    found[name] = { line: idx + 1, job: lines[j].trim().replace(/:$/, "") };
  }
  // scanner and gate must be in the same job (a split would let one be skipped independently)
  const jobs = new Set(Object.values(found).map((f) => f.job));
  if (jobs.size > 1) errors.push(`${wf}: Vault route steps are split across jobs ${[...jobs].join(", ")}`);
  wfReport[wf] = found;
}
// 3. the downstream build job still waits for the job that holds the gate (ci.yml)
const ci = fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
const gateJob = wfReport[".github/workflows/ci.yml"]?.["validate:vault-routes"]?.job;
if (gateJob && !new RegExp(`needs:\\s*\\[?\\s*${gateJob}\\b`).test(ci)) errors.push(`ci.yml: no later job has needs: ${gateJob} — gate does not block build`);

const report = {
  gap: GAP, sub_phase: SUB, checked_at: new Date().toISOString(), validator_version: "13-C.1",
  ...binding(Object.fromEntries([SCANNER, GATE, "package.json", ...WORKFLOWS].filter((f) => fs.existsSync(path.join(ROOT, f))).map((f) => [f, sha256File(path.join(ROOT, f))]))),
  package_scripts: SCRIPTS, workflows: wfReport, errors, status: errors.length ? "FAIL" : "PASS",
};
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "ci-wiring.json"), JSON.stringify(report, null, 2) + "\n");
if (errors.length) { for (const e of errors) console.error(`  ${e}`); fail(`${errors.length} CI wiring problem(s)`); }
console.log(`${SUB} PASS — ${WORKFLOWS.length} pipelines run ${Object.keys(SCRIPTS).length} Vault route steps as blocking steps (${rel(path.join(OUT, "ci-wiring.json"))})`);
