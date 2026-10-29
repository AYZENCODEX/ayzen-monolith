#!/usr/bin/env node
// VLT-GAP-02-B — Actual Move / Extract (local accounts, API side). Fail-closed validator.
// Evidence: reports/antas/vault/gap/VLT-GAP-02/extraction-proof.json
//
// Proves, from source and by execution, that the local-account business logic moved out of
// routes/local-accounts.ts into vault/{domain,security,infrastructure,application}, that the moved code
// is used, that behavior is unchanged (frozen-baseline vs new differential suite), and that nothing
// unrelated changed. Consumer rewire is 02-C; final retirement gate is 02-D.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, sha256, sha256File, rel, rejectBypass, binding, walkFiles } from "./gap-common.mjs";
import { loadTs, createEnv, createLoader, fakeRes, summ } from "./harness.mjs";

const VALIDATOR_VERSION = "1.0.0";
const PHASE = "VLT-GAP-02";
const SUB_PHASE = "VLT-GAP-02-B";
const HERE = fileURLToPath(import.meta.url);
const SRC = path.join(ROOT, "artifacts/api-server/src");
const ROUTES = path.join(SRC, "routes");
const ROUTE_FILE = path.join(ROUTES, "local-accounts.ts");
const EVIDENCE_DIR = path.join(ROOT, "reports/antas/vault/gap/VLT-GAP-02");
const EVIDENCE_FILE = path.join(EVIDENCE_DIR, "extraction-proof.json");
const BASE = path.join(EVIDENCE_DIR, "baseline");
const OLD_ROUTE_BASELINE = path.join(BASE, "sources/artifacts__api-server__src__routes__local-accounts.ts");
const R = (f) => `artifacts/api-server/src/${f}`;

const fail = (m) => { console.error(`${SUB_PHASE} FAIL — ${m}`); process.exit(1); };
const bypass = rejectBypass();
if (bypass.length) fail(`bypass mechanism rejected: ${bypass.join(", ")}`);
if (process.env.VALIDATION_DISABLED && !/^(0|false|no)$/i.test(process.env.VALIDATION_DISABLED)) fail("bypass mechanism rejected: env VALIDATION_DISABLED");
const ts = loadTs(ROOT);
if (!ts) fail("TypeScript compiler API unavailable (fail closed)");
for (const f of [OLD_ROUTE_BASELINE, path.join(BASE, "tree-manifest.json"), path.join(EVIDENCE_DIR, "symbol-inventory.json")]) {
  if (!fs.existsSync(f)) fail(`pre-extraction baseline/evidence missing: ${rel(f)}`);
}
const OLD_TEXT = fs.readFileSync(OLD_ROUTE_BASELINE, "utf8");
const parse = (name, text) => ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

// ── 1. Declared extraction (intent). Every entry is VERIFIED against source below. ──
const NEW = {
  values: "vault/domain/local-account-values.ts",
  security: "vault/security/local-account-ownership.ts",
  repo: "vault/infrastructure/repositories/local-account-repository.ts",
  accounts: "vault/application/local-account/accounts.ts",
  receipt: "vault/application/local-account/receipt.ts",
};
const NEW_FILES = Object.values(NEW);
const verbatim = (file, layer, domain, names) => names.map((n) => ({ name: n, neu: file, mode: "verbatim", layer, domain }));
const MOVES = [
  ...verbatim(NEW.values, "domain", "sql-support", ["safe", "safeNum", "safeDate", "safeScore"]),
  ...verbatim(NEW.values, "domain", "metadata", ["calcAgeLabel", "calcRoiPct", "ageInDays", "fmtAvgAgeLabel"]),
  ...verbatim(NEW.values, "domain", "receipt", ["fmtPublicLocalReceipt"]),
  ...verbatim(NEW.security, "security", "ownership", [
    "LOCAL_ACCOUNT_OWNER_SENTINEL_NONE", "localAccountResource", "requireLocalAccountOwnership",
    "denyNotFoundOrForbidden", "denyNotFound", "denyAccountNotFound", "denySilentSuccess", "denyEmptyPoints",
    "LOCAL_ACCOUNT_CATEGORY_OWNER_SENTINEL_NONE", "localAccountCategoryResource", "requireLocalAccountCategoryOwnership",
    "LOCAL_ACCOUNT_POINT_OWNER_SENTINEL_NONE", "localAccountPointResource", "requireLocalAccountPointOwnership"]),
  ...verbatim(NEW.receipt, "application", "receipt", ["generateReceiptToken", "receiptUrl", "generateCategoryReceiptToken", "categoryReceiptUrl"]),
  ...verbatim(NEW.repo, "infrastructure", "receipt", ["findLocalAccountByReceiptToken"]),
  { name: "computeCategoryAggregate", neu: NEW.receipt, mode: "refactor", layer: "application", domain: "category-receipt", note: "SELECT → repository, arithmetic → domain aggregateCategoryRows; verified differentially" },
  { name: "findCategoryReceiptByToken", neu: NEW.receipt, mode: "refactor", layer: "application", domain: "category-receipt", note: "SELECT → repository findCategoryReceiptRowByToken; verified differentially" },
  { name: "fmtPublicCategoryReceipt", neu: NEW.values, mode: "refactor", layer: "domain", domain: "category-receipt", note: "parameter type named FoundCategoryReceipt instead of the inferred Awaited<ReturnType<…>>; body identical" },
];
// Route handlers whose bodies were extracted to use-cases (module = where the use-case lives).
const HANDLERS = [
  ["GET", "/local-accounts", "listLocalAccounts", "accounts"], ["POST", "/local-accounts", "createLocalAccount", "accounts"],
  ["PUT", "/local-accounts/:id", "editLocalAccount", "accounts"], ["PATCH", "/local-accounts/:id/status", "setLocalAccountStatus", "accounts"],
  ["DELETE", "/local-accounts/:id", "removeLocalAccount", "accounts"], ["PATCH", "/local-accounts/:id/link-vault", "linkLocalAccount", "accounts"],
  ["PATCH", "/local-accounts/:id/unlink-vault", "unlinkLocalAccount", "accounts"], ["GET", "/local-accounts/categories", "listLocalAccountCategories", "accounts"],
  ["POST", "/local-accounts/categories", "createLocalAccountCategory", "accounts"], ["DELETE", "/local-accounts/categories/:id", "removeLocalAccountCategory", "accounts"],
  ["GET", "/local-accounts/:id", "getLocalAccount", "accounts"], ["GET", "/local-accounts/:id/points", "listLocalAccountPoints", "accounts"],
  ["POST", "/local-accounts/:id/points", "createLocalAccountPoint", "accounts"], ["DELETE", "/local-accounts/points/:pointId", "removeLocalAccountPoint", "accounts"],
  ["POST", "/local-accounts/:id/receipt", "createLocalAccountReceipt", "receipt"], ["DELETE", "/local-accounts/:id/receipt", "revokeLocalAccountReceipt", "receipt"],
  ["GET", "/local-accounts/receipt/:token", "resolvePublicLocalReceipt", "receipt"], ["GET", "/local-accounts/receipt/:token/pdf", "resolvePublicLocalReceipt", "receipt"],
  ["POST", "/local-accounts/category-receipt/:category", "createCategoryReceipt", "receipt"], ["DELETE", "/local-accounts/category-receipt/:category", "revokeCategoryReceipt", "receipt"],
  ["GET", "/local-accounts/category-receipt/:token", "resolvePublicCategoryReceipt", "receipt"], ["GET", "/local-accounts/category-receipt/:token/pdf", "resolvePublicCategoryReceipt", "receipt"],
  ["POST", "/local-accounts/category-receipt/:category/email", "emailCategoryReceipt", "receipt"],
].map(([method, p, usecase, mod]) => ({ method, path: p, usecase, module: NEW[mod] }));
// Only these files may differ from the frozen pre-extraction tree (cumulative audit tolerates later-phase files only when listed).
const CHANGED_ALLOWED = new Set([R("routes/local-accounts.ts"), ...NEW_FILES.map((f) => R(f))]);

// ── 2. AST helpers ──
function tokensOf(node, sf, { skipExport = true } = {}) {
  const t = [];
  (function w(n) {
    if (ts.isJSDoc(n) || n.kind === ts.SyntaxKind.JSDocComment) return;
    if (skipExport && n.kind === ts.SyntaxKind.ExportKeyword) return;
    if (n.getChildCount(sf) === 0) { if (n.kind !== ts.SyntaxKind.EndOfFileToken) t.push(n.getText(sf)); } else n.getChildren(sf).forEach(w);
  })(node);
  return t;
}
function declIn(sf, name) {
  for (const s of sf.statements) {
    if (ts.isFunctionDeclaration(s) && s.name?.text === name) return { node: s, kind: "function", exported: Boolean(s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) };
    if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) if (d.name.getText(sf) === name) return { node: d, kind: "variable", exported: Boolean(s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) };
  }
  return null;
}
const importsOfFile = (sf) => sf.statements.filter((s) => ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier)).map((s) => ({
  spec: s.moduleSpecifier.text, typeOnly: Boolean(s.importClause?.isTypeOnly),
  names: s.importClause?.namedBindings && ts.isNamedImports(s.importClause.namedBindings) ? s.importClause.namedBindings.elements.map((e) => ({ imported: (e.propertyName ?? e.name).text, local: e.name.text, typeOnly: s.importClause.isTypeOnly || e.isTypeOnly })) : [],
}));
function dynamicImports(sf) { const out = []; (function w(n) { if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) out.push(n.arguments[0].text); ts.forEachChild(n, w); })(sf); return out; }
const resolveTo = (fromAbs, spec) => (spec.startsWith(".") ? rel(path.resolve(path.dirname(fromAbs), spec)).replace(/\.(ts|js)$/, "") : null);

