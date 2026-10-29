#!/usr/bin/env node
// VLT-GAP-17 — Migration map truth gate. Every claim in docs/antas/vault/file-migration-map.md is checked against the tree:
//   coverage     every vault/** file is a NEW path in some row; every routes/vault*.ts + lib/vault*.ts on disk is an OLD path in some row
//   RETIRED      old path absent (or a documented re-export-only shim with zero importers); zero imports / path-string references remain
//   EXTRACTED    new owner exists and holds real code; an old file still on disk reaches it through imports and has no db/sql calls left
//   NEW-SEAM     new owner exists; row states a reason; "barrel" rows must contain re-exports only
//   IMPLEMENTED  only with an explicit "pending"; "pending" anywhere else is rejected
//   evidence     a row that cites VLT-GAP-NN is UNCERTIFIED unless recorded evidence says PASS (and vice versa: stale marker rejected)
// Also records symbols moved and callers per row. Usage: node validate-vlt-gap-17.mjs [--self-test] [--root <dir>]
// Writes reports/antas/vault/gap/VLT-GAP-17/map-check.json — `status` is written by this script only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT as REPO_ROOT, rejectBypass, binding, sha256File } from "./gap-common.mjs";
import { loadTs } from "./harness.mjs";
import { SRC, MAP_DOC, EVIDENCE_DIR, parseMap, indexRepo, buildGraph, evidenceState, certifiedFor, globToRe, stripExt } from "./gap-17-common.mjs";

const GAP = "VLT-GAP-17", VERSION = "17.1";
const argv = process.argv.slice(2);
const fail = (m) => { console.error(`${GAP} FAIL — ${m}`); process.exit(1); };
const bad = rejectBypass(["--self-test", "--root"]);
if (bad.length) fail(`bypass rejected: ${bad.join(", ")}`);
for (const [k, v] of Object.entries(process.env)) if (/^(VALIDATION_DISABLED|ANTAS_BYPASS|VLT_BYPASS|VAULT_BYPASS)$/i.test(k) && v && !/^(0|false|no)$/i.test(v)) fail(`bypass rejected: ${k}`);
const ri = argv.indexOf("--root");
if (ri >= 0 && (!argv[ri + 1] || argv[ri + 1].startsWith("-"))) fail("--root needs a directory (fail closed)");
const ROOT = ri >= 0 ? path.resolve(argv[ri + 1]) : REPO_ROOT;
const ts = loadTs(REPO_ROOT);
if (!ts) fail("typescript compiler not found (fail closed)");

const DB_METHODS = new Set(["select", "insert", "update", "delete", "execute", "transaction"]);
// Ports are documented alias files (provider-ports.ts header): re-export-only by design, so the scaffold rule does not apply to them.
const PORT_ALIAS = /^artifacts\/api-server\/src\/vault\/infrastructure\/providers\/[a-z-]+-ports\.ts$/;
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

// AST, not regex: `db.update()` inside a comment or string is not a call.
function hasDbCalls(file) {
  const tree = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let hit = false;
  const walk = (n) => {
    if (hit) return;
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression) && n.expression.expression.text === "db" && DB_METHODS.has(n.expression.name.text)) hit = true;
    else if (ts.isTaggedTemplateExpression(n) && ts.isIdentifier(n.tag) && n.tag.text === "sql") hit = true;
    else ts.forEachChild(n, walk);
  };
  walk(tree);
  return hit;
}

