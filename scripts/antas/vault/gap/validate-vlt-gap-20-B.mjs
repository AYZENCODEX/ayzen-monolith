#!/usr/bin/env node
// VLT-GAP-20-B -- Performance / query-regression JUDGE (Hardening H3).
//   node validate-vlt-gap-20-B.mjs        Writes reports/antas/vault/gap/VLT-GAP-20/gate.json (status written by this script only).
// Re-profiles OLD (frozen) and CURRENT route code and judges them against each other and against the 20-A capture:
//   V1 every OLD route still served          V2 no cell issues more DB statements   V3 no new/grown query shape (per op + table)
//   V4 no more boundary calls (encrypt/audit/event/charge)   V5 no N+1 introduced or worsened (2nd row => extra statements)
//   V6 current counts equal the 20-A capture   V7 handler p50/p95/p99/total within tolerance (retried if ONLY timing fails)
//   V8 stale intentional-change allowances   V9 non-deterministic profile
// Then proves the judge itself: 9 planted regressions, each must be caught by the intended rule, and the control must pass.
import fs from "node:fs";
import path from "node:path";
import { ROOT, rel, rejectBypass, sha256File, binding } from "./gap-common.mjs";
import { profileGroup, pcfg, GAPDIR, judge, timingOnly, perfGroupNames } from "./perf-common.mjs";
import { cfg } from "./equivalence-suite.mjs";

const GAP = "VLT-GAP-20", SUB = "VLT-GAP-20-B", started = Date.now();
const OUT = path.join(ROOT, "reports/antas/vault/gap", GAP);
const fail = (m) => { console.error(`${SUB} FAIL -- ${m}`); process.exit(1); };
const bad = rejectBypass([]); if (bad.length) fail(`bypass rejected: ${bad.join(", ")}`);
for (const [k, v] of Object.entries(process.env)) if (/^(VALIDATION_DISABLED|ANTAS_BYPASS|VLT_BYPASS|VAULT_BYPASS)$/i.test(k) && v && !/^(0|false|no)$/i.test(v)) fail(`bypass rejected: ${k}`);
const findings = []; const need = (c, rule, msg) => { if (!c) findings.push({ rule, message: msg }); };

// 1. the 20-A capture must exist, be a validator-written PASS, and be bound to the current engine/config (fail closed)
const capPath = path.join(OUT, "baseline.json");
if (!fs.existsSync(capPath)) fail("no 20-A capture (run validate-vlt-gap-20-A.mjs) -- fail closed");
const cap = JSON.parse(fs.readFileSync(capPath, "utf8"));
need(cap.status === "PASS" && cap.sub === "VLT-GAP-20-A" && cap.stage === "capture", "capture", "20-A capture is not a PASS capture");
const capFiles = ["perf-common.mjs", "equivalence-replay.mjs", "equivalence-suite.mjs", "harness.mjs", "gap-configs/vault-perf.json", "gap-configs/vault-equivalence.json", "validate-vlt-gap-20-A.mjs"].map((f) => path.join(GAPDIR, f));
const nowBind = binding(Object.fromEntries(capFiles.map((f) => [rel(f), sha256File(f)])));
need(cap.binding?.source_tree_sha256 === nowBind.source_tree_sha256, "capture-stale", "20-A capture was taken with different engine/config files (re-run 20-A, reviewed)");
need(JSON.stringify(cap.scenarios) === JSON.stringify(pcfg.scenarios) && cap.reps === pcfg.reps, "capture-stale", "scenarios/reps changed since the capture");

