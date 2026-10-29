// VLT-GAP-12 extract-method proof (stages split-census / split-verify), driven by CFG.extractMethod.
//   split-census  freezes every planned file BEFORE the extract-method tool runs (write-once) and records the infrastructure roots it contains.
//   split-verify  proves each file is the frozen baseline with every infrastructure access replaced by a call into vault/infrastructure:
//                 inline each such call back (repository function body / wrapper alias) and the file's non-import statements must print identically to the
//                 baseline. Also: no application/security/crypto/route file still reaches the DB, scheduler or a provider directly, repositories never import
//                 the application layer, and the touched files typecheck.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

// VLT-GAP-16-B: later duplicate elimination replaced per-module helper names with one shared name (identifier renames
// only). The sealed baseline stays byte-for-byte untouched on disk; the in-memory comparison text gets the same renames,
// and each rename is only honoured while its canonical target is really exported by the shared module.
const GAP16_RENAMES = [
  ["denyGameEntryNotFoundOrForbidden", "denyNotFoundOrForbidden", "artifacts/api-server/src/vault/security/deny-responses.ts"],
  ["denyGameEntryNotFound", "denyNotFound", "artifacts/api-server/src/vault/security/deny-responses.ts"],
  ["denyGameEntrySilentSuccess", "denySilentSuccess", "artifacts/api-server/src/vault/security/deny-responses.ts"],
  ["denyKycNotFoundOrForbidden", "denyNotFoundOrForbidden", "artifacts/api-server/src/vault/security/deny-responses.ts"],
  ["denyKycNotFound", "denyNotFound", "artifacts/api-server/src/vault/security/deny-responses.ts"],
  ["denyKycSilentSuccess", "denySilentSuccess", "artifacts/api-server/src/vault/security/deny-responses.ts"],
  ["respondWithAttachmentResult", "respondWithVaultResult", "artifacts/api-server/src/vault/application/use-case-result.ts"],
  ["respondWithMigrationResult", "respondWithVaultResult", "artifacts/api-server/src/vault/application/use-case-result.ts"],
  ["respondWithSnapshotResult", "respondWithVaultResult", "artifacts/api-server/src/vault/application/use-case-result.ts"],
];
function applyGap16Renames(text) {
  let out = text;
  for (const [from, to, owner] of GAP16_RENAMES) {
    if (!new RegExp(`\\b${from}\\b`).test(out)) continue;
    const ownerPath = path.join(ROOT, owner);
    if (!fs.existsSync(ownerPath) || !new RegExp(`export (const|function) ${to}\\b`).test(fs.readFileSync(ownerPath, "utf8"))) continue; // evidence missing: leave the baseline text alone (so the proof fails)
    out = out.replace(new RegExp(`\\b${from}\\b`, "g"), to);
  }
  return out;
}
import { ROOT, binding, sha256, sha256File } from "./gap-common.mjs";

