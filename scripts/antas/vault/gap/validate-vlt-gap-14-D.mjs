#!/usr/bin/env node
// VLT-GAP-14-D — Architecture gate: prove the CI gate is real (counterpart of 13-D).
//   1. real scan of the real tree passes (fresh evidence, regenerated here, not a stale file)
//   2. scope is complete: every .ts file under vault/ is in the graph and every vault/ layer directory is in the config
//   3. intentional violations are planted in COPIES OF THE REAL TREE (real api-server/src files) and the scanner must
//      exit non-zero AND report the planted file:line:rule — one case per rule A0..A8 (+ type-only, dynamic, cycle)
//   4. bypass flags / env vars, --root without a value, and an empty / missing scope fail closed
//   5. the CI command in package.json is the scanner, the scanner self-test and 14-C CI-wiring validator pass
// Writes reports/antas/vault/gap/VLT-GAP-14/gate.json — `status` is written by this script only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, rel, rejectBypass, sha256File, binding } from "./gap-common.mjs";

const GAP = "VLT-GAP-14", SUB = "VLT-GAP-14-D";
const OUT = path.join(ROOT, "reports/antas/vault/gap", GAP);
const SCAN_DIR = "scripts/antas/vault/gap";
const SCANNER = path.join(ROOT, SCAN_DIR, "validate-vlt-gap-14.mjs");
const C_VAL = path.join(ROOT, SCAN_DIR, "validate-vlt-gap-14-C.mjs");
const SELF = path.join(ROOT, SCAN_DIR, "validate-vlt-gap-14-D.mjs");
const CFG = path.join(ROOT, SCAN_DIR, "gap-configs/vault-architecture.json");
const fail = (m) => { console.error(`${SUB} FAIL — ${m}`); process.exit(1); };
const bad = rejectBypass([]);
if (bad.length) fail(`bypass rejected: ${bad.join(", ")}`);
const cfg = JSON.parse(fs.readFileSync(CFG, "utf8"));
const SRC = path.join(ROOT, cfg.src_root);

const CLEAN_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(VALIDATION_DISABLED|ANTAS_BYPASS|VLT_BYPASS|VAULT_BYPASS)$/i.test(k)));
const run = (args, env = CLEAN_ENV) => spawnSync(process.execPath, args, { cwd: ROOT, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const commands = [], exit_codes = {}, errors = [];
const record = (label, cmd, r) => { commands.push(`${label}: node ${cmd.map((c) => c.replace(ROOT + "/", "")).join(" ")}`); exit_codes[label] = r.status; };
const need = (cond, msg) => { if (!cond) errors.push(msg); };

// ── 1. real scan, fresh evidence ────────────────────────────────────────────────────────────────────────────
const reportPath = path.join(OUT, "architecture.json");
fs.rmSync(reportPath, { force: true });
const real = run([SCANNER]); record("real-scan", [SCANNER], real);
need(real.status === 0, `real scan exit ${real.status}: ${real.stderr.trim().split("\n").slice(0, 3).join(" | ")}`);
need(fs.existsSync(reportPath), "scanner did not regenerate architecture.json");
const scan = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, "utf8")) : { violations: [{}], status: "MISSING", vault_files: 0, cycles: [] };
need(scan.status === "PASS" && scan.violations.length === 0, `architecture.json status ${scan.status}, ${scan.violations.length} violations`);
need(scan.cycles.length === 0, `${scan.cycles.length} runtime cycles in real tree`);
need(scan.vault_files > 0, "scanner reported 0 Vault files (fail closed)");