// 2. fresh profile of every route group, then judge. Counts are deterministic; if ONLY latency fails, re-measure (bounded retries).
const routeGroups = perfGroupNames();
const profileAll = async () => { const cur = {}; for (const g of routeGroups) { const r = await profileGroup(g, pcfg.reps); cur[g] = r; if (r.loadErrors.length) findings.push({ rule: "load", message: `${g}: ${r.loadErrors[0]}` }); } return cur; };
let cur = await profileAll(), res = judge(cur, cap.groups, pcfg), attempts = 1;
while (timingOnly(res.violations) && attempts <= pcfg.timing.retries) { cur = await profileAll(); res = judge(cur, cap.groups, pcfg); attempts++; }
const real = judge(cur, cap.groups, pcfg, { timing: false });
for (const v of res.violations) findings.push({ rule: v.code, message: v.msg });
const totalCells = Object.values(cur).reduce((n, r) => n + Object.keys(r.cells).length, 0);
need(totalCells === cap.total_cells, "coverage", `profiled ${totalCells} cells, capture has ${cap.total_cells}`);
need(totalCells > 0 && res.n_plus_one.old.length >= 0, "coverage", "nothing profiled");

// 3. prove the judge: planted regressions on a deep copy of the real profiles/capture; each must trip the intended rule, control must be clean.
const clone = (x) => structuredClone(x);
const firstKey = (c, pred) => { for (const [g, r] of Object.entries(c)) for (const [k, cell] of Object.entries(r.cells)) if (pred(cell, k)) return [g, k]; return null; };
const mutations = [
  ["control: unmutated profile is clean", "NONE", (c) => c],
  ["one extra DB statement on a current-side cell", "V2_MORE_QUERIES", (c) => { const [g, k] = firstKey(c, (x) => x.new.statements > 0); c[g].cells[k].new.statements += 1; return c; }],
  ["current code issues a query shape OLD never did", "V3_NEW_QUERY_SHAPE", (c) => { const [g, k] = firstKey(c, (x) => x.new.statements > 0); c[g].cells[k].new.shapes["select plantedTable"] = 1; return c; }],
  ["current code encrypts/audits one more time", "V4_MORE_BOUNDARY_CALLS", (c) => { const [g, k] = firstKey(c, (x) => x.new.calls >= 0); c[g].cells[k].new.calls += 1; return c; }],
  ["per-row query planted (N+1) on a route that had none", "V5_N_PLUS_ONE_INTRODUCED", (c) => { const g = "local-account"; const rows = Object.entries(c[g].cells).filter(([k, x]) => k.endsWith(` @ ${pcfg.n_plus_one.one_row}`) && x.new.statements > 0); const [k] = rows[0]; const many = k.replace(pcfg.n_plus_one.one_row, pcfg.n_plus_one.many_rows); c[g].cells[many].new.statements = c[g].cells[k].new.statements + 3; return c; }],
  ["OLD route dropped from current code", "V1_ROUTE_MISSING", (c) => { const g = Object.keys(c)[0]; c[g].new_routes = c[g].new_routes.slice(1); return c; }],
  ["current latency 6x slower on every handler", "V7_LATENCY_TOTAL", (c) => { for (const r of Object.values(c)) for (const x of Object.values(r.cells)) if (x.new) x.new.ms = x.new.ms * 6 + 3; return c; }],
  ["capture edited by hand (counts no longer match reality)", "V6_BASELINE_DRIFT", null],
  ["intentional-change allowance that matches nothing", "V8_STALE_ALLOWANCE", null],
  ["profile differs between two identical runs", "V9_NON_DETERMINISTIC", (c) => { const [g, k] = firstKey(c, () => true); c[g].cells[k].deterministic = false; return c; }],
];
const mutationResults = [];
for (const [name, expect, fn] of mutations) {
  let c = clone(cur), b = clone(cap.groups), cf = clone(pcfg);
  if (name.startsWith("capture edited")) { const [g, k] = firstKey(c, (x) => x.new.statements > 0); b[g].cells[k].new.statements += 5; }
  else if (name.startsWith("intentional-change")) cf.intentional_changes = [{ cell: "entity-secret::GET /nowhere @ row-db", metric: "statements", old: 1, new: 2, reason: "planted" }];
  else c = fn(c);
  const r = judge(c, b, cf);
  const codes = [...new Set(r.violations.map((v) => v.code))];
  const ok = expect === "NONE" ? r.violations.length === 0 : codes.includes(expect);
  mutationResults.push({ mutation: name, expected: expect === "NONE" ? "no violations" : expect, caught: ok, got: codes.slice(0, 4) });
  need(ok, "mutation", `judge did not behave for "${name}": expected ${expect}, got ${codes.join(",") || "nothing"}`);
}