export async function run({ STAGE, CFG, ts, fail, SUB, DIR, API }) {
  const EM = CFG.extractMethod, abs = (f) => path.join(ROOT, f), exists = (f) => fs.existsSync(abs(f)), read = (f) => fs.readFileSync(abs(f), "utf8");
  const token = (f) => f.replace(/[^a-zA-Z0-9]+/g, "__").replace(/^__|__$/g, "");
  const BASE = `${DIR}/${EM.baselineDir}`, CENSUS = `${DIR}/split-census.json`, PROOF = `${DIR}/split-proof.json`;
  const parse = (f, t) => ts.createSourceFile(f, t, ts.ScriptTarget.Latest, true);
  const files = EM.files.map((f) => f.file);
  const resolveSpec = (from, spec) => (spec.startsWith(".") ? path.relative(ROOT, path.resolve(path.dirname(abs(from)), spec)).split(path.sep).join("/") : spec);
  const typeOnlyDecl = (d) => d.importClause?.isTypeOnly;
  const PORT_FROM = new Map(Object.entries(EM.ports).map(([name, p]) => [name, p.from]));

  // Syntactic roots (no type information): db chains, bare db, cron.schedule/validate, provider ports — by imported local name.
  function scanRoots(f, text) {
    const sf = parse(f, text); const roots = { db: 0, bareDb: 0, cron: 0, ports: 0, tx: 0, illegalImports: [] };
    const dbNames = new Set(), cronNames = new Set(), portNames = new Set();
    for (const st of sf.statements) {
      if (!ts.isImportDeclaration(st) || !st.importClause) continue;
      const spec = st.moduleSpecifier.text, rs = resolveSpec(f, spec), c = st.importClause, tOnly = typeOnlyDecl(st);
      const nb = c.namedBindings;
      const named = nb && ts.isNamedImports(nb) ? nb.elements : [];
      if (spec === "@workspace/db") { for (const e of named) if (!tOnly && !e.isTypeOnly && !(EM.allowedDbImports ?? []).includes(e.name.text)) { roots.illegalImports.push(`@workspace/db:${e.name.text}`); if (e.name.text === "db") dbNames.add("db"); } }
      if (spec === "drizzle-orm") for (const e of named) if (!tOnly && !e.isTypeOnly) roots.illegalImports.push(`drizzle-orm:${e.name.text}`);
      if (spec === "node-cron" && c.name) { cronNames.add(c.name.text); roots.illegalImports.push("node-cron"); }
      for (const e of named) if (!tOnly && !e.isTypeOnly && PORT_FROM.get((e.propertyName ?? e.name).text) === rs) { portNames.add(e.name.text); roots.illegalImports.push(`${rs}:${e.name.text}`); }
    }
    const v = (n) => {
      if (ts.isImportDeclaration(n)) return;
      if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) { const rs = resolveSpec(f, n.arguments[0].text); if ([...new Set([...Object.values(EM.ports).map((p) => p.from), ...(EM.dynamicImportPorts ?? []).map((d) => d.from)])].includes(rs)) roots.illegalImports.push(`dynamic import ${rs}`); }
      if (ts.isIdentifier(n) && dbNames.has(n.text) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) && !ts.isTypeQueryNode(n.parent)) { if (ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n) roots.db++; else roots.bareDb++; }
      if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && cronNames.has(n.expression.text)) roots.cron++;
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && portNames.has(n.expression.text)) roots.ports++;
      ts.forEachChild(n, v);
    };
    v(sf);
    return roots;
  }

  if (STAGE === "split-census") {
    if (exists(CENSUS)) fail("split census already sealed (write-once)");
    const entries = [];
    for (const f of files) {
      if (!exists(f)) fail(`planned file missing: ${f}`);
      const text = read(f); const dest = `${BASE}/sources/${token(f)}`;
      fs.mkdirSync(path.dirname(abs(dest)), { recursive: true }); fs.writeFileSync(abs(dest), text);
      entries.push({ file: f, baseline_copy: dest, sha256: sha256(text), roots: scanRoots(f, text) });
    }
    const totals = entries.reduce((a, e) => ({ db: a.db + e.roots.db, bareDb: a.bareDb + e.roots.bareDb, cron: a.cron + e.roots.cron, ports: a.ports + e.roots.ports }), { db: 0, bareDb: 0, cron: 0, ports: 0 });
    fs.writeFileSync(abs(CENSUS), JSON.stringify({ schema_version: 1, phase: CFG.gap, sub_phase: "12-split-census", ...binding(Object.fromEntries(entries.map((e) => [e.file, e.sha256]))), totals, sources: entries, status: "PASS" }, null, 2) + "\n");
    console.log(`${SUB} PASS — froze ${entries.length} files; ${totals.db} db chains, ${totals.bareDb} bare db, ${totals.cron} scheduler calls, ${totals.ports} provider calls to extract`);
    return;
  }

  // ───────────────────────── split-verify ─────────────────────────
  if (!exists(CENSUS)) fail("split census missing — run --stage split-census before extracting");
  const census = JSON.parse(read(CENSUS)); if (census.status !== "PASS") fail("split census is not PASS");
  for (const s of census.sources) if (!exists(s.baseline_copy) || sha256File(abs(s.baseline_copy)) !== s.sha256) fail(`sealed split baseline missing or corrupt: ${s.file}`);

  // Repository / wrapper definitions that calls may be inlined from.
  const repoFns = new Map(); // name -> { params:[], expr:string, file }
  const repoFiles = [...new Set(EM.files.map((f) => f.repo))].filter(exists);
  for (const rf of repoFiles) {
    const sf = parse(rf, read(rf));
    for (const st of sf.statements) {
      if (!ts.isFunctionDeclaration(st) || !st.name || !st.body) continue;
      const mods = st.modifiers?.map((m) => m.kind) ?? [];
      if (!mods.includes(ts.SyntaxKind.ExportKeyword)) continue;
      if (st.body.statements.length !== 1 || !ts.isReturnStatement(st.body.statements[0]) || !st.body.statements[0].expression) continue;
      repoFns.set(st.name.text, { params: st.parameters.map((p) => p.name.getText(sf)), expr: st.body.statements[0].expression.getText(sf), file: rf });
    }
  }
  const printer = ts.createPrinter({ removeComments: true });
  const DYN = EM.dynamicImportPorts ?? [];
  const normDyn = (f, printed) => printed.replace(/import\("([^"]+)"\)/g, (m, spec) => { const rs = resolveSpec(f, spec); const hit = DYN.find((d) => d.to === rs + ".ts" || d.to === rs); return `import("<${hit ? hit.from : rs}>")`; });
  const statements = (f, text) => { const sf = parse(f, text); return sf.statements.filter((s) => !ts.isImportDeclaration(s)).map((s) => printer.printNode(ts.EmitHint.Unspecified, s, sf).replace(/\s+/g, " ").trim()).map((x) => normDyn(f, x)); };
  const stmtName = (s) => (/^(?:export )?(?:async )?(?:function|const|let|class|interface|type)\s+([A-Za-z0-9_$]+)/.exec(s)?.[1]) ?? s.slice(0, 40);
  const SUBST = EM.calleeSubstitutions;

  function inline(f, text, baseText, fns = repoFns) {
    const baseLocals = new Set(); for (const st of parse(f, baseText).statements) if (ts.isImportDeclaration(st) && st.importClause) { const c = st.importClause; if (c.name) baseLocals.add(c.name.text); if (c.namedBindings) { if (ts.isNamespaceImport(c.namedBindings)) baseLocals.add(c.namedBindings.name.text); else for (const e of c.namedBindings.elements) baseLocals.add(e.name.text); } }
    const sf = parse(f, text); const edits = []; const unresolved = [];
    // which identifiers are imported from infrastructure (repositories / wrappers / ports)?
    const infraLocals = new Set();
    for (const st of sf.statements) if (ts.isImportDeclaration(st) && st.importClause?.namedBindings && ts.isNamedImports(st.importClause.namedBindings) && resolveSpec(f, st.moduleSpecifier.text).includes("/vault/infrastructure/")) for (const e of st.importClause.namedBindings.elements) if (!baseLocals.has(e.name.text)) infraLocals.add(e.name.text);
    const v = (n) => {
      if (ts.isImportDeclaration(n)) return;
      if (ts.isIdentifier(n) && infraLocals.has(n.text) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) && !ts.isImportSpecifier(n.parent)) {
        const call = ts.isCallExpression(n.parent) && n.parent.expression === n ? n.parent : null;
        if (fns.has(n.text) && call) {
          const r = fns.get(n.text); const args = call.arguments.map((a) => a.getText(sf));
          if (args.length !== r.params.length || args.some((a, i) => a !== r.params[i])) unresolved.push(`${n.text}(${args.join(", ")}) is not an identity call of (${r.params.join(", ")})`);
          edits.push({ start: call.getStart(sf), end: call.getEnd(), text: r.expr });
          return;
        }
        if (SUBST[n.text]) { edits.push({ start: n.getStart(sf), end: n.getEnd(), text: SUBST[n.text] }); return; }
        unresolved.push(`${n.text}: imported from infrastructure but is neither a single-return repository function nor a declared wrapper/port`);
      }
      ts.forEachChild(n, v);
    };
    v(sf);
    let out = text; for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
    return { out, unresolved, inlined: edits.length };
  }

  const report = []; let totalInlined = 0;
  const RELOC = new Map((EM.relocations ?? []).map((r) => [r.from, r.to]));
  for (const s of census.sources) {
    const f = s.file; const baseText = applyGap16Renames(read(s.baseline_copy));
    if (RELOC.has(f)) { // relocated wholesale: same statements, new home
      const to = RELOC.get(f); if (exists(f)) fail(`${f}: relocated to ${to} but the old file still exists`); if (!exists(to)) fail(`${f}: relocation target ${to} missing`);
      const a = statements(f, baseText), b = statements(to, read(to)); if (a.length !== b.length || a.some((x, i) => x !== b[i])) fail(`${f} → ${to}: relocated file is not statement-identical`);
      report.push({ file: f, relocated_to: to, statements: a.length, status: "PASS" }); continue;
    }
    const nowText = read(f);
    const { out, unresolved, inlined } = inline(f, nowText, baseText);
    if (unresolved.length) fail(`${f}:\n  ${unresolved.join("\n  ")}`);
    const a = statements(f, baseText), b = statements(f, out);
    if (a.length !== b.length) fail(`${f}: statement count changed (${a.length} → ${b.length}) — extraction may only replace infrastructure accesses`);
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) fail(`${f}: statement "${stmtName(a[i])}" differs from the sealed baseline after inlining infrastructure calls back:\n--- baseline\n${a[i].slice(0, 700)}\n--- inlined\n${b[i].slice(0, 700)}`);
    const roots = scanRoots(f, nowText);
    if (roots.db || roots.bareDb || roots.cron || roots.ports || roots.illegalImports.length) fail(`${f}: still reaches infrastructure directly (${JSON.stringify(roots)})`);
    totalInlined += inlined; report.push({ file: f, statements: a.length, infrastructure_calls_inlined: inlined, status: "PASS" });
  }
  // Self-test of the proof: tampered repository functions and tampered call sites must be rejected.
  const compare = (f, baseText, nowText, fns) => {
    const { out, unresolved } = inline(f, nowText, baseText, fns); if (unresolved.length) return `unresolved: ${unresolved[0]}`;
    const a = statements(f, baseText), b = statements(f, out); if (a.length !== b.length) return "statement count";
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return `statement ${stmtName(a[i])}`; return null;
  };
  let mutantsCaught = 0, mutantsRun = 0;
  const bySource = census.sources.filter((s) => exists(s.file) && !RELOC.has(s.file));
  const callSites = []; // { s, name, call }
  for (const s of bySource) { const nowText = read(s.file); for (const name of repoFns.keys()) { const m = new RegExp(`\\b${name}\\(([^()]*)\\)`).exec(nowText); if (m && !new RegExp(`\\b${name}\\b`).test(read(s.baseline_copy))) callSites.push({ s, name, text: nowText, m }); } }
  const pick = (arr, n) => arr.filter((_, i) => i % Math.max(1, Math.floor(arr.length / n)) === 0).slice(0, n);
  for (const c of pick(callSites, 10)) { // 1. repository function body altered
    const fns = new Map(repoFns); const r = fns.get(c.name); fns.set(c.name, { ...r, expr: `${r.expr}.limit(1)` });
    mutantsRun++; if (compare(c.s.file, read(c.s.baseline_copy), c.text, fns)) mutantsCaught++; else fail(`proof self-test: altered repository function ${c.name} was NOT caught`);
  }
  for (const c of pick(callSites, 10)) { // 2. call site removed from the application file
    const text = c.text.replace(c.m[0], "undefined");
    mutantsRun++; if (compare(c.s.file, read(c.s.baseline_copy), text, repoFns)) mutantsCaught++; else fail(`proof self-test: removed call ${c.name} in ${c.s.file} was NOT caught`);
  }
  for (const c of callSites.filter((x) => repoFns.get(x.name).params.length >= 2).slice(0, 5)) { // 3. arguments swapped
    const args = c.m[1].split(",").map((x) => x.trim()); [args[0], args[1]] = [args[1], args[0]];
    const text = c.text.replace(c.m[0], `${c.name}(${args.join(", ")})`);
    mutantsRun++; if (compare(c.s.file, read(c.s.baseline_copy), text, repoFns)) mutantsCaught++; else fail(`proof self-test: swapped arguments of ${c.name} in ${c.s.file} were NOT caught`);
  }
  { const s = bySource[0]; const text = read(s.file) + "\nexport const __tamper = 1;\n"; mutantsRun++; if (compare(s.file, read(s.baseline_copy), text, repoFns)) mutantsCaught++; else fail("proof self-test: an added statement was NOT caught"); }

  // layer rule: infrastructure never imports the application layer / routes (except the declared provider ports file).
  const layerViolations = [];
  for (const rf of [...repoFiles, EM.dbHandleFile, EM.cronFile].filter(exists)) { for (const m of read(rf).matchAll(/from "([^"]+)"/g)) { const rs = resolveSpec(rf, m[1]); if (/\/vault\/(application|api|security)\//.test(rs) || /\/routes\//.test(rs)) layerViolations.push(`${rf} -> ${rs}`); } }
  if (layerViolations.length) fail(`infrastructure imports a higher layer:\n  ${layerViolations.join("\n  ")}`);
  // every infrastructure function the app calls must exist (ports/wrappers defined)
  for (const [alias, orig] of Object.entries(SUBST)) { const defined = [EM.dbHandleFile, EM.cronFile, EM.portsFile].filter(exists).some((f) => new RegExp(`\\b${alias}\\b`).test(read(f))); if (!defined && files.some((f) => new RegExp(`\\b${alias}\\b`).test(read(f)))) fail(`wrapper ${alias} (→ ${orig}) is used but not defined in the infrastructure files`); }
  const tcFiles = [...new Set([...files, ...repoFiles, EM.dbHandleFile, EM.cronFile, EM.portsFile, ...CFG.typecheckExtra].filter(exists))].map((f) => f.replace(`${API}/`, "src/"));
  const tc = spawnSync("pnpm", ["--filter", "@workspace/api-server", "exec", "tsc", "--noEmit", "--skipLibCheck", "--target", "es2022", "--module", "esnext", "--moduleResolution", "bundler", "--types", "node", "--strict", "--customConditions", "workspace", ...tcFiles], { cwd: ROOT, encoding: "utf8", timeout: 600_000, maxBuffer: 24 * 1024 * 1024 });
  if (tc.error || tc.status !== 0) { console.error(`${tc.stdout}${tc.stderr}`.slice(-6000)); fail(`TypeScript check failed (exit ${tc.status ?? "unknown"})`); }
  fs.writeFileSync(abs(PROOF), JSON.stringify({ schema_version: 1, phase: CFG.gap, sub_phase: "12-split-verify", ...binding(Object.fromEntries(census.sources.map((s) => [s.file, sha256File(abs(exists(s.file) ? s.file : RELOC.get(s.file)))]))), files: report, repository_functions: repoFns.size, proof_self_test: { mutants_run: mutantsRun, mutants_caught: mutantsCaught }, infrastructure_calls_inlined: totalInlined, typecheck: { exit_code: tc.status }, status: "PASS" }, null, 2) + "\n");
  console.log(`${SUB} PASS — ${report.length} files equal their sealed baselines after inlining ${totalInlined} infrastructure calls; no direct DB / scheduler / provider access remains; proof self-test ${mutantsCaught}/${mutantsRun} tampered variants rejected; infrastructure imports no higher layer; typecheck clean`);
}
