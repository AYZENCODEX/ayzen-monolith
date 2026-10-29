#!/usr/bin/env node
// VLT-GAP-13-D — Route-thinness gate: prove the CI gate is real.
//   1. real scan of the real tree passes (fresh evidence, not a stale file)
//   2. scope is complete: every mounted/on-disk Vault route is scanned (explicit, reasoned exclusions only)
//   3. intentional violations planted in COPIES OF REAL route files make the scanner exit non-zero and
//      report the planted file:line:rule  (this is the "introduce a violation and prove CI fails" proof)
//   4. bypass flags / env vars and an empty scope fail closed
//   5. the CI wiring validator (13-C) and the scanner self-test pass
// Writes reports/antas/vault/gap/VLT-GAP-13/gate.json — `status` is written by this script only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, rel, rejectBypass, sha256File, binding } from "./gap-common.mjs";

const GAP = "VLT-GAP-13", SUB = "VLT-GAP-13-D";
const OUT = path.join(ROOT, "reports/antas/vault/gap", GAP);
const ROUTES = path.join(ROOT, "artifacts/api-server/src/routes");
const SCANNER = path.join(ROOT, "scripts/antas/vault/gap/validate-vlt-gap-13.mjs");
const C_VAL = path.join(ROOT, "scripts/antas/vault/gap/validate-vlt-gap-13-C.mjs");
const fail = (m) => { console.error(`${SUB} FAIL — ${m}`); process.exit(1); };
const bad = rejectBypass([]);
if (bad.length) fail(`bypass rejected: ${bad.join(", ")}`);

// Route files that mention "vault" but are deliberately outside the Vault-owned scan scope. Each needs a reason;
// anything else that looks Vault-owned and is not scanned fails the gate.
const EXCLUDED = {};

const CLEAN_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(VALIDATION_DISABLED|ANTAS_BYPASS|VLT_BYPASS|VAULT_BYPASS)$/i.test(k)));
const run = (args, env = CLEAN_ENV) => spawnSync(process.execPath, args, { cwd: ROOT, env, encoding: "utf8" });
const commands = [], exit_codes = {}, errors = [];
const record = (label, cmd, r) => { commands.push(`${label}: node ${cmd.map((c) => c.replace(ROOT + "/", "")).join(" ")}`); exit_codes[label] = r.status; };
const need = (cond, msg) => { if (!cond) errors.push(msg); };

// ── 1. real scan, fresh evidence ────────────────────────────────────────────────────────────────────────────
const reportPath = path.join(OUT, "route-thinness.json");
fs.rmSync(reportPath, { force: true });
const real = run([SCANNER]); record("real-scan", [SCANNER], real);
need(real.status === 0, `real scan exit ${real.status}: ${real.stderr.trim().split("\n").slice(0, 3).join(" | ")}`);
need(fs.existsSync(reportPath), "scanner did not regenerate route-thinness.json");
const scan = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, "utf8")) : { route_files: [], violations: [{}], status: "MISSING" };
need(scan.status === "PASS" && scan.violations.length === 0, `route-thinness.json status ${scan.status}, ${scan.violations.length} violations`);
const scanned = new Set(scan.route_files.map((f) => path.basename(f.file)));
const totalHandlers = scan.route_files.reduce((n, f) => n + f.handlers, 0);
need(totalHandlers > 0, "scanner reported 0 handlers (fail closed)");

// ── 2. scope completeness ───────────────────────────────────────────────────────────────────────────────────
const indexText = fs.readFileSync(path.join(ROUTES, "index.ts"), "utf8");
const importOf = new Map([...indexText.matchAll(/import\s+(\w+)\s+from\s+"\.\/([\w-]+)"/g)].map((m) => [m[1], `${m[2]}.ts`]));
const mounted = new Set([...indexText.matchAll(/router\.use\((\w+)\)/g)].map((m) => importOf.get(m[1])).filter(Boolean));
const onDisk = fs.readdirSync(ROUTES).filter((n) => /vault/i.test(n) && n.endsWith(".ts"));
const unscanned = [...new Set([...onDisk, ...[...mounted].filter((n) => /vault/i.test(n))])].filter((n) => !scanned.has(n));
for (const n of unscanned) need(EXCLUDED[n], `${n} looks Vault-owned (mounted/on disk) but is not scanned and has no documented exclusion`);
for (const n of Object.keys(EXCLUDED)) need(fs.existsSync(path.join(ROUTES, n)), `stale exclusion ${n} (file no longer exists)`);
for (const n of scanned) need(mounted.has(n), `${n} is scanned but not mounted in routes/index.ts (orphan route)`);
for (const n of [...mounted].filter((n) => /^vault/.test(n))) need(scanned.has(n), `${n} mounted but not scanned`);

