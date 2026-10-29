#!/usr/bin/env node
// VLT-GAP-01-D — Old Source Retirement Gate. Fail-closed validator.
// Evidence: reports/antas/vault/gap/VLT-GAP-01/{old-source-fingerprint,new-source-fingerprint,route-thinness,
//           duplicate-implementation,behavior-regression,security-regression,gate}.json
//
// Question answered: after GAP-01 extraction, is the OLD implementation (routes/vault.ts, vault-entity-links.ts,
// vault-snapshot.ts, vault-shares.ts) still authoritative for any GAP-01 behavior?
//
// Scope rule (from the roadmap): the gate is GAP-01's. Old-file code owned by a LATER gap (GAP-02 local account,
// GAP-05 secret/wallet, GAP-09 snapshot, GAP-10 share, GAP-11 health) is not GAP-01 business logic; it is reported as
// deferred, and must be byte-for-byte untouched so this phase cannot silently change another gap's behavior.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { ROOT, sha256, sha256File, rel, rejectBypass, binding, walkFiles, GAP01D_NEW_FILES } from "./gap-common.mjs";
import { loadTs, createEnv, createLoader, fakeRes, summ, sqlKeyOf } from "./harness.mjs";

const VALIDATOR_VERSION = "1.0.0";
const SUB_PHASE = "VLT-GAP-01-D";
const HERE = fileURLToPath(import.meta.url);
const SRC = path.join(ROOT, "artifacts/api-server/src");
const ROUTES = path.join(SRC, "routes");
const BASE = path.join(ROOT, "reports/antas/vault/gap/VLT-GAP-01/baseline");
const EVID = path.join(ROOT, "reports/antas/vault/gap/VLT-GAP-01");
const EV = { old: "old-source-fingerprint.json", neu: "new-source-fingerprint.json", thin: "route-thinness.json", dup: "duplicate-implementation.json", beh: "behavior-regression.json", sec: "security-regression.json", gate: "gate.json" };
const R = (f) => `artifacts/api-server/src/${f}`;
const fail = (m) => { console.error(`${SUB_PHASE} FAIL — ${m}`); process.exit(1); };

const bypass = rejectBypass();
if (bypass.length) fail(`bypass mechanism rejected: ${bypass.join(", ")}`);
const ts = loadTs(ROOT);
if (!ts) fail("TypeScript compiler API unavailable (fail closed)");
const parse = (name, text) => ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const canon = (o) => JSON.stringify(o);
const readSrc = (f) => fs.readFileSync(path.join(SRC, f), "utf8");
const baseText = (n) => fs.readFileSync(path.join(BASE, "routes", n), "utf8");

// ── Declared intent (every entry is VERIFIED against source below; nothing here is trusted) ─────────────────────────
const OLD_FILES = ["vault.ts", "vault-entity-links.ts", "vault-snapshot.ts", "vault-shares.ts"];
const LATER_GAPS = new Set(["GAP-02", "GAP-05", "GAP-09", "GAP-10", "GAP-11"]);
// Symbols whose 01-A classification (name-based) is GAP-01 but whose only consumer is a later gap's code.
const RECLASSIFY = { "vault.ts|BRIDGE_PLATFORMS": { to: "GAP-02", onlyUsedInside: "autoCreateLocalAccountsForEntity" } };
// Dead duplicates retired outright (must be provably unreferenced AND a strict subset of the canonical owner).
const RETIRE_DEAD = { "vault.ts|legacyFormatRow": { canonical: ["vault/application/entity/representation.ts", "formatVaultEntry"] } };
// Route handler -> use-case (baseline route key -> [destination file, function]).
const EXTRACTED_ROUTES = {
  "vault-entity-links.ts": {
    "GET /vault/:id/links": ["vault/application/entity/links.ts", "listEntityLinks"], "POST /vault-entity-links": ["vault/application/entity/links.ts", "createEntityLink"],
    "PATCH /vault-entity-links/:id": ["vault/application/entity/links.ts", "updateEntityLink"], "DELETE /vault-entity-links/:id": ["vault/application/entity/links.ts", "deleteEntityLink"],
    "GET /vault/links/all": ["vault/application/entity/links.ts", "listAllEntityLinks"],
  },
  "vault.ts": Object.fromEntries([
    ["GET /vault", "lifecycle", "listEntities"], ["GET /vault/tags", "lifecycle", "listEntityTags"], ["GET /vault/trash", "lifecycle", "listTrashedEntities"], ["GET /vault/:id", "lifecycle", "getEntity"],
    ["DELETE /vault/trash", "lifecycle", "emptyTrash"], ["DELETE /vault/:id", "lifecycle", "trashEntity"], ["POST /vault/:id/restore", "lifecycle", "restoreEntity"], ["DELETE /vault/trash/:id", "lifecycle", "purgeTrashedEntity"],
    ["GET /vault/gas-overview", "analytics", "getGasOverviewForUser"], ["GET /vault/:id/gas", "analytics", "getEntityGas"], ["GET /vault/analytics", "analytics", "getEntityAnalytics"], ["GET /vault/analytics/value-history", "analytics", "getEntityValueHistory"],
    ["POST /vault", "create", "createEntity"], ["PATCH /vault/bulk-tag", "bulk", "bulkTagEntities"], ["PATCH /vault/bulk-action", "bulk", "bulkActionEntities"],
    ["GET /vault/activity", "activity-feed", "listMyVaultActivity"], ["GET /vault/:id/activity", "activity-feed", "listEntityActivity"],
    ["PATCH /vault/:id", "update", "updateEntity"], ["PATCH /vault/:id/field", "update", "updateEntityField"], ["GET /vault/:id/field-history", "update", "listEntityFieldHistory"],
    ["GET /admin/vault", "admin", "adminListEntities"], ["GET /admin/vault/full", "admin", "adminFullVault"], ["GET /admin/vault/local-accounts", "admin", "adminListLocalAccounts"],
    ["GET /admin/vault/users", "admin", "adminListVaultUsers"], ["GET /admin/vault/users/:userId", "admin", "adminGetUserVault"], ["GET /admin/vault/activity", "admin", "adminVaultActivityFeed"],
    ["POST /vault/:id/receipt", "receipt", "createReceiptLink"], ["DELETE /vault/:id/receipt", "receipt", "revokeReceiptLink"],
  ].map(([k, f, fn]) => [k, [`vault/application/entity/${f}.ts`, fn]])),
};
// Public receipt routes are decomposed across several receipt.ts symbols; parity is checked on the union.
const COMPOSITE_ROUTES = {
  "GET /vault/receipt/:token": { baselineExtra: ["findVaultEntryByReceiptToken", "fmtPublicVaultReceipt"], newFns: ["resolvePublicReceipt", "findVaultEntryByReceiptToken", "fmtPublicVaultReceipt"] },
  "GET /vault/receipt/:token/pdf": { baselineExtra: ["findVaultEntryByReceiptToken", "fmtPublicVaultReceipt"], newFns: ["resolvePublicReceipt", "buildReceiptPdfSpec", "findVaultEntryByReceiptToken", "fmtPublicVaultReceipt"], newIncludesRouteHandler: true },
};
const COMPOSITE_DEST = "vault/application/entity/receipt.ts";
// Private helpers moved verbatim in 01-D (baseline vault.ts -> receipt.ts, same name).
const MOVED_D_VERBATIM = { "vault.ts|generateVaultReceiptToken": COMPOSITE_DEST, "vault.ts|vaultReceiptUrl": COMPOSITE_DEST, "vault.ts|findVaultEntryByReceiptToken": COMPOSITE_DEST, "vault.ts|fmtPublicVaultReceipt": COMPOSITE_DEST };
const ALL_OWNER_FILES = () => walkFiles(path.join(SRC, "vault"), [], (p) => p.endsWith(".ts") && !p.endsWith(".d.ts")).map((f) => path.relative(SRC, f).split(path.sep).join("/")).filter((f) => f !== "vault/api/index.ts" && f !== "vault/index.ts");
const ALLOWED_CHANGED = () => new Set([
  R("routes/vault.ts"), R("routes/vault-entity-links.ts"), R("routes/entities.ts"), R("routes/value-history.ts"), R("lib/vault-health-scan.ts"), "scripts/src/test-route-ownership-regression.ts",
  ...GAP01D_NEW_FILES.map(R), ...[
    "vault/security/entity-ownership.ts", "vault/infrastructure/repositories/entity-repository.ts", "vault/application/entity/activity.ts", "vault/application/entity/links.ts", "vault/application/entity/lifecycle.ts",
    "vault/application/entity/representation.ts", "vault/domain/entity/fields.ts", "vault/domain/entity/calculations.ts"].map(R)]);

// ── AST helpers ─────────────────────────────────────────────────────────────────────────────────────────────────────
function tokensOf(node, sf) { const t = []; (function w(n) { if (ts.isJSDoc(n)) return; if (n.getChildCount(sf) === 0) { if (n.kind !== ts.SyntaxKind.EndOfFileToken) t.push(n.getText(sf)); } else n.getChildren(sf).forEach(w); })(node); return t; }
const fp = (node, sf) => { const t = tokensOf(node, sf); if (t[0] === "export") t.shift(); return sha256(t.join(" ")); };
const lineOf = (sf, pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;
const hasExport = (s) => s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
const norm = (t) => t.replace(/\s+/g, " ").replace(/req\.user!\.userId/g, "userId").replace(/req\.params\.(id|userId|token)/g, "idParam").replace(/req\.body/g, "body").replace(/req\.query/g, "query").trim();

function importMapOf(sf) {
  const m = new Map();
  for (const s of sf.statements) {
    if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier) || !s.importClause) continue;
    const c = s.importClause, mod = s.moduleSpecifier.text;
    if (c.name) m.set(c.name.text, { module: mod, imported: "default" });
    if (c.namedBindings && ts.isNamedImports(c.namedBindings)) for (const e of c.namedBindings.elements) m.set(e.name.text, { module: mod, imported: (e.propertyName ?? e.name).text });
    if (c.namedBindings && ts.isNamespaceImport(c.namedBindings)) m.set(c.namedBindings.name.text, { module: mod, imported: "*" });
  }
  return m;
}
function importsOf(sf, fileAbs) {
  const out = [];
  for (const s of sf.statements) {
    if (ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier)) {
      const names = []; const c = s.importClause;
      if (c?.name) names.push({ imported: "default", local: c.name.text });
      if (c?.namedBindings && ts.isNamedImports(c.namedBindings)) for (const e of c.namedBindings.elements) names.push({ imported: (e.propertyName ?? e.name).text, local: e.name.text });
      if (c?.namedBindings && ts.isNamespaceImport(c.namedBindings)) names.push({ imported: "*", local: c.namedBindings.name.text });
      out.push({ spec: s.moduleSpecifier.text, kind: "import", names, typeOnly: Boolean(c?.isTypeOnly), line: lineOf(sf, s.getStart(sf)), abs: s.moduleSpecifier.text.startsWith(".") ? path.resolve(path.dirname(fileAbs), s.moduleSpecifier.text.replace(/\.(js|ts|mjs)$/, "")) : null });
    } else if (ts.isExportDeclaration(s) && s.moduleSpecifier && ts.isStringLiteral(s.moduleSpecifier)) {
      const names = s.exportClause && ts.isNamedExports(s.exportClause) ? s.exportClause.elements.map((e) => ({ imported: (e.propertyName ?? e.name).text, local: e.name.text })) : [{ imported: "*", local: "*" }];
      out.push({ spec: s.moduleSpecifier.text, kind: "re-export", names, line: lineOf(sf, s.getStart(sf)), abs: s.moduleSpecifier.text.startsWith(".") ? path.resolve(path.dirname(fileAbs), s.moduleSpecifier.text.replace(/\.(js|ts|mjs)$/, "")) : null });
    }
  }
  (function w(n) {
    if (ts.isCallExpression(n) && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0]) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require"))) {
      const spec = n.arguments[0].text; const names = [];
      // const { a, b } = await import("x")  /  const { a } = require("x")
      let p = n.parent; if (p && ts.isAwaitExpression(p)) p = p.parent;
      if (p && ts.isVariableDeclaration(p) && ts.isObjectBindingPattern(p.name)) for (const e of p.name.elements) names.push({ imported: (e.propertyName ?? e.name).getText(sf), local: e.name.getText(sf) });
      else names.push({ imported: "*", local: "?" });
      out.push({ spec, kind: n.expression.kind === ts.SyntaxKind.ImportKeyword ? "dynamic-import" : "require", names, line: lineOf(sf, n.getStart(sf)), abs: spec.startsWith(".") ? path.resolve(path.dirname(fileAbs), spec.replace(/\.(js|ts|mjs)$/, "")) : null });
    }
    ts.forEachChild(n, w);
  })(sf);
  return out;
}

// callee name independent of arguments: a.b(x).c(y) -> "a.b.c"
function calleeName(expr, sf) {
  if (ts.isIdentifier(expr)) return expr.text;
  if (expr.kind === ts.SyntaxKind.ImportKeyword) return "import";
  if (ts.isPropertyAccessExpression(expr)) {
    const l = expr.expression;
    const left = ts.isCallExpression(l) ? calleeName(l.expression, sf) : ts.isNonNullExpression(l) || ts.isParenthesizedExpression(l) || ts.isAsExpression(l) ? calleeName(l.expression, sf) : ts.isIdentifier(l) || ts.isPropertyAccessExpression(l) ? calleeName(l, sf) : l.getText(sf).replace(/\s+/g, " ").slice(0, 40);
    return `${left}.${expr.name.text}`;
  }
  if (ts.isElementAccessExpression(expr)) return `${calleeName(expr.expression, sf)}[]`;
  if (ts.isNonNullExpression(expr) || ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr)) return calleeName(expr.expression, sf);
  return expr.getText(sf).replace(/\s+/g, " ").slice(0, 40);
}
const DEP_ALIAS = { autoCreateLocalAccounts: "autoCreateLocalAccountsForEntity", auditBulkOwnership: "auditVaultBulkOwnership" };
function normCallee(n) {
  n = n.replace(/^deps\./, "");
  const [head, ...rest] = n.split(".");
  return [DEP_ALIAS[head] ?? head, ...rest].join(".");
}
const isPlumbingCallee = (n) => n === "res.status" || n === "res.json" || n.startsWith("res.status.") || n.startsWith("res.json.");

