#!/usr/bin/env node
/**
 * Projects module boundary validator (PRJ-01 boundaries, cumulative through the current phase).
 *
 * Static, read-only. Gate (roadmap): no duplicate owner, no new unexplained cycle,
 * no public API change. It never touches source files; it only writes
 *   reports/antas/projects/prj-01-dependency-scan.json
 *   reports/antas/projects/prj-01-route-owner-map.csv
 *
 * Reports are written as <phase>-dependency-scan.json / <phase>-route-owner-map.csv, so earlier phase reports stay as history.
 * Usage: node scripts/antas/projects/validate-boundaries.mjs [--self-test] [--no-write]
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const manifest = JSON.parse(fs.readFileSync(path.join(here, "boundaries.manifest.json"), "utf8"));
const PHASE = manifest.currentPhase ?? manifest.phase;
const phaseTag = PHASE.toLowerCase();
const serverRoot = path.join(root, "artifacts/api-server/src");
const moduleRoot = path.join(root, manifest.sources.moduleRoot);
const reportDir = path.join(root, "reports/antas/projects");
const docsDir = path.join(root, "docs/antas/projects");

const rel = (file) => path.relative(root, file).split(path.sep).join("/");
const read = (file) => fs.readFileSync(file, "utf8");

function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules") return [];
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}
const isSource = (f) => /\.(?:mjs|cjs|js|mts|cts|ts|tsx|jsx)$/.test(f);
const isTest = (f) => /\.(?:test|spec)\.[^.]+$/.test(f);

/** Remove block comments and whole-line / trailing `//` comments so prose never counts as code. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[\s;{}(),])\/\/.*$/gm, "$1");
}

function importStatements(source) {
  const out = [];
  const code = stripComments(source);
  for (const m of code.matchAll(/\bimport\s+(type\s+)?([\s\S]*?)\s*from\s*["']([^"']+)["']/g)) {
    const clause = m[2];
    const named = clause.match(/\{([\s\S]*)\}/);
    const symbols = named
      ? named[1].split(",").map((s) => s.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim()).filter(Boolean)
      : [];
    out.push({ specifier: m[3], symbols, typeOnly: Boolean(m[1]) });
  }
  for (const m of code.matchAll(/\bimport\s*["']([^"']+)["']/g)) out.push({ specifier: m[1], symbols: [], typeOnly: false });
  for (const m of code.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) out.push({ specifier: m[1], symbols: [], typeOnly: false, dynamic: true });
  return out;
}

function resolveLocalImport(importer, specifier, fileSet) {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(importer), specifier);
  const candidates = [
    base,
    ...[".ts", ".tsx", ".mts", ".js", ".mjs", ".cjs"].map((e) => `${base}${e}`),
    ...["index.ts", "index.tsx", "index.js", "index.mjs"].map((n) => path.join(base, n)),
  ];
  return candidates.find((c) => fileSet.has(c)) ?? null;
}

function stronglyConnectedComponents(graph) {
  let next = 0;
  const idx = new Map(), low = new Map(), stack = [], onStack = new Set(), out = [];
  const visit = (node) => {
    idx.set(node, next); low.set(node, next); next += 1; stack.push(node); onStack.add(node);
    for (const dep of graph.get(node) ?? []) {
      if (!idx.has(dep)) { visit(dep); low.set(node, Math.min(low.get(node), low.get(dep))); }
      else if (onStack.has(dep)) low.set(node, Math.min(low.get(node), idx.get(dep)));
    }
    if (low.get(node) === idx.get(node)) {
      const comp = []; let m;
      do { m = stack.pop(); onStack.delete(m); comp.push(m); } while (m !== node);
      out.push(comp);
    }
  };
  for (const n of graph.keys()) if (!idx.has(n)) visit(n);
  return out;
}

// ── route parsing ────────────────────────────────────────────────────────────
function parseRoutes(file) {
  const routes = [];
  read(file).split("\n").forEach((line, i) => {
    const m = line.match(/^router\.(get|post|put|patch|delete)\(\s*"([^"]+)"\s*,(.*)$/);
    if (!m) return;
    const middleware = [...m[3].matchAll(/\b(require[A-Za-z]+)\b/g)].map((x) => x[1]);
    routes.push({ method: m[1].toUpperCase(), path: m[2], line: i + 1, middleware });
  });
  return routes;
}
const surfaceLine = (r) => `${r.method} ${r.path} | ${r.middleware.join(",")}`;

/** Static first-match shadowing under Express 4 semantics: an earlier route with the same method,
 *  same segment count, and a param (or equal literal) in every position handles every request the
 *  later route could receive. Partial overlaps are intentionally not reported. */
