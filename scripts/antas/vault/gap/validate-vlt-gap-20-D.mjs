#!/usr/bin/env node
// VLT-GAP-20-D -- Performance gate: prove the CI gate is real (counterpart of 13-D / 14-D / 16-D).
//   1. the real 20-B gate passes on the real tree and its evidence is fresh (regenerated here, not a stale file)
//   2. scope is complete: every route group expected is profiled, cell count == the 20-A capture, every Vault route file is in a
//      group or a documented exclusion; timing tolerances / reps / allowances are PINNED here, so loosening means editing this gate
//   3. regressions are planted in COPIES OF THE REAL SOURCE (extra query, N+1, extra boundary call, dropped route, added latency,
//      a silent "improvement") and in the gate's own inputs (loosened tolerance, deleted / hand-edited capture): the real 20-B must
//      exit non-zero AND report the intended rule. Negative controls (unmodified copy, behaviour-preserving edit) must still pass.
//   4. bypass flags / env fail closed and do not touch the evidence
//   5. package.json commands + the 20-C CI-wiring validator pass
// Writes reports/antas/vault/gap/VLT-GAP-20/ci-gate.json -- `status` is written by this script only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { ROOT, rel, rejectBypass, sha256File, binding } from "./gap-common.mjs";

const GAP = "VLT-GAP-20", SUB = "VLT-GAP-20-D", started = Date.now();
const OUT = path.join(ROOT, "reports/antas/vault/gap", GAP);
const D = "scripts/antas/vault/gap";
const JUDGE = path.join(ROOT, D, "validate-vlt-gap-20-B.mjs"), WIRING = path.join(ROOT, D, "validate-vlt-gap-20-C.mjs");
const fail = (m) => { console.error(`${SUB} FAIL -- ${m}`); process.exit(1); };
const bad = rejectBypass([]); if (bad.length) fail(`bypass rejected: ${bad.join(", ")}`);
const gcfg = JSON.parse(fs.readFileSync(path.join(ROOT, D, "gap-configs/vault-perf-gate.json"), "utf8"));
const pcfg = JSON.parse(fs.readFileSync(path.join(ROOT, D, "gap-configs/vault-perf.json"), "utf8"));
const ecfg = JSON.parse(fs.readFileSync(path.join(ROOT, D, "gap-configs/vault-equivalence.json"), "utf8"));
const CLEAN_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/(SKIP|BYPASS|DISABLE|FORCE|IGNORE|NOVALIDATE|ASSUME_PASS|CONTINUE_ON_ERROR)/i.test(k)));
const errors = [], need = (c, m) => { if (!c) errors.push(m); };
const tail = (s, n = 2) => String(s).trim().split("\n").slice(-n).join(" | ");
const readJson = (p) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null);
const GATE_REL = `reports/antas/vault/gap/${GAP}/gate.json`;

// -- 1. real gate, fresh evidence ------------------------------------------------------------------------------------------------
const gatePath = path.join(ROOT, GATE_REL);
fs.rmSync(gatePath, { force: true });
const real = spawnSync(process.execPath, [JUDGE], { cwd: ROOT, env: CLEAN_ENV, encoding: "utf8", maxBuffer: 64 << 20 });
need(real.status === 0, `real 20-B exit ${real.status}: ${tail(real.stderr || real.stdout, 3)}`);
const gate = readJson(gatePath);
need(!!gate, "20-B did not regenerate gate.json");
const base = readJson(path.join(OUT, "baseline.json"));
need(base?.status === "PASS" && base.sub === "VLT-GAP-20-A", "20-A capture missing or not PASS");
if (gate) {
  need(gate.status === "PASS" && gate.findings.length === 0, `gate.json status ${gate.status}, ${gate.findings.length} findings`);
  need(gate.regressions.violations === 0 && gate.regressions.n_plus_one_introduced === 0 && gate.regressions.n_plus_one_worsened === 0, `gate.json regressions not zero: ${JSON.stringify(gate.regressions)}`);
  need(gate.statements.old === gate.statements.current && gate.statements.old > 0, `statement totals differ or empty: ${JSON.stringify(gate.statements)}`);
  need(gate.mutations.length >= 10 && gate.mutations.every((m) => m.caught), "20-B judge self-checks missing or not all caught");
  need(base && gate.cells_profiled === base.total_cells && gate.cells_profiled > 0, `cells profiled ${gate.cells_profiled} != capture ${base?.total_cells}`);
}

