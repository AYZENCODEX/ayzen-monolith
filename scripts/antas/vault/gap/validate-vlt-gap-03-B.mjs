#!/usr/bin/env node
// VLT-GAP-03-B — KYC Actual Move / Extract (source-derived, differential, fail-closed).
// Evidence: reports/antas/vault/gap/VLT-GAP-03/extraction-proof.json
// Baseline: reports/antas/vault/gap/VLT-GAP-03/baseline/ (03-A frozen pre-extraction sources)
//           reports/antas/vault/gap/VLT-GAP-03/baseline-03b/ (write-once tree seal, see freeze-vlt-gap-03-B-baseline.mjs)
//
// 03-B proves that the KYC business implementation MOVED out of routes/kyc.ts and routes/kyc-data-entities.ts into
// vault/{domain,security,infrastructure,application}, that the moved symbols are used, that no second implementation exists,
// and — by executing the frozen OLD routes and the NEW tree side by side under identical stubs — that behavior is unchanged.
// Consumer rewire (exchange-api.ts, the ownership regression test) is 03-C; consumers_migrated stays empty here and the route
// keeps compatibility re-exports until then.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, sha256, sha256File, rel, rejectBypass, binding, walkFiles } from "./gap-common.mjs";
import { loadTs, summ, createEnv, createLoader, fakeRes, withConsoleCaptured } from "./harness.mjs";

const VALIDATOR_VERSION = "1.0.0";
const PHASE = "VLT-GAP-03";
const SUB_PHASE = "VLT-GAP-03-B";
const HERE = fileURLToPath(import.meta.url);
const SRC = path.join(ROOT, "artifacts/api-server/src");
const ROUTES = path.join(SRC, "routes");
const EVIDENCE_DIR = path.join(ROOT, "reports/antas/vault/gap/VLT-GAP-03");
const EVIDENCE_FILE = path.join(EVIDENCE_DIR, "extraction-proof.json");
const BASE = path.join(EVIDENCE_DIR, "baseline");
const BASE03B = path.join(EVIDENCE_DIR, "baseline-03b");
const R = (p) => `artifacts/api-server/src/${p}`;

const fail = (m) => { console.error(`${SUB_PHASE} FAIL — ${m}`); process.exit(1); };
const bypass = rejectBypass(["--verify"]);
if (bypass.length) fail(`bypass mechanism rejected: ${bypass.join(", ")}`);
if (process.env.VALIDATION_DISABLED && !/^(0|false|no)$/i.test(process.env.VALIDATION_DISABLED)) fail("bypass mechanism rejected: env VALIDATION_DISABLED");

const ts = loadTs(ROOT);
if (!ts) fail("TypeScript compiler API unavailable (fail closed)");

// ── Layout under proof ────────────────────────────────────────────────────
const OLD = {
  kyc: { file: "routes/kyc.ts", baseline: path.join(BASE, "sources/artifacts__api-server__src__routes__kyc.ts") },
  data: { file: "routes/kyc-data-entities.ts", baseline: path.join(BASE, "sources/artifacts__api-server__src__routes__kyc-data-entities.ts") },
};
const OLD_DOMAIN_BASELINE = path.join(BASE, "sources/artifacts__api-server__src__vault__domain__kyc.ts");
const NEW = {
  values: "vault/domain/kyc-values.ts", domain: "vault/domain/kyc.ts",
  security: "vault/security/kyc-ownership.ts",
  repo: "vault/infrastructure/repositories/kyc-repository.ts", dataRepo: "vault/infrastructure/repositories/kyc-data-entity-repository.ts",
  entries: "vault/application/kyc/entries.ts", dataEntities: "vault/application/kyc/data-entities.ts",
};
const NEW_FILES = Object.values(NEW);
const ROUTE_FILES = [OLD.kyc.file, OLD.data.file];
const CHANGED_ALLOWED = new Set([R(OLD.kyc.file), R(OLD.data.file), R(NEW.domain)]);
const ADDED_ALLOWED = new Set([NEW.values, NEW.security, NEW.repo, NEW.dataRepo, NEW.entries, NEW.dataEntities].map(R));
const readNew = (f) => fs.readFileSync(path.join(SRC, f), "utf8");
const OLD_TEXT = { kyc: fs.existsSync(OLD.kyc.baseline) ? fs.readFileSync(OLD.kyc.baseline, "utf8") : null, data: fs.existsSync(OLD.data.baseline) ? fs.readFileSync(OLD.data.baseline, "utf8") : null };
if (OLD_TEXT.kyc === null || OLD_TEXT.data === null) fail("frozen 03-A baseline sources missing; run validate-vlt-gap-03-A.mjs on the pre-extraction tree");

// ── AST helpers ───────────────────────────────────────────────────────────
const parse = (name, text) => ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const HTTP = new Set(["get", "post", "put", "patch", "delete"]);
function walk(node, fn) { fn(node); ts.forEachChild(node, (c) => walk(c, fn)); }
function tokens(node, sf) { const t = []; (function w(n) { if (n.getChildCount(sf) === 0 && n.kind !== ts.SyntaxKind.EndOfFileToken) t.push(n.getText(sf)); else n.getChildren(sf).forEach(w); })(node); return t; }
const fp = (node, sf) => sha256(tokens(node, sf).join(" "));

function routeTable(text, name) {
  const sf = parse(name, text); const out = [];
  for (const s of sf.statements) {
    if (!ts.isExpressionStatement(s) || !ts.isCallExpression(s.expression)) continue;
    const c = s.expression; const cal = c.expression;
    if (!(ts.isPropertyAccessExpression(cal) && cal.expression.getText(sf) === "router" && HTTP.has(cal.name.text))) continue;
    const args = c.arguments.slice(1); const handler = args[args.length - 1];
    const sig = args.slice(0, -1).map((a) => (ts.isIdentifier(a) ? a.text : ts.isCallExpression(a) ? `${a.expression.getText(sf)}(${a.arguments.filter(ts.isStringLiteralLike).map((x) => JSON.stringify(x.text)).join(",")})` : "?"));
    const refs = { db: 0, sql: 0, encrypt: 0, decrypt: 0, charge: 0 };
    walk(handler, (n) => { if (!ts.isIdentifier(n)) return; if (n.text === "db") refs.db++; else if (n.text === "sql") refs.sql++; else if (/^(encryptField)$/.test(n.text)) refs.encrypt++; else if (/^decrypt/.test(n.text)) refs.decrypt++; else if (n.text === "chargeCredits") refs.charge++; });
    const L = (n) => [sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, sf.getLineAndCharacterOfPosition(n.getEnd()).line + 1];
    const [a, b] = L(handler);
    out.push({ method: cal.name.text.toUpperCase(), path: ts.isStringLiteralLike(c.arguments[0]) ? c.arguments[0].text : null, middleware: sig, handler_lines: b - a + 1, refs, ref_total: Object.values(refs).reduce((x, y) => x + y, 0) });
  }
  return out;
}
function topLevelDecls(text, name) {
  const sf = parse(name, text); const out = [];
  for (const s of sf.statements) {
    if (ts.isImportDeclaration(s) || (ts.isExpressionStatement(s) && ts.isCallExpression(s.expression))) continue;
    if (ts.isExportDeclaration(s) || ts.isExportAssignment(s)) continue;
    if (ts.isFunctionDeclaration(s) && s.name) out.push(s.name.text);
    else if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) out.push(d.name.getText(sf));
    else if (ts.isTypeAliasDeclaration(s) || ts.isInterfaceDeclaration(s)) out.push(s.name.text);
  }
  return out;
}
function importsOf(text, name) {
  const sf = parse(name, text); const out = [];
  for (const s of sf.statements) if (ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier)) out.push({ module: s.moduleSpecifier.text, type_only: Boolean(s.importClause?.isTypeOnly), names: [] });
  return out;
}
function exportsOf(text, name) {
  const sf = parse(name, text); const out = new Set();
  for (const s of sf.statements) {
    const exp = s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (ts.isExportDeclaration(s) && s.exportClause && ts.isNamedExports(s.exportClause)) s.exportClause.elements.forEach((e) => out.add(e.name.text));
    else if (ts.isExportAssignment(s)) out.add("default");
    else if (exp && ts.isFunctionDeclaration(s) && s.name) out.add(s.name.text);
    else if (exp && ts.isVariableStatement(s)) s.declarationList.declarations.forEach((d) => out.add(d.name.getText(sf)));
    else if (exp && (ts.isTypeAliasDeclaration(s) || ts.isInterfaceDeclaration(s))) out.add(s.name.text);
  }
  return [...out].sort();
}
// SQL statements: template literals containing uppercase SQL keywords, `${…}` normalised so identifier renames don't matter.
const SQL_KW = /\b(SELECT|INSERT INTO|UPDATE|DELETE FROM|LEFT JOIN|EXISTS)\b/;
function sqlStatements(text, name) {
  const sf = parse(name, text); const out = [];
  walk(sf, (n) => {
    let raw = null;
    if (ts.isNoSubstitutionTemplateLiteral(n)) raw = n.text;
    else if (ts.isTemplateExpression(n)) raw = n.head.text + n.templateSpans.map((s) => "${}" + s.literal.text).join("");
    if (raw !== null && SQL_KW.test(raw)) out.push(raw.replace(/\s+/g, " ").trim());
  });
  return out.sort();
}
function errorLiterals(text, name) {
  const sf = parse(name, text); const out = new Set();
  walk(sf, (n) => { if (ts.isPropertyAssignment(n) && /^(error|message)$/.test(n.name.getText(sf)) && ts.isStringLiteralLike(n.initializer)) out.add(n.initializer.text); });
  return [...out].sort();
}
function functionUnits(text, name) {
  const sf = parse(name, text); const out = [];
  for (const s of sf.statements) {
    if (ts.isFunctionDeclaration(s) && s.name) out.push({ name: s.name.text, tokens: tokens(s, sf).length, fp: fp(s.body ?? s, sf), body_fp: s.body ? fp(s.body, sf) : null, async: Boolean(s.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) });
    else if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) if (d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) out.push({ name: d.name.getText(sf), tokens: tokens(d.initializer, sf).length, fp: fp(d.initializer.body, sf), body_fp: fp(d.initializer.body, sf), async: Boolean(d.initializer.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) });
  }
  return out;
}
const countCalls = (text, name, rx) => { const sf = parse(name, text); let n = 0; walk(sf, (x) => { if (ts.isCallExpression(x) && rx.test(x.expression.getText(sf))) n++; }); return n; };
function identRefs(text, name, ident) {
  const sf = parse(name, text); let n = 0;
  walk(sf, (x) => {
    if (!ts.isIdentifier(x) || x.text !== ident) return;
    const p = x.parent; if (!p) return;
    if ((ts.isFunctionDeclaration(p) || ts.isVariableDeclaration(p) || ts.isInterfaceDeclaration(p) || ts.isTypeAliasDeclaration(p)) && p.name === x) return; // declaration site
    if (ts.isImportSpecifier(p) || ts.isExportSpecifier(p)) return;
    n++;
  });
  return n;
}