function codeShape(file) {
  const tree = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let executable = 0, reexportOnly = true;
  const symbols = [];
  for (const n of tree.statements) {
    const exported = !!n.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    const isImport = ts.isImportDeclaration(n), isReexport = ts.isExportDeclaration(n), isType = ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n);
    if (!(isImport || isReexport)) reexportOnly = false;
    if ((ts.isFunctionDeclaration(n) && n.body) || ts.isClassDeclaration(n) || ts.isEnumDeclaration(n) || ts.isExpressionStatement(n) || ts.isExportAssignment(n)) executable++;
    else if (ts.isVariableStatement(n) && n.declarationList.declarations.some((d) => d.initializer)) executable++;
    if (exported) {
      if (ts.isVariableStatement(n)) n.declarationList.declarations.forEach((d) => ts.isIdentifier(d.name) && symbols.push(d.name.text));
      else if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n) || isType || ts.isEnumDeclaration(n)) && n.name) symbols.push(n.name.text);
    }
  }
  return { executable, reexportOnly, typeOnlyOk: tree.statements.some((n) => ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n)), symbols };
}

function check() {
  const mapFile = path.join(ROOT, MAP_DOC);
  if (!fs.existsSync(mapFile)) fail(`map missing: ${MAP_DOC} (fail closed)`);
  if (!fs.existsSync(path.join(ROOT, SRC, "vault"))) fail(`${SRC}/vault missing (fail closed)`);
  const rows = parseMap(fs.readFileSync(mapFile, "utf8"));
  if (!rows.length) fail("map has no rows (fail closed)");
  const idx = indexRepo(ROOT), g = buildGraph(ROOT, idx);
  const findings = [], out = [], evCache = {}, evidence = {};
  const F = (row, rule, msg) => findings.push({ line: row?.line ?? null, rule, message: msg });
  const ev = (gap) => (evCache[gap] ??= evidenceState(ROOT, gap, rows.filter((r) => r.gaps.includes(gap)).flatMap((r) => [...r.old, ...r.new])));
  const existsOrGlob = (p) => (p.includes("*") ? idx.match(p).length > 0 : idx.has(p));
  const retiredByLaterRow = (p, self) => rows.some((r) => r !== self && r.kind === "RETIRED" && r.old.includes(p));

  const seen = new Map();
  for (const r of rows) {
    const key = `${r.old.join(",")}=>${r.new.join(",")}`;
    if (r.old.length + r.new.length > 0) { if (seen.has(key)) F(r, "M0-duplicate-row", `duplicate of line ${seen.get(key)}`); else seen.set(key, r.line); }
    if (r.kind === "UNKNOWN") { F(r, "M0-status", `status "${r.statusRaw.slice(0, 40)}" is not one of RETIRED/EXTRACTED/IMPLEMENTED/NEW-SEAM/compatibility-preserved/thin entrypoint/extracted`); continue; }
    if (r.pending && r.kind !== "IMPLEMENTED") F(r, "M1-pending", `"pending" is only valid on an IMPLEMENTED row (found on ${r.kind})`);
    if (r.kind === "IMPLEMENTED" && !r.pending) F(r, "M1-implemented", "IMPLEMENTED without an explicit pending marker claims more than it proves");

    const rec = { line: r.line, kind: r.kind, old: r.old, new: r.new, symbols_moved: {}, old_importers: {}, callers_of_new_outside_vault: {} };
    // new owners
    for (const p of r.new) {
      if (!existsOrGlob(p)) { if (!(r.kind === "RETIRED" || r.kind === "EXTRACTED") || !retiredByLaterRow(p, r)) F(r, "M2-new-missing", `new owner ${p} does not exist${r.kind === "EXTRACTED" || r.kind === "RETIRED" ? " and no later RETIRED row retires it" : ""}`); continue; }
      if (p.includes("*") || !/\.(ts|tsx)$/.test(p)) continue;
      const shape = codeShape(p);
      rec.symbols_moved[p] = shape.symbols;
      const callers = (g.reverse.get(p) ? [...g.reverse.get(p)] : []).filter((f) => !f.startsWith(`${SRC}/vault/`));
      rec.callers_of_new_outside_vault[p] = callers;
      if (["RETIRED", "EXTRACTED", "SEAM"].includes(r.kind) && shape.executable === 0 && !shape.typeOnlyOk && !PORT_ALIAS.test(p)) F(r, "M3-scaffold", `${p} has no executable code (import/re-export only) — scaffold, not an extraction`);
      if (r.kind === "NEW-SEAM") {
        if (/barrel/i.test(r.statusRaw) && !shape.reexportOnly) F(r, "M3-barrel", `${p} is declared a barrel but contains non-re-export statements`);
        if (!/barrel/i.test(r.statusRaw) && shape.executable === 0 && !shape.typeOnlyOk) F(r, "M3-scaffold", `${p} is a NEW-SEAM with no executable code`);
        if (!/;\s*\S.{10,}/.test(r.statusRaw)) F(r, "M4-reason", "NEW-SEAM rows must state a reason after ';'");
      }
    }
    // old sources
    if (r.kind === "RETIRED") {
      for (const p of r.old) {
        if (p.includes("*")) { F(r, "M5-glob", `RETIRED row lists glob ${p}`); continue; }
        const importers = g.importersOf(p).filter((f) => f !== p);
        rec.old_importers[p] = importers;
        if (idx.has(p)) {
          const s = codeShape(p);
          if (!(r.shim && s.reexportOnly)) F(r, "M5-old-exists", `RETIRED but ${p} still exists${r.shim ? " and is not re-export-only" : " (only a re-export-only shim may stay, and the row must say so)"}`);
        }
        if (importers.length) F(r, "M6-old-referenced", `RETIRED but ${p} is still referenced by ${importers.slice(0, 4).join(", ")}${importers.length > 4 ? ` (+${importers.length - 4})` : ""}`);
      }
    } else if (r.kind === "EXTRACTED") {
      const live = r.old.filter((p) => !p.includes("*") && idx.has(p));
      for (const p of r.old) if (!p.includes("*") && !idx.has(p) && !retiredByLaterRow(p, r)) F(r, "M7-old-missing", `EXTRACTED but old ${p} is gone and no RETIRED row accounts for it (use RETIRED)`);
      for (const p of live) {
        const t = g.texts.get(p) ?? "";
        if (/\.(ts|tsx)$/.test(p) && t && hasDbCalls(p)) F(r, "M8-old-behavior", `EXTRACTED but ${p} still makes db/sql calls — old behavior remains`);
      }
      if (live.length) for (const n of r.new.filter((x) => !x.includes("*") && idx.has(x))) {
        if (!live.some((o) => g.reach(o).has(n))) F(r, "M9-unreached", `none of ${live.join(", ")} imports (directly or transitively) the new owner ${n}`);
      }
    } else if (["COMPAT", "THIN", "SEAM"].includes(r.kind)) {
      for (const p of r.old) if (!existsOrGlob(p)) F(r, "M7-old-missing", `${r.kind} row lists ${p} but it does not exist`);
    }
    // evidence
    for (const gap of r.gaps) {
      const e = ev(gap); evidence[gap] = { retire: e.retire, gate: e.gate, extraction: e.extract, current_proof: e.current_proof };
      const need = r.kind === "RETIRED" ? "RETIRED" : "EXTRACTED";
      const cert = certifiedFor(e, need);
      const anyBinding = [e.gate, e.retire, e.extract].filter(Boolean).every((x) => !!x.binding);
      if (!anyBinding) F(r, "M10-binding", `evidence for VLT-GAP-${gap} has no commit_sha/source_tree_sha256 binding`);
      if (r.kind === "IMPLEMENTED") { if (cert) F(r, "M10-stale-pending", `VLT-GAP-${gap} evidence is PASS but the row still says pending`); }
      else if (!cert && !r.uncertified) F(r, "M10-uncertified", `row cites VLT-GAP-${gap} but recorded evidence does not certify a ${need} claim (${[e.gate && `gate ${e.gate.status}`, e.retire && `retire ${e.retire.status}`, e.extract && `extraction ${e.extract.status}`].filter(Boolean).join(", ") || "no evidence files"}); add "UNCERTIFIED" to the status`);
      else if (cert && r.uncertified) F(r, "M10-stale-uncertified", `row is marked UNCERTIFIED but VLT-GAP-${gap} evidence certifies it — remove the marker`);
    }
    out.push(rec);
  }

  // coverage
  const newCovers = (f) => rows.some((r) => r.new.some((p) => (p.includes("*") ? globToRe(p).test(f) : p === f)));
  const oldCovers = (f) => rows.some((r) => r.old.some((p) => (p.includes("*") ? globToRe(p).test(f) : p === f)));
  const vaultFiles = idx.files.filter((f) => f.startsWith(`${SRC}/vault/`) && f.endsWith(".ts"));
  for (const f of vaultFiles) if (!newCovers(f)) F(null, "C1-unmapped-new", `${f} is not the new owner in any map row`);
  const legacy = idx.files.filter((f) => /^artifacts\/api-server\/src\/(routes\/vault[^/]*|lib\/vault-[^/]*)\.ts$/.test(f));
  for (const f of legacy) if (!oldCovers(f)) F(null, "C2-unmapped-old", `${f} still exists and is not an old source in any map row`);

  const open_items = {
    pending_rows: rows.filter((r) => r.kind === "IMPLEMENTED").map((r) => r.line),
    uncertified_rows: rows.filter((r) => r.uncertified).map((r) => r.line),
    origin_unproven_files: rows.filter((r) => r.kind === "NEW-SEAM" && !/barrel/i.test(r.statusRaw) && /unproven|unknown origin/i.test(r.statusRaw)).flatMap((r) => r.new),
    justified_new_seams: rows.filter((r) => r.kind === "NEW-SEAM" && !/barrel/i.test(r.statusRaw) && !/unproven|unknown origin/i.test(r.statusRaw))
      .map((r) => ({ line: r.line, files: r.new, reason: r.statusRaw.split(";").slice(1).join(";").trim() })),
  };
  return { rows, out, findings, evidence, open_items, vaultFiles: vaultFiles.length, legacy: legacy.length };
}

