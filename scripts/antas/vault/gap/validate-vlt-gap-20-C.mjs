#!/usr/bin/env node
// VLT-GAP-20-C -- Performance gate CI enforcement wiring.
// Proves the perf / query-regression gate is a BLOCKING step in every CI pipeline: package scripts point at the real validators,
// each workflow runs them as plain `run:` steps (no continue-on-error / if / `|| true` / path filter), the job holding them is itself
// non-skippable, and the capture script (which rewrites the baseline) is NEVER run in CI.   node validate-vlt-gap-20-C.mjs
import fs from "node:fs";
import path from "node:path";
import { ROOT, rel, rejectBypass, sha256File, binding } from "./gap-common.mjs";

const GAP = "VLT-GAP-20", SUB = "VLT-GAP-20-C";
const OUT = path.join(ROOT, "reports/antas/vault/gap", GAP);
const fail = (m) => { console.error(`${SUB} FAIL -- ${m}`); process.exit(1); };
const bad = rejectBypass([]); if (bad.length) fail(`bypass rejected: ${bad.join(", ")}`);

const D = "scripts/antas/vault/gap";
const SCRIPTS = {
  "validate:vault-perf": `node ${D}/validate-vlt-gap-20-B.mjs`,
  "validate:vault-perf:ci-wiring": `node ${D}/validate-vlt-gap-20-C.mjs`,
  "validate:vault-perf:gate": `node ${D}/validate-vlt-gap-20-D.mjs`,
};
const CAPTURE = { name: "capture:vault-perf", cmd: `node ${D}/validate-vlt-gap-20-A.mjs` };
const WORKFLOWS = [".github/workflows/ci.yml", "ci/enforcement-pipeline.yml"];
const UNSAFE_STEP = /continue-on-error|^\s*(-\s+)?if:|\|\|\s*(true|:|exit\s+0)|;\s*(true|exit\s+0)\s*$|\bset\s+\+e\b/;
const errors = [];

// 1. package.json scripts are exactly the expected commands and the targets exist; capture stays a manual, reviewed command
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
for (const [name, cmd] of Object.entries(SCRIPTS)) if (pkg.scripts?.[name] !== cmd) errors.push(`package.json script "${name}" is ${JSON.stringify(pkg.scripts?.[name])}, expected ${JSON.stringify(cmd)}`);
if (pkg.scripts?.[CAPTURE.name] !== CAPTURE.cmd) errors.push(`package.json script "${CAPTURE.name}" is ${JSON.stringify(pkg.scripts?.[CAPTURE.name])}, expected ${JSON.stringify(CAPTURE.cmd)}`);
for (const f of [...Object.values(SCRIPTS).map((c) => c.replace(/^node /, "")), CAPTURE.cmd.replace(/^node /, ""), `${D}/perf-common.mjs`, `${D}/gap-configs/vault-perf.json`, `${D}/gap-configs/vault-perf-gate.json`]) if (!fs.existsSync(path.join(ROOT, f))) errors.push(`missing ${f}`);
// no other package script may chain the capture (it would let a pipeline re-baseline itself and make the drift check vacuous)
for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) if (name !== CAPTURE.name && /validate-vlt-gap-20-A|capture:vault-perf/.test(cmd)) errors.push(`package.json script "${name}" runs the 20-A capture`);

