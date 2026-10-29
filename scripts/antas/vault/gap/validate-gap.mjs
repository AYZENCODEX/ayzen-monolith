#!/usr/bin/env node
// Generic VLT-GAP validator (LEAN roadmap): config in gap-configs/NN.mjs, stage-driven.
//   node validate-gap.mjs --gap NN --stage ...
//   --stage census   freeze the pre-extraction sources + source-derived symbol inventory   (08-A)
//   --stage extract  moved libs are byte-identical (modulo import paths) in their new owners (08-B)
//   --stage rewire   no consumer imports an old path; every consumer imports the new owner  (08-C)
//   --stage retire   old libs gone, routes thin, parity + executed differential + typecheck (08-D)
//   --stage split-census / split-verify   extract-method plan: freeze, then prove every infrastructure access was moved verbatim (12-E)
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { ROOT, binding, rejectBypass, rel, sha256, sha256File, walkFiles } from "./gap-common.mjs";
import { buildInfraCensus } from "./infra-census.mjs";

const argv = process.argv.slice(2);
const gi = argv.indexOf("--gap");
const GAPNUM = gi >= 0 ? argv[gi + 1] : null;
if (!GAPNUM || !/^\d\d$/.test(GAPNUM)) { console.error("usage: validate-gap.mjs --gap NN --stage census|extract|rewire|retire"); process.exit(1); }
const CFG = (await import(`./gap-configs/${GAPNUM}.mjs`)).default;
const GAP = CFG.gap, DIR = CFG.dir, API = CFG.api;
const MAP_DOC = "docs/antas/vault/file-migration-map.md";
const DIFFERENTIAL = CFG.differential;
const MOVES = CFG.moves, ROUTES = CFG.routes, SYMBOL_MOVES = CFG.symbolMoves, REPOSITORIES = CFG.repositories;
const ownerOf = (f) => CFG.successorOwners?.[f] ?? f;
const NEW_OWNERS = [...Object.values(MOVES).map(ownerOf), ...Object.values(ROUTES).map((r) => r.app), ...REPOSITORIES, ...CFG.extraOwners, ...new Set(SYMBOL_MOVES.map((m) => m.to))];
const FORBIDDEN_IN_ROUTE = CFG.forbiddenInRoute;
const MAP_ROWS = CFG.mapRows();

const si = argv.indexOf("--stage");
const STAGE = si >= 0 ? argv[si + 1] : null;
const SUB = `${GAP}/${STAGE ?? "?"}`;
const fail = (m) => { console.error(`${SUB} FAIL — ${m}`); process.exit(1); };
{
  const bypass = rejectBypass(["--stage", "--gap"]);
  const filtered = bypass.filter((b) => !/^unknown flag --(stage|gap)$/.test(b));
  if (filtered.length) fail(`bypass rejected: ${filtered.join(", ")}`);
}
if (!["census", "extract", "rewire", "retire", "split-census", "split-verify"].includes(STAGE)) fail("usage: --gap NN --stage census|extract|rewire|retire|split-census|split-verify");
for (const [k, v] of Object.entries(process.env)) {
  if (/^(VALIDATION_DISABLED|ANTAS_BYPASS|VLT_BYPASS|VAULT_BYPASS)$/i.test(k) && v && !/^(0|false|no)$/i.test(v)) fail(`bypass rejected: ${k}`);
}
const abs = (f) => path.join(ROOT, f);
const read = (f) => fs.readFileSync(abs(f), "utf8");
const exists = (f) => fs.existsSync(abs(f));
const ts = createRequire(path.join(ROOT, "package.json"))("typescript");
const parse = (f, text) => ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true, f.endsWith(".mjs") ? ts.ScriptKind.JS : ts.ScriptKind.TS);
const token = (f) => f.replace(/[^a-zA-Z0-9]+/g, "__").replace(/^__|__$/g, "");
const BASE_DIR = `${DIR}/baseline`;
const MANIFEST = `${BASE_DIR}/repo-manifest.json`;
const INVENTORY = `${DIR}/symbol-inventory.json`;
const INFRA_CENSUS = `${DIR}/infra-census.json`;
const baselineCopy = (f) => `${BASE_DIR}/sources/${token(f)}`;
const OUT = { extract: `${DIR}/extraction-proof.json`, rewire: `${DIR}/consumer-graph.json`, retire: `${DIR}/retire-proof.json` };
const writeEvidence = (file, obj) => { fs.mkdirSync(path.dirname(abs(file)), { recursive: true }); fs.writeFileSync(abs(file), `${JSON.stringify(obj, null, 2)}\n`); };

