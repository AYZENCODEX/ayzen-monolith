#!/usr/bin/env node
// VLT-GAP-04-D — one-shot, WRITE-ONCE baseline freeze. Run ONCE, before any 04-D validation.
//
// Same reason as freeze-vlt-gap-04-C-baseline.mjs: baselines must never be written by a validator that
// can be re-run. The 04-D validator only
// VERIFIES this seal. The seal freezes the exact tree that 04-C certified, so 04-D can prove that the
// retirement gate itself changed no application source, and that no earlier validator was edited afterwards.
//
// Refuses to run if a seal exists, if 04-C evidence is not a current PASS, or if any argument is given.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, sha256, sha256File, rel, walkFiles } from "./gap-common.mjs";

const EVIDENCE_DIR = path.join(ROOT, "reports/antas/vault/gap/VLT-GAP-04");
const BASE = path.join(EVIDENCE_DIR, "baseline-04d");
const SEAL = path.join(BASE, "SEAL.json");
const GAP_DIR = "scripts/antas/vault/gap/";
const NEW_IN_04D = new Set([`${GAP_DIR}validate-vlt-gap-04-D.mjs`, `${GAP_DIR}freeze-vlt-gap-04-D-baseline.mjs`]);

const die = (m) => { console.error(`VLT-GAP-04-D freeze REFUSED — ${m}`); process.exit(1); };
if (process.argv.slice(2).length) die("takes no arguments");
if (fs.existsSync(SEAL)) die("baseline-04d/SEAL.json already exists; the baseline is write-once");

// 04-C evidence must be a PASS bound to the current tree (verified by executing its own --verify, not by reading status).
const v = spawnSync(process.execPath, [path.join(ROOT, `${GAP_DIR}validate-vlt-gap-04-C.mjs`), "--verify"], { encoding: "utf8" });
if (v.status !== 0) die(`04-C evidence does not verify against the current tree: ${(v.stderr || v.stdout).trim().slice(-300)}`);
const ev = JSON.parse(fs.readFileSync(path.join(EVIDENCE_DIR, "consumer-graph.json"), "utf8"));
if (ev.status !== "PASS" || ev.sub_phase !== "VLT-GAP-04-C") die("consumer-graph.json is not a 04-C PASS");

// The two files 04-D is allowed to touch, frozen verbatim as 04-C certified them (used to reconstruct the 04-C-certified state).
const FROZEN = {
  "marketplace-game.route.ts": "artifacts/api-server/src/routes/marketplace-game.ts",
  "game-ownership.ts": "artifacts/api-server/src/vault/security/game-ownership.ts",
};
fs.mkdirSync(path.join(BASE, "frozen"), { recursive: true });
const frozen = {};
for (const [name, file] of Object.entries(FROZEN)) {
  const dst = path.join(BASE, "frozen", name);
  fs.copyFileSync(path.join(ROOT, file), dst);
  frozen[name] = { source: file, sha256: sha256File(dst) };
}
const files = {};
const gapScripts = {};
for (const f of walkFiles(ROOT)) {
  const k = rel(f);
  if (k.startsWith(GAP_DIR)) { if (!NEW_IN_04D.has(k)) gapScripts[k] = sha256File(f); continue; }
  files[k] = sha256File(f);
}
fs.mkdirSync(BASE, { recursive: true });
const manifestText = `${JSON.stringify({ description: "Tree certified by VLT-GAP-04-C (validator scripts under scripts/antas/vault/gap/ are recorded separately in SEAL.json)", files }, null, 2)}\n`;
fs.writeFileSync(path.join(BASE, "tree-manifest.json"), manifestText);
fs.writeFileSync(SEAL, `${JSON.stringify({
  sealed_at: new Date().toISOString(),
  tree_manifest_sha256: sha256(manifestText),
  file_count: Object.keys(files).length,
  certified_by: { sub_phase: ev.sub_phase, source_tree_sha256: ev.source_tree_sha256, commit_sha: ev.commit_sha, validator_sha256: ev.validator_sha256 },
  frozen_files: frozen,
  gap_scripts_at_freeze: gapScripts,
}, null, 2)}\n`);
console.log(`VLT-GAP-04-D baseline sealed: ${Object.keys(files).length} files, ${Object.keys(gapScripts).length} pre-existing validator scripts (certified by ${ev.sub_phase}).`);
