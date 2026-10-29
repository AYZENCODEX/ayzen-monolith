#!/usr/bin/env node
// VLT-GAP-18 — Anti-bypass / tamper gate (Hardening H1). One script, whole gate set, no per-gate copies.
//   bypass     every gate script (validate-vlt-gap-*.mjs, differential-*.mjs) is run in a clean copy of the tree with a bypass flag
//              (--skip-validation) and with a bypass env (VALIDATION_DISABLED=true): it must exit non-zero, say "bypass", and write nothing.
//   integrity  evidence the other gates trust (gate / retire-proof / extraction-proof / map-check / ...) with status PASS must carry
//              the validator-generated shape: source_hashes + a source_tree_sha256 that is the hash of exactly those entries.
//   ledger     evidence-ledger.json pins status + canonical sha256 of every evidence file. A hand edit, a deleted FAIL, or a new
//              fabricated PASS no longer matches. Only `--seal` rewrites it, and --seal refuses a FAIL->PASS upgrade unless the
//              owning gate regenerated PASS in a clean copy. With VLT_EVIDENCE_HMAC_KEY set the ledger is also HMAC-signed.
//   regen      the fast deterministic gates are re-run in a clean copy; every evidence file they rewrite must equal the committed
//              one (timestamps plus clean-copy-only Git/mtime metadata ignored). This catches a hand edit even if the ledger was re-sealed over it.
//   mutations  the checks above are attacked on a copy of the real tree (8 planted lies); each must be caught by the right detector.
//   wiring     package.json scripts + both CI workflows run this gate as a plain blocking step.
// Usage: node validate-vlt-gap-18.mjs [--seal] [--root <dir>]
// Writes reports/antas/vault/gap/VLT-GAP-18/tamper-check.json — `status` is written by this script only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { ROOT as REPO_ROOT, rejectBypass, binding, sha256, sha256File } from "./gap-common.mjs";

const GAP = "VLT-GAP-18", VERSION = "18.1";
const argv = process.argv.slice(2);
const fail = (m) => { console.error(`${GAP} FAIL — ${m}`); process.exit(1); };
const bad = rejectBypass(["--seal", "--root"]);
if (bad.length) fail(`bypass rejected: ${bad.join(", ")}`);
for (const [k, v] of Object.entries(process.env)) if (/^(VALIDATION_DISABLED|ANTAS_BYPASS|VLT_BYPASS|VAULT_BYPASS)$/i.test(k) && v && !/^(0|false|no)$/i.test(v)) fail(`bypass rejected: ${k}`);
const ri = argv.indexOf("--root");
if (ri >= 0 && (!argv[ri + 1] || argv[ri + 1].startsWith("-"))) fail("--root needs a directory (fail closed)");
const ROOT = ri >= 0 ? path.resolve(argv[ri + 1]) : REPO_ROOT;
const SEAL = argv.includes("--seal");

const GAPDIR = "scripts/antas/vault/gap";
const EVID = "reports/antas/vault/gap";
const OWN_DIR = `${EVID}/${GAP}`;
const LEDGER = `${OWN_DIR}/evidence-ledger.json`;
const REPORT = `${OWN_DIR}/tamper-check.json`;
const SELF = `${GAPDIR}/validate-vlt-gap-18.mjs`;
// Evidence other gates read to decide "certified" (gap-17-common evidenceState + the map). A PASS here must look validator-generated.
const TRUSTED = new Set(["gate.json", "retire-proof.json", "extraction-proof.json", "map-check.json"]);
// Fast, deterministic gates that can be re-run on every CI pass. The heavy -D wrappers are not (they re-run these plus planted-case proofs).
const REGEN = ["13", "13-C", "14", "14-C", "15-A", "16", "16-C", "17", "20-C"].map((s) => `${GAPDIR}/validate-vlt-gap-${s}.mjs`);
const KEY = process.env.VLT_EVIDENCE_HMAC_KEY || null;

