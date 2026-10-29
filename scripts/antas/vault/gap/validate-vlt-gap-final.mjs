#!/usr/bin/env node
// VLT-GAP-21 -- FINAL SOURCE-TRUTH CERTIFICATION.   node validate-vlt-gap-final.mjs
// Executes (does not read) every live Vault gate in a CLEAN COPY of the tree (requirement 15), verifies the recorded evidence of the point-in-time
// sub-phase gates (GAP-00..12: they need git HEAD / sealed pre-state, so they cannot be re-run on today's tree), runs build + the test suites in the real
// tree, and refuses PASS while the migration map still carries pending / UNCERTIFIED / origin-unproven rows. `status` is written by this script only.
// Fails closed: a gate that cannot run (e.g. no node_modules / pnpm for build+tests) is NOT_EXECUTED and the certificate is FAIL.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { ROOT, rel, rejectBypass, sha256File, binding } from "./gap-common.mjs";

const GAP = "VLT-GAP-21", started = Date.now();
const OUT = path.join(ROOT, "reports/antas/vault/gap", GAP);
const fail = (m) => { console.error(`${GAP} FAIL -- ${m}`); process.exit(1); };
const bad = rejectBypass([]); if (bad.length) fail(`bypass rejected: ${bad.join(", ")}`);
if (process.env.VLT_GAP21_ACTIVE) fail("recursive invocation: the final validator is already running");
const CLEAN_ENV = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/(SKIP|BYPASS|DISABLE|FORCE|IGNORE|NOVALIDATE|ASSUME_PASS|CONTINUE_ON_ERROR)/i.test(k))), VLT_GAP21_ACTIVE: "1" };
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const tail = (s, n = 2) => String(s).trim().split("\n").slice(-n).join(" | ").slice(0, 400);

// ── 1. the live gates, derived from package.json (the CI contract), never from a private list ──────────────────────────────────────────────────────
// excluded: capture/seal/generate scripts REWRITE evidence (they are reviewed manual commands, not gates); `validate:vault` is the pre-GAP certification
const NOT_GATES = /^(capture:|seal:|generate:|validate:vault-final$)/; // the final validator must never run itself (it would recurse)
const live = Object.entries(pkg.scripts).filter(([k, v]) => /^validate:vault-/.test(k) && !NOT_GATES.test(k) && /^node scripts\/antas\/vault\/gap\//.test(v)).map(([name, cmd]) => ({ name, cmd }));
// requirement -> the gates that prove it (every name must exist in package.json, else the requirement is unproven)
const REQ = [
  [1, "all GAP validators execute and PASS", live.map((g) => g.name)],
  [4, "source graph", ["validate:vault-architecture", "validate:vault-architecture:gate"]],
  [5, "route thinness", ["validate:vault-routes", "validate:vault-routes:gate", "validate:vault-routes:differential"]],
  [6, "duplicate scan", ["validate:vault-duplicates", "validate:vault-duplicates:gate"]],
  [7, "migration map", ["validate:vault-map"]],
  [8, "security (behaviour/API equivalence incl. tenant isolation)", ["validate:vault-equivalence:compare", "validate:vault-equivalence:gate"]],
  [9, "crypto compatibility (replay + backup envelope)", ["validate:vault-equivalence:replay", "validate:vault-equivalence:backup"]],
  [10, "backup/restore", ["validate:vault-equivalence:backup"]],
  [11, "snapshot/restore", ["validate:vault-equivalence:compare"]],
  [12, "runtime/chaos", ["validate:vault-chaos"]],
  [13, "performance", ["validate:vault-perf", "validate:vault-perf:gate"]],
  [14, "fake-PASS / tamper", ["validate:vault-tamper"]],
];
const SERIAL = new Set(["validate:vault-perf", "validate:vault-perf:gate", "validate:vault-chaos", "validate:vault-tamper"]); // timing-sensitive or itself spawns trees: run alone, last

const copyTree = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "gap21-clean-"));
  fs.cpSync(ROOT, d, { recursive: true, filter: (s) => !/(^|\/)(node_modules|\.git)(\/|$)|reports\/antas\/vault\/gap\/VLT-GAP-21(\/|$)/.test(s) });
  if (fs.existsSync(path.join(ROOT, "node_modules"))) fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(d, "node_modules"), "dir");
  return d;
};
const run = (cwd, cmd) => new Promise((resolve) => {
  const t0 = Date.now(); let so = "", se = "";
  const c = spawn("sh", ["-c", cmd], { cwd, env: CLEAN_ENV });
  c.stdout.on("data", (b) => (so += b)); c.stderr.on("data", (b) => (se += b));
  c.on("close", (code) => resolve({ code, out: so, err: se, ms: Date.now() - t0 }));
  c.on("error", (e) => resolve({ code: 127, out: so, err: String(e), ms: Date.now() - t0 }));
});
const pool = async (items, n, fn) => { const out = new Array(items.length); let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } })); return out; };

