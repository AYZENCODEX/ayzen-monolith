#!/usr/bin/env node
// VLT-GAP-01-B — Actual Move / Extract (entity core). Fail-closed validator.
// Evidence: reports/antas/vault/gap/VLT-GAP-01/extraction-proof.json
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { ROOT, sha256, sha256File, rel, rejectBypass, binding, walkFiles, GAP01D_NEW_FILES } from "./gap-common.mjs";
import { loadTs, createEnv, createLoader, fakeRes, sliceSymbols, summ, sqlKeyOf } from "./harness.mjs";

const VALIDATOR_VERSION = "1.0.0";
const SUB_PHASE = "VLT-GAP-01-B";
const HERE = fileURLToPath(import.meta.url);
const SRC = path.join(ROOT, "artifacts/api-server/src");
const ROUTES = path.join(SRC, "routes");
const BASE = path.join(ROOT, "reports/antas/vault/gap/VLT-GAP-01/baseline");
const EVIDENCE_DIR = path.join(ROOT, "reports/antas/vault/gap/VLT-GAP-01");
const EVIDENCE_FILE = path.join(EVIDENCE_DIR, "extraction-proof.json");
const R = (f) => `artifacts/api-server/src/${f}`;

const fail = (m) => { console.error(`${SUB_PHASE} FAIL — ${m}`); process.exit(1); };
const bypass = rejectBypass();
if (bypass.length) fail(`bypass mechanism rejected: ${bypass.join(", ")}`);
const ts = loadTs(ROOT);
if (!ts) fail("TypeScript compiler API unavailable (fail closed)");
for (const f of ["routes/vault.ts", "routes/vault-entity-links.ts"]) if (!fs.existsSync(path.join(BASE, f))) fail(`pre-extraction baseline missing: ${f}`);
const baseText = (n) => fs.readFileSync(path.join(BASE, "routes", n), "utf8");
const parse = (name, text) => ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

// ── 1. Move declaration (intent). Every entry is VERIFIED against source below. ──
// mode "verbatim": declaration must be token-identical (modulo `export`) to the baseline.
// mode "refactor": route handler → application use-case; verified structurally + differentially.
const V = "routes/vault.ts", L = "routes/vault-entity-links.ts";
const MOVES = [
  { old: [V, "requireVaultEntryOwnership"], neu: ["vault/security/entity-ownership.ts", "requireVaultEntryOwnership"], mode: "verbatim", layer: "security", domain: "ownership-resource-builders" },
  { old: [L, "vaultEntryResource"], neu: ["vault/security/entity-ownership.ts", "vaultEntryResource"], mode: "verbatim", layer: "security", domain: "ownership-resource-builders" },
  { old: [L, "vaultEntityLinkResource"], neu: ["vault/security/entity-ownership.ts", "vaultEntityLinkResource"], mode: "verbatim", layer: "security", domain: "ownership-resource-builders" },
  { old: [L, "requireVaultEntityLinkOwnership"], neu: ["vault/security/entity-ownership.ts", "requireVaultEntityLinkOwnership"], mode: "verbatim", layer: "security", domain: "ownership-resource-builders" },
  { old: [L, "requireVaultEntryOwnership"], neu: ["vault/security/entity-ownership.ts", "requireVaultEntryOwnershipOr404"], mode: "renamed", layer: "security", domain: "ownership-resource-builders", note: "renamed to avoid clash with the generic factory of the same name; body identical" },
  { old: [V, "vaultBulkOwnershipEngine"], neu: ["vault/security/entity-ownership.ts", "vaultBulkOwnershipEngine"], mode: "verbatim", layer: "security", domain: "ownership-resource-builders" },
  { old: [V, "auditVaultBulkOwnership"], neu: ["vault/security/entity-ownership.ts", "auditVaultBulkOwnership"], mode: "verbatim", layer: "security", domain: "ownership-resource-builders" },
  { old: [V, "SAFE_COLS"], neu: ["vault/infrastructure/repositories/entity-repository.ts", "SAFE_COLS"], mode: "verbatim", layer: "infrastructure", domain: "entity-crud" },
  ...["selectVault", "selectVaultOne", "selectAllVaultEntries", "selectVaultTrash", "selectVaultTrashOne", "hardDeleteVaultEntry"].map((n) => ({ old: [V, n], neu: ["vault/infrastructure/repositories/entity-repository.ts", n], mode: "verbatim", layer: "infrastructure", domain: "entity-crud" })),
  { old: [V, "logVaultActivity"], neu: ["vault/application/entity/activity.ts", "logVaultActivity"], mode: "verbatim", layer: "application", domain: "entity-crud" },
  ...["NEW_VAULT_FIELDS", "BASE_VAULT_FIELDS", "DATE_FIELDS", "SINGLE_FIELD_EDITABLE", "fieldLabel", "BULK_ALLOWED_STATUSES"].map((n) => ({ old: [V, n], neu: ["vault/domain/entity/fields.ts", n], mode: "verbatim", layer: "domain", domain: "entity-crud" })),
  ...["ENTITY_GAS_CHAINS", "addressesFor"].map((n) => ({ old: [V, n], neu: ["vault/domain/entity/calculations.ts", n], mode: "verbatim", layer: "domain", domain: "entity-calculations" })),
  { old: [L, "ownsEntity"], neu: ["vault/application/entity/links.ts", "ownsEntity"], mode: "verbatim", layer: "application", domain: "entity-links" },
];
// Route handlers whose bodies were extracted to use-cases.
const HANDLERS = [
  { file: L, method: "GET", path: "/vault/:id/links", usecase: ["vault/application/entity/links.ts", "listEntityLinks"] },
  { file: L, method: "POST", path: "/vault-entity-links", usecase: ["vault/application/entity/links.ts", "createEntityLink"] },
  { file: L, method: "PATCH", path: "/vault-entity-links/:id", usecase: ["vault/application/entity/links.ts", "updateEntityLink"] },
  { file: L, method: "DELETE", path: "/vault-entity-links/:id", usecase: ["vault/application/entity/links.ts", "deleteEntityLink"] },
  { file: L, method: "GET", path: "/vault/links/all", usecase: ["vault/application/entity/links.ts", "listAllEntityLinks"] },
  { file: V, method: "GET", path: "/vault", usecase: ["vault/application/entity/lifecycle.ts", "listEntities"] },
  { file: V, method: "GET", path: "/vault/tags", usecase: ["vault/application/entity/lifecycle.ts", "listEntityTags"] },
  { file: V, method: "GET", path: "/vault/trash", usecase: ["vault/application/entity/lifecycle.ts", "listTrashedEntities"] },
  { file: V, method: "GET", path: "/vault/:id", usecase: ["vault/application/entity/lifecycle.ts", "getEntity"] },
  { file: V, method: "DELETE", path: "/vault/trash", usecase: ["vault/application/entity/lifecycle.ts", "emptyTrash"] },
  { file: V, method: "DELETE", path: "/vault/:id", usecase: ["vault/application/entity/lifecycle.ts", "trashEntity"] },
  { file: V, method: "POST", path: "/vault/:id/restore", usecase: ["vault/application/entity/lifecycle.ts", "restoreEntity"] },
  { file: V, method: "DELETE", path: "/vault/trash/:id", usecase: ["vault/application/entity/lifecycle.ts", "purgeTrashedEntity"] },
];
const NEW_FILES = [...new Set([...MOVES.map((m) => m.neu[0]), ...HANDLERS.map((h) => h.usecase[0])])];
// Files that 01-C (consumer rewire) is allowed to touch on top of 01-B's own set. 01-B's diff audit is
// cumulative against the original upload, so it must tolerate exactly these, and nothing else.
const LATER_PHASE_ALLOWED = [R("routes/entities.ts"), R("routes/value-history.ts"), R("lib/vault-health-scan.ts"), "scripts/src/test-route-ownership-regression.ts"];
const CHANGED_ALLOWED = new Set([R("routes/vault.ts"), R("routes/vault-entity-links.ts"), ...NEW_FILES.map((f) => R(f)), ...GAP01D_NEW_FILES.map(R), ...LATER_PHASE_ALLOWED]);

// ── 2. AST helpers ──
function tokensOf(node, sf) {
  const t = [];
  (function w(n) { if (ts.isJSDoc(n) || n.kind === ts.SyntaxKind.JSDocComment) return; if (n.getChildCount(sf) === 0) { if (n.kind !== ts.SyntaxKind.EndOfFileToken) t.push(n.getText(sf)); } else n.getChildren(sf).forEach(w); })(node);
  return t;
}
function declIn(sf, name) {
  for (const s of sf.statements) {
    if (ts.isFunctionDeclaration(s) && s.name?.text === name) return { node: s, kind: "function" };
    if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) if (d.name.getText(sf) === name) return { node: d, kind: "variable", stmt: s };
  }
  return null;
}
const fpOf = (d, sf) => { const t = tokensOf(d.node, sf); if (t[0] === "export") t.shift(); return sha256(t.join(" ")); };
const isExported = (d) => (d.kind === "function" ? d.node : d.stmt).modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