// ── 2. scope completeness ───────────────────────────────────────────────────────────────────────────────────
const tsFiles = (dir, out = []) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) { if (!["node_modules", "__tests__", "__mocks__"].includes(e.name)) tsFiles(p, out); } else if (/\.(ts|tsx|mts|cts)$/.test(e.name) && !/\.d\.ts$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name)) out.push(p); } return out; };
const vaultOnDisk = tsFiles(path.join(ROOT, cfg.vault_root)).length;
need(vaultOnDisk === scan.vault_files, `scanner saw ${scan.vault_files} Vault files but ${vaultOnDisk} exist on disk`);
const layerDirs = fs.readdirSync(path.join(ROOT, cfg.vault_root), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
for (const d of layerDirs) need(cfg.layers.includes(d), `vault/${d} exists on disk but is not a configured layer (no rules would govern it)`);

// ── 3. CI-fail proof on copies of the real tree ──────────────────────────────────────────────────────────────
const copyTree = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "gap14-D-"));
  fs.cpSync(SRC, path.join(d, cfg.src_root), { recursive: true, filter: (s) => !/(^|\/)node_modules(\/|$)/.test(s) });
  const pv = path.join(ROOT, "packages/vault-crypto");
  if (fs.existsSync(pv)) fs.cpSync(pv, path.join(d, "packages/vault-crypto"), { recursive: true, filter: (s) => !/node_modules/.test(s) });
  return d;
};
const control = copyTree();
const c = run([SCANNER, "--root", control]); record("control-unmodified-copy", [SCANNER, "--root", "<tmp>"], c);
need(c.status === 0, `unmodified copy of the real tree should pass but exit ${c.status}: ${c.stderr.trim().split("\n").slice(0, 2).join(" | ")}`);
fs.rmSync(control, { recursive: true, force: true });

// every case prepends ONE line to a real file (line 1), so the planted line is always 1.
const S = cfg.src_root;
const CASES = [
  { id: "A2a", rule: "A2-layer-direction", file: `${S}/vault/infrastructure/index.ts`, code: 'import "../application/entity/index";' },
  { id: "A2b", rule: "A2-layer-direction", file: `${S}/vault/crypto/field-encryption.ts`, code: 'import "../infrastructure/db-handle";' },
  { id: "A3a", rule: "A3-domain-purity", file: `${S}/vault/domain/entity-links.ts`, code: 'import "../../lib/event-hub";' },
  { id: "A3b", rule: "A3-domain-purity", file: `${S}/vault/domain/serial.ts`, code: 'import "../application/entity/create";', also: ["A2-layer-direction"] },
  { id: "A4a", rule: "A4-db-import", file: `${S}/vault/application/entity/create.ts`, code: 'import { db as plantedDb } from "@workspace/db";' },
  { id: "A4b", rule: "A4-db-import", file: `${S}/vault/application/entity/update.ts`, code: 'import type { SQL } from "drizzle-orm";', typeOnly: true },
  { id: "A4c", rule: "A4-db-import", file: `${S}/vault/application/entity/bulk.ts`, code: "export const plantedDyn = async () => (await import(\"@workspace/db\")).db;", bottom: true },
  { id: "A4d", rule: "A4-http-import", file: `${S}/vault/application/entity/receipt.ts`, code: 'import type { Request as PlantedReq } from "express";', typeOnly: true },
  { id: "A4e", rule: "A4-provider-import", file: `${S}/vault/application/backup/schedule.ts`, code: 'import plantedFs from "node:fs";' },
  { id: "A4f", rule: "A4-frontend-import", file: `${S}/vault/application/entity/admin.ts`, code: 'import plantedReact from "react";' },
  { id: "A4g", rule: "A4-http-import", file: `${S}/vault/infrastructure/index.ts`, code: 'import type { Response as PlantedRes } from "express";', typeOnly: true },
  { id: "A5a", rule: "A5-route-import", file: `${S}/vault/application/entity/admin.ts`, code: 'import "../../../routes/kyc";' },
  { id: "A5b", rule: "A5-route-import", file: `${S}/vault/infrastructure/jobs/${firstTs("vault/infrastructure/jobs")}`, code: 'import "../../../routes/kyc";' },
  { id: "A5c", rule: "A5-middleware-import", file: `${S}/vault/application/entity/create.ts`, code: 'import "../../../middlewares/auth";' },
  { id: "A6", rule: "A6-cross-feature-private", file: `${S}/vault/application/kyc/enrollment.ts`, code: 'import "../entity/create";' },
  { id: "A7a", rule: "A7-legacy-import", file: `${S}/routes/kyc.ts`, code: 'import "../lib/vault-pin-guard";' },
  { id: "A7b", rule: "A7-legacy-import", file: `${S}/vault/security/lockout.ts`, code: 'import "../../lib/vault-pin-guard";' },
  { id: "A8", rule: "A8-outside-deep-import", file: `${S}/routes/kyc.ts`, code: 'import "../vault/infrastructure/db-handle";' },
  { id: "A0", rule: "A0-unresolved", file: `${S}/vault/application/entity/receipt.ts`, code: 'import "./planted-does-not-exist";' },
];
function firstTs(sub) { const d = path.join(SRC, sub); return fs.existsSync(d) ? (fs.readdirSync(d).find((n) => /\.ts$/.test(n) && n !== "index.ts") ?? "MISSING.ts") : "MISSING.ts"; }