// -- 2. scope completeness + anti-loosening --------------------------------------------------------------------------------------
const P = gcfg.pins;
const groups = Object.keys(ecfg.groups).filter((g) => g !== "health");
need(JSON.stringify([...groups].sort()) === JSON.stringify([...P.route_groups_expected].sort()), `route groups ${groups.join(",")} != pinned ${P.route_groups_expected.join(",")}`);
for (const g of P.route_groups_expected) { const pg = base?.per_group?.[g]; need(pg && pg.routes > 0 && pg.cells > 0 && pg.statements.old > 0, `group ${g} not captured / vacuous`); }
const SRC = path.join(ROOT, ecfg.src_root);
const coGroups = pcfg.current_only_groups ?? {};
need(JSON.stringify(Object.fromEntries(Object.entries(coGroups).map(([k, v]) => [k, v.files]))) === JSON.stringify(P.current_only_groups), `current_only_groups ${JSON.stringify(Object.keys(coGroups))} != pinned ${JSON.stringify(Object.keys(P.current_only_groups))} (a route with a frozen original must not be moved to current-only to dodge the OLD comparison)`);
for (const g of Object.keys(P.current_only_groups)) { const pg = base?.per_group?.[g]; need(pg && pg.current_only === true && pg.cells > 0 && pg.statements.new > 0, `current-only group ${g} not captured / vacuous`); }
need(JSON.stringify(pcfg.scenario_groups ?? {}) === JSON.stringify(P.scenario_groups), "scenario_groups changed from the gate pin");
const inGroup = new Set([...Object.values(ecfg.groups).flatMap((g) => g.current_files ?? []), ...Object.values(coGroups).flatMap((g) => g.files.map((f) => f.replace(/^routes\//, "routes/")))]);
const NAME = new RegExp(gcfg.route_scope_name_regex), EXCL = gcfg.route_scope_exclusions.map((e) => ({ re: new RegExp(e.file_regex), reason: e.reason }));
const routeScope = [];
for (const f of fs.readdirSync(path.join(SRC, "routes")).filter((n) => n.endsWith(".ts") && NAME.test(n))) {
  const ex = EXCL.find((e) => e.re.test(f)), covered = inGroup.has(`routes/${f}`);
  routeScope.push({ file: `routes/${f}`, in_perf_scope: covered, exclusion: ex?.reason ?? null });
  need(covered || (ex && ex.reason), `route routes/${f} is in no perf group and has no documented exclusion`);
  need(!(covered && ex), `route routes/${f} is both covered and excluded`);
}
need(routeScope.some((r) => r.in_perf_scope), "no Vault routes in perf scope (fail closed)");
for (const [k, v] of Object.entries(P.timing_max)) need(typeof pcfg.timing[k] === "number" && pcfg.timing[k] <= v, `timing.${k} is ${pcfg.timing[k]}, gate pins <= ${v}`);
need(pcfg.reps >= P.min_reps, `reps ${pcfg.reps} < pinned ${P.min_reps}`);
for (const s of P.required_scenarios) need(pcfg.scenarios.includes(s), `scenario ${s} removed (N+1 detection needs it)`);
need(pcfg.n_plus_one?.one_row === "row-db" && pcfg.n_plus_one?.many_rows === "row-db-two-rows", "n_plus_one scenario pair changed");
need((pcfg.intentional_changes ?? []).length <= P.max_intentional_changes, `intentional_changes grew to ${(pcfg.intentional_changes ?? []).length} (gate pins ${P.max_intentional_changes}; a reviewed allowance means editing the pin)`);
const unmeas = Object.values(pcfg.allowed_unmeasurable ?? {}).reduce((n, o) => n + Object.keys(o).length, 0);
need(unmeas <= P.max_unmeasurable_routes, `allowed_unmeasurable grew to ${unmeas} (gate pins ${P.max_unmeasurable_routes})`);

// -- 3. plant regressions in copies of the real tree -----------------------------------------------------------------------------
const copyTree = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "gap20-D-"));
  const skip = (s) => /(^|\/)node_modules(\/|$)|(^|\/)\.git(\/|$)/.test(s);
  for (const p of [D, "artifacts/api-server/src", "reports/antas/vault/gap"]) fs.cpSync(path.join(ROOT, p), path.join(d, p), { recursive: true, filter: (s) => !skip(s) });
  fs.copyFileSync(path.join(ROOT, "package.json"), path.join(d, "package.json"));
  if (fs.existsSync(path.join(ROOT, "node_modules"))) fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(d, "node_modules"), "dir");
  fs.rmSync(path.join(d, GATE_REL), { force: true }); // a stale PASS copied from the real tree must never be mistaken for the child's verdict
  return d;
};
const runChild = (tmp, extraArgs = [], env = CLEAN_ENV) => new Promise((resolve) => {
  const t0 = Date.now(); let so = "", se = "";
  const c = spawn(process.execPath, [path.join(tmp, D, "validate-vlt-gap-20-B.mjs"), ...extraArgs], { cwd: tmp, env });
  c.stdout.on("data", (b) => (so += b)); c.stderr.on("data", (b) => (se += b));
  c.on("close", (code) => { const g = readJson(path.join(tmp, GATE_REL)); resolve({ code, stdout: so, stderr: se, gate: g, rules: [...new Set((g?.findings ?? []).map((f) => f.rule))], ms: Date.now() - t0 }); });
});
const edit = (tmp, file, find, replace) => { const f = path.join(tmp, "artifacts/api-server/src", file); const t = fs.readFileSync(f, "utf8"); const n = t.split(find).length - 1; if (n !== 1) throw new Error(`plant anchor in ${file} matches ${n}x (need exactly 1): ${find.slice(0, 60)}`); fs.writeFileSync(f, t.replace(find, () => replace)); };
const KYC = "vault/application/kyc/entries.ts", MIG = "vault/application/migration/use-cases.ts";
const GET_SEL = "    const result = await selectKycEntryForUser(id, userId);\n    if (!result.rows.length) return { status: 404, body: { error: \"Not found\" } };\n    // Charge-on-success";
const CHARGE = "    const charge = await chargeCredits(userId, \"sylo.kyc_entry_view\");";
const LIST_SEL = "    const result = await selectKycEntries(userId, { category, platform, unused });\n    return { status: 200, body: decryptRows(result.rows as any[], KYC_SENSITIVE_FIELDS) };";
const CASES = [
  { id: "Q1-extra-query", what: "GET /kyc-entries/:id runs its select twice", expect: ["V2_MORE_QUERIES"], apply: (t) => edit(t, KYC, GET_SEL, GET_SEL.replace("    if (!result.rows.length)", "    await selectKycEntryForUser(id, userId);\n    if (!result.rows.length)")) },
  { id: "Q2-n-plus-one", what: "GET /kyc-entries re-reads every row one by one", expect: ["V2_MORE_QUERIES", "V5_N_PLUS_ONE_INTRODUCED"], apply: (t) => edit(t, KYC, LIST_SEL, LIST_SEL.replace("    return {", "    for (const r of result.rows as any[]) await selectKycEntryForUser(r.id, userId);\n    return {")) },
  { id: "Q3-extra-boundary-call", what: "GET /kyc-entries/:id charges credits twice", expect: ["V4_MORE_BOUNDARY_CALLS"], apply: (t) => edit(t, KYC, CHARGE, `${CHARGE}\n    await chargeCredits(userId, "sylo.kyc_entry_view");`) },
  { id: "Q4-extra-decrypt", what: "GET /kyc-entries decrypts the rows twice", expect: ["V4_MORE_BOUNDARY_CALLS"], apply: (t) => edit(t, KYC, LIST_SEL, LIST_SEL.replace("    return {", "    decryptRows(result.rows as any[], KYC_SENSITIVE_FIELDS);\n    return {")) },
  { id: "Q5-route-dropped", what: "GET /kyc-entries no longer served on that path", expect: ["V1_ROUTE_MISSING"], apply: (t) => edit(t, "routes/kyc.ts", 'router.get("/kyc-entries", requireAuth', 'router.get("/kyc-entries-moved", requireAuth') },
  { id: "Q6-latency", what: "GET /kyc-entries spins 40ms on every call", expect: ["V7_LATENCY_TOTAL"], apply: (t) => edit(t, KYC, LIST_SEL, `    const __t0 = performance.now(); while (performance.now() - __t0 < 40) { /* planted */ }\n${LIST_SEL}`) },
  { id: "Q7-silent-improvement", what: "a charge call is removed: fewer calls than the capture must NOT pass silently", expect: ["V6_BASELINE_DRIFT"], apply: (t) => edit(t, KYC, CHARGE, "    const charge = { ok: false } as any;") },
  { id: "Q8-local-account", what: "GET /local-accounts runs its select twice (second group)", expect: ["V2_MORE_QUERIES"], apply: (t) => { const f = "vault/application/local-account/accounts.ts", a = "    const result = await selectLocalAccounts(userId, { category, onlyUnlinked: linkedParam === \"false\", vaultEntryId });"; edit(t, f, a, `${a}\n    await selectLocalAccounts(userId, { category, onlyUnlinked: linkedParam === "false", vaultEntryId });`); } },
  { id: "Q9-entity", what: "GET /vault runs its select twice (third group)", expect: ["V2_MORE_QUERIES"], apply: (t) => { const a = "  const entries = await selectVault(userId);\n  return { status: 200, body: entries.map(e => formatRow(e)) };"; edit(t, "vault/application/entity/lifecycle.ts", a, a.replace("  return", "  await selectVault(userId);\n  return")); } },
  { id: "L1-linked-branch", what: "extra query inside the `row.data_entity_id` re-read branch of POST /kyc-entries (formerly an unreached blind spot)", expect: ["V2_MORE_QUERIES", "V6_BASELINE_DRIFT"], apply: (t) => edit(t, KYC, "    const withData = row.data_entity_id ? await fetchKycEntryWithData(row.id) : row;\n    return { status: 201,", "    const withData = row.data_entity_id ? (await fetchKycEntryWithData(row.id), await fetchKycEntryWithData(row.id)) : row;\n    return { status: 201," ) },
  { id: "M1-migration-export-extra-query", what: "GET /vault/export selects twice (current-only group: no OLD side, only drift)", expect: ["V6_BASELINE_DRIFT"], apply: (t) => edit(t, MIG, "  const rows = await selectVaultEntriesForModule(userId);\n", "  await selectVaultEntriesForModule(userId);\n  const rows = await selectVaultEntriesForModule(userId);\n") },
  { id: "M2-migration-import-extra-insert", what: "POST /vault/import inserts every entry twice", expect: ["V6_BASELINE_DRIFT"], apply: (t) => edit(t, MIG, "      await insertVaultEntriesForModule(values);\n      imported++;", "      await insertVaultEntriesForModule(values);\n      await insertVaultEntriesForModule(values);\n      imported++;") },
  { id: "M3-migration-route-dropped", what: "GET /vault/export removed from both sides: a captured cell must not vanish silently", expect: ["V6_BASELINE_DRIFT"], apply: (t) => edit(t, "routes/vault-migration.ts", 'router.get("/vault/export", requireAuth', 'router.get("/vault/export-moved", requireAuth') },
  { id: "G1-tolerance-loosened", what: "p95/p99/total tolerances raised to hide a slowdown without re-capturing", expect: ["capture-stale"], apply: (t) => { const f = path.join(t, D, "gap-configs/vault-perf.json"); const c = JSON.parse(fs.readFileSync(f, "utf8")); c.timing.p95_factor = 100; c.timing.total_factor = 100; fs.writeFileSync(f, JSON.stringify(c, null, 2)); } },
  { id: "G2-capture-hand-edited", what: "baseline.json edited by hand to match a planted extra query", expect: ["V6_BASELINE_DRIFT"], apply: (t) => { edit(t, KYC, GET_SEL, GET_SEL.replace("    if (!result.rows.length)", "    await selectKycEntryForUser(id, userId);\n    if (!result.rows.length)")); const f = path.join(t, "reports/antas/vault/gap", GAP, "baseline.json"); const b = JSON.parse(fs.readFileSync(f, "utf8")); const cells = b.groups.kyc.cells; for (const [k, c] of Object.entries(cells)) if (k.startsWith("GET /kyc-entries/:id @") && c.new.statements > 0) { c.new.statements += 1; c.new.shapes = { ...c.new.shapes }; } fs.writeFileSync(f, JSON.stringify(b)); }, expectAny: true },
  { id: "G3-capture-deleted", what: "baseline.json deleted: the gate must fail closed, not skip", expect: [], expectStderr: /no 20-A capture/, apply: (t) => fs.rmSync(path.join(t, "reports/antas/vault/gap", GAP, "baseline.json"), { force: true }) },
];
const NEGATIVE = [
  { id: "N1-unmodified-copy", what: "unmodified copy of the real tree", apply: () => {} },
  { id: "N2-behaviour-preserving-edit", what: "comment + dead local added to GET /kyc-entries (no query, call or route change)", apply: (t) => edit(t, KYC, LIST_SEL, `    // planted no-op refactor\n    const __unused = 1; void __unused;\n${LIST_SEL}`) },
];

const pool = async (items, n, fn) => { const out = new Array(items.length); let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } })); return out; };
const runCase = async (c) => { const tmp = copyTree(); try { c.apply(tmp); } catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); return { c, error: String(e.message ?? e) }; } const r = await runChild(tmp); fs.rmSync(tmp, { recursive: true, force: true }); return { c, r }; };