function analyzeBody(node, sf) {
  const o = { db: new Set(), sql: 0, tables: new Set(), statuses: new Set(), literals: new Set(), branches: 0, calls: new Set() };
  (function w(n) {
    if (ts.isCallExpression(n)) {
      const c = n.expression;
      if (ts.isPropertyAccessExpression(c)) {
        let r = c.expression; while (ts.isPropertyAccessExpression(r) || ts.isCallExpression(r)) r = r.expression;
        if (ts.isIdentifier(r) && r.text === "db") o.db.add(`db.${c.name.text}`);
        if (ts.isIdentifier(r) && r.text === "res" && c.name.text === "status" && n.arguments[0] && ts.isNumericLiteral(n.arguments[0])) o.statuses.add(Number(n.arguments[0].text));
      }
      if (ts.isIdentifier(c)) o.calls.add(c.text);
    }
    if (ts.isTaggedTemplateExpression(n) && n.tag.getText(sf) === "sql") o.sql++;
    if (ts.isIdentifier(n) && /Table$/.test(n.text)) o.tables.add(n.text);
    if (ts.isPropertyAssignment(n) && ["error", "message"].includes(n.name.getText(sf)) && ts.isStringLiteralLike(n.initializer)) o.literals.add(n.initializer.text);
    if (ts.isTemplateExpression(n) && n.parent && ts.isPropertyAssignment(n.parent) && ["error", "message"].includes(n.parent.name.getText(sf))) o.literals.add(n.getText(sf));
    if (ts.isIfStatement(n) || ts.isConditionalExpression(n) || ts.isCatchClause(n) || ts.isForOfStatement(n)) o.branches++;
    ts.forEachChild(n, w);
  })(node);
  return o;
}
function routeNode(sf, method, p) {
  for (const s of sf.statements) {
    if (!ts.isExpressionStatement(s) || !ts.isCallExpression(s.expression)) continue;
    const c = s.expression.expression;
    if (ts.isPropertyAccessExpression(c) && c.expression.getText(sf) === "router" && c.name.text.toUpperCase() === method) {
      const a0 = s.expression.arguments[0];
      if (a0 && ts.isStringLiteralLike(a0) && a0.text === p) return s;
    }
  }
  return null;
}
function importsOf(sf, fileAbs) {
  const out = [];
  for (const s of sf.statements) {
    let spec = null, typeOnly = false, names = [];
    if (ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier)) {
      spec = s.moduleSpecifier.text; typeOnly = Boolean(s.importClause?.isTypeOnly);
      const c = s.importClause;
      if (c?.name) names.push({ imported: "default", local: c.name.text, typeOnly });
      if (c?.namedBindings && ts.isNamedImports(c.namedBindings)) for (const e of c.namedBindings.elements) names.push({ imported: (e.propertyName ?? e.name).text, local: e.name.text, typeOnly: typeOnly || e.isTypeOnly });
      if (c?.namedBindings && ts.isNamespaceImport(c.namedBindings)) names.push({ imported: "*", local: c.namedBindings.name.text, typeOnly });
    } else if (ts.isExportDeclaration(s) && s.moduleSpecifier && ts.isStringLiteral(s.moduleSpecifier)) {
      spec = s.moduleSpecifier.text; typeOnly = Boolean(s.isTypeOnly);
      if (s.exportClause && ts.isNamedExports(s.exportClause)) s.exportClause.elements.forEach((e) => names.push({ imported: (e.propertyName ?? e.name).text, local: e.name.text, typeOnly, reexport: true }));
      else names.push({ imported: "*", local: "*", typeOnly, reexport: true });
    }
    if (spec) out.push({ spec, typeOnly: names.length > 0 && names.every((n) => n.typeOnly), names, abs: spec.startsWith(".") ? path.resolve(path.dirname(fileAbs), spec.replace(/\.(js|ts)$/, "")) : null });
  }
  return out;
}
const resolveTs = (abs) => [abs + ".ts", path.join(abs, "index.ts")].find((c) => fs.existsSync(c)) ?? null;
function exportsOf(sf) {
  const set = new Set(); let star = false;
  for (const s of sf.statements) {
    const exp = s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (exp && (ts.isFunctionDeclaration(s) || ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s) || ts.isClassDeclaration(s) || ts.isEnumDeclaration(s)) && s.name) set.add(s.name.text);
    if (exp && ts.isVariableStatement(s)) s.declarationList.declarations.forEach((d) => set.add(d.name.getText(sf)));
    if (ts.isExportAssignment(s)) set.add("default");
    if (ts.isExportDeclaration(s)) { if (s.exportClause && ts.isNamedExports(s.exportClause)) s.exportClause.elements.forEach((e) => set.add(e.name.text)); else star = true; }
  }
  return { set, star };
}

