#!/usr/bin/env node
// VLT-GAP-16-D — Duplicate/legacy gate: prove the CI gate is real (counterpart of 13-D / 14-D).
//   1. real scan of the real tree passes (fresh evidence regenerated here, not a stale file)
//   2. scope is complete: scanner file count == files on disk; every vault/ file and every Vault-owned route is in scope
//      (non-Vault routes need a documented exclusion); thresholds and allowlist sizes can't be loosened silently
//   3. intentional duplicates/legacy/crypto/security violations are planted in COPIES OF THE REAL SOURCE TREE and the scanner
//      must exit non-zero AND report the planted file:line:rule — one case per rule D1/L1/L2/C1/S1 (several each);
//      negative controls (near-duplicate with a different literal, aliased approved-owner import) must still pass
//   4. bypass flags/env, --root without a value, empty / missing / vault-less scope fail closed
//   5. package.json commands are the real scripts, the scanner self-test and the 16-C CI-wiring validator pass
// Writes reports/antas/vault/gap/VLT-GAP-16/gate.json — `status` is written by this script only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, rel, rejectBypass, sha256File, binding } from "./gap-common.mjs";

const GAP = "VLT-GAP-16", SUB = "VLT-GAP-16-D";
const OUT = path.join(ROOT, "reports/antas/vault/gap", GAP);
const SCAN_DIR = "scripts/antas/vault/gap";
const SCANNER = path.join(ROOT, SCAN_DIR, "validate-vlt-gap-16.mjs");
const C_VAL = path.join(ROOT, SCAN_DIR, "validate-vlt-gap-16-C.mjs");
const SELF = path.join(ROOT, SCAN_DIR, "validate-vlt-gap-16-D.mjs");
const CFG_PATH = path.join(ROOT, SCAN_DIR, "gap-configs/vault-duplicates.json");
const fail = (m) => { console.error(`${SUB} FAIL — ${m}`); process.exit(1); };
const bad = rejectBypass([]);
if (bad.length) fail(`bypass rejected: ${bad.join(", ")}`);
const cfg = JSON.parse(fs.readFileSync(CFG_PATH, "utf8"));
const SRC = path.join(ROOT, cfg.src_root);

const CLEAN_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(VALIDATION_DISABLED|ANTAS_BYPASS|VLT_BYPASS|VAULT_BYPASS)$/i.test(k)));
const run = (args, env = CLEAN_ENV) => spawnSync(process.execPath, args, { cwd: ROOT, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const commands = [], exit_codes = {}, errors = [];
const record = (label, cmd, r) => { commands.push(`${label}: node ${cmd.map((c) => c.replace(ROOT + "/", "")).join(" ")}`); exit_codes[label] = r.status; };
const need = (cond, msg) => { if (!cond) errors.push(msg); };
const stderrHead = (r, n = 2) => r.stderr.trim().split("\n").slice(0, n).join(" | ");

// ── 1. real scan, fresh evidence ────────────────────────────────────────────────────────────────────────────
const reportPath = path.join(OUT, "duplicate-scan.json");
fs.rmSync(reportPath, { force: true });
const real = run([SCANNER]); record("real-scan", [SCANNER], real);
need(real.status === 0, `real scan exit ${real.status}: ${stderrHead(real, 3)}`);
need(fs.existsSync(reportPath), "scanner did not regenerate duplicate-scan.json");
const scan = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, "utf8")) : { findings: [{}], status: "MISSING", files_scanned: 0, vault_files: 0, totals: {}, duplicate_groups: [{}] };
need(scan.status === "PASS" && scan.findings.length === 0, `duplicate-scan.json status ${scan.status}, ${scan.findings.length} findings`);
need(scan.duplicate_groups.length === 0, `${scan.duplicate_groups.length} duplicate groups in real tree`);
need(scan.totals.duplicate_business_implementations === 0 && scan.totals.unexpected_legacy_consumers === 0 && scan.totals.old_source_of_truth_modules === 0, `totals not all zero: ${JSON.stringify(scan.totals)}`);
need(scan.vault_files > 0 && scan.files_scanned > 0, "scanner reported 0 files (fail closed)");

