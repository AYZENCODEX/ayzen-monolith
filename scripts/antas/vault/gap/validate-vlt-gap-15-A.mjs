#!/usr/bin/env node
// VLT-GAP-15-A — Equivalence: freeze pre-extraction fixtures + census (detection only, like 13-A / 14-A).
//   node validate-vlt-gap-15-A.mjs --freeze   (re)write the frozen contract fixtures from the sealed baseline copies
//   node validate-vlt-gap-15-A.mjs            verify the freeze (baseline hashes, fixtures regenerate identically, seal) and
//                                             write the census: contract diff old vs current + replay coverage matrix
// A freezes the OLD contract and measures what is not yet proven. It does NOT claim equivalence — 15-B..D replay and gate it.
import fs from "node:fs";
import path from "node:path";
import { ROOT, rel, rejectBypass, sha256, sha256File, binding } from "./gap-common.mjs";

const GAP = "VLT-GAP-15", SUB = "VLT-GAP-15-A";
const OUT = path.join(ROOT, "reports/antas/vault/gap", GAP);
const FIX_DIR = path.join(OUT, "fixtures");
const FIX = path.join(FIX_DIR, "contract-fixtures.json");
const SEAL = path.join(FIX_DIR, "contract-fixtures.sha256");
const CFG_PATH = path.join(ROOT, "scripts/antas/vault/gap/gap-configs/vault-equivalence.json");
const GAPDIR = path.join(ROOT, "scripts/antas/vault/gap");
const fail = (m) => { console.error(`${SUB} FAIL — ${m}`); process.exit(1); };
const bad = rejectBypass(["--freeze"]);
if (bad.length) fail(`bypass rejected: ${bad.join(", ")}`);
const FREEZE = process.argv.includes("--freeze");
const cfg = JSON.parse(fs.readFileSync(CFG_PATH, "utf8"));
const errors = [];
const need = (c, m) => { if (!c) errors.push(m); };

