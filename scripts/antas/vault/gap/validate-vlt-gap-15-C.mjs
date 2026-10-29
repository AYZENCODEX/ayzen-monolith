#!/usr/bin/env node
// VLT-GAP-15-C -- Equivalence comparison: judge old==new on every recorded cell, tally what was actually exercised per dimension,
// and prove the comparison can see a regression (planted divergences must be detected).
//   node validate-vlt-gap-15-C.mjs        (run 15-B first; C re-executes the replay itself and checks it matches B's recording)
import fs from "node:fs";
import path from "node:path";
import { ROOT, rel, rejectBypass, sha256File, binding } from "./gap-common.mjs";
import { runSuite, cfg, rcfg, GAPDIR, groupInputs, logsOf, dimOf, digest } from "./equivalence-suite.mjs";
import { runRoutes, SCENARIOS, stable } from "./equivalence-replay.mjs";

const GAP = "VLT-GAP-15", SUB = "VLT-GAP-15-C";
const OUT = path.join(ROOT, "reports/antas/vault/gap", GAP);
const fail = (m) => { console.error(`${SUB} FAIL -- ${m}`); process.exit(1); };
const bad = rejectBypass([]); if (bad.length) fail(`bypass rejected: ${bad.join(", ")}`);
const errors = []; const need = (c, m) => { if (!c) errors.push(m); };

// 1. B's recording must exist, have passed, and describe the code/config that exists now
const bp = path.join(OUT, "replay.json");
need(fs.existsSync(bp), "replay.json missing -- run 15-B first");
const B = fs.existsSync(bp) ? JSON.parse(fs.readFileSync(bp, "utf8")) : null;
if (B) {
  need(B.status === "PASS", `15-B status is ${B.status}`);
  const files = ["equivalence-replay.mjs", "equivalence-suite.mjs", "harness.mjs", "gap-configs/vault-equivalence.json", "gap-configs/vault-equivalence-replay.json", "validate-vlt-gap-15-B.mjs"].map((f) => path.join(GAPDIR, f));
  const cur = binding(Object.fromEntries(files.map((f) => [rel(f), sha256File(f)])));
  need(cur.source_tree_sha256 === B.binding.source_tree_sha256, "15-B recording is stale: replay engine/config/validator changed since 15-B ran -- rerun 15-B");
}