export function findShadows(ordered) {
  const shadows = [];
  const seg = (p) => p.split("/").filter(Boolean);
  for (let j = 0; j < ordered.length; j += 1) {
    for (let i = 0; i < j; i += 1) {
      const a = ordered[i], b = ordered[j];
      if (a.method !== b.method) continue;
      const sa = seg(a.path), sb = seg(b.path);
      if (sa.length !== sb.length) continue;
      if (a.path === b.path) { shadows.push({ shadowed: `${b.method} ${b.path}`, shadowedBy: `${a.method} ${a.path}`, kind: "duplicate-registration" }); break; }
      const covers = sa.every((s, k) => s.startsWith(":") || s === sb[k]);
      if (covers) { shadows.push({ shadowed: `${b.method} ${b.path}`, shadowedBy: `${a.method} ${a.path}`, kind: "param-shadow" }); break; }
    }
  }
  return shadows;
}

// ── table-name detection ─────────────────────────────────────────────────────
const tableGroups = manifest.tableOwnership;
const ownerOfTable = new Map();
const identifierToTable = new Map();
for (const [owner, tables] of Object.entries(tableGroups)) {
  for (const [table, identifiers] of Object.entries(tables)) {
    ownerOfTable.set(table, owner);
    for (const id of identifiers) identifierToTable.set(id, table);
  }
}
const rawNamePattern = (names) => new RegExp(`\\b(FROM|JOIN|INTO|UPDATE)\\s+(?:public\\.)?(${names.join("|")})\\b`, "gi");

/** Returns Map<table, "read"|"write"> for the tables of the given owners touched by `source`. */
function tableAccess(source, ownersWanted) {
  const code = stripComments(source);
  const result = new Map();
  const mark = (table, access) => {
    if (!ownersWanted.includes(ownerOfTable.get(table))) return;
    if (result.get(table) !== "write") result.set(table, access);
  };
  for (const [identifier, table] of identifierToTable) {
    const mentioned = new RegExp(`\\b${identifier}\\b`).test(code);
    if (!mentioned) continue;
    mark(table, "read");
    if (new RegExp(`\\.(?:insert|update|delete)\\(\\s*${identifier}\\b`).test(code)) mark(table, "write");
  }
  const names = [...ownerOfTable.keys()];
  const alt = names.filter((n) => ownersWanted.includes(ownerOfTable.get(n)));
  if (alt.length) {
    for (const m of code.matchAll(rawNamePattern(alt))) {
      const verb = m[1].toUpperCase();
      // `DELETE FROM x` shows up as FROM; resolve it by looking back for DELETE.
      const before = code.slice(Math.max(0, m.index - 12), m.index);
      const isWrite = verb === "INTO" || verb === "UPDATE" || /DELETE\s*$/i.test(before);
      mark(m[2].toLowerCase(), isWrite ? "write" : "read");
    }
  }
  return result;
}