// negative controls run alone (latency judgement should not share the CPU with the plants), then plants in parallel
const negResults = []; for (const n of NEGATIVE) negResults.push(await runCase(n));
const plantResults = await pool(CASES, 3, runCase);

const cases = [];
for (const { c, r, error } of plantResults) {
  if (error) { errors.push(`${c.id}: ${error}`); cases.push({ id: c.id, what: c.what, caught: false, error }); continue; }
  const failed = r.code !== 0 && r.gate?.status !== "PASS";
  let caught = failed;
  if (c.expectStderr) caught = caught && c.expectStderr.test(r.stderr);
  else if (c.expectAny) caught = caught && r.rules.length > 0 && c.expect.every((x) => r.rules.includes(x));
  else caught = caught && c.expect.every((x) => r.rules.includes(x));
  need(caught, `${c.id} (${c.what}) was NOT caught as expected: exit ${r.code}, rules [${r.rules.slice(0, 6).join(",")}] ${tail(r.stderr, 1)}`);
  cases.push({ id: c.id, what: c.what, caught, exit_code: r.code, expected_rules: c.expect, reported_rules: r.rules, seconds: Math.round(r.ms / 100) / 10 });
}
const negatives = [];
for (const { c, r, error } of negResults) {
  if (error) { errors.push(`${c.id}: ${error}`); negatives.push({ id: c.id, what: c.what, passed: false, error }); continue; }
  const ok = r.code === 0 && r.gate?.status === "PASS";
  need(ok, `negative control ${c.id} (${c.what}) must pass but exit ${r.code}: rules [${r.rules.join(",")}] ${tail(r.stderr, 2)}`);
  negatives.push({ id: c.id, what: c.what, passed: ok, exit_code: r.code, seconds: Math.round(r.ms / 100) / 10 });
}