const proofs = [];
const reportedRe = (file) => new RegExp(`${file.replace(/[./]/g, "\\$&")}:(\\d+) \\[([^\\]]+)\\]`, "g");
for (const m of CASES) {
  const tmp = copyTree(), f = path.join(tmp, m.file);
  if (!fs.existsSync(f)) { errors.push(`${m.id}: real file ${m.file} not found — update the case`); fs.rmSync(tmp, { recursive: true, force: true }); continue; }
  const L = fs.readFileSync(f, "utf8").split("\n");
  let plantedLine;
  if (m.bottom) { L.push(m.code); plantedLine = L.length; } else { L.unshift(m.code); plantedLine = 1; }
  fs.writeFileSync(f, L.join("\n"));
  const r = run([SCANNER, "--root", tmp]); record(`plant-${m.id}`, [SCANNER, "--root", "<tmp>"], r);
  const hits = [...r.stderr.matchAll(reportedRe(m.file))].map((x) => ({ line: +x[1], rule: x[2] }));
  const exact = hits.some((h) => h.rule === m.rule && h.line === plantedLine);
  const ok = r.status !== 0 && exact;
  need(ok, `${m.id}: planted ${m.rule} at ${m.file}:${plantedLine} — exit ${r.status}, reported ${JSON.stringify(hits.slice(0, 4))}`);
  proofs.push({ id: m.id, file: m.file, rule: m.rule, planted_line: plantedLine, type_only: !!m.typeOnly, scanner_exit: r.status, reported: hits.filter((h) => h.rule === m.rule).slice(0, 2), ok });
  fs.rmSync(tmp, { recursive: true, force: true });
}
// A1 runtime cycle between two REAL files: make an existing importer-target import its importer back
{
  const tmp = copyTree();
  const a = `${S}/vault/application/entity/index.ts`, b = `${S}/vault/application/entity/create.ts`;
  const edge = /from\s+"\.\/create"/.test(fs.readFileSync(path.join(tmp, a), "utf8"));
  // add a runtime edge both ways between two real entity files (planted new line 1 in each)
  for (const [x, y] of [[a, "./create"], [b, "./index"]]) { const p = path.join(tmp, x); fs.writeFileSync(p, `import "${y}";\n` + fs.readFileSync(p, "utf8")); }
  const r = run([SCANNER, "--root", tmp]); record("plant-A1", [SCANNER, "--root", "<tmp>"], r);
  const hit = new RegExp(`(${a.replace(/[./]/g, "\\$&")}|${b.replace(/[./]/g, "\\$&")}):1 \\[A1-cycle\\]`).test(r.stderr);
  const ok = r.status !== 0 && hit;
  need(ok, `A1: planted cycle ${a} <-> ${b} not reported at a planted line (exit ${r.status})`);
  proofs.push({ id: "A1", file: `${a} <-> ${b}`, rule: "A1-cycle", planted_line: 1, scanner_exit: r.status, ok, preexisting_edge: edge });
  fs.rmSync(tmp, { recursive: true, force: true });
}
// type-only cycle must NOT fail (erased at runtime)
{
  const tmp = copyTree(), a = `${S}/vault/application/entity/index.ts`, b = `${S}/vault/application/entity/create.ts`;
  for (const [x, y] of [[a, "./create"], [b, "./index"]]) { const p = path.join(tmp, x); fs.writeFileSync(p, `import type {} from "${y}";\n` + fs.readFileSync(p, "utf8")); }
  const r = run([SCANNER, "--root", tmp]); record("type-only-cycle-accepted", [SCANNER, "--root", "<tmp>"], r);
  need(r.status === 0 && !/A1-cycle/.test(r.stderr), `type-only cycle wrongly rejected (exit ${r.status})`);
  proofs.push({ id: "A1-typeonly-ok", rule: "none", scanner_exit: r.status, ok: r.status === 0 });
  fs.rmSync(tmp, { recursive: true, force: true });
}
// rule coverage: every rule family A0..A8 has at least one proven case
for (const fam of ["A0", "A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8"]) need(proofs.some((p) => p.rule.startsWith(fam) && p.ok), `no passing planted case for rule ${fam}`);

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
  const r0 = run([SCANNER, "--root"]); record("fail-closed-root-no-value", [SCANNER, "--root"], r0);
  const ok0 = r0.status !== 0; bypass.push({ via: "--root without value", ok: ok0 }); need(ok0, "--root with no directory did not fail closed");
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "gap14-D-empty-"));
  const r = run([SCANNER, "--root", empty]); record("fail-closed-empty-scope", [SCANNER, "--root", "<empty>"], r);
  const ok = r.status !== 0 && /fail closed/.test(r.stderr); bypass.push({ via: "empty scope", ok }); need(ok, `empty scan scope did not fail closed (exit ${r.status})`);
  fs.mkdirSync(path.join(empty, cfg.vault_root), { recursive: true });
  const r1 = run([SCANNER, "--root", empty]); record("fail-closed-empty-vault", [SCANNER, "--root", "<empty-vault>"], r1);
  const ok1 = r1.status !== 0 && /fail closed/.test(r1.stderr); bypass.push({ via: "empty vault root", ok: ok1 }); need(ok1, `empty Vault root did not fail closed (exit ${r1.status})`);
  const r2 = run([SCANNER, "--root", path.join(empty, "does-not-exist")]); record("fail-closed-missing-dir", [SCANNER, "--root", "<missing>"], r2);
  const ok2 = r2.status !== 0; bypass.push({ via: "missing scope dir", ok: ok2 }); need(ok2, "missing scan dir did not fail closed");
  fs.rmSync(empty, { recursive: true, force: true });
}