// 2. fresh replay; every cell must equal B's digest AND old must equal new
const G = await runSuite();
const TOK = { audit: /\b(recordAudit|logActivity|logVaultActivity|logSubjectActivity|logBackupAudit)\s*\(/g, side_effects: /\b(createNotification|syncOnVaultDelete|delistVaultMarketplaceListings|chargeCredits|sendMail|fetch)\s*\(/g, events: /\b(broadcastEvent|publishEvent|emitEvent)\s*\(|\btype:\s*"vault\.[a-z]+\.[a-z]+"/g, encrypted_values: /\b(encrypt\w*|decrypt\w*)\s*\(/g };
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
const groups = {}; const open = [];
// VLT-GAP-19: reviewed, deliberate behaviour changes. A cell may differ old vs new only if it is listed with a reason AND the evidence
// strings still exist in the named current files; a listed change that no longer differs is stale and rejected.
const IC = rcfg.intentional_changes ?? [], icHit = new Set();
for (const x of IC) for (const q of x.requires ?? []) need(fs.readFileSync(path.join(ROOT, q.file), "utf8").includes(q.contains), `intentional change ${x.group}/${x.route}@${x.scn}: evidence \`${q.contains.slice(0, 50)}\` missing from ${q.file}`);
IC.forEach((x) => need((G[x.group]?.cells ?? []).some((c) => c.route === x.route && c.scn === x.scn && !c.equal), `intentional change ${x.group}/${x.route}@${x.scn} no longer differs old vs new -- remove it`));
const isIC = (g, c) => { const i = IC.findIndex((x) => x.group === g && x.route === c.route && x.scn === c.scn); if (i >= 0) icHit.add(i); return i >= 0; };
for (const [g, r] of Object.entries(G)) {
  r.cells = r.cells.filter((c) => !(!c.equal && isIC(g, c)));
  const diffs = r.cells.filter((c) => !c.equal);
  const stale = B ? r.cells.filter((c) => B.groups[g]?.cell_digests[`${c.route} @ ${c.scn}`] !== digest(c)) : r.cells;
  need(diffs.length === 0, `${g}: ${diffs.length} cell(s) differ old vs new, first: ${diffs[0]?.route} @ ${diffs[0]?.scn} -> ${diffs[0]?.diff}`);
  need(stale.length === 0, `${g}: ${stale.length} cell(s) differ from 15-B's recording (replay not reproducible)`);
  // per-dimension tally: what OLD did vs what NEW did (counts must match; equality of order/args is already in cell equality)
  const tally = {};
  for (const c of r.cells) {
    for (const side of ["old", "new"]) {
      const src = side === "old" ? c : { old: c.new };
      for (const [l] of logsOf(src)) for (const d of dimOf(l)) { tally[d] ??= { old: 0, new: 0 }; tally[d][side]++; }
    }
  }
  for (const [d, t] of Object.entries(tally)) need(t.old === t.new, `${g}/${d}: observed ${t.old} old vs ${t.new} new`);
  const base = strip(r.baselineText); const explained = rcfg.residual_unexercised?.[g] ?? {};
  const unexercised = [];
  for (const [d, re] of Object.entries(TOK)) {
    const sites = (base.match(re) ?? []).length;
    if (sites > 0 && !tally[d]) { unexercised.push(d); need(d in explained, `${g}/${d}: ${sites} call site(s) in OLD code never executed by the replay and no residual_unexercised explanation`); }
  }
  for (const d of Object.keys(explained)) if (!unexercised.includes(d)) { if (tally[d]) need(false, `${g}/${d}: residual_unexercised explanation is stale (dimension is now exercised) -- remove it`); }
  for (const d of unexercised) if (explained[d]) open.push({ group: g, dimension: d, reason: explained[d], covered_by_passing_differential: /covered by (differential|validate)/.test(explained[d]) && !/NOT covered/.test(explained[d]) });
  groups[g] = { cells: r.cells.length, equal_cells: r.cells.length - diffs.length, routes: new Set(r.cells.map((c) => c.route)).size, dimension_events_old_vs_new: tally, unexercised_dimensions: unexercised, shallow_routes: B?.groups[g]?.shallow_routes ?? [] };
}

// 3. sensitivity: the comparison must detect planted divergences (otherwise "0 diffs" means nothing)
const inp = groupInputs("share-attachment", cfg.groups["share-attachment"]);
const MUT = [
  ["status code", (t) => t.replace(/status\((404|403|400)\)/g, (m, c) => `status(${c === "404" ? 410 : 409})`)],
  ["error message", (t) => t.replace(/error:\s*"([^"]+)"/g, (m, s) => `error: "${s} (changed)"`)],
  ["db query arg", (t) => t.replace(/\.limit\(1\)/g, ".limit(2)")],
  ["dropped side effect", (t) => t.replace(/\b(?:publishAyzenDomainEvent|createNotification)\(/g, "Promise.resolve(")],
];
const probes = [];
for (const [name, fn] of MUT) {
  let changed = 0, detected = 0;
  const mt = {}; for (const f of inp.oldFiles) { const x = fn(inp.texts[f]); if (x !== inp.texts[f]) changed++; mt[f] = x; }
  for (const scn of SCENARIOS.slice(0, 8)) {
    const o = await runRoutes({ files: inp.oldFiles, texts: mt, scn }); need(o.loadErrors.length === 0, `sensitivity probe '${name}' broke module loading (${o.loadErrors[0]}) -- invalid probe`); const n = await runRoutes({ files: inp.newFiles, scn });
    for (const k of Object.keys(o.routes)) if (stable(o.routes[k]) !== stable(n.routes[k])) detected++;
  }
  probes.push({ mutation: name, applied: changed > 0, detected_cells: detected });
  need(changed > 0, `sensitivity probe '${name}' could not be applied to the frozen text`);
  need(detected > 0, `sensitivity probe '${name}' (planted divergence) was NOT detected -- the comparison is blind to it`);
}

const files = ["equivalence-replay.mjs", "equivalence-suite.mjs", "gap-configs/vault-equivalence-replay.json", "validate-vlt-gap-15-C.mjs"].map((f) => path.join(GAPDIR, f));
const report = { gap: GAP, sub: SUB, stage: "compare", checked_at: new Date().toISOString(), total_cells: Object.values(groups).reduce((n, g) => n + g.cells, 0), equal_cells: Object.values(groups).reduce((n, g) => n + g.equal_cells, 0),
  groups, sensitivity_probes: probes, legacy_differentials: B?.legacy_differentials ?? null,
  stale_legacy_differentials: Object.entries(B?.legacy_differentials ?? {}).filter(([, v]) => v.status !== "PASS").map(([k]) => k),
  open_for_15_D: open, equivalence_complete: errors.length === 0 && open.length === 0 && !(Object.values(B?.legacy_differentials ?? {}).some((v) => v.status !== "PASS")),
  binding: binding(Object.fromEntries(files.map((f) => [rel(f), sha256File(f)]))), errors, status: errors.length ? "FAIL" : "PASS" };
fs.writeFileSync(path.join(OUT, "compare.json"), JSON.stringify(report, null, 2) + "\n");
if (errors.length) { for (const e of errors) console.error(`  - ${e}`); fail(`${errors.length} problem(s)`); }
console.log(`${SUB} PASS -- ${report.equal_cells}/${report.total_cells} cells equal; planted divergences detected ${probes.filter((p) => p.detected_cells > 0).length}/${probes.length}; open for 15-D: ${open.length} residual dimension(s), ${report.stale_legacy_differentials.length} stale differential(s)`);