// Identity of a file ignoring ONLY import/export-from specifiers (the sole thing a move may change).
function normalizedIdentity(f, text) {
  const tree = parse(f, text);
  const edits = [];
  const spec = (n) => { if (n && ts.isStringLiteral(n) && n.text.startsWith(".")) edits.push([n.getStart(tree), n.getEnd(), '"<rel>"']); };
  const walk = (n) => {
    // A relative static import is rewiring, not logic: it may be re-split or re-pointed when owners move (the
    // symbol body hashes and tsc still prove nothing else changed). Re-exports keep specifier-only normalisation.
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && n.moduleSpecifier.text.startsWith(".")) { edits.push([n.getFullStart(), n.getEnd(), ""]); return; }
    if (ts.isExportDeclaration(n) && n.moduleSpecifier) spec(n.moduleSpecifier);
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) spec(n.arguments[0]);
    ts.forEachChild(n, walk);
  };
  walk(tree);
  let out = text;
  for (const [s, e, r] of edits.sort((x, y) => y[0] - x[0])) out = out.slice(0, s) + r + out.slice(e);
  return out;
}
// Hash of a node's text with relative import specifiers (static or dynamic) normalised: a move may change those, nothing else.
function hashNode(tree, node, text) {
  const start = node.getStart(tree), end = node.getEnd(), edits = [];
  const walk = (n) => {
    const spec = (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) ? n.moduleSpecifier : (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword ? n.arguments[0] : null);
    if (spec && ts.isStringLiteral(spec) && spec.text.startsWith(".")) edits.push([spec.getStart(tree) - start, spec.getEnd() - start]);
    ts.forEachChild(n, walk);
  };
  walk(node);
  let t = text.slice(start, end);
  for (const [s0, e0] of edits.sort((a, b) => b[0] - a[0])) t = t.slice(0, s0) + '"<rel>"' + t.slice(e0);
  // A moved type/interface/class must become exported; the `export` modifier is the only thing a move may add to it.
  t = t.replace(/^export\s+(?=(interface|type|class|enum)\b)/, "");
  return sha256(t);
}
function symbolsOf(f, text) {
  const tree = parse(f, text);
  const lines = (n) => [tree.getLineAndCharacterOfPosition(n.getStart(tree)).line + 1, tree.getLineAndCharacterOfPosition(n.getEnd()).line + 1];
  const out = [];
  const dbWords = /\b(db\.(select|insert|update|delete|execute|transaction)|sql`)/;
  const providerWords = /\b(fetch\(|sendEmail|sendToUser|createNotification|cron\.schedule)/;
  for (const n of tree.statements) {
    const exported = !!n.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    const add = (name, kind, node, body) => {
      const t = body ? body.getText(tree) : node.getText(tree);
      out.push({ name, kind, exported, lines: lines(node), body_sha256: hashNode(tree, body ?? node, text), db_ops: dbWords.test(t), provider_ops: providerWords.test(t) });
    };
    if (ts.isFunctionDeclaration(n) && n.name) add(n.name.text, "function", n, n.body);
    else if (ts.isClassDeclaration(n) && n.name) add(n.name.text, "class", n, n);
    else if (ts.isVariableStatement(n)) { for (const d of n.declarationList.declarations) if (ts.isIdentifier(d.name)) add(d.name.text, d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)) ? "function-value" : "const", n, d.initializer ?? n); }
    else if (ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n)) add(n.name.text, "type", n, n);
  }
  return out;
}
const allSourceFiles = () => walkFiles(ROOT, [], (p) => /\.(ts|tsx|mts|mjs|js)$/.test(p) && !rel(p).startsWith("scripts/antas/") && !rel(p).startsWith("attached_assets/")).map(rel);
function importEdges(f) {
  const tree = parse(f, read(f));
  const edges = [];
  const walk = (n) => {
    const s = (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) ? n.moduleSpecifier : (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword ? n.arguments[0] : null);
    if (s && ts.isStringLiteral(s) && s.text.startsWith(".")) edges.push(rel(path.resolve(path.dirname(abs(f)), s.text)));
    ts.forEachChild(n, walk);
  };
  walk(tree);
  return edges;
}
const stripExt = (f) => f.replace(/\.(ts|tsx|mts|mjs|js)$/, "");
const consumersOf = (targets) => {
  const want = new Map(targets.map((t) => [stripExt(t), t]));
  const found = {};
  for (const f of allSourceFiles()) {
    let edges; try { edges = importEdges(f); } catch { continue; }
    for (const e of edges) { const t = want.get(stripExt(e)); if (t && t !== f) (found[t] ??= new Set()).add(f); }
  }
  return Object.fromEntries(Object.entries(found).map(([k, v]) => [k, [...v].sort()]));
};

// ───────────────────────────── census (08-A)
if (STAGE === "split-census" || STAGE === "split-verify") {
  if (!CFG.extractMethod) fail("config has no extractMethod plan");
  await (await import("./split-proof.mjs")).run({ STAGE, CFG, ts, fail, SUB, DIR, API });
  process.exit(0);
}
if (STAGE === "census") {
  // extraSources: files that are not moved/thinned themselves but lose individual symbols (symbolMoves.from) — frozen so those bodies can be proven unchanged.
  const sources = [...new Set([...Object.keys(MOVES), ...Object.keys(ROUTES), ...(CFG.extraSources ?? [])])];
  if (exists(MANIFEST) || exists(INVENTORY)) {
    if (!exists(MANIFEST) || !exists(INVENTORY)) fail("partial census evidence exists; refusing to replace a sealed snapshot");
    const m = JSON.parse(read(MANIFEST)), i = JSON.parse(read(INVENTORY));
    if (m.status !== "PASS" || i.status !== "PASS") fail("existing census is not a sealed PASS");
    for (const s of m.sources) if (!exists(s.baseline_copy) || sha256File(abs(s.baseline_copy)) !== s.sha256) fail(`sealed baseline missing or corrupt: ${s.file}`);
    console.log(`${SUB} already PASS — sealed pre-extraction census retained`); process.exit(0);
  }
  for (const f of sources) if (!exists(f)) fail(`pre-extraction source missing (census must run before the move): ${f}`);
  for (const n of Object.values(MOVES)) if (exists(n)) fail(`destination already exists, census must precede extraction: ${n}`);
  const consumers = consumersOf(Object.keys(MOVES));
  const records = [], manifestSources = [], frozen = new Map();
  for (const f of sources) {
    const text = read(f);
    if (parse(f, text).parseDiagnostics.length) fail(`source does not parse: ${f}`);
    const syms = symbolsOf(f, text);
    syms.forEach((s) => records.push({ file: f, ...s }));
    frozen.set(baselineCopy(f), text);
    manifestSources.push({ file: f, baseline_copy: baselineCopy(f), sha256: sha256(text), lines: text.split("\n").length, symbols: syms.length, exported: syms.filter((s) => s.exported).length });
  }
  const hashes = Object.fromEntries(manifestSources.map((s) => [s.file, s.sha256]));
  for (const [p, t] of frozen) { fs.mkdirSync(path.dirname(abs(p)), { recursive: true }); fs.writeFileSync(abs(p), t, { flag: "wx" }); }
  writeEvidence(MANIFEST, { schema_version: 1, phase: GAP, sub_phase: "08-census", ...binding(hashes), source_hashes: hashes, sources: manifestSources, moves: MOVES, status: "PASS" });
  writeEvidence(INVENTORY, { schema_version: 1, phase: GAP, sub_phase: "08-census", ...binding(hashes), source_hashes: hashes, records, consumers, summary: { files: sources.length, symbols: records.length, db_symbols: records.filter((r) => r.db_ops).length, provider_symbols: records.filter((r) => r.provider_ops).length, consumers: Object.values(consumers).flat().length }, status: "PASS" });
  if (CFG.infraCensus) {
    // Direct infrastructure access across the whole Vault behavior tree, classified by the config (sealed with the census).
    const ic = buildInfraCensus(ts, CFG.infraCensus);
    const unclassified = ic.records.filter((r) => !r.disposition || r.disposition === "unclassified");
    if (unclassified.length) fail(`infra census has unclassified symbols:\n  ${unclassified.map((r) => `${r.file}#${r.name}`).join("\n  ")}`);
    writeEvidence(INFRA_CENSUS, { schema_version: 1, phase: GAP, sub_phase: "12-census", ...binding(hashes), source_hashes: hashes, ...ic, status: "PASS" });
  }
  console.log(`${SUB} PASS — froze ${sources.length} sources, ${records.length} symbols (${records.filter((r) => r.db_ops).length} touch the DB), ${new Set(Object.values(consumers).flat()).size} distinct consumer files`);
  process.exit(0);
}

// ───────────────────────────── common prerequisites
for (const f of [MANIFEST, INVENTORY]) if (!exists(f)) fail(`census evidence missing: ${f} (run --stage census BEFORE moving anything)`);
const manifest = JSON.parse(read(MANIFEST)), inventory = JSON.parse(read(INVENTORY));
if (manifest.status !== "PASS" || inventory.status !== "PASS") fail("census is not PASS");
for (const s of manifest.sources) if (!exists(s.baseline_copy) || sha256File(abs(s.baseline_copy)) !== s.sha256) fail(`frozen baseline missing or corrupt: ${s.file}`);
const baselineText = (f) => read(baselineCopy(f));

let differentialEvidence;
function runDifferential() {
  if (differentialEvidence) return differentialEvidence;
  if (!exists(DIFFERENTIAL)) fail(`differential missing: ${DIFFERENTIAL}`);
  const result = spawnSync("node", [DIFFERENTIAL], { cwd: ROOT, encoding: "utf8", timeout: 240_000 });
  if (result.error || result.status !== 0) {
    console.error(`${result.stdout ?? ""}${result.stderr ?? ""}`.slice(-8000));
    fail(`executed differential failed (exit ${result.status ?? "unknown"})`);
  }
  differentialEvidence = {
    summary: result.stdout.trim().split("\n").pop(),
    script_sha256: sha256File(abs(DIFFERENTIAL)),
  };
  return differentialEvidence;
}


// A later gap may legitimately refine an owner this gap created (e.g. GAP-12 moving infrastructure access out of the GAP-11 health modules).
// That is accepted only when the later gap sealed this file's state (split census) equal to what THIS gap proved, and its own proof is a
// PASS bound to the files exactly as they are now.
function successorProves(newF, before) {
  const root = "reports/antas/vault/gap";
  for (const d of fs.readdirSync(abs(root)).map((x) => `${root}/${x}`).filter((x) => x !== DIR)) {
    if (!exists(`${d}/split-census.json`) || !exists(`${d}/split-proof.json`)) continue;
    const census = JSON.parse(read(`${d}/split-census.json`)), proof = JSON.parse(read(`${d}/split-proof.json`));
    const entry = census.sources.find((e) => e.file === newF);
    if (!entry || census.status !== "PASS" || proof.status !== "PASS") continue;
    if (!exists(entry.baseline_copy) || sha256File(abs(entry.baseline_copy)) !== entry.sha256) continue;
    if (normalizedIdentity(newF, read(entry.baseline_copy)) !== before) continue;
    // freshness: the proof must be bound to every planned file exactly as it is now
    const moved = new Map(proof.files.filter((f) => f.relocated_to).map((f) => [f.file, f.relocated_to]));
    const hashes = Object.fromEntries(census.sources.map((e) => [e.file, sha256File(abs(exists(e.file) ? e.file : moved.get(e.file) ?? e.file))]));
    if (binding(hashes).source_tree_sha256 !== proof.source_tree_sha256) continue;
    return true;
  }
  return false;
}

// ───────────────────────────── extract (08-B)
function checkExtract() {
  const proof = [];
  for (const [oldF, newF] of Object.entries(MOVES)) {
    const currentOwner = ownerOf(newF);
    if (!exists(currentOwner)) fail(`new owner missing: ${currentOwner}`);
    const nt = read(currentOwner);
    if (parse(currentOwner, nt).parseDiagnostics.length) fail(`new owner does not parse: ${currentOwner}`);
    const before = normalizedIdentity(oldF, baselineText(oldF)), after = normalizedIdentity(newF, nt);
    const identical = before === after;
    const splitRefinement = !identical && successorProves(newF, before);
    const refinementReason = CFG.refinedMoves?.[newF];
    const differentialRefinement = !identical && !splitRefinement && !!refinementReason;
    if (differentialRefinement) runDifferential();
    const refined = splitRefinement || differentialRefinement;
    if (!identical && !refined) fail(`${currentOwner} differs from the frozen ${oldF} beyond import paths (no downstream split or approved differential proof)`);
    const syms = symbolsOf(currentOwner, nt);
    if (!syms.some((s) => s.kind.startsWith("function") && s.exported)) fail(`${currentOwner} is scaffold-only`);
    const baseSyms = symbolsOf(oldF, baselineText(oldF));
    for (const b of baseSyms) {
      const a = syms.find((s) => s.name === b.name);
      const successor = CFG.symbolSuccessors?.[`${oldF}#${b.name}`];
      if (!a && successor) {
        if (!successor.reason || !exists(successor.file)) fail(`invalid symbol successor for ${b.name} (${oldF})`);
        const replacement = symbolsOf(successor.file, read(successor.file)).find((s) => s.name === successor.name);
        if (!replacement?.exported) fail(`${successor.file} does not export the declared successor ${successor.name} for ${b.name}`);
        runDifferential();
        proof.push({
          symbol: b.name,
          from: oldF,
          to: currentOwner,
          symbol_successor: `${successor.file}#${successor.name}`,
          successor_reason: successor.reason,
          differential_verified: true,
        });
        continue;
      }
      // Unexported declarations are not part of the moved module contract. A proved downstream
      // refinement may inline, rename, or relocate one; keep the observed omission in its evidence.
      if (!a && !b.exported && refined) {
        proof.push({
          symbol: b.name,
          from: oldF,
          to: currentOwner,
          private_declaration_not_retained: true,
          refinement_evidence: splitRefinement ? "later extract-method split proof" : "live gap differential",
        });
        continue;
      }
      if (!a || (!refined && a.body_sha256 !== b.body_sha256) || a.exported !== b.exported) fail(`symbol not preserved: ${b.name} (${oldF} -> ${currentOwner})`);
    }
    proof.push({
      from: oldF,
      to: currentOwner,
      ...(currentOwner !== newF ? { intermediate_owner: newF } : {}),
      symbols_preserved: baseSyms.length,
      identical_modulo_imports: identical,
      ...(splitRefinement ? { refinement_evidence: "later extract-method split proof" } : {}),
      ...(differentialRefinement ? { refinement_evidence: "live gap differential", refinement_reason: refinementReason } : {}),
    });
  }
  for (const [route, r] of Object.entries(ROUTES)) {
    if (!exists(r.app)) fail(`application owner missing: ${r.app}`);
    const tree = parse(r.app, read(r.app));
    if (tree.parseDiagnostics.length) fail(`parse error: ${r.app}`);
    const exp = tree.statements.filter((n) => ts.isFunctionDeclaration(n) && n.body && n.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)).map((n) => n.name.text);
    for (const s of r.symbols) if (!exp.includes(s)) fail(`${r.app} does not export ${s}`);
    proof.push({ route, owner: r.app, symbols: r.symbols });
  }
  for (const repo of REPOSITORIES) if (!exists(repo) || !/export async function/.test(read(repo))) fail(`repository owner missing or scaffold-only: ${repo}`);
  for (const [repo, names] of Object.entries(CFG.repositoryExports ?? {})) {
    const exp = parse(repo, read(repo)).statements.filter((n) => ts.isFunctionDeclaration(n) && n.body && n.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)).map((n) => n.name.text);
    for (const nm of names) if (!exp.includes(nm)) fail(`${repo} does not export ${nm}`);
  }
  // Symbols extracted out of a route: the body must be byte-for-byte what the frozen route had.
  for (const m of SYMBOL_MOVES) {
    if (!exists(m.to)) fail(`symbol owner missing: ${m.to}`);
    const before = symbolsOf(m.from, baselineText(m.from)).find((r) => r.name === m.name);
    if (!before) fail(`frozen baseline has no symbol ${m.name} in ${m.from}`);
    const after = symbolsOf(m.to, read(m.to)).find((s) => s.name === m.name);
    if (!after || !after.exported) fail(`${m.to} does not export ${m.name}`);
    const refinedReason = CFG.refinedSymbolMoves?.[`${m.from}#${m.name}`];
    const identical = after.body_sha256 === before.body_sha256;
    if (!identical && !refinedReason) fail(`symbol body changed during extraction: ${m.name} (${m.from} -> ${m.to})`);
    if (!identical) runDifferential();
    proof.push({
      symbol: m.name,
      from: m.from,
      to: m.to,
      body_identical: identical,
      ...(identical ? {} : { refinement_evidence: "live gap differential", refinement_reason: refinedReason }),
    });
  }
  return proof;
}
if (STAGE === "extract") {
  const proof = checkExtract();
  const hashes = Object.fromEntries(NEW_OWNERS.map((f) => [f, sha256File(abs(f))]));
  writeEvidence(OUT.extract, { schema_version: 1, phase: GAP, sub_phase: "08-extract", ...binding(hashes), source_hashes: hashes, proof, status: "PASS" });
  const exact = proof.filter((p) => p.identical_modulo_imports).length;
  console.log(`${SUB} PASS — ${exact} byte-identical moves, ${proof.length - exact} evidence-backed refinements; ${Object.keys(ROUTES).length} route owners export their use cases`); process.exit(0);
}