const read = (root, f) => fs.readFileSync(path.join(root, f), "utf8");
const exists = (root, f) => fs.existsSync(path.join(root, f));
const volatile = (k) => /_at$/.test(k);
const regenOnlyMetadata = (k) => ["commit_sha", "commit_binding", "source_mtime_latest"].includes(k);
const canon = (v, omit = () => false) => (Array.isArray(v) ? v.map((x) => canon(x, omit)) : v && typeof v === "object"
  ? Object.fromEntries(Object.entries(v).filter(([k]) => !volatile(k) && !omit(k)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, canon(x, omit)])) : v);
const canonHash = (j) => sha256(JSON.stringify(canon(j)));
const regenHash = (j) => sha256(JSON.stringify(canon(j, regenOnlyMetadata)));

function evidenceFiles(root) {
  const out = [], base = path.join(root, EVID);
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!/^baseline/.test(e.name) && e.name !== "fixtures" && e.name !== "VLT-GAP-21" && p !== path.join(root, OWN_DIR)) walk(p); } // VLT-GAP-21 is the OUTPUT of the final gate (which itself runs this one), not evidence it can ledger
      else if (e.name.endsWith(".json")) out.push(path.relative(root, p).split(path.sep).join("/"));
    }
  };
  if (fs.existsSync(base)) walk(base);
  return out.sort();
}
function loadEvidence(root) {
  const m = {}, errs = [];
  for (const f of evidenceFiles(root)) {
    let j;
    try { j = JSON.parse(read(root, f)); } catch { errs.push({ file: f, rule: "json", message: "evidence is not valid JSON" }); continue; }
    if (j && typeof j === "object" && "status" in j) m[f] = j;
  }
  return { m, errs };
}

// ── integrity: PASS evidence must look validator-generated ───────────────────────────────────────────────────────────────
function integrity(root) {
  const { m, errs } = loadEvidence(root), findings = [...errs], stale = [];
  for (const [f, j] of Object.entries(m)) {
    if (j.status !== "PASS" && j.status !== "FAIL") findings.push({ file: f, rule: "status-value", message: `status ${JSON.stringify(j.status)} is not PASS/FAIL` });
    if (j.status !== "PASS" || !TRUSTED.has(path.basename(f))) continue;
    const sh = j.source_hashes;
    if (!sh || typeof sh !== "object" || !Object.keys(sh).length || !j.source_tree_sha256) { findings.push({ file: f, rule: "forged-shape", message: "PASS evidence has no source_hashes / source_tree_sha256 — not validator-generated" }); continue; }
    const tree = sha256(Object.entries(sh).sort().map(([k, v]) => `${k}:${v}`).join("\n"));
    if (tree !== j.source_tree_sha256) findings.push({ file: f, rule: "binding-mismatch", message: "source_tree_sha256 is not the hash of source_hashes (hand-edited)" });
    for (const [p, h] of Object.entries(sh)) {
      if (!exists(root, p)) stale.push({ file: f, path: p, why: "missing" });
      else if (p.startsWith(GAPDIR) && sha256File(path.join(root, p)) !== h) stale.push({ file: f, path: p, why: "changed since evidence" });
    }
  }
  return { findings, stale, count: Object.keys(m).length, m };
}