// ── 5. CI command + self-test + wiring ───────────────────────────────────────────────────────────────────────
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
need(pkg.scripts?.["validate:vault-architecture"] === `node ${SCAN_DIR}/validate-vlt-gap-14.mjs`, "package.json validate:vault-architecture is not the scanner");
need(pkg.scripts?.["validate:vault-architecture:gate"] === `node ${SCAN_DIR}/validate-vlt-gap-14-D.mjs`, "package.json validate:vault-architecture:gate is not the 14-D gate");
const st = run([SCANNER, "--self-test"]); record("scanner-self-test", [SCANNER, "--self-test"], st);
need(st.status === 0, `scanner self-test exit ${st.status}`);
const cw = run([C_VAL]); record("ci-wiring-14-C", [C_VAL], cw);
need(cw.status === 0, `14-C CI wiring exit ${cw.status}: ${cw.stderr.trim().split("\n").slice(0, 3).join(" | ")}`);

// ── evidence ────────────────────────────────────────────────────────────────────────────────────────────────
const hashed = Object.fromEntries([SCANNER, C_VAL, SELF, CFG].map((p) => [rel(p), sha256File(p)]));
const report = {
  phase: GAP, sub_phase: SUB, validator_version: "14-D.1", checked_at: new Date().toISOString(),
  ...binding(hashed), source_hashes: hashed, commands, exit_codes,
  vault_files: scan.vault_files, vault_files_on_disk: vaultOnDisk, violations_in_real_tree: scan.violations.length, cycles_in_real_tree: scan.cycles.length,
  ci_fail_proof: { control_copy_exit: c.status, planted_cases: proofs.length, all_caught_at_planted_line: proofs.every((p) => p.ok), proofs },
  bypass_and_fail_closed: bypass, errors, status: errors.length ? "FAIL" : "PASS",
};
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "gate.json"), JSON.stringify(report, null, 2) + "\n");
if (errors.length) { for (const e of errors) console.error(`  ${e}`); fail(`${errors.length} gate failure(s)`); }
console.log(`${SUB} PASS — ${scan.vault_files} Vault files clean; ${proofs.length} planted cases on a copy of the real tree each failed the scan at the planted line; ${bypass.length} bypass/fail-closed checks rejected; CI wiring verified`);