// Behavioral feature vector of a set of nodes (order-insensitive multisets).
function featuresOf(nodes, sf, { ignoreCallees = new Set() } = {}) {
  const f = { db_chains: [], table_refs: [], sql_templates: [], strings: [], numbers: [], calls: [], control: {}, awaits: 0 };
  const bump = (k) => { f.control[k] = (f.control[k] ?? 0) + 1; };
  const visit = (n) => {
    if (ts.isCallExpression(n)) {
      const nm = normCallee(calleeName(n.expression, sf));
      if (!isPlumbingCallee(nm) && !ignoreCallees.has(nm.split(".")[0])) f.calls.push(nm);
      // `res.json(x)` with no `res.status(..)` is an implicit HTTP 200; the extracted use-cases state it explicitly as `{ status: 200, .. }`.
      if (ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "json" && ts.isIdentifier(n.expression.expression) && n.expression.expression.text === "res") f.numbers.push("200");
      // outermost db chain only
      const par = n.parent;
      const inner = par && ts.isPropertyAccessExpression(par) && par.expression === n;
      if (!inner) { const parts = []; let c = n; let root = null; while (c) { if (ts.isCallExpression(c)) { c = c.expression; continue; } if (ts.isPropertyAccessExpression(c)) { parts.unshift(c.name.text); c = c.expression; continue; } if (ts.isIdentifier(c)) { root = c.text; break; } if (ts.isNonNullExpression(c) || ts.isParenthesizedExpression(c) || ts.isAwaitExpression(c)) { c = c.expression; continue; } break; } if (root === "db") f.db_chains.push(`db.${parts.join(".")}`); }
    }
    if (ts.isNewExpression(n)) f.calls.push(`new ${n.expression.getText(sf)}`);
    if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && /Table$/.test(n.expression.text)) f.table_refs.push(`${n.expression.text}.${n.name.text}`);
    if (ts.isIdentifier(n) && /Table$/.test(n.text) && !(n.parent && ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) f.table_refs.push(n.text);
    if (ts.isTaggedTemplateExpression(n) && n.tag.getText(sf) === "sql") f.sql_templates.push(norm(n.template.getText(sf)));
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      // A relative dynamic-import specifier moves with its file; compare the module it resolves to, not the spelling.
      const isDynImport = n.parent && ts.isCallExpression(n.parent) && n.parent.expression.kind === ts.SyntaxKind.ImportKeyword && n.parent.arguments[0] === n && n.text.startsWith(".");
      if (isDynImport) { const fnm = sf.fileName; const dirRaw = path.isAbsolute(fnm) ? path.dirname(fnm) : fnm.includes("/") ? path.dirname(path.join(SRC, fnm)) : ROUTES; const dir = dirRaw.startsWith(BASE) ? path.join(SRC, path.relative(BASE, dirRaw)) : dirRaw; f.strings.push(`import:${path.relative(SRC, path.resolve(dir, n.text)).split(path.sep).join("/")}`); }
      else f.strings.push(n.text);
    }
    if (ts.isTemplateExpression(n) && !(n.parent && ts.isTaggedTemplateExpression(n.parent))) f.strings.push(norm(n.getText(sf)));
    if (ts.isNumericLiteral(n)) f.numbers.push(n.text);
    switch (n.kind) {
      case ts.SyntaxKind.IfStatement: bump("if"); if (n.elseStatement) bump("else"); break;
      case ts.SyntaxKind.ConditionalExpression: bump("ternary"); break;
      case ts.SyntaxKind.SwitchStatement: bump("switch"); break;
      case ts.SyntaxKind.CaseClause: bump("case"); break;
      case ts.SyntaxKind.ForStatement: case ts.SyntaxKind.ForOfStatement: case ts.SyntaxKind.ForInStatement: case ts.SyntaxKind.WhileStatement: case ts.SyntaxKind.DoStatement: bump("loop"); break;
      case ts.SyntaxKind.TryStatement: bump("try"); break;
      case ts.SyntaxKind.CatchClause: bump("catch"); break;
      case ts.SyntaxKind.ThrowStatement: bump("throw"); break;
      case ts.SyntaxKind.AwaitExpression: f.awaits++; break;
      case ts.SyntaxKind.QuestionDotToken: bump("optional-chain"); break;
      case ts.SyntaxKind.BinaryExpression: { const k = n.operatorToken.kind; if (k === ts.SyntaxKind.AmpersandAmpersandToken) bump("&&"); else if (k === ts.SyntaxKind.BarBarToken) bump("||"); else if (k === ts.SyntaxKind.QuestionQuestionToken) bump("??"); break; }
      default:
    }
    ts.forEachChild(n, visit);
  };
  for (const n of nodes) visit(n);
  for (const k of ["db_chains", "table_refs", "sql_templates", "strings", "numbers", "calls"]) f[k].sort();
  f.control = Object.fromEntries(Object.entries(f.control).sort());
  return f;
}
function parityDiff(a, b) {
  const d = [];
  for (const k of ["db_chains", "table_refs", "sql_templates", "strings", "numbers", "calls"]) if (canon(a[k]) !== canon(b[k])) {
    const cnt = (l) => l.reduce((m, x) => (m.set(x, (m.get(x) ?? 0) + 1), m), new Map());
    const ca = cnt(a[k]), cb = cnt(b[k]); const miss = [], extra = [];
    for (const [x, n] of ca) if ((cb.get(x) ?? 0) < n) miss.push(x); for (const [x, n] of cb) if ((ca.get(x) ?? 0) < n) extra.push(x);
    d.push(`${k}: dropped=[${miss.slice(0, 3).map((s) => String(s).slice(0, 60))}] added=[${extra.slice(0, 3).map((s) => String(s).slice(0, 60))}]`);
  }
  if (canon(a.control) !== canon(b.control)) d.push(`control-flow ${canon(a.control)} != ${canon(b.control)}`);
  if (a.awaits !== b.awaits) d.push(`awaits ${a.awaits} != ${b.awaits}`);
  return d;
}

// ── Symbol scan (own AST census of an old-source file) ─────────────────────────────────────────────────────────────
const HTTP = new Set(["get", "post", "put", "patch", "delete", "head", "options", "all"]);
function scanSymbols(text, fileName) {
  const sf = parse(fileName, text); const syms = [];
  const add = (o) => syms.push({ file: path.basename(fileName), ...o, sf });
  for (const s of sf.statements) {
    if (ts.isImportDeclaration(s)) continue;
    const L = { start: lineOf(sf, s.getStart(sf)), end: lineOf(sf, s.getEnd()) };
    if (ts.isExportDeclaration(s) && s.moduleSpecifier) { add({ key: `re-export@${L.start}`, kind: "re-export", node: s, ...L, exported: true }); continue; }
    if (ts.isExportDeclaration(s)) { add({ key: `export-list@${L.start}`, kind: "export-list", node: s, ...L, exported: true }); continue; }
    if (ts.isFunctionDeclaration(s) && s.name) { add({ key: s.name.text, kind: "function", node: s, ...L, exported: hasExport(s) }); continue; }
    if (ts.isVariableStatement(s)) { for (const d of s.declarationList.declarations) add({ key: d.name.getText(sf), kind: "const", node: s, decl: d, ...L, exported: hasExport(s) }); continue; }
    if (ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s)) { add({ key: s.name.text, kind: "type", node: s, ...L, exported: hasExport(s) }); continue; }
    if (ts.isExportAssignment(s)) { add({ key: "default", kind: "export-default", node: s, ...L, exported: true }); continue; }
    if (ts.isExpressionStatement(s) && ts.isCallExpression(s.expression)) {
      const c = s.expression;
      if (ts.isPropertyAccessExpression(c.expression) && c.expression.expression.getText(sf) === "router" && HTTP.has(c.expression.name.text)) {
        const p = c.arguments[0]; const h = c.arguments[c.arguments.length - 1];
        add({ key: `${c.expression.name.text.toUpperCase()} ${ts.isStringLiteral(p) ? p.text : "?"}`, kind: "route", node: s, ...L, handler: h, middleware: c.arguments.slice(1, -1) });
        continue;
      }
      if (ts.isPropertyAccessExpression(c.expression) && c.expression.name.text === "registerRule") { add({ key: `${c.expression.expression.getText(sf)}.registerRule`, kind: "rule-registration", node: s, ...L }); continue; }
    }
    add({ key: `stmt@${L.start}`, kind: "unknown-statement", node: s, ...L });
  }
  return { sf, syms, imports: importMapOf(sf) };
}
const symKey = (s) => `${s.file}|${s.key}`;

// ── Thin-route rules ───────────────────────────────────────────────────────────────────────────────────────────────
const PROVIDER = /^(fetch|axios|request|streamFantasticReceiptPdf)$/, CRYPTO = /^(encryptField|decryptField|decryptRows|encryptSeedPhrase|decryptSeedPhrase|generateSerial|createHash|createHmac|randomBytes|randomUUID|createCipheriv|createDecipheriv)/, EVENT = /^(broadcastEvent|createNotification|sendToUser|logVaultActivity|logSubjectActivity)$/, SYNC = /^(syncOnVault\w+|delistVaultMarketplaceListings|chargeCredits)$/;
function thinCheck(sym, sf, imports) {
  const v = []; const h = sym.handler;
  if (!h || !(ts.isArrowFunction(h) || ts.isFunctionExpression(h)) || !h.body) return { thin: false, violations: ["handler is not an inline function"], metrics: null };
  const body = ts.isBlock(h.body) ? h.body : null;
  const fe = featuresOf([h.body], sf);
  const stmts = body ? body.statements.length : 1;
  if (fe.db_chains.length) v.push(`database access in route: ${fe.db_chains.slice(0, 3).join(", ")}`);
  if (fe.table_refs.length) v.push(`table reference in route: ${[...new Set(fe.table_refs)].slice(0, 3).join(", ")}`);
  if (fe.sql_templates.length) v.push(`SQL template in route (${fe.sql_templates.length})`);
  for (const k of ["ternary", "switch", "case", "loop", "try", "catch", "throw", "&&", "||", "??"]) if (fe.control[k]) v.push(`decision/flow construct in route: ${k} x${fe.control[k]}`);
  // the only permitted branch is mapping a use-case result to a response: `if (!r.something)`
  const ifs = []; (function w(n) { if (ts.isIfStatement(n)) ifs.push(n); ts.forEachChild(n, w); })(h.body);
  for (const i of ifs) if (!/^!?r\.\w+$/.test(i.expression.getText(sf).trim())) v.push(`business branch in route: if (${i.expression.getText(sf).slice(0, 50)})`);
  if (ifs.length > 1) v.push(`more than one response-mapping branch (${ifs.length})`);
  if (stmts > 4) v.push(`handler has ${stmts} statements (max 4)`);
  let delegates = 0; const bad = [];
  for (const c of fe.calls) {
    const head = c.split(".")[0];
    const imp = imports.get(head);
    if (imp && /\/vault\//.test(imp.module) && !imp.module.startsWith("./")) { delegates++; continue; }
    if (head === "streamFantasticReceiptPdf") continue; // response mapping (stream the PDF the use-case described)
    bad.push(c);
  }
  if (bad.length) v.push(`non-adapter calls in route: ${[...new Set(bad)].slice(0, 5).join(", ")}`);
  for (const c of new Set(fe.calls.map((x) => x.split(".")[0]))) { if (PROVIDER.test(c) && c !== "streamFantasticReceiptPdf") v.push(`provider call: ${c}`); if (CRYPTO.test(c)) v.push(`crypto call: ${c}`); if (EVENT.test(c) || SYNC.test(c)) v.push(`side-effect call in route: ${c}`); }
  if (delegates === 0) v.push("route does not delegate to a vault/ application owner");
  // inline middleware callbacks (onDeny) may only write a response
  for (const m of sym.middleware ?? []) (function w(n) {
    if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && n.body) {
      const mf = featuresOf([n.body], sf);
      const other = mf.calls.filter((c) => !isPlumbingCallee(c));
      if (other.length || mf.db_chains.length || Object.keys(mf.control).length) v.push(`middleware callback does more than write a response: ${other.concat(Object.keys(mf.control)).join(",")}`);
      return;
    }
    ts.forEachChild(n, w);
  })(m);
  return { thin: v.length === 0, violations: v, metrics: { db_chains: fe.db_chains.length, tables: fe.table_refs.length, sql_templates: fe.sql_templates.length, branches: Object.values(fe.control).reduce((a, b) => a + b, 0), delegated_calls: delegates, statements: stmts } };
}
function wiringCheck(sym, sf) { // new adapter-wiring const: object literal of shorthand/identifier members only
  if (sym.kind !== "const" || !sym.decl.initializer || !ts.isObjectLiteralExpression(sym.decl.initializer)) return false;
  return sym.decl.initializer.properties.every((p) => ts.isShorthandPropertyAssignment(p) || (ts.isPropertyAssignment(p) && ts.isIdentifier(p.initializer)));
}
const metricsOfSym = (sym) => { const fe = featuresOf([sym.kind === "route" ? sym.handler : sym.node], sym.sf); return { db_chains: fe.db_chains.length, tables: [...new Set(fe.table_refs)], sql_templates: fe.sql_templates.length, branches: Object.values(fe.control).reduce((a, b) => a + b, 0), calls: fe.calls.length, tokens: tokensOf(sym.node, sym.sf).length }; };

// ── Pre-extraction ownership (01-A output, independently re-derived symbols must all map onto it) ───────────────────
function loadOwners() {
  const pre = JSON.parse(fs.readFileSync(path.join(BASE, "symbol-inventory.pre-extraction.json"), "utf8"));
  const m = new Map();
  for (const r of pre.records) m.set(`${path.basename(r.file)}|${r.name}`, { owner_gap: r.owner_gap, behavior_domain: r.behavior_domain, classification: r.classification });
  return m;
}
const findDecl = (name, destRel) => { const abs = path.join(SRC, destRel); if (!fs.existsSync(abs)) return null; const { sf, syms } = scanSymbols(fs.readFileSync(abs, "utf8"), abs); const s = syms.find((x) => x.key === name && (x.kind === "function" || x.kind === "const")); return s ? { ...s, sf } : null; };
const declFp = (s) => fp(s.kind === "const" ? s.node : s.node, s.sf);
// Renamed moves (01-B claim mode "renamed"): identical body, only the declared name differs. Compare token-for-token
// with the destination name mapped back to the baseline name; nothing else may differ.
const renamedFp = (s, fromName, toName) => { const t = tokensOf(s.node, s.sf); if (t[0] === "export") t.shift(); return sha256(t.map((x) => (x === fromName ? toName : x)).join(" ")); };