// ── ledger ────────────────────────────────────────────────────────────────────────────────────────────────────────────
const entriesOf = (m) => Object.fromEntries(Object.entries(m).map(([f, j]) => [f, { status: j.status, sha256: canonHash(j) }]));
const hmacOf = (entries) => crypto.createHmac("sha256", KEY).update(JSON.stringify(entries)).digest("hex");
function ledgerCheck(root, m) {
  const f = [];
  if (!exists(root, LEDGER)) return { findings: [{ file: LEDGER, rule: "ledger-missing", message: "no evidence ledger (fail closed) — run with --seal once, reviewed" }], hmac_verified: false };
  let L;
  try { L = JSON.parse(read(root, LEDGER)); } catch { return { findings: [{ file: LEDGER, rule: "ledger-json", message: "ledger is not valid JSON" }], hmac_verified: false }; }
  const cur = entriesOf(m), prev = L.entries || {};
  for (const [p, e] of Object.entries(cur)) {
    if (!prev[p]) f.push({ file: p, rule: "unledgered", message: "evidence file is not in the ledger (new/fabricated)" });
    else if (prev[p].sha256 !== e.sha256 || prev[p].status !== e.status) f.push({ file: p, rule: "ledger-mismatch", message: `content differs from sealed ledger (sealed ${prev[p].status}, now ${e.status})` });
  }
  for (const p of Object.keys(prev)) if (!cur[p]) f.push({ file: p, rule: "ledger-missing-evidence", message: "sealed evidence file is gone or lost its status (deleted FAIL?)" });
  let hv = false;
  if (L.hmac) {
    if (KEY) { hv = hmacOf(prev) === L.hmac; if (!hv) f.push({ file: LEDGER, rule: "ledger-hmac", message: "ledger HMAC does not verify" }); }
  } else if (KEY) f.push({ file: LEDGER, rule: "ledger-unsigned", message: "VLT_EVIDENCE_HMAC_KEY is set but the ledger is unsigned" });
  return { findings: f, hmac_verified: hv };
}

// ── clean copy + gate runs ─────────────────────────────────────────────────────────────────────────────────────────────
function cleanCopy(root) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vlt-gap-18-"));
  fs.cpSync(root, dir, { recursive: true, filter: (s) => !/(^|\/)(node_modules|\.git)(\/|$)/.test(s.slice(root.length)) });
  return dir;
}
const run = (cwd, script, args = [], env = {}) => spawnSync(process.execPath, [path.join(cwd, script), ...args], {
  cwd,
  encoding: "utf8",
  timeout: 180000,
  env: {
    ...process.env,
    NODE_PATH: [process.env.NODE_PATH, path.join(ROOT, "node_modules")].filter(Boolean).join(path.delimiter),
    ...env,
  },
});
const evidenceSnapshot = (root) => Object.fromEntries(evidenceFiles(root).map((f) => [f, sha256File(path.join(root, f))]));
const diffSnap = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]);

function gateScripts(root) {
  const d = path.join(root, GAPDIR);
  return fs.readdirSync(d).filter((n) => /^(validate-vlt-gap-.+|differential-.+)\.mjs$/.test(n) && n !== path.basename(SELF)).sort().map((n) => `${GAPDIR}/${n}`);
}
function bypassCheck(work, scripts) {
  const results = [];
  for (const s of scripts) {
    const before = evidenceSnapshot(work), problems = [];
    for (const [label, args, env] of [["--skip-validation", ["--skip-validation"], {}], ["VALIDATION_DISABLED=true", [], { VALIDATION_DISABLED: "true" }]]) {
      const r = run(work, s, args, env), out = `${r.stdout || ""}${r.stderr || ""}`;
      if (r.error) problems.push(`${label}: did not finish (${r.error.code || r.error.message})`);
      else if (r.status === 0) problems.push(`${label}: exited 0 — bypass accepted`);
      else if (!/bypass/i.test(out)) problems.push(`${label}: exit ${r.status} but not a bypass rejection`);
    }
    const touched = diffSnap(before, evidenceSnapshot(work));
    if (touched.length) problems.push(`bypass run wrote evidence: ${touched.join(", ")}`);
    results.push({ script: s, rejected: problems.length === 0, problems });
  }
  return results;
}
function regenCheck(work) {
  const before = loadEvidence(work).m, rawBefore = evidenceSnapshot(work), ran = [];
  for (const s of REGEN) { const r = run(work, s); ran.push({ script: s, exit: r.status }); }
  const after = loadEvidence(work).m, diffs = [];
  const rewritten = Object.fromEntries(diffSnap(rawBefore, evidenceSnapshot(work)).filter((f) => after[f]).map((f) => [f, after[f]]));
  for (const f of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!before[f] || !after[f]) { if (!before[f]) diffs.push({ file: f, rule: "regen-new", message: "gate produced evidence that was not committed" }); continue; }
    if (regenHash(before[f]) !== regenHash(after[f])) diffs.push({ file: f, rule: "regen-diff", message: `committed ${before[f].status} evidence differs from what the gate regenerates (${after[f].status})` });
  }
  return { ran, diffs, rewritten, failed_gates: ran.filter((r) => r.exit !== 0).map((r) => r.script) };
}