// ── 2. scope completeness + anti-loosening ───────────────────────────────────────────────────────────────────
const tsFiles = (dir, out = []) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { if (e.name === "node_modules" || e.name.startsWith(".")) continue; const p = path.join(dir, e.name); if (e.isDirectory()) tsFiles(p, out); else if (/\.(ts|tsx|mts|mjs)$/.test(e.name) && !/\.d\.m?ts$/.test(e.name) && !/\.(test|spec)\./.test(e.name)) out.push(p); } return out; };
const onDisk = tsFiles(SRC);
need(onDisk.length === scan.files_scanned, `scanner saw ${scan.files_scanned} files but ${onDisk.length} exist on disk`);
const relSrc = (p) => path.relative(SRC, p).split(path.sep).join("/");
const SCOPE = new RegExp(cfg.scope_file_regex);
const vaultOnDisk = onDisk.filter((p) => relSrc(p).startsWith("vault/"));
need(vaultOnDisk.length === scan.vault_files, `scanner saw ${scan.vault_files} vault/ files but ${vaultOnDisk.length} exist`);
for (const p of vaultOnDisk) if (!SCOPE.test(relSrc(p))) { errors.push(`vault file ${relSrc(p)} is outside scope_file_regex — duplicates there would be invisible`); break; }
const EXCL = (cfg.route_scope_exclusions ?? []).map((e) => ({ re: new RegExp(e.file_regex), reason: e.reason }));
const routeScope = [];
for (const p of onDisk.filter((q) => relSrc(q).startsWith("routes/"))) {
  const name = path.basename(p);
  if (!/^(vault|kyc|local-account|game|marketplace)/.test(name)) continue;
  const inScope = SCOPE.test(relSrc(p)), ex = EXCL.find((e) => e.re.test(name));
  routeScope.push({ file: relSrc(p), in_scope: inScope, exclusion: ex?.reason ?? null });
  need(inScope || (ex && ex.reason), `route ${relSrc(p)} is neither in scope_file_regex nor a documented exclusion`);
}
need(routeScope.some((r) => r.in_scope), "no Vault routes in scope (fail closed)");
// anti-loosening: thresholds and allowlist sizes are pinned here; changing them means editing (and reviewing) this gate
need(cfg.min_statements <= 1 && cfg.min_normalized_chars <= 60, `thresholds loosened (min_statements ${cfg.min_statements}, min_normalized_chars ${cfg.min_normalized_chars}; gate pins <=1 / <=60)`);
need(cfg.allowed_shims.length <= 1, `allowed_shims grew to ${cfg.allowed_shims.length} (gate pins 1)`);
need(cfg.security_primitive_allow.length <= 3, `security_primitive_allow grew to ${cfg.security_primitive_allow.length} (gate pins 3)`);
for (const e of [...cfg.allowed_shims, ...cfg.security_primitive_allow]) need(e.reason && e.requires?.length, `allowlist entry ${e.file} has no reason/evidence`);
need(cfg.legacy_file_regex === "^lib/vault-", `legacy_file_regex changed to ${cfg.legacy_file_regex}`);

// ── 3. CI-fail proof on copies of the real source tree ───────────────────────────────────────────────────────
const copyTree = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "gap16-D-")); fs.cpSync(SRC, d, { recursive: true, filter: (s) => !/(^|\/)node_modules(\/|$)/.test(s) }); return d; };
const control = copyTree();
const c = run([SCANNER, "--root", control]); record("control-unmodified-copy", [SCANNER, "--root", "<tmp>"], c);
need(c.status === 0, `unmodified copy of the real tree should pass but exit ${c.status}: ${stderrHead(c)}`);
fs.rmSync(control, { recursive: true, force: true });