// ── main analysis ────────────────────────────────────────────────────────────
function analyze() {
  const findings = [];
  const notes = [];
  const allServer = walk(serverRoot).filter((f) => isSource(f) && !isTest(f));
  const serverSet = new Set(allServer);
  const routeFiles = Object.fromEntries(manifest.sources.routes.map((r) => [path.basename(r, ".ts"), path.join(root, r)]));
  const moduleFiles = walk(moduleRoot).filter((f) => isSource(f) && !isTest(f));
  const projectsSources = [...Object.values(routeFiles), ...moduleFiles];
  const projectsSourceSet = new Set(projectsSources);

  for (const [name, file] of Object.entries(routeFiles)) {
    if (!fs.existsSync(file)) findings.push({ check: "route-file-present", file: rel(file), name });
  }
  if (findings.length) return { findings, notes, scan: {} };

  // 1. route counts + frozen surface + owner map
  const parsed = Object.fromEntries(Object.entries(routeFiles).map(([n, f]) => [n, parseRoutes(f)]));
  const counts = Object.fromEntries(Object.entries(parsed).map(([n, r]) => [n, r.length]));
  for (const [name, expected] of Object.entries(manifest.sources.expectedRouteCounts)) {
    if (counts[name] !== expected) findings.push({ check: "route-count", file: name, expected, actual: counts[name] });
  }
  const surface = {};
  for (const [name, routes] of Object.entries(parsed)) {
    const actual = routes.map(surfaceLine);
    const frozen = manifest.frozenRouteSurface[name] ?? [];
    surface[name] = actual;
    const added = actual.filter((l) => !frozen.includes(l));
    const removed = frozen.filter((l) => !actual.includes(l));
    const sameOrder = added.length === 0 && removed.length === 0 && actual.every((l, i) => l === frozen[i]);
    if (!sameOrder) findings.push({ check: "frozen-route-surface", file: name, added, removed, orderChanged: added.length === 0 && removed.length === 0 });
  }
  const surfaceHash = crypto.createHash("sha256")
    .update(Object.keys(manifest.frozenRouteSurface).filter((k) => k !== "note" && k !== "mountOrder").map((k) => manifest.frozenRouteSurface[k].join("\n")).join("\n--\n"))
    .digest("hex");
  const actualHash = crypto.createHash("sha256")
    .update(Object.keys(manifest.frozenRouteSurface).filter((k) => k !== "note" && k !== "mountOrder").map((k) => (surface[k] ?? []).join("\n")).join("\n--\n"))
    .digest("hex");

  const ownerKey = (r) => `${r.file}|${r.method} ${r.path}`;
  const ownerEntries = new Map();
  const duplicateOwners = [];
  for (const entry of manifest.routeOwners) {
    const key = ownerKey(entry);
    if (ownerEntries.has(key)) duplicateOwners.push(key);
    ownerEntries.set(key, entry);
  }
  if (duplicateOwners.length) findings.push({ check: "duplicate-route-owner", routes: duplicateOwners });
  const actualKeys = Object.entries(parsed).flatMap(([n, rs]) => rs.map((r) => ownerKey({ file: n, ...r })));
  const unmapped = actualKeys.filter((k) => !ownerEntries.has(k));
  const orphaned = [...ownerEntries.keys()].filter((k) => !actualKeys.includes(k));
  if (unmapped.length || orphaned.length) findings.push({ check: "route-owner-coverage", unmapped, orphaned });
  const routeOwnerRows = Object.entries(parsed).flatMap(([n, rs]) => rs.map((r) => {
    const o = ownerEntries.get(ownerKey({ file: n, ...r }));
    return { file: `routes/${n}.ts`, line: r.line, method: r.method, path: r.path, middleware: r.middleware.join("+"), owner: o?.owner ?? "UNMAPPED", pepOwner: o?.pepOwner ?? "" };
  }));

  // 2. mount order in routes/index.ts
  const indexSource = read(path.join(root, manifest.sources.routeIndex));
  const mountPositions = ["projectsRouter", "projectDatesRouter", "projectTemplatesRouter"].map((id) => indexSource.search(new RegExp(`router\\.use\\(\\s*${id}\\s*\\)`)));
  const mountOk = mountPositions.every((p) => p >= 0) && mountPositions[0] < mountPositions[1] && mountPositions[1] < mountPositions[2];
  if (!mountOk) findings.push({ check: "route-mount-order", expected: manifest.frozenRouteSurface.mountOrder, positions: mountPositions });
  const mountedSpecifiers = [...indexSource.matchAll(/import\s+(projectsRouter|projectDatesRouter|projectTemplatesRouter)\s+from\s+"([^"]+)"/g)].map((m) => m[2]);

  // 3. shadowed routes (cross-file, in mount order)
  const ordered = [...parsed["projects"], ...parsed["project-dates"], ...parsed["project-templates"]];
  const shadows = findShadows(ordered);
  const knownShadowKeys = manifest.knownShadowedRoutes.map((s) => `${s.shadowed}<-${s.shadowedBy}`);
  const unknownShadows = shadows.filter((s) => !knownShadowKeys.includes(`${s.shadowed}<-${s.shadowedBy}`));
  const missingKnownShadows = manifest.knownShadowedRoutes.filter((s) => !shadows.some((x) => x.shadowed === s.shadowed && x.shadowedBy === s.shadowedBy));
  if (unknownShadows.length) findings.push({ check: "unexplained-route-shadow", shadows: unknownShadows });
  if (missingKnownShadows.length) findings.push({ check: "stale-known-shadow", shadows: missingKnownShadows, message: "A recorded shadow no longer exists. Behavior changed; re-baseline deliberately." });

  // 4. protected symbols: exactly one declaration, at the current owner
  const declares = (src, name) => new RegExp(`\\b(?:async\\s+)?(?:function|const|let|var)\\s+${name}\\b`).test(stripComments(src));
  const symbolOwners = {};
  const sourceTextCache = new Map(allServer.map((f) => [f, read(f)]));
  for (const sym of manifest.protectedSymbols) {
    const owners = allServer.filter((f) => declares(sourceTextCache.get(f), sym.name)).map(rel);
    symbolOwners[sym.name] = owners;
    if (owners.length !== 1 || owners[0] !== sym.currentOwner) {
      findings.push({ check: "single-symbol-owner", symbol: sym.name, expectedOwner: sym.currentOwner, actualOwners: owners });
    }
  }

  // 5. cross-module imports from Projects sources
  const importEdges = [];
  const crossModuleViolations = [];
  const usedAllowEntries = new Set();
  for (const file of projectsSources) {
    for (const stmt of importStatements(read(file))) {
      const target = resolveLocalImport(file, stmt.specifier, serverSet);
      if (!target) continue;
      const targetRel = rel(target);
      const targetModule = targetRel.includes("/src/vault/") ? "vault"
        : targetRel.includes("/src/finance/") || /\/src\/lib\/finance-/.test(targetRel) ? "finance" : null;
      if (!targetModule) continue;
      const edge = { from: rel(file), specifier: stmt.specifier, target: targetRel, symbols: stmt.symbols, targetModule };
      importEdges.push(edge);
      const idx = manifest.allowedCrossModuleImports.findIndex((a) => a.from === edge.from && a.specifier === edge.specifier);
      if (idx < 0) { crossModuleViolations.push({ ...edge, reason: "import not in allowlist" }); continue; }
      usedAllowEntries.add(idx);
      const allowed = [...manifest.allowedCrossModuleImports[idx].symbols].sort().join(",");
      if (allowed !== [...stmt.symbols].sort().join(",")) crossModuleViolations.push({ ...edge, reason: `symbols differ from contract (${allowed})` });
    }
  }
  const staleAllow = manifest.allowedCrossModuleImports.filter((_, i) => !usedAllowEntries.has(i));
  if (crossModuleViolations.length) findings.push({ check: "cross-module-import-allowlist", violations: crossModuleViolations });
  if (staleAllow.length) findings.push({ check: "stale-cross-module-allowlist", entries: staleAllow.map((a) => `${a.from} -> ${a.specifier}`) });

  // 6. reverse edges: Vault/Finance must never import Projects code
  const reverse = [];
  for (const file of allServer) {
    const r = rel(file);
    if (!r.includes("/src/vault/") && !r.includes("/src/finance/") && !/\/src\/lib\/finance-/.test(r)) continue;
    for (const stmt of importStatements(sourceTextCache.get(file))) {
      const target = resolveLocalImport(file, stmt.specifier, serverSet);
      if (target && projectsSourceSet.has(target)) reverse.push({ from: r, to: rel(target) });
    }
  }
  if (reverse.length) findings.push({ check: "reverse-module-edge", edges: reverse });

  // 7. foreign-table reads inside Projects route sources
  const foreignObserved = [];
  for (const file of projectsSources) {
    const access = tableAccess(read(file), ["vault", "finance", "unmodularized-siblings"]);
    for (const [table, kind] of access) foreignObserved.push({ file: rel(file), table, kind, owner: ownerOfTable.get(table) });
  }
  const knownForeign = manifest.knownForeignTableEdges;
  const newForeign = foreignObserved.filter((o) => !knownForeign.some((k) => k.file === o.file && k.table === o.table && k.kind === o.kind));
  const staleForeign = knownForeign.filter((k) => !foreignObserved.some((o) => o.file === k.file && o.table === k.table && o.kind === k.kind));
  if (newForeign.length) findings.push({ check: "new-foreign-table-edge", edges: newForeign });
  if (staleForeign.length) findings.push({ check: "stale-foreign-table-edge", edges: staleForeign.map((k) => `${k.file}:${k.table}`) });

  // 8. outside consumers of Projects-owned tables
  const externalObserved = [];
  for (const file of allServer) {
    if (projectsSourceSet.has(file)) continue;
    const access = tableAccess(sourceTextCache.get(file), ["projects"]);
    if (!access.size) continue;
    const kind = [...access.values()].includes("write") ? "write" : "read";
    externalObserved.push({ file: rel(file), access: kind, tables: [...access.keys()].sort(), writes: [...access].filter(([, v]) => v === "write").map(([k]) => k).sort() });
  }
  const knownExternal = manifest.knownExternalConsumers;
  const externalProblems = [];
  for (const o of externalObserved) {
    const k = knownExternal.find((e) => e.file === o.file);
    if (!k) { externalProblems.push({ file: o.file, problem: "new external consumer", access: o.access, tables: o.tables }); continue; }
    if (o.access === "write" && k.access !== "write") externalProblems.push({ file: o.file, problem: "read escalated to write", tables: o.writes });
    const unlisted = o.tables.filter((t) => !k.tables.includes(t));
    if (unlisted.length) externalProblems.push({ file: o.file, problem: "touches tables not recorded", tables: unlisted });
  }
  for (const k of knownExternal) {
    if (!externalObserved.some((o) => o.file === k.file)) externalProblems.push({ file: k.file, problem: "recorded consumer no longer touches Projects tables (stale entry)" });
  }
  if (externalProblems.length) findings.push({ check: "external-project-table-consumers", problems: externalProblems });

  // 8b. billing guard (PRJ-07): anything that CREATES enrollments outside the single-enroll use case must check and
  // charge credits through projects/application/enrollment-billing, or be explicitly exempt with a reason.
  {
    const billed = manifest.billedEnrollmentWriters ?? [];
    const exempt = manifest.exemptEnrollmentWriters ?? [];
    const problems = [];
    for (const b of billed) {
      const text = stripComments(read(path.join(root, b.file)));
      for (const call of ["checkEnrollCredits(", "chargeEnrollCredits("]) if (!text.includes(call)) problems.push({ file: b.file, problem: `no longer calls ${call}` });
      if (!importStatements(read(path.join(root, b.file))).some((i) => i.specifier.endsWith("projects/application/enrollment-billing") || (b.file.includes("/projects/application/") && i.specifier === "./enrollment-billing"))) problems.push({ file: b.file, problem: "does not import enrollment-billing" });
    }
    for (const o of externalObserved) {
      if (!o.writes.includes("project_enrollments")) continue;
      if (billed.some((b) => b.file === o.file) || exempt.some((e) => e.file === o.file)) continue;
      problems.push({ file: o.file, problem: "writes project_enrollments but is neither billed nor exempt" });
    }
    for (const e of exempt) if (!externalObserved.some((o) => o.file === e.file && o.writes.includes("project_enrollments"))) problems.push({ file: e.file, problem: "exempt entry is stale (no longer writes project_enrollments)" });
    if (problems.length) findings.push({ check: "enrollment-billing-guard", problems });
  }

  // 9. module layout, purity and dependency direction (active once projects/ exists)
  const moduleState = { exists: fs.existsSync(moduleRoot), files: moduleFiles.map(rel) };
  if (moduleState.exists) {
    const domainDir = path.join(moduleRoot, "domain");
    const impure = [];
    for (const file of walk(domainDir).filter((f) => isSource(f) && !isTest(f))) {
      for (const stmt of importStatements(read(file))) {
        const target = resolveLocalImport(file, stmt.specifier, new Set([...serverSet]));
        if (!(target && target.startsWith(`${domainDir}${path.sep}`))) impure.push({ file: rel(file), specifier: stmt.specifier });
      }
    }
    if (impure.length) findings.push({ check: "projects-domain-purity", imports: impure });
    const upward = [];
    for (const file of moduleFiles) {
      for (const stmt of importStatements(read(file))) {
        const target = resolveLocalImport(file, stmt.specifier, serverSet);
        if (target && /\/src\/routes\//.test(rel(target))) upward.push({ file: rel(file), specifier: stmt.specifier });
      }
    }
    if (upward.length) findings.push({ check: "projects-imports-routes", edges: upward, message: "projects/ must not import route modules; routes are adapters over projects/." });
  } else {
    notes.push("projects/ module root does not exist yet (expected at PRJ-01: no code moves until PRJ-02).");
  }

  // 9b. extracted routes must be pure adapters (PRJ-02 onward)
  for (const ad of manifest.extractedAdapters ?? []) {
    const file = routeFiles[ad.file];
    const text = stripComments(read(file));
    const specs = importStatements(read(file)).map((i) => i.specifier);
    const bad = specs.filter((sp) => ad.forbiddenImports.includes(sp));
    const missing = ad.mustImportFrom.filter((sp) => !specs.includes(sp));
    const patterns = (ad.forbiddenPatterns ?? []).filter((p) => new RegExp(p).test(text));
    if (bad.length || missing.length || patterns.length) findings.push({ check: "adapter-purity", file: rel(file), forbiddenImportsFound: bad, missingImports: missing, forbiddenPatternsFound: patterns });
  }

  // 9c. single table owner file (repository) for extracted tables
  for (const t of manifest.tableOwnerFiles ?? []) {
    const offenders = [];
    for (const file of allServer) {
      const r = rel(file);
      if (r === t.ownerFile || (t.allowedOthers ?? []).includes(r)) continue;
      const code = stripComments(sourceTextCache.get(file));
      const typed = t.identifiers.some((id) => new RegExp(`\\b${id}\\b`).test(code));
      const raw = new RegExp(`\\b(FROM|JOIN|INTO|UPDATE)\\s+(?:public\\.)?${t.table}\\b`, "i").test(code);
      if (typed || raw) offenders.push(r);
    }
    if (!fs.existsSync(path.join(root, t.ownerFile))) offenders.push(`${t.ownerFile} (owner file missing)`);
    if (offenders.length) findings.push({ check: "single-table-owner", table: t.table, ownerFile: t.ownerFile, offenders });
  }

  // 9d. layering inside projects/: infrastructure may not import application or routes; application may not import routes
  if (moduleState.exists) {
    const layerOf = (f) => { const m2 = rel(f).match(/\/src\/projects\/(domain|application|infrastructure|security|contracts)\//); return m2 ? m2[1] : null; };
    const layering = [];
    for (const file of moduleFiles) {
      const from = layerOf(file);
      for (const stmt of importStatements(read(file))) {
        const target = resolveLocalImport(file, stmt.specifier, serverSet);
        if (!target) continue;
        const to = layerOf(target);
        if (from === "infrastructure" && (to === "application" || /\/src\/routes\//.test(rel(target)))) layering.push({ file: rel(file), specifier: stmt.specifier });
        if (from === "domain" && to && to !== "domain") layering.push({ file: rel(file), specifier: stmt.specifier });
      }
    }
    if (layering.length) findings.push({ check: "projects-layering", violations: layering });
  }

  // 9e. legacy retirement: nothing may import the three route files' internals; only routes/index.ts mounts them
  {
    const everything = walk(serverRoot).filter(isSource);
    const everythingSet = new Set(everything);
    const legacyTargets = new Set(Object.values(routeFiles));
    const allowedMount = path.join(root, manifest.sources.routeIndex);
    const offenders = [];
    for (const file of everything) {
      if (legacyTargets.has(file)) continue;
      for (const stmt of importStatements(read(file))) {
        const target = resolveLocalImport(file, stmt.specifier, everythingSet);
        if (!target || !legacyTargets.has(target)) continue;
        if (file === allowedMount && stmt.symbols.length === 0 && !stmt.dynamic) continue; // default-import mount
        offenders.push({ importer: rel(file), imports: rel(target), symbols: stmt.symbols });
      }
    }
    if (offenders.length) findings.push({ check: "legacy-route-internals-imported", offenders, message: "Only routes/index.ts may import the legacy route files, and only their default router." });
  }

  // 10. import cycles that include a Projects source
  const graph = new Map();
  for (const file of allServer) {
    graph.set(file, importStatements(sourceTextCache.get(file)).map((s) => resolveLocalImport(file, s.specifier, serverSet)).filter(Boolean));
  }
  const cycles = stronglyConnectedComponents(graph)
    .filter((c) => (c.length > 1 || (graph.get(c[0]) ?? []).includes(c[0])) && c.some((f) => projectsSourceSet.has(f)))
    .map((c) => c.map(rel).sort());
  const knownCycles = manifest.knownImportCycles ?? [];
  const newCycles = cycles.filter((c) => !knownCycles.some((k) => JSON.stringify(k) === JSON.stringify(c)));
  if (newCycles.length) findings.push({ check: "import-cycle-including-projects", cycles: newCycles });
  if (cycles.length && !newCycles.length) notes.push(`${cycles.length} pre-existing recorded import cycle(s) include Projects sources.`);

  // 11. PEP wiring frozen (Season C9 / D7 / E3 behavior)
  const enrollmentUseCase = path.join(moduleRoot, "application/enrollment.ts");
  const projectsSource = stripComments(read(routeFiles["projects"]) + (fs.existsSync(enrollmentUseCase) ? `\n${read(enrollmentUseCase)}` : ""));
  const pepPins = [
    ["project_enrollment.delete", /requireProjectEnrollmentOwnership\(\s*"project_enrollment\.delete"/],
    ["project_enrollment.activity.read", /requireProjectEnrollmentOwnership\(\s*"project_enrollment\.activity\.read"/],
    ["project.entity_overview.read", /requireProjectsVaultEntryOwnership\(\s*"project\.entity_overview\.read"/],
    ["project.enroll", /requireProjectsVaultEntryOwnership\(\s*"project\.enroll"/],
    ["project.enroll.kyc_entry (audit-only)", /(?:auditProjectsOwnership\([^)]*|\baudit\(\s*)"project\.enroll\.kyc_entry"/],
    ["project_pnl_receipt.view", /requirePublicAudit\(\s*"project_pnl_receipt\.view"/],
    ["project_pnl_receipt.pdf", /requirePublicAudit\(\s*"project_pnl_receipt\.pdf"/],
  ];
  const missingPins = pepPins.filter(([, re]) => !re.test(projectsSource)).map(([n]) => n);
  if (missingPins.length) findings.push({ check: "pep-wiring-frozen", missing: missingPins });

  // 12. documentation covers every owner and every contract id
  const docFiles = ["projects-boundaries.md", "projects-cross-module-contract.md"].map((f) => path.join(docsDir, f));
  const docText = docFiles.filter((f) => fs.existsSync(f)).map(read).join("\n");
  const missingDocs = docFiles.filter((f) => !fs.existsSync(f)).map(rel);
  if (missingDocs.length) findings.push({ check: "documentation-present", missing: missingDocs });
  else {
    const owners = [...new Set([...manifest.routeOwners.flatMap((r) => [r.owner, r.pepOwner].filter(Boolean)), ...manifest.protectedSymbols.map((s) => s.targetOwner)])];
    const missingOwners = owners.filter((o) => !docText.includes(o));
    const contractIds = [...new Set(manifest.allowedCrossModuleImports.map((a) => a.contract))];
    const missingContracts = contractIds.filter((c) => !docText.includes(c));
    if (missingOwners.length || missingContracts.length) findings.push({ check: "documentation-coverage", missingOwners, missingContracts });
  }

  const scan = {
    routeCounts: counts,
    totalRoutes: Object.values(counts).reduce((a, b) => a + b, 0),
    surfaceSha256: actualHash,
    frozenSurfaceSha256: surfaceHash,
    mountedSpecifiers,
    shadows,
    protectedSymbolOwners: symbolOwners,
    crossModuleImports: importEdges,
    reverseEdges: reverse,
    foreignTableEdges: foreignObserved,
    externalConsumers: externalObserved,
    importCycles: cycles,
    moduleState,
    routeOwnerRows,
  };
  return { findings, notes, scan };
}

// ── self test: prove the detectors can fail ──────────────────────────────────
function selfTest() {
  const problems = [];
  const r = (method, p) => ({ method, path: p });
  const a = findShadows([r("GET", "/x/:id/y"), r("GET", "/x/mine/y")]);
  if (a.length !== 1 || a[0].kind !== "param-shadow") problems.push("param shadow not detected");
  if (findShadows([r("GET", "/x/mine/y"), r("GET", "/x/:id/y")]).length !== 0) problems.push("false positive when literal precedes param");
  if (findShadows([r("GET", "/x/:id"), r("POST", "/x/:id")]).length !== 0) problems.push("false positive across methods");
  if (findShadows([r("GET", "/x/:id"), r("GET", "/x/:id/y")]).length !== 0) problems.push("false positive across segment counts");
  if (findShadows([r("GET", "/x"), r("GET", "/x")])[0]?.kind !== "duplicate-registration") problems.push("duplicate registration not detected");
  const sample = "import { a, type B, c as d } from \"../vault/x\";\n// import { z } from \"../nope\";";
  const stmts = importStatements(sample);
  if (stmts.length !== 1 || stmts[0].symbols.join() !== "a,B,c") problems.push(`import parser wrong: ${JSON.stringify(stmts)}`);
  const acc = tableAccess("db.insert(projectEnrollmentsTable); // FROM project_ratings\nawait db.execute(sql`DELETE FROM user_projects WHERE 1`)", ["projects"]);
  if (acc.get("project_enrollments") !== "write") problems.push("typed write not detected");
  if (acc.get("user_projects") !== "write") problems.push("raw DELETE FROM not classified as write");
  if (acc.has("project_ratings")) problems.push("comment text counted as table access");
  return problems;
}

if (process.argv.includes("--self-test")) {
  const problems = selfTest();
  console.log(problems.length ? `Projects boundary self-test FAILED:\n- ${problems.join("\n- ")}` : "Projects boundary self-test passed (7 detector checks).");
  process.exit(problems.length ? 1 : 0);
}

const { findings, notes, scan } = analyze();
const status = findings.length ? "FAIL" : "PASS";

if (!process.argv.includes("--no-write")) {
  fs.mkdirSync(reportDir, { recursive: true });
  const { routeOwnerRows, ...scanForJson } = scan;
  fs.writeFileSync(path.join(reportDir, `${phaseTag}-dependency-scan.json`), `${JSON.stringify({
    schemaVersion: 1, phase: PHASE, generatedBy: "scripts/antas/projects/validate-boundaries.mjs",
    generatedAt: new Date().toISOString(), status, findings, notes, scan: scanForJson,
  }, null, 2)}\n`);
  if (routeOwnerRows) {
    const header = "route_file,line,method,path,middleware,target_owner,pep_owner";
    const csv = [header, ...routeOwnerRows.map((x) => [x.file, x.line, x.method, x.path, x.middleware, x.owner, x.pepOwner].join(","))].join("\n");
    fs.writeFileSync(path.join(reportDir, `${phaseTag}-route-owner-map.csv`), `${csv}\n`);
  }
}

console.log(`${PHASE} boundary validation: ${status}`);
console.log(`routes scanned: ${scan.totalRoutes ?? "n/a"}; findings: ${findings.length}`);
for (const n of notes) console.log(`note: ${n}`);
for (const f of findings) console.log(`FINDING ${f.check}: ${JSON.stringify(f).slice(0, 600)}`);
process.exit(findings.length ? 1 : 0);