// ── seal ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
function sealLedger(root, m, regenerated) {
  const prevL = exists(root, LEDGER) ? JSON.parse(read(root, LEDGER)) : null, prev = prevL?.entries || {}, cur = entriesOf(m), refused = [];
  for (const [p, e] of Object.entries(cur)) {
    if (prev[p]?.status === "FAIL" && e.status === "PASS" && !(regenerated?.[p]?.status === "PASS" && canonHash(regenerated[p]) === e.sha256)) refused.push(`${p}: FAIL->PASS upgrade not reproduced by its gate in a clean copy`);
  }
  for (const p of Object.keys(prev)) if (!cur[p]) refused.push(`${p}: sealed evidence removed`);
  if (refused.length) return { ok: false, refused };
  const L = { phase: GAP, validator_version: VERSION, sealed_at: new Date().toISOString(), hmac: KEY ? hmacOf(cur) : null, entries: cur };
  return { ok: true, ledger: L };
}

// ── mutations: attack the checks on a copy of the real tree ────────────────────────────────────────────────────────────
function mutations(work, regenerated) {
  const out = [];
  const wj = (f) => JSON.parse(read(work, f)), ww = (f, j) => { fs.mkdirSync(path.dirname(path.join(work, f)), { recursive: true }); fs.writeFileSync(path.join(work, f), JSON.stringify(j, null, 2)); };
  const detect = () => { const i = integrity(work), l = ledgerCheck(work, i.m); return { integrity: i.findings.length > 0, ledger: l.findings.length > 0 }; };
  const trial = (name, need, mutate, restore, probe = detect) => {
    mutate();
    let got; try { got = probe(); } finally { restore(); }
    out.push({ mutation: name, must_be_caught_by: need, caught_by: Object.keys(got).filter((k) => got[k]), caught: need.every((k) => got[k]) });
  };
  const keep = (f) => { const had = exists(work, f), raw = had ? read(work, f) : null; return () => (had ? fs.writeFileSync(path.join(work, f), raw) : fs.rmSync(path.join(work, f), { force: true })); };
  const g04 = `${EVID}/VLT-GAP-04/gate.json`, g16 = `${EVID}/VLT-GAP-16/gate.json`, g07 = `${EVID}/VLT-GAP-07/gate.json`, m17 = `${EVID}/VLT-GAP-17/map-check.json`;
  const need = (f) => { if (!exists(work, f) && !f.includes("VLT-GAP-07")) throw new Error(`mutation target missing: ${f} (fail closed)`); };
  [g04, g16, m17].forEach(need);

  let r = keep(g04);
  trial("flip VLT-GAP-04 gate.json FAIL->PASS by hand", ["ledger"], () => { const j = wj(g04); j.status = "PASS"; ww(g04, j); }, r);
  r = keep(g04);
  trial("delete VLT-GAP-04 gate.json (hide a FAIL)", ["ledger"], () => fs.rmSync(path.join(work, g04)), r);
  r = keep(g07);
  trial("fabricate a bare PASS gate.json for VLT-GAP-07", ["integrity", "ledger"], () => ww(g07, { status: "PASS" }), r);
  r = keep(g16);
  trial("edit source_tree_sha256 in VLT-GAP-16 gate.json", ["integrity", "ledger"], () => { const j = wj(g16); j.source_tree_sha256 = "0".repeat(64); ww(g16, j); }, r);
  r = keep(g16);
  trial("edit a source_hashes value in VLT-GAP-16 gate.json", ["integrity", "ledger"], () => { const j = wj(g16); const k = Object.keys(j.source_hashes)[0]; j.source_hashes[k] = "f".repeat(64); ww(g16, j); }, r);

  // attacker edits evidence AND re-seals the ledger over it: ledger+integrity are fooled, regeneration must not be.
  const rl = keep(LEDGER), rm = keep(m17);
  trial("hand-edit map-check.json, then re-seal the ledger over it", ["regen"], () => {
    const j = wj(m17); j.hand_edited_claim = "all rows verified"; ww(m17, j);
    const ents = entriesOf(loadEvidence(work).m); // attacker writes the ledger directly, no --seal guard
    ww(LEDGER, { phase: GAP, entries: ents, hmac: KEY ? hmacOf(ents) : null });
  }, () => { rl(); rm(); }, () => ({ regen: regenCheck(work).diffs.some((d) => d.file === m17) }));

  // --seal must refuse to launder a FAIL->PASS flip
  r = keep(g04);
  trial("--seal over a hand-flipped VLT-GAP-04 FAIL->PASS", ["seal-refuses"], () => { const j = wj(g04); j.status = "PASS"; ww(g04, j); }, r, () => ({ "seal-refuses": !sealLedger(work, loadEvidence(work).m, regenerated).ok }));

  // a gate that ignores bypass flags must be flagged
  const fake = `${GAPDIR}/validate-vlt-gap-99-fake.mjs`;
  trial("plant a gate script that ignores --skip-validation", ["bypass"], () => fs.writeFileSync(path.join(work, fake), "process.exit(0);\n"), () => fs.rmSync(path.join(work, fake), { force: true }), () => ({ bypass: !bypassCheck(work, [fake])[0].rejected }));
  return out;
}