// A plant is { file, code, mode }: "top" prepends one line (line 1), "bottom" appends one line, "new" creates a one-line file.
// Paths are relative to the api-server src root (the scanner's --root), which is how findings are reported.
const RESPOND_COPY = 'export function plantedRespond(resp: any, result: any): void { if (result.headers) for (const [hk, hv] of Object.entries(result.headers)) resp.setHeader(hk, hv); if (result.send !== undefined) resp.status(result.status).send(result.send); else resp.status(result.status).json(result.body); }';
const KEYS_COPY = "export function plantedLoadKeys(ns: string) { return db.execute(sql`SELECT version, wrapped_dek, active FROM encryption_keys WHERE namespace = ${ns} ORDER BY version ASC`); }";
const DENY_COPY = 'export const plantedDeny = (_rq: any, rs: any) => { rs.status(404).json({ error: "Not found or forbidden" }); };';
const CASES = [
  { id: "D1a", rule: "D1-duplicate-implementation", plants: [{ file: "vault/security/zz-planted-respond.ts", code: RESPOND_COPY, mode: "new" }], expect: [{ file: "vault/security/zz-planted-respond.ts", line: 1 }] },
  { id: "D1b", rule: "D1-duplicate-implementation", plants: [{ file: "vault/infrastructure/repositories/zz-planted-keys.ts", code: KEYS_COPY, mode: "new" }], expect: [{ file: "vault/infrastructure/repositories/zz-planted-keys.ts", line: 1 }] },
  { id: "D1c", rule: "D1-duplicate-implementation", plants: [{ file: "vault/security/lockout.ts", code: DENY_COPY, mode: "bottom" }], expect: [{ file: "vault/security/lockout.ts", line: "bottom" }] },
  { id: "L2a", rule: "L2-legacy-source-of-truth", plants: [{ file: "lib/vault-planted-legacy.ts", code: "export function plantedLegacy(a: number) { return a + 1; }", mode: "new" }], expect: [{ file: "lib/vault-planted-legacy.ts", line: 1 }] },
  { id: "L2b", rule: "L2-legacy-source-of-truth", plants: [{ file: "lib/vault-planted-shim.ts", code: 'export { requireVaultPin } from "../vault/security/pin-guard";', mode: "new" }], expect: [{ file: "lib/vault-planted-shim.ts", line: 1 }] },
  { id: "L1a", rule: "L1-unexpected-legacy-consumer", plants: [{ file: "routes/kyc.ts", code: 'import "../lib/vault-pin-guard";', mode: "top" }], expect: [{ file: "routes/kyc.ts", line: 1 }] },
  { id: "L1b", rule: "L1-unexpected-legacy-consumer", plants: [{ file: "lib/vault-planted-legacy.ts", code: "export function plantedLegacy(a: number) { return a + 1; }", mode: "new" }, { file: "routes/local-accounts.ts", code: 'import "../lib/vault-planted-legacy";', mode: "top" }], expect: [{ file: "routes/local-accounts.ts", line: 1 }] },
  { id: "C1a", rule: "C1-duplicate-crypto-logic", plants: [{ file: "vault/application/entity/create.ts", code: 'import { createCipheriv as plantedCipher } from "node:crypto";', mode: "top" }], expect: [{ file: "vault/application/entity/create.ts", line: 1 }] },
  { id: "C1b", rule: "C1-duplicate-crypto-logic", plants: [{ file: "vault/application/entity/bulk.ts", code: 'import { hkdfSync as plantedHkdf } from "node:crypto";', mode: "top" }], expect: [{ file: "vault/application/entity/bulk.ts", line: 1 }] },
  { id: "S1a", rule: "S1-duplicate-security-logic", plants: [{ file: "vault/application/entity/update.ts", code: 'import { timingSafeEqual as plantedCmp } from "node:crypto";', mode: "top" }], expect: [{ file: "vault/application/entity/update.ts", line: 1 }] },
  { id: "S1b", rule: "S1-duplicate-security-logic", plants: [{ file: "vault/application/entity/admin.ts", code: 'import { createHmac as plantedHmac } from "node:crypto";', mode: "top" }], expect: [{ file: "vault/application/entity/admin.ts", line: 1 }] },
  { id: "S1c-cap-seed", rule: "S1-duplicate-security-logic", plants: [{ file: "vault/crypto/seed-phrase.ts", code: 'import { scryptSync as plantedScrypt } from "node:crypto";', mode: "top" }], expect: [{ file: "vault/crypto/seed-phrase.ts", line: 1 }] },
  { id: "S1d-cap-blob", rule: "S1-duplicate-security-logic", plants: [{ file: "vault/application/snapshot/blob.ts", code: 'import { scryptSync as plantedScrypt2 } from "node:crypto";', mode: "top" }], expect: [{ file: "vault/application/snapshot/blob.ts", line: 1 }] },
];
// negative controls: must NOT be rejected
const NEGATIVE = [
  { id: "N1-near-duplicate-different-literal", plants: [{ file: "vault/security/zz-planted-respond.ts", code: RESPOND_COPY.replace("status(result.status).send", "status(result.status + 1).send"), mode: "new" }] },
  { id: "N2-aliased-approved-owner-import", plants: [{ file: "vault/application/entity/update.ts", code: 'import { hashPassword as plantedHash } from "../../../lib/password";', mode: "top" }] },
];
const reportedRe = (file) => new RegExp(`${file.replace(/[./]/g, "\\$&")}:(\\d+) \\[([^\\]]+)\\]`, "g");
function applyPlants(tmp, plants) {
  const lines = {};
  for (const p of plants) {
    const f = path.join(tmp, p.file);
    if (p.mode === "new") { if (fs.existsSync(f)) throw new Error(`${p.file} already exists`); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, p.code + "\n"); lines[p.file] = 1; continue; }
    if (!fs.existsSync(f)) throw new Error(`real file ${p.file} not found — update the case`);
    const L = fs.readFileSync(f, "utf8").split("\n");
    if (p.mode === "bottom") { L.push(p.code); lines[p.file] = L.length; } else { L.unshift(p.code); lines[p.file] = 1; }
    fs.writeFileSync(f, L.join("\n"));
  }
  return lines;
}
const proofs = [];
for (const m of CASES) {
  const tmp = copyTree(); let lines;
  try { lines = applyPlants(tmp, m.plants); } catch (e) { errors.push(`${m.id}: ${e.message}`); fs.rmSync(tmp, { recursive: true, force: true }); continue; }
  const r = run([SCANNER, "--root", tmp]); record(`plant-${m.id}`, [SCANNER, "--root", "<tmp>"], r);
  const want = m.expect.map((x) => ({ file: x.file, line: x.line === "bottom" ? lines[x.file] : x.line }));
  const got = want.map((w) => [...r.stderr.matchAll(reportedRe(w.file))].map((x) => ({ line: +x[1], rule: x[2] })));
  const exact = want.every((w, i) => got[i].some((h) => h.rule === m.rule && h.line === w.line));
  const ok = r.status !== 0 && exact;
  need(ok, `${m.id}: planted ${m.rule} at ${want.map((w) => `${w.file}:${w.line}`).join(", ")} — exit ${r.status}, reported ${JSON.stringify(got.flat().slice(0, 4))}`);
  proofs.push({ id: m.id, rule: m.rule, planted: want, scanner_exit: r.status, reported: got.flat().filter((h) => h.rule === m.rule).slice(0, 3), ok });
  fs.rmSync(tmp, { recursive: true, force: true });
}
for (const m of NEGATIVE) {
  const tmp = copyTree();
  try { applyPlants(tmp, m.plants); } catch (e) { errors.push(`${m.id}: ${e.message}`); fs.rmSync(tmp, { recursive: true, force: true }); continue; }
  const r = run([SCANNER, "--root", tmp]); record(`negative-${m.id}`, [SCANNER, "--root", "<tmp>"], r);
  const ok = r.status === 0; need(ok, `${m.id}: should be accepted but exit ${r.status}: ${stderrHead(r)}`);
  proofs.push({ id: m.id, rule: "none (must pass)", scanner_exit: r.status, ok });
  fs.rmSync(tmp, { recursive: true, force: true });
}
for (const fam of ["D1", "L1", "L2", "C1", "S1"]) need(proofs.some((p) => p.rule.startsWith(fam) && p.ok), `no passing planted case for rule ${fam}`);