// ── 1. Old-source disposition (the core gate) ──────────────────────────────────────────────────────────────────────
function retirementGate({ overlay = new Map() } = {}) {
  const owners = loadOwners();
  const claims = JSON.parse(fs.readFileSync(path.join(EVID, "extraction-proof.json"), "utf8")).symbols_moved ?? [];
  const claimByFrom = new Map(claims.map((c) => [c.from, c]));
  const files = [];
  const violations = []; const dispositions = []; const thin = []; const deferredBusiness = {};
  for (const f of OLD_FILES) {
    const curPath = path.join(ROUTES, f);
    const curText = overlay.get(R(`routes/${f}`)) ?? fs.readFileSync(curPath, "utf8");
    const baseTxt = baseText(f);
    const cur = scanSymbols(curText, curPath), old = scanSymbols(baseTxt, path.join(BASE, "routes", f));
    const curByKey = new Map(cur.syms.map((s) => [s.key, s])); const consumed = new Set();
    const rec = { file: R(`routes/${f}`), baseline_sha256: sha256(baseTxt), current_sha256: sha256(curText), baseline_lines: baseTxt.split("\n").length, current_lines: curText.split("\n").length, baseline_tokens: tokensOf(old.sf, old.sf).length, current_tokens: tokensOf(cur.sf, cur.sf).length, symbols: [] };
    const untouched = rec.baseline_sha256 === rec.current_sha256;
    for (const b of old.syms) {
      const k = symKey(b); const inv = owners.get(`${f}|${b.key}`) ?? (b.kind === "export-default" ? owners.get(`${f}|default`) : undefined);
      const out = { symbol: b.key, kind: b.kind, baseline_lines: [b.start, b.end], baseline_fingerprint: fp(b.node, b.sf), metrics_baseline: metricsOfSym(b) };
      if (!inv) { violations.push(`${k}: baseline symbol has no ownership record (unclassified)`); out.disposition = "UNCLASSIFIED"; rec.symbols.push(out); continue; }
      let owner = inv.owner_gap; out.owner_gap = owner; out.behavior_domain = inv.behavior_domain;
      const re = RECLASSIFY[k];
      if (re) { const c = curByKey.get(b.key); const refs = []; if (c) { (function w(n) { if (ts.isIdentifier(n) && n.text === b.key && n !== c.decl?.name) refs.push(n); ts.forEachChild(n, w); })(cur.sf); }
        const host = curByKey.get(re.onlyUsedInside); const inside = refs.filter((r) => host && r.getStart(cur.sf) >= host.node.getStart(cur.sf) && r.getEnd() <= host.node.getEnd());
        if (c && host && refs.length > 0 && inside.length === refs.length && declFp(c) === declFp(b)) { owner = re.to; out.owner_gap = re.to; out.reclassified = { from: inv.owner_gap, proof: `all ${refs.length} references are inside ${re.onlyUsedInside}; declaration unchanged` }; }
        else violations.push(`${k}: reclassification to ${re.to} not provable from source`); }
      const c = curByKey.get(b.key); if (c) consumed.add(b.key);
      const same = c ? fp(c.node, c.sf) === out.baseline_fingerprint : false;
      if (owner === "GAP-01") {
        if (b.kind === "route") {
          if (!c) { out.disposition = "MISSING_ROUTE"; violations.push(`${k}: public route disappeared`); }
          else { const t = thinCheck(c, cur.sf, cur.imports); out.disposition = t.thin ? "ADAPTER_THIN" : "AUTHORITATIVE_OLD_LOGIC"; out.thinness = t; thin.push({ file: f, route: b.key, owner_gap: owner, ...t, middleware: c.middleware.map((m) => m.getText(cur.sf).replace(/\s+/g, " ").slice(0, 110)) });
            if (!t.thin) violations.push(`${k}: route is not an adapter — ${t.violations.join("; ")}`);
            const dest = (EXTRACTED_ROUTES[f] ?? {})[b.key]; const comp = f === "vault.ts" ? COMPOSITE_ROUTES[b.key] : null;
            if (!dest && !comp) { out.disposition = "NO_EXTRACTION_TARGET"; violations.push(`${k}: GAP-01 route without a declared use-case owner`); } else out.new_owner = dest ? `${dest[0]}#${dest[1]}` : `${COMPOSITE_DEST}#{${comp.newFns.join(",")}}`; }
        } else if (["router", "default"].includes(b.key) || b.kind === "export-default") {
          out.disposition = c ? "ADAPTER_ROUTER" : "MISSING_ROUTER"; if (!c) violations.push(`${k}: router adapter missing`);
        } else if (b.kind === "type") { out.disposition = c ? "TYPE_RETAINED" : "TYPE_MOVED"; }
        else if (RETIRE_DEAD[k]) {
          const rd = RETIRE_DEAD[k]; const canon_ = findDecl(rd.canonical[1], rd.canonical[0]);
          const refs = []; (function w(n) { if (ts.isIdentifier(n) && n.text === b.key) refs.push(n); ts.forEachChild(n, w); })(old.sf);
          const props = (node, sf) => { const s = new Set(); (function w(n) { if (ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) s.add(n.name.getText(sf)); ts.forEachChild(n, w); })(node); return s; };
          const oldProps = props(b.node, old.sf); const canProps = canon_ ? props(canon_.node, canon_.sf) : new Set();
          const missing = [...oldProps].filter((p) => !canProps.has(p));
          const ok = !c && !b.exported && refs.length === 1 && canon_ && missing.length === 0;
          out.disposition = ok ? "RETIRED_DEAD_DUPLICATE" : "RETIREMENT_UNPROVEN";
          out.retirement_proof = { references_in_baseline: refs.length, exported: b.exported, canonical: rd.canonical.join("#"), properties_only_in_dead_copy: missing, still_declared_in_old_file: Boolean(c) };
          if (!ok) violations.push(`${k}: dead-duplicate retirement not proven (${canon(out.retirement_proof)})`);
        } else if (MOVED_D_VERBATIM[k]) {
          const dest = findDecl(b.key, MOVED_D_VERBATIM[k]); const ok = !c && dest && declFp(dest) === out.baseline_fingerprint;
          out.disposition = ok ? "MOVED_VERBATIM" : "MOVE_UNPROVEN"; out.new_owner = `${MOVED_D_VERBATIM[k]}#${b.key}`;
          if (dest) out.new_metrics = { tokens: tokensOf(dest.node, dest.sf).length, db_chains: featuresOf([dest.node], dest.sf).db_chains.length };
          if (!ok) violations.push(`${k}: expected verbatim move to ${MOVED_D_VERBATIM[k]} — ${c ? "still declared in old file" : dest ? "fingerprint differs" : "destination missing"}`);
        } else {
          // 01-B move: verify the claim against source (the claim itself is only a pointer)
          const fromKey = R(`routes/${f}`) + "#" + b.key; const claim = claimByFrom.get(fromKey);
          if (b.kind === "rule-registration") {
            const destF = "vault/security/entity-ownership.ts"; const abs = path.join(SRC, destF); const dsf = parse(destF, fs.readFileSync(abs, "utf8"));
            const has = dsf.statements.some((s) => ts.isExpressionStatement(s) && fp(s, dsf) === out.baseline_fingerprint);
            out.disposition = !c && has ? "MOVED_VERBATIM" : "MOVE_UNPROVEN"; out.new_owner = `${destF}#${b.key}`; if (out.disposition !== "MOVED_VERBATIM") violations.push(`${k}: rule registration not moved verbatim`);
          } else if (!claim) { out.disposition = "UNACCOUNTED"; violations.push(`${k}: GAP-01 symbol neither retained as adapter, retired, nor moved (no extraction claim)`); }
          else {
            const [dfile, dname] = claim.to.replace(R(""), "").split("#"); const dest = findDecl(dname, dfile);
            const ok = !c && dest && (claim.mode === "renamed" ? renamedFp(dest, dname, b.key) : declFp(dest)) === out.baseline_fingerprint;
            out.disposition = ok ? (claim.mode === "renamed" ? "MOVED_RENAMED" : "MOVED_VERBATIM") : "MOVE_UNPROVEN"; out.new_owner = claim.to;
            if (dest) out.new_metrics = { tokens: tokensOf(dest.node, dest.sf).length, db_chains: featuresOf([dest.node], dest.sf).db_chains.length };
            if (!ok) violations.push(`${k}: claimed move to ${claim.to} not proven (${c ? "old file still declares it" : dest ? "fingerprint differs" : "destination missing"})`);
          }
        }
      } else if (LATER_GAPS.has(owner)) {
        if (untouched || (c && same)) { out.disposition = `DEFERRED_${owner}`; const m = metricsOfSym(c ?? b); (deferredBusiness[owner] ??= { symbols: 0, db_chains: 0, tokens: 0 }); deferredBusiness[owner].symbols++; deferredBusiness[owner].db_chains += m.db_chains; deferredBusiness[owner].tokens += m.tokens; }
        else { out.disposition = "DEFERRED_SYMBOL_MODIFIED"; violations.push(`${k}: belongs to ${owner} but was ${c ? "modified" : "removed"} by GAP-01`); }
      } else { out.disposition = "UNKNOWN_OWNER"; violations.push(`${k}: owner ${owner} is not a known later gap`); }
      rec.symbols.push(out); dispositions.push({ file: f, symbol: b.key, disposition: out.disposition, owner_gap: out.owner_gap });
    }
    // symbols present now that did not exist in the baseline
    for (const c of cur.syms) {
      if (consumed.has(c.key)) continue;
      const okWiring = wiringCheck(c, cur.sf);
      const entry = { symbol: c.key, kind: c.kind, disposition: okWiring ? "NEW_ADAPTER_WIRING" : "NEW_UNCLASSIFIED_SYMBOL", lines: [c.start, c.end] };
      rec.symbols.push(entry);
      if (!okWiring) violations.push(`${f}|${c.key}: new symbol in an old file that is not adapter wiring (${c.kind})`);
    }
    // exports: only default router + later-gap exports may remain
    const exps = cur.syms.filter((s) => s.exported && s.kind !== "type").map((s) => s.key);
    rec.exports = exps;
    files.push(rec);
  }
  return { files, violations, dispositions, thin, deferredBusiness, owners };
}

// ── 2. Static behavior parity: baseline handler vs extracted use-case (independent feature multisets) ────────────────
function staticParity(overlayNew = new Map()) {
  const results = [];
  const usecaseNode = (destRel, name) => { const abs = path.join(SRC, destRel); const txt = overlayNew.get(R(destRel)) ?? fs.readFileSync(abs, "utf8"); const { sf, syms } = scanSymbols(txt, abs); const s = syms.find((x) => x.key === name); return s ? { sf, node: s.node } : null; };
  const baseSyms = {}; for (const f of ["vault.ts", "vault-entity-links.ts"]) baseSyms[f] = scanSymbols(baseText(f), path.join(BASE, "routes", f));
  const curVault = scanSymbols(overlayNew.get(R("routes/vault.ts")) ?? fs.readFileSync(path.join(ROUTES, "vault.ts"), "utf8"), path.join(ROUTES, "vault.ts"));
  const push = (route, dest, diffs, extra = {}) => results.push({ route, use_case: dest, equivalent: diffs.length === 0, differences: diffs, ...extra });
  for (const [f, map] of Object.entries(EXTRACTED_ROUTES)) for (const [rk, [destRel, fn]] of Object.entries(map)) {
    const b = baseSyms[f].syms.find((s) => s.key === rk && s.kind === "route"); const u = usecaseNode(destRel, fn);
    if (!b || !u) { push(rk, `${destRel}#${fn}`, [!b ? "baseline route missing" : "use-case missing"]); continue; }
    const fb = featuresOf([b.handler.body], baseSyms[f].sf), fu = featuresOf([u.node], u.sf, { ignoreCallees: new Set([fn]) });
    push(rk, `${destRel}#${fn}`, parityDiff(fb, fu), { baseline: { db: fb.db_chains.length, tables: [...new Set(fb.table_refs)].length, branches: Object.values(fb.control).reduce((a, x) => a + x, 0), awaits: fb.awaits }, current: { db: fu.db_chains.length, tables: [...new Set(fu.table_refs)].length, branches: Object.values(fu.control).reduce((a, x) => a + x, 0), awaits: fu.awaits } });
  }
  for (const [rk, spec] of Object.entries(COMPOSITE_ROUTES)) {
    const b = baseSyms["vault.ts"].syms.find((s) => s.key === rk && s.kind === "route");
    const bx = spec.baselineExtra.map((n) => baseSyms["vault.ts"].syms.find((s) => s.key === n));
    const nu = spec.newFns.map((n) => usecaseNode(COMPOSITE_DEST, n));
    const curRoute = curVault.syms.find((s) => s.key === rk && s.kind === "route");
    if (!b || bx.some((x) => !x) || nu.some((x) => !x) || !curRoute) { push(rk, COMPOSITE_DEST, ["composite operand missing"]); continue; }
    const fb = featuresOf([b.handler.body, ...bx.map((s) => s.node)], baseSyms["vault.ts"].sf, { ignoreCallees: new Set(spec.newFns) });
    // baseline handler for the two GETs shares the helper bodies; the PDF route additionally calls the streamer, which stays in the route
    const parts = nu.map((x) => ({ n: x.node, sf: x.sf }));
    const feats = [...parts.map((p) => featuresOf([p.n], p.sf, { ignoreCallees: new Set(spec.newFns) })), ...(spec.newIncludesRouteHandler ? [featuresOf([curRoute.handler.body], curVault.sf, { ignoreCallees: new Set(spec.newFns) })] : [])];
    const merged = { db_chains: [], table_refs: [], sql_templates: [], strings: [], numbers: [], calls: [], control: {}, awaits: 0 };
    for (const x of feats) { for (const k of ["db_chains", "table_refs", "sql_templates", "strings", "numbers", "calls"]) merged[k].push(...x[k]); for (const [k, v] of Object.entries(x.control)) merged.control[k] = (merged.control[k] ?? 0) + v; merged.awaits += x.awaits; }
    for (const k of ["db_chains", "table_refs", "sql_templates", "strings", "numbers", "calls"]) merged[k].sort(); merged.control = Object.fromEntries(Object.entries(merged.control).sort());
    // The PDF route streams on success instead of calling res.json, so the shared resolver's explicit `status: 200` (the success
    // discriminator that lets the route stream) has no literal in the baseline PDF handler. Exactly one such 200 is accounted for.
    if (spec.newIncludesRouteHandler) { const i = merged.numbers.indexOf("200"); if (i >= 0 && !fb.numbers.includes("200")) merged.numbers.splice(i, 1); }
    // The adapter itself now does `const r = await resolvePublicReceipt(..); if (!r.receipt) {..}`: exactly one await and one if that replace the inlined
    // token/lookup awaits+ifs. Deduct only when the surplus is exactly that (any other drift still fails).
    if (spec.newIncludesRouteHandler && (merged.control.if ?? 0) - (fb.control.if ?? 0) === 1 && merged.awaits - fb.awaits === 1) { merged.control.if -= 1; merged.awaits -= 1; }
    // The composite decomposition legitimately turns `if (!token)`/`if (!found)` (kept) and moves the 400/404 mapping into the result object,
    // and the PDF spec is now built by buildReceiptPdfSpec (same literals). Compare the same feature vector.
    push(rk, `${COMPOSITE_DEST}#{${spec.newFns.join(",")}}`, parityDiff(fb, merged), { composite: true });
  }
  return results;
}

