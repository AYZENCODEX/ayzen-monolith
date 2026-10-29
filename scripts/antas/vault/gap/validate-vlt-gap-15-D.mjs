#!/usr/bin/env node
// VLT-GAP-15-D -- Equivalence gate. Regenerates B and C from scratch (never trusts stored evidence), then requires:
// every cell equal, planted divergences detected, no stale differential, and every residual unexercised dimension is
// covered by a differential/validator that passes RIGHT NOW. Writes gate.json (validator-only).
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, rejectBypass, rel, sha256File, binding } from "./gap-common.mjs";
import { rcfg, GAPDIR } from "./equivalence-suite.mjs";

const GAP = "VLT-GAP-15", SUB = "VLT-GAP-15-D";
const OUT = path.join(ROOT, "reports/antas/vault/gap", GAP);
const fail = (m) => { console.error(`${SUB} FAIL -- ${m}`); process.exit(1); };
const bad = rejectBypass([]); if (bad.length) fail(`bypass rejected: ${bad.join(", ")}`);
const errors = []; const need = (c, m) => { if (!c) errors.push(m); };
const run = (s) => spawnSync(process.execPath, [path.join(GAPDIR, s)], { cwd: ROOT, encoding: "utf8", timeout: 300000 });

// 1. regenerate B then C (a hand-edited replay.json/compare.json is simply overwritten)
for (const s of ["validate-vlt-gap-15-A.mjs", "validate-vlt-gap-15-B.mjs", "validate-vlt-gap-15-C.mjs"]) { const r = run(s); need(r.status === 0, `${s} failed: ${(r.stderr || r.stdout).trim().split("\n").slice(-2).join(" / ")}`); }
const rd = (f) => JSON.parse(fs.readFileSync(path.join(OUT, f), "utf8"));
const B = rd("replay.json"), C = rd("compare.json");
need(B.status === "PASS" && C.status === "PASS", "B/C evidence is not PASS");
need(C.total_cells > 0 && C.equal_cells === C.total_cells, `only ${C.equal_cells}/${C.total_cells} cells equal`);
need(C.sensitivity_probes.length >= 4 && C.sensitivity_probes.every((p) => p.applied && p.detected_cells > 0), "a planted divergence was not detected");
need(C.stale_legacy_differentials.length === 0, `stale/failing differentials: ${C.stale_legacy_differentials.join(", ")}`);
need(Object.values(B.groups).every((g) => g.deterministic_cells === g.cells), "non-deterministic cells");

// 2. each residual (call site never executed by the replay) must be covered by something that passes now
const covers = {}; const accepted = [];
for (const o of C.open_for_15_D) {
  const cited = [...new Set(o.reason.match(/(?:differential|validate)-vlt-gap-[\w-]+/g) ?? [])].map((n) => `${n.startsWith("differential") ? n : n}.mjs`);
  if (rcfg.accepted_residual?.[`${o.group}/${o.dimension}`]) { accepted.push(`${o.group}/${o.dimension}`); continue; }
  need(!/NOT covered/.test(o.reason) && cited.length > 0, `${o.group}/${o.dimension}: residual is not covered by any cited differential/validator (${o.reason.slice(0, 80)}...)`);
  for (const s of cited) { if (!(s in covers)) { const f = fs.existsSync(path.join(GAPDIR, s)) ? s : null; covers[s] = f ? run(f).status === 0 : false; } need(covers[s], `${o.group}/${o.dimension}: cited ${s} does not exist or does not pass`); }
}

// 3. no bypass wiring: the two package scripts exist and carry no skip flags
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).scripts ?? {};
for (const k of ["validate:vault-equivalence:census", "validate:vault-equivalence:replay", "validate:vault-equivalence:compare", "validate:vault-equivalence:gate"]) need(typeof pkg[k] === "string" && !/--(force|skip|no-verify)|VALIDATION_DISABLED/i.test(pkg[k]), `package.json script ${k} missing or bypassable`);

const files = ["validate-vlt-gap-15-D.mjs", "validate-vlt-gap-15-C.mjs", "validate-vlt-gap-15-B.mjs", "equivalence-replay.mjs", "equivalence-suite.mjs", "differential-vlt-gap-15-backup.mjs", "gap-configs/vault-equivalence-replay.json"].map((f) => path.join(GAPDIR, f));
const SH = Object.fromEntries(files.map((f) => [rel(f), sha256File(f)]));
const gate = { gap: GAP, sub: SUB, stage: "gate", checked_at: new Date().toISOString(), cells: C.total_cells, equal_cells: C.equal_cells, groups: Object.fromEntries(Object.entries(C.groups).map(([g, v]) => [g, { cells: v.cells, equal: v.equal_cells, routes: v.routes, shallow_routes: v.shallow_routes }])),
  planted_divergences_detected: C.sensitivity_probes.map((p) => p.mutation), residual_covered_by: covers, residual_accepted_by_owner: accepted.map((k) => [k, rcfg.accepted_residual[k]]), equivalence_complete: errors.length === 0 && accepted.length === 0,
  known_limits: ["moved-module internals are the same fake on both sides in the route replay (covered by module-level differentials/cells)", "4 routes reach shallow paths only (allowed_shallow, listed per group)", "stand-in values: AUTH_STEP_POLICIES, CLOUD_PROVIDERS, retention days", "no-auth state not replayed (requireAuth answers first; middleware chain compared)"],
  source_hashes: SH, ...(({ source_tree_sha256 }) => ({ source_tree_sha256 }))(binding(SH)), binding: binding(SH), errors, status: errors.length ? "FAIL" : "PASS" };
fs.writeFileSync(path.join(OUT, "gate.json"), JSON.stringify(gate, null, 2) + "\n");
if (errors.length) { for (const e of errors) console.error(`  - ${e}`); fail(`${errors.length} problem(s)`); }
console.log(`${SUB} PASS -- ${gate.equal_cells}/${gate.cells} cells equal, ${gate.planted_divergences_detected.length}/4 planted divergences detected, ${Object.keys(covers).length} covering differential(s) pass`);