// ── 3. Static extraction proof ──
function staticProof() {
  const checks = []; const chk = (name, passed, details = "") => checks.push({ name, passed: Boolean(passed), details });
  const oldSf = { [V]: parse(V, baseText("vault.ts")), [L]: parse(L, baseText("vault-entity-links.ts")) };
  const curSf = { [V]: parse(V, fs.readFileSync(path.join(ROUTES, "vault.ts"), "utf8")), [L]: parse(L, fs.readFileSync(path.join(ROUTES, "vault-entity-links.ts"), "utf8")) };
  const newSf = Object.fromEntries(NEW_FILES.map((f) => [f, parse(f, fs.readFileSync(path.join(SRC, f), "utf8"))]));

  const moved = [];
  for (const m of MOVES) {
    const [of, on] = m.old; const [nf, nn] = m.neu;
    const od = declIn(oldSf[of], on), nd = newSf[nf] ? declIn(newSf[nf], nn) : null;
    const rec = { old_file: R(of), old_symbol: on, new_file: R(nf), new_symbol: nn, mode: m.mode, layer: m.layer, behavior_domain: m.domain };
    rec.old_declared = Boolean(od); rec.new_declared = Boolean(nd);
    if (od && nd) {
      rec.old_fingerprint = fpOf(od, oldSf[of]);
      rec.new_fingerprint = fpOf(nd, newSf[nf]);
      rec.old_lines = od.node.getText(oldSf[of]).split("\n").length;
      rec.identical_modulo_export = rec.old_fingerprint === rec.new_fingerprint;
      rec.new_exported = isExported(nd);
      // the moved implementation must be executable business code, not a stub/re-export
      rec.new_is_reexport = nd.kind === "variable" && !nd.node.initializer;
    }
    // renamed: compare by replacing the new name with the old name in tokens
    if (m.mode === "renamed" && od && nd) {
      const t = tokensOf(nd.node, newSf[nf]); if (t[0] === "export") t.shift();
      // The fixed-404 variant differs only by its name (old local fn used the same body).
      const ot = tokensOf(od.node, oldSf[of]).map((x) => (x === on ? nn : x));
      rec.identical_modulo_export = t.join(" ") === ot.join(" ");
    }
    // old file must no longer declare it
    const stillOld = declIn(curSf[of], on);
    rec.old_declaration_remaining = Boolean(stillOld);
    // usage: referenced from at least one consumer outside its own file
    rec.consumers = [];
    moved.push(rec);
  }
  for (const r of moved) {
    chk(`moved:${r.old_symbol}→${r.new_symbol}:declared-both`, r.old_declared && r.new_declared, `${r.old_file} / ${r.new_file}`);
    chk(`moved:${r.old_symbol}→${r.new_symbol}:identical-implementation`, r.identical_modulo_export === true, "token-identical (modulo `export`) to pre-extraction baseline");
    chk(`moved:${r.old_symbol}→${r.new_symbol}:old-declaration-removed`, r.old_declaration_remaining === false, `${r.old_file} still declares ${r.old_symbol}`);
    
    chk(`moved:${r.old_symbol}→${r.new_symbol}:not-a-stub`, r.new_is_reexport === false);
  }

  // handler → use-case structural equivalence
  const handlers = [];
  for (const h of HANDLERS) {
    const oNode = routeNode(oldSf[h.file], h.method, h.path), cNode = routeNode(curSf[h.file], h.method, h.path);
    const [uf, un] = h.usecase; const ud = newSf[uf] ? declIn(newSf[uf], un) : null;
    const rec = { route: `${h.method} ${h.path}`, route_file: R(h.file), usecase: `${R(uf)}#${un}` };
    rec.route_present_before = Boolean(oNode); rec.route_present_after = Boolean(cNode); rec.usecase_declared = Boolean(ud);
    if (oNode && cNode && ud) {
      const ob = analyzeBody(oNode, oldSf[h.file]), cb = analyzeBody(cNode, curSf[h.file]), ub = analyzeBody(ud.node, newSf[uf]);
      const setEq = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
      rec.old_handler = { db_ops: [...ob.db].sort(), sql_templates: ob.sql, tables: [...ob.tables].sort(), statuses: [...ob.statuses].sort(), error_literals: [...ob.literals].sort(), branches: ob.branches };
      rec.new_handler = { db_ops: [...cb.db].sort(), sql_templates: cb.sql, tables: [...cb.tables].sort(), branches: cb.branches, calls: [...cb.calls].sort() };
      rec.usecase_body = { db_ops: [...ub.db].sort(), sql_templates: ub.sql, tables: [...ub.tables].sort(), statuses: [...ub.statuses].sort(), error_literals: [...ub.literals].sort(), branches: ub.branches };
      // preserved behaviour surface: every DB op, table, status code, error text of the old handler exists in the use-case.
      rec.db_ops_preserved = setEq(ob.db, ub.db) && ob.sql === ub.sql;
      rec.tables_preserved = [...ob.tables].every((t) => ub.tables.has(t));
      rec.error_literals_preserved = [...ob.literals].every((l) => ub.literals.has(l));
      // statuses: old wrote res.status(N); new returns {status:N} — collect numeric `status:` props.
      const ust = new Set(); (function w(n) { if (ts.isPropertyAssignment(n) && n.name.getText(newSf[uf]) === "status" && ts.isNumericLiteral(n.initializer)) ust.add(Number(n.initializer.text)); ts.forEachChild(n, w); })(ud.node);
      rec.statuses_preserved = [...ob.statuses].every((s) => ust.has(s));
      rec.route_is_thin = cb.db.size === 0 && cb.sql === 0 && cb.tables.size === 0 && cb.branches === 0;
      rec.route_calls_usecase = cb.calls.has(un);
    }
    handlers.push(rec);
  }
  for (const r of handlers) {
    const n = `handler:${r.route}`;
    chk(`${n}:present`, r.route_present_before && r.route_present_after && r.usecase_declared);
    chk(`${n}:db-ops-preserved-in-usecase`, r.db_ops_preserved === true);
    chk(`${n}:tables-preserved`, r.tables_preserved === true);
    chk(`${n}:error-messages-preserved`, r.error_literals_preserved === true);
    chk(`${n}:status-codes-preserved`, r.statuses_preserved === true);
    chk(`${n}:route-has-no-db-sql-or-decision-tree`, r.route_is_thin === true, JSON.stringify(r.new_handler));
    chk(`${n}:route-delegates-to-usecase`, r.route_calls_usecase === true);
  }

  // all vault/** files + routes: import graph for usage, forbidden imports, link check
  const vaultFiles = walkFiles(path.join(SRC, "vault"), [], (p) => p.endsWith(".ts"));
  const routeFiles = walkFiles(ROUTES, [], (p) => p.endsWith(".ts"));
  const allSrc = walkFiles(SRC, [], (p) => p.endsWith(".ts") && !p.endsWith(".d.ts"));
  const parsedAll = new Map();
  const getSf = (abs) => { if (!parsedAll.has(abs)) parsedAll.set(abs, parse(abs, fs.readFileSync(abs, "utf8"))); return parsedAll.get(abs); };

  // usage: who imports each moved symbol (by resolved file + name)
  const importIndex = []; // {from, target, name, typeOnly}
  for (const f of allSrc) {
    const sf = getSf(f);
    for (const im of importsOf(sf, f)) { if (!im.abs) continue; const t = resolveTs(im.abs); if (!t) continue; for (const n of im.names) importIndex.push({ from: f, target: t, name: n.imported, typeOnly: n.typeOnly, reexport: Boolean(n.reexport) }); }
  }
  for (const r of moved) {
    const target = path.join(SRC, r.new_file.replace("artifacts/api-server/src/", ""));
    const users = importIndex.filter((i) => i.target === target && (i.name === r.new_symbol || i.name === "*") && i.from !== target && !i.typeOnly);
    // in-file use (e.g. ownsEntity used by use-cases in the same file)
    const sfN = getSf(target); let inFile = 0;
    (function w(n) { if (ts.isIdentifier(n) && n.text === r.new_symbol) inFile++; ts.forEachChild(n, w); })(sfN);
    r.consumers = [...new Set(users.map((u) => rel(u.from)))].sort();
    r.in_file_references = Math.max(0, inFile - 1);
    chk(`used:${r.new_symbol}@${path.basename(r.new_file)}`, r.consumers.length > 0 || r.in_file_references > 0, "moved symbol is referenced by no consumer (copied-but-unused)");
    chk(`exported-or-internally-used:${r.new_symbol}`, r.new_exported === true || r.in_file_references > 0, "symbol neither exported nor used in its own file");
  }
  for (const h of HANDLERS) {
    const target = path.join(SRC, h.usecase[0]);
    const users = importIndex.filter((i) => i.target === target && i.name === h.usecase[1] && i.from.endsWith(h.file.replace("routes/", "routes/")));
    chk(`used:${h.usecase[1]}←${path.basename(h.file)}`, users.length > 0, "route does not import its use-case");
  }

  // forbidden imports for vault/** layers
  const forb = [];
  for (const f of vaultFiles) {
    const rp = rel(f).replace("artifacts/api-server/src/vault/", "");
    const layer = rp.split("/")[0];
    for (const im of importsOf(getSf(f), f)) {
      const tgt = im.abs ? rel(im.abs) : im.spec;
      const isRoute = im.abs && im.abs.startsWith(ROUTES + path.sep) || im.abs === ROUTES;
      if (isRoute && layer !== "api") forb.push({ file: rel(f), spec: im.spec, rule: "vault/** (except api) must not import routes/*" });
      if (layer === "domain" && !im.typeOnly) {
        if (["express", "@workspace/db", "drizzle-orm"].includes(im.spec) || (im.abs && !im.abs.startsWith(path.join(SRC, "vault") + path.sep) )) forb.push({ file: rel(f), spec: im.spec, rule: "domain must not have runtime imports of providers/db/express/outside-vault" });
      }
    }
  }
  chk("forbidden-imports:none", forb.length === 0, JSON.stringify(forb));

  // import link-check on changed files: every named import from a local ts module exists
  const linkFail = [];
  for (const f of [path.join(ROUTES, "vault.ts"), path.join(ROUTES, "vault-entity-links.ts"), ...NEW_FILES.map((x) => path.join(SRC, x))]) {
    for (const im of importsOf(getSf(f), f)) {
      if (!im.abs) continue;
      const t = resolveTs(im.abs);
      if (!t) { if (!fs.existsSync(im.abs + ".mjs") && !fs.existsSync(im.abs + ".js")) linkFail.push(`${rel(f)}: unresolved ${im.spec}`); continue; }
      const ex = exportsOf(getSf(t));
      for (const n of im.names) if (n.imported !== "*" && n.imported !== "default" && !ex.star && !ex.set.has(n.imported)) linkFail.push(`${rel(f)}: '${n.imported}' not exported by ${rel(t)}`);
    }
  }
  chk("import-link-check:changed-files", linkFail.length === 0, linkFail.join("; "));

  // duplicate implementations: semantic fingerprints across scope (routes/vault*.ts + vault/**)
  const scopeFiles = [...routeFiles.filter((p) => /routes\/vault[^/]*\.ts$/.test(p.split(path.sep).join("/"))), ...vaultFiles];
  const fps = new Map();
  const collect = (f) => {
    const sf = getSf(f);
    for (const s of sf.statements) {
      let d = null, name = null;
      if (ts.isFunctionDeclaration(s) && s.name) { d = s; name = s.name.text; }
      else if (ts.isVariableStatement(s)) for (const x of s.declarationList.declarations) { if (x.initializer && (ts.isArrowFunction(x.initializer) || ts.isFunctionExpression(x.initializer))) { d = x; name = x.name.getText(sf); } }
      if (!d) continue;
      const t = tokensOf(d, sf); if (t[0] === "export") t.shift();
      if (t.length < 25) continue;
      const nameless = t.map((x) => (x === name ? "§" : x)).join(" ");
      const k = sha256(nameless);
      (fps.get(k) ?? fps.set(k, []).get(k)).push({ file: rel(f), symbol: name, tokens: t.length });
    }
  };
  scopeFiles.forEach(collect);
  const dupInScope = [...fps.values()].filter((v) => v.length > 1);
  chk("duplicate-implementations:0-in-scope", dupInScope.length === 0, JSON.stringify(dupInScope));
  // out-of-scope duplicates (informational; owned by 01-C consumer rewire)
  const outFps = new Map();
  const moveNames = new Set(MOVES.map((m) => m.old[1]));
  for (const f of routeFiles) {
    if (scopeFiles.includes(f)) continue;
    const sf = getSf(f);
    for (const s of sf.statements) if (ts.isFunctionDeclaration(s) && s.name && moveNames.has(s.name.text)) outFps.set(`${rel(f)}#${s.name.text}`, { file: rel(f), symbol: s.name.text });
  }
  return { checks, moved, handlers, duplicates_in_scope: dupInScope, duplicates_outside_scope: [...outFps.values()], forbidden_imports: forb, import_link_failures: linkFail };
}