// ── wiring ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
function wiring(root) {
  const f = [], pkg = JSON.parse(read(root, "package.json"));
  const want = { "validate:vault-tamper": `node ${SELF}`, "seal:vault-evidence": `node ${SELF} --seal` };
  for (const [k, v] of Object.entries(want)) if (pkg.scripts?.[k] !== v) f.push(`package.json "${k}" is ${JSON.stringify(pkg.scripts?.[k])}, expected ${JSON.stringify(v)}`);
  const unsafe = /continue-on-error|^\s*(-\s+)?if:|\|\|\s*(true|:|exit\s+0)|;\s*(true|exit\s+0)\s*$|\bset\s+\+e\b/;
  for (const wf of [".github/workflows/ci.yml", "ci/enforcement-pipeline.yml"]) {
    if (!exists(root, wf)) { f.push(`${wf} missing`); continue; }
    const lines = read(root, wf).split("\n"), i = lines.findIndex((l) => /^\s*-\s+run:\s+pnpm validate:vault-tamper\s*$/.test(l));
    if (i < 0) f.push(`${wf} has no plain "pnpm validate:vault-tamper" step`);
    else if (unsafe.test(lines[i]) || (lines[i + 1] && /^\s+(continue-on-error|if):/.test(lines[i + 1]))) f.push(`${wf} step is not blocking`);
  }
  return f;
}

// ── main ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
if (!exists(ROOT, `${EVID}`) || !exists(ROOT, GAPDIR)) fail("evidence or gate directory missing (fail closed)");
const started = Date.now();
const scripts = gateScripts(ROOT);
if (scripts.length < 20) fail(`only ${scripts.length} gate scripts found (fail closed)`);

const work = cleanCopy(ROOT);
const integ = integrity(ROOT);
let bypass, regen, mut;
try {
  bypass = bypassCheck(work, scripts);
  regen = regenCheck(work);
  if (SEAL) {
    if (integ.findings.length) fail(`refusing to seal: ${integ.findings.map((x) => `${x.file} [${x.rule}]`).join("; ")}`);
    const s = sealLedger(ROOT, integ.m, regen.rewritten);
    if (!s.ok) fail(`refusing to seal: ${s.refused.join("; ")}`);
    fs.mkdirSync(path.join(ROOT, OWN_DIR), { recursive: true });
    fs.mkdirSync(path.join(work, OWN_DIR), { recursive: true });
    for (const d of [ROOT, work]) fs.writeFileSync(path.join(d, LEDGER), JSON.stringify(s.ledger, null, 2) + "\n");
    console.log(`${GAP} sealed ${Object.keys(s.ledger.entries).length} evidence files${KEY ? " (HMAC-signed)" : " (unsigned: set VLT_EVIDENCE_HMAC_KEY in CI to sign)"}`);
  }
  mut = mutations(work, regen.rewritten);
} finally { fs.rmSync(work, { recursive: true, force: true }); }