// ── 4. bypass + fail-closed ──────────────────────────────────────────────────────────────────────────────────
const bypass = [];
const expectRejected = (label, via, r, re) => { const ok = r.status !== 0 && re.test(r.stderr); bypass.push({ via, ok }); need(ok, `${via} not rejected (exit ${r.status})`); record(label, [SCANNER], r); };
for (const flag of ["--force", "--skip", "--skip-validation", "--continue-on-error", "--ignore-failures"]) expectRejected(`bypass-arg${flag}`, flag, run([SCANNER, flag]), /bypass rejected/);
for (const env of ["VALIDATION_DISABLED", "ANTAS_BYPASS"]) expectRejected(`bypass-env-${env}`, `${env}=true`, run([SCANNER], { ...CLEAN_ENV, [env]: "true" }), /bypass rejected/);
expectRejected("fail-closed-root-no-value", "--root without value", run([SCANNER, "--root"]), /fail closed/);
{
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "gap16-D-empty-"));
  expectRejected("fail-closed-empty-scope", "empty scope", run([SCANNER, "--root", empty]), /fail closed/);
  fs.mkdirSync(path.join(empty, "lib"), { recursive: true }); fs.writeFileSync(path.join(empty, "lib/x.ts"), "export const x = 1;\n");
  expectRejected("fail-closed-no-vault-dir", "scope without vault/", run([SCANNER, "--root", empty]), /fail closed/);
  expectRejected("fail-closed-missing-dir", "missing scope dir", run([SCANNER, "--root", path.join(empty, "does-not-exist")]), /fail closed/);
  fs.rmSync(empty, { recursive: true, force: true });
}

