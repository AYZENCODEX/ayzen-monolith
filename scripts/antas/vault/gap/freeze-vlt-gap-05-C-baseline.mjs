#!/usr/bin/env node
// VLT-GAP-05-C — one-shot, WRITE-ONCE baseline freeze. Run ONCE, on the tree 05-B certified, BEFORE any 05-C source edit.
//
// Same reason as freeze-vlt-gap-04-C-baseline.mjs: a baseline must never be written by a validator that can be re-run.
// The 05-C validator only VERIFIES this seal. It freezes (a) the exact tree 05-B certified and (b) the verbatim text of every file that,
// at freeze time, imports the compatibility adapter lib/vault-crypto.ts (DERIVED by an AST scan, not hand-listed), so each 05-C edit can be
// proven as a delta from the certified state.
//
// Refuses to run if a seal exists, if 05-B evidence is not a current PASS, or if any argument is given.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, sha256, sha256File, rel, walkFiles } from "./gap-common.mjs";
import { loadTs } from "./harness.mjs";

const EVIDENCE_DIR = path.join(ROOT, "reports/antas/vault/gap/VLT-GAP-05");
const BASE = path.join(EVIDENCE_DIR, "baseline-05c");
const SEAL = path.join(BASE, "SEAL.json");
const GAP_DIR = "scripts/antas/vault/gap/";
const NEW_IN_05C = new Set([`${GAP_DIR}validate-vlt-gap-05-C.mjs`, `${GAP_DIR}freeze-vlt-gap-05-C-baseline.mjs`]);
const COMPAT = "artifacts/api-server/src/lib/vault-crypto";

const die = (m) => { console.error(`VLT-GAP-05-C freeze REFUSED — ${m}`); process.exit(1); };
if (process.argv.slice(2).length) die("takes no arguments");
if (fs.existsSync(SEAL)) die("baseline-05c/SEAL.json already exists; the baseline is write-once");
const ts = loadTs(ROOT); if (!ts) die("TypeScript compiler API unavailable");

// 05-B evidence must be a PASS bound to the current tree (verified by executing its own --verify, not by reading status).
const v = spawnSync(process.execPath, [path.join(ROOT, `${GAP_DIR}validate-vlt-gap-05-B.mjs`), "--verify"], { encoding: "utf8" });
if (v.status !== 0) die(`05-B evidence does not verify against the current tree: ${(v.stderr || v.stdout).trim().slice(-300)}`);
const ev = JSON.parse(fs.readFileSync(path.join(EVIDENCE_DIR, "extraction-proof.json"), "utf8"));
if (ev.status !== "PASS" || ev.sub_phase !== "VLT-GAP-05-B") die("extraction-proof.json is not a 05-B PASS");

// Derive every importer of the compat adapter (static import, re-export, dynamic import, require) from the AST.
const importersOf = (target) => {
  const out = [];
  for (const abs of walkFiles(ROOT, [], (p) => /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(p) && !p.endsWith(".d.ts"))) {
    const r = rel(abs);
    if (r.startsWith("scripts/antas/") || r.startsWith("reports/") || r.includes("/node_modules/")) continue;
    const text = fs.readFileSync(abs, "utf8"); if (!/vault-crypto/.test(text)) continue;
    const sf = ts.createSourceFile(r, text, ts.ScriptTarget.Latest, true, /x$/.test(r) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const hit = (spec) => spec.startsWith(".") && rel(path.resolve(path.dirname(abs), spec)).replace(/\.(ts|js|mjs)$/, "") === target;
    let found = false;
    (function w(n) {
      if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier) && hit(n.moduleSpecifier.text)) found = true;
      if (ts.isCallExpression(n) && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0]) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require")) && hit(n.arguments[0].text)) found = true;
      ts.forEachChild(n, w);
    })(sf);
    if (found) out.push(r);
  }
  return out.sort();
};
const importers = importersOf(COMPAT);
if (importers.length < 20) die(`expected the adapter to have >= 20 importers at freeze time, found ${importers.length} (scan broken?)`);

fs.mkdirSync(path.join(BASE, "consumers"), { recursive: true });
const frozen = {};
for (const file of importers) {
  const name = file.replace(/\//g, "__");
  const dst = path.join(BASE, "consumers", name);
  fs.copyFileSync(path.join(ROOT, file), dst);
  frozen[name] = { source: file, sha256: sha256File(dst) };
}
// The adapter itself is frozen too (it must stay byte-identical: compat is retained until 05-D decides its fate).
const adapterDst = path.join(BASE, "consumers", "__adapter__lib__vault-crypto.ts");
fs.copyFileSync(path.join(ROOT, `${COMPAT}.ts`), adapterDst);

const files = {};
const gapScripts = {};
for (const f of walkFiles(ROOT)) {
  const k = rel(f);
  if (k.startsWith(GAP_DIR)) { if (!NEW_IN_05C.has(k)) gapScripts[k] = sha256File(f); continue; }
  files[k] = sha256File(f);
}
const manifestText = `${JSON.stringify({ description: "Tree certified by VLT-GAP-05-B (validator scripts under scripts/antas/vault/gap/ are recorded separately in SEAL.json)", files }, null, 2)}\n`;
fs.writeFileSync(path.join(BASE, "tree-manifest.json"), manifestText);
fs.writeFileSync(SEAL, `${JSON.stringify({
  sub_phase: "VLT-GAP-05-C",
  sealed_at: new Date().toISOString(),
  matches_05B_certified_state: true,
  tree_manifest_sha256: sha256(manifestText),
  file_count: Object.keys(files).length,
  certified_by: { sub_phase: ev.sub_phase, source_tree_sha256: ev.source_tree_sha256, commit_sha: ev.commit_sha, validator_sha256: ev.validator_sha256, source_hashes_checked: Object.keys(ev.source_hashes).length },
  compat_adapter: { source: `${COMPAT}.ts`, sha256: sha256File(adapterDst) },
  frozen_consumers: frozen,
  gap_scripts_at_freeze: gapScripts,
}, null, 2)}\n`);
console.log(`VLT-GAP-05-C baseline sealed: ${Object.keys(frozen).length} frozen consumers of lib/vault-crypto, ${Object.keys(files).length} tree entries, ${Object.keys(gapScripts).length} pre-existing validator scripts (certified by ${ev.sub_phase}).`);