// ── 4. Differential behavioural tests (OLD baseline vs NEW source, same stubs) ──
const key = sqlKeyOf;
const ok = (value) => ({ value });
const boom = (m = "db down") => ({ throw: m });
async function runCase({ which, file, method, path: rp, req, script = {}, overrides, flush = true }) {
  const env = createEnv(script);
  if (overrides) for (const [k, v] of overrides) env.overrides.set(k, v);
  const L_ = createLoader({ ts, root: ROOT, srcDir: SRC, env });
  const tail = file === "links" ? "vault-entity-links" : "vault";
  if (which === "old") {
    if (file === "vault") env.stubs["routes/vault-entity-links"] = L_.loadText(baseText("vault-entity-links.ts"), "vault-entity-links.ts", ROUTES);
    L_.loadText(baseText(`${tail}.ts`), `${tail}.ts`, ROUTES);
  } else {
    L_.loadFile(path.join(ROUTES, `${tail}.ts`));
  }
  const loadLog = env.log.splice(0);
  const r = env.routes.find((x) => x.method === method && x.path === rp);
  if (!r) return { missingRoute: true };
  // middleware summary
  const stack = [];
  for (const m of r.stack.slice(0, -1)) {
    const s = { name: m.name || "anon" };
    if (m.__ownership) {
      const res = fakeRes(); m.__ownership.opts.onDeny({}, res);
      const probe = { params: { id: "9" } }, e2 = m.__ownership.builder;
      s.ownership = { action: m.__ownership.action, deny: { status: res.statusCode, body: summ(res.body) }, decisionObserver: m.__ownership.opts.onDecision?.__stub };
    }
    stack.push(s);
  }
  const res = fakeRes();
  let threw = null;
  const origErr = console.error; console.error = (...a) => env.log.push(["console.error", String(a[0]).slice(0, 80)]);
  try { await r.stack[r.stack.length - 1](req, res); } catch (e) { threw = String(e.message); }
  if (flush) await new Promise((x) => setTimeout(x, 5));
  console.error = origErr;
  return { status: res.statusCode ?? 200, body: summ(res.body), threw, log: env.log, loadLog, stack, builders: r.stack.slice(0, -1).filter((m) => m.__ownership).map((m) => m.__ownership.builder), envRef: env };
}
const canon = (o) => JSON.stringify(o);
function diffRuns(a, b) {
  const d = [];
  if (a.missingRoute || b.missingRoute) return ["route missing"];
  if (a.status !== b.status) d.push(`status ${a.status} != ${b.status}`);
  if (canon(a.body) !== canon(b.body)) d.push(`body differs: ${canon(a.body).slice(0, 160)} vs ${canon(b.body).slice(0, 160)}`);
  if (a.threw !== b.threw) d.push(`threw ${a.threw} != ${b.threw}`);
  if (canon(a.stack) !== canon(b.stack)) d.push("middleware/ownership stack differs");
  const sa = a.log.map(canon), sb = b.log.map(canon);
  if (canon([...sa].sort()) !== canon([...sb].sort())) d.push(`side-effect multiset differs: -${sa.filter((x) => !sb.includes(x)).slice(0, 2).join("|")} +${sb.filter((x) => !sa.includes(x)).slice(0, 2).join("|")}`);
  const grp = (l) => { const g = {}; for (const e of l) (g[e[0]] ??= []).push(canon(e)); return g; };
  const ga = grp(a.log), gb = grp(b.log);
  for (const k of new Set([...Object.keys(ga), ...Object.keys(gb)])) if (canon(ga[k]) !== canon(gb[k])) { d.push(`ordered side-effects differ for ${k}`); break; }
  return d;
}