const led = ledgerCheck(ROOT, integ.m);
const wire = wiring(ROOT);

const findings = [
  ...bypass.filter((b) => !b.rejected).map((b) => ({ file: b.script, rule: "bypass-accepted", message: b.problems.join("; ") })),
  ...integ.findings, ...led.findings, ...regen.diffs,
  ...mut.filter((x) => !x.caught).map((x) => ({ file: "mutation", rule: "mutation-missed", message: `"${x.mutation}" needed ${x.must_be_caught_by.join("+")}, got ${x.caught_by.join("+") || "nothing"}` })),
  ...wire.map((w) => ({ file: "wiring", rule: "wiring", message: w })),
];
if (regen.failed_gates.length) findings.push({ file: "regen", rule: "gate-failed", message: `regenerated gates exited non-zero: ${regen.failed_gates.join(", ")}` });
const status = findings.length ? "FAIL" : "PASS";

const own = [SELF, `${GAPDIR}/gap-common.mjs`];
const report = {
  phase: GAP, sub_phase: GAP, validator_version: VERSION, checked_at: new Date().toISOString(),
  ...binding(Object.fromEntries(own.map((f) => [f, sha256File(path.join(ROOT, f))]))),
  source_hashes: Object.fromEntries(own.map((f) => [f, sha256File(path.join(ROOT, f))])),
  duration_ms: Date.now() - started,
  bypass: { gates_tested: bypass.length, rejected: bypass.filter((b) => b.rejected).length, accepted: bypass.filter((b) => !b.rejected), probes: ["--skip-validation", "VALIDATION_DISABLED=true"] },
  integrity: { evidence_files: integ.count, findings: integ.findings, stale_source_refs: integ.stale.length, stale_sample: integ.stale.slice(0, 20) },
  ledger: { file: LEDGER, hmac_signed_and_verified: led.hmac_verified, findings: led.findings },
  regeneration: { gates: regen.ran, differences: regen.diffs },
  mutations: mut,
  wiring: wire,
  limits: [
    "The ledger is tamper-evident, not tamper-proof: without VLT_EVIDENCE_HMAC_KEY (a CI secret) anyone with write access can re-run --seal. --seal refuses FAIL->PASS flips and unreproduced PASS changes, and regeneration catches edits to reproducible evidence.",
    "Evidence the fast gates cannot regenerate (04, 07-12 point-in-time proofs, 13-D/14-D/15-B..D/16-D heavy wrappers) is protected by the ledger and integrity shape only.",
    "First seal is trust-on-first-use: it pins the evidence present at that moment, FAIL entries included.",
  ],
  findings, status,
};
fs.mkdirSync(path.join(ROOT, OWN_DIR), { recursive: true });
fs.writeFileSync(path.join(ROOT, REPORT), JSON.stringify(report, null, 2) + "\n");
if (status !== "PASS") {
  console.error(`${GAP} FAIL — ${findings.length} finding(s):`);
  for (const x of findings.slice(0, 25)) console.error(`  [${x.rule}] ${x.file}: ${x.message}`);
  process.exit(1);
}
console.log(`${GAP} PASS — ${bypass.length} gate scripts reject bypass flag+env without writing; ${integ.count} evidence files sealed in ledger${led.hmac_verified ? " (HMAC verified)" : ""}; ${regen.ran.length} gates regenerate identical evidence; ${mut.length}/${mut.length} planted tampers caught; wiring blocking in both pipelines`);
