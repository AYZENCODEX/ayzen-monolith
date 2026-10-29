#!/usr/bin/env node
// VLT-GAP-03-C — one-shot, WRITE-ONCE baseline freeze. Run ONCE, on the tree 03-B certified, BEFORE any 03-C source edit.
//
// Same reason as freeze-vlt-gap-02-C/03-B-baseline.mjs: a baseline must never be written by a validator that can be re-run.
// The 03-C validator only VERIFIES this seal. It freezes (a) the exact tree 03-B certified and (b) the verbatim text of every
// file 03-C is allowed to change, so each 03-C edit can be proven as a delta from the certified state and the OLD consumers can
// be executed side by side with the NEW ones.
//
// Refuses to run if a seal exists, if 03-B evidence is not a current PASS, or if any argument is given.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, sha256, sha256File, rel, walkFiles } from "./gap-common.mjs";

const EVIDENCE_DIR = path.join(ROOT, "reports/antas/vault/gap/VLT-GAP-03");
const BASE = path.join(EVIDENCE_DIR, "baseline-03c");
const SEAL = path.join(BASE, "SEAL.json");
const GAP_DIR = "scripts/antas/vault/gap/";
const NEW_IN_03C = new Set([`${GAP_DIR}validate-vlt-gap-03-C.mjs`, `${GAP_DIR}freeze-vlt-gap-03-C-baseline.mjs`]);
const R = (f) => `artifacts/api-server/src/${f}`;

const die = (m) => { console.error(`VLT-GAP-03-C freeze REFUSED — ${m}`); process.exit(1); };
if (process.argv.slice(2).length) die("takes no arguments");
if (fs.existsSync(SEAL)) die("baseline-03c/SEAL.json already exists; the baseline is write-once");

// 03-B evidence must be a PASS bound to the current tree (verified by executing its own --verify, not by reading status).
const v = spawnSync(process.execPath, [path.join(ROOT, `${GAP_DIR}validate-vlt-gap-03-B.mjs`), "--verify"], { encoding: "utf8" });
if (v.status !== 0) die(`03-B evidence does not verify against the current tree: ${(v.stderr || v.stdout).trim().slice(-300)}`);
const ev = JSON.parse(fs.readFileSync(path.join(EVIDENCE_DIR, "extraction-proof.json"), "utf8"));
if (ev.status !== "PASS" || ev.sub_phase !== "VLT-GAP-03-B") die("extraction-proof.json is not a 03-B PASS");

// Every file 03-C may change, frozen verbatim as 03-B certified it.
const FROZEN = {
  "exchange-api.ts": R("routes/exchange-api.ts"),
  "projects.ts": R("routes/projects.ts"),
  "kyc.route.ts": R("routes/kyc.ts"),
  "kyc-data-entities.route.ts": R("routes/kyc-data-entities.ts"),
  "kyc-ownership.ts": R("vault/security/kyc-ownership.ts"),
  "entries.ts": R("vault/application/kyc/entries.ts"),
  "test-route-ownership-regression.ts": "scripts/src/test-route-ownership-regression.ts",
  "check-ownership-gate-coverage.ts": "scripts/src/check-ownership-gate-coverage.ts",
};

fs.mkdirSync(path.join(BASE, "consumers"), { recursive: true });
const frozen = {};
for (const [name, file] of Object.entries(FROZEN)) {
  const dst = path.join(BASE, "consumers", name);
  fs.copyFileSync(path.join(ROOT, file), dst);
  frozen[name] = { source: file, sha256: sha256File(dst) };
}

const files = {};
const gapScripts = {};
for (const f of walkFiles(ROOT)) {
  const k = rel(f);
  if (k.startsWith(GAP_DIR)) { if (!NEW_IN_03C.has(k)) gapScripts[k] = sha256File(f); continue; }
  files[k] = sha256File(f);
}
const manifestText = `${JSON.stringify({ description: "Tree certified by VLT-GAP-03-B (validator scripts under scripts/antas/vault/gap/ are recorded separately in SEAL.json)", files }, null, 2)}\n`;
fs.writeFileSync(path.join(BASE, "tree-manifest.json"), manifestText);
fs.writeFileSync(SEAL, `${JSON.stringify({
  sub_phase: "VLT-GAP-03-C",
  sealed_at: new Date().toISOString(),
  matches_03B_certified_state: true,
  tree_manifest_sha256: sha256(manifestText),
  file_count: Object.keys(files).length,
  certified_by: { sub_phase: ev.sub_phase, source_tree_sha256: ev.source_tree_sha256, commit_sha: ev.commit_sha, validator_sha256: ev.validator_sha256, source_hashes_checked: Object.keys(ev.source_hashes).length },
  frozen_consumers: frozen,
  gap_scripts_at_freeze: gapScripts,
}, null, 2)}\n`);
console.log(`VLT-GAP-03-C baseline sealed: ${Object.keys(frozen).length} frozen consumer files, ${Object.keys(files).length} tree entries, ${Object.keys(gapScripts).length} pre-existing validator scripts (certified by ${ev.sub_phase}).`);