// ── 3. Duplicate implementation scan ───────────────────────────────────────────────────────────────────────────────
function fnFingerprints(sf, minTokens = 20) {
  const res = [];
  const visit = (node, name) => { const t = tokensOf(node, sf); if (t[0] === "export") t.shift(); if (t.length >= minTokens) res.push({ name, fp: sha256(t.map((x) => (x === name ? "§" : x)).join(" ")), tokens: t.length }); };
  for (const s of sf.statements) {
    if (ts.isFunctionDeclaration(s) && s.name) visit(s, s.name.text);
    if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) if (d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) visit(d, d.name.getText(sf));
    if (ts.isExpressionStatement(s) && ts.isCallExpression(s.expression) && ts.isPropertyAccessExpression(s.expression.expression) && s.expression.expression.expression.getText(sf) === "router") {
      const h = s.expression.arguments[s.expression.arguments.length - 1]; if ((ts.isArrowFunction(h) || ts.isFunctionExpression(h)) && ts.isBlock(h.body)) visit(h.body, `handler:${s.expression.expression.name.text}:${s.expression.arguments[0].getText(sf)}`);
    }
  }
  return res;
}
function duplicateScan({ overlay = new Map() } = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(BASE, "repo-manifest.json"), "utf8")).files;
  const ownerFps = new Map();
  for (const f of ALL_OWNER_FILES()) { const abs = path.join(SRC, f); for (const x of fnFingerprints(parse(f, fs.readFileSync(abs, "utf8")))) ownerFps.set(x.fp, `${R(f)}#${x.name}`); }
  // fingerprints of GAP-01 baseline implementations that must no longer exist in old files
  const baselineGap01 = new Map(); const owners = loadOwners();
  for (const f of OLD_FILES) { const { sf, syms } = scanSymbols(baseText(f), path.join(BASE, "routes", f)); for (const s of syms) { const o = owners.get(`${f}|${s.key}`); if (o?.owner_gap !== "GAP-01") continue; if (s.kind === "route") { const h = s.handler; if (h?.body && ts.isBlock(h.body)) { const t = tokensOf(h.body, sf); if (t.length >= 20) baselineGap01.set(sha256(t.join(" ")), `${f}|${s.key}`); } } else if (s.kind === "function") baselineGap01.set(fp(s.node, sf), `${f}|${s.key}`); } }
  const scanFiles = walkFiles(SRC, [], (p) => /\.(ts|tsx|mjs|js)$/.test(p) && !p.endsWith(".d.ts")).map((p) => [rel(p), fs.readFileSync(p, "utf8"), sha256File(p)]);
  for (const [k, v] of overlay) scanFiles.push([k, v, undefined]);
  const hits = [], remainingBaseline = [], preExisting = [];
  for (const [r, text, hash] of scanFiles) {
    if (r.startsWith(R("vault/")) || r.startsWith("scripts/antas/")) continue;
    if (!/\bfunction\b|=>/.test(text)) continue;
    const sf = parse(r, text); const untouched = hash !== undefined && manifest[r] === hash;
    for (const x of fnFingerprints(sf)) {
      const o = ownerFps.get(x.fp);
      if (o) (untouched ? preExisting : hits).push({ file: r, symbol: x.name, duplicates: o, tokens: x.tokens, ...(untouched ? { reason: "file unchanged since baseline; pre-dates the extraction (independent idiom, not extracted code)" } : {}) });
      const bl = baselineGap01.get(x.fp); if (bl) remainingBaseline.push({ file: r, symbol: x.name, same_as_baseline_gap01: bl });
    }
    // baseline GAP-01 route bodies inside old files (handler: prefix is not used above for the route bodies here, so scan routes directly)
  }
  for (const f of OLD_FILES) { // old files: route handler bodies identical to a baseline GAP-01 handler body would mean the old logic survived
    const r = R(`routes/${f}`); const text = overlay.get(r) ?? fs.readFileSync(path.join(ROUTES, f), "utf8"); const { sf, syms } = scanSymbols(text, path.join(ROUTES, f));
    for (const s of syms) if (s.kind === "route" && ts.isBlock(s.handler.body)) { const t = tokensOf(s.handler.body, sf); if (t.length < 20) continue; const bl = baselineGap01.get(sha256(t.join(" "))); if (bl) remainingBaseline.push({ file: r, symbol: s.key, same_as_baseline_gap01: bl }); }
  }
  const dupRoutes = []; // two owner modules implementing the same body
  const seen = new Map(); for (const f of ALL_OWNER_FILES()) for (const x of fnFingerprints(parse(f, fs.readFileSync(path.join(SRC, f), "utf8")))) { if (seen.has(x.fp) && seen.get(x.fp).split("#")[0] !== f) dupRoutes.push({ a: seen.get(x.fp), b: `${f}#${x.name}` }); else seen.set(x.fp, `${f}#${x.name}`); }
  return { hits, remainingBaseline, preExisting, ownerDuplicates: dupRoutes, owner_functions_fingerprinted: ownerFps.size };
}

// ── 4. Hidden import / bypass scan (repository-wide) ────────────────────────────────────────────────────────────────
function movedNames(dispositions) { return new Set(dispositions.filter((d) => /^MOVED|^RETIRED/.test(d.disposition)).map((d) => d.symbol)); }
function hiddenImportScan(moved, overlay = new Map()) {
  const roots = ["artifacts", "scripts", "tests", "lib", "services", "apps", "packages"].map((d) => path.join(ROOT, d)).filter((d) => fs.existsSync(d));
  const files = []; for (const d of roots) walkFiles(d, files, (p) => /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(p) && !p.endsWith(".d.ts"));
  const oldAbs = new Map(OLD_FILES.map((f) => [path.join(ROUTES, f.replace(/\.ts$/, "")), f]));
  const all = [...files.map((f) => [rel(f), fs.readFileSync(f, "utf8"), f]), ...[...overlay].map(([k, v]) => [k, v, path.join(ROOT, k)])];
  const edges = [], violations = [];
  for (const [r, text, abs] of all) {
    if (r.startsWith("scripts/antas/") || r.startsWith("reports/")) continue;
    if (!/vault/.test(text)) continue;
    const sf = parse(r, text);
    for (const im of importsOf(sf, abs)) {
      let target = null;
      if (im.abs) target = oldAbs.get(im.abs) ?? null; else { const m = im.spec.match(/(?:^|\/)routes\/(vault(?:-entity-links|-snapshot|-shares)?)$/); if (m) target = `${m[1]}.ts`; }
      if (!target) continue;
      const isOld = OLD_FILES.some((f) => R(`routes/${f}`) === r);
      for (const n of im.names) {
        const e = { consumer: r, target: R(`routes/${target}`), symbol: n.imported, kind: im.kind, line: im.line };
        if (n.imported !== "*" && n.imported !== "default" && moved.has(n.imported)) { e.verdict = "HIDDEN_BYPASS"; violations.push(`${r}:${im.line} imports moved symbol ${n.imported} from ${target}`); }
        else if (im.kind === "dynamic-import" || im.kind === "require") { e.verdict = n.imported === "*" ? "DYNAMIC_UNKNOWN_NAMES" : "dynamic-named"; if (n.imported === "*") violations.push(`${r}:${im.line} dynamic ${im.kind} of ${target} with unknown member use`); }
        else if (im.kind === "re-export" && n.imported === "*" && r !== R("vault/api/index.ts")) { e.verdict = "STAR_REEXPORT"; violations.push(`${r}:${im.line} star re-export of ${target}`); }
        else e.verdict = "ok";
        if (isOld) e.verdict = e.verdict === "ok" ? "old-to-old" : e.verdict;
        edges.push(e);
      }
      // namespace import: inspect member use
      for (const n of im.names.filter((x) => x.imported === "*" && im.kind === "import")) {
        (function w(nn) { if (ts.isPropertyAccessExpression(nn) && ts.isIdentifier(nn.expression) && nn.expression.text === n.local && moved.has(nn.name.text)) violations.push(`${r} uses ${n.local}.${nn.name.text} (moved symbol) via namespace import of ${target}`); ts.forEachChild(nn, w); })(sf);
      }
    }
  }
  return { edges, violations };
}

// ── 5. Layering: extracted application code must not depend on the API layer ──────────────────────────────────────
function layeringScan(overlay = new Map()) {
  const v = [];
  for (const f of ALL_OWNER_FILES()) {
    const r = R(f); const abs = path.join(SRC, f); const text = overlay.get(r) ?? fs.readFileSync(abs, "utf8"); const sf = parse(f, text);
    const isApp = f.startsWith("vault/application/") || f.startsWith("vault/domain/") || f.startsWith("vault/infrastructure/");
    for (const im of importsOf(sf, abs)) {
      if (im.abs && /\/routes(\/|$)/.test(im.abs.split(path.sep).join("/"))) v.push(`${f}:${im.line} imports from the API route layer (${im.spec})`);
      if (isApp && im.spec === "express" && !im.typeOnly) v.push(`${f}:${im.line} runtime import of express in ${f.split("/")[1]} layer`);
      if (isApp && /^\.\.\/.*middlewares\//.test(im.spec)) v.push(`${f}:${im.line} imports middleware in ${f.split("/")[1]} layer`);
    }
    if (f.startsWith("vault/application/entity/") && /\breq\b\s*[.:,)]|\bres\b\s*[.:,)]/.test(text.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, ""))) v.push(`${f}: references Express req/res identifiers`);
  }
  return v;
}