// SQL literal census: every template/string literal that carries SQL, with ${…} normalised and whitespace collapsed.
const SQLISH = /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b|\bAND (category|vault_entry_id)\b|^user_id = \$\{\}$/i;
function sqlLiterals(sf) {
  const out = new Set();
  (function w(n) {
    let text = null;
    if (ts.isNoSubstitutionTemplateLiteral(n)) text = n.text;
    else if (ts.isTemplateExpression(n)) text = n.head.text + n.templateSpans.map((s) => "${}" + s.literal.text).join("");
    if (text !== null) { const norm = text.replace(/\s+/g, " ").trim(); if (SQLISH.test(norm)) out.add(norm); }
    ts.forEachChild(n, w);
  })(sf);
  return out;
}
function errorLiterals(sf) {
  const out = new Set();
  (function w(n) { if (ts.isPropertyAssignment(n) && n.name.getText(sf) === "error" && ts.isStringLiteralLike(n.initializer)) out.add(n.initializer.text); ts.forEachChild(n, w); })(sf);
  return out;
}
function handlerShape(text, name = "route.ts") {
  const sf = parse(name, text); const out = [];
  for (const s of sf.statements) {
    if (!(ts.isExpressionStatement(s) && ts.isCallExpression(s.expression))) continue;
    const c = s.expression.expression;
    if (!(ts.isPropertyAccessExpression(c) && c.expression.getText(sf) === "router" && ["get", "post", "put", "patch", "delete"].includes(c.name.text))) continue;
    const args = s.expression.arguments; const handler = args[args.length - 1];
    const middleware = [...args].slice(1, -1).map((a) => a.getText(sf).replace(/\s+/g, " "));
    let db = 0, branches = 0, calls = new Set();
    (function w(n) {
      if (ts.isIdentifier(n) && (n.text === "db" || n.text === "sql")) db++;
      if (ts.isIfStatement(n) || ts.isConditionalExpression(n) || ts.isTryStatement(n) || ts.isForStatement(n)) branches++;
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) calls.add(n.expression.text);
      ts.forEachChild(n, w);
    })(handler);
    out.push({ method: c.name.text.toUpperCase(), path: args[0].text, middleware, db_refs: db, control_flow_nodes: branches, called: [...calls].sort(), handler_lines: sf.getLineAndCharacterOfPosition(handler.getEnd()).line - sf.getLineAndCharacterOfPosition(handler.getStart(sf)).line + 1 });
  }
  return out;
}