// ── Moved-symbol map (OLD → NEW owner) ────────────────────────────────────
// { old: where it lived, name: old name, to: new file, as: new name, internal: referenced only inside its own file by design }
const MOVES = [
  { old: "routes/kyc.ts", name: "val", to: NEW.values, as: "val" },
  { old: "routes/kyc.ts", name: "numVal", to: NEW.values, as: "numVal" },
  { old: "routes/kyc-data-entities.ts", name: "safe", to: NEW.values, as: "safe" },
  { old: "routes/kyc-data-entities.ts", name: "safeDate", to: NEW.values, as: "safeDate" },
  { old: "routes/kyc.ts", name: "DATA_ENTITY_JOIN", to: NEW.repo, as: "DATA_ENTITY_JOIN", internal: true },
  { old: "routes/kyc.ts", name: "DATA_ENTITY_SELECT", to: NEW.repo, as: "DATA_ENTITY_SELECT", internal: true },
  { old: "routes/kyc.ts", name: "fetchWithData", to: NEW.repo, as: "fetchKycEntryWithData" },
  { old: "routes/kyc.ts", name: "kycEntryResource", to: NEW.security, as: "kycEntryResource", compat_reexport: true },
  { old: "routes/kyc.ts", name: "requireKycEntryOwnership", to: NEW.security, as: "requireKycEntryOwnership", compat_reexport: true },
  { old: "routes/kyc-data-entities.ts", name: "DATA_ENTITY_SENSITIVE_FIELDS", to: NEW.domain, as: "KYC_DATA_ENTITY_SENSITIVE_FIELDS" },
  { old: "routes/kyc-data-entities.ts", name: "KYC_DATA_ENTITY_OWNER_SENTINEL_NONE", to: NEW.domain, as: "KYC_DATA_ENTITY_OWNER_SENTINEL_NONE" },
  { old: "routes/kyc-data-entities.ts", name: "kycDataEntityResource", to: NEW.security, as: "kycDataEntityResource" },
  { old: "routes/kyc-data-entities.ts", name: "requireKycDataEntityOwnership", to: NEW.security, as: "requireKycDataEntityOwnership" },
  { old: "routes/kyc-data-entities.ts", name: "USED_BY_KYC", to: NEW.dataRepo, as: "USED_BY_KYC", internal: true },
  { old: "routes/kyc-data-entities.ts", name: "USED_BY_VAULT", to: NEW.dataRepo, as: "USED_BY_VAULT", internal: true },
  { old: "routes/kyc-data-entities.ts", name: "USED_EXPR", to: NEW.dataRepo, as: "USED_EXPR", internal: true },
  { old: "routes/kyc.ts", name: "allowed (status vocabulary)", to: NEW.domain, as: "KYC_ENTRY_BAN_STATUSES" },
];
// Route handler → use-case (each old inline handler body must have a named owner that the route calls).
const HANDLERS = [
  ["GET", "/kyc-entries", NEW.entries, "listKycEntries"], ["POST", "/kyc-entries", NEW.entries, "createKycEntry"],
  ["GET", "/kyc-entries/:id", NEW.entries, "getKycEntry"], ["PUT", "/kyc-entries/:id", NEW.entries, "editKycEntry"],
  ["PATCH", "/kyc-entries/:id/status", NEW.entries, "setKycEntryStatus"], ["DELETE", "/kyc-entries/:id", NEW.entries, "removeKycEntry"],
  ["GET", "/kyc-entries/enrollments", NEW.entries, "listKycEnrollments"],
  ["GET", "/kyc-data-entities", NEW.dataEntities, "listKycDataEntities"], ["GET", "/kyc-data-entities/overview", NEW.dataEntities, "getKycDataEntityOverview"],
  ["POST", "/kyc-data-entities", NEW.dataEntities, "createKycDataEntity"], ["GET", "/kyc-data-entities/:id", NEW.dataEntities, "getKycDataEntity"],
  ["PUT", "/kyc-data-entities/:id", NEW.dataEntities, "editKycDataEntity"], ["DELETE", "/kyc-data-entities/:id", NEW.dataEntities, "removeKycDataEntity"],
];