// ── 6. Differential behavior + security regression (old baseline vs current, identical stubs) ─────────────────────
const ok = (value) => ({ value }); const boom = (m = "db down") => ({ throw: m });
const tableProxy = (name) => new Proxy({ __table: name }, { get: (t, p) => (p === "__table" ? name : typeof p === "symbol" || p === "then" ? undefined : { __col: `${name}.${String(p)}` }) });
function mkEnv(script, flags = {}) {
  const env = createEnv(script); const st = env.stubs; const log = env.log;
  st["@workspace/db"].valueHistoryTable = tableProxy("valueHistoryTable");
  st["vault/application/entity/representation"] = { formatVaultEntry: (e) => ({ ...e }) };
  delete st["vault/domain/secret-fields"]; // real allow-list
  const crypto = { encryptField: (v) => { log.push(["encryptField", summ(v)]); return v == null ? v : `enc(${v})`; }, decryptField: (v) => { log.push(["decryptField", summ(v)]); return v == null ? v : `dec(${v})`; }, decryptRows: (rows, f) => { log.push(["decryptRows", summ([rows.length, f])]); return rows.map((r) => ({ ...r, _decrypted: true })); } };
  st["lib/vault-crypto"] = crypto; st["vault/crypto/field-encryption"] = crypto;
  st["vault/crypto/seed-phrase"] = { encryptSeedPhrase: (v) => { log.push(["encryptSeedPhrase", v]); return `seed(${v})`; }, decryptSeedPhrase: (v) => { log.push(["decryptSeedPhrase", v]); return `unseed(${v})`; } };
  st["vault/domain/serial"] = { generateSerial: (u) => { log.push(["generateSerial", u]); return `S-${u}-1`; } };
  st["vault/application/health"] = { computeAutoScore: () => 5, evalHealthRules: () => [], severityEmoji: () => "!" };
  st["lib/entity-worth"] = { computeEntityWorth: (e) => Number(e.currentValue ?? 0), computeEntityBuyValue: (e) => Number(e.currentBuyValue ?? 0), computeEntityProfitPct: (e) => (Number(e.currentBuyValue) > 0 ? ((Number(e.currentValue) - Number(e.currentBuyValue)) / Number(e.currentBuyValue)) * 100 : null), computeAge: (d) => (d ? "1y" : null) };
  st["lib/receipt-theme"] = { streamFantasticReceiptPdf: (res, spec) => { log.push(["streamFantasticReceiptPdf", summ(spec)]); } };
  st["lib/gas-health"] = { getGasOverview: async (addrs, chains) => { log.push(["getGasOverview", summ([addrs, chains])]); if (flags.gasThrows) throw new Error("rpc down"); return { totalUsd: 12.345, worstRisk: addrs.length > 1 ? "critical" : "warning", snapshots: [{ chain: "ETH", balance: 1, error: null }, { chain: "BASE", balance: 0, error: null }, { chain: "OP", balance: 0, error: "x" }] }; } };
  Object.assign(st["services/sync"], { syncOnVaultUpdate: (id) => { log.push(["syncOnVaultUpdate", id]); return Promise.resolve(); }, syncOnVaultStatusChange: (id, s) => { log.push(["syncOnVaultStatusChange", [id, s]]); return Promise.resolve(); } });
  st.crypto = { randomBytes: (n) => { log.push(["randomBytes", n]); return { toString: () => "TOKEN" }; } };
  return env;
}
const U = { user: { userId: 7 } };
const ent = (o = {}) => ({ id: 5, userId: 7, projectName: "P", status: "active", tags: ["a"], currentValue: 100, currentBuyValue: 50, score: 8, twitterWorth: "10", twitterBuyValue: "4", discordWorth: "2", twitter2fa: "x", entitySerial: "S-5", walletAddresses: '["0xabc"]', deletedAt: null, receiptToken: null, encryptedSeedPhrase: "es", category: "c", username: "u", followers: 3, createDate: "2020", ...o });
const K = sqlKeyOf; const SEL = "db.select:vaultEntriesTable", UPD = "db.update:vaultEntriesTable", INS = "db.insert:vaultEntriesTable", INS_A = "db.insert:vaultActivityLogTable", INS_H = "db.insert:vaultFieldHistoryTable", SEL_A = "db.select:vaultActivityLogTable", SEL_H = "db.select:vaultFieldHistoryTable", SEL_V = "db.select:valueHistoryTable", SEL_U = "db.select:usersTable";
const CASES = [];
const add = (name, method, p, req, script = {}, cat = "success", flags = {}) => CASES.push({ name, method, path: p, req: { ...U, params: {}, body: {}, query: {}, ...req }, script, cat, flags });
const FB = K("SELECT id, user_id, entity_serial,");
// gas
add("gas-overview: success (addresses, mixed risk)", "GET", "/vault/gas-overview", {}, { [SEL]: [ok([ent(), ent({ id: 6, walletAddresses: "[]" }), ent({ id: 7, walletAddresses: '["a","b"]', driveWalletAddress: "d" })])] });
add("gas-overview: provider failure -> 500", "GET", "/vault/gas-overview", {}, { [SEL]: [ok([ent()])] }, "failure", { gasThrows: true });
add("gas-overview: db + fallback failure -> 500", "GET", "/vault/gas-overview", {}, { [SEL]: [boom()], [FB.replace("SELECT id, user_id, entity_serial,", "")]: [] , ["db.execute:" + K("SELECT id, user_id, entity_serial, category")]: [boom()] }, "failure");
add("entity gas: success", "GET", "/vault/:id/gas", { params: { id: "5" } }, { [SEL]: [ok([ent()])] });
add("entity gas: array id param", "GET", "/vault/:id/gas", { params: { id: ["5", "9"] } }, { [SEL]: [ok([ent()])] });
add("entity gas: not owned -> 404", "GET", "/vault/:id/gas", { params: { id: "5" } }, { [SEL]: [ok([])] }, "security");
add("entity gas: no addresses", "GET", "/vault/:id/gas", { params: { id: "5" } }, { [SEL]: [ok([ent({ walletAddresses: null })])] });
add("entity gas: provider failure -> 500", "GET", "/vault/:id/gas", { params: { id: "5" } }, { [SEL]: [ok([ent()])] }, "failure", { gasThrows: true });
// create
const FULL_BODY = { projectName: "Proj", username: "u", accountPassword: "pw", email: "e@x.io", emailPassword: "ep", email2fa: "2", twitterUsername: "tw", twitterPassword: "tp", discordUsername: "dc", telegramUsername: "tg", walletAddresses: ["0x1"], backupCodes: ["b1"], notes: "n", otherAccounts: "oa", tags: ["t"], seedPhrase: "seed words", lastLoginAt: "2024-01-02", twitterBuyDate: "2023-05-05", score: 11, dataEntityId: "4", twitterFollowers: "10" };
add("create: validation projectName required -> 400", "POST", "/vault", { body: {} }, {}, "failure");
add("create: success full payload (encrypt, audit, bridge)", "POST", "/vault", { body: FULL_BODY }, { [INS]: [ok([ent({ id: 11 })])], ["db.execute:" + K("SELECT id FROM local_accounts")]: [ok({ rows: [] }), ok({ rows: [] }), ok({ rows: [] })] });
add("create: minimal payload defaults score", "POST", "/vault", { body: { projectName: "Min", score: "abc" } }, { [INS]: [ok([ent({ id: 12 })])] });
add("create: schema fallback insert", "POST", "/vault", { body: FULL_BODY }, { [INS]: [boom("col missing"), ok([ent({ id: 13 })])] });
add("create: both inserts fail -> propagates", "POST", "/vault", { body: FULL_BODY }, { [INS]: [boom("a"), boom("b")] }, "failure");
// bulk-tag
add("bulk-tag: ids required -> 400", "PATCH", "/vault/bulk-tag", { body: { tag: "x" } }, {}, "failure");
add("bulk-tag: tag required -> 400", "PATCH", "/vault/bulk-tag", { body: { ids: [1], tag: "  " } }, {}, "failure");
add("bulk-tag: add (owned, foreign/missing, NaN)", "PATCH", "/vault/bulk-tag", { body: { ids: [5, 6, "zz"], tag: " new " } }, { [SEL]: [ok([{ id: 5, userId: 7 }, { id: 6, userId: 9 }]), ok([ent()]), ok([])] });
add("bulk-tag: remove", "PATCH", "/vault/bulk-tag", { body: { ids: [5], tag: "a", action: "remove" } }, { [SEL]: [ok([{ id: 5, userId: 7 }]), ok([ent()])] });
add("bulk-tag: update failure is per-id ok:false", "PATCH", "/vault/bulk-tag", { body: { ids: [5], tag: "z" } }, { [SEL]: [ok([{ id: 5, userId: 7 }]), ok([ent()])], [UPD]: [boom()] }, "failure");
// bulk-action
add("bulk-action: ids required -> 400", "PATCH", "/vault/bulk-action", { body: { action: "tag" } }, {}, "failure");
add("bulk-action: >200 ids -> 400", "PATCH", "/vault/bulk-action", { body: { ids: Array.from({ length: 201 }, (_, i) => i), action: "delete" } }, {}, "failure");
add("bulk-action: no valid ids -> 400", "PATCH", "/vault/bulk-action", { body: { ids: ["a", "b"], action: "delete" } }, {}, "failure");
add("bulk-action: tag missing -> 400", "PATCH", "/vault/bulk-action", { body: { ids: [1], action: "tag" } }, {}, "failure");
add("bulk-action: tag add", "PATCH", "/vault/bulk-action", { body: { ids: [5, 6], action: "tag", tag: "t" } }, { [SEL]: [ok([{ id: 5, userId: 7 }]), ok([ent()]), ok([])] });
add("bulk-action: status invalid -> 400", "PATCH", "/vault/bulk-action", { body: { ids: [1], action: "status", status: "nope" } }, {}, "failure");
add("bulk-action: status success + row missing", "PATCH", "/vault/bulk-action", { body: { ids: [5, 6], action: "status", status: "banned" } }, { [SEL]: [ok([{ id: 5, userId: 7 }, { id: 6, userId: 8 }])], [UPD]: [ok([ent()]), ok([])] });
add("bulk-action: status update failure", "PATCH", "/vault/bulk-action", { body: { ids: [5], action: "status", status: "active" } }, { [SEL]: [ok([{ id: 5, userId: 7 }])], [UPD]: [boom()] }, "failure");
add("bulk-action: delete (soft) + foreign row not touched", "PATCH", "/vault/bulk-action", { body: { ids: [5, 6], action: "delete" } }, { [SEL]: [ok([{ id: 5, userId: 7 }, { id: 6, userId: 8 }])], [UPD]: [ok([ent()]), ok([])] }, "security");
add("bulk-action: unknown action -> 400", "PATCH", "/vault/bulk-action", { body: { ids: [1], action: "zzz" } }, {}, "failure");
// analytics
add("analytics: success (roi, platforms, 2fa)", "GET", "/vault/analytics", {}, { [SEL]: [ok([ent(), ent({ id: 6, projectName: "Q", currentValue: 10, currentBuyValue: 40, twitter2fa: null, twitterWorth: "0" }), ent({ id: 7, projectName: null, currentBuyValue: 0, score: 0 })])] });
add("analytics: empty", "GET", "/vault/analytics", {}, { [SEL]: [ok([])] });
add("analytics: failure -> 500", "GET", "/vault/analytics", {}, { [SEL]: [boom()], ["db.execute:" + K("SELECT id, user_id, entity_serial, category")]: [boom()] }, "failure");
add("value-history: success", "GET", "/vault/analytics/value-history", {}, { [SEL_V]: [ok([{ id: 1, createdAt: new Date("2024-01-01T00:00:00Z") }])] });
add("value-history: failure -> 500", "GET", "/vault/analytics/value-history", {}, { [SEL_V]: [boom()] }, "failure");
// activity
add("my activity: defaults", "GET", "/vault/activity", {}, { [SEL_A]: [ok([{ log: { id: 1, createdAt: new Date("2024-01-01T00:00:00Z") }, entitySerial: "S", entityId: 5 }, { log: { id: 2, createdAt: new Date("2024-01-02T00:00:00Z") }, entitySerial: null, entityId: null }])], ["db.execute:" + K("SELECT COUNT(*)::int as count")]: [ok({ rows: [{ count: 2 }] })] });
add("my activity: page/limit clamps", "GET", "/vault/activity", { query: { page: "0", limit: "9999" } }, { [SEL_A]: [ok([])], ["db.execute:" + K("SELECT COUNT(*)::int as count")]: [ok({ rows: [{ count: 0 }] })] });
add("my activity: failure -> 500", "GET", "/vault/activity", {}, { [SEL_A]: [boom()] }, "failure");
add("entity activity: success", "GET", "/vault/:id/activity", { params: { id: "5" } }, { [SEL]: [ok([ent()])], [SEL_A]: [ok([{ id: 1, createdAt: new Date("2024-01-01T00:00:00Z") }])] });
add("entity activity: not owned -> 404", "GET", "/vault/:id/activity", { params: { id: "5" } }, { [SEL]: [ok([])] }, "security");
add("entity activity: failure -> 500", "GET", "/vault/:id/activity", { params: { id: "5" } }, { [SEL]: [ok([ent()])], [SEL_A]: [boom()] }, "failure");
// update
const UPD_BODY = { projectName: "N", email: "e@x", emailPassword: "pw", username: "u", accountPassword: "ap", lastLoginAt: "2024-03-03", lastLoginAtX: 1, followers: "12.6", dataEntityId: "9", walletAddresses: ["0x1"], backupCodes: ["c"], tags: "notarray", otherAccounts: "oa", seedPhrase: "seed words", status: "banned", score: "7.4", currentValue: "12", currentBuyValue: "abc", twitterBanned: true };
add("update: full body (status change path)", "PATCH", "/vault/:id", { params: { id: "5" }, body: UPD_BODY }, { [UPD]: [ok([ent()])], ["db.execute:" + K("SELECT id FROM local_accounts")]: [ok({ rows: [] })] });
add("update: non-status body (updated path + sync)", "PATCH", "/vault/:id", { params: { id: "5" }, body: { projectName: "Z", seedPhrase: "", tags: ["x"], followers: "abc", status: "bogus" } }, { [UPD]: [ok([ent()])] });
add("update: not found -> 404", "PATCH", "/vault/:id", { params: { id: "5" }, body: { projectName: "Z" } }, { [UPD]: [ok([])] }, "security");
add("update: schema fallback succeeds", "PATCH", "/vault/:id", { params: { id: "5" }, body: UPD_BODY }, { [UPD]: [boom("col"), ok([ent()])] });
add("update: fallback row missing -> 404", "PATCH", "/vault/:id", { params: { id: "5" }, body: UPD_BODY }, { [UPD]: [boom("col"), ok([])] }, "security");
add("update: both updates fail -> propagates", "PATCH", "/vault/:id", { params: { id: "5" }, body: UPD_BODY }, { [UPD]: [boom("a"), boom("b")] }, "failure");
add("field: unknown field -> 400", "PATCH", "/vault/:id/field", { params: { id: "5" }, body: { field: "hax", value: 1 } }, {}, "failure");
add("field: not owned -> 404", "PATCH", "/vault/:id/field", { params: { id: "5" }, body: { field: "notes", value: "x" } }, { [SEL]: [ok([])] }, "security");
add("field: sensitive field success (history + bridge)", "PATCH", "/vault/:id/field", { params: { id: "5" }, body: { field: "twitterPassword", value: "newpw" } }, { [SEL]: [ok([ent({ twitterPassword: "old" })])], [UPD]: [ok([ent()])], [INS_H]: [ok([])] });
add("field: date field", "PATCH", "/vault/:id/field", { params: { id: "5" }, body: { field: "buyDate", value: "2024-02-02" } }, { [SEL]: [ok([ent({ buyDate: "2023-01-01" })])], [UPD]: [ok([ent()])] });
add("field: followers NaN -> 400", "PATCH", "/vault/:id/field", { params: { id: "5" }, body: { field: "followers", value: "abc" } }, { [SEL]: [ok([ent()])] }, "failure");
add("field: followers rounds", "PATCH", "/vault/:id/field", { params: { id: "5" }, body: { field: "followers", value: -4.4 } }, { [SEL]: [ok([ent()])], [UPD]: [ok([ent()])] });
add("field: empty value -> null", "PATCH", "/vault/:id/field", { params: { id: "5" }, body: { field: "notes", value: "" } }, { [SEL]: [ok([ent({ notes: "old" })])], [UPD]: [ok([ent()])] });
add("field: update returns no row -> 404", "PATCH", "/vault/:id/field", { params: { id: "5" }, body: { field: "notes", value: "x" } }, { [SEL]: [ok([ent()])], [UPD]: [ok([])] }, "security");
add("field: update failure -> 500", "PATCH", "/vault/:id/field", { params: { id: "5" }, body: { field: "notes", value: "x" } }, { [SEL]: [ok([ent()])], [UPD]: [boom()] }, "failure");
add("field-history: not owned -> 404", "GET", "/vault/:id/field-history", { params: { id: "5" } }, { [SEL]: [ok([])] }, "security");
add("field-history: success", "GET", "/vault/:id/field-history", { params: { id: "5" } }, { [SEL]: [ok([{ id: 5 }])], [SEL_H]: [ok([{ id: 1, field: "notesX", oldValue: "a", newValue: "b", changedAt: new Date("2024-01-01T00:00:00Z") }])] });
add("field-history: filtered", "GET", "/vault/:id/field-history", { params: { id: "5" }, query: { field: "notes" } }, { [SEL]: [ok([{ id: 5 }])], [SEL_H]: [ok([])] });
add("field-history: failure -> 500", "GET", "/vault/:id/field-history", { params: { id: "5" } }, { [SEL]: [ok([{ id: 5 }])], [SEL_H]: [boom()] }, "failure");
// admin
const ADM = [{ entry: ent({ encryptedSeedPhrase: "es" }), username: "adm", userEmail: "a@x" }];
add("admin list: success", "GET", "/admin/vault", {}, { "db.select:": [ok(ADM)] , [SEL]: [ok(ADM)] });
add("admin list: falls back to selectVault(0)", "GET", "/admin/vault", {}, { [SEL]: [boom(), ok([ent()])] });
add("admin full: success (seed decrypted)", "GET", "/admin/vault/full", {}, { [SEL]: [ok(ADM)] });
add("admin full: failure -> 500", "GET", "/admin/vault/full", {}, { [SEL]: [boom()] }, "failure");
add("admin local-accounts: success", "GET", "/admin/vault/local-accounts", {}, { ["db.execute:" + K("SELECT la.*, u.username, u.email")]: [ok({ rows: [{ id: 1, password: "p" }] })] });
add("admin local-accounts: failure -> 500", "GET", "/admin/vault/local-accounts", {}, { ["db.execute:" + K("SELECT la.*, u.username, u.email")]: [boom()] }, "failure");
add("admin users: success", "GET", "/admin/vault/users", {}, { ["db.execute:" + K("SELECT u.id, u.username, u.email,")]: [ok({ rows: [{ id: 1 }] })] });
add("admin users: failure -> 500", "GET", "/admin/vault/users", {}, { ["db.execute:" + K("SELECT u.id, u.username, u.email,")]: [boom()] }, "failure");
add("admin user vault: invalid id -> 400", "GET", "/admin/vault/users/:userId", { params: { userId: "zz" } }, {}, "failure");
add("admin user vault: success (+missing user)", "GET", "/admin/vault/users/:userId", { params: { userId: "9" } }, { [SEL]: [ok([ent({ encryptedSeedPhrase: "es" })])], [SEL_U]: [ok([])], ["db.execute:" + K("SELECT * FROM local_accounts WHERE")]: [ok({ rows: [{ id: 3 }] })] });
add("admin user vault: user found, array param", "GET", "/admin/vault/users/:userId", { params: { userId: ["9", "1"] } }, { [SEL]: [ok([ent()])], [SEL_U]: [ok([{ id: 9, username: "n", email: "e" }])] });
add("admin user vault: failure -> 500", "GET", "/admin/vault/users/:userId", { params: { userId: "9" } }, { [SEL]: [boom()] }, "failure");
add("admin activity: success", "GET", "/admin/vault/activity", { query: { page: "2", limit: "5" } }, { [SEL_A]: [ok([{ log: { id: 1, createdAt: new Date("2024-01-01T00:00:00Z") }, username: null }])] });
add("admin activity: failure -> 500", "GET", "/admin/vault/activity", {}, { [SEL_A]: [boom()] }, "failure");
// receipts
add("receipt create: invalid id -> 400", "POST", "/vault/:id/receipt", { params: { id: "zz" } }, {}, "failure");
add("receipt create: not owned -> 404", "POST", "/vault/:id/receipt", { params: { id: "5" } }, { [SEL]: [ok([])] }, "security");
add("receipt create: existing token", "POST", "/vault/:id/receipt", { params: { id: "5" } }, { [SEL]: [ok([{ id: 5, receiptToken: "OLD" }])] });
add("receipt create: mints token", "POST", "/vault/:id/receipt", { params: { id: "5" } }, { [SEL]: [ok([{ id: 5, receiptToken: null }])], [UPD]: [ok([{ receiptToken: "TOKEN" }])] });
add("receipt create: 3 collisions -> 500", "POST", "/vault/:id/receipt", { params: { id: "5" } }, { [SEL]: [ok([{ id: 5, receiptToken: null }])], [UPD]: [boom("dup"), boom("dup"), boom("dup")] }, "failure");
add("receipt create: db failure -> 500", "POST", "/vault/:id/receipt", { params: { id: "5" } }, { [SEL]: [boom()] }, "failure");
add("receipt revoke: invalid id -> 400", "DELETE", "/vault/:id/receipt", { params: { id: "zz" } }, {}, "failure");
add("receipt revoke: not owned -> 404", "DELETE", "/vault/:id/receipt", { params: { id: "5" } }, { [UPD]: [ok([])] }, "security");
add("receipt revoke: success", "DELETE", "/vault/:id/receipt", { params: { id: "5" } }, { [UPD]: [ok([{ id: 5 }])] });
add("public receipt: missing token -> 400", "GET", "/vault/receipt/:token", { params: { token: "" } }, {}, "failure");
add("public receipt: unknown -> 404", "GET", "/vault/receipt/:token", { params: { token: "T" } }, { [SEL]: [ok([])] }, "security");
add("public receipt: success (array token)", "GET", "/vault/receipt/:token", { params: { token: ["T", "U"] } }, { [SEL]: [ok([ent({ receiptToken: "T" })])], [SEL_U]: [ok([{ username: "own" }])] });
add("public receipt pdf: unknown -> 404", "GET", "/vault/receipt/:token/pdf", { params: { token: "T" } }, { [SEL]: [ok([])] }, "security");
add("public receipt pdf: missing token -> 400", "GET", "/vault/receipt/:token/pdf", { params: { token: "" } }, {}, "failure");
add("public receipt pdf: streams (profit)", "GET", "/vault/receipt/:token/pdf", { params: { token: "T" } }, { [SEL]: [ok([ent({ receiptToken: "T" })])], [SEL_U]: [ok([{ username: "own" }])] });
add("public receipt pdf: streams (no buy value)", "GET", "/vault/receipt/:token/pdf", { params: { token: "T" } }, { [SEL]: [ok([ent({ receiptToken: "T", currentBuyValue: 0, projectName: null, entitySerial: null })])], [SEL_U]: [ok([])] });