// 2. every workflow runs every script as a blocking step
const wfReport = {};
for (const wf of WORKFLOWS) {
  const abs = path.join(ROOT, wf);
  if (!fs.existsSync(abs)) { errors.push(`workflow missing: ${wf}`); continue; }
  const lines = fs.readFileSync(abs, "utf8").split("\n");
  const indentOf = (l) => l.match(/^ */)[0].length;
  const text = lines.join("\n");
  if (/^\s+paths(-ignore)?:/m.test(text)) errors.push(`${wf}: a paths/paths-ignore filter can skip the gate`);
  if (!/^\s*pull_request:/m.test(text)) errors.push(`${wf}: does not trigger on pull_request`);
  if (/capture:vault-perf|validate-vlt-gap-20-A/.test(text)) errors.push(`${wf}: runs the 20-A capture (re-baselines itself); capture is a reviewed manual command`);
  const found = {};
  for (const name of Object.keys(SCRIPTS)) {
    const want = `pnpm ${name}`;
    const idx = lines.findIndex((l) => new RegExp(`^\\s*-\\s+run:\\s+${want.replace(/[:.]/g, "\\$&")}\\s*$`).test(l));
    if (idx < 0) { errors.push(`${wf}: no \`- run: ${want}\` step`); continue; }
    const stepIndent = indentOf(lines[idx]);
    const block = [lines[idx]];
    for (let i = idx + 1; i < lines.length && lines[i].trim() !== "" && indentOf(lines[i]) > stepIndent; i++) block.push(lines[i]);
    if (block.some((l) => UNSAFE_STEP.test(l))) errors.push(`${wf}: step "${want}" can be skipped/ignored (${block.find((l) => UNSAFE_STEP.test(l)).trim()})`);
    let j = idx; while (j >= 0 && !(indentOf(lines[j]) === 2 && /^\s{2}[\w-]+:\s*$/.test(lines[j]))) j--;
    if (j < 0) { errors.push(`${wf}: cannot find job for step "${want}"`); continue; }
    const jobIndent = 2; let k = j + 1;
    for (; k < lines.length && !(lines[k].trim() !== "" && indentOf(lines[k]) <= jobIndent); k++)
      if (indentOf(lines[k]) === jobIndent + 2 && /^\s+(continue-on-error|if):/.test(lines[k])) errors.push(`${wf}: job ${lines[j].trim()} has job-level ${lines[k].trim()} -- gate can be skipped`);
    found[name] = { line: idx + 1, job: lines[j].trim().replace(/:$/, "") };
  }
  const jobs = new Set(Object.values(found).map((f) => f.job));
  if (jobs.size > 1) errors.push(`${wf}: Vault perf steps are split across jobs ${[...jobs].join(", ")}`);
  // order: judge before its own wiring/gate checks, and all three after the GAP-19 chaos gate (perf is judged on code that already survived chaos)
  const L = (n) => found[n]?.line ?? -1, chaos = lines.findIndex((l) => /^\s*-\s+run:\s+pnpm validate:vault-chaos\s*$/.test(l)) + 1;
  if (chaos <= 0) errors.push(`${wf}: GAP-19 chaos step not found (perf must run after it)`);
  else if (Object.keys(SCRIPTS).some((n) => L(n) > 0 && L(n) < chaos)) errors.push(`${wf}: a perf step runs before the GAP-19 chaos gate`);
  if (L("validate:vault-perf") > 0 && (L("validate:vault-perf:ci-wiring") < L("validate:vault-perf") || L("validate:vault-perf:gate") < L("validate:vault-perf:ci-wiring"))) errors.push(`${wf}: perf steps out of order (expected judge, ci-wiring, gate)`);
  wfReport[wf] = found;
}
// 3. the downstream build job still waits for the job that holds the gate (ci.yml)
const ci = fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
const gateJob = wfReport[".github/workflows/ci.yml"]?.["validate:vault-perf"]?.job;
if (gateJob && !new RegExp(`needs:\\s*\\[?\\s*${gateJob}\\b`).test(ci)) errors.push(`ci.yml: no later job has needs: ${gateJob} -- gate does not block build`);

const files = [...Object.values(SCRIPTS).map((c) => c.replace(/^node /, "")), "package.json", ...WORKFLOWS].filter((f) => fs.existsSync(path.join(ROOT, f)));
const report = { gap: GAP, sub_phase: SUB, checked_at: new Date().toISOString(), validator_version: "20-C.1",
  ...binding(Object.fromEntries(files.map((f) => [f, sha256File(path.join(ROOT, f))]))),
  package_scripts: SCRIPTS, capture_script_not_in_ci: !errors.some((e) => /capture/.test(e)), workflows: wfReport, errors, status: errors.length ? "FAIL" : "PASS" };
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "ci-wiring.json"), JSON.stringify(report, null, 2) + "\n");
if (errors.length) { for (const e of errors) console.error(`  ${e}`); fail(`${errors.length} CI wiring problem(s)`); }
console.log(`${SUB} PASS -- ${WORKFLOWS.length} pipelines run ${Object.keys(SCRIPTS).length} Vault perf steps as blocking steps after GAP-19; capture never runs in CI (${rel(path.join(OUT, "ci-wiring.json"))})`);