const status = findings.length ? "FAIL" : "PASS";
const hashes = Object.fromEntries([...capFiles, path.join(GAPDIR, "validate-vlt-gap-20-B.mjs"), capPath].map((f) => [rel(f), sha256File(f)]));
const sumSt = (side) => Object.values(cur).reduce((n, r) => n + Object.values(r.cells).reduce((m, c) => m + (c[side]?.statements ?? 0), 0), 0);
const cnt = (code) => res.violations.filter((v) => v.code === code).length;
const report = {
  gap: GAP, sub: SUB, stage: "gate", checked_at: new Date().toISOString(), ...binding(hashes), source_hashes: hashes, duration_ms: Date.now() - started,
  scenarios: pcfg.scenarios, reps: pcfg.reps, cells_profiled: totalCells, timing_attempts: attempts,
  statements: { old: sumSt("old"), current: sumSt("new") },
  regressions: { more_queries: cnt("V2_MORE_QUERIES"), new_query_shapes: cnt("V3_NEW_QUERY_SHAPE"), more_boundary_calls: cnt("V4_MORE_BOUNDARY_CALLS"), n_plus_one_introduced: res.n_plus_one.introduced.length, n_plus_one_worsened: res.n_plus_one.worsened.length, violations: res.violations.length },
  improvements: res.improvements,
  pre_existing_n_plus_one: res.n_plus_one.old.map((x) => ({ ...x, still_in_current: res.n_plus_one.new.some((y) => y.group === x.group && y.route === x.route) })),
  latency_ms: res.latency,
  tolerance: pcfg.timing, intentional_changes: pcfg.intentional_changes,
  unmeasurable_routes: pcfg.allowed_unmeasurable,
  mutations: mutationResults,
  limits: [
    "Counts are exact for what the GAP-15 fakes can drive: canned rows, 1 vs 2 rows to expose per-row querying. A route whose fan-out depends on real data volume (e.g. a loop over 10k rows) shows as N+1 only if its statement count changes between 1 and 2 rows.",
    "Handler time is the CPU/await cost of the code path against in-memory fakes. It is NOT Postgres latency, plans, locks, indexes or payload size; p50/p95/p99 here guard against the extraction adding work, not against slow queries.",
    "GET /vault/gas-overview never answers under the replay fakes (same on OLD and current, declared in vault-perf.json): its statements and timing are not measured.",
    "Pre-existing N+1 shapes (DELETE /vault/trash, POST /vault/health-check) are the same in OLD and current: the extraction did not introduce them and this gate does not fix them; they are listed for a performance backlog.",
    "Only branches the GAP-15 fake rows reach are profiled: e.g. the kyc code that re-reads a data entity runs only when a row carries data_entity_id, which the canned rows do not, so an extra query planted there (tried by hand) is NOT seen. Statement counts on exercised paths are exact (an extra query planted on GET /kyc-entries/:id was caught by V2/V3/V6).",
    "The db-throws scenario is not profiled (error paths short-circuit); its one intentional old/current difference is covered by GAP-15-C.",
    "Judge mutations are planted on the profiles/capture the judge consumes, not on the Vault source; a source-level regression is caught because it changes the profiles.",
  ],
  findings, status,
};
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "gate.json"), JSON.stringify(report, null, 2) + "\n");
if (status !== "PASS") { console.error(`${SUB} FAIL -- ${findings.length} finding(s):`); for (const x of findings.slice(0, 25)) console.error(`  [${x.rule}] ${x.message}`); process.exit(1); }
void real;
console.log(`${SUB} PASS -- ${totalCells} cells: no extra queries/shapes/boundary calls, no N+1 introduced (${report.pre_existing_n_plus_one.length} pre-existing, unchanged), latency within tolerance, ${mutationResults.filter((m) => m.caught).length}/${mutationResults.length} judge checks caught`);