// ───────────────────────────── rewire (08-C)
function checkRewire() {
  checkExtract();
  const oldFiles = Object.keys(MOVES);
  // Route modules may only be imported by the registrars; anything else (jobs, other libs) importing a route's
  // exports is a bypass of the new owner.
  const routeImporters = Object.entries(consumersOf(Object.keys(ROUTES))).flatMap(([t, fs_]) => fs_.filter((f) => !CFG.allowedRouteImporters.includes(f)).map((f) => `${f} -> ${t}`));
  if (routeImporters.length) fail(`non-registrar files still import route modules:\n  ${routeImporters.join("\n  ")}`);
  const oldC = consumersOf(oldFiles);
  const bypass = Object.entries(oldC).flatMap(([t, fs_]) => fs_.map((f) => `${f} -> ${t}`));
  if (bypass.length) fail(`consumers still import the old paths:\n  ${bypass.join("\n  ")}`);
  const currentMoves = Object.fromEntries(Object.entries(MOVES).map(([oldF, newF]) => [oldF, ownerOf(newF)]));
  const newC = consumersOf(Object.values(currentMoves));
  const expected = inventory.consumers;
  const graph = [];
  const files = allSourceFiles();
  const byBarePath = new Map(files.map((f) => [stripExt(f), f]));
  const reachability = new Map();
  const reaches = (start, target) => {
    const key = `${stripExt(start)}=>${stripExt(target)}`;
    if (reachability.has(key)) return reachability.get(key);
    const wanted = stripExt(target), seen = new Set(), pending = [start];
    while (pending.length) {
      const current = pending.pop();
      if (seen.has(current)) continue;
      seen.add(current);
      for (const edge of importEdges(current)) {
        const bare = stripExt(edge);
        if (bare === wanted) { reachability.set(key, true); return true; }
        const next = byBarePath.get(bare);
        if (next && !seen.has(next)) pending.push(next);
      }
    }
    reachability.set(key, false);
    return false;
  };
  for (const [oldF, newF] of Object.entries(MOVES)) {
    // A baseline consumer may have been moved itself, or (routes) had its logic extracted into its application owner.
    // A route's imports may now live in its application owner or in any module its symbols were moved to; likewise a plain
    // consumer whose symbols were moved out (their imports travelled with them).
    const candidates = (f) => (MOVES[f] ? [ownerOf(MOVES[f])] : ROUTES[f] ? [ROUTES[f].app, ...SYMBOL_MOVES.filter((m) => m.from === f).map((m) => m.to)] : [f, ...SYMBOL_MOVES.filter((m) => m.from === f).map((m) => m.to)]);
    const want = (expected[oldF] ?? []).map((consumer) => [
      ...candidates(consumer),
      ...(CFG.consumerSuccessors?.[oldF]?.[consumer] ?? []),
    ]);
    const currentOwner = ownerOf(newF);
    const have = new Set(newC[currentOwner] ?? []);
    const checked = (expected[oldF] ?? []).map((consumer, i) => ({
      original: consumer,
      path: want[i].find((f) => exists(f) && reaches(f, currentOwner)) ?? null,
    }));
    const missing = checked.filter((c) => !c.path).map((c) => c.original);
    if (missing.length) fail(`consumers of ${oldF} no longer reach ${currentOwner}: ${missing.join(", ")}`);
    graph.push({
      old: oldF,
      new: currentOwner,
      ...(currentOwner !== newF ? { intermediate_owner: newF } : {}),
      consumers: [...have].sort(),
      reachable_consumer_paths: checked,
    });
  }
  return graph;
}
if (STAGE === "rewire") {
  const graph = checkRewire();
  const hashes = Object.fromEntries(NEW_OWNERS.map((f) => [f, sha256File(abs(f))]));
  writeEvidence(OUT.rewire, { schema_version: 1, phase: GAP, sub_phase: "08-rewire", ...binding(hashes), source_hashes: hashes, graph, old_path_importers_remaining: [], status: "PASS" });
  console.log(`${SUB} PASS — ${graph.reduce((n, g) => n + g.consumers.length, 0)} consumer edges reach the new owners; nothing imports an old path`); process.exit(0);
}