// lifecycle + entity-link routes (GAP-01 ownership-gated; deny bodies/actions compared old vs new)
const SEL_L = "db.select:vaultEntityLinksTable", UPD_L = "db.update:vaultEntityLinksTable", DEL_L = "db.delete:vaultEntityLinksTable";
const trashed = (o = {}) => ent({ deletedAt: new Date("2024-01-01T00:00:00Z"), ...o });
add("get entity: success (charge on success)", "GET", "/vault/:id", { params: { id: "5" } }, { [SEL]: [ok([ent()])] });
add("get entity: not found -> 404, no charge", "GET", "/vault/:id", { params: { id: "5" } }, { [SEL]: [ok([])] }, "security");
add("trash entity: success (delist, audit, broadcast)", "DELETE", "/vault/:id", { params: { id: "5" } }, { [SEL]: [ok([ent()])] });
add("trash entity: foreign/missing -> 404", "DELETE", "/vault/:id", { params: { id: "5" } }, { [SEL]: [ok([])] }, "security");
add("restore entity: success", "POST", "/vault/:id/restore", { params: { id: "5" } }, { [SEL]: [ok([trashed()])] });
add("restore entity: not trashed/foreign -> 404", "POST", "/vault/:id/restore", { params: { id: "5" } }, { [SEL]: [ok([])] }, "security");
add("purge entity: success (hard delete + sync)", "DELETE", "/vault/trash/:id", { params: { id: "5" } }, { [SEL]: [ok([trashed()])] });
add("purge entity: not trashed/foreign -> 404", "DELETE", "/vault/trash/:id", { params: { id: "5" } }, { [SEL]: [ok([])] }, "security");
add("entity links: success (forward + counterpart)", "GET", "/vault/:id/links", { params: { id: "5" } }, { [SEL]: [ok([{ id: 5, projectName: "P", username: "u", category: "c", entitySerial: "S-5", status: "active" }]), ok([{ id: 6, projectName: "Q", username: "v", category: "c", status: "active" }])], [SEL_L]: [ok([{ id: 1, entityId: 5, linkedEntityId: 6, relationType: "related", note: "n", createdAt: new Date("2024-01-01T00:00:00Z") }])] });
add("entity links: invalid id -> 400", "GET", "/vault/:id/links", { params: { id: "zz" } }, {}, "failure");
add("entity links: not owned -> 404", "GET", "/vault/:id/links", { params: { id: "5" } }, { [SEL]: [ok([])] }, "security");
add("update link: success (note only)", "PATCH", "/vault-entity-links/:id", { params: { id: "1" }, body: { note: " hi " } }, { [UPD_L]: [ok([{ id: 1, relationType: "related", note: "hi", createdAt: new Date("2024-01-01T00:00:00Z") }])] });
add("update link: bad relationType -> 400", "PATCH", "/vault-entity-links/:id", { params: { id: "1" }, body: { relationType: "nope" } }, {}, "failure");
add("update link: foreign/missing -> 404", "PATCH", "/vault-entity-links/:id", { params: { id: "1" }, body: { note: "x" } }, { [UPD_L]: [ok([])] }, "security");
add("delete link: success", "DELETE", "/vault-entity-links/:id", { params: { id: "1" } }, { [DEL_L]: [ok([{ id: 1 }])] });
add("delete link: invalid id -> 400", "DELETE", "/vault-entity-links/:id", { params: { id: "x" } }, {}, "failure");
add("delete link: foreign/missing -> 404", "DELETE", "/vault-entity-links/:id", { params: { id: "1" } }, { [DEL_L]: [ok([])] }, "security");

async function runCase(c, which, { overrides, routesOverride } = {}) {
  const env = mkEnv(c.script, c.flags);
  if (overrides) for (const [k, v] of overrides) env.overrides.set(k, v);
  const L = createLoader({ ts, root: ROOT, srcDir: SRC, env });
  if (which === "old") { env.stubs["routes/vault-entity-links"] = L.loadText(baseText("vault-entity-links.ts"), "vault-entity-links.ts", ROUTES); L.loadText(baseText("vault.ts"), "vault.ts", ROUTES); }
  else { L.loadFile(path.join(ROUTES, "vault-entity-links.ts")); if (routesOverride) L.loadText(routesOverride, "vault.ts", ROUTES); else L.loadFile(path.join(ROUTES, "vault.ts")); }
  env.log.splice(0);
  const r = env.routes.find((x) => x.method === c.method && x.path === c.path);
  if (!r) return { missingRoute: true };
  const stack = [];
  for (const m of r.stack.slice(0, -1)) {
    const s = { name: m?.name || "anon" };
    if (m?.__ownership) { const res = fakeRes(); m.__ownership.opts.onDeny({}, res); s.ownership = { action: m.__ownership.action, deny: { status: res.statusCode, body: summ(res.body) }, observer: m.__ownership.opts.onDecision?.__stub }; }
    stack.push(s);
  }
  const res = fakeRes(); let threw = null; const oe = console.error, ow = console.warn;
  console.error = (...a) => env.log.push(["console.error", String(a[0]).slice(0, 80)]); console.warn = () => {};
  // Frozen clock: old and new run under the identical instant so wall-clock fields (e.g. receipt `generatedAt`) cannot cause false diffs.
  const RealDate = globalThis.Date; const FROZEN = RealDate.parse("2026-01-01T00:00:00.000Z");
  globalThis.Date = class extends RealDate { constructor(...a) { if (a.length === 0) super(FROZEN); else super(...a); } static now() { return FROZEN; } };
  try { await r.stack[r.stack.length - 1](c.req, res); } catch (e) { threw = String(e.message); }
  await new Promise((x) => setTimeout(x, 5));
  globalThis.Date = RealDate;
  console.error = oe; console.warn = ow;
  return { status: res.statusCode ?? 200, body: summ(res.body), threw, log: env.log, stack };
}
function diffRuns(a, b) {
  if (a.missingRoute || b.missingRoute) return [`route missing (old=${!a.missingRoute} new=${!b.missingRoute})`];
  const d = [];
  if (a.status !== b.status) d.push(`status ${a.status} != ${b.status}`);
  if (canon(a.body) !== canon(b.body)) d.push(`body differs: ${canon(a.body).slice(0, 140)} vs ${canon(b.body).slice(0, 140)}`);
  if (a.threw !== b.threw) d.push(`threw ${a.threw} != ${b.threw}`);
  if (canon(a.stack) !== canon(b.stack)) d.push("middleware/ownership stack differs");
  const sa = a.log.map(canon), sb = b.log.map(canon);
  if (canon([...sa].sort()) !== canon([...sb].sort())) d.push(`side-effect multiset differs: -${sa.filter((x) => !sb.includes(x)).slice(0, 2).join("|")} +${sb.filter((x) => !sa.includes(x)).slice(0, 2).join("|")}`);
  const grp = (l) => { const g = {}; for (const e of l) (g[e[0]] ??= []).push(canon(e)); return g; };
  const ga = grp(a.log), gb = grp(b.log);
  for (const k of new Set([...Object.keys(ga), ...Object.keys(gb)])) if (canon(ga[k]) !== canon(gb[k])) { d.push(`ordered side-effects differ for ${k}`); break; }
  return d;
}
async function differentialSuite(opts = {}, only = null) {
  const out = [];
  for (const c of CASES) {
    if (only && !only(c)) continue;
    const o = await runCase(c, "old"), n = await runCase(c, "new", opts);
    const diffs = diffRuns(o, n);
    out.push({ name: c.name, route: `${c.method} ${c.path}`, category: c.cat, passed: diffs.length === 0, differences: diffs, calls_old: o.log?.length ?? 0, calls_new: n.log?.length ?? 0, response_status: n.status ?? null, exercised: (o.log?.length ?? 0) > 0 || Boolean(o.status), stack: n.stack });
  }
  return out;
}