// ── 3. CI-fail proof on copies of real route files ──────────────────────────────────────────────────────────
const HANDLER = /^router\.(get|post|put|patch|delete)\(.*=>\s*\{\s*$/;
const afterImports = (L) => { let i = -1; L.forEach((l, k) => { if (/^import\s/.test(l)) i = k; }); return i; };
const atHandler = (L) => L.findIndex((l) => HANDLER.test(l));
const MUTATIONS = [
  { id: "R1", rule: "R1-db-import",       file: "vault-shares.ts",        where: "top",     code: 'import { db } from "@workspace/db";' },
  { id: "R2", rule: "R2-raw-sql/db",      file: "vault-attachments.ts",   where: "handler", code: "  await db.select().from(planted);" },
  { id: "R2b", rule: "R2-raw-sql/db",     file: "vault-snapshot.ts",      where: "handler", code: '  const planted = "DELETE FROM vault_entries WHERE id = 1";' },
  { id: "R3", rule: "R3-provider-access", file: "vault-migration.ts",     where: "handler", code: '  await fetch("https://example.invalid/exfil");' },
  { id: "R4", rule: "R4-business-calc",   file: "vault-reauth.ts",        where: "handler", code: "  const planted = Date.now() - 1000;" },
  { id: "R4b", rule: "R4-business-calc",  file: "game-entries.ts",        where: "handler", code: "  for (const planted of [1]) { void planted; }" },
  { id: "R5", rule: "R5-state-mutation",  file: "vault-backup-key.ts",    where: "top",     code: "const plantedCache = new Map();" },
  { id: "R6", rule: "R6-security-policy", file: "vault-security.ts",      where: "handler", code: '  const planted = createHash("sha256");' },
  { id: "R7", rule: "R7-route-to-route",  file: "vault.ts",               where: "top",     code: 'import plantedOther from "./vault-shares";' },
  { id: "R8", rule: "R8-handler-size",    file: "kyc.ts",                 where: "handler", code: Array.from({ length: 45 }, (_, i) => `  const planted${i} = ${i};`).join("\n"), noLine: true },
];
const scopeFiles = [...scanned];
const mkTmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "gap13-D-")); for (const n of scopeFiles) fs.copyFileSync(path.join(ROUTES, n), path.join(d, n)); return d; };

const control = mkTmp();
const c = run([SCANNER, "--root", control]); record("control-unmodified-copy", [SCANNER, "--root", "<tmp>"], c);
need(c.status === 0, `unmodified copy of real routes should pass but exit ${c.status}`);
fs.rmSync(control, { recursive: true, force: true });

