#!/usr/bin/env node
// VLT-GAP-05-D — one-shot, WRITE-ONCE baseline freeze. Run ONCE, before any 05-D change.
//
// Same rationale as freeze-vlt-gap-05-C-baseline.mjs: a baseline must never be written by a validator that can be
// re-run. The 05-D validator only VERIFIES this seal. The seal freezes the exact tree that 05-C certified, plus the
// verbatim text of every file 05-D is allowed to touch, so 05-D can (a) reconstruct the 05-C-certified state in a
// temp copy and re-run 05-C there, and (b) prove the retirement changed nothing else.
//
// Refuses to run if a seal exists, if 05-C evidence is not a current PASS, or if any argument is given.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, sha256, sha256File, rel, walkFiles } from "./gap-common.mjs";

const EVIDENCE_DIR = path.join(ROOT, "reports/antas/vault/gap/VLT-GAP-05");
const BASE = path.join(EVIDENCE_DIR, "baseline-05d");
const SEAL = path.join(BASE, "SEAL.json");
const GAP_DIR = "scripts/antas/vault/gap/";
const NEW_IN_05D = new Set([`${GAP_DIR}validate-vlt-gap-05-D.mjs`, `${GAP_DIR}freeze-vlt-gap-05-D-baseline.mjs`]);

const die = (m) => { console.error(`VLT-GAP-05-D freeze REFUSED — ${m}`); process.exit(1); };
if (process.argv.slice(2).length) die("takes no arguments");
if (fs.existsSync(SEAL)) die("baseline-05d/SEAL.json already exists; the baseline is write-once");

const v = spawnSync(process.execPath, [path.join(ROOT, `${GAP_DIR}validate-vlt-gap-05-C.mjs`), "--verify"], { encoding: "utf8" });
if (v.status !== 0) die(`05-C evidence does not verify against the current tree: ${(v.stderr || v.stdout).trim().slice(-300)}`);
const ev = JSON.parse(fs.readFileSync(path.join(EVIDENCE_DIR, "consumer-graph.json"), "utf8"));
if (ev.status !== "PASS" || ev.sub_phase !== "VLT-GAP-05-C") die("consumer-graph.json is not a 05-C PASS");
if (ev.old_adapter_importers_remaining?.length) die("05-C evidence still lists importers of the adapter");

// The only files 05-D may touch, frozen verbatim as 05-C certified them.
const FROZEN = {
  "adapter__lib__vault-crypto.ts": "artifacts/api-server/src/lib/vault-crypto.ts",
  "owner__field-encryption.ts": "artifacts/api-server/src/vault/crypto/field-encryption.ts",
  "doc__file-migration-map.md": "docs/antas/vault/file-migration-map.md",
  "doc__db-touch-inventory.md": "docs/antas/vault/db-touch-inventory.md",
  "doc__architecture.md": "docs/antas/vault/architecture.md",
  "script__build-certification.mjs": "scripts/antas/vault/build-certification.mjs",
};
fs.mkdirSync(path.join(BASE, "frozen"), { recursive: true });
const frozen = {};
for (const [name, file] of Object.entries(FROZEN)) {
  const dst = path.join(BASE, "frozen", name);
  fs.copyFileSync(path.join(ROOT, file), dst);
  frozen[name] = { source: file, sha256: sha256File(dst) };
}
const files = {}; const gapScripts = {};
for (const f of walkFiles(ROOT)) {
  const k = rel(f);
  if (k.startsWith(GAP_DIR)) { if (!NEW_IN_05D.has(k)) gapScripts[k] = sha256File(f); continue; }
  files[k] = sha256File(f);
}
const manifestText = `${JSON.stringify({ description: "Tree certified by VLT-GAP-05-C (validator scripts under scripts/antas/vault/gap/ are recorded separately in SEAL.json)", files }, null, 2)}\n`;
fs.writeFileSync(path.join(BASE, "tree-manifest.json"), manifestText);
fs.writeFileSync(SEAL, `${JSON.stringify({
  sealed_at: new Date().toISOString(),
  sub_phase: "VLT-GAP-05-D",
  tree_manifest_sha256: sha256(manifestText),
  file_count: Object.keys(files).length,
  certified_by: { sub_phase: ev.sub_phase, source_tree_sha256: ev.source_tree_sha256, commit_sha: ev.commit_sha, validator_sha256: ev.validator_sha256 },
  frozen_files: frozen,
  gap_scripts_at_freeze: gapScripts,
}, null, 2)}\n`);
console.log(`VLT-GAP-05-D baseline sealed: ${Object.keys(files).length} files, ${Object.keys(gapScripts).length} pre-existing validator scripts (certified by ${ev.sub_phase}).`);