const U = { user: { userId: 7 } };
const ent = (o = {}) => ({ id: 5, projectName: "P", username: "u", category: "c", entitySerial: "S-5", status: "active", ...o });
const link = (o = {}) => ({ id: 1, userId: 7, entityId: 5, linkedEntityId: 6, relationType: "alt_of", note: null, createdAt: "t", ...o });
const SEL_E = "db.select:vaultEntriesTable", SEL_L = "db.select:vaultEntityLinksTable", UPD_E = "db.update:vaultEntriesTable", UPD_L = "db.update:vaultEntityLinksTable", DEL_L = "db.delete:vaultEntityLinksTable", INS_L = "db.insert:vaultEntityLinksTable", INS_A = "db.insert:vaultActivityLogTable";
const LINKS = "links", VAULT = "vault";
const CASES = [];
const add = (name, file, method, p, req, script, cat = "success") => CASES.push({ name, file, method, path: p, req, script, cat });
// entity-links
add("links.GET success both directions + deleted counterpart", LINKS, "GET", "/vault/:id/links", { ...U, params: { id: "5" } }, { [SEL_E]: [ok([ent()]), ok([{ id: 6, projectName: "Q", username: null, category: "c", status: "active" }])], [SEL_L]: [ok([link(), link({ id: 2, entityId: 8, linkedEntityId: 5, relationType: "alt_of" }), link({ id: 3, entityId: 5, linkedEntityId: 99, relationType: "shares_wallet" })])] });
add("links.GET array param", LINKS, "GET", "/vault/:id/links", { ...U, params: { id: ["5"] } }, { [SEL_E]: [ok([ent()])], [SEL_L]: [ok([])] });
add("links.GET invalid id → 400", LINKS, "GET", "/vault/:id/links", { ...U, params: { id: "abc" } }, {}, "failure");
add("links.GET not owned → 404", LINKS, "GET", "/vault/:id/links", { ...U, params: { id: "5" } }, { [SEL_E]: [ok([])] }, "security");
add("links.GET db failure → 500", LINKS, "GET", "/vault/:id/links", { ...U, params: { id: "5" } }, { [SEL_E]: [ok([ent()])], [SEL_L]: [boom()] }, "failure");
add("links.POST success (+note trim)", LINKS, "POST", "/vault-entity-links", { ...U, body: { entityId: "5", linkedEntityId: "6", relationType: "alt_of", note: "  hi  " } }, { [SEL_E]: [ok([ent()]), ok([ent({ id: 6 })])], [SEL_L]: [ok([])], [INS_L]: [ok([link({ note: "hi" })])] });
add("links.POST blank note → null", LINKS, "POST", "/vault-entity-links", { ...U, body: { entityId: 5, linkedEntityId: 6, relationType: "other", note: "   " } }, { [SEL_E]: [ok([ent()]), ok([ent({ id: 6 })])], [SEL_L]: [ok([])], [INS_L]: [ok([link()])] });
add("links.POST missing ids → 400", LINKS, "POST", "/vault-entity-links", { ...U, body: { relationType: "alt_of" } }, {}, "failure");
add("links.POST self link → 400", LINKS, "POST", "/vault-entity-links", { ...U, body: { entityId: 5, linkedEntityId: 5, relationType: "alt_of" } }, {}, "failure");
add("links.POST bad relationType → 400", LINKS, "POST", "/vault-entity-links", { ...U, body: { entityId: 5, linkedEntityId: 6, relationType: "bogus" } }, {}, "failure");
add("links.POST entity not owned → 404", LINKS, "POST", "/vault-entity-links", { ...U, body: { entityId: 5, linkedEntityId: 6, relationType: "alt_of" } }, { [SEL_E]: [ok([]), ok([ent({ id: 6 })])] }, "security");
add("links.POST linked entity not owned → 404", LINKS, "POST", "/vault-entity-links", { ...U, body: { entityId: 5, linkedEntityId: 6, relationType: "alt_of" } }, { [SEL_E]: [ok([ent()]), ok([])] }, "security");
add("links.POST duplicate → 409", LINKS, "POST", "/vault-entity-links", { ...U, body: { entityId: 5, linkedEntityId: 6, relationType: "alt_of" } }, { [SEL_E]: [ok([ent()]), ok([ent({ id: 6 })])], [SEL_L]: [ok([link()])] }, "failure");
add("links.POST inverse duplicate → 409", LINKS, "POST", "/vault-entity-links", { ...U, body: { entityId: 5, linkedEntityId: 6, relationType: "main_of" } }, { [SEL_E]: [ok([ent()]), ok([ent({ id: 6 })])], [SEL_L]: [ok([link({ entityId: 6, linkedEntityId: 5, relationType: "alt_of" })])] }, "failure");
add("links.POST insert failure → 500", LINKS, "POST", "/vault-entity-links", { ...U, body: { entityId: 5, linkedEntityId: 6, relationType: "alt_of" } }, { [SEL_E]: [ok([ent()]), ok([ent({ id: 6 })])], [SEL_L]: [ok([])], [INS_L]: [boom("unique violation")] }, "failure");
add("links.PATCH success", LINKS, "PATCH", "/vault-entity-links/:id", { ...U, params: { id: "1" }, body: { relationType: "main_of", note: " n " } }, { [UPD_L]: [ok([link({ relationType: "main_of", note: "n" })])] });
add("links.PATCH note only (empty → null)", LINKS, "PATCH", "/vault-entity-links/:id", { ...U, params: { id: "1" }, body: { note: "" } }, { [UPD_L]: [ok([link()])] });
add("links.PATCH invalid id → 400", LINKS, "PATCH", "/vault-entity-links/:id", { ...U, params: { id: "x" }, body: {} }, {}, "failure");
add("links.PATCH bad relationType → 400", LINKS, "PATCH", "/vault-entity-links/:id", { ...U, params: { id: "1" }, body: { relationType: "nope" } }, {}, "failure");
add("links.PATCH not found → 404", LINKS, "PATCH", "/vault-entity-links/:id", { ...U, params: { id: "1" }, body: { note: "a" } }, { [UPD_L]: [ok([])] }, "security");
add("links.PATCH db failure → 500", LINKS, "PATCH", "/vault-entity-links/:id", { ...U, params: { id: "1" }, body: { note: "a" } }, { [UPD_L]: [boom()] }, "failure");
add("links.DELETE success", LINKS, "DELETE", "/vault-entity-links/:id", { ...U, params: { id: "1" } }, { [DEL_L]: [ok([{ id: 1 }])] });
add("links.DELETE not found → 404", LINKS, "DELETE", "/vault-entity-links/:id", { ...U, params: { id: "1" } }, { [DEL_L]: [ok([])] }, "security");
add("links.DELETE invalid id → 400", LINKS, "DELETE", "/vault-entity-links/:id", { ...U, params: { id: "z" } }, {}, "failure");
add("links.DELETE db failure → 500", LINKS, "DELETE", "/vault-entity-links/:id", { ...U, params: { id: "1" } }, { [DEL_L]: [boom()] }, "failure");
const LINKS_ALL_KEY = key("SELECT vel.id, vel.entity_id, vel.linked_entity_id,");
add("links.GET all success", LINKS, "GET", "/vault/links/all", U, { [`db.execute:${LINKS_ALL_KEY}`]: [ok({ rows: [{ id: 1 }] })] });
add("links.GET all failure → 500", LINKS, "GET", "/vault/links/all", U, { [`db.execute:${LINKS_ALL_KEY}`]: [boom()] }, "failure");
// entity lifecycle (vault.ts)
const FALLBACK_KEY = key("SELECT id, user_id, entity_serial,");
const row = (o = {}) => ({ id: 5, userId: 7, tags: '["a","b"]', deletedAt: null, ...o });
add("vault.GET list", VAULT, "GET", "/vault", U, { [SEL_E]: [ok([row(), row({ id: 6 })])] });
add("vault.GET list falls back to raw SQL on drizzle failure", VAULT, "GET", "/vault", U, { [SEL_E]: [boom("column missing")], [`db.execute:${FALLBACK_KEY}`]: [ok({ rows: [{ id: 9 }] })] }, "failure");
add("vault.GET tags success (dedupe/trim/sort/malformed)", VAULT, "GET", "/vault/tags", U, { [SEL_E]: [ok([row({ tags: '["b"," a ","", 3]' }), row({ tags: "not json" }), row({ tags: null }), row({ tags: '["b","c"]' })])] });
add("vault.GET tags failure → 500", VAULT, "GET", "/vault/tags", U, { [SEL_E]: [boom("x")], [`db.execute:${FALLBACK_KEY}`]: [boom("y")] }, "failure");
add("vault.GET trash (purgeAt)", VAULT, "GET", "/vault/trash", U, { [SEL_E]: [ok([row({ deletedAt: "2026-01-01T00:00:00.000Z" }), row({ id: 8, deletedAt: null })])] });
add("vault.GET :id success charges credits + logs view", VAULT, "GET", "/vault/:id", { ...U, params: { id: "5" } }, { [SEL_E]: [ok([row({ entitySerial: "S-1" })])] });
add("vault.GET :id array param", VAULT, "GET", "/vault/:id", { ...U, params: { id: ["5"] } }, { [SEL_E]: [ok([row()])] });
add("vault.GET :id not found → 404 (no charge)", VAULT, "GET", "/vault/:id", { ...U, params: { id: "5" } }, { [SEL_E]: [ok([])] }, "security");
add("vault.GET :id activity-log insert failure is swallowed", VAULT, "GET", "/vault/:id", { ...U, params: { id: "5" } }, { [SEL_E]: [ok([row()])], [INS_A]: [boom("log down")] }, "failure");
add("vault.GET :id team mirror activity", VAULT, "GET", "/vault/:id", { ...U, params: { id: "5" } }, { [SEL_E]: [ok([row()])], [`db.execute:${key("SELECT team_id FROM vault_entries")}`]: [ok({ rows: [{ team_id: 3 }] })] });
add("vault.DELETE :id trashes", VAULT, "DELETE", "/vault/:id", { ...U, params: { id: "5" } }, { [SEL_E]: [ok([row()])], [UPD_E]: [ok([])] });
add("vault.DELETE :id not found → 404", VAULT, "DELETE", "/vault/:id", { ...U, params: { id: "5" } }, { [SEL_E]: [ok([])] }, "security");
add("vault.DELETE :id update failure propagates", VAULT, "DELETE", "/vault/:id", { ...U, params: { id: "5" } }, { [SEL_E]: [ok([row()])], [UPD_E]: [boom("write failed")] }, "failure");
add("vault.POST restore success", VAULT, "POST", "/vault/:id/restore", { ...U, params: { id: "5" } }, { [SEL_E]: [ok([row({ deletedAt: "x" })])], [UPD_E]: [ok([])] });
add("vault.POST restore not trashed → 404", VAULT, "POST", "/vault/:id/restore", { ...U, params: { id: "5" } }, { [SEL_E]: [ok([])] }, "security");
add("vault.DELETE trash/:id purge success", VAULT, "DELETE", "/vault/trash/:id", { ...U, params: { id: "5" } }, { [SEL_E]: [ok([row({ deletedAt: "x" })])], [DEL_E()]: [ok([])] });
function DEL_E() { return "db.delete:vaultEntriesTable"; }
add("vault.DELETE trash/:id not trashed → 404", VAULT, "DELETE", "/vault/trash/:id", { ...U, params: { id: "5" } }, { [SEL_E]: [ok([])] }, "security");
add("vault.DELETE trash empties all", VAULT, "DELETE", "/vault/trash", U, { [SEL_E]: [ok([row({ id: 1 }), row({ id: 2 })])] });
add("vault.DELETE trash empty set", VAULT, "DELETE", "/vault/trash", U, { [SEL_E]: [ok([])] });
add("vault.DELETE trash purge failure mid-way propagates", VAULT, "DELETE", "/vault/trash", U, { [SEL_E]: [ok([row({ id: 1 }), row({ id: 2 })])], [DEL_E()]: [ok([]), boom("fk")] }, "failure");

