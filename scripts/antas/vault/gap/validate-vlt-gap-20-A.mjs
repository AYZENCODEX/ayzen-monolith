#!/usr/bin/env node
// VLT-GAP-20-A -- Performance / query-regression CAPTURE (Hardening H3).
//   node validate-vlt-gap-20-A.mjs
// Runs the FROZEN pre-extraction route code and the CURRENT route code under the GAP-15 deterministic fakes, per route x scenario, and records
// the query profile (DB round trips, per-table shapes, boundary calls) and handler timing of both. One capture, written once; 20-B judges it.
// Proves here (not judged): the capture is real -- executed, deterministic, non-vacuous, every route reached, every unmeasurable route declared.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, rel, rejectBypass, sha256File, binding } from "./gap-common.mjs";
import { profileGroup, pcfg, GAPDIR, nPlusOne, latency, statementsTotal, perfGroupNames, currentOnlyGroups } from "./perf-common.mjs";
import { cfg } from "./equivalence-suite.mjs";

const GAP = "VLT-GAP-20", SUB = "VLT-GAP-20-A";
const OUT = path.join(ROOT, "reports/antas/vault/gap", GAP);
const fail = (m) => { console.error(`${SUB} FAIL -- ${m}`); process.exit(1); };
const bad = rejectBypass([]); if (bad.length) fail(`bypass rejected: ${bad.join(", ")}`);
const errors = []; const need = (c, m) => { if (!c) errors.push(m); };

// 1. the frozen OLD sources must still verify (15-A) -- the capture is only meaningful against the sealed pre-extraction code
const a = spawnSync(process.execPath, [path.join(GAPDIR, "validate-vlt-gap-15-A.mjs")], { cwd: ROOT, encoding: "utf8" });
need(a.status === 0, `15-A freeze verification failed: ${(a.stderr || a.stdout).trim().split("\n").pop()}`);
need(Array.isArray(pcfg.scenarios) && pcfg.scenarios.length >= 3 && pcfg.reps >= 5, "vault-perf.json: scenarios/reps too small to be a capture");

// 2. profile every route group (the health group is a module differential, not a route surface -- covered by GAP-19 / 15)
const groups = {}, perGroup = {};
for (const g of perfGroupNames()) {
  const r = await profileGroup(g, pcfg.reps);
  need(r.loadErrors.length === 0, `${g}: module load errors: ${r.loadErrors.slice(0, 2).join(" | ")}`);
  need(Object.keys(r.cells).length > 0, `${g}: capture executed nothing`);
  need(statementsTotal(r.cells, "old") > 0 && statementsTotal(r.cells, "new") > 0, `${g}: no DB statement observed on one side (vacuous capture)`);
  need(r.old_routes.every((k) => r.new_routes.includes(k)), `${g}: routes in OLD but not current: ${r.old_routes.filter((k) => !r.new_routes.includes(k)).join(", ")}`);
  need(Object.values(r.cells).every((c) => c.new && c.deterministic), `${g}: current-side profile missing or non-deterministic`);
  // routes whose handler never answers under the fakes are not timed; each must be declared and identical on both sides
  const unmeas = Object.entries(r.cells).filter(([, c]) => c.old.threw === "PERF_TIMEOUT" || c.new?.threw === "PERF_TIMEOUT");
  const declared = pcfg.allowed_unmeasurable?.[g] ?? {};
  const names = [...new Set(unmeas.map(([k]) => k.split(" @ ")[0]))];
  for (const [k, c] of unmeas) need(c.old.threw === c.new?.threw, `${g}: ${k} times out on one side only`);
  for (const n of names) need(n in declared, `${g}: ${n} never answers under the fakes and is not declared in allowed_unmeasurable`);
  for (const n of Object.keys(declared)) need(names.includes(n), `${g}: allowed_unmeasurable lists ${n} but it answers now -- remove it`);
  const np = nPlusOne(r.cells);
  groups[g] = { cells: Object.fromEntries(Object.entries(r.cells).map(([k, c]) => [k, { old: c.old, new: c.new, deterministic: c.deterministic }])) };
  perGroup[g] = { current_only: !!currentOnlyGroups()[g], routes: r.old_routes.length, cells: Object.keys(r.cells).length, statements: { old: statementsTotal(r.cells, "old"), new: statementsTotal(r.cells, "new") },
    latency: { old: latency(r.cells, "old"), new: latency(r.cells, "new") }, unmeasurable_routes: names, n_plus_one: { old: np.old, new: np.new } };
}
need(Object.keys(groups).length === perfGroupNames().length, "not every route group was captured");
const totalCells = Object.values(groups).reduce((n, g) => n + Object.keys(g.cells).length, 0);

const files = ["perf-common.mjs", "equivalence-replay.mjs", "equivalence-suite.mjs", "harness.mjs", "gap-configs/vault-perf.json", "gap-configs/vault-equivalence.json", "validate-vlt-gap-20-A.mjs"].map((f) => path.join(GAPDIR, f));
const report = { gap: GAP, sub: SUB, stage: "capture", checked_at: new Date().toISOString(), scenarios: pcfg.scenarios, reps: pcfg.reps, total_cells: totalCells,
  method: "frozen pre-extraction route files vs current route files, identical deterministic fakes (GAP-15 engine); statements counted per DB call, N+1 = extra statements for a second row; handler wall time = median of reps, old/new interleaved",
  per_group: perGroup, groups,
  not_measured: "real Postgres latency, plans, locks, indexes, network, payload size; the fakes return canned rows so row-count scaling is probed with 1 vs 2 rows only; judging old vs new is 20-B",
  binding: binding(Object.fromEntries(files.map((f) => [rel(f), sha256File(f)]))), errors, status: errors.length ? "FAIL" : "PASS" };
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "baseline.json"), JSON.stringify(report, null, 2) + "\n");
if (errors.length) { for (const e of errors) console.error(`  - ${e}`); fail(`${errors.length} problem(s)`); }
console.log(`${SUB} PASS -- ${totalCells} cells over ${Object.keys(groups).length} groups captured (old + current), deterministic, every OLD route reached`);