// -- 4. bypass fails closed and leaves the evidence alone --------------------------------------------------------------------------
const before = fs.existsSync(gatePath) ? sha256File(gatePath) : null;
const bypass = [];
for (const [label, args, env] of [["flag --force", ["--force"], CLEAN_ENV], ["flag --skip-validation", ["--skip-validation"], CLEAN_ENV], ["env VALIDATION_DISABLED=true", [], { ...CLEAN_ENV, VALIDATION_DISABLED: "true" }], ["env VAULT_BYPASS=1", [], { ...CLEAN_ENV, VAULT_BYPASS: "1" }]]) {
  const r = spawnSync(process.execPath, [JUDGE, ...args], { cwd: ROOT, env, encoding: "utf8" });
  const ok = r.status !== 0 && /bypass/i.test(r.stderr);
  need(ok, `${label}: expected non-zero exit with "bypass" message, got exit ${r.status}: ${tail(r.stderr, 1)}`);
  bypass.push({ attempt: label, exit_code: r.status, rejected: ok });
}
need(before === null || sha256File(gatePath) === before, "a bypass attempt modified gate.json");

// -- 5. wiring ------------------------------------------------------------------------------------------------------------------------
const w = spawnSync(process.execPath, [WIRING], { cwd: ROOT, env: CLEAN_ENV, encoding: "utf8" });
need(w.status === 0, `20-C CI wiring failed: ${tail(w.stderr || w.stdout, 3)}`);