const proofs = [];
for (const m of MUTATIONS) {
  const tmp = mkTmp(), f = path.join(tmp, m.file);
  const L = fs.readFileSync(f, "utf8").split("\n");
  const at = m.where === "top" ? afterImports(L) : atHandler(L);
  if (at < 0) { errors.push(`${m.id}: no insertion point in ${m.file}`); fs.rmSync(tmp, { recursive: true, force: true }); continue; }
  const plantedLine = at + 2; // 1-based line of the first inserted line
  L.splice(at + 1, 0, m.code);
  fs.writeFileSync(f, L.join("\n"));
  const r = run([SCANNER, "--root", tmp]); record(`plant-${m.id}`, [SCANNER, "--root", "<tmp>"], r);
  const hits = [...r.stderr.matchAll(new RegExp(`${m.file.replace(/\./g, "\\.")}:(\\d+) \\[([^\\]]+)\\]`, "g"))].map((x) => ({ line: +x[1], rule: x[2] }));
  const exact = hits.some((h) => h.rule === m.rule && (m.noLine || h.line === plantedLine));
  const ok = r.status !== 0 && exact;
  need(ok, `${m.id}: planted ${m.rule} in ${m.file}:${plantedLine} — exit ${r.status}, reported ${JSON.stringify(hits.slice(0, 4))}`);
  proofs.push({ id: m.id, file: m.file, rule: m.rule, planted_line: m.noLine ? null : plantedLine, scanner_exit: r.status, reported: hits.filter((h) => h.rule === m.rule).slice(0, 2), ok });
  fs.rmSync(tmp, { recursive: true, force: true });
}
// R9 (handler stops delegating): replace the first delegated call in a real handler with a literal result
{
  const tmp = mkTmp(), f = path.join(tmp, "vault-shares.ts");
  const src = fs.readFileSync(f, "utf8");
  const mut = src.replace(/const r = await \w+\([^)]*\);/, "const r = { status: 200, body: {} };");
  need(mut !== src, "R9: no delegating call found to strip in vault-shares.ts");
  fs.writeFileSync(f, mut);
  const r = run([SCANNER, "--root", tmp]); record("plant-R9", [SCANNER, "--root", "<tmp>"], r);
  const ok = r.status !== 0 && /vault-shares\.ts:\d+ \[R9-no-delegate\]/.test(r.stderr);
  need(ok, `R9: stripped delegate not caught (exit ${r.status})`);
  proofs.push({ id: "R9", file: "vault-shares.ts", rule: "R9-no-delegate", scanner_exit: r.status, ok });
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── 4. bypass + fail-closed ──────────────────────────────────────────────────────────────────────────────────
const bypass = [];
for (const flag of ["--force", "--skip", "--skip-validation", "--continue-on-error", "--ignore-failures"]) {
  const r = run([SCANNER, flag]); record(`bypass-arg${flag}`, [SCANNER, flag], r);
  const ok = r.status !== 0 && /bypass rejected/.test(r.stderr); bypass.push({ via: flag, ok }); need(ok, `bypass ${flag} not rejected (exit ${r.status})`);
}
for (const env of ["VALIDATION_DISABLED", "ANTAS_BYPASS"]) {
  const r = run([SCANNER], { ...CLEAN_ENV, [env]: "true" }); record(`bypass-env-${env}`, [SCANNER], r);
  const ok = r.status !== 0 && /bypass rejected/.test(r.stderr); bypass.push({ via: `${env}=true`, ok }); need(ok, `bypass ${env}=true not rejected (exit ${r.status})`);
}
{
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "gap13-D-empty-"));
  const r = run([SCANNER, "--root", empty]); record("fail-closed-empty-scope", [SCANNER, "--root", "<empty>"], r);
  const ok = r.status !== 0 && /fail closed/.test(r.stderr); bypass.push({ via: "empty scope", ok }); need(ok, `empty scan scope did not fail closed (exit ${r.status})`);
  const r2 = run([SCANNER, "--root", path.join(empty, "does-not-exist")]); record("fail-closed-missing-dir", [SCANNER, "--root", "<missing>"], r2);
  const ok2 = r2.status !== 0; bypass.push({ via: "missing scope dir", ok: ok2 }); need(ok2, "missing scan dir did not fail closed");
  fs.rmSync(empty, { recursive: true, force: true });
}

// ── 5. self-test + CI wiring ─────────────────────────────────────────────────────────────────────────────────
const st = run([SCANNER, "--self-test"]); record("scanner-self-test", [SCANNER, "--self-test"], st);
need(st.status === 0, `scanner self-test exit ${st.status}`);
const DIFF = path.join(ROOT, "scripts/antas/vault/gap/differential-vlt-gap-13-E.mjs");
const df = run([DIFF]); record("differential-marketplace-vault", [DIFF], df);
need(df.status === 0, `marketplace-vault differential exit ${df.status}: ${df.stderr.trim().split("\n").slice(0, 2).join(" | ")}`);
const cw = run([C_VAL]); record("ci-wiring-13-C", [C_VAL], cw);
need(cw.status === 0, `13-C CI wiring exit ${cw.status}: ${cw.stderr.trim().split("\n").slice(0, 3).join(" | ")}`);

// ── evidence ────────────────────────────────────────────────────────────────────────────────────────────────
const hashed = Object.fromEntries([SCANNER, C_VAL, fileURL(), ...scan.route_files.map((f) => path.join(ROOT, f.file))].map((p) => [rel(p), sha256File(p)]));
function fileURL() { return path.join(ROOT, "scripts/antas/vault/gap/validate-vlt-gap-13-D.mjs"); }
const report = {
  phase: GAP, sub_phase: SUB, validator_version: "13-D.1", checked_at: new Date().toISOString(),
  ...binding(hashed), source_hashes: hashed, commands, exit_codes,
  route_files: scan.route_files.length, handlers_scanned: totalHandlers, violations_in_real_tree: scan.violations.length,
  scope: { scanned: [...scanned].sort(), excluded_with_reason: EXCLUDED, unscanned_found: unscanned },
  ci_fail_proof: { control_copy_exit: c.status, planted_cases: proofs.length, all_caught_at_planted_line: proofs.every((p) => p.ok), proofs },
  bypass_and_fail_closed: bypass, errors, status: errors.length ? "FAIL" : "PASS",
};
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "gate.json"), JSON.stringify(report, null, 2) + "\n");
if (errors.length) { for (const e of errors) console.error(`  ${e}`); fail(`${errors.length} gate failure(s)`); }
console.log(`${SUB} PASS — ${scan.route_files.length} route files / ${totalHandlers} handlers clean; ${proofs.length} planted violations each failed the scan at the planted line; ${bypass.length} bypass/fail-closed checks rejected; CI wiring verified`);