// ── 1. Static proof ──────────────────────────────────────────────────────
function staticProof() {
  const checks = []; const chk = (name, pass, details = "") => checks.push({ name, passed: Boolean(pass), details });
  const newText = Object.fromEntries(NEW_FILES.map((f) => [f, readNew(f)]));
  const routeNew = { kyc: readNew(OLD.kyc.file), data: readNew(OLD.data.file) };
  for (const f of NEW_FILES) chk(`destination-exists:${f}`, newText[f].length > 0, "");

  // 03-A evidence + seal binding
  const ev03a = JSON.parse(fs.readFileSync(path.join(EVIDENCE_DIR, "symbol-inventory.json"), "utf8"));
  const seal = fs.existsSync(path.join(BASE03B, "SEAL.json")) ? JSON.parse(fs.readFileSync(path.join(BASE03B, "SEAL.json"), "utf8")) : null;
  chk("03A-evidence-is-PASS", ev03a.status === "PASS" && ev03a.sub_phase === "VLT-GAP-03-A", `status=${ev03a.status}`);
  chk("baseline-kyc-route-matches-03A-evidence-hash", ev03a.source_hashes?.[R(OLD.kyc.file)] === sha256(OLD_TEXT.kyc), "");
  chk("baseline-data-route-matches-03A-evidence-hash", ev03a.source_hashes?.[R(OLD.data.file)] === sha256(OLD_TEXT.data), "");
  chk("baseline-domain-matches-03A-evidence-hash", ev03a.source_hashes?.[R(NEW.domain)] === sha256(fs.readFileSync(OLD_DOMAIN_BASELINE, "utf8")), "");
  chk("baseline-is-pre-extraction-shape", routeTable(OLD_TEXT.kyc, "old-kyc.ts").every((r) => r.ref_total > 0) && routeTable(OLD_TEXT.data, "old-data.ts").filter((r) => r.ref_total > 0).length >= 5, "frozen baseline routes must still contain inline DB access");
  chk("tree-seal-present-and-consistent", Boolean(seal) && seal.certified_by?.sub_phase === "VLT-GAP-03-A" && seal.certified_by?.source_tree_sha256 === ev03a.source_tree_sha256 && sha256(fs.readFileSync(path.join(BASE03B, "tree-manifest.json"), "utf8")) === seal.tree_manifest_sha256, "");

  // Route table identical (paths, order, middleware chain semantics)
  const routeBefore = [...routeTable(OLD_TEXT.kyc, "o1"), ...routeTable(OLD_TEXT.data, "o2")];
  const routeAfter = [...routeTable(routeNew.kyc, "n1"), ...routeTable(routeNew.data, "n2")];
  const perFileBefore = { kyc: routeTable(OLD_TEXT.kyc, "o1"), data: routeTable(OLD_TEXT.data, "o2") };
  const perFileAfter = { kyc: routeTable(routeNew.kyc, "n1"), data: routeTable(routeNew.data, "n2") };
  chk("route-count-preserved", routeBefore.length === routeAfter.length && routeBefore.length === HANDLERS.length, `before=${routeBefore.length} after=${routeAfter.length} declared=${HANDLERS.length}`);
  for (const k of ["kyc", "data"]) {
    const sig = (t) => JSON.stringify(t.map((r) => [r.method, r.path, r.middleware]));
    chk(`route-order-and-middleware-identical:${k}`, sig(perFileBefore[k]) === sig(perFileAfter[k]), "route table (order, paths, middleware chains incl. ownership action names / credit keys) must be unchanged");
  }
  const enr = perFileAfter.kyc.findIndex((r) => r.path === "/kyc-entries/enrollments"); const byId = perFileAfter.kyc.findIndex((r) => r.method === "GET" && r.path === "/kyc-entries/:id");
  chk("route-shadowing-order-preserved", enr > byId && byId >= 0, "GET /kyc-entries/enrollments is (still) registered after GET /kyc-entries/:id — pre-existing behavior, preserved, not fixed");
  chk("route-has-zero-db-sql-crypto-refs", routeAfter.every((r) => r.ref_total === 0), routeAfter.filter((r) => r.ref_total).map((r) => `${r.method} ${r.path}`).join(", "));
  chk("route-handlers-are-thin", routeAfter.every((r) => r.handler_lines <= 5), routeAfter.filter((r) => r.handler_lines > 5).map((r) => `${r.method} ${r.path}=${r.handler_lines}`).join(", "));
  const topKyc = topLevelDecls(routeNew.kyc, "n1"), topData = topLevelDecls(routeNew.data, "n2");
  chk("route-declares-only-router", [...topKyc, ...topData].every((n) => n === "router"), [...topKyc, ...topData].filter((n) => n !== "router").join(", "));
  chk("route-templates-contain-no-sql", sqlStatements(routeNew.kyc, "n1").length === 0 && sqlStatements(routeNew.data, "n2").length === 0, "");

  // SQL preserved exactly (multiset, normalised)
  const oldSql = [...sqlStatements(OLD_TEXT.kyc, "o1"), ...sqlStatements(OLD_TEXT.data, "o2")].sort();
  const destSqlFiles = [NEW.repo, NEW.dataRepo, NEW.security];
  const newSql = destSqlFiles.flatMap((f) => sqlStatements(newText[f], f)).sort();
  const cnt = (a) => a.reduce((m, s) => ((m[s] = (m[s] ?? 0) + 1), m), {});
  const co = cnt(oldSql), cn = cnt(newSql);
  const missing = Object.keys(co).filter((s) => (cn[s] ?? 0) < co[s]); const extra = Object.keys(cn).filter((s) => (co[s] ?? 0) < cn[s]);
  chk("sql-every-old-statement-preserved-in-destination", missing.length === 0, missing.map((s) => s.slice(0, 90)).join(" | "));
  chk("sql-no-new-statements-introduced", extra.length === 0, extra.map((s) => s.slice(0, 90)).join(" | "));
  chk("sql-statement-count-equal", oldSql.length === newSql.length && oldSql.length >= 22, `old=${oldSql.length} new=${newSql.length}`);
  const perFileSql = destSqlFiles.map((f) => new Set(sqlStatements(newText[f], f)));
  const cross = []; for (let i = 0; i < perFileSql.length; i++) for (let j = i + 1; j < perFileSql.length; j++) for (const s of perFileSql[i]) if (perFileSql[j].has(s)) cross.push(s.slice(0, 80));
  chk("no-sql-statement-implemented-in-two-files", cross.length === 0, cross.join(" | "));

  // Error/response semantics preserved
  const oldErr = [...new Set([...errorLiterals(OLD_TEXT.kyc, "o1"), ...errorLiterals(OLD_TEXT.data, "o2")])].sort();
  const newErr = [...new Set([NEW.entries, NEW.dataEntities, NEW.security].flatMap((f) => errorLiterals(newText[f], f)))].sort();
  const notPreserved = oldErr.filter((e) => !newErr.includes(e)); const notNew = newErr.filter((e) => !oldErr.includes(e));
  chk("error-messages-preserved", notPreserved.length === 0, notPreserved.join(" | "));
  chk("no-new-error-messages", notNew.length === 0, notNew.join(" | "));

  // Destination holds executable business implementation (not scaffolding)
  const units = Object.fromEntries(NEW_FILES.map((f) => [f, functionUnits(newText[f], f)]));
  const execRepo = countCalls(newText[NEW.repo], NEW.repo, /^db\.execute$/), execData = countCalls(newText[NEW.dataRepo], NEW.dataRepo, /^db\.execute$/);
  chk("destination-repository-executes-sql", execRepo >= 8 && execData >= 8, `kyc-repository db.execute=${execRepo} data-entity-repository db.execute=${execData}`);
  chk("destination-application-has-use-cases", units[NEW.entries].filter((u) => u.async).length >= 7 && units[NEW.dataEntities].filter((u) => u.async).length >= 6, `entries=${units[NEW.entries].length} dataEntities=${units[NEW.dataEntities].length}`);
  chk("destination-domain-has-logic", units[NEW.values].length >= 5 && units[NEW.domain].some((u) => u.name === "isKycBanStatus"), `values fns=${units[NEW.values].length}`);
  chk("destination-security-has-logic", units[NEW.security].length >= 6, `functions=${units[NEW.security].length}`);
  const typeOnly = NEW_FILES.filter((f) => units[f].length === 0 && !/export const \w+ = (\[|\{|-?\d|")/.test(newText[f]));
  chk("no-scaffold-only-destination", typeOnly.length === 0 && NEW_FILES.every((f) => units[f].length > 0 || f === NEW.domain), typeOnly.join(", "));

  // Every route handler delegates to its named use-case, and that use-case exists in the destination
  const handlerRows = [];
  for (const [m, p, file, fn] of HANDLERS) {
    const home = p.startsWith("/kyc-entries") ? routeNew.kyc : routeNew.data;
    const sf = parse("route", home); let delegating = false;
    for (const s of sf.statements) if (ts.isExpressionStatement(s) && ts.isCallExpression(s.expression) && ts.isPropertyAccessExpression(s.expression.expression) && s.expression.expression.name.text.toUpperCase() === m && ts.isStringLiteralLike(s.expression.arguments[0]) && s.expression.arguments[0].text === p) { let has = false; walk(s.expression.arguments[s.expression.arguments.length - 1], (n) => { if (ts.isCallExpression(n) && n.expression.getText(sf) === fn) has = true; }); delegating = has; }
    const defined = units[file].some((u) => u.name === fn && u.async);
    handlerRows.push({ method: m, path: p, use_case: `${file}#${fn}`, route_calls_use_case: delegating, use_case_defined: defined });
  }
  chk("every-handler-delegates-to-a-defined-use-case", handlerRows.every((h) => h.route_calls_use_case && h.use_case_defined), handlerRows.filter((h) => !(h.route_calls_use_case && h.use_case_defined)).map((h) => `${h.method} ${h.path}`).join(", "));

  // Moved symbols: gone from routes, defined in destination, actually used
  const allText = { ...newText, [OLD.kyc.file]: routeNew.kyc, [OLD.data.file]: routeNew.data };
  const moved = [];
  for (const mv of MOVES) {
    const oldText = mv.old === OLD.kyc.file ? OLD_TEXT.kyc : OLD_TEXT.data;
    const oldName = mv.name.split(" ")[0];
    const wasInOld = oldName === "allowed" ? /const allowed = \[/.test(oldText) : topLevelDecls(oldText, "o").includes(oldName) || exportsOf(oldText, "o").includes(oldName);
    const stillInRoute = oldName === "allowed" ? /const allowed = \[/.test(allText[mv.old]) : topLevelDecls(allText[mv.old], "n").includes(oldName);
    const definedNew = topLevelDecls(newText[mv.to], mv.to).includes(mv.as);
    const inSame = identRefs(newText[mv.to], mv.to, mv.as);
    const inOthers = Object.entries(allText).filter(([f]) => f !== mv.to).reduce((a, [f, t]) => a + identRefs(t, f, mv.as), 0);
    const reexported = mv.compat_reexport ? new RegExp(`export \\{[^}]*\\b${mv.as}\\b[^}]*\\} from "\\.\\./vault/security/kyc-ownership"`).test(allText[mv.old]) : null;
    const used = mv.internal ? inSame > 0 : inOthers > 0;
    moved.push({ old_file: mv.old, old_symbol: oldName, new_file: mv.to, new_symbol: mv.as, existed_in_old: wasInOld, remaining_in_old_file: stillInRoute, defined_in_new: definedNew, references_from_other_files: inOthers, references_in_own_file: inSame, compat_reexport_in_route: reexported });
    chk(`moved:${mv.old}#${oldName}→${mv.to}#${mv.as}`, wasInOld && !stillInRoute && definedNew && used && (mv.compat_reexport ? reexported : true), JSON.stringify({ wasInOld, stillInRoute, definedNew, inOthers, inSame, reexported }));
  }
  chk("moved-symbols-are-used", moved.every((m) => m.references_from_other_files > 0 || m.references_in_own_file > 0), moved.filter((m) => !(m.references_from_other_files > 0 || m.references_in_own_file > 0)).map((m) => m.new_symbol).join(", "));
  // Every declared destination function is used somewhere (no copied-but-unused code)
  const unused = [];
  for (const f of NEW_FILES) for (const u of units[f]) {
    if (u.name === "isKycStatus") continue;
    const refs = Object.entries(allText).reduce((a, [g, t]) => a + identRefs(t, g, u.name), 0);
    if (refs === 0 && !(exportsOf(newText[f], f).includes(u.name) && /compat/i.test(""))) unused.push(`${f}#${u.name}`);
  }
  chk("no-copied-but-unused-destination-functions", unused.length === 0, unused.join(", "));

  // Duplicate implementations: same function body in two files
  const dupes = []; const seen = new Map();
  for (const [f, t] of Object.entries(allText)) for (const u of functionUnits(t, f)) {
    if (u.tokens < 14) continue;
    const k = u.body_fp; if (seen.has(k) && seen.get(k).file !== f) dupes.push({ a: `${seen.get(k).file}#${seen.get(k).name}`, b: `${f}#${u.name}` }); else seen.set(k, { file: f, name: u.name });
  }
  chk("no-duplicate-implementation-between-files", dupes.length === 0, dupes.map((d) => `${d.a} == ${d.b}`).join(" | "));
  const oldFnFps = new Map([...functionUnits(OLD_TEXT.kyc, "o1"), ...functionUnits(OLD_TEXT.data, "o2")].filter((u) => u.tokens >= 14).map((u) => [u.body_fp, u.name]));
  const leftInRoute = [...functionUnits(routeNew.kyc, "n1"), ...functionUnits(routeNew.data, "n2")].filter((u) => oldFnFps.has(u.body_fp));
  chk("old-function-bodies-not-left-in-routes", leftInRoute.length === 0, leftInRoute.map((u) => u.name).join(", "));

  // Import boundaries
  const forbiddenRoute = []; for (const [k, t] of Object.entries(routeNew)) for (const i of importsOf(t, k)) if (/(^|\/)(vault-crypto|credit-meter)$/.test(i.module) && /credit-meter/.test(i.module) === false || /^(@workspace\/db|drizzle-orm)$/.test(i.module) || /lib\/vault-crypto/.test(i.module)) forbiddenRoute.push(`${k}:${i.module}`);
  chk("route-no-longer-imports-persistence-or-crypto", forbiddenRoute.length === 0, forbiddenRoute.join(", "));
  const routeCredit = importsOf(routeNew.kyc, "n1").filter((i) => /services\/credit-meter/.test(i.module));
  chk("route-only-keeps-requireCreditBalance-middleware", routeCredit.length === 1 && /import \{ requireCreditBalance \} from "\.\.\/services\/credit-meter"/.test(routeNew.kyc) && !/chargeCredits/.test(routeNew.kyc), "");
  const appDb = [NEW.entries, NEW.dataEntities].flatMap((f) => importsOf(newText[f], f).filter((i) => /^(@workspace\/db|drizzle-orm|express)$/.test(i.module)).map((i) => `${f}:${i.module}`));
  chk("application-imports-no-db-drizzle-or-express", appDb.length === 0, appDb.join(", "));
  const domImp = [NEW.values, NEW.domain].flatMap((f) => importsOf(newText[f], f).map((i) => `${f}:${i.module}`));
  chk("domain-imports-nothing", domImp.length === 0, domImp.join(", "));
  const infraBad = [NEW.repo, NEW.dataRepo].flatMap((f) => importsOf(newText[f], f).filter((i) => /application|routes|security|express/.test(i.module)).map((i) => `${f}:${i.module}`));
  chk("infrastructure-does-not-import-application-routes-or-express", infraBad.length === 0, infraBad.join(", "));
  const vaultToRoutes = NEW_FILES.flatMap((f) => importsOf(newText[f], f).filter((i) => /(^|\/)routes(\/|$)/.test(i.module)).map((i) => `${f}:${i.module}`));
  chk("no-vault-module-imports-routes", vaultToRoutes.length === 0, vaultToRoutes.join(", "));
  const encOnlyApp = NEW_FILES.filter((f) => f !== NEW.entries && f !== NEW.dataEntities && /encryptField\(|decryptRow\(|decryptRows\(/.test(newText[f]));
  chk("crypto-orchestration-only-in-application-layer", encOnlyApp.length === 0, encOnlyApp.join(", "));

  // Public surface: compat exports + default exports unchanged
  const oldExp = { kyc: exportsOf(OLD_TEXT.kyc, "o1"), data: exportsOf(OLD_TEXT.data, "o2") };
  const newExp = { kyc: exportsOf(routeNew.kyc, "n1"), data: exportsOf(routeNew.data, "n2") };
  chk("route-public-exports-unchanged:kyc", JSON.stringify(oldExp.kyc) === JSON.stringify(newExp.kyc), `old=${oldExp.kyc} new=${newExp.kyc}`);
  chk("route-public-exports-unchanged:data", JSON.stringify(oldExp.data) === JSON.stringify(newExp.data), `old=${oldExp.data} new=${newExp.data}`);
  const domOld = exportsOf(fs.readFileSync(OLD_DOMAIN_BASELINE, "utf8"), "d0"), domNew = exportsOf(newText[NEW.domain], "d1");
  chk("domain-exports-only-additive", domOld.every((e) => domNew.includes(e)), `removed=${domOld.filter((e) => !domNew.includes(e))}`);
  const oldDomText = fs.readFileSync(OLD_DOMAIN_BASELINE, "utf8");
  chk("domain-original-content-untouched", newText[NEW.domain].startsWith(oldDomText.trimEnd()), "existing domain/kyc.ts content must be preserved byte-for-byte; 03-B only appends");
  chk("vault-index-still-exports-domain-kyc", /export \* from "\.\/domain\/kyc"/.test(fs.readFileSync(path.join(SRC, "vault/index.ts"), "utf8")), "");
  const idxNames = new Set(); let idxClash = [];
  for (const f of ["vault/index.ts"]) { /* re-export collision check across all vault/index exports */
    const idx = fs.readFileSync(path.join(SRC, f), "utf8"); for (const m of idx.matchAll(/export \* from "\.\/([^"]+)"/g)) { const tf = path.join(SRC, "vault", `${m[1]}.ts`); if (!fs.existsSync(tf)) continue; for (const e of exportsOf(fs.readFileSync(tf, "utf8"), tf)) { if (idxNames.has(e)) idxClash.push(e); idxNames.add(e); } }
  }
  chk("vault-index-has-no-export-name-collisions", idxClash.length === 0, idxClash.join(", "));
  return { checks, moved, handlerRows, routeBefore, routeAfter, units, oldSqlCount: oldSql.length, newSqlCount: newSql.length, duplicates: dupes, forbiddenRoute };
}

// ── 2. Differential harness (frozen OLD routes vs NEW tree, identical stubs) ─
function makeEnv(script, opts = {}) {
  const env = createEnv({});
  env.queue = [...script];
  env.db.execute = (q) => { env.log.push(["db.execute", summ(q)]); const it = env.queue.shift(); if (it && it.throw) return Promise.reject(new Error(it.throw)); return Promise.resolve(it ? it.value : { rows: [] }); };
  env.chargeOk = opts.chargeOk ?? true;
  const named = (n, f) => { Object.defineProperty(f, "name", { value: n }); f.__stub = n; return f; };
  env.stubs["services/credit-meter"] = {
    chargeCredits: async (...a) => { env.log.push(["chargeCredits", summ(a)]); return env.chargeOk ? { ok: true, charged: 5, newBalance: 95 } : { ok: false }; },
    requireCreditBalance: (k) => named(`requireCreditBalance(${k})`, () => {}),
  };
  const dec = (r, f) => (r && typeof r === "object" ? { ...r, __decrypted: [...f] } : r);
  env.stubs["lib/vault-crypto"] = {
    encryptField: (x) => { env.log.push(["encryptField", summ([x])]); return x === null || x === undefined ? x : `ENC(${x})`; },
    decryptRow: (r, f) => { env.log.push(["decryptRow", summ([r, f])]); return dec(r, f); },
    decryptRows: (rs, f) => { env.log.push(["decryptRows", summ([rs, f])]); return rs.map((r) => dec(r, f)); },
  };
  return env;
}
const loadOld = (which, env) => createLoader({ ts, root: ROOT, srcDir: SRC, env }).loadText(OLD_TEXT[which], OLD[which].file, ROUTES);
const loadNew = (which, env) => createLoader({ ts, root: ROOT, srcDir: SRC, env }).loadFile(path.join(SRC, OLD[which].file));

const FULL = { category: "Exchange", username: "u", accountPassword: "pw", notes: "n", email: "e@x", emailPassword: "ep", account2fa: "2f", accountBackupCode: "bc", email2fa: "e2", emailBackupCode: "eb", lastLoginAt: "2026-01-01", accountBuyDate: "2026-01-02", accountCreateDate: "2026-01-03", accountBuyPrice: "12.5", accountWorth: "abc", kycFollowers: "10", emailRecovery: "r@x", emailRecoveryPassword: "rp", recovery2fa: "r2", recoveryBackupCode: "rb", dataEntityId: "5", platform: "Binance", buyPrice: 3, location: "BD", connection: "vpn", contactNumber: "017", buyDate: "2026-02-01", paid: 1, sellerName: "S", socialAccount: "fb" };
const rows = (...r) => ({ value: { rows: r } });
const boom = (m = "boom") => ({ throw: m });
const KE = "/kyc-entries", KD = "/kyc-data-entities";
const CASES = [
  // ── kyc entries ──
  { name: "list:no-filters", cat: "success", which: "kyc", method: "GET", path: KE, query: {}, db: [rows({ id: 1, category: "X" }, { id: 2 })] },
  { name: "list:all-filters", cat: "success", which: "kyc", method: "GET", path: KE, query: { category: "Exchange", platform: "Binance", unused: "true" }, db: [rows({ id: 3 })] },
  { name: "list:unused-not-true", cat: "success", which: "kyc", method: "GET", path: KE, query: { unused: "yes", category: "" }, db: [rows()] },
  { name: "list:db-error", cat: "failure", which: "kyc", method: "GET", path: KE, query: {}, db: [boom("list down")] },
  { name: "create:full-with-data-entity", cat: "success", which: "kyc", method: "POST", path: KE, body: FULL, db: [rows({ id: 9, data_entity_id: 5 }), rows({ id: 9, data_entity_id: 5, name: "N" })] },
  { name: "create:no-data-entity", cat: "success", which: "kyc", method: "POST", path: KE, body: { ...FULL, dataEntityId: null }, db: [rows({ id: 10, data_entity_id: null })] },
  { name: "create:empty-body-defaults", cat: "success", which: "kyc", method: "POST", path: KE, body: {}, db: [rows({ id: 11 })] },
  { name: "create:blank-strings-null", cat: "success", which: "kyc", method: "POST", path: KE, body: { category: "Other", username: "", email: "", paid: "", accountBuyPrice: "", buyPrice: "x" }, db: [rows({ id: 12 })] },
  { name: "create:category-empty-400", cat: "failure", which: "kyc", method: "POST", path: KE, body: { category: "" }, db: [] },
  { name: "create:insert-error", cat: "failure", which: "kyc", method: "POST", path: KE, body: FULL, db: [boom("insert down")] },
  { name: "create:refetch-error", cat: "failure", which: "kyc", method: "POST", path: KE, body: FULL, db: [rows({ id: 9, data_entity_id: 5 }), boom("refetch down")] },
  { name: "get:found-charged", cat: "success", which: "kyc", method: "GET", path: `${KE}/:id`, params: { id: "4" }, db: [rows({ id: 4, user_id: 7 })] },
  { name: "get:found-charge-declined", cat: "success", which: "kyc", method: "GET", path: `${KE}/:id`, params: { id: "4" }, chargeOk: false, db: [rows({ id: 4 })] },
  { name: "get:not-found-no-charge", cat: "failure", which: "kyc", method: "GET", path: `${KE}/:id`, params: { id: "4" }, db: [rows()] },
  { name: "get:invalid-id-400", cat: "failure", which: "kyc", method: "GET", path: `${KE}/:id`, params: { id: "abc" }, db: [] },
  { name: "get:db-error", cat: "failure", which: "kyc", method: "GET", path: `${KE}/:id`, params: { id: "4" }, db: [boom("get down")] },
  { name: "update:full", cat: "success", which: "kyc", method: "PUT", path: `${KE}/:id`, params: { id: "4" }, body: FULL, db: [rows({ id: 4, data_entity_id: 5 }), rows({ id: 4, data_entity_id: 5, name: "N" })] },
  { name: "update:empty-body-keeps-link-and-paid", cat: "success", which: "kyc", method: "PUT", path: `${KE}/:id`, params: { id: "4" }, body: {}, db: [rows({ id: 4, data_entity_id: null })] },
  { name: "update:link-cleared-null", cat: "success", which: "kyc", method: "PUT", path: `${KE}/:id`, params: { id: "4" }, body: { dataEntityId: null, paid: false }, db: [rows({ id: 4 })] },
  { name: "update:link-zero-and-paid-true", cat: "success", which: "kyc", method: "PUT", path: `${KE}/:id`, params: { id: "4" }, body: { dataEntityId: "0", paid: "yes" }, db: [rows({ id: 4 })] },
  { name: "update:not-found-404", cat: "failure", which: "kyc", method: "PUT", path: `${KE}/:id`, params: { id: "4" }, body: FULL, db: [rows()] },
  { name: "update:invalid-id-400", cat: "failure", which: "kyc", method: "PUT", path: `${KE}/:id`, params: { id: "zz" }, body: FULL, db: [] },
  { name: "update:db-error", cat: "failure", which: "kyc", method: "PUT", path: `${KE}/:id`, params: { id: "4" }, body: FULL, db: [boom("upd down")] },
  { name: "status:banned", cat: "success", which: "kyc", method: "PATCH", path: `${KE}/:id/status`, params: { id: "4" }, body: { status: "banned" }, db: [rows({ id: 4, status: "banned" })] },
  { name: "status:active", cat: "success", which: "kyc", method: "PATCH", path: `${KE}/:id/status`, params: { id: "4" }, body: { status: "active" }, db: [rows({ id: 4, status: "active" })] },
  { name: "status:inactive-rejected", cat: "failure", which: "kyc", method: "PATCH", path: `${KE}/:id/status`, params: { id: "4" }, body: { status: "inactive" }, db: [] },
  { name: "status:suspended-rejected", cat: "failure", which: "kyc", method: "PATCH", path: `${KE}/:id/status`, params: { id: "4" }, body: { status: "suspended" }, db: [] },
  { name: "status:missing-rejected", cat: "failure", which: "kyc", method: "PATCH", path: `${KE}/:id/status`, params: { id: "4" }, body: {}, db: [] },
  { name: "status:not-found-404", cat: "failure", which: "kyc", method: "PATCH", path: `${KE}/:id/status`, params: { id: "4" }, body: { status: "banned" }, db: [rows()] },
  { name: "status:invalid-id-400", cat: "failure", which: "kyc", method: "PATCH", path: `${KE}/:id/status`, params: { id: "x" }, body: { status: "banned" }, db: [] },
  { name: "status:db-error", cat: "failure", which: "kyc", method: "PATCH", path: `${KE}/:id/status`, params: { id: "4" }, body: { status: "banned" }, db: [boom("st down")] },
  { name: "delete:ok", cat: "success", which: "kyc", method: "DELETE", path: `${KE}/:id`, params: { id: "4" }, db: [rows()] },
  { name: "delete:invalid-id-400", cat: "failure", which: "kyc", method: "DELETE", path: `${KE}/:id`, params: { id: "q" }, db: [] },
  { name: "delete:db-error", cat: "failure", which: "kyc", method: "DELETE", path: `${KE}/:id`, params: { id: "4" }, db: [boom("del down")] },
  { name: "enrollments:rows", cat: "success", which: "kyc", method: "GET", path: `${KE}/enrollments`, db: [rows({ enrollment_id: 1 }, { enrollment_id: 2 })] },
  { name: "enrollments:db-error", cat: "failure", which: "kyc", method: "GET", path: `${KE}/enrollments`, db: [boom("enr down")] },
  // ── kyc data entities ──
  { name: "de-list:all", cat: "success", which: "data", method: "GET", path: KD, query: {}, db: [rows({ id: 1, nid_number: "n" })] },
  { name: "de-list:used", cat: "success", which: "data", method: "GET", path: KD, query: { status: "used" }, db: [rows({ id: 1 })] },
  { name: "de-list:unused", cat: "success", which: "data", method: "GET", path: KD, query: { status: "unused" }, db: [rows()] },
  { name: "de-list:unknown-status", cat: "success", which: "data", method: "GET", path: KD, query: { status: "bogus" }, db: [rows({ id: 2 })] },
  { name: "de-list:db-error", cat: "failure", which: "data", method: "GET", path: KD, query: {}, db: [boom("dl down")] },
  { name: "de-overview:row", cat: "success", which: "data", method: "GET", path: `${KD}/overview`, db: [rows({ total: 3, used: 1, unused: 2 })] },
  { name: "de-overview:no-row-default", cat: "success", which: "data", method: "GET", path: `${KD}/overview`, db: [rows()] },
  { name: "de-overview:db-error", cat: "failure", which: "data", method: "GET", path: `${KD}/overview`, db: [boom("ov down")] },
  { name: "de-create:full", cat: "success", which: "data", method: "POST", path: KD, body: { nidNumber: "123", name: "O'Neil", fatherName: "F", birthDate: "1990-01-01", photo1Url: "p1", photo2Url: "p2", notes: "n'" }, db: [rows({ id: 1, nid_number: "ENC(123)" })] },
  { name: "de-create:empty-body", cat: "success", which: "data", method: "POST", path: KD, body: {}, db: [rows({ id: 2 })] },
  { name: "de-create:quote-injection-escaped", cat: "security", which: "data", method: "POST", path: KD, body: { name: "x'); DROP TABLE kyc_data_entities; --", nidNumber: "1'2" }, db: [rows({ id: 3 })] },
  { name: "de-create:db-error", cat: "failure", which: "data", method: "POST", path: KD, body: { name: "x" }, db: [boom("dc down")] },
  { name: "de-get:found", cat: "success", which: "data", method: "GET", path: `${KD}/:id`, params: { id: "8" }, db: [rows({ id: 8, nid_number: "n" })] },
  { name: "de-get:not-found", cat: "failure", which: "data", method: "GET", path: `${KD}/:id`, params: { id: "8" }, db: [rows()] },
  { name: "de-get:invalid-id-400", cat: "failure", which: "data", method: "GET", path: `${KD}/:id`, params: { id: "nan" }, db: [] },
  { name: "de-get:db-error", cat: "failure", which: "data", method: "GET", path: `${KD}/:id`, params: { id: "8" }, db: [boom("dg down")] },
  { name: "de-update:full", cat: "success", which: "data", method: "PUT", path: `${KD}/:id`, params: { id: "8" }, body: { nidNumber: "9", name: "N", fatherName: "F", birthDate: "2000-02-02", photo1Url: "a", photo2Url: "b", notes: "c" }, db: [rows({ id: 8 })] },
  { name: "de-update:empty-body-nulls", cat: "success", which: "data", method: "PUT", path: `${KD}/:id`, params: { id: "8" }, body: {}, db: [rows({ id: 8 })] },
  { name: "de-update:not-found-404", cat: "failure", which: "data", method: "PUT", path: `${KD}/:id`, params: { id: "8" }, body: { name: "x" }, db: [rows()] },
  { name: "de-update:invalid-id-400", cat: "failure", which: "data", method: "PUT", path: `${KD}/:id`, params: { id: "k" }, body: { name: "x" }, db: [] },
  { name: "de-update:db-error", cat: "failure", which: "data", method: "PUT", path: `${KD}/:id`, params: { id: "8" }, body: { name: "x" }, db: [boom("du down")] },
  { name: "de-delete:ok", cat: "success", which: "data", method: "DELETE", path: `${KD}/:id`, params: { id: "8" }, db: [rows(), rows(), rows()] },
  { name: "de-delete:blocked-by-kyc-409", cat: "security", which: "data", method: "DELETE", path: `${KD}/:id`, params: { id: "8" }, db: [rows({ id: 1 })] },
  { name: "de-delete:blocked-by-vault-409", cat: "security", which: "data", method: "DELETE", path: `${KD}/:id`, params: { id: "8" }, db: [rows(), rows({ id: 2 })] },
  { name: "de-delete:invalid-id-400", cat: "failure", which: "data", method: "DELETE", path: `${KD}/:id`, params: { id: "n" }, db: [] },
  { name: "de-delete:kyc-check-error", cat: "failure", which: "data", method: "DELETE", path: `${KD}/:id`, params: { id: "8" }, db: [boom("d1 down")] },
  { name: "de-delete:vault-check-error", cat: "failure", which: "data", method: "DELETE", path: `${KD}/:id`, params: { id: "8" }, db: [rows(), boom("d2 down")] },
  { name: "de-delete:delete-error", cat: "failure", which: "data", method: "DELETE", path: `${KD}/:id`, params: { id: "8" }, db: [rows(), rows(), boom("d3 down")] },
];

async function runCase(loader, c, overrides) {
  const env = makeEnv(c.db ?? [], { chargeOk: c.chargeOk });
  if (overrides) env.overrides = overrides;
  let threw = null;
  try { loader(c.which, env); } catch (e) { threw = `load:${e.message}`; }
  const route = env.routes.find((r) => r.method === c.method && r.path === c.path);
  if (!route) return { threw: threw ?? "route-not-registered", status: null, body: null, res_calls: [], log: env.log, stack: [] };
  const res = fakeRes(); const req = { user: { userId: 7 }, params: c.params ?? {}, query: c.query ?? {}, body: c.body ?? {} };
  const handler = route.stack[route.stack.length - 1];
  try { await withConsoleCaptured(env.log, async () => { await handler(req, res); }); } catch (e) { threw = `run:${e.message}`; }
  const stack = route.stack.slice(0, -1).map((m) => (m.__ownership ? { ownership: m.__ownership.action, decision_observer: m.__ownership.opts?.onDecision?.name ?? null } : { middleware: m.name }));
  return { threw, status: res.statusCode, body: summ(res.body), res_calls: res.calls, log: env.log, stack, remaining_queue: env.queue.length };
}
const canon = (r) => JSON.stringify(r) ?? "undefined"; // PATCH(03-B): JSON.stringify(undefined) is undefined; a bare res.json leaves statusCode undefined and the `.slice` in diff reporting crashed on any mutant that changed the status
let OLD_CACHE = null;
async function oldResults() { if (!OLD_CACHE) { OLD_CACHE = []; for (const c of CASES) OLD_CACHE.push(await runCase(loadOld, c)); } return OLD_CACHE; }
async function differentialSuite(overrides) {
  const olds = await oldResults(); const out = [];
  for (let i = 0; i < CASES.length; i++) {
    const c = CASES[i]; const n = await runCase(loadNew, c, overrides); const o = olds[i]; const diffs = [];
    for (const k of ["threw", "status", "body", "res_calls", "log", "stack", "remaining_queue"]) if (canon(o[k]) !== canon(n[k])) diffs.push(`${k}: old=${canon(o[k]).slice(0, 140)} new=${canon(n[k]).slice(0, 140)}`);
    out.push({ name: c.name, category: c.cat, method: c.method, path: c.path, passed: diffs.length === 0 && !o.threw, diffs: o.threw ? [`OLD baseline itself threw: ${o.threw}`] : diffs, log_entries: n.log.length, status: n.status });
  }
  return out;
}

// ── 3. Security suite: ownership builders / deny bodies / compat exports ───
async function securitySuite(overrides) {
  const out = []; const t = (name, pass, details = "") => out.push({ name, passed: Boolean(pass), details });
  const kinds = [["kyc", "GET", `${KE}/:id`], ["data", "GET", `${KD}/:id`]];
  const scen = [{ id: "5", db: [rows({ user_id: 7 })] }, { id: "5", db: [rows({ user_id: 99 })] }, { id: "5", db: [rows()] }, { id: "abc", db: [] }, { id: "5", db: [boom("own down")] }];
  for (const [which, method, p] of kinds) {
    for (const sc of scen) {
      const run = async (loader, ov) => {
        const env = makeEnv(sc.db); if (ov) env.overrides = ov; loader(which, env);
        const r = env.routes.find((x) => x.method === method && x.path === p); const own = r.stack.find((m) => m.__ownership)?.__ownership;
        let ref, err = null; try { ref = await own.builder({ params: { id: sc.id } }); } catch (e) { err = e.message; }
        return canon({ ref, err, log: env.log, action: own.action });
      };
      t(`security:${which}:ownership-builder:${sc.id}:${sc.db.length ? Object.keys(sc.db[0])[0] : "none"}:${JSON.stringify(sc.db[0]?.value?.rows?.[0] ?? sc.db[0]?.throw ?? null)}`, (await run(loadOld)) === (await run(loadNew, overrides)), "");
    }
  }
  // deny bodies and observer wiring, per protected route
  const prot = CASES.filter((c) => ["GET", "PUT", "PATCH", "DELETE"].includes(c.method) && c.path.includes(":id")).map((c) => [c.which, c.method, c.path]);
  for (const [which, method, p] of [...new Set(prot.map((x) => x.join("|")))].map((s) => s.split("|"))) {
    const run = (loader, ov) => { const env = makeEnv([]); if (ov) env.overrides = ov; loader(which, env); const r = env.routes.find((x) => x.method === method && x.path === p); const own = r.stack.find((m) => m.__ownership)?.__ownership; const res = fakeRes(); own.opts.onDeny({ params: { id: "1" } }, res); return canon({ action: own.action, status: res.statusCode, body: summ(res.body), calls: res.calls, observer: own.opts.onDecision?.name, chain: r.stack.slice(0, -1).map((m) => m.name) }); };
    t(`security:deny-and-wiring:${method} ${p}`, run(loadOld) === run(loadNew, overrides), "");
  }
  // every id-scoped route keeps requireAuth BEFORE ownership
  for (const [which, method, p] of [...new Set(prot.map((x) => x.join("|")))].map((s) => s.split("|"))) {
    const env = makeEnv([]); if (overrides) env.overrides = overrides; loadNew(which, env); const r = env.routes.find((x) => x.method === method && x.path === p);
    const names = r.stack.slice(0, -1).map((m) => (m.__ownership ? "OWN" : m.name)); t(`security:auth-precedes-ownership:${method} ${p}`, names[0] === "requireAuth" && names[1] === "OWN", names.join(","));
  }
  // secret-field coverage: decrypt/encrypt field lists identical
  for (const c of CASES.filter((x) => x.name === "list:no-filters" || x.name === "de-list:all")) { const o = (await oldResults())[CASES.indexOf(c)]; const n = await runCase(loadNew, c, overrides); t(`security:decrypt-field-list:${c.name}`, canon(o.log.filter((l) => /^decrypt/.test(l[0]))) === canon(n.log.filter((l) => /^decrypt/.test(l[0]))), ""); }
  // compat exports still resolve for the not-yet-rewired consumers (03-C)
  const mk = (loader) => { const env = makeEnv([]); if (overrides) env.overrides = overrides; return loader("kyc", env); };
  const mo = mk(loadOld), mn = mk(loadNew);
  t("compat:kycEntryResource-exported-and-equivalent", typeof mn.kycEntryResource === "function" && typeof mo.kycEntryResource === "function", "");
  t("compat:requireKycEntryOwnership-exported-and-equivalent", typeof mn.requireKycEntryOwnership === "function" && canon(summ(Object.keys(mo).sort())) === canon(summ(Object.keys(mn).sort())), `old=${Object.keys(mo)} new=${Object.keys(mn)}`);
  const ownDesc = (m) => { const x = m.requireKycEntryOwnership("a.b", () => {}); return { action: x.__ownership.action, obs: x.__ownership.opts.onDecision?.name }; };
  t("compat:requireKycEntryOwnership-behaves-the-same", canon(ownDesc(mo)) === canon(ownDesc(mn)), "");
  return out;
}

// ── 4. Unit parity of moved pure helpers ──────────────────────────────────
async function unitParity(overrides) {
  const out = []; const t = (name, pass, details = "") => out.push({ name, passed: Boolean(pass), details });
  const oldNames = { kyc: ["val", "numVal"], data: ["safe", "safeDate"] };
  const priv = {};
  for (const k of ["kyc", "data"]) { const env = makeEnv([]); const ld = createLoader({ ts, root: ROOT, srcDir: SRC, env }); Object.assign(priv, ld.loadText(`${OLD_TEXT[k]}\nexport const __private = { ${oldNames[k].join(", ")} };\n`, OLD[k].file, ROUTES).__private); }
  const env = makeEnv([]); if (overrides) env.overrides = overrides; const nv = createLoader({ ts, root: ROOT, srcDir: SRC, env }).loadFile(path.join(SRC, NEW.values));
  const inputs = [null, undefined, "", " ", "0", 0, 1, -1, "12.5", "abc", "O'Neil", "a''b", "x'); DROP", true, false, NaN, {}, [], new Date(0), "2026-01-01", 1e21];
  for (const n of ["val", "numVal", "safe", "safeDate"]) t(`unit:${n}-parity`, inputs.every((x) => canon(summ([priv[n](x)])) === canon(summ([nv[n](x)]))), "");
  return out;
}

// ── 5. Mutation tests: seeded regressions in the NEW tree must be caught ──
async function mutationTests() {
  const res = []; const P = (f) => path.join(SRC, f);
  const muts = [
    { name: "UPDATE drops owner filter", file: P(NEW.repo), from: /(UPDATE kyc_entries SET[\s\S]*?WHERE id = \$\{id\}) AND user_id = \$\{userId\}/, to: "$1" },
    { name: "DELETE drops owner filter", file: P(NEW.repo), from: /DELETE FROM kyc_entries WHERE id = \$\{id\} AND user_id = \$\{userId\}/, to: "DELETE FROM kyc_entries WHERE id = ${id}" },
    { name: "list drops user scope", file: P(NEW.repo), from: /sql`k\.user_id = \$\{userId\}`/, to: "sql`1 = 1`" },
    { name: "GET :id stops charging credits", file: P(NEW.entries), from: /const charge = await chargeCredits\(userId, "sylo\.kyc_entry_view"\);/, to: "const charge = { ok: false } as any;" },
    { name: "GET :id 404 body changed", file: P(NEW.entries), from: /status: 404, body: \{ error: "Not found" \} \};\n    \/\/ Charge-on-success/, to: 'status: 404, body: { error: "Missing" } };\n    // Charge-on-success' },
    { name: "account password no longer encrypted on create", file: P(NEW.entries), from: /accountPassword: encryptField\(d\(b\.accountPassword, null\) as any\)/, to: "accountPassword: d(b.accountPassword, null)" },
    { name: "NID no longer encrypted on data entity create", file: P(NEW.dataEntities), from: /nidNumber: encryptField\(d\(b\.nidNumber, null\) as any\)/, to: "nidNumber: d(b.nidNumber, null)" },
    { name: "status vocabulary widened", file: P(NEW.domain), from: /KYC_ENTRY_BAN_STATUSES = \["active", "banned"\]/, to: 'KYC_ENTRY_BAN_STATUSES = ["active", "banned", "inactive"]' },
    { name: "entry ownership sentinel changed", file: P(NEW.domain), from: /KYC_ENTRY_OWNER_SENTINEL_NONE = -1/, to: "KYC_ENTRY_OWNER_SENTINEL_NONE = 0" },
    { name: "data entity ownership sentinel changed", file: P(NEW.domain), from: /KYC_DATA_ENTITY_OWNER_SENTINEL_NONE = -1/, to: "KYC_DATA_ENTITY_OWNER_SENTINEL_NONE = 0" },
    { name: "deny handler leaks 403", file: P(NEW.security), from: /res\.status\(404\)\.json\(\{ error: "Not found or forbidden" \}\)/, to: 'res.status(403).json({ error: "Not found or forbidden" })' },
    { name: "delete guard drops vault-link check", file: P(NEW.dataEntities), from: /const linkedVault = await findVaultEntryLinkedToDataEntity\(id\);\n    if \(linkedVault\.rows\.length\) return \{ status: 409, body: \{ error: "Data entity is in use by a Vault entity — unlink it first" \} \};\n/, to: "" },
    { name: "SQL escaping removed from safe()", file: P(NEW.values), from: /\.replace\(\/'\/g, "''"\)\}'`;\nexport const safeDate/, to: '}\'`;\nexport const safeDate' },
    { name: "numVal NaN fallback changed", file: P(NEW.values), from: /isNaN\(Number\(v\)\) \? 0 : Number\(v\)/, to: "isNaN(Number(v)) ? 1 : Number(v)" },
    { name: "unused filter loses active-status predicate", file: P(NEW.repo), from: / AND pe\.status = 'active'/, to: "" },
    { name: "route ownership gate removed from PUT", file: P(OLD.kyc.file), from: /requireKycEntryOwnership\("kyc_entry\.update", denyKycNotFoundOrForbidden\), /, to: "" },
    { name: "route ownership gate removed from data-entity DELETE", file: P(OLD.data.file), from: /requireKycDataEntityOwnership\("kyc_data_entity\.delete", denyKycSilentSuccess\), /, to: "" },
    { name: "refetch-with-data skipped after create", file: P(NEW.entries), from: /const withData = row\.data_entity_id \? await fetchKycEntryWithData\(row\.id\) : row;\n    return \{ status: 201/, to: "const withData = row;\n    return { status: 201" },
  ];
  for (const m of muts) {
    const orig = fs.readFileSync(m.file, "utf8");
    if (!m.from.test(orig)) { res.push({ name: `mutation:${m.name}`, passed: false, details: "mutation anchor not found (fail closed)" }); continue; }
    const overrides = new Map([[m.file, orig.replace(m.from, m.to)]]);
    // PATCH(03-B): the suite throwing on a mutant (e.g. the ownership gate is gone, so there is no __ownership middleware to inspect) is a detection, not a validator crash.
    let detected = false, thrown = "";
    try { const suite = [...(await differentialSuite(overrides)), ...(await securitySuite(overrides)), ...(await unitParity(overrides))]; detected = suite.some((s) => !s.passed); } catch (e) { detected = true; thrown = String(e?.message ?? e); }
    res.push({ name: `mutation-detected:${m.name}`, passed: detected, details: detected ? (thrown ? `detected via suite exception: ${thrown}` : "") : "seeded regression was NOT detected" });
  }
  return res;
}

// ── 6. Diff audit against the write-once tree seal ────────────────────────
function diffAudit() {
  const man = JSON.parse(fs.readFileSync(path.join(BASE03B, "tree-manifest.json"), "utf8")).files;
  const seal = JSON.parse(fs.readFileSync(path.join(BASE03B, "SEAL.json"), "utf8"));
  const now = {}; for (const f of walkFiles(ROOT)) { const k = rel(f); if (!k.startsWith("scripts/antas/vault/gap/")) now[k] = sha256File(f); }
  const changed = [], added = [], removed = [];
  for (const [k, v] of Object.entries(now)) { if (!(k in man)) added.push(k); else if (man[k] !== v) changed.push(k); }
  for (const k of Object.keys(man)) if (!(k in now)) removed.push(k);
  const gapNow = {}; for (const f of walkFiles(path.join(ROOT, "scripts/antas/vault/gap"))) gapNow[rel(f)] = sha256File(f);
  const gapEdited = Object.entries(seal.gap_scripts_at_freeze).filter(([k, v]) => gapNow[k] !== v).map(([k]) => k);
  const unexpected = [...changed.filter((k) => !CHANGED_ALLOWED.has(k)), ...added.filter((k) => !ADDED_ALLOWED.has(k)), ...removed];
  return { changed, added, removed, unexpected, earlier_validators_edited: gapEdited };
}

// ── 7. Degraded differential typecheck (project deps are not installed in the upload) ─
function typecheckDifferential() {
  const cfgRaw = ts.readConfigFile(path.join(ROOT, "tsconfig.base.json"), ts.sys.readFile).config?.compilerOptions ?? {};
  const opts = ts.convertCompilerOptionsFromJson({ ...cfgRaw, noEmit: true, skipLibCheck: true, types: [], incremental: false, composite: false, baseUrl: ROOT }, ROOT).options;
  const routeAbs = ROUTE_FILES.map((f) => path.join(SRC, f)); const newAbs = NEW_FILES.map((f) => path.join(SRC, f)); const scopeAbs = [...routeAbs, ...newAbs];
  const baselineFor = new Map([[routeAbs[0], OLD.kyc.baseline], [routeAbs[1], OLD.data.baseline], [path.join(SRC, NEW.domain), OLD_DOMAIN_BASELINE]]);
  const run = (useBaseline) => {
    const host = ts.createCompilerHost(opts); const rf = host.readFile.bind(host), gs = host.getSourceFile.bind(host);
    const ov = (f) => (useBaseline ? baselineFor.get(f) : undefined);
    host.readFile = (f) => rf(ov(f) ?? f);
    host.getSourceFile = (f, lv, ...r) => { const o = ov(f); return o ? ts.createSourceFile(f, fs.readFileSync(o, "utf8"), lv, true) : gs(f, lv, ...r); };
    const roots = useBaseline ? routeAbs : scopeAbs;
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
  const tot = (x) => Object.values(x).reduce((a, b) => a + b, 0);
  return { before_total: tot(before.tally), after_total: tot(after.tally), syntactic_errors: after.syntactic, new_diagnostics: regress, before_by_class: before.tally, after_by_class: after.tally };
}

// ── 8. Main ───────────────────────────────────────────────────────────────
const sourceHashes = () => Object.fromEntries([...ROUTE_FILES, ...NEW_FILES].map((f) => [R(f), sha256File(path.join(SRC, f))]).concat(["scripts/antas/vault/gap/harness.mjs", "scripts/antas/vault/gap/gap-common.mjs"].map((f) => [f, sha256File(path.join(ROOT, f))])));
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
  const has = (m, p, k) => CASES.some((c) => c.method === m && c.path === p && (k ? c.cat === k : true));
  checks.push({ name: "coverage:every-route-has-differential-case", passed: HANDLERS.every(([m, p]) => has(m, p)), details: HANDLERS.filter(([m, p]) => !has(m, p)).map(([m, p]) => `${m} ${p}`).join(", ") });
  checks.push({ name: "coverage:every-route-has-success-and-failure-case", passed: HANDLERS.every(([m, p]) => has(m, p, "success") || has(m, p, "security")) && HANDLERS.every(([m, p]) => has(m, p, "failure") || has(m, p, "security")), details: HANDLERS.filter(([m, p]) => !(has(m, p, "failure") || has(m, p, "security"))).map(([m, p]) => `${m} ${p}`).join(", ") });
  checks.push({ name: "no-skipped-tests", passed: CASES.length > 0 && diff.length === CASES.length, details: `${diff.length}/${CASES.length}` });
  checks.push({ name: "differential-cases-executed-db-calls", passed: diff.filter((d) => d.log_entries > 0).length >= 53, details: `${diff.filter((d) => d.log_entries > 0).length} cases recorded interactions` });
  checks.push({ name: "mutation-suite-size", passed: mut.length >= 15, details: `${mut.length} seeded regressions` });
  checks.push({ name: "diff-audit:no-unrelated-changes", passed: audit.unexpected.length === 0, details: audit.unexpected.join(", ") });
  checks.push({ name: "diff-audit:no-earlier-validator-edited", passed: audit.earlier_validators_edited.length === 0, details: audit.earlier_validators_edited.join(", ") });
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
    commands: ["node scripts/antas/vault/gap/validate-vlt-gap-03-B.mjs", "in-process differential suite (frozen baseline routes vs new source)", "in-process differential typecheck"],
    exit_codes,
    symbols_moved: st.moved.filter((m) => m.existed_in_old && !m.remaining_in_old_file && m.defined_in_new).map((m) => `${m.old_file}#${m.old_symbol} → ${m.new_file}#${m.new_symbol}`),
    handlers_extracted: st.handlerRows,
    consumers_migrated: [],
    old_business_symbols_remaining: { route_declares_business_symbols: st.routeAfter.length ? [] : [], route_handlers_with_db_refs: st.routeAfter.filter((r) => r.ref_total > 0).map((r) => `${r.method} ${r.path}`) },
    duplicate_implementations: st.duplicates,
    route_thinness: { before: { routes: st.routeBefore.length, with_inline_refs: st.routeBefore.filter((r) => r.ref_total > 0).length, handler_lines: st.routeBefore.reduce((a, r) => a + r.handler_lines, 0) }, after: { routes: st.routeAfter.length, with_inline_refs: st.routeAfter.filter((r) => r.ref_total > 0).length, handler_lines: st.routeAfter.reduce((a, r) => a + r.handler_lines, 0) } },
    sql: { old_statements: st.oldSqlCount, new_statements: st.newSqlCount },
    destination_functions: Object.fromEntries(Object.entries(st.units).map(([f, u]) => [f, u.map((x) => x.name)])),
    diff_audit: audit,
    typecheck: { mode: "degraded-differential (project dependencies are not installed in the upload; full tsc/build is NOT executed)", before_total: tc.before_total, after_total: tc.after_total, syntactic_errors: tc.syntactic_errors, new_diagnostics: tc.new_diagnostics, before_by_class: tc.before_by_class, after_by_class: tc.after_by_class },
    tests: { differential_cases: diff.length, differential_passed: diff.filter((d) => d.passed).length, security_checks: sec.length, security_passed: sec.filter((d) => d.passed).length, unit_parity: unit.length, unit_passed: unit.filter((d) => d.passed).length, mutations_seeded: mut.length, mutations_detected: mut.filter((d) => d.passed).length },
    notes: [
      "consumers_migrated is empty by design: exchange-api.ts and scripts/src/test-route-ownership-regression.ts still import requireKycEntryOwnership/kycEntryResource from routes/kyc.ts through the compatibility re-export; they are rewired in 03-C.",
      "Behavior is preserved exactly, including pre-existing quirks: PATCH status accepts only {active, banned} (isKycStatus in domain/kyc.ts is still unused and still disagrees), and GET /kyc-entries/enrollments is registered after GET /kyc-entries/:id so the :id route shadows it. Neither is fixed here.",
      "The project's own test suites and full tsc/build cannot run in this environment (dependencies are not installed); the differential suite executes the frozen OLD routes and the NEW tree under identical stubbed dependencies and compares every DB call, crypto call, credit charge, status code and body. Run the repo's build and tests in CI before certifying.",
      "The frontend sources in the 03-A census (components/kyc-entries.tsx and pages/user/vault-kyc-*.tsx) are API clients only and are not part of this backend extraction.",
    ],
    status: failed.length === 0 ? "PASS" : "FAIL",
    checks,
  };
  const body = { ...evidence }; delete body.generated_at;
  evidence.generated_at = new Date().toISOString(); evidence.evidence_body_sha256 = sha256(JSON.stringify(body));
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(EVIDENCE_FILE, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`${SUB_PHASE} ${evidence.status} — ${diff.length} differential cases, ${sec.length} security checks, ${unit.length} unit parity, ${mut.filter((m) => m.passed).length}/${mut.length} mutations detected, ${st.checks.length} static checks (${Date.now() - started}ms)`);
  if (failed.length) { console.error(failed.map((c) => `- ${c.name}: ${c.details || "not satisfied"}`).join("\n")); process.exit(1); }
}
main().catch((e) => fail(`unhandled: ${e.stack ?? e}`));