// ── 7. Differential typecheck (dependencies are not installed in the upload => degraded, and labelled as such) ───────
function typecheckDifferential() {
  const cfgRaw = ts.readConfigFile(path.join(ROOT, "tsconfig.base.json"), ts.sys.readFile).config.compilerOptions;
  const opts = ts.convertCompilerOptionsFromJson({ ...cfgRaw, noEmit: true, skipLibCheck: true, types: [], incremental: false, composite: false, baseUrl: ROOT }, ROOT).options;
  const ownerAbs = ALL_OWNER_FILES().map((f) => path.join(SRC, f));
  const scope = [path.join(ROUTES, "vault.ts"), path.join(ROUTES, "vault-entity-links.ts"), ...ownerAbs];
  const run = (useBaseline) => {
    const host = ts.createCompilerHost(opts); const rf = host.readFile.bind(host), gs = host.getSourceFile.bind(host);
    const ov = (f) => (useBaseline ? ({ [path.join(ROUTES, "vault.ts")]: path.join(BASE, "routes/vault.ts"), [path.join(ROUTES, "vault-entity-links.ts")]: path.join(BASE, "routes/vault-entity-links.ts") })[f] : undefined);
    host.readFile = (f) => rf(ov(f) ?? f);
    host.getSourceFile = (f, lv, ...r) => { const o = ov(f); return o ? ts.createSourceFile(f, fs.readFileSync(o, "utf8"), lv, true) : gs(f, lv, ...r); };
    const roots = useBaseline ? [path.join(ROUTES, "vault.ts"), path.join(ROUTES, "vault-entity-links.ts")] : scope;
    const prog = ts.createProgram(roots, opts, host); const tally = {}; const syntactic = [];
    for (const f of roots) { const sf = prog.getSourceFile(f); if (sf) for (const d of prog.getSyntacticDiagnostics(sf)) syntactic.push(`${rel(f)}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`); }
    for (const sf of prog.getSourceFiles()) {
      if (!scope.includes(sf.fileName)) continue;
      if (useBaseline && ownerAbs.includes(sf.fileName)) continue;
      for (const d of prog.getSemanticDiagnostics(sf)) {
        const msg = ts.flattenDiagnosticMessageText(d.messageText, " ");
        if ([2307, 7016, 2792].includes(d.code)) { const mm = msg.match(/module '([^']+)'/) ?? msg.match(/'([^']+)'/); if (mm && !mm[1].startsWith(".")) { tally.__external_unresolved = (tally.__external_unresolved ?? 0) + 1; continue; } }
        const k = `${d.code}: ${msg.replace(/'[^']*'/g, "'…'").slice(0, 90)}`; tally[k] = (tally[k] ?? 0) + 1;
      }
    }
    return { tally, syntactic };
  };
  const before = run(true), after = run(false); const regress = [];
  for (const [k, n] of Object.entries(after.tally)) if (k !== "__external_unresolved" && n > (before.tally[k] ?? 0)) regress.push(`${k} (+${n - (before.tally[k] ?? 0)})`);
  const real = [2304, 2305, 2614, 2724, 2551, 2554, 2555, 2741, 2322, 2769, 2345, 2339, 2353, 2561];
  return { mode: "degraded-differential (project dependencies are not installed in the upload; full tsc/build is NOT executed)", before_total: Object.values(before.tally).reduce((a, b) => a + b, 0), after_total: Object.values(after.tally).reduce((a, b) => a + b, 0), syntactic_errors: after.syntactic, new_diagnostics: regress, real_class_new: regress.filter((r) => real.includes(parseInt(r, 10))), before: before.tally, after: after.tally };
}

// ── 8. Diff audit ──────────────────────────────────────────────────────────────────────────────────────────────────
function diffAudit() {
  const man = JSON.parse(fs.readFileSync(path.join(BASE, "repo-manifest.json"), "utf8")).files; const allowed = ALLOWED_CHANGED();
  const now = {}; for (const f of walkFiles(ROOT)) now[rel(f)] = sha256File(f);
  const changed = [], added = [], removed = [];
  for (const [k, v] of Object.entries(now)) { if (!(k in man)) added.push(k); else if (man[k] !== v) changed.push(k); }
  for (const k of Object.keys(man)) if (!(k in now)) removed.push(k);
  const okAdd = (k) => allowed.has(k) || k.startsWith("scripts/antas/vault/gap/");
  return { changed, added, removed, unexpected: [...changed.filter((k) => !allowed.has(k) && !k.startsWith("scripts/antas/vault/gap/")), ...added.filter((k) => !okAdd(k)), ...removed] };
}
function sourceHashes() {
  const files = [...OLD_FILES.map((f) => R(`routes/${f}`)), ...ALL_OWNER_FILES().map(R), "scripts/antas/vault/gap/harness.mjs", "scripts/antas/vault/gap/gap-common.mjs", "scripts/antas/vault/gap/validate-vlt-gap-01-C.mjs"];
  return Object.fromEntries(files.map((f) => [f, sha256File(path.join(ROOT, f))]));
}
const writeEv = (name, obj) => { const body = { ...obj }; const txt = `${JSON.stringify(body, null, 2)}\n`; fs.writeFileSync(path.join(EVID, name), txt); return sha256(txt); };