// ───────────────────────────── retire (08-D)
// A gap with an extract-method plan is only retired once every planned infrastructure access has been proven moved (split-verify re-runs here).
if (CFG.extractMethod) await (await import("./split-proof.mjs")).run({ STAGE: "split-verify", CFG, ts, fail, SUB, DIR, API });
const graph = checkRewire();
for (const o of Object.keys(MOVES)) if (exists(o)) fail(`old lib still exists (must be retired): ${o}`);
const literals = (text, f) => {
  const tree = parse(f, text);
  const strings = new Set(), statuses = new Set(), routes = new Set();
  const walk = (n) => {
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) return;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) strings.add(n.text);
    if (ts.isTemplateExpression(n)) { strings.add(n.head.text); n.templateSpans.forEach((s) => strings.add(s.literal.text)); }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression) && n.expression.expression.text === "router" && /^(get|post|put|patch|delete)$/.test(n.expression.name.text) && ts.isStringLiteral(n.arguments[0])) routes.add(`${n.expression.name.text.toUpperCase()} ${n.arguments[0].text}`);
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "status" && ts.isNumericLiteral(n.arguments[0] ?? {})) statuses.add(Number(n.arguments[0].text));
    if (ts.isPropertyAssignment(n) && n.name.getText() === "status" && ts.isNumericLiteral(n.initializer)) statuses.add(Number(n.initializer.text));
    ts.forEachChild(n, walk);
  };
  walk(tree);
  statuses.delete(200);
  return { strings, statuses, routes };
};
const routeReport = [];
for (const [route, r] of Object.entries(ROUTES)) {
  const text = read(route);
  const tree = parse(route, text);
  const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const re of FORBIDDEN_IN_ROUTE) if (re.test(code)) fail(`${route} still contains extracted logic matching ${re}`);
  if (text.split("\n").length > CFG.maxRouteLines) fail(`${route} is too large for a thin adapter`);
  const before = literals(baselineText(route), route);
  const files = r.literalFiles;
  const after = { strings: new Set(), statuses: new Set(), routes: new Set() };
  for (const f of files) { const l = literals(read(f), f); l.strings.forEach((x) => after.strings.add(x)); l.statuses.forEach((x) => after.statuses.add(x)); l.routes.forEach((x) => after.routes.add(x)); }
  if (JSON.stringify([...before.routes].sort()) !== JSON.stringify([...r.routes.map((x) => { const [m, p] = x.split(" "); return `${m} ${p}`; })].sort())) fail(`baseline route set differs from config for ${route}`);
  if (JSON.stringify([...before.routes].sort()) !== JSON.stringify([...after.routes].sort())) fail(`${route}: route set changed`);
  if (JSON.stringify([...before.statuses].sort()) !== JSON.stringify([...after.statuses].sort())) fail(`${route}: HTTP status-code set changed ${[...before.statuses].sort()} -> ${[...after.statuses].sort()}`);
  // Whitespace runs are insignificant in SQL/text literals, so a re-indented (dedented) literal is not a lost one.
  const ws = (s) => s.replace(/\s+/g, " ").trim();
  const afterNorm = new Set([...after.strings].map(ws));
  const lost = [...before.strings].filter((s) => s.trim() && s.length > 1 && !after.strings.has(s) && !afterNorm.has(ws(s)) && !/^[./@]/.test(s));
  if (lost.length) fail(`${route}: string literals lost in extraction:\n  ${lost.join("\n  ")}`);
  const adapters = [];
  const visit = (n) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression) && n.expression.expression.text === "router" && /^(get|post|put|patch|delete)$/.test(n.expression.name.text)) adapters.push(n.arguments[n.arguments.length - 1]);
    ts.forEachChild(n, visit);
  };
  visit(tree);
  for (const h of adapters) if (!/await \w+\(|=\s*\w+\(/.test(h.body?.getText() ?? "")) fail(`${route}: a handler does not delegate to the application owner`);
  routeReport.push({ route, lines: text.split("\n").length, baseline_lines: baselineText(route).split("\n").length, handlers: before.routes.size, status_codes: [...after.statuses].sort() });
}
// No duplicate implementation: a moved symbol must be defined in exactly one backend source file (API + operator scripts;
// same-named frontend API clients and unrelated services are different code).
const dupes = [];
const dupCandidates = [...Object.keys(MOVES).flatMap((oldF) => symbolsOf(oldF, baselineText(oldF)).filter((r) => r.exported && r.kind.startsWith("function"))), ...SYMBOL_MOVES.map((m) => ({ name: m.name }))];
for (const s of dupCandidates) {
  const owners = allSourceFiles().filter((f) => (f.startsWith(`${API}/`) || f.startsWith("scripts/src/")) && new RegExp(`(function\\s+${s.name}\\b|(?:const|let)\\s+${s.name}\\s*[=:]|(?:interface|type|class)\\s+${s.name}\\b)`).test(read(f)) && !(CFG.duplicateAllow?.[s.name] ?? []).includes(f));
  if (owners.length !== 1) dupes.push(`${s.name}: ${owners.join(", ")}`);
}
if (dupes.length) fail(`duplicate/missing implementations:\n  ${dupes.join("\n  ")}`);
// Migration map.
const mapLines = read(MAP_DOC).split("\n");
for (const row of MAP_ROWS) if (!mapLines.includes(row)) fail(`migration map is missing row: ${row.slice(0, 90)}…`);
// Behavior + types.
if (!exists(DIFFERENTIAL)) fail(`differential missing: ${DIFFERENTIAL}`);
const diff = runDifferential();
const diffSummary = diff.summary;
const tc = spawnSync("pnpm", ["--filter", "@workspace/api-server", "run", "typecheck"], { cwd: ROOT, encoding: "utf8", timeout: 300_000, maxBuffer: 12 * 1024 * 1024 });
if (tc.error || tc.status !== 0) { console.error(`${tc.stdout ?? ""}${tc.stderr ?? ""}`.slice(-12_000)); fail(`TypeScript check failed (exit ${tc.status ?? "unknown"})`); }
const hashes = Object.fromEntries([...NEW_OWNERS, ...Object.keys(ROUTES), DIFFERENTIAL].map((f) => [f, sha256File(abs(f))]));
writeEvidence(OUT.retire, {
  schema_version: 1, phase: GAP, sub_phase: "08-retire", ...binding(hashes), source_hashes: hashes,
  old_files_removed: Object.keys(MOVES), moves: MOVES, consumer_graph: graph, routes: routeReport,
  duplicate_implementations: [], executed_differential: diffSummary, differential_script_sha256: diff.script_sha256, typecheck: { exit_code: tc.status }, status: "PASS",
});
console.log(`${SUB} PASS — ${Object.keys(MOVES).length} old libs retired, ${routeReport.length} routes thin (${routeReport.map((r) => `${r.baseline_lines}→${r.lines}`).join(", ")}), ${diffSummary}, typecheck clean`);