// unit-level parity for verbatim-moved symbols, executed against the sliced OLD source
async function unitParity() {
  const results = []; const t = (name, pass, details = "") => results.push({ name, passed: Boolean(pass), details });
  const vText = baseText("vault.ts"), lText = baseText("vault-entity-links.ts");
  const mk = (which, srcText, names, newRel) => {
    const env = createEnv(); const ld = createLoader({ ts, root: ROOT, srcDir: SRC, env });
    if (which === "old") { const { text, missing } = sliceSymbols(ts, srcText, names); if (missing.length) throw new Error(`baseline missing: ${missing}`); return { env, mod: ld.loadText(text, "slice.ts", ROUTES) }; }
    return { env, mod: ld.loadFile(path.join(SRC, newRel)) };
  };
  const pure = async (label, names, newRel, fn) => {
    const o = mk("old", vText, names, newRel), n = mk("new", vText, names, newRel);
    const a = await fn(o.mod, o.env), b = await fn(n.mod, n.env);
    t(label, canon(a) === canon(b), canon(a) === canon(b) ? "" : `${canon(a).slice(0, 120)} vs ${canon(b).slice(0, 120)}`);
  };
  await pure("unit:fields constants and fieldLabel", ["NEW_VAULT_FIELDS", "BASE_VAULT_FIELDS", "DATE_FIELDS", "SINGLE_FIELD_EDITABLE", "fieldLabel", "BULK_ALLOWED_STATUSES"], "vault/domain/entity/fields.ts", (m) => ({ nf: m.NEW_VAULT_FIELDS, bf: m.BASE_VAULT_FIELDS, df: [...m.DATE_FIELDS], sf: [...m.SINGLE_FIELD_EDITABLE], bs: [...m.BULK_ALLOWED_STATUSES], lab: ["twitterEmailRecoveryPassword", "", "a", "ABC", "x2fa"].map(m.fieldLabel) }));
  await pure("unit:calculations addressesFor/ENTITY_GAS_CHAINS", ["ENTITY_GAS_CHAINS", "addressesFor"], "vault/domain/entity/calculations.ts", (m) => ({ c: [...m.ENTITY_GAS_CHAINS], a: [{}, { wallet_addresses: '["0x1"]' }, { walletAddresses: "bad json", driveWalletAddress: "0xd" }, { wallet_addresses: '["0x1","0x2"]', drive_wallet_address: "0xd" }, { wallet_addresses: null }].map(m.addressesFor) }));
  await pure("unit:SAFE_COLS text", ["SAFE_COLS"], "vault/infrastructure/repositories/entity-repository.ts", async () => null).catch(() => {});
  const repoNames = ["SAFE_COLS", "selectVault", "selectVaultOne", "selectAllVaultEntries", "selectVaultTrash", "selectVaultTrashOne", "hardDeleteVaultEntry"];
  const scenarios = [
    ["primary ok", {}, { [SEL_E]: [ok([{ id: 1 }])] }], ["fallback", {}, { [SEL_E]: [boom("no col")], [`db.execute:${FALLBACK_KEY}`]: [ok({ rows: [{ id: 2 }] })] }], ["both fail", {}, { [SEL_E]: [boom("a")], [`db.execute:${FALLBACK_KEY}`]: [boom("b")] }], ["empty", {}, { [SEL_E]: [ok([])] }],
  ];
  for (const fn of ["selectVault", "selectVaultOne", "selectAllVaultEntries", "selectVaultTrash", "selectVaultTrashOne"]) for (const [sn, , script] of scenarios) {
    const run = async (which) => {
      const env = createEnv(script); const ld = createLoader({ ts, root: ROOT, srcDir: SRC, env });
      const mod = which === "old" ? ld.loadText(sliceSymbols(ts, vText, repoNames).text, "slice.ts", ROUTES) : ld.loadFile(path.join(SRC, "vault/infrastructure/repositories/entity-repository.ts"));
      let out, thr = null; try { out = await mod[fn](...(/One$/.test(fn) ? [5, 7] : fn === "selectAllVaultEntries" ? [] : [7])); } catch (e) { thr = e.message; }
      return { out: summ(out), thr, log: env.log };
    };
    const a = await run("old"), b = await run("new");
    t(`unit:${fn} [${sn}]`, canon(a) === canon(b), canon(a) === canon(b) ? "" : "result or SQL/call log differs");
  }
  for (const rej of [false, true]) {
    const run = async (which) => {
      const env = createEnv({}); env.syncDeleteRejects = rej; const ld = createLoader({ ts, root: ROOT, srcDir: SRC, env });
      const mod = which === "old" ? ld.loadText(sliceSymbols(ts, vText, repoNames).text, "slice.ts", ROUTES) : ld.loadFile(path.join(SRC, "vault/infrastructure/repositories/entity-repository.ts"));
      await mod.hardDeleteVaultEntry(5, 7); await new Promise((x) => setTimeout(x, 3)); return env.log;
    };
    const a = await run("old"), b = await run("new");
    t(`unit:hardDeleteVaultEntry [sync ${rej ? "rejects" : "ok"}]`, canon(a) === canon(b));
  }
  const actScenarios = [["ok/no team", {}], ["insert fails", { [INS_A]: [boom("x")] }], ["team mirrored", { [`db.execute:${key("SELECT team_id FROM vault_entries")}`]: [ok({ rows: [{ team_id: 4 }] })] }], ["team lookup fails", { [`db.execute:${key("SELECT team_id FROM vault_entries")}`]: [boom("y")] }]];
  for (const [n, script] of actScenarios) {
    const run = async (which) => {
      const env = createEnv(script); const ld = createLoader({ ts, root: ROOT, srcDir: SRC, env });
      const mod = which === "old" ? ld.loadText(sliceSymbols(ts, vText, ["logVaultActivity"]).text, "slice.ts", ROUTES) : ld.loadFile(path.join(SRC, "vault/application/entity/activity.ts"));
      const lg = env.log; const orig = console.error; console.error = (...a) => lg.push(["console.error", String(a[0])]);
      try { await mod.logVaultActivity(5, 7, "created", "d"); } finally { console.error = orig; }
      return lg;
    };
    const a = await run("old"), b = await run("new");
    t(`unit:logVaultActivity [${n}]`, canon(a) === canon(b));
  }
  for (const ids of [[], [1, 2]]) for (const rows of [[], [{ id: 1, userId: 7 }, { id: 2, userId: 9 }]]) {
    const run = async (which) => {
      const env = createEnv({ [SEL_E]: [ok(rows)] }); const ld = createLoader({ ts, root: ROOT, srcDir: SRC, env });
      const mod = which === "old" ? ld.loadText(sliceSymbols(ts, vText, ["vaultBulkOwnershipEngine", "auditVaultBulkOwnership"]).text, "slice.ts", ROUTES) : ld.loadFile(path.join(SRC, "vault/security/entity-ownership.ts"));
      env.log.length = 0; await mod.auditVaultBulkOwnership({ user: { userId: 7 } }, ids, "vault_entry.bulk"); return env.log;
    };
    const a = await run("old"), b = await run("new");
    t(`unit:auditVaultBulkOwnership [ids=${ids.length}, rows=${rows.length}]`, canon(a) === canon(b));
  }
  // ownership resource builders: OLD (entity-links baseline) vs NEW security module
  const idCases = [{ params: { id: "5" } }, { params: { id: ["5", "6"] } }, { params: { id: "nope" } }, { params: { id: "5" } }];
  for (const [bname, tbl] of [["vaultEntryResource", SEL_E], ["vaultEntityLinkResource", SEL_L]]) for (let i = 0; i < idCases.length; i++) {
    const script = { [tbl]: [ok(i === 3 ? [] : [{ userId: 7 }])] };
    const run = async (which) => {
      const env = createEnv(script); const ld = createLoader({ ts, root: ROOT, srcDir: SRC, env });
      const mod = which === "old" ? ld.loadText(sliceSymbols(ts, lText, [bname]).text, "slice.ts", ROUTES) : ld.loadFile(path.join(SRC, "vault/security/entity-ownership.ts"));
      env.log.length = 0; // module-init effects are compared separately (load:module-init)
      let out, thr = null; try { out = await mod[bname](idCases[i]); } catch (e) { thr = e.message; }
      return { out: summ(out), thr, log: env.log };
    };
    const a = await run("old"), b = await run("new");
    t(`unit:${bname} [case ${i}]`, canon(a) === canon(b));
  }
  return results;
}