// ── contract extraction (literal-parity, text based, comments stripped on both sides) ───────────────────────────
const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
const uniq = (a) => [...new Set(a)].sort();
const all = (re, t, g = 1) => [...t.matchAll(re)].map((m) => m[g]);
const CALLEES = ["broadcastEvent", "publishEvent", "emitEvent", "recordAudit", "logActivity", "logVaultActivity", "logSubjectActivity", "logBackupAudit", "createNotification", "syncOnVaultDelete", "delistVaultMarketplaceListings", "chargeCredits"];
// extraction renamed some callees behind ports (14-B); count the port alias as the same call
const ALIAS = { createNotification: "(?:Provider)?" };
function extract(raw) {
  const t = stripComments(raw);
  const callees = {};
  for (const c of CALLEES) { const n = (t.match(new RegExp(`\\b${c}${ALIAS[c] ?? ""}\\s*\\(`, "g")) ?? []).length; if (n) callees[c] = n; }
  return {
    routes: uniq([...t.matchAll(/\brouter\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/g)].map((m) => `${m[1].toUpperCase()} ${m[2]}`)),
    status_codes: uniq([...all(/\bstatus\(\s*(\d{3})\s*\)/g, t), ...all(/\bstatus:\s*(\d{3})\b/g, t)]),
    error_messages: uniq(all(/\berror:\s*"((?:[^"\\\n]|\\.)*)"/g, t)),
    error_codes: uniq(all(/\bcode:\s*"([A-Za-z0-9_.:-]+)"/g, t)),
    events: uniq([...all(/\b(?:broadcastEvent|publishEvent|emitEvent)\(\s*"([^"]+)"/g, t), ...all(/\btype:\s*"(vault\.[\w.]+)"/g, t)]),
    audit_actions: uniq(all(/\baction:\s*"([\w.:-]+)"/g, t)),
    side_effect_callees: callees,
  };
}
const SETS = ["routes", "status_codes", "error_messages", "error_codes", "events", "audit_actions"];

// ── collect current code per group ──────────────────────────────────────────────────────────────────────────────
const SRC = path.join(ROOT, cfg.src_root);
const tsIn = (p, out = []) => { const st = fs.statSync(p); if (st.isFile()) { if (/\.tsx?$/.test(p) && !/\.d\.ts$/.test(p)) out.push(p); } else for (const e of fs.readdirSync(p)) if (e !== "node_modules") tsIn(path.join(p, e), out); return out; };
function currentFor(g) {
  const files = [];
  for (const f of g.current_files) { const p = path.join(SRC, f); if (!fs.existsSync(p)) errors.push(`current file missing: ${f}`); else files.push(p); }
  for (const d of g.current_dirs) { const p = path.join(SRC, d); if (!fs.existsSync(p)) errors.push(`current dir/file missing: ${d}`); else tsIn(p, files); }
  return [...new Set(files)].sort();
}
function merge(parts) {
  const o = Object.fromEntries(SETS.map((k) => [k, []])); o.side_effect_callees = {};
  for (const p of parts) { for (const k of SETS) o[k].push(...p[k]); for (const [c, n] of Object.entries(p.side_effect_callees)) o.side_effect_callees[c] = (o.side_effect_callees[c] ?? 0) + n; }
  for (const k of SETS) o[k] = uniq(o[k]);
  return o;
}

// ── manifest hashes (sealed by the gap that froze each baseline) ────────────────────────────────────────────────
const manifestHash = new Map();
for (const m of fs.readdirSync(path.join(ROOT, "reports/antas/vault/gap"))) {
  const mp = path.join(ROOT, "reports/antas/vault/gap", m, "baseline/repo-manifest.json");
  if (!fs.existsSync(mp)) continue;
  const j = JSON.parse(fs.readFileSync(mp, "utf8"));
  for (const s of j.sources ?? []) if (s.baseline_copy && s.sha256) manifestHash.set(s.baseline_copy, s.sha256);
  if (j.files && typeof j.files === "object") for (const [k, v] of Object.entries(j.files)) { const sha = typeof v === "string" ? v : v?.sha256; if (sha) manifestHash.set(k, sha); }
}

// ── build fixtures from the frozen baseline copies ──────────────────────────────────────────────────────────────
const fixtures = { gap: GAP, kind: "frozen-pre-extraction-contract", groups: {} };
const hashProblems = [];
for (const [name, g] of Object.entries(cfg.groups)) {
  const files = [];
  for (const b of g.baseline) {
    const abs = path.join(ROOT, b);
    if (!fs.existsSync(abs)) { errors.push(`${name}: baseline copy missing ${b}`); continue; }
    const sha = sha256File(abs);
    const mh = manifestHash.get(b) ?? manifestHash.get(path.basename(b)) ?? manifestHash.get(`artifacts/api-server/src/routes/${path.basename(b)}`) ?? null;
    if (mh && mh !== sha) hashProblems.push(`${name}: ${b} sha256 ${sha.slice(0, 12)} != manifest ${mh.slice(0, 12)}`);
    files.push({ baseline_copy: b, sha256: sha, manifest_sha256: mh, manifest_verified: mh === sha, lines: fs.readFileSync(abs, "utf8").split("\n").length, ...extract(fs.readFileSync(abs, "utf8")) });
  }
  fixtures.groups[name] = { tasks: g.tasks, note: g.note ?? null, files, merged: merge(files) };
  need(files.length > 0 && files.some((f) => SETS.some((k) => f[k].length) || Object.keys(f.side_effect_callees).length), `${name}: no contract literals extracted from baseline (fail closed)`);
}
for (const h of hashProblems) errors.push(`baseline changed since it was frozen — ${h}`);
const fixtureText = JSON.stringify(fixtures, null, 2) + "\n";

if (FREEZE) {
  if (errors.length) { for (const e of errors) console.error(`  ${e}`); fail(`${errors.length} problem(s), nothing frozen`); }
  fs.mkdirSync(FIX_DIR, { recursive: true });
  fs.writeFileSync(FIX, fixtureText); fs.writeFileSync(SEAL, sha256(fixtureText) + "\n");
  console.log(`${SUB} frozen — ${Object.keys(fixtures.groups).length} groups, ${Object.values(fixtures.groups).reduce((n, g) => n + g.files.length, 0)} baseline files, seal ${sha256(fixtureText).slice(0, 16)}…`);
  process.exit(0);
}

// ── verify freeze ───────────────────────────────────────────────────────────────────────────────────────────────
need(fs.existsSync(FIX) && fs.existsSync(SEAL), "fixtures not frozen — run with --freeze once (fail closed)");
let frozen = null;
if (fs.existsSync(FIX) && fs.existsSync(SEAL)) {
  const onDisk = fs.readFileSync(FIX, "utf8");
  need(sha256(onDisk) === fs.readFileSync(SEAL, "utf8").trim(), "contract-fixtures.json does not match its seal (edited after freeze)");
  need(onDisk === fixtureText, "fixtures regenerated from the baseline copies differ from the frozen file");
  frozen = JSON.parse(onDisk);
}

// ── census: old contract vs current code, per group ─────────────────────────────────────────────────────────────
const explainedPath = path.join(GAPDIR, "gap-configs/vault-equivalence-explained.json");
const explained = fs.existsSync(explainedPath) ? JSON.parse(fs.readFileSync(explainedPath, "utf8")) : { explained: [] };
// an explanation is only honoured if its `requires` substrings really exist in the named current file(s)
const explanationHolds = (e) => !!e.reason && Array.isArray(e.requires) && e.requires.length > 0 && e.requires.every((r) => { const p = path.join(ROOT, r.file); return fs.existsSync(p) && fs.readFileSync(p, "utf8").includes(r.contains); });
for (const e of explained.explained) if (!explanationHolds(e)) errors.push(`explanation for [${e.group}] ${e.kind}: "${String(e.value).slice(0, 60)}" is not backed by its \`requires\` evidence`);
const isExplained = (grp, kind, value) => explained.explained.some((e) => e.group === grp && e.kind === kind && e.value === value && explanationHolds(e));
const census = {}, unexplained = [];
for (const [name, g] of Object.entries(cfg.groups)) {
  const cur = merge(currentFor(g).map((f) => extract(fs.readFileSync(f, "utf8"))));
  const old = (frozen ?? fixtures).groups[name].merged;
  const diff = {};
  for (const k of SETS) {
    const missing = old[k].filter((v) => !cur[k].includes(v)), added = cur[k].filter((v) => !old[k].includes(v));
    diff[k] = { old: old[k].length, current: cur[k].length, missing_in_current: missing, added_in_current: added.length };
    for (const v of missing) if (!isExplained(name, k, v)) unexplained.push({ group: name, kind: k, value: v });
  }
  const callees = {};
  for (const c of new Set([...Object.keys(old.side_effect_callees), ...Object.keys(cur.side_effect_callees)])) callees[c] = { old: old.side_effect_callees[c] ?? 0, current: cur.side_effect_callees[c] ?? 0 };
  census[name] = { tasks: g.tasks, diff, side_effect_callee_counts: callees, callee_count_drops: Object.entries(callees).filter(([, v]) => v.current < v.old).map(([c, v]) => `${c} ${v.old}→${v.current}`) };
}

// ── replay coverage matrix: which existing executable evidence touches which dimension ──────────────────────────
// heuristic: an evidence script/report "signals" a dimension if its text contains the dimension's pattern. It shows
// where NO evidence exists at all; it does not prove a signalled dimension was compared 1:1 (that is 15-B..D's job).
const dims = Object.fromEntries(Object.entries(cfg.dimensions).map(([k, v]) => [k, new RegExp(v, "i")]));
const coverage = {};
for (const [name, g] of Object.entries(cfg.groups)) {
  const ev = [];
  for (const s of g.evidence_scripts) { const p = path.join(GAPDIR, s); if (fs.existsSync(p)) ev.push({ kind: "script", path: rel(p), text: fs.readFileSync(p, "utf8") }); else errors.push(`${name}: evidence script missing ${s}`); }
  for (const r of g.evidence_reports) { const p = path.join(ROOT, "reports/antas/vault/gap", r); if (fs.existsSync(p)) ev.push({ kind: "report", path: rel(p), text: fs.readFileSync(p, "utf8") }); else errors.push(`${name}: evidence report missing ${r}`); }
  const executesBoth = ev.some((e) => e.kind === "script" && /differential|harness|loadTs|createEnv/.test(e.text));
  const cells = {};
  for (const [d, re] of Object.entries(dims)) cells[d] = ev.filter((e) => re.test(e.text)).map((e) => e.path);
  coverage[name] = { tasks: g.tasks, evidence: ev.map((e) => e.path), executes_old_vs_new: executesBoth, dimensions: Object.fromEntries(Object.entries(cells).map(([d, v]) => [d, v.length ? "signalled" : "NONE"])) };
}
const explainedCount = explained.explained.length;
const uncovered = [];
for (const [name, c] of Object.entries(coverage)) {
  if (!c.executes_old_vs_new) uncovered.push({ group: name, cell: "no executed old-vs-new replay (static/validator evidence only)" });
  for (const [d, v] of Object.entries(c.dimensions)) if (v === "NONE") uncovered.push({ group: name, cell: d });
}
const taskCover = Object.fromEntries(Object.entries(cfg.replay_tasks).map(([t, label]) => [t, { label, groups: Object.entries(cfg.groups).filter(([, g]) => g.tasks.includes(+t)).map(([n]) => n) }]));
for (const [t, v] of Object.entries(taskCover)) need(v.groups.length > 0, `replay task ${t} (${v.label}) has no fixture group`);

// ── evidence ────────────────────────────────────────────────────────────────────────────────────────────────────
const hashed = { [rel(CFG_PATH)]: sha256File(CFG_PATH), [rel(FIX)]: fs.existsSync(FIX) ? sha256File(FIX) : null, [rel(path.join(GAPDIR, "validate-vlt-gap-15-A.mjs"))]: sha256File(path.join(GAPDIR, "validate-vlt-gap-15-A.mjs")) };
const report = {
  gap: GAP, sub_phase: SUB, validator_version: "15-A.1", checked_at: new Date().toISOString(), ...binding(Object.fromEntries(Object.entries(hashed).filter(([, v]) => v))),
  freeze: { groups: Object.keys(cfg.groups).length, baseline_files: Object.values(fixtures.groups).reduce((n, g) => n + g.files.length, 0), manifest_verified: Object.values(fixtures.groups).flatMap((g) => g.files).filter((f) => f.manifest_verified).length, seal: fs.existsSync(SEAL) ? fs.readFileSync(SEAL, "utf8").trim() : null },
  replay_tasks: taskCover, contract_census: census, coverage, 
  open_for_15_B_to_D: { unexplained_contract_differences: unexplained, callee_count_drops: Object.entries(census).flatMap(([g, c]) => c.callee_count_drops.map((d) => `${g}: ${d}`)), uncovered_cells: uncovered },
  explained_differences: explained.explained,
  equivalence_proven: false, // A never claims this
  errors, status: errors.length ? "FAIL" : "PASS",
};
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "equivalence-census.json"), JSON.stringify(report, null, 2) + "\n");
if (errors.length) { for (const e of errors) console.error(`  ${e}`); fail(`${errors.length} problem(s)`); }
console.log(`${SUB} PASS (detection) — ${report.freeze.baseline_files} pre-extraction files frozen in ${report.freeze.groups} groups (${report.freeze.manifest_verified} hash-verified against their gap manifest, rest sealed by fixtures seal only)`);
console.log(`  open for 15-B..D: ${unexplained.length} unexplained contract difference(s), ${report.open_for_15_B_to_D.callee_count_drops.length} side-effect call-count drop(s), ${uncovered.length} uncovered replay cell(s)`);
for (const u of unexplained.slice(0, 40)) console.log(`    [${u.group}] ${u.kind}: ${u.value.slice(0, 110)}`);