const blockers = [];
const block = (b) => blockers.push(b);
const clean = copyTree();
const results = {};
try {
  const parallel = live.filter((g) => !SERIAL.has(g.name)), serial = live.filter((g) => SERIAL.has(g.name));
  const exec = async (g) => { const r = await run(clean, g.cmd); results[g.name] = { command: g.cmd, exit_code: r.code, executed: true, passed: r.code === 0, seconds: Math.round(r.ms / 100) / 10, last_line: tail(r.err || r.out, 1) }; };
  await pool(parallel, 3, exec);
  for (const g of serial) await exec(g);
} finally { /* keep the copy for map-check evidence below, removed after */ }

// ── 2. the migration map's own open items (read from the CLEAN-COPY run of 17, not from the committed file) ─────────────────────────────────────────
const mapCheck = (() => { try { return JSON.parse(fs.readFileSync(path.join(clean, "reports/antas/vault/gap/VLT-GAP-17/map-check.json"), "utf8")); } catch { return null; } })();
const open = mapCheck?.open_items ?? null;
if (!open) block({ id: "map-open-items-unreadable", detail: "VLT-GAP-17 map-check.json missing after the clean run" });
else {
  if (open.pending_rows.length) block({ id: "pending-rows", detail: `${open.pending_rows.length} migration-map row(s) still IMPLEMENTED/pending (lines ${open.pending_rows.join(",")})`, fix: "run the GAP-07 validation for packages/vault-crypto and let the map generator promote the row" });
  if (open.uncertified_rows.length) block({ id: "uncertified-rows", detail: `${open.uncertified_rows.length} row(s) cite evidence that is not PASS / has no retire proof (lines ${open.uncertified_rows.join(",")})`, fix: "GAP-08/09: no reproducible retire proof (later GAPs legitimately edited the moved files); GAP-04: recorded evidence FAIL. Re-certify against the current tree, do not hand-edit the map" });
  if (open.origin_unproven_files.length) block({ id: "origin-unproven-files", detail: `${open.origin_unproven_files.length} NEW-SEAM file(s) with no proven origin: ${open.origin_unproven_files.map((f) => path.basename(f)).join(", ")}`, fix: "prove each is extracted code or new seam with an owner; or retire it" });
}
fs.rmSync(clean, { recursive: true, force: true });

