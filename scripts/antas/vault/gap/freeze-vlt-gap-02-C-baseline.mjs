#!/usr/bin/env node
// VLT-GAP-02-C — one-shot, WRITE-ONCE baseline freeze. Run ONCE, before any 02-C source change.
//
// Why a separate script: 02-A rewrites its baseline directory on every run (it overwrote the frozen
// pre-extraction route with the already-extracted route). The 02-C validator therefore never writes
// baselines; it only VERIFIES this seal. This script refuses to run if a seal already exists.
//
// It freezes the exact tree that 02-B certified (verified here against the 02-B evidence hashes) so that
// every 02-C change can be proven as a delta from that state.
import fs from "node:fs";
import path from "node:path";
import { ROOT, sha256, sha256File, rel, walkFiles } from "./gap-common.mjs";

const EVIDENCE_DIR = path.join(ROOT, "reports/antas/vault/gap/VLT-GAP-02");
const BASE = path.join(EVIDENCE_DIR, "baseline-02c");
const SEAL = path.join(BASE, "SEAL.json");
const R = (f) => `artifacts/api-server/src/${f}`;

const die = (m) => { console.error(`VLT-GAP-02-C freeze REFUSED — ${m}`); process.exit(1); };
if (process.argv.slice(2).length) die("takes no arguments");
if (fs.existsSync(SEAL)) die("baseline-02c/SEAL.json already exists; the baseline is write-once");

// Consumer files that 02-C rewires (frozen verbatim as they were when 02-B certified).
const FROZEN = {
  "value-history.ts": R("routes/value-history.ts"),
  "vault.ts": R("routes/vault.ts"),
  "bulk.ts": R("routes/bulk.ts"),
  "local-accounts.route.ts": R("routes/local-accounts.ts"),
  "check-ownership-gate-coverage.ts": "scripts/src/check-ownership-gate-coverage.ts",
};

// Anchor: the sealed state must equal what 02-B certified (its validator-generated source hashes).
const ev = JSON.parse(fs.readFileSync(path.join(EVIDENCE_DIR, "extraction-proof.json"), "utf8"));
if (ev.status !== "PASS" || ev.sub_phase !== "VLT-GAP-02-B") die("02-B evidence is not a PASS");
const drift = Object.entries(ev.source_hashes).filter(([f, h]) => !fs.existsSync(path.join(ROOT, f)) || sha256File(path.join(ROOT, f)) !== h).map(([f]) => f);
if (drift.length) die(`working tree differs from the 02-B certified state: ${drift.join(", ")}`);

fs.mkdirSync(path.join(BASE, "consumers"), { recursive: true });
const frozen = {};
for (const [name, file] of Object.entries(FROZEN)) {
  const dst = path.join(BASE, "consumers", name);
  fs.copyFileSync(path.join(ROOT, file), dst);
  frozen[name] = { source: file, sha256: sha256File(dst) };
}
const files = {};
for (const f of walkFiles(ROOT)) files[rel(f)] = sha256File(f);
fs.writeFileSync(path.join(BASE, "tree-manifest.json"), `${JSON.stringify({ sub_phase: "VLT-GAP-02-C", purpose: "tree exactly as certified by 02-B, frozen before any 02-C change", file_count: Object.keys(files).length, files }, null, 2)}\n`);
const seal = {
  sub_phase: "VLT-GAP-02-C", sealed_at: new Date().toISOString(),
  matches_02B_certified_state: true, certified_by: { sub_phase: ev.sub_phase, source_tree_sha256: ev.source_tree_sha256, validator_sha256: ev.validator_sha256, source_hashes_checked: Object.keys(ev.source_hashes).length },
  frozen_consumers: frozen, tree_manifest_sha256: sha256(fs.readFileSync(path.join(BASE, "tree-manifest.json"), "utf8")),
};
fs.writeFileSync(SEAL, `${JSON.stringify(seal, null, 2)}\n`);
console.log(`VLT-GAP-02-C baseline sealed: ${Object.keys(frozen).length} consumer files, ${Object.keys(files).length} tree entries`);