// ── 9. Mutation self-tests: the gate must FAIL when the retirement is undone ────────────────────────────────────────
async function selfTests() {
  const out = []; const t = (name, passed, details = "") => out.push({ name, passed: Boolean(passed), details });
  const vaultPath = R("routes/vault.ts"); const cur = fs.readFileSync(path.join(ROUTES, "vault.ts"), "utf8");
  const mutate = (fnRe, repl) => { const m = cur.replace(fnRe, repl); return m === cur ? null : m; };
  // (a) a DB query smuggled into a thin route
  const m1 = mutate(/(router\.get\("\/vault\/analytics", requireAuth, async \(req, res\): Promise<void> => \{\n)/, '$1  await db.select().from(vaultEntriesTable);\n');
  t("selftest:mutation-anchor-a", m1 !== null);
  if (m1) t("selftest:db-query-in-route-is-detected", retirementGate({ overlay: new Map([[vaultPath, m1]]) }).violations.some((v) => /GET \/vault\/analytics.*database access/.test(v)));
  // (b) a business decision tree (ternary) smuggled into a thin route
  const m2 = mutate(/(router\.get\("\/vault\/activity", requireAuth, async \(req, res\): Promise<void> => \{\n)/, '$1  const q = req.query.page ? 1 : 2;\n');
  t("selftest:mutation-anchor-b", m2 !== null);
  if (m2) t("selftest:decision-tree-in-route-is-detected", retirementGate({ overlay: new Map([[vaultPath, m2]]) }).violations.some((v) => /GET \/vault\/activity.*(ternary|non-adapter|decision)/.test(v)));
  // (c) an old GAP-01 helper re-declared in the old file
  const m3 = cur + "\nasync function selectVault(userId: number) { return db.select().from(vaultEntriesTable); }\n";
  t("selftest:redeclared-gap01-symbol-is-detected", retirementGate({ overlay: new Map([[vaultPath, m3]]) }).violations.some((v) => /selectVault|new symbol in an old file/.test(v)));
  // (d) a GAP-02/11 (deferred) symbol modified by this phase
  const m4 = mutate(/(async function runHealthCheck\([^)]*\): Promise<void> \{\n)/, "$1  console.log('x');\n");
  t("selftest:mutation-anchor-d", m4 !== null);
  if (m4) t("selftest:deferred-gap-symbol-tampering-is-detected", retirementGate({ overlay: new Map([[vaultPath, m4]]) }).violations.some((v) => /runHealthCheck.*modified/.test(v)));
  // (e) route removes its ownership middleware -> behavior/security differential must notice
  const m5 = mutate(/requireVaultEntryOwnership\("vault_entry\.update", /, 'requireVaultEntryOwnership("vault_entry.update.WEAKENED", ');
  t("selftest:mutation-anchor-e", m5 !== null);
  if (m5) { const c = CASES.find((x) => x.name === "update: not found -> 404"); const o = await runCase(c, "old"), n = await runCase(c, "new", { routesOverride: m5 }); t("selftest:ownership-action-change-is-detected-by-differential", diffRuns(o, n).some((x) => /middleware/.test(x))); }
  // (f) use-case drops the userId scope on bulk soft-delete
  const bulkAbs = path.join(SRC, "vault/application/entity/bulk.ts"); const bulk = fs.readFileSync(bulkAbs, "utf8");
  const m6 = bulk.replace(/\.where\(and\(eq\(vaultEntriesTable\.id, id\), eq\(vaultEntriesTable\.userId, userId\), sql`\$\{vaultEntriesTable\.deletedAt\} IS NULL`\)\)/, ".where(and(eq(vaultEntriesTable.id, id), sql`${vaultEntriesTable.deletedAt} IS NULL`))");
  t("selftest:mutation-anchor-f", m6 !== bulk);
  if (m6 !== bulk) {
    const c = CASES.find((x) => x.name.startsWith("bulk-action: delete")); const o = await runCase(c, "old"), n = await runCase(c, "new", { overrides: new Map([[bulkAbs, m6]]) });
    t("selftest:dropped-owner-scope-is-detected-by-differential", diffRuns(o, n).length > 0);
    t("selftest:dropped-owner-scope-is-detected-by-static-parity", staticParity(new Map([[R("vault/application/entity/bulk.ts"), m6]])).some((p) => p.route === "PATCH /vault/bulk-action" && !p.equivalent));
  }
  // (g) use-case changes an error status
  const upd = fs.readFileSync(path.join(SRC, "vault/application/entity/update.ts"), "utf8"); const m7 = upd.replace('status: 400, body: { error: "Unknown or non-editable field" }', 'status: 422, body: { error: "Unknown or non-editable field" }');
  t("selftest:mutation-anchor-g", m7 !== upd);
  if (m7 !== upd) { const c = CASES.find((x) => x.name === "field: unknown field -> 400"); const o = await runCase(c, "old"), n = await runCase(c, "new", { overrides: new Map([[path.join(SRC, "vault/application/entity/update.ts"), m7]]) }); t("selftest:changed-status-code-is-detected", diffRuns(o, n).some((x) => /status/.test(x))); }
  // (h) hidden import: a consumer pulls a moved symbol back from the old route module
  const fake = new Map([[R("routes/zz-hidden.ts"), 'import { selectVaultOne } from "./vault";\nexport const x = selectVaultOne;\n']]);
  const moved = movedNames(retirementGate().dispositions);
  t("selftest:hidden-import-of-moved-symbol-is-detected", hiddenImportScan(moved, fake).violations.some((v) => /zz-hidden/.test(v)));
  const fakeDyn = new Map([[R("routes/zz-dyn.ts"), 'export async function f() { const m = await import("./vault"); return m; }\n']]);
  t("selftest:dynamic-import-of-old-module-is-detected", hiddenImportScan(moved, fakeDyn).violations.some((v) => /zz-dyn/.test(v)));
  // (i) a copied (renamed) implementation outside vault/
  const own = fs.readFileSync(path.join(SRC, "vault/application/entity/receipt.ts"), "utf8").replace(/\bfmtPublicVaultReceipt\b/g, "someOtherName");
  t("selftest:renamed-copy-outside-vault-is-detected", duplicateScan({ overlay: new Map([[R("routes/zz-copy.ts"), own]]) }).hits.some((h) => h.file.endsWith("zz-copy.ts")));
  // (j) application layer reaching back into the API layer
  const bad = fs.readFileSync(path.join(SRC, "vault/application/entity/bulk.ts"), "utf8").replace('import type { EntityResult } from "./lifecycle";', 'import type { EntityResult } from "./lifecycle";\nimport { broadcastEvent } from "../../../routes/events";');
  t("selftest:application-importing-routes-is-detected", layeringScan(new Map([[R("vault/application/entity/bulk.ts"), bad]])).some((v) => /routes/.test(v)));
  // (k) a use-case that stopped doing something the old handler did (dropped audit call)
  const create = fs.readFileSync(path.join(SRC, "vault/application/entity/create.ts"), "utf8"); const m8 = create.replace(/\n  logVaultActivity\(.*\n/, "\n");
  t("selftest:dropped-audit-call-is-detected-by-static-parity", m8 !== create && staticParity(new Map([[R("vault/application/entity/create.ts"), m8]])).some((p) => p.route === "POST /vault" && !p.equivalent));
  return out;
}

// ── main ────────────────────────────────────────────────────────────────────────────────────────────────────────────
function verifyMode() {
  const gp = path.join(EVID, EV.gate);
  if (!fs.existsSync(gp)) fail("evidence missing: run the validator first");
  const ev = JSON.parse(fs.readFileSync(gp, "utf8")); const b = binding(sourceHashes()); const p = [];
  if (ev.sub_phase !== SUB_PHASE) p.push("sub_phase mismatch");
  if (ev.commit_sha !== b.commit_sha) p.push("commit_sha mismatch");
  if (ev.source_tree_sha256 !== b.source_tree_sha256) p.push("source changed since evidence (stale)");
  if (ev.validator_sha256 !== sha256File(HERE)) p.push("different validator version");
  const body = { ...ev }; delete body.evidence_body_sha256; delete body.generated_at;
  if (sha256(JSON.stringify(body)) !== ev.evidence_body_sha256) p.push("evidence body edited after generation");
  for (const [n, h] of Object.entries(ev.companion_evidence_sha256 ?? {})) { const f = path.join(EVID, n); if (!fs.existsSync(f) || sha256(fs.readFileSync(f, "utf8")) !== h) p.push(`companion evidence ${n} missing or edited`); }
  for (const n of Object.values(EV)) if (n !== EV.gate && !(n in (ev.companion_evidence_sha256 ?? {}))) p.push(`companion evidence ${n} not bound`);
  if (ev.status !== "PASS") p.push(`recorded status ${ev.status}`);
  if (p.length) fail(`evidence rejected: ${p.join("; ")}`);
  console.log(`${SUB_PHASE} evidence verified (${b.commit_binding})`);
}

async function main() {
  if (process.argv.includes("--verify")) { verifyMode(); return; }
  const started = Date.now(); const commands = []; const exit_codes = {};
  // executed prerequisite chain: 01-C -> 01-B -> 01-A (exit codes recorded, not trusted from disk)
  const c1 = spawnSync(process.execPath, [path.join(ROOT, "scripts/antas/vault/gap/validate-vlt-gap-01-C.mjs")], { encoding: "utf8", env: process.env });
  commands.push("node scripts/antas/vault/gap/validate-vlt-gap-01-C.mjs"); exit_codes["01-C"] = c1.status;

  const gate = retirementGate();
  const parity = staticParity();
  const dup = duplicateScan();
  const moved = movedNames(gate.dispositions);
  const hidden = hiddenImportScan(moved);
  const layering = layeringScan();
  const diff = await differentialSuite();
  const tc = typecheckDifferential();
  const audit = diffAudit();
  const selft = await selfTests();

  const security = diff.filter((r) => r.category === "security");
  const unexercised = diff.filter((r) => !r.exercised);
  const routesCovered = new Set(diff.map((r) => r.route));
  const d22 = [...Object.entries(EXTRACTED_ROUTES["vault.ts"]).filter(([, [f]]) => !/lifecycle/.test(f)).map(([k]) => k), ...Object.keys(COMPOSITE_ROUTES)];
  const uncovered = d22.filter((k) => !routesCovered.has(k.replace(/^(\w+) /, "$1 ")) && ![...routesCovered].some((x) => x === k));

  // ownership actions must be identical (old vs new) for every ownership-gated extracted route
  const gated = new Map(); for (const r of diff) if (r.stack?.some((s) => s.ownership)) gated.set(r.route, r.stack.filter((s) => s.ownership).map((s) => s.ownership.action));
  const gap01Remaining = gate.files.flatMap((f) => f.symbols.filter((s) => s.owner_gap === "GAP-01" && ["AUTHORITATIVE_OLD_LOGIC", "UNACCOUNTED", "MOVE_UNPROVEN", "RETIREMENT_UNPROVEN", "MISSING_ROUTE", "NO_EXTRACTION_TARGET", "UNCLASSIFIED"].includes(s.disposition)).map((s) => `${path.basename(f.file)}#${s.symbol}`));

  const checks = []; const chk = (name, passed, details = "") => checks.push({ name, passed: Boolean(passed), details: typeof details === "string" ? details : canon(details) });
  chk("prerequisite:01-C-executed-and-passed (executes 01-B and 01-A)", c1.status === 0, (c1.stderr || c1.stdout || "").slice(-300));
  chk("retirement:every-baseline-symbol-has-a-proven-disposition", gate.violations.length === 0, gate.violations.slice(0, 12).join(" | "));
  chk("retirement:no-GAP-01-symbol-remains-authoritative-in-old-files", gap01Remaining.length === 0, gap01Remaining.join(", "));
  chk("retirement:all-GAP-01-routes-are-thin-adapters", gate.thin.every((t) => t.thin), gate.thin.filter((t) => !t.thin).map((t) => `${t.route}: ${t.violations[0]}`).join(" | "));
  // Expected census is derived from the pre-extraction 01-A inventory (not a hardcoded number): every GAP-01 route handler must be inspected.
  const expectedGap01Routes = JSON.parse(fs.readFileSync(path.join(BASE, "symbol-inventory.pre-extraction.json"), "utf8")).records.filter((r) => r.kind === "route-handler" && r.owner_gap === "GAP-01").map((r) => `${path.basename(r.file)}|${r.name}`).sort();
  const inspectedRoutes = gate.thin.map((t) => `${t.file}|${t.route}`).sort();
  chk("retirement:thin-route-census-is-non-trivial", expectedGap01Routes.length > 0 && canon(expectedGap01Routes) === canon(inspectedRoutes), `${gate.thin.length} GAP-01 routes inspected; expected ${expectedGap01Routes.length} from the pre-extraction inventory; missing=[${expectedGap01Routes.filter((k) => !inspectedRoutes.includes(k)).join(", ")}] unexpected=[${inspectedRoutes.filter((k) => !expectedGap01Routes.includes(k)).join(", ")}]`);
  chk("retirement:vault-entity-links-fully-retired-to-adapter", gate.files.find((f) => f.file.endsWith("vault-entity-links.ts")).symbols.filter((s) => s.kind === "route").every((s) => s.disposition === "ADAPTER_THIN"));
  chk("retirement:deferred-later-gap-code-untouched", !gate.files.some((f) => f.symbols.some((s) => s.disposition === "DEFERRED_SYMBOL_MODIFIED")));
  chk("retirement:snapshot-and-share-sources-byte-identical-to-baseline", gate.files.filter((f) => /snapshot|shares/.test(f.file)).every((f) => f.baseline_sha256 === f.current_sha256));
  chk("retirement:old-file-exports-are-compat-only", gate.files.every((f) => f.exports.every((e) => e === "default" || ["toHealthInput"].includes(e) || /snapshot|shares/.test(f.file))), gate.files.map((f) => `${path.basename(f.file)}:${f.exports.join("/")}`).join(" "));
  chk("parity:every-extracted-handler-preserves-db-sql-tables-literals-branches-awaits", parity.every((p) => p.equivalent), parity.filter((p) => !p.equivalent).map((p) => `${p.route}: ${p.differences.join("; ")}`).join(" | "));
  chk("parity:coverage-all-extracted-routes-checked", parity.length === Object.values(EXTRACTED_ROUTES).reduce((n, m) => n + Object.keys(m).length, 0) + Object.keys(COMPOSITE_ROUTES).length, `${parity.length} parity checks`);
  chk("duplicates:no-copy-of-extracted-implementation-outside-vault", dup.hits.length === 0, canon(dup.hits));
  chk("duplicates:no-baseline-GAP-01-body-survives-in-old-files", dup.remainingBaseline.length === 0, canon(dup.remainingBaseline));
  chk("duplicates:no-two-owner-modules-implement-the-same-function", dup.ownerDuplicates.length === 0, canon(dup.ownerDuplicates));
  chk("imports:no-hidden-import-keeps-old-code-authoritative", hidden.violations.length === 0, hidden.violations.join(" | "));
  chk("layering:extracted-application-code-does-not-reach-the-API-layer", layering.length === 0, layering.join(" | "));
  chk("behavior:differential-old-baseline-vs-current-all-identical", diff.every((r) => r.passed), diff.filter((r) => !r.passed).map((r) => `${r.name}: ${r.differences[0]}`).slice(0, 8).join(" | "));
  chk("behavior:every-case-executed-the-route", unexercised.length === 0, unexercised.map((r) => r.name).join(", "));
  chk("behavior:cases-cover-success-failure-and-security", ["success", "failure", "security"].every((c) => diff.some((r) => r.category === c)) && diff.length >= 80, `${diff.length} cases`);
  chk("behavior:all-extracted-routes-exercised-by-a-case", uncovered.length === 0, uncovered.join(", "));
  chk("security:ownership-actions-and-deny-bodies-identical-old-vs-new", security.every((r) => r.passed) && gated.size >= 14, `${gated.size} ownership-gated routes exercised`);
  chk("security:foreign-and-missing-owner-paths-executed", security.length >= 16 && security.every((r) => r.exercised), `${security.length} security cases`);
  chk("typecheck:no-syntax-errors-in-changed-or-new-files", tc.syntactic_errors.length === 0, tc.syntactic_errors.join(" | "));
  chk("typecheck:no-new-real-class-diagnostics-vs-baseline", tc.real_class_new.length === 0, tc.real_class_new.join(" | "));
  chk("diff-audit:no-unrelated-changes", audit.unexpected.length === 0, audit.unexpected.join(", "));
  for (const r of selft) chk(r.name, r.passed, r.details);
  exit_codes.retirement_gate = gate.violations.length ? 1 : 0; exit_codes.differential = diff.every((r) => r.passed) ? 0 : 1; exit_codes.self_tests = selft.every((r) => r.passed) ? 0 : 1; exit_codes.typecheck_degraded = tc.real_class_new.length || tc.syntactic_errors.length ? 1 : 0;
  const failed = checks.filter((c) => !c.passed);

  fs.mkdirSync(EVID, { recursive: true });
  const hashes = sourceHashes(); const bd = binding(hashes);
  const common = { phase: "VLT-GAP-01", sub_phase: SUB_PHASE, commit_sha: bd.commit_sha, commit_binding: bd.commit_binding, source_tree_sha256: bd.source_tree_sha256, validator_version: VALIDATOR_VERSION, validator_sha256: sha256File(HERE) };
  const companion = {};
  companion[EV.old] = writeEv(EV.old, { ...common, description: "Current vs pre-extraction fingerprint and disposition of every symbol in the four old source files", files: gate.files.map((f) => ({ ...f, symbols: f.symbols.map(({ ...s }) => s) })), deferred_later_gap_code_remaining: gate.deferredBusiness, dispositions: Object.entries(gate.dispositions.reduce((m, d) => (m[d.disposition] = (m[d.disposition] ?? 0) + 1, m), {})).sort() });
  const ownerFiles = ALL_OWNER_FILES().map((f) => { const abs = path.join(SRC, f); const text = fs.readFileSync(abs, "utf8"); const { sf, syms } = scanSymbols(text, abs); const fe = featuresOf([sf], sf); return { file: R(f), sha256: sha256(text), lines: text.split("\n").length, exports: syms.filter((s) => s.exported).map((s) => s.key), executable_business: { db_chains: fe.db_chains.length, sql_templates: fe.sql_templates.length, branches: Object.values(fe.control).reduce((a, b) => a + b, 0) }, gap01d_new: GAP01D_NEW_FILES.includes(f) }; });
  const usage = {}; // are the new owners actually used by the routes?
  { const v = scanSymbols(fs.readFileSync(path.join(ROUTES, "vault.ts"), "utf8"), path.join(ROUTES, "vault.ts")); const l = scanSymbols(fs.readFileSync(path.join(ROUTES, "vault-entity-links.ts"), "utf8"), path.join(ROUTES, "vault-entity-links.ts")); for (const [fnm, im] of [...v.imports, ...l.imports]) if (/\/vault\//.test(im.module)) usage[fnm] = (usage[fnm] ?? 0); (function w(n, sf) { if (ts.isCallExpression(n)) { const nm = calleeName(n.expression, sf).split(".")[0]; if (nm in usage) usage[nm]++; } if (ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) { const nm = n.name.getText(sf); if (nm in usage) usage[nm]++; } if (ts.isIdentifier(n) && n.parent && (ts.isPropertyAssignment(n.parent) && n.parent.initializer === n) && n.text in usage) usage[n.text]++; ts.forEachChild(n, (c) => w(c, sf)); })(v.sf, v.sf); (function w(n, sf) { if (ts.isCallExpression(n)) { const nm = calleeName(n.expression, sf).split(".")[0]; if (nm in usage) usage[nm]++; } ts.forEachChild(n, (c) => w(c, sf)); })(l.sf, l.sf); }
  companion[EV.neu] = writeEv(EV.neu, { ...common, description: "Fingerprints of the new owner modules and proof that the old routes actually call them", owner_files: ownerFiles, owner_symbol_call_sites_in_old_routes: usage, unused_imported_owner_symbols: Object.entries(usage).filter(([, n]) => n === 0).map(([k]) => k), extracted_routes: parity.map((p) => ({ route: p.route, use_case: p.use_case, baseline: p.baseline, current: p.current, composite: p.composite ?? false, parity: p.equivalent })) });
  companion[EV.thin] = writeEv(EV.thin, { ...common, description: "Per-route thinness of every GAP-01 route left in the old files", allowed_in_old_route: ["request parsing", "auth-context construction", "compatibility mapping", "response mapping", "compatibility exports"], rejected_in_old_route: ["db/sql/table access", "provider/crypto/event/sync calls", "domain calculations", "decision trees", "duplicated authorization/persistence"], routes: gate.thin, summary: { routes: gate.thin.length, thin: gate.thin.filter((t) => t.thin).length, not_thin: gate.thin.filter((t) => !t.thin).length } });
  companion[EV.dup] = writeEv(EV.dup, { ...common, description: "Duplicate implementation scan (name-agnostic semantic fingerprints)", extracted_copy_outside_vault: dup.hits, baseline_gap01_bodies_surviving_in_old_files: dup.remainingBaseline, owner_module_duplicates: dup.ownerDuplicates, pre_existing_independent_idioms_not_from_extraction: dup.preExisting, owner_functions_fingerprinted: dup.owner_functions_fingerprinted, hidden_import_edges: hidden.edges, hidden_import_violations: hidden.violations, layering_violations: layering });
  companion[EV.beh] = writeEv(EV.beh, { ...common, description: "Old frozen baseline vs current routes, executed side by side under identical stubs (DB, providers, events, crypto)", stubbed: "no network and no real database; deterministic stand-ins are identical for OLD and NEW", cases: diff.map(({ stack, ...r }) => r), static_parity: parity, typecheck: tc, summary: { cases: diff.length, passed: diff.filter((r) => r.passed).length, static_parity: parity.length, static_parity_equivalent: parity.filter((p) => p.equivalent).length } });
  companion[EV.sec] = writeEv(EV.sec, { ...common, description: "Ownership / isolation regression: identical PEP action, deny bodies and middleware order old vs new; foreign/missing-owner paths executed", ownership_gated_routes: Object.fromEntries(gated), security_cases: security.map(({ stack, ...r }) => r), mutation_evidence: selft.filter((s) => /ownership|owner-scope|hidden|application-importing/.test(s.name)) });
  const g = { ...common, source_hashes: hashes, commands, exit_codes, symbols_moved: gate.dispositions.filter((d) => /^MOVED/.test(d.disposition)).map((d) => `${d.file}#${d.symbol}`), handlers_extracted_total: parity.length, consumers_migrated: [], old_business_symbols_remaining: gap01Remaining, duplicate_implementations: dup.hits, disposition_summary: gate.dispositions.reduce((m, d) => (m[d.disposition] = (m[d.disposition] ?? 0) + 1, m), {}), deferred_later_gap_code_remaining: gate.deferredBusiness, deferred_note: "Old-file code still owned by GAP-02/05/11 (vault.ts) and GAP-09/10 (snapshot/shares) is NOT GAP-01 logic. It is untouched by this phase and is retired by its own gap. The old files are therefore not yet fully retired; GAP-01's share of them is.", summary: { old_files: gate.files.length, gap01_routes_thin: gate.thin.filter((t) => t.thin).length, gap01_routes_total: gate.thin.length, gap01_symbols_authoritative_in_old: gap01Remaining.length, parity_checks: parity.length, differential_cases: diff.length, differential_passed: diff.filter((r) => r.passed).length, self_tests: selft.length, self_tests_passed: selft.filter((s) => s.passed).length }, companion_evidence_sha256: companion, checks, status: failed.length === 0 ? "PASS" : "FAIL" };
  g.evidence_body_sha256 = sha256(JSON.stringify(g)); g.generated_at = new Date().toISOString();
  fs.writeFileSync(path.join(EVID, EV.gate), `${JSON.stringify(g, null, 2)}\n`);
  console.log(`${SUB_PHASE} ${g.status} — gap01-routes-thin=${g.summary.gap01_routes_thin}/${g.summary.gap01_routes_total} authoritative-old=${gap01Remaining.length} parity=${parity.filter((p) => p.equivalent).length}/${parity.length} differential=${g.summary.differential_passed}/${diff.length} selftests=${g.summary.self_tests_passed}/${selft.length} (${Date.now() - started}ms)`);
  if (failed.length) { console.error(failed.map((c) => `- ${c.name}: ${String(c.details).slice(0, 400) || "not satisfied"}`).join("\n")); process.exit(1); }
}
main().catch((e) => fail(`validator crashed: ${e.stack || e}`));