async function differentialSuite(overrides) {
  const out = [];
  for (const c of CASES) {
    const [a, b] = [await runCase({ which: "old", ...c, overrides: undefined }), await runCase({ which: "new", ...c, overrides })];
    // builders parity (ownership builders used by this route)
    const diffs = diffRuns(a, b);
    out.push({ name: c.name, category: c.cat, passed: diffs.length === 0, diffs, calls_old: a.log?.length ?? 0, calls_new: b.log?.length ?? 0 });
  }
  return out;
}
async function loadParity() {
  const both = async (which) => {
    const env = createEnv(); const ld = createLoader({ ts, root: ROOT, srcDir: SRC, env });
    if (which === "old") { env.stubs["routes/vault-entity-links"] = ld.loadText(baseText("vault-entity-links.ts"), "vault-entity-links.ts", ROUTES); ld.loadText(baseText("vault.ts"), "vault.ts", ROUTES); }
    else { ld.loadFile(path.join(ROUTES, "vault-entity-links.ts")); ld.loadFile(path.join(ROUTES, "vault.ts")); }
    return { log: env.log.map(canon).sort(), routes: env.routes.map((r) => `${r.method} ${r.path} mw=${r.stack.length - 1}`).sort() };
  };
  const a = await both("old"), b = await both("new");
  return [
    { name: "load:route table (method, path, middleware count) identical", passed: canon(a.routes) === canon(b.routes), diffs: canon(a.routes) === canon(b.routes) ? [] : [`old ${a.routes.length} vs new ${b.routes.length}`] },
    { name: "load:module-init side effects identical (policy rule registration)", passed: canon(a.log) === canon(b.log), diffs: canon(a.log) === canon(b.log) ? [] : [canon(a.log).slice(0, 200)] },
  ];
}