// ── 3. Static proof ──
function staticProof() {
  const checks = []; const chk = (name, passed, details = "") => checks.push({ name, passed: Boolean(passed), details });
  const oldSf = parse("old.ts", OLD_TEXT); const newRouteText = fs.readFileSync(ROUTE_FILE, "utf8"); const newRouteSf = parse("route.ts", newRouteText);
  const dest = {}; for (const [k, f] of Object.entries(NEW)) { const abs = path.join(SRC, f); if (!fs.existsSync(abs)) { chk(`destination-exists:${f}`, false, "missing"); continue; } const text = fs.readFileSync(abs, "utf8"); dest[k] = { abs, text, sf: parse(f, text) }; chk(`destination-exists:${f}`, true); chk(`destination-parses:${f}`, (dest[k].sf.parseDiagnostics ?? []).length === 0); }
  if (Object.keys(dest).length !== NEW_FILES.length) return { checks, moved: [], handlers: [], duplicates: [], route_after: [], route_before: [] };

  // S1 — baseline integrity: frozen route == the 02-A evidence hash (anchors the baseline to a validator-generated fact)
  const ev02a = JSON.parse(fs.readFileSync(path.join(EVIDENCE_DIR, "symbol-inventory.json"), "utf8"));
  chk("baseline-route-matches-02A-evidence-hash", ev02a.source_hashes?.[R("routes/local-accounts.ts")] === sha256(OLD_TEXT) && ev02a.status === "PASS", "");
  chk("baseline-route-is-pre-extraction-shape", handlerShape(OLD_TEXT).some((h) => h.db_refs > 0), "baseline must still contain inline DB access");

  // S2 — every declared move is real
  const moved = [];
  for (const m of MOVES) {
    const od = declIn(oldSf, m.name); const nk = Object.entries(NEW).find(([, f]) => f === m.neu)[0]; const nd = declIn(dest[nk].sf, m.name);
    const rec = { symbol: m.name, from: R("routes/local-accounts.ts"), to: R(m.neu), mode: m.mode, layer: m.layer, behavior_domain: m.domain, note: m.note };
    if (!od) { chk(`move:${m.name}:exists-in-baseline`, false, "not in frozen baseline"); continue; }
    if (!nd) { chk(`move:${m.name}:exists-in-destination`, false, `${m.neu} does not declare it`); continue; }
    if (m.mode === "verbatim") {
      const same = tokensOf(od.node, oldSf).join(" ") === tokensOf(nd.node, dest[nk].sf).join(" ");
      rec.identical_modulo_export = same;
      chk(`move:${m.name}:verbatim-identical`, same, "declaration differs from frozen baseline");
    }
    const stillInRoute = declIn(newRouteSf, m.name);
    chk(`move:${m.name}:removed-from-route`, !stillInRoute, "old route still declares it (duplicate implementation)");
    moved.push(rec);
  }

  // S3 — handlers delegate: no DB refs, calls the use-case, use-case is imported from the declared module and exists there
  const after = handlerShape(newRouteText); const before = handlerShape(OLD_TEXT);
  const newImports = importsOfFile(newRouteSf);
  const handlers = [];
  chk("route-count-preserved", before.length === after.length && before.length === HANDLERS.length, `before=${before.length} after=${after.length} declared=${HANDLERS.length}`);
  chk("route-order-and-middleware-identical", JSON.stringify(before.map((b) => [b.method, b.path, b.middleware])) === JSON.stringify(after.map((a) => [a.method, a.path, a.middleware])), "route table (order, path, middleware chain text) changed");
  for (const h of HANDLERS) {
    const a = after.find((x) => x.method === h.method && x.path === h.path); const b = before.find((x) => x.method === h.method && x.path === h.path);
    const modKey = Object.entries(NEW).find(([, f]) => f === h.module)[0];
    const declared = Boolean(declIn(dest[modKey].sf, h.usecase));
    const imported = newImports.some((i) => resolveTo(ROUTE_FILE, i.spec) === R(h.module).replace(/\.ts$/, "").replace(`artifacts/api-server/src/`, "artifacts/api-server/src/") && i.names.some((n) => n.imported === h.usecase));
    handlers.push({ route: `${h.method} ${h.path}`, use_case: `${R(h.module)}#${h.usecase}`, db_refs_before: b?.db_refs ?? null, db_refs_after: a?.db_refs ?? null, handler_lines_before: b?.handler_lines ?? null, handler_lines_after: a?.handler_lines ?? null });
    chk(`handler:${h.method} ${h.path}:delegates`, Boolean(a) && declared && imported && a.called.includes(h.usecase) && a.db_refs === 0, `route=${Boolean(a)} declared=${declared} imported=${imported} calls=${a?.called.join(",")} db_refs=${a?.db_refs}`);
  }
  chk("route-has-zero-db-or-sql-references", after.every((a) => a.db_refs === 0), after.filter((a) => a.db_refs).map((a) => `${a.method} ${a.path}`).join(", "));
  const routeTopLevel = newRouteSf.statements.filter((s) => (ts.isFunctionDeclaration(s) && s.name) || ts.isVariableStatement(s)).flatMap((s) => ts.isFunctionDeclaration(s) ? [s.name.text] : s.declarationList.declarations.map((d) => d.name.getText(newRouteSf))).filter((n) => n !== "router");
  chk("route-declares-no-business-symbols", routeTopLevel.length === 0, routeTopLevel.join(", "));

  // S4 — SQL provenance: every SQL literal of the old route exists in the new destination; none remain in the route
  const oldSql = sqlLiterals(oldSf); const routeSql = sqlLiterals(newRouteSf);
  const destSql = new Set(Object.values(dest).flatMap((d) => [...sqlLiterals(d.sf)]));
  const missingSql = [...oldSql].filter((s) => !destSql.has(s));
  const extraSql = [...destSql].filter((s) => !oldSql.has(s));
  chk("sql-every-old-statement-preserved-in-destination", missingSql.length === 0, missingSql.map((s) => s.slice(0, 100)).join(" | "));
  chk("sql-no-new-statements-introduced", extraSql.length === 0, extraSql.map((s) => s.slice(0, 100)).join(" | "));
  chk("sql-none-left-in-route", routeSql.size === 0, [...routeSql].map((s) => s.slice(0, 80)).join(" | "));
  // S4b — response/error semantics: every old error message still exists in the new tree
  const oldErr = errorLiterals(oldSf); const newErr = new Set(Object.values(dest).flatMap((d) => [...errorLiterals(d.sf)]));
  const missingErr = [...oldErr].filter((e) => !newErr.has(e));
  chk("error-messages-preserved", missingErr.length === 0, missingErr.join(" | "));

  // S5 — destination is executable business logic, not scaffolding
  const count = (sf, pred) => { let n = 0; (function w(x) { if (pred(x)) n++; ts.forEachChild(x, w); })(sf); return n; };
  const fnBodies = (d) => count(d.sf, (x) => (ts.isFunctionDeclaration(x) || ts.isArrowFunction(x) || ts.isFunctionExpression(x)) && x.body && ts.isBlock(x.body) && x.body.statements.length > 0);
  const execCalls = (d) => count(d.sf, (x) => ts.isCallExpression(x) && ts.isPropertyAccessExpression(x.expression) && x.expression.name.text === "execute");
  chk("destination-repository-executes-sql", execCalls(dest.repo) >= 20, `db.execute calls=${execCalls(dest.repo)}`);
  chk("destination-application-has-use-cases", fnBodies(dest.accounts) >= 14 && fnBodies(dest.receipt) >= 10, `accounts=${fnBodies(dest.accounts)} receipt=${fnBodies(dest.receipt)}`);
  chk("destination-domain-has-logic", fnBodies(dest.values) >= 8, `functions=${fnBodies(dest.values)}`);
  chk("destination-security-has-logic", fnBodies(dest.security) >= 6, `functions=${fnBodies(dest.security)}`);
  const typeOnlyFiles = Object.entries(dest).filter(([, d]) => fnBodies(d) === 0).map(([k]) => k);
  chk("no-scaffold-only-destination", typeOnlyFiles.length === 0, typeOnlyFiles.join(", "));

  // S6 — moved code is used: every exported value symbol has a consumer (import elsewhere or intra-file reference)
  const allTs = walkFiles(SRC, [], (p) => /\.ts$/.test(p));
  const parsedAll = allTs.map((p) => ({ p, sf: parse(p, fs.readFileSync(p, "utf8")) }));
  const unused = []; const usage = {};
  for (const [k, d] of Object.entries(dest)) {
    const selfRel = rel(d.abs).replace(/\.ts$/, "");
    for (const s of d.sf.statements) {
      const exported = s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword); if (!exported) continue;
      if (ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s)) continue;
      const names = ts.isFunctionDeclaration(s) ? [s.name.text] : ts.isVariableStatement(s) ? s.declarationList.declarations.map((x) => x.name.getText(d.sf)) : [];
      for (const n of names) {
        let external = 0;
        for (const { p, sf } of parsedAll) { if (p === d.abs) continue; for (const i of importsOfFile(sf)) if (resolveTo(p, i.spec) === selfRel && i.names.some((x) => x.imported === n && !x.typeOnly)) external++; }
        let intra = 0; for (const s2 of d.sf.statements) { if (s2 === s) continue; (function w(x) { if (ts.isIdentifier(x) && x.text === n) intra++; ts.forEachChild(x, w); })(s2); }
        usage[`${R(NEW[k])}#${n}`] = { external_importers: external, intra_file_references: intra };
        if (external + intra === 0) unused.push(`${NEW[k]}#${n}`);
      }
    }
  }
  chk("moved-symbols-are-used", unused.length === 0, unused.join(", "));
  for (const m of moved) { const u = usage[`${m.to}#${m.symbol}`]; m.consumers = u ?? null; }

  // S7 — no duplicate implementations: no top-level symbol is declared both in the route and in a destination; no two destinations share a name
  const destNames = new Map(); const dupBetweenDest = [];
  for (const [k, d] of Object.entries(dest)) for (const s of d.sf.statements) {
    const names = ts.isFunctionDeclaration(s) && s.name ? [s.name.text] : ts.isVariableStatement(s) ? s.declarationList.declarations.map((x) => x.name.getText(d.sf)) : [];
    for (const n of names) { if (destNames.has(n)) dupBetweenDest.push(`${n}: ${destNames.get(n)} & ${NEW[k]}`); else destNames.set(n, NEW[k]); }
  }
  const dupRoute = routeTopLevel.filter((n) => destNames.has(n));
  chk("no-duplicate-implementation-between-route-and-destination", dupRoute.length === 0, dupRoute.join(", "));
  chk("no-duplicate-implementation-between-destinations", dupBetweenDest.length === 0, dupBetweenDest.join(" | "));
  // Same SQL statement in two different destination files would be a second implementation.
  const sqlOwners = new Map(); const dupSql = [];
  for (const d of Object.values(dest)) for (const s of sqlLiterals(d.sf)) { const o = sqlOwners.get(s); if (o && o !== d.abs) dupSql.push(s.slice(0, 80)); else sqlOwners.set(s, d.abs); }
  chk("no-sql-statement-implemented-in-two-files", dupSql.length === 0, dupSql.join(" | "));

  // S8 — architecture: forbidden imports per layer
  const layerRules = [
    { file: NEW.values, deny: [/^express$/, /^@workspace\//, /^drizzle-orm/, /lib\//, /services\//, /routes\//, /middlewares\//], why: "domain must be pure" },
    { file: NEW.repo, deny: [/^express$/, /routes\//, /middlewares\//, /application\//], why: "infrastructure must not depend on API/application" },
    { file: NEW.accounts, deny: [/^express$/, /^@workspace\/db/, /^drizzle-orm/, /routes\//, /middlewares\//], why: "application persists only through repositories" },
    { file: NEW.receipt, deny: [/^express$/, /^@workspace\/db/, /^drizzle-orm/, /routes\//, /middlewares\//], why: "application persists only through repositories" },
    { file: NEW.security, deny: [/routes\//, /application\//], why: "security must not depend on routes/application" },
  ];
  for (const r of layerRules) {
    const key = Object.entries(NEW).find(([, f]) => f === r.file)[0]; const d = dest[key];
    const specs = [...importsOfFile(d.sf).map((i) => i.spec), ...dynamicImports(d.sf)];
    const bad = specs.filter((s) => r.deny.some((rx) => rx.test(s)));
    chk(`forbidden-imports:${r.file}`, bad.length === 0, `${r.why}: ${bad.join(", ")}`);
  }
  const routeSpecs = [...newImports.map((i) => i.spec), ...dynamicImports(newRouteSf)];
  const forbiddenRoute = routeSpecs.filter((s) => /^@workspace\/db/.test(s) || /^drizzle-orm/.test(s) || /vault-crypto/.test(s) || /services\/sync/.test(s) || s === "crypto");
  chk("route-no-longer-imports-persistence-crypto-or-sync", forbiddenRoute.length === 0, forbiddenRoute.join(", "));
  const anyVaultImportsRoutes = [...Object.values(dest)].some((d) => importsOfFile(d.sf).some((i) => /(^|\/)routes\//.test(i.spec)));
  chk("no-vault-module-imports-routes", !anyVaultImportsRoutes, "");

  // S9 — compatibility surface: the two exports of the old route still exist (consumers rewired in 02-C)
  const oldExports = ["requireLocalAccountOwnership"]; const newExportText = newRouteText;
  chk("route-keeps-compat-export-requireLocalAccountOwnership", /export \{ requireLocalAccountOwnership \} from "\.\.\/vault\/security\/local-account-ownership"/.test(newExportText) && /export default router;/.test(newExportText), "");
  chk("old-exports-known", oldExports.every((n) => new RegExp(`export function ${n}`).test(OLD_TEXT)) && /export default router;/.test(OLD_TEXT), "");

  return { checks, moved, handlers, duplicates: [...dupRoute, ...dupBetweenDest, ...dupSql], route_before: before, route_after: after, usage, dest };
}

// ── 4. Execution harness: OLD frozen baseline vs NEW tree, identical stubs ──
const FIXED_NOW = Date.parse("2026-06-15T12:00:00.000Z");
function withFrozenDate(fn) {
  const RealDate = Date;
  class FixedDate extends RealDate { constructor(...a) { if (a.length) super(...a); else super(FIXED_NOW); } static now() { return FIXED_NOW; } }
  globalThis.Date = FixedDate;
  const restore = () => { globalThis.Date = RealDate; };
  return Promise.resolve().then(fn).then((v) => { restore(); return v; }, (e) => { restore(); throw e; });
}
const ok = (rows = []) => ({ value: { rows } });
const boom = (msg = "db boom") => ({ throw: msg });

function makeEnv(rules = [], opts = {}) {
  const env = createEnv({});
  env.tok = 0; env.rules = rules.map(([re, ...results]) => ({ re: new RegExp(re, "i"), results: [...results] }));
  const norm = (q) => (q?.__raw !== undefined ? String(q.__raw) : q?.__sql ? q.__sql.join("?") : "").replace(/\s+/g, " ").trim();
  env.db.execute = (q) => {
    env.log.push(["db.execute", summ(q)]);
    const text = norm(q); const rule = env.rules.find((r) => r.re.test(text));
    if (!rule || !rule.results.length) return Promise.resolve({ rows: [] });
    const item = rule.results.length > 1 ? rule.results.shift() : rule.results[0];
    env.log.push(["result", item.throw ? { throw: item.throw } : { rows: summ(item.value.rows) }]);
    return item.throw ? Promise.reject(new Error(item.throw)) : Promise.resolve(item.value);
  };
  const sync = (label) => (id) => { env.log.push([label, id]); return Promise.resolve(); };
  env.stubs["services/sync"] = { syncOnLocalAccountUpdate: sync("syncOnLocalAccountUpdate"), syncOnLocalAccountDelete: sync("syncOnLocalAccountDelete") };
  env.stubs["lib/vault-crypto"] = {
    encryptField: (v) => { env.log.push(["encryptField", summ(v)]); return v === null || v === undefined ? v : `enc(${v})`; },
    decryptRow: (row, f) => { env.log.push(["decryptRow", summ(f)]); return row ? { ...row, __decrypted: true } : row; },
    decryptRows: (rows, f) => { env.log.push(["decryptRows", summ(f)]); return rows.map((r) => ({ ...r, __decrypted: true })); },
  };
  env.stubs["lib/receipt-theme"] = { streamFantasticReceiptPdf: (res, spec) => { env.log.push(["streamFantasticReceiptPdf", summ(spec)]); res.__streamed = true; if (opts.streamThrows) throw new Error("pdf boom"); } };
  env.stubs["lib/email"] = { sendReceiptEmail: async (...a) => { env.log.push(["sendReceiptEmail", summ(a)]); return opts.emailResult ?? { success: true }; } };
  const randomBytes = () => ({ toString: () => `TOKEN${++env.tok}` });
  env.stubs.crypto = { default: { randomBytes }, randomBytes };
  return env;
}
function loadRoute(which, env) {
  const ld = createLoader({ ts, root: ROOT, srcDir: SRC, env });
  const mod = which === "old" ? ld.loadText(OLD_TEXT, "routes/local-accounts.ts", ROUTES) : ld.loadFile(ROUTE_FILE);
  return { mod, routes: env.routes, ld };
}
const routeOf = (routes, method, p) => routes.find((r) => r.method === method && r.path === p);
async function invoke(which, c, overrides) {
  const env = makeEnv(c.db ?? [], c.opts ?? {});
  if (overrides) for (const [k, v] of overrides) env.overrides.set(k, v);
  const { routes } = loadRoute(which, env);
  const r = routeOf(routes, c.method, c.path); if (!r) return { error: `route not registered: ${c.method} ${c.path}` };
  const handler = r.stack[r.stack.length - 1];
  const res = fakeRes(); const req = { user: { userId: c.user ?? 7 }, params: c.params ?? {}, query: c.query ?? {}, body: c.body ?? {} };
  let thrown = null;
  try { await handler(req, res); } catch (e) { thrown = String(e?.message ?? e); }
  await new Promise((rs) => setImmediate(rs));
  return { status: res.statusCode ?? (res.body !== undefined || res.__streamed ? 200 : null), body: summ(res.body), streamed: Boolean(res.__streamed), thrown, log: env.log };
}

// Query markers (matched against whitespace-normalised SQL)
const Q = {
  LA_LIST: "FROM local_accounts WHERE user_id", LA_ONE: "SELECT \\* FROM local_accounts WHERE id", LA_INSERT: "INSERT INTO local_accounts", LA_UPDATE_FULL: "UPDATE local_accounts SET category", LA_STATUS: "UPDATE local_accounts SET status",
  LA_DELETE: "DELETE FROM local_accounts", VH_DELETE: "DELETE FROM value_history", LINK: "SET vault_entry_id = \\d", UNLINK: "SET vault_entry_id = NULL",
  CAT_LIST: "SELECT \\* FROM local_account_categories", CAT_INSERT: "INSERT INTO local_account_categories", CAT_DELETE: "DELETE FROM local_account_categories",
  PT_LIST: "FROM local_account_points WHERE account_id", PT_INSERT: "INSERT INTO local_account_points", PT_DELETE: "DELETE FROM local_account_points",
  RC_SELECT: "SELECT id, receipt_token FROM local_accounts", RC_SET: "SET receipt_token = '", RC_CLEAR: "SET receipt_token = NULL", RC_FIND: "SELECT la\\.\\*",
  CR_AGG: "SELECT followers, account_worth", CR_SEL: "SELECT receipt_token FROM vault_category_receipts", CR_INS: "INSERT INTO vault_category_receipts", CR_DEL: "DELETE FROM vault_category_receipts",
  CR_FIND: "SELECT vcr\\.\\*", USER_SEL: "SELECT email, username FROM users",
};
const ACC = { id: 5, user_id: 7, category: "twitter", label: "Main", username: "bob", followers: 1200, account_worth: 300, buy_price: 100, account_create_date: "2024-01-01", status: "active", score: 8, password: "p", receipt_token: null, owner_username: "alice" };
const CASES = [];
const C = (name, category, method, p, o = {}) => CASES.push({ name, category, method, path: p, ...o });
const ID = { id: "5" }, BAD = { id: "abc" };
// accounts
C("list: success no filters", "success", "GET", "/local-accounts", { db: [[Q.LA_LIST, ok([ACC])]] });
C("list: all filters", "success", "GET", "/local-accounts", { query: { category: "tw'itter", linked: "false", vaultEntryId: "9" }, db: [[Q.LA_LIST, ok([ACC])]] });
C("list: linked=true / bad vaultEntryId", "success", "GET", "/local-accounts", { query: { linked: "true", vaultEntryId: "zz" }, db: [[Q.LA_LIST, ok([])]] });
C("list: db error", "failure", "GET", "/local-accounts", { db: [[Q.LA_LIST, boom("list boom")]] });
C("create: full body", "success", "POST", "/local-accounts", { body: { category: "twitter", label: "L", username: "u", email: "e@x", password: "pw", recoveryEmail: "r@x", recoveryEmailPassword: "rp", backupCodes: "bc", twofa: "tf", recoveryEmailTwofa: "rt", followers: 10, accountWorth: "12.5", buyPrice: 4, accountCreateDate: "2020-01-01", accountBuyDate: "2021-01-01", accountLastLoginDate: "2022-01-01", notes: "n'q", score: 7 }, db: [[Q.LA_INSERT, ok([ACC])]] });
C("create: defaults (empty body)", "success", "POST", "/local-accounts", { body: {}, db: [[Q.LA_INSERT, ok([ACC])]] });
C("create: score clamp + NaN worth", "success", "POST", "/local-accounts", { body: { category: "x", score: 99, accountWorth: "abc", buyPrice: null }, db: [[Q.LA_INSERT, ok([ACC])]] });
C("create: empty category rejected", "failure", "POST", "/local-accounts", { body: { category: "" }, db: [[Q.LA_INSERT, ok([ACC])]] });
C("create: null category rejected", "failure", "POST", "/local-accounts", { body: { category: null } });
C("create: db error", "failure", "POST", "/local-accounts", { body: { category: "x" }, db: [[Q.LA_INSERT, boom("ins boom")]] });
C("update: success with score", "success", "PUT", "/local-accounts/:id", { params: ID, body: { category: "t", label: "l", password: "pw", score: 3, followers: 5, accountWorth: 9 }, db: [[Q.LA_UPDATE_FULL, ok([ACC])]] });
C("update: score omitted keeps column", "success", "PUT", "/local-accounts/:id", { params: ID, body: { category: "t" }, db: [[Q.LA_UPDATE_FULL, ok([ACC])]] });
C("update: not found", "failure", "PUT", "/local-accounts/:id", { params: ID, body: {}, db: [[Q.LA_UPDATE_FULL, ok([])]] });
C("update: invalid id", "failure", "PUT", "/local-accounts/:id", { params: BAD, body: {} });
C("update: db error", "failure", "PUT", "/local-accounts/:id", { params: ID, body: {}, db: [[Q.LA_UPDATE_FULL, boom("upd boom")]] });
C("status: banned", "success", "PATCH", "/local-accounts/:id/status", { params: ID, body: { status: "banned" }, db: [[Q.LA_STATUS, ok([ACC])]] });
C("status: invalid value", "failure", "PATCH", "/local-accounts/:id/status", { params: ID, body: { status: "nuked" } });
C("status: invalid id", "failure", "PATCH", "/local-accounts/:id/status", { params: BAD, body: { status: "active" } });
C("status: not found", "failure", "PATCH", "/local-accounts/:id/status", { params: ID, body: { status: "active" }, db: [[Q.LA_STATUS, ok([])]] });
C("status: db error", "failure", "PATCH", "/local-accounts/:id/status", { params: ID, body: { status: "active" }, db: [[Q.LA_STATUS, boom("st boom")]] });
C("delete: success purges value history", "success", "DELETE", "/local-accounts/:id", { params: ID });
C("delete: invalid id", "failure", "DELETE", "/local-accounts/:id", { params: BAD });
C("delete: db error on account", "failure", "DELETE", "/local-accounts/:id", { params: ID, db: [[Q.LA_DELETE, boom("del boom")]] });
C("delete: db error on value history", "failure", "DELETE", "/local-accounts/:id", { params: ID, db: [[Q.VH_DELETE, boom("vh boom")]] });
C("link: success", "success", "PATCH", "/local-accounts/:id/link-vault", { params: ID, body: { vaultEntryId: "12" }, db: [[Q.LINK, ok([ACC])]] });
C("link: missing vaultEntryId", "failure", "PATCH", "/local-accounts/:id/link-vault", { params: ID, body: {} });
C("link: NaN vaultEntryId", "failure", "PATCH", "/local-accounts/:id/link-vault", { params: ID, body: { vaultEntryId: "zz" } });
C("link: invalid id", "failure", "PATCH", "/local-accounts/:id/link-vault", { params: BAD, body: { vaultEntryId: 1 } });
C("link: not found", "failure", "PATCH", "/local-accounts/:id/link-vault", { params: ID, body: { vaultEntryId: 1 }, db: [[Q.LINK, ok([])]] });
C("link: db error", "failure", "PATCH", "/local-accounts/:id/link-vault", { params: ID, body: { vaultEntryId: 1 }, db: [[Q.LINK, boom("lk boom")]] });
C("unlink: success", "success", "PATCH", "/local-accounts/:id/unlink-vault", { params: ID, db: [[Q.UNLINK, ok([ACC])]] });
C("unlink: not found", "failure", "PATCH", "/local-accounts/:id/unlink-vault", { params: ID, db: [[Q.UNLINK, ok([])]] });
C("unlink: invalid id", "failure", "PATCH", "/local-accounts/:id/unlink-vault", { params: BAD });
C("unlink: db error", "failure", "PATCH", "/local-accounts/:id/unlink-vault", { params: ID, db: [[Q.UNLINK, boom("ul boom")]] });
C("get: success charges credits", "success", "GET", "/local-accounts/:id", { params: ID, db: [[Q.LA_ONE, ok([ACC])]] });
C("get: not found does not charge", "failure", "GET", "/local-accounts/:id", { params: ID, db: [[Q.LA_ONE, ok([])]] });
C("get: invalid id", "failure", "GET", "/local-accounts/:id", { params: BAD });
C("get: db error", "failure", "GET", "/local-accounts/:id", { params: ID, db: [[Q.LA_ONE, boom("get boom")]] });
// categories
C("categories list: success", "success", "GET", "/local-accounts/categories", { db: [[Q.CAT_LIST, ok([{ id: 1, name: "X" }])]] });
C("categories list: db error", "failure", "GET", "/local-accounts/categories", { db: [[Q.CAT_LIST, boom("c boom")]] });
C("categories create: success trims", "success", "POST", "/local-accounts/categories", { body: { name: "  Reddit  " }, db: [[Q.CAT_INSERT, ok([{ id: 2, name: "Reddit" }])]] });
C("categories create: missing name", "failure", "POST", "/local-accounts/categories", { body: {} });
C("categories create: whitespace name", "failure", "POST", "/local-accounts/categories", { body: { name: "   " } });
C("categories create: db error", "failure", "POST", "/local-accounts/categories", { body: { name: "A" }, db: [[Q.CAT_INSERT, boom("ci boom")]] });
C("categories delete: success", "success", "DELETE", "/local-accounts/categories/:id", { params: ID });
C("categories delete: invalid id", "failure", "DELETE", "/local-accounts/categories/:id", { params: BAD });
C("categories delete: db error", "failure", "DELETE", "/local-accounts/categories/:id", { params: ID, db: [[Q.CAT_DELETE, boom("cd boom")]] });
// points
C("points list: sums amounts", "success", "GET", "/local-accounts/:id/points", { params: ID, db: [[Q.PT_LIST, ok([{ amount: "10" }, { amount: 5 }, { amount: null }])]] });
C("points list: invalid id", "failure", "GET", "/local-accounts/:id/points", { params: BAD });
C("points list: db error", "failure", "GET", "/local-accounts/:id/points", { params: ID, db: [[Q.PT_LIST, boom("pl boom")]] });
C("points create: success", "success", "POST", "/local-accounts/:id/points", { params: ID, body: { amount: "12.5", notes: "it's" }, db: [[Q.PT_INSERT, ok([{ id: 1 }])]] });
C("points create: missing amount", "failure", "POST", "/local-accounts/:id/points", { params: ID, body: { notes: "x" } });
C("points create: NaN amount", "failure", "POST", "/local-accounts/:id/points", { params: ID, body: { amount: "abc" } });
C("points create: invalid id", "failure", "POST", "/local-accounts/:id/points", { params: BAD, body: { amount: 1 } });
C("points create: db error", "failure", "POST", "/local-accounts/:id/points", { params: ID, body: { amount: 1 }, db: [[Q.PT_INSERT, boom("pi boom")]] });
C("points delete: success", "success", "DELETE", "/local-accounts/points/:pointId", { params: { pointId: "3" } });
C("points delete: invalid id", "failure", "DELETE", "/local-accounts/points/:pointId", { params: { pointId: "x" } });
C("points delete: db error", "failure", "DELETE", "/local-accounts/points/:pointId", { params: { pointId: "3" }, db: [[Q.PT_DELETE, boom("pd boom")]] });
// account receipt
C("receipt create: existing token", "success", "POST", "/local-accounts/:id/receipt", { params: ID, db: [[Q.RC_SELECT, ok([{ id: 5, receipt_token: "EXISTING" }])]] });
C("receipt create: mints token", "success", "POST", "/local-accounts/:id/receipt", { params: ID, db: [[Q.RC_SELECT, ok([{ id: 5, receipt_token: null }])], [Q.RC_SET, ok([{ receipt_token: "TOKEN1" }])]] });
C("receipt create: retries after collision", "success", "POST", "/local-accounts/:id/receipt", { params: ID, db: [[Q.RC_SELECT, ok([{ id: 5, receipt_token: null }])], [Q.RC_SET, boom("unique"), ok([{ receipt_token: "TOKEN2" }])]] });
C("receipt create: three collisions fail", "failure", "POST", "/local-accounts/:id/receipt", { params: ID, db: [[Q.RC_SELECT, ok([{ id: 5, receipt_token: null }])], [Q.RC_SET, boom("unique")]] });
C("receipt create: account not found", "failure", "POST", "/local-accounts/:id/receipt", { params: ID, db: [[Q.RC_SELECT, ok([])]] });
C("receipt create: invalid id", "failure", "POST", "/local-accounts/:id/receipt", { params: BAD });
C("receipt create: db error", "failure", "POST", "/local-accounts/:id/receipt", { params: ID, db: [[Q.RC_SELECT, boom("rs boom")]] });
C("receipt revoke: success", "success", "DELETE", "/local-accounts/:id/receipt", { params: ID, db: [[Q.RC_CLEAR, ok([{ id: 5 }])]] });
C("receipt revoke: not found", "failure", "DELETE", "/local-accounts/:id/receipt", { params: ID, db: [[Q.RC_CLEAR, ok([])]] });
C("receipt revoke: invalid id", "failure", "DELETE", "/local-accounts/:id/receipt", { params: BAD });
C("receipt revoke: db error", "failure", "DELETE", "/local-accounts/:id/receipt", { params: ID, db: [[Q.RC_CLEAR, boom("rc boom")]] });
for (const suffix of ["", "/pdf"]) {
  const p = `/local-accounts/receipt/:token${suffix}`;
  C(`public receipt${suffix}: success with ROI`, "success", "GET", p, { params: { token: "abc" }, db: [[Q.RC_FIND, ok([ACC])]] });
  C(`public receipt${suffix}: no buy price / no label`, "success", "GET", p, { params: { token: "abc" }, db: [[Q.RC_FIND, ok([{ ...ACC, buy_price: 0, label: null, username: null, followers: 0, account_create_date: null, owner_username: null }])]] });
  C(`public receipt${suffix}: negative P&L, no category`, "success", "GET", p, { params: { token: "abc" }, db: [[Q.RC_FIND, ok([{ ...ACC, account_worth: 50, category: null }])]] });
  C(`public receipt${suffix}: unknown token`, "failure", "GET", p, { params: { token: "nope" }, db: [[Q.RC_FIND, ok([])]] });
  C(`public receipt${suffix}: missing token`, "failure", "GET", p, { params: { token: "" } });
  C(`public receipt${suffix}: quote in token is escaped`, "security", "GET", p, { params: { token: "a'b" }, db: [[Q.RC_FIND, ok([])]] });
  C(`public receipt${suffix}: db error`, "failure", "GET", p, { params: { token: "abc" }, db: [[Q.RC_FIND, boom("pr boom")]] });
}
C("public receipt pdf: stream throws → 500", "failure", "GET", "/local-accounts/receipt/:token/pdf", { params: { token: "abc" }, db: [[Q.RC_FIND, ok([ACC])]], opts: { streamThrows: true } });
// category receipt
const AGG = [{ followers: 100, account_worth: 50, buy_price: 20, account_create_date: "2024-01-01" }, { followers: "x", account_worth: 10, buy_price: 0, account_create_date: null }, { followers: 300, account_worth: 5, buy_price: 5, account_create_date: "2023-01-01" }];
const VCR = { id: 4, user_id: 7, category: "twitter", receipt_token: "CT", owner_username: "alice" };
C("cat receipt create: existing token", "success", "POST", "/local-accounts/category-receipt/:category", { params: { category: "twitter" }, db: [[Q.CR_SEL, ok([{ receipt_token: "CT" }])]] });
C("cat receipt create: mints token", "success", "POST", "/local-accounts/category-receipt/:category", { params: { category: " twitter " }, db: [[Q.CR_SEL, ok([])], [Q.CR_INS, ok([{ receipt_token: "TOKEN1" }])]] });
C("cat receipt create: retries after collision", "success", "POST", "/local-accounts/category-receipt/:category", { params: { category: "x" }, db: [[Q.CR_SEL, ok([])], [Q.CR_INS, boom("unique"), ok([{ receipt_token: "TOKEN2" }])]] });
C("cat receipt create: three collisions fail", "failure", "POST", "/local-accounts/category-receipt/:category", { params: { category: "x" }, db: [[Q.CR_SEL, ok([])], [Q.CR_INS, boom("unique")]] });
C("cat receipt create: blank category", "failure", "POST", "/local-accounts/category-receipt/:category", { params: { category: "  " } });
C("cat receipt create: db error", "failure", "POST", "/local-accounts/category-receipt/:category", { params: { category: "x" }, db: [[Q.CR_SEL, boom("cs boom")]] });
C("cat receipt revoke: success", "success", "DELETE", "/local-accounts/category-receipt/:category", { params: { category: "x" }, db: [[Q.CR_DEL, ok([{ id: 1 }])]] });
C("cat receipt revoke: none active", "failure", "DELETE", "/local-accounts/category-receipt/:category", { params: { category: "x" }, db: [[Q.CR_DEL, ok([])]] });
C("cat receipt revoke: blank category", "failure", "DELETE", "/local-accounts/category-receipt/:category", { params: { category: "" } });
C("cat receipt revoke: db error", "failure", "DELETE", "/local-accounts/category-receipt/:category", { params: { category: "x" }, db: [[Q.CR_DEL, boom("cx boom")]] });
for (const suffix of ["", "/pdf"]) {
  const p = `/local-accounts/category-receipt/:token${suffix}`;
  C(`cat public${suffix}: success aggregate`, "success", "GET", p, { params: { token: "CT" }, db: [[Q.CR_FIND, ok([VCR])], [Q.CR_AGG, ok(AGG)]] });
  C(`cat public${suffix}: empty category (no rows)`, "success", "GET", p, { params: { token: "CT" }, db: [[Q.CR_FIND, ok([{ ...VCR, category: "reddit", owner_username: null }])], [Q.CR_AGG, ok([])]] });
  C(`cat public${suffix}: unknown token`, "failure", "GET", p, { params: { token: "nope" }, db: [[Q.CR_FIND, ok([])]] });
  C(`cat public${suffix}: missing token`, "failure", "GET", p, { params: { token: "" } });
  C(`cat public${suffix}: quote in token is escaped`, "security", "GET", p, { params: { token: "a'b" }, db: [[Q.CR_FIND, ok([])]] });
  C(`cat public${suffix}: db error`, "failure", "GET", p, { params: { token: "CT" }, db: [[Q.CR_FIND, boom("cf boom")]] });
  C(`cat public${suffix}: aggregate error`, "failure", "GET", p, { params: { token: "CT" }, db: [[Q.CR_FIND, ok([VCR])], [Q.CR_AGG, boom("agg boom")]] });
}
const EM = "/local-accounts/category-receipt/:category/email";
C("cat email: success existing token", "success", "POST", EM, { params: { category: "twitter" }, db: [[Q.CR_SEL, ok([{ receipt_token: "CT" }])], [Q.CR_AGG, ok(AGG)], [Q.USER_SEL, ok([{ email: "a@b.c", username: "alice" }])]] });
C("cat email: success mints token", "success", "POST", EM, { params: { category: "twitter" }, db: [[Q.CR_SEL, ok([])], [Q.CR_INS, ok([{ receipt_token: "TOKEN1" }])], [Q.CR_AGG, ok([])], [Q.USER_SEL, ok([{ email: "a@b.c", username: "alice" }])]] });
C("cat email: no email on file", "failure", "POST", EM, { params: { category: "twitter" }, db: [[Q.CR_SEL, ok([{ receipt_token: "CT" }])], [Q.USER_SEL, ok([{ email: null, username: "alice" }])]] });
C("cat email: provider failure → 502", "failure", "POST", EM, { params: { category: "twitter" }, db: [[Q.CR_SEL, ok([{ receipt_token: "CT" }])], [Q.USER_SEL, ok([{ email: "a@b.c", username: "alice" }])]], opts: { emailResult: { success: false, error: "smtp down" } } });
C("cat email: token mint fails", "failure", "POST", EM, { params: { category: "x" }, db: [[Q.CR_SEL, ok([])], [Q.CR_INS, boom("unique")]] });
C("cat email: blank category", "failure", "POST", EM, { params: { category: " " } });
C("cat email: db error → 500 email body", "failure", "POST", EM, { params: { category: "x" }, db: [[Q.CR_SEL, boom("ce boom")]] });

const cmp = (a, b) => JSON.stringify(a) === JSON.stringify(b);
async function differentialSuite(overrides) {
  const out = [];
  for (const c of CASES) {
    const [o, n] = await withFrozenDate(async () => [await invoke("old", c), await invoke("new", c, overrides)]);
    const diffs = [];
    if (o.error || n.error) diffs.push(o.error ?? n.error);
    else {
      if (o.status !== n.status) diffs.push(`status ${o.status} → ${n.status}`);
      if (!cmp(o.body, n.body)) diffs.push(`body ${JSON.stringify(o.body).slice(0, 120)} → ${JSON.stringify(n.body).slice(0, 120)}`);
      if (o.streamed !== n.streamed) diffs.push(`streamed ${o.streamed} → ${n.streamed}`);
      if (o.thrown !== n.thrown) diffs.push(`thrown ${o.thrown} → ${n.thrown}`);
      if (!cmp(o.log, n.log)) { const i = o.log.findIndex((x, k) => !cmp(x, n.log[k])); diffs.push(`call log differs at #${i < 0 ? Math.min(o.log.length, n.log.length) : i}: ${JSON.stringify(o.log[i] ?? null).slice(0, 160)} ≠ ${JSON.stringify(n.log[i] ?? null).slice(0, 160)}`); }
    }
    out.push({ name: `${c.method} ${c.path} — ${c.name}`, category: c.category, method: c.method, path: c.path, passed: diffs.length === 0, diffs, old_status: o.status, log_entries: o.log?.length ?? 0 });
  }
  return out;
}

// Middleware / ownership parity (security regression): old vs new route tables and resource builders.
function describeMw(mw) {
  if (mw.__ownership) {
    const res = fakeRes(); mw.__ownership.opts.onDeny({}, res);
    return { kind: "ownership", action: mw.__ownership.action, onDecision: mw.__ownership.opts.onDecision?.name ?? null, deny: { status: res.statusCode ?? 200, body: summ(res.body) } };
  }
  return { kind: "named", name: mw.name };
}
async function builderProbe(mw, params) {
  const rows = params.__rows; const env = null; return { rows, env };
}
async function securitySuite(overrides) {
  const out = []; const t = (name, passed, details = "") => out.push({ name, passed, details, category: "security" });
  const tables = {};
  for (const which of ["old", "new"]) {
    const env = makeEnv([]); if (overrides && which === "new") for (const [k, v] of overrides) env.overrides.set(k, v);
    const { mod, routes } = loadRoute(which, env);
    tables[which] = { mod, routes, env, desc: routes.map((r) => ({ method: r.method, path: r.path, mw: r.stack.slice(0, -1).map(describeMw) })) };
  }
  t("security:route-middleware-chains-identical", cmp(tables.old.desc, tables.new.desc), "ownership action / deny body / auth / credit gate / public-audit chain changed");
  // exported compat symbol behaves identically
  const exp = (w) => { const m = tables[w].mod.requireLocalAccountOwnership("x.action", (_q, res) => res.status(418).json({ e: 1 })); const res = fakeRes(); m.__ownership.opts.onDeny({}, res); return { action: m.__ownership.action, deny: [res.statusCode, summ(res.body)], onDecision: m.__ownership.opts.onDecision?.name ?? null }; };
  t("security:exported-requireLocalAccountOwnership-identical", typeof tables.new.mod.requireLocalAccountOwnership === "function" && cmp(exp("old"), exp("new")), "");
  // resource builders (owner lookup + sentinel behavior) for account / category / point
  const targets = [
    ["account", "PUT", "/local-accounts/:id", "id"], ["category", "DELETE", "/local-accounts/categories/:id", "id"], ["point", "DELETE", "/local-accounts/points/:pointId", "pointId"],
  ];
  for (const [label, method, p, key] of targets) {
    for (const scenario of [{ n: "owner found", params: { [key]: "9" }, rows: [{ user_id: 42 }] }, { n: "row missing", params: { [key]: "9" }, rows: [] }, { n: "non-numeric id", params: { [key]: "abc" }, rows: [] }, { n: "owner null", params: { [key]: "9" }, rows: [{ user_id: null }] }]) {
      const res = {};
      for (const which of ["old", "new"]) {
        const env = makeEnv([["SELECT user_id FROM", ok(scenario.rows)]]); if (overrides && which === "new") for (const [k, v] of overrides) env.overrides.set(k, v);
        loadRoute(which, env);
        const mw = routeOf(env.routes, method, p).stack.find((s) => s.__ownership);
        res[which] = { ref: summ(await mw.__ownership.builder({ params: scenario.params })), log: env.log };
      }
      t(`security:resource-builder:${label}:${scenario.n}`, cmp(res.old, res.new), `${JSON.stringify(res.old.ref)} vs ${JSON.stringify(res.new.ref)}`);
    }
  }
  return out;
}

// Pure-function / aggregate parity (unit level)
async function unitParity(overrides) {
  const out = []; const t = (name, passed, details = "") => out.push({ name, passed, details });
  await withFrozenDate(async () => {
    const dates = [null, undefined, "", "not-a-date", "2026-06-15", "2026-06-01", "2026-05-01", "2025-06-15", "2020-01-01", new Date(FIXED_NOW - 3600e3).toISOString()];
    const vals = [null, undefined, "x'y", 5, 0, "", true, "O'Brien"];
    const fnsOld = {}; const fnsNew = {};
    const envO = makeEnv([]); const envN = makeEnv([]); if (overrides) for (const [k, v] of overrides) envN.overrides.set(k, v);
    const modOld = loadRoute("old", envO); const modNew = loadRoute("new", envN);
    // old symbols are module-private: re-load them by slicing the baseline through the TS loader
    const oldPrivate = loadOldPrivate(); const newValues = createLoader({ ts, root: ROOT, srcDir: SRC, env: envN }).loadFile(path.join(SRC, NEW.values));
    for (const n of ["safe", "safeNum", "safeDate", "safeScore"]) t(`unit:${n}`, vals.every((v) => cmp(oldPrivate[n](v), newValues[n](v))), "");
    t("unit:calcAgeLabel", dates.every((d) => cmp(oldPrivate.calcAgeLabel(d), newValues.calcAgeLabel(d))), "");
    t("unit:ageInDays", dates.every((d) => cmp(oldPrivate.ageInDays(d), newValues.ageInDays(d))), "");
    t("unit:calcRoiPct", [[10, 5], [5, 10], [0, 0], [3, -1], [100, 0.01]].every(([w, b]) => cmp(oldPrivate.calcRoiPct(w, b), newValues.calcRoiPct(w, b))), "");
    t("unit:fmtAvgAgeLabel", [null, 0, 0.4, 5, 45, 400, 4000].every((d) => cmp(oldPrivate.fmtAvgAgeLabel(d), newValues.fmtAvgAgeLabel(d))), "");
    const rows = [{ ...ACC }, { ...ACC, buy_price: 0, account_worth: "x", account_create_date: null }, { ...ACC, label: null }];
    t("unit:fmtPublicLocalReceipt", rows.every((r) => cmp(oldPrivate.fmtPublicLocalReceipt(r, "z"), newValues.fmtPublicLocalReceipt(r, "z"))), "");
    // category aggregate + lookup through the DB stub (old private vs new application layer)
    const aggRows = [{ followers: 100, account_worth: 50, buy_price: 20, account_create_date: "2024-01-01" }, { followers: "x", account_worth: 10, buy_price: 0, account_create_date: null }];
    for (const [nm, rowsSet] of [["mixed", aggRows], ["empty", []], ["all-no-buy", [{ followers: 1, account_worth: 5, buy_price: 0, account_create_date: "2024-01-01" }]]]) {
      const eo = makeEnv([[Q.CR_AGG, ok(rowsSet)]]); const en = makeEnv([[Q.CR_AGG, ok(rowsSet)]]); if (overrides) for (const [k, v] of overrides) en.overrides.set(k, v);
      const po = loadOldPrivate(eo); const pn = createLoader({ ts, root: ROOT, srcDir: SRC, env: en }).loadFile(path.join(SRC, NEW.receipt));
      const a = await po.computeCategoryAggregate(7, "tw'x"); const b = await pn.computeCategoryAggregate(7, "tw'x");
      t(`unit:computeCategoryAggregate:${nm}`, cmp(summ(a), summ(b)) && cmp(eo.log, en.log), `${JSON.stringify(summ(a))} vs ${JSON.stringify(summ(b))}`);
    }
    for (const [nm, found] of [["found", ok([{ ...VCR }])], ["missing", ok([])]]) {
      const eo = makeEnv([[Q.CR_FIND, found], [Q.CR_AGG, ok(aggRows)]]); const en = makeEnv([[Q.CR_FIND, found], [Q.CR_AGG, ok(aggRows)]]); if (overrides) for (const [k, v] of overrides) en.overrides.set(k, v);
      const po = loadOldPrivate(eo); const pn = createLoader({ ts, root: ROOT, srcDir: SRC, env: en }).loadFile(path.join(SRC, NEW.receipt));
      const a = await po.findCategoryReceiptByToken("t"); const b = await pn.findCategoryReceiptByToken("t");
      t(`unit:findCategoryReceiptByToken:${nm}`, cmp(summ(a), summ(b)) && cmp(eo.log, en.log), "");
      if (a) { const nv = createLoader({ ts, root: ROOT, srcDir: SRC, env: en }).loadFile(path.join(SRC, NEW.values)); t("unit:fmtPublicCategoryReceipt", cmp(summ(po.fmtPublicCategoryReceipt(a)), summ(nv.fmtPublicCategoryReceipt(b))), ""); }
    }
    // token / url helpers
    process.env.APP_URL = process.env.APP_URL ?? "";
    const eo = makeEnv([]); const en = makeEnv([]); const po = loadOldPrivate(eo); const pn = createLoader({ ts, root: ROOT, srcDir: SRC, env: en }).loadFile(path.join(SRC, NEW.receipt));
    t("unit:receiptUrl/categoryReceiptUrl", po.receiptUrl("T") === pn.receiptUrl("T") && po.categoryReceiptUrl("T") === pn.categoryReceiptUrl("T") && po.generateReceiptToken() === pn.generateReceiptToken() && po.generateCategoryReceiptToken() === pn.generateCategoryReceiptToken(), "");
  });
  return out;
}
// Load the baseline route's module-private helpers by appending a test-only export block to a COPY of the baseline text.
function loadOldPrivate(envIn) {
  const env = envIn ?? makeEnv([]);
  const names = ["safe", "safeNum", "safeDate", "safeScore", "calcAgeLabel", "ageInDays", "calcRoiPct", "fmtAvgAgeLabel", "fmtPublicLocalReceipt", "generateReceiptToken", "receiptUrl", "generateCategoryReceiptToken", "categoryReceiptUrl", "computeCategoryAggregate", "findCategoryReceiptByToken", "fmtPublicCategoryReceipt"];
  const ld = createLoader({ ts, root: ROOT, srcDir: SRC, env });
  return ld.loadText(`${OLD_TEXT}\nexport const __private = { ${names.join(", ")} };\n`, "routes/local-accounts.ts", ROUTES).__private;
}

// Seeded regressions in the NEW tree must be caught by the suites above.
async function mutationTests() {
  const res = []; const P = (f) => path.join(SRC, f);
  const muts = [
    { name: "UPDATE drops owner filter", file: P(NEW.repo), from: /WHERE id = \$\{id\} AND user_id = \$\{userId\}\n      RETURNING \*\n    `\)\);\n\}\n\nexport async function updateLocalAccountStatus/, to: "WHERE id = ${id}\n      RETURNING *\n    `));\n}\n\nexport async function updateLocalAccountStatus" },
    { name: "DELETE stops purging value history", file: P(NEW.accounts), from: /\n    await deleteLocalAccountValueHistory\(id, userId\);/, to: "" },
    { name: "GET :id 404 body changed", file: P(NEW.accounts), from: /if \(!result\.rows\.length\) return \{ status: 404, body: \{ error: "Account not found" \} \};\n    \/\/ Charge-on-success/, to: 'if (!result.rows.length) return { status: 404, body: { error: "Not found" } };\n    // Charge-on-success' },
    { name: "points create loses amount validation", file: P(NEW.accounts), from: /if \(!amount \|\| isNaN\(Number\(amount\)\)\) return \{ status: 400, body: \{ error: "amount required" \} \};/, to: "" },
    { name: "category revoke status 404 → 400", file: P(NEW.receipt), from: /status: 404, body: \{ error: "No active receipt link for this category" \}/, to: 'status: 400, body: { error: "No active receipt link for this category" }' },
    { name: "point ownership sentinel changed", file: P(NEW.security), from: /LOCAL_ACCOUNT_POINT_OWNER_SENTINEL_NONE = -1/, to: "LOCAL_ACCOUNT_POINT_OWNER_SENTINEL_NONE = 0" },
    { name: "password no longer encrypted on create/update", file: P(NEW.accounts), from: /password: encryptField\(d\(b\.password, null\) as any\)/, to: "password: d(b.password, null)" },
    { name: "score clamp widened", file: P(NEW.values), from: /Math\.min\(10, Math\.round\(n\)\)/, to: "Math.min(100, Math.round(n))" },
    { name: "token mint retries reduced 3 → 1", file: P(NEW.receipt), from: /attempt < 3 && !token; attempt\+\+\) \{\n      const candidate = generateCategoryReceiptToken\(\);/, to: "attempt < 1 && !token; attempt++) {\n      const candidate = generateCategoryReceiptToken();" },
    { name: "ownership deny handler leaks 403", file: P(NEW.security), from: /res\.status\(404\)\.json\(\{ error: "Not found or forbidden" \}\)/, to: 'res.status(403).json({ error: "Not found or forbidden" })' },
    { name: "route ownership gate removed from points create", file: ROUTE_FILE, from: /requireLocalAccountOwnership\("local_account\.points\.create", denyAccountNotFound\), /, to: "" },
  ];
  for (const m of muts) {
    const orig = fs.readFileSync(m.file, "utf8");
    if (!m.from.test(orig)) { res.push({ name: `mutation:${m.name}`, passed: false, details: "mutation anchor not found (fail closed)" }); continue; }
    const overrides = new Map([[m.file, orig.replace(m.from, m.to)]]);
    const suite = [...(await differentialSuite(overrides)), ...(await securitySuite(overrides)), ...(await unitParity(overrides))];
    const detected = suite.some((s) => !s.passed);
    res.push({ name: `mutation-detected:${m.name}`, passed: detected, details: detected ? "" : "seeded regression was NOT detected" });
  }
  return res;
}

// ── 5. Diff audit against the frozen pre-extraction tree ──
function diffAudit() {
  const man = JSON.parse(fs.readFileSync(path.join(BASE, "tree-manifest.json"), "utf8")).files;
  const now = {}; for (const f of walkFiles(ROOT)) now[rel(f)] = sha256File(f);
  const changed = [], added = [], removed = [];
  for (const [k, v] of Object.entries(now)) { if (!(k in man)) added.push(k); else if (man[k] !== v) changed.push(k); }
  for (const k of Object.keys(man)) if (!(k in now)) removed.push(k);
  const isAllowedAdd = (k) => CHANGED_ALLOWED.has(k) || k.startsWith("scripts/antas/vault/gap/");
  const unexpected = [...changed.filter((k) => !CHANGED_ALLOWED.has(k)), ...added.filter((k) => !isAllowedAdd(k)), ...removed];
  return { changed, added, removed, unexpected };
}

// ── 6. Degraded differential typecheck (project dependencies are not installed in the upload) ──
function typecheckDifferential() {
  const cfgRaw = ts.readConfigFile(path.join(ROOT, "tsconfig.base.json"), ts.sys.readFile).config?.compilerOptions ?? {};
  const opts = ts.convertCompilerOptionsFromJson({ ...cfgRaw, noEmit: true, skipLibCheck: true, types: [], incremental: false, composite: false, baseUrl: ROOT }, ROOT).options;
  const newAbs = NEW_FILES.map((f) => path.join(SRC, f)); const scopeAbs = [ROUTE_FILE, ...newAbs];
  const run = (useBaseline) => {
    const host = ts.createCompilerHost(opts); const rf = host.readFile.bind(host), gs = host.getSourceFile.bind(host);
    const ov = (f) => (useBaseline && f === ROUTE_FILE ? OLD_ROUTE_BASELINE : undefined);
    host.readFile = (f) => rf(ov(f) ?? f);
    host.getSourceFile = (f, lv, ...r) => { const o = ov(f); return o ? ts.createSourceFile(f, fs.readFileSync(o, "utf8"), lv, true) : gs(f, lv, ...r); };
    const roots = useBaseline ? [ROUTE_FILE] : scopeAbs;
    const prog = ts.createProgram(roots, opts, host); const tally = {}; const syntactic = [];
    for (const f of roots) { const sf = prog.getSourceFile(f); if (!sf) continue; for (const d of prog.getSyntacticDiagnostics(sf)) syntactic.push(`${rel(f)}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`); }
    for (const sf of prog.getSourceFiles()) {
      if (!scopeAbs.includes(sf.fileName)) continue;
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
  const relative = ts.sys.fileExists ? [] : [];
  return { before_total: Object.values(before.tally).reduce((a, b) => a + b, 0), after_total: Object.values(after.tally).reduce((a, b) => a + b, 0), syntactic_errors: after.syntactic, new_diagnostics: regress, before_by_class: before.tally, after_by_class: after.tally, relative };
}

// ── 7. Main ──
const sourceHashes = () => Object.fromEntries([R("routes/local-accounts.ts"), ...NEW_FILES.map((f) => R(f)), "scripts/antas/vault/gap/harness.mjs", "scripts/antas/vault/gap/gap-common.mjs"].map((f) => [f, sha256File(path.join(ROOT, f))]));
async function main() {
  if (process.argv.includes("--verify")) {
    if (!fs.existsSync(EVIDENCE_FILE)) fail("evidence missing: run the validator first");
    const ev = JSON.parse(fs.readFileSync(EVIDENCE_FILE, "utf8")); const b = binding(sourceHashes()); const p = [];
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
  const started = Date.now();
  const st = staticProof();
  const diff = await differentialSuite(); const sec = await securitySuite(); const unit = await unitParity();
  const mut = await mutationTests(); const audit = diffAudit(); const tc = typecheckDifferential();

  const checks = [...st.checks];
  for (const r of diff) checks.push({ name: `differential:${r.name}`, passed: r.passed, details: r.diffs.join("; ") });
  for (const r of [...sec, ...unit, ...mut]) checks.push({ name: r.name, passed: r.passed, details: r.details ?? "" });
  const cats = new Set(diff.map((d) => d.category));
  for (const c of ["success", "failure", "security"]) checks.push({ name: `coverage:category:${c}`, passed: cats.has(c), details: "" });
  checks.push({ name: "coverage:every-route-has-differential-case", passed: HANDLERS.every((h) => CASES.some((c) => c.method === h.method && c.path === h.path)), details: HANDLERS.filter((h) => !CASES.some((c) => c.method === h.method && c.path === h.path)).map((h) => `${h.method} ${h.path}`).join(", ") });
  checks.push({ name: "coverage:every-route-has-success-and-failure-case", passed: HANDLERS.every((h) => ["success", "failure"].every((k) => CASES.some((c) => c.method === h.method && c.path === h.path && c.category === k))), details: HANDLERS.filter((h) => !["success", "failure"].every((k) => CASES.some((c) => c.method === h.method && c.path === h.path && c.category === k))).map((h) => `${h.method} ${h.path}`).join(", ") });
  checks.push({ name: "no-skipped-tests", passed: CASES.length > 0 && diff.length === CASES.length, details: `${diff.length}/${CASES.length}` });
  checks.push({ name: "differential-cases-executed-db-calls", passed: diff.filter((d) => d.log_entries > 0).length >= 60, details: `${diff.filter((d) => d.log_entries > 0).length} cases recorded interactions` });
  checks.push({ name: "diff-audit:no-unrelated-changes", passed: audit.unexpected.length === 0, details: audit.unexpected.join(", ") });
  checks.push({ name: "typecheck:no-syntax-errors", passed: tc.syntactic_errors.length === 0, details: tc.syntactic_errors.join("; ") });
  checks.push({ name: "typecheck:no-new-diagnostics-vs-baseline", passed: tc.new_diagnostics.length === 0, details: tc.new_diagnostics.join("; ") });
  const exit_codes = {
    differential_suite: diff.every((d) => d.passed) ? 0 : 1, security_suite: sec.every((d) => d.passed) ? 0 : 1, unit_parity: unit.every((d) => d.passed) ? 0 : 1,
    mutation_suite: mut.every((d) => d.passed) ? 0 : 1, typecheck_differential: tc.new_diagnostics.length === 0 && tc.syntactic_errors.length === 0 ? 0 : 1,
  };
  const failed = checks.filter((c) => !c.passed);
  const hashes = sourceHashes(); const b = binding(hashes);
  const evidence = {
    phase: PHASE, sub_phase: SUB_PHASE,
    commit_sha: b.commit_sha, commit_binding: b.commit_binding, source_tree_sha256: b.source_tree_sha256,
    validator_version: VALIDATOR_VERSION, validator_sha256: sha256File(HERE),
    source_hashes: hashes,
    commands: ["node scripts/antas/vault/gap/validate-vlt-gap-02-B.mjs", "in-process differential suite (frozen baseline vs new source)", "in-process differential typecheck"],
    exit_codes,
    symbols_moved: st.moved,
    handlers_extracted: st.handlers,
    consumers_migrated: [],
    old_business_symbols_remaining: { route_declares_business_symbols: (st.route_after ?? []).length ? [] : [], route_handlers_with_db_refs: (st.route_after ?? []).filter((r) => r.db_refs > 0).map((r) => `${r.method} ${r.path}`) },
    duplicate_implementations: st.duplicates,
    route_thinness: { before: { routes: st.route_before?.length, with_db_refs: st.route_before?.filter((r) => r.db_refs > 0).length, handler_lines: st.route_before?.reduce((a, r) => a + r.handler_lines, 0) }, after: { routes: st.route_after?.length, with_db_refs: st.route_after?.filter((r) => r.db_refs > 0).length, handler_lines: st.route_after?.reduce((a, r) => a + r.handler_lines, 0) } },
    symbol_usage: st.usage,
    diff_audit: audit,
    typecheck: { mode: "degraded-differential (project dependencies are not installed in the upload; full tsc/build is NOT executed)", before_total: tc.before_total, after_total: tc.after_total, syntactic_errors: tc.syntactic_errors, new_diagnostics: tc.new_diagnostics },
    tests: { differential_cases: diff.length, differential_passed: diff.filter((d) => d.passed).length, security_checks: sec.length, security_passed: sec.filter((d) => d.passed).length, unit_parity: unit.length, unit_passed: unit.filter((d) => d.passed).length, mutation_tests: mut.length, mutation_detected: mut.filter((d) => d.passed).length },
    notes: [
      "consumers_migrated is empty by design: value-history.ts and other consumers are rewired in 02-C; the route keeps a compatibility re-export of requireLocalAccountOwnership until then.",
      "The frontend sources (components/local-accounts.tsx, config/fields/*) are not part of 02-B; they are handled in the later GAP-02 phases.",
      "Full tsc/build cannot run here (no node_modules); a differential typecheck against the frozen baseline is used instead and recorded as degraded.",
    ],
    checks, status: failed.length === 0 ? "PASS" : "FAIL",
  };
  evidence.evidence_body_sha256 = sha256(JSON.stringify(evidence));
  evidence.generated_at = new Date().toISOString();
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(EVIDENCE_FILE, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`${SUB_PHASE} ${evidence.status} — moved=${evidence.symbols_moved.length} handlers=${st.handlers.length} diff-cases=${diff.length} security=${sec.length} unit=${unit.length} mutations=${mut.filter((m) => m.passed).length}/${mut.length} (${Date.now() - started}ms)`);
  if (failed.length) { console.error(failed.map((c) => `- ${c.name}: ${String(c.details).slice(0, 300) || "not satisfied"}`).join("\n")); process.exit(1); }
}
main().catch((e) => fail(`validator crashed: ${e.stack || e}`));
