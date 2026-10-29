#!/usr/bin/env node
// VLT-GAP-15-B -- Equivalence replay: execute FROZEN old code and CURRENT code under identical deterministic fakes and record it.
//   node validate-vlt-gap-15-B.mjs
// B proves the replay is real (executed, deterministic, non-vacuous, every route reached). Judging old==new is 15-C.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, rel, rejectBypass, sha256File, binding } from "./gap-common.mjs";
import { runSuite, cfg, rcfg, GAPDIR, logsOf, dimOf, depthOf, digest } from "./equivalence-suite.mjs";

const GAP = "VLT-GAP-15", SUB = "VLT-GAP-15-B";
const OUT = path.join(ROOT, "reports/antas/vault/gap", GAP);
const fail = (m) => { console.error(`${SUB} FAIL -- ${m}`); process.exit(1); };
const bad = rejectBypass([]); if (bad.length) fail(`bypass rejected: ${bad.join(", ")}`);
const errors = []; const need = (c, m) => { if (!c) errors.push(m); };

// 1. the frozen contract / baselines must still verify (15-A) -- replay is only meaningful against the sealed OLD code
const a = spawnSync(process.execPath, [path.join(GAPDIR, "validate-vlt-gap-15-A.mjs")], { cwd: ROOT, encoding: "utf8" });
need(a.status === 0, `15-A freeze verification failed: ${(a.stderr || a.stdout).trim().split("\n").pop()}`);

// 2. run the replay
const G = await runSuite();
const groups = {};
for (const [g, r] of Object.entries(G)) {
  const names = [...new Set(r.cells.map((c) => c.route))].sort();
  const dims = {}; const deep = new Set();
  for (const c of r.cells) { for (const [l] of logsOf(c)) for (const d of dimOf(l)) dims[d] = (dims[d] ?? 0) + 1; if (depthOf(c).responded) deep.add(c.route); }
  const shallow = names.filter((n) => !deep.has(n));
  const allowed = rcfg.allowed_shallow?.[g] ?? {};
  need(r.cells.length > 0, `${g}: replay executed nothing`);
  need(r.loadErrors.length === 0, `${g}: module load errors: ${r.loadErrors.slice(0, 2).join(" | ")}`);
  need(r.cells.every((c) => c.deterministic), `${g}: non-deterministic replay (${r.cells.filter((c) => !c.deterministic).length} cells)`);
  if (r.kind === "routes") {
    const missing = r.old_routes.filter((k) => !r.new_routes.includes(k));
    need(missing.length === 0, `${g}: routes present in OLD but not current: ${missing.join(", ")}`);
    need(r.cells.every((c) => c.new !== null), `${g}: cells with no current-side recording`);
  }
  for (const s of shallow) need(s in allowed, `${g}: ${s} never produced a real (non-5xx, non-harness-error) response and is not declared in allowed_shallow`);
  for (const k of Object.keys(allowed)) need(shallow.includes(k), `${g}: allowed_shallow lists ${k} but it is no longer shallow -- remove it`);
  groups[g] = { kind: r.kind, routes: names.length, scenarios: new Set(r.cells.map((c) => c.scn)).size, cells: r.cells.length, deterministic_cells: r.cells.filter((c) => c.deterministic).length,
    deep_routes: deep.size, shallow_routes: shallow, observed_dimension_events: dims, cell_digests: Object.fromEntries(r.cells.map((c) => [`${c.route} @ ${c.scn}`, digest(c)])) };
}
need(Object.keys(groups).length === Object.keys(cfg.groups).length, "not every 15-A group was replayed");

// 3. record the state of the older module-level differentials (they are evidence only while they still run against the current tree)
const legacy = {};
for (const s of rcfg.legacy_differentials) {
  const r = spawnSync(process.execPath, [path.join(GAPDIR, s)], { cwd: ROOT, encoding: "utf8", timeout: 120000 });
  legacy[s] = { exit: r.status, status: r.status === 0 ? "PASS" : "STALE_OR_FAILING", last_line: ((r.stdout + r.stderr).trim().split("\n").pop() ?? "").slice(0, 160) };
}

const files = ["equivalence-replay.mjs", "equivalence-suite.mjs", "harness.mjs", "gap-configs/vault-equivalence.json", "gap-configs/vault-equivalence-replay.json", "validate-vlt-gap-15-B.mjs"].map((f) => path.join(GAPDIR, f));
const report = { gap: GAP, sub: SUB, stage: "replay", checked_at: new Date().toISOString(),
  total_cells: Object.values(groups).reduce((n, g) => n + g.cells, 0), groups, legacy_differentials: legacy,
  boundaries_faked_identically_on_both_sides: Object.keys(rcfg.boundaries), unreachable_scenarios_dropped: rcfg.unreachable_scenarios_dropped,
  not_proven_here: "internals of the faked boundary modules (see residual_unexercised in 15-C); judging old==new is 15-C",
  binding: binding(Object.fromEntries(files.map((f) => [rel(f), sha256File(f)]))), errors, status: errors.length ? "FAIL" : "PASS" };
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "replay.json"), JSON.stringify(report, null, 2) + "\n");
if (errors.length) { for (const e of errors) console.error(`  - ${e}`); fail(`${errors.length} problem(s)`); }
console.log(`${SUB} PASS -- ${report.total_cells} cells replayed across ${Object.keys(groups).length} groups; legacy differentials: ${Object.entries(legacy).map(([k, v]) => `${k.replace(/^differential-vlt-gap-|\.mjs$/g, "")}=${v.status}`).join(" ")}`);