// ── 3. recorded evidence of the point-in-time gates (GAP-00..12) + non-PASS sweep over everything recorded ─────────────────────────────────────────
const EV = path.join(ROOT, "reports/antas/vault");
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(".json") ? [path.join(d, e.name)] : []));
const nonPass = [], supersededNonPass = [], perGap = {};
const currentGap04Proof = mapCheck?.evidence?.["04"]?.current_proof?.status === "PASS";
for (const f of walk(EV)) {
  if (/\/VLT-GAP-21\//.test(f)) continue; // this validator's own output
  let j; try { j = JSON.parse(fs.readFileSync(f, "utf8")); } catch { nonPass.push({ file: rel(f), status: "UNPARSEABLE" }); continue; }
  if (!j || typeof j !== "object" || !("status" in j)) continue;
  const m = rel(f).match(/VLT-GAP-(\d\d)\b/) ?? rel(f).match(/antas\/vault\/(\d\d)\//); const g = m?.[1];
  if (g) (perGap[g] ??= { files: 0, pass: 0 }), perGap[g].files++, j.status === "PASS" && perGap[g].pass++;
  if (j.status !== "PASS") {
    const record = { file: rel(f), status: j.status };
    if (g === "04" && currentGap04Proof) supersededNonPass.push({ ...record, reason: "Historical GAP-04 evidence is superseded by the fresh GAP-13 game-route scan and GAP-15-D equivalence gate recorded in the current map-check." });
    else nonPass.push(record);
  }
}
for (let n = 0; n <= 20; n++) { const g = String(n).padStart(2, "0"); if (n === 0 || n === 7 || n === 21) continue; if (!perGap[g]?.files) block({ id: `no-evidence-gap-${g}`, detail: `no recorded evidence for GAP-${g}` }); }
for (const np of nonPass) block({ id: "recorded-evidence-not-pass", detail: `${np.file} is ${np.status}` });

// ── 4. every requirement's gates executed and passed ──────────────────────────────────────────────────────────────────────────────────────────────
const requirements = REQ.map(([n, what, names]) => {
  const missing = names.filter((x) => !results[x]), failed = names.filter((x) => results[x] && !results[x].passed);
  const ok = names.length > 0 && !missing.length && !failed.length;
  if (!ok) block({ id: `requirement-${n}`, detail: `${what}: ${missing.length ? `not executed: ${missing.join(", ")}` : ""}${failed.length ? ` failed: ${failed.map((f) => `${f} (${results[f].last_line})`).join("; ")}` : ""}`.trim() });
  return { n, what, gates: names, status: ok ? "PASS" : "FAIL" };
});

// ── 5. build + tests (requirements 2, 3) in the real tree ─────────────────────────────────────────────────────────────────────────────────────────
const hasPnpm = spawnSync("sh", ["-c", "command -v pnpm"], { encoding: "utf8" }).status === 0, hasDeps = fs.existsSync(path.join(ROOT, "node_modules"));
const apiPkg = JSON.parse(fs.readFileSync(path.join(ROOT, "artifacts/api-server/package.json"), "utf8"));
const BT = [
  [2, "full build (typecheck + build)", "pnpm run build"],
  [3, "unit/integration/contract suites", [ "pnpm -r --if-present run test", ...Object.keys(apiPkg.scripts ?? {}).filter((k) => /^test(:|$)/.test(k)).map((k) => `pnpm --filter ./artifacts/api-server run ${k}`) ].join(" && ")],
];
const buildTest = [];
for (const [n, what, cmd] of BT) {
  if (!hasPnpm || !hasDeps) { buildTest.push({ n, what, command: cmd, executed: false, status: "NOT_EXECUTED", reason: `${!hasPnpm ? "pnpm not available" : ""}${!hasPnpm && !hasDeps ? "; " : ""}${!hasDeps ? "node_modules not installed" : ""}` }); block({ id: `requirement-${n}`, detail: `${what}: NOT_EXECUTED (${!hasPnpm ? "pnpm not available" : "node_modules not installed"}); run in an installed checkout / CI` }); continue; }
  const r = await run(ROOT, cmd);
  buildTest.push({ n, what, command: cmd, executed: true, exit_code: r.code, seconds: Math.round(r.ms / 100) / 10, status: r.code === 0 ? "PASS" : "FAIL", last_line: tail(r.err || r.out, 1) });
  if (r.code !== 0) block({ id: `requirement-${n}`, detail: `${what} failed: ${tail(r.err || r.out, 1)}` });
}

// ── 6. certificate (status computed here, never edited) ───────────────────────────────────────────────────────────────────────────────────────────
const passed = (...names) => names.every((x) => results[x]?.passed);
const zero = (...names) => (passed(...names) ? 0 : null); // 0 only if the gates that measure it ran and passed; null = unproven (never reported as 0)
const certificate = {
  status: blockers.length ? "FAIL" : "PASS",
  source_of_truth_verified: !blockers.length,
  all_required_validators_executed: live.every((g) => results[g.name]?.executed) && buildTest.every((b) => b.executed),
  extraction_proof: passed("validate:vault-map") && !(open?.uncertified_rows.length || open?.pending_rows.length || open?.origin_unproven_files.length),
  route_thinness_proof: passed("validate:vault-routes", "validate:vault-routes:gate"),
  duplicate_business_implementations: zero("validate:vault-duplicates", "validate:vault-duplicates:gate"),
  unexpected_legacy_consumers: zero("validate:vault-architecture", "validate:vault-routes"),
  forbidden_imports: zero("validate:vault-architecture", "validate:vault-architecture:gate"),
  behavior_regressions: zero("validate:vault-equivalence:compare", "validate:vault-equivalence:gate"),
  security_regressions: zero("validate:vault-equivalence:compare", "validate:vault-equivalence:gate"),
  crypto_compatibility_failures: zero("validate:vault-equivalence:replay", "validate:vault-equivalence:backup"),
  backup_restore_failures: zero("validate:vault-equivalence:backup"),
  snapshot_restore_failures: zero("validate:vault-equivalence:compare"),
  runtime_failures: zero("validate:vault-chaos"),
  performance_regressions: zero("validate:vault-perf", "validate:vault-perf:gate"),
  validator_bypass_test: passed("validate:vault-tamper") ? "PASS" : results["validate:vault-tamper"]?.executed ? "FAIL" : "NOT_EXECUTED",
};
const files = [path.join(ROOT, "scripts/antas/vault/gap/validate-vlt-gap-final.mjs"), path.join(ROOT, "package.json")];
const report = { gap: GAP, checked_at: new Date().toISOString(), ...binding(Object.fromEntries(files.map((f) => [rel(f), sha256File(f)]))), duration_seconds: Math.round((Date.now() - started) / 1000),
  method: "live gates (from package.json validate:vault-*) executed in a clean copy of the tree; point-in-time sub-phase gates verified by recorded evidence; build/tests in the real tree",
  certificate, requirements, build_and_tests: buildTest, executed_gates: results, recorded_evidence: { per_gap: perGap, non_pass: nonPass, superseded_non_pass: supersededNonPass },
  migration_map_open_items: open, blockers, status: certificate.status };
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "final-run.json"), JSON.stringify(report, null, 2) + "\n");
fs.writeFileSync(path.join(OUT, "certificate.json"), JSON.stringify(certificate, null, 2) + "\n");
if (blockers.length) { console.error(`${GAP} FAIL -- NOT CERTIFIABLE: ${blockers.length} blocker(s):`); for (const b of blockers) console.error(`  [${b.id}] ${b.detail}`); process.exit(1); }
console.log(`${GAP} PASS -- ${live.length} live gates executed in a clean copy, build + tests pass, 0 open map items (${rel(path.join(OUT, "certificate.json"))})`);