const isInner = ri >= 0; // runs against a copy: never touches the real evidence
function main() {
  const res = check();
  const dir = path.join(ROOT, EVIDENCE_DIR, GAP);
  fs.mkdirSync(dir, { recursive: true });
  const hashes = Object.fromEntries(["gap-17-common.mjs", "validate-vlt-gap-17.mjs", "generate-vlt-gap-17-map.mjs"].map((f) => [`scripts/antas/vault/gap/${f}`, sha256File(path.join(REPO_ROOT, "scripts/antas/vault/gap", f))]));
  hashes[MAP_DOC] = sha256File(path.join(ROOT, MAP_DOC));
  const count = (k) => res.rows.filter((r) => r.kind === k).length;
  const report = {
    phase: GAP, sub_phase: "VLT-GAP-17", validator_version: VERSION, checked_at: new Date().toISOString(), ...binding(hashes), source_hashes: hashes,
    command: "node scripts/antas/vault/gap/validate-vlt-gap-17.mjs",
    totals: { rows: res.rows.length, RETIRED: count("RETIRED"), EXTRACTED: count("EXTRACTED"), "NEW-SEAM": count("NEW-SEAM"), IMPLEMENTED: count("IMPLEMENTED"), COMPAT_THIN_SEAM: count("COMPAT") + count("THIN") + count("SEAM"), vault_files_on_disk: res.vaultFiles, legacy_files_on_disk: res.legacy, unmapped_files: res.findings.filter((f) => /^C[12]-/.test(f.rule)).length },
    open_items: res.open_items,
    evidence_commit_binding_note: "recorded evidence is bound by commit_sha (git) or source_tree_sha256 (no git repository in the upload); the gate verifies presence + status, not that the bound tree equals today's tree — later GAPs legitimately changed it",
    rows: res.out, evidence: res.evidence, findings: res.findings,
    status: res.findings.length ? "FAIL" : "PASS",
  };
  fs.writeFileSync(path.join(dir, "map-check.json"), `${JSON.stringify(report, null, 2)}\n`);
  if (res.findings.length) {
    for (const f of res.findings.slice(0, 40)) console.error(`  ${f.rule}${f.line ? ` (map line ${f.line})` : ""}: ${f.message}`);
    if (res.findings.length > 40) console.error(`  … ${res.findings.length - 40} more (see map-check.json)`);
    fail(`${res.findings.length} map claim(s) contradict the repository`);
  }
  const o = res.open_items;
  console.log(`${GAP} PASS — ${res.rows.length} rows match the tree (${res.vaultFiles} vault files mapped); open: ${o.pending_rows.length} pending, ${o.uncertified_rows.length} uncertified, ${o.origin_unproven_files.length} origin-unproven`);
}