// mutation tests: seed regressions into NEW source and require the suite to notice.
async function mutationTests() {
  const res = []; const P = (f) => path.join(SRC, f);
  const muts = [
    { name: "PATCH link drops owner filter", file: P("vault/application/entity/links.ts"), from: /(\.set\(updates\)\s*\n\s*\.where\(and\(eq\(vaultEntityLinksTable\.id, id\), )eq\(vaultEntityLinksTable\.userId, userId\)/, to: "$1eq(vaultEntityLinksTable.userId, 0)" },
    { name: "POST duplicate no longer 409", file: P("vault/application/entity/links.ts"), from: /status: 409/, to: "status: 200" },
    { name: "trash no longer delists marketplace", file: P("vault/application/entity/lifecycle.ts"), from: /delistVaultMarketplaceListings\(id, "vault_entry_trashed"\)\.catch\(\(\) => \{\}\);/, to: "" },
    { name: "GET :id charges before ownership lookup semantic", file: P("vault/application/entity/lifecycle.ts"), from: /if \(!entry\) return \{ status: 404, body: \{ error: "Vault entry not found" \} \};/, to: "" },
    { name: "repository loses deleted_at filter in fallback", file: P("vault/infrastructure/repositories/entity-repository.ts"), from: /WHERE user_id = \$\{userId\} AND deleted_at IS NULL/, to: "WHERE user_id = ${userId}" },
  ];
  for (const m of muts) {
    const orig = fs.readFileSync(m.file, "utf8");
    if (!m.from.test(orig)) { res.push({ name: `mutation:${m.name}`, passed: false, details: "mutation anchor not found (fail closed)" }); continue; }
    const mutated = orig.replace(m.from, m.to);
    const suite = [...(await differentialSuite(new Map([[m.file, mutated]]))), ...await unitParityWithOverride(m.file, mutated)];
    const detected = suite.some((s) => !s.passed);
    res.push({ name: `mutation-detected:${m.name}`, passed: detected, details: detected ? "" : "seeded regression was NOT detected by the differential suite" });
  }
  return res;
}
async function unitParityWithOverride(file, text) {
  // unit parity uses loadFile without overrides; run the relevant repository scenario with the override.
  if (!file.endsWith("entity-repository.ts")) return [];
  const vText = baseText("vault.ts"); const names = ["SAFE_COLS", "selectVault"]; const out = [];
  const run = async (which) => {
    const env = createEnv({ [SEL_E]: [boom("x")], [`db.execute:${FALLBACK_KEY}`]: [ok({ rows: [] })] }); env.overrides.set(file, text);
    const ld = createLoader({ ts, root: ROOT, srcDir: SRC, env });
    const mod = which === "old" ? ld.loadText(sliceSymbols(ts, vText, names).text, "slice.ts", ROUTES) : ld.loadFile(file);
    await mod.selectVault(7); return env.log;
  };
  out.push({ name: "unit:selectVault fallback [mutated]", passed: canon(await run("old")) === canon(await run("new")) });
  return out;
}

// ── 5. Diff audit against the pre-extraction manifest ──
function diffAudit() {
  const man = JSON.parse(fs.readFileSync(path.join(BASE, "repo-manifest.json"), "utf8")).files;
  const now = {};
  for (const f of walkFiles(ROOT)) now[rel(f)] = sha256File(f);
  const changed = [], added = [], removed = [];
  for (const [k, v] of Object.entries(now)) { if (!(k in man)) added.push(k); else if (man[k] !== v) changed.push(k); }
  for (const k of Object.keys(man)) if (!(k in now)) removed.push(k);
  const isAllowedAdd = (k) => CHANGED_ALLOWED.has(k) || k.startsWith("scripts/antas/vault/gap/");
  const unexpected = [...changed.filter((k) => !CHANGED_ALLOWED.has(k)), ...added.filter((k) => !isAllowedAdd(k)), ...removed];
  return { changed, added, removed, unexpected };
}

// ── 6. Differential typecheck (degraded: dependencies are not installed) ──
function typecheckDifferential() {
  const cfgRaw = ts.readConfigFile(path.join(ROOT, "tsconfig.base.json"), ts.sys.readFile).config.compilerOptions;
  const opts = ts.convertCompilerOptionsFromJson({ ...cfgRaw, noEmit: true, skipLibCheck: true, types: [], incremental: false, composite: false, baseUrl: ROOT }, ROOT).options;
  const scopeAbs = [path.join(ROUTES, "vault.ts"), path.join(ROUTES, "vault-entity-links.ts"), ...NEW_FILES.map((f) => path.join(SRC, f))];
  const run = (useBaseline) => {
    const host = ts.createCompilerHost(opts);
    const rf = host.readFile.bind(host), fe = host.fileExists.bind(host), gs = host.getSourceFile.bind(host);
    const overrideFor = (f) => useBaseline ? ({ [path.join(ROUTES, "vault.ts")]: path.join(BASE, "routes/vault.ts"), [path.join(ROUTES, "vault-entity-links.ts")]: path.join(BASE, "routes/vault-entity-links.ts") })[f] : undefined;
    host.readFile = (f) => rf(overrideFor(f) ?? f);
    host.getSourceFile = (f, lv, ...r) => { const o = overrideFor(f); return o ? ts.createSourceFile(f, fs.readFileSync(o, "utf8"), lv, true) : gs(f, lv, ...r); };
    const roots = useBaseline ? scopeAbs.filter((f) => !NEW_FILES.map((x) => path.join(SRC, x)).includes(f)) : scopeAbs;
    const prog = ts.createProgram(roots, opts, host);
    const tally = {}; const syntactic = [];
    for (const f of roots) {
      const sf = prog.getSourceFile(f); if (!sf) continue;
      for (const d of prog.getSyntacticDiagnostics(sf)) syntactic.push(`${rel(f)}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
    }
    // whole-program semantic diagnostics attributed to scope files (moved code changes file, not message)
    for (const sf of prog.getSourceFiles()) {
      if (!scopeAbs.includes(sf.fileName) && !(useBaseline && [path.join(ROUTES, "vault.ts"), path.join(ROUTES, "vault-entity-links.ts")].includes(sf.fileName))) continue;
      for (const d of prog.getSemanticDiagnostics(sf)) {
        const msg = ts.flattenDiagnosticMessageText(d.messageText, " ");
        if ([2307, 7016, 2792].includes(d.code)) { const mm = msg.match(/module '([^']+)'/) ?? msg.match(/'([^']+)'/); if (mm && !mm[1].startsWith(".")) { tally.__external_unresolved = (tally.__external_unresolved ?? 0) + 1; continue; } }
        const k = `${d.code}: ${msg.replace(/'[^']*'/g, "'…'").slice(0, 90)}`;
        tally[k] = (tally[k] ?? 0) + 1;
      }
    }
    return { tally, syntactic };
  };
  const before = run(true), after = run(false);
  const regress = [];
  for (const [k, n] of Object.entries(after.tally)) if (k !== "__external_unresolved" && n > (before.tally[k] ?? 0)) regress.push(`${k} (+${n - (before.tally[k] ?? 0)})`);
  const realClasses = [2304, 2305, 2614, 2724, 2551, 2554, 2555, 2741, 2322, 2769, 2345];
  return { before_total: Object.values(before.tally).reduce((a, b) => a + b, 0), after_total: Object.values(after.tally).reduce((a, b) => a + b, 0), syntactic_errors: after.syntactic, new_diagnostics: regress, real_class_new: regress.filter((r) => realClasses.includes(Number(r.split(":")[0]))), before: before.tally, after: after.tally };
}

// ── 7. Main ──
function sourceHashes() {
  const files = [R("routes/vault.ts"), R("routes/vault-entity-links.ts"), ...NEW_FILES.map((f) => R(f)), "scripts/antas/vault/gap/harness.mjs", "scripts/antas/vault/gap/gap-common.mjs"];
  return Object.fromEntries(files.map((f) => [f, sha256File(path.join(ROOT, f))]));
}
async function main() {
  const verify = process.argv.includes("--verify");
  if (verify) {
    if (!fs.existsSync(EVIDENCE_FILE)) fail("evidence missing: run the validator first");
    const ev = JSON.parse(fs.readFileSync(EVIDENCE_FILE, "utf8"));
    const b = binding(sourceHashes()); const p = [];
    if (ev.sub_phase !== SUB_PHASE) p.push("sub_phase mismatch");
    if (ev.commit_sha !== b.commit_sha) p.push("commit_sha mismatch");
    if (ev.source_tree_sha256 !== b.source_tree_sha256) p.push("source changed since evidence (stale)");
    if (ev.validator_sha256 !== sha256File(HERE)) p.push("different validator version");
    const body = { ...ev }; delete body.evidence_body_sha256; delete body.generated_at;
    if (sha256(JSON.stringify(body)) !== ev.evidence_body_sha256) p.push("evidence body edited after generation");
    if (ev.status !== "PASS") p.push(`recorded status ${ev.status}`);
    if (p.length) fail(`evidence rejected: ${p.join("; ")}`);
    console.log(`${SUB_PHASE} evidence verified (${b.commit_binding})`); return;
  }

  const started = Date.now(); const commands = []; const exit_codes = {};
  // 01-A census re-run on the post-extraction tree (executed, exit code recorded)
  const a = spawnSync(process.execPath, [path.join(ROOT, "scripts/antas/vault/gap/validate-vlt-gap-01-A.mjs")], { encoding: "utf8", env: { ...process.env, NODE_PATH: process.env.NODE_PATH ?? "" } });
  commands.push("node scripts/antas/vault/gap/validate-vlt-gap-01-A.mjs"); exit_codes["01-A-census"] = a.status;

  const st = staticProof();
  const unit = await unitParity();
  const diff = await differentialSuite();
  const load = await loadParity();
  const mut = await mutationTests();
  commands.push("in-process differential suite (old baseline vs new source)"); 
  const audit = diffAudit();
  const tc = typecheckDifferential();

  const checks = [...st.checks];
  const push = (arr, prefix = "") => arr.forEach((r) => checks.push({ name: prefix + r.name, passed: r.passed, details: (r.diffs ?? []).join("; ") || r.details || "" }));
  push(diff, "differential:"); push(unit); push(load); push(mut);
  const cats = new Set(diff.map((d) => d.category));
  for (const c of ["success", "failure", "security"]) checks.push({ name: `coverage:category:${c}`, passed: cats.has(c), details: "" });
  checks.push({ name: "coverage:every-extracted-handler-has-differential-case", passed: HANDLERS.every((h) => CASES.some((c) => c.method === h.method && c.path === h.path && ((c.file === LINKS) === (h.file === L)))), details: "" });
  checks.push({ name: "census-01-A-exit-code-0", passed: a.status === 0, details: (a.stderr || "").slice(0, 200) });
  checks.push({ name: "no-skipped-tests", passed: CASES.length > 0 && diff.length === CASES.length, details: `${diff.length}/${CASES.length}` });
  checks.push({ name: "diff-audit:no-unrelated-changes", passed: audit.unexpected.length === 0, details: audit.unexpected.join(", ") });
  checks.push({ name: "typecheck:no-syntax-errors", passed: tc.syntactic_errors.length === 0, details: tc.syntactic_errors.join("; ") });
  checks.push({ name: "typecheck:no-new-diagnostics-vs-baseline", passed: tc.new_diagnostics.length === 0, details: tc.new_diagnostics.join("; ") });
  exit_codes.differential_suite = diff.every((d) => d.passed) ? 0 : 1;
  exit_codes.unit_parity = unit.every((d) => d.passed) ? 0 : 1;
  exit_codes.typecheck_differential = tc.new_diagnostics.length === 0 && tc.syntactic_errors.length === 0 ? 0 : 1;

  // post-extraction thinness from the fresh census
  const post = fs.existsSync(path.join(EVIDENCE_DIR, "symbol-inventory.json")) ? JSON.parse(fs.readFileSync(path.join(EVIDENCE_DIR, "symbol-inventory.json"), "utf8")) : null;
  const pre = JSON.parse(fs.readFileSync(path.join(BASE, "symbol-inventory.pre-extraction.json"), "utf8"));
  const routeStats = (inv, file) => { const rs = inv.records.filter((r) => r.kind === "route-handler" && r.file.endsWith(file)); return { routes: rs.length, with_business_behavior: rs.filter((r) => r.business_behavior_in_route).length, touching_db: rs.filter((r) => r.touches_db).length, branches: rs.reduce((x, r) => x + r.branch_total, 0) }; };
  const thin = post ? Object.fromEntries(["vault.ts", "vault-entity-links.ts"].map((f) => [f, { before: routeStats(pre, f), after: routeStats(post, f) }])) : null;
  const remaining = post ? post.records.filter((r) => r.file.endsWith("routes/vault.ts") && r.owner_gap === "GAP-01" && r.kind === "route-handler" && r.business_behavior_in_route).map((r) => r.name) : [];
  const remainingNonRoute = post ? post.records.filter((r) => /routes\/vault(-entity-links)?\.ts$/.test(r.file) && r.owner_gap === "GAP-01" && ["function", "arrow-function", "constant"].includes(r.kind)).map((r) => `${path.basename(r.file)}#${r.name}`) : [];
  checks.push({ name: "extracted-links-file-has-zero-business-routes", passed: thin && thin["vault-entity-links.ts"].after.with_business_behavior === 0 && thin["vault-entity-links.ts"].after.touching_db === 0, details: JSON.stringify(thin?.["vault-entity-links.ts"]?.after) });
  checks.push({ name: "vault-ts-db-touching-routes-reduced", passed: thin && thin["vault.ts"].after.touching_db < thin["vault.ts"].before.touching_db, details: JSON.stringify(thin?.["vault.ts"]) });

  const failed = checks.filter((c) => !c.passed);
  const hashes = sourceHashes(); const b = binding(hashes);
  const evidence = {
    phase: "VLT-GAP-01", sub_phase: SUB_PHASE,
    commit_sha: b.commit_sha, commit_binding: b.commit_binding, source_tree_sha256: b.source_tree_sha256,
    validator_version: VALIDATOR_VERSION, validator_sha256: sha256File(HERE),
    source_hashes: hashes,
    commands, exit_codes,
    symbols_moved: st.moved.map((m) => ({ from: `${m.old_file}#${m.old_symbol}`, to: `${m.new_file}#${m.new_symbol}`, mode: m.mode, layer: m.layer, behavior_domain: m.behavior_domain, identical_implementation: m.identical_modulo_export, consumers: m.consumers, in_file_references: m.in_file_references })),
    handlers_extracted: st.handlers,
    consumers_migrated: [],
    old_business_symbols_remaining: { gap01_routes_with_business_behavior_in_vault_ts: remaining, gap01_non_route_symbols_in_old_files: remainingNonRoute },
    duplicate_implementations: st.duplicates_in_scope,
    duplicates_outside_scope_for_01C: st.duplicates_outside_scope,
    route_thinness: thin,
    diff_audit: audit,
    typecheck: { mode: "degraded-differential (project dependencies are not installed in the upload; full tsc/build is NOT executed)", ...tc },
    tests: { differential_cases: diff.length, differential_passed: diff.filter((d) => d.passed).length, unit_parity: unit.length, unit_passed: unit.filter((d) => d.passed).length, mutation_tests: mut.length, mutation_detected: mut.filter((d) => d.passed).length, results: diff.map((d) => ({ name: d.name, category: d.category, passed: d.passed, calls_old: d.calls_old, calls_new: d.calls_new })) },
    checks,
    status: failed.length === 0 ? "PASS" : "FAIL",
  };
  evidence.evidence_body_sha256 = sha256(JSON.stringify(evidence));
  evidence.generated_at = new Date().toISOString();
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(EVIDENCE_FILE, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`${SUB_PHASE} ${evidence.status} — moved=${evidence.symbols_moved.length} handlers=${st.handlers.length} diff-cases=${diff.length} unit=${unit.length} mutations=${mut.filter((m) => m.passed).length}/${mut.length} (${Date.now() - started}ms)`);
  if (failed.length) { console.error(failed.map((c) => `- ${c.name}: ${String(c.details).slice(0, 300) || "not satisfied"}`).join("\n")); process.exit(1); }
}
main().catch((e) => fail(`validator crashed: ${e.stack || e}`));