const files = [JUDGE, WIRING, path.join(ROOT, D, "validate-vlt-gap-20-D.mjs"), path.join(ROOT, D, "perf-common.mjs"), path.join(ROOT, D, "gap-configs/vault-perf.json"), path.join(ROOT, D, "gap-configs/vault-perf-gate.json"), path.join(ROOT, "package.json")];
const report = { gap: GAP, sub: SUB, stage: "ci-gate", checked_at: new Date().toISOString(), ...binding(Object.fromEntries(files.map((f) => [rel(f), sha256File(f)]))), duration_ms: Date.now() - started,
  real_gate: gate ? { status: gate.status, cells_profiled: gate.cells_profiled, statements: gate.statements, regressions: gate.regressions, pre_existing_n_plus_one: gate.pre_existing_n_plus_one?.map((x) => `${x.group}: ${x.route}`) } : null,
  scope: { groups, route_files: routeScope, pins: P },
  planted_regressions: cases, negative_controls: negatives, bypass_attempts: bypass,
  open_residuals: [
    "routes/vault-migration.ts has no frozen pre-extraction original, so it is profiled CURRENT-ONLY (pinned in vault-perf.json + this gate): drift and vanished routes are caught (M1-M3), but OLD-vs-current parity cannot be proven for it.",
    "Branches gated on request/row data the scenarios do not provide are still unprofiled; data_entity_id (kyc, entity-secret, snapshot-trash) is now covered by the perf-only row-db-linked scenario.",
    "Counts are exact for exercised paths; latency is in-memory code-path cost, not Postgres. Plant Q6 proves a 40ms slowdown is seen, not that a 5% one is.",
    "GET /vault/gas-overview never answers under the replay fakes (identical OLD/current, declared in allowed_unmeasurable) and the db-throws scenario is not profiled.",
    "Pre-existing per-row query loops (DELETE /vault/trash, POST /vault/health-check) are unchanged by the extraction and are a performance backlog, not gated here.",
  ],
  errors, status: errors.length ? "FAIL" : "PASS" };
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "ci-gate.json"), JSON.stringify(report, null, 2) + "\n");
if (errors.length) { console.error(`${SUB} FAIL -- ${errors.length} problem(s):`); for (const e of errors.slice(0, 25)) console.error(`  ${e}`); process.exit(1); }
console.log(`${SUB} PASS -- real gate PASS (${gate.cells_profiled} cells); ${cases.length}/${cases.length} planted regressions caught, ${negatives.length}/${negatives.length} negative controls pass, ${bypass.length} bypass attempts rejected; unreached-branch + current-only plants included (${rel(path.join(OUT, "ci-gate.json"))})`);