// ── 5. CI command + self-test + wiring ───────────────────────────────────────────────────────────────────────
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
need(pkg.scripts?.["validate:vault-duplicates"] === `node ${SCAN_DIR}/validate-vlt-gap-16.mjs`, "package.json validate:vault-duplicates is not the scanner");
need(pkg.scripts?.["validate:vault-duplicates:gate"] === `node ${SCAN_DIR}/validate-vlt-gap-16-D.mjs`, "package.json validate:vault-duplicates:gate is not the 16-D gate");
const st = run([SCANNER, "--self-test"]); record("scanner-self-test", [SCANNER, "--self-test"], st);
need(st.status === 0, `scanner self-test exit ${st.status}: ${stderrHead(st)}`);
const cw = run([C_VAL]); record("ci-wiring-16-C", [C_VAL], cw);
need(cw.status === 0, `16-C CI wiring exit ${cw.status}: ${stderrHead(cw, 3)}`);

// ── evidence ─────────────────────────────────────────────────────────────────────────────────────────────────
const hashed = Object.fromEntries([SCANNER, C_VAL, SELF, CFG_PATH].map((p) => [rel(p), sha256File(p)]));
const report = {
  phase: GAP, sub_phase: SUB, validator_version: "16-D.1", checked_at: new Date().toISOString(),
  ...binding(hashed), source_hashes: hashed, commands, exit_codes,
  files_scanned: scan.files_scanned, files_on_disk: onDisk.length, vault_files: scan.vault_files, totals_in_real_tree: scan.totals,
  route_scope: routeScope, pinned: { min_statements: cfg.min_statements, min_normalized_chars: cfg.min_normalized_chars, allowed_shims: cfg.allowed_shims.length, security_primitive_allow: cfg.security_primitive_allow.length },
  ci_fail_proof: { control_copy_exit: c.status, planted_cases: CASES.length, negative_controls: NEGATIVE.length, all_ok: proofs.every((p) => p.ok), proofs },
  bypass_and_fail_closed: bypass, errors, status: errors.length ? "FAIL" : "PASS",
};
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "gate.json"), JSON.stringify(report, null, 2) + "\n");
if (errors.length) { for (const e of errors) console.error(`  ${e}`); fail(`${errors.length} gate failure(s)`); }
console.log(`${SUB} PASS — ${scan.files_scanned} files clean; ${CASES.length} planted cases on a copy of the real tree each failed the scan at the planted line, ${NEGATIVE.length} negative controls accepted; ${bypass.length} bypass/fail-closed checks rejected; CI wiring verified`);
