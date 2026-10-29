#!/usr/bin/env node
// VLT-GAP-03-B — one-shot, WRITE-ONCE baseline freeze. Run ONCE, on the tree 03-A certified, BEFORE any 03-B extraction edit.
//
// Same reason as freeze-vlt-gap-02-C/02-D-baseline.mjs: baselines must never be written by a validator that can be
// re-run. The 03-B validator only VERIFIES this seal. The seal freezes the exact pre-extraction tree that 03-A
// certified, so 03-B can prove that the extraction changed only routes/kyc.ts, routes/kyc-data-entities.ts and
// vault/domain/kyc.ts, added only the declared destination files, and that no earlier validator was edited afterwards.
//
// Refuses to run if a seal exists, if 03-A evidence is not a current PASS, or if any argument is given.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, sha256, sha256File, rel, walkFiles } from "./gap-common.mjs";

const EVIDENCE_DIR = path.join(ROOT, "reports/antas/vault/gap/VLT-GAP-03");
const BASE = path.join(EVIDENCE_DIR, "baseline-03b");
const SEAL = path.join(BASE, "SEAL.json");
const GAP_DIR = "scripts/antas/vault/gap/";
const NEW_IN_03B = new Set([`${GAP_DIR}validate-vlt-gap-03-B.mjs`, `${GAP_DIR}freeze-vlt-gap-03-B-baseline.mjs`]);

const die = (m) => { console.error(`VLT-GAP-03-B freeze REFUSED — ${m}`); process.exit(1); };
if (process.argv.slice(2).length) die("takes no arguments");
if (fs.existsSync(SEAL)) die("baseline-03b/SEAL.json already exists; the baseline is write-once");

// 03-A evidence must be a PASS bound to the current tree (verified by executing its own --verify, not by reading status).
const v = spawnSync(process.execPath, [path.join(ROOT, `${GAP_DIR}validate-vlt-gap-03-A.mjs`), "--verify"], { encoding: "utf8" });
if (v.status !== 0) die(`03-A evidence does not verify against the current tree: ${(v.stderr || v.stdout).trim().slice(-300)}`);
const ev = JSON.parse(fs.readFileSync(path.join(EVIDENCE_DIR, "symbol-inventory.json"), "utf8"));
if (ev.status !== "PASS" || ev.sub_phase !== "VLT-GAP-03-A") die("symbol-inventory.json is not a 03-A PASS");

const files = {};
const gapScripts = {};
for (const f of walkFiles(ROOT)) {
  const k = rel(f);
  if (k.startsWith(GAP_DIR)) { if (!NEW_IN_03B.has(k)) gapScripts[k] = sha256File(f); continue; }
  files[k] = sha256File(f);
}
fs.mkdirSync(BASE, { recursive: true });
const manifestText = `${JSON.stringify({ description: "Tree certified by VLT-GAP-03-A (validator scripts under scripts/antas/vault/gap/ are recorded separately in SEAL.json)", files }, null, 2)}\n`;
fs.writeFileSync(path.join(BASE, "tree-manifest.json"), manifestText);
fs.writeFileSync(SEAL, `${JSON.stringify({
  sealed_at: new Date().toISOString(),
  tree_manifest_sha256: sha256(manifestText),
  file_count: Object.keys(files).length,
  certified_by: { sub_phase: ev.sub_phase, source_tree_sha256: ev.source_tree_sha256, commit_sha: ev.commit_sha, validator_sha256: ev.validator_sha256 },
  gap_scripts_at_freeze: gapScripts,
}, null, 2)}\n`);
console.log(`VLT-GAP-03-B baseline sealed: ${Object.keys(files).length} files, ${Object.keys(gapScripts).length} pre-existing validator scripts (certified by ${ev.sub_phase}).`);