// ── self-test: plant lies in COPIES of the real tree; each must be caught with the right rule ──────────────────────
function selfTest() {
  if (isInner) fail("--self-test cannot be combined with --root");
  const keep = (p) => !/(^|\/)(node_modules|\.git|dist)(\/|$)|baseline|\.tsbuildinfo$/.test(p);
  const mk = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "gap17-"));
    for (const sub of [SRC, "scripts", "tests", "services", "packages", EVIDENCE_DIR.replace(/\/gap$/, "")]) {
      const from = path.join(REPO_ROOT, sub);
      if (!fs.existsSync(from) || sub === "scripts") continue;
      fs.cpSync(from, path.join(d, sub), { recursive: true, filter: (s) => keep(path.relative(REPO_ROOT, s).split(path.sep).join("/")) });
    }
    fs.mkdirSync(path.join(d, "docs/antas/vault"), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, MAP_DOC), path.join(d, MAP_DOC));
    fs.writeFileSync(path.join(d, "package.json"), "{}");
    return d;
  };
  const run = (d, extra = [], env = {}) => spawnSync(process.execPath, [new URL(import.meta.url).pathname, "--root", d, ...extra], { encoding: "utf8", env: { ...process.env, ...env } });
  const edit = (d, f, fn) => { const p = path.join(d, f); fs.writeFileSync(p, fn(fs.readFileSync(p, "utf8"))); };
  const mapRow = (d, needle) => { const t = fs.readFileSync(path.join(d, MAP_DOC), "utf8"); return t.split("\n").find((l) => l.startsWith("|") && l.includes(needle)); };
  const cases = [
    ["control: untouched copy passes", () => {}, 0, null],
    ["row deleted → vault file unmapped", (d) => edit(d, MAP_DOC, (t) => t.replace(mapRow(d, "vault/domain/serial.ts") + "\n", "")), 1, "C1-unmapped-new"],
    ["RETIRED old file still present", (d) => fs.writeFileSync(path.join(d, SRC, "lib/vault-backup-envelope.ts"), "export const x = 1;\n"), 1, "M5-old-exists"],
    ["RETIRED old path still imported", (d) => edit(d, `${SRC}/routes/vault.ts`, (t) => `import "../lib/vault-snapshot-restore";\n${t}`), 1, "M6-old-referenced"],
    ["RETIRED old path named in a job/yml string", (d) => { fs.mkdirSync(path.join(d, "services"), { recursive: true }); fs.writeFileSync(path.join(d, "services/job.yml"), `run: ${SRC}/lib/vault-trash-cron\n`); }, 1, "M6-old-referenced"],
    ["EXTRACTED new owner missing", (d) => fs.rmSync(path.join(d, SRC, "vault/security/lockout.ts")), 1, "M2-new-missing"],
    ["new owner replaced by import-only scaffold", (d) => fs.writeFileSync(path.join(d, SRC, "vault/security/lockout.ts"), `import fs from "node:fs";\nexport { fs };\n`), 1, "M3-scaffold"],
    ["EXTRACTED route regained a db call", (d) => edit(d, `${SRC}/routes/vault-reauth.ts`, (t) => `${t}\nasync function leak() { return db.select().from(x); }\n`), 1, "M8-old-behavior"],
    ["status flipped to RETIRED while old source still exists", (d) => edit(d, MAP_DOC, (t) => {
      const line = t.split("\n").find((candidate) => candidate.includes(`${SRC}/routes/vault-reauth.ts`) && candidate.includes("| EXTRACTED"));
      return line ? t.replace(line, line.replace("| EXTRACTED", "| RETIRED")) : t;
    }), 1, "M5-old-exists"],
    ["pending marker on a non-IMPLEMENTED row", (d) => edit(d, MAP_DOC, (t) => t.replace("RETIRED (VLT-GAP-05-D)", "RETIRED (VLT-GAP-05-D; validation pending)")), 1, "M1-pending"],
    ["unknown status word", (d) => edit(d, MAP_DOC, (t) => t.replace("RETIRED (VLT-GAP-05-D)", "MIGRATED (VLT-GAP-05-D)")), 1, "M0-status"],
    ["UNCERTIFIED marker omitted from a row with failing evidence", (d) => {
      const evidenceDir = path.join(d, EVIDENCE_DIR, "VLT-GAP-05");
      fs.mkdirSync(evidenceDir, { recursive: true });
      for (const name of ["gate.json", "retire-proof.json", "extraction-proof.json"]) {
        const file = path.join(evidenceDir, name);
        const prior = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
        fs.writeFileSync(file, JSON.stringify({ ...prior, status: "FAIL", source_tree_sha256: prior.source_tree_sha256 ?? "self-test-binding" }));
      }
    }, 1, "M10-uncertified"],
    ["fake legacy PASS cannot replace a failed current proof", (d) => {
      for (const name of ["gate.json", "extraction-proof.json"]) {
        const file = path.join(d, EVIDENCE_DIR, `VLT-GAP-04/${name}`);
        const prior = JSON.parse(fs.readFileSync(file, "utf8"));
        fs.writeFileSync(file, JSON.stringify({ ...prior, status: "PASS" }));
      }
      for (const file of ["reports/antas/vault/gap/VLT-GAP-13/route-thinness.json", "reports/antas/vault/gap/VLT-GAP-15/gate.json", "reports/antas/vault/gap/VLT-GAP-15/compare.json"]) {
        const reportPath = path.join(d, file);
        const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
        fs.writeFileSync(reportPath, JSON.stringify({ ...report, status: "FAIL" }));
      }
    }, 1, "M10-uncertified"],
    ["barrel with real code", (d) => fs.appendFileSync(path.join(d, SRC, "vault/index.ts"), "\nexport const sneaky = () => 1;\n"), 1, "M3-barrel"],
    ["map file missing (fail closed)", (d) => fs.rmSync(path.join(d, MAP_DOC)), 1, "map missing"],
    ["bypass flag --force rejected", () => {}, 1, "bypass rejected", ["--force"]],
    ["bypass env VALIDATION_DISABLED rejected", () => {}, 1, "bypass rejected", [], { VALIDATION_DISABLED: "true" }],
  ];
  let bad = 0;
  for (const [name, mutate, want, rule, extra = [], env = {}] of cases) {
    const d = mk();
    try { mutate(d); const r = run(d, extra, env); const ok = r.status === want && (rule === null || (r.stderr + r.stdout).includes(rule)); if (!ok) { bad++; console.error(`  ✗ ${name}: exit ${r.status} (want ${want}${rule ? `, ${rule}` : ""}) — ${r.stderr.trim().split("\n").slice(0, 3).join(" | ")}`); } else console.log(`  ✓ ${name}`); }
    finally { fs.rmSync(d, { recursive: true, force: true }); }
  }
  if (bad) fail(`self-test: ${bad}/${cases.length} cases wrong`);
  console.log(`${GAP} self-test PASS — ${cases.length} cases (planted lies caught by rule; control passes; bypass/fail-closed enforced)`);
}

if (argv.includes("--self-test")) selfTest(); else main();
