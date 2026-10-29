#!/usr/bin/env node
// VLT-GAP-02-D — Old Source Retirement Gate (local accounts). Fail-closed validator.
// Evidence: reports/antas/vault/gap/VLT-GAP-02/{old-source-fingerprint,new-source-fingerprint,route-thinness,
//           duplicate-implementation,behavior-regression,security-regression,gate}.json
//
// Question answered: after GAP-02 extraction (02-B) and consumer rewire (02-C), is any OLD local-account source
// (routes/local-accounts.ts, components/local-accounts.tsx, config/fields/local-account-{create,buy}.ts) still
// authoritative for local-account business behavior?
//
// Method (everything is derived from source; nothing declared here is trusted):
//   1. re-scan the pre-extraction route (sealed baseline) and the current route with an AST census;
//   2. every baseline symbol must have a proven disposition (adapter / moved verbatim / moved with unit proof);
//   3. every current route handler must be a thin adapter that delegates to vault/application;
//   4. route table (order, paths, middleware chains) must equal the baseline;
//   5. no hidden import, duplicate implementation, or layering breach keeps old code authoritative;
//   6. frontend files are classified (UI adapter / declarative config / display helper) and their API calls
//      must resolve to registered routes; residual duplicated display helpers are enumerated and deferred by name;
//   7. 02-C is executed in place; 02-B is executed in a temp copy (running it in place would overwrite the
//      certified evidence 02-C is anchored to); every failing 02-B check must be one 02-C superseded AND must be
//      independently re-proven here;
//   8. the gate is mutation-tested: it must FAIL when the retirement is undone, and must reject bypass attempts.
// This validator NEVER writes a baseline; it only verifies the write-once seal from freeze-vlt-gap-02-D-baseline.mjs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { ROOT, sha256, sha256File, rel, rejectBypass, binding, walkFiles } from "./gap-common.mjs";
import { loadTs } from "./harness.mjs";

const VALIDATOR_VERSION = "1.0.0";
const PHASE = "VLT-GAP-02";
const SUB_PHASE = "VLT-GAP-02-D";
const HERE = fileURLToPath(import.meta.url);
const GAP = "scripts/antas/vault/gap/";
const SRC = path.join(ROOT, "artifacts/api-server/src");
const AYZEN = path.join(ROOT, "artifacts/ayzen/src");
const EVID = path.join(ROOT, "reports/antas/vault/gap/VLT-GAP-02");
const BASE = path.join(EVID, "baseline");
const SEAL_DIR = path.join(EVID, "baseline-02d");
const R = (f) => `artifacts/api-server/src/${f}`;
const RA = (f) => `artifacts/ayzen/src/${f}`;
const EV = { old: "old-source-fingerprint.json", neu: "new-source-fingerprint.json", thin: "route-thinness.json", dup: "duplicate-implementation.json", beh: "behavior-regression.json", sec: "security-regression.json", gate: "gate.json" };

const fail = (m) => { console.error(`${SUB_PHASE} FAIL — ${m}`); process.exit(1); };
const bypass = rejectBypass();
if (bypass.length) fail(`bypass mechanism rejected: ${bypass.join(", ")}`);
if (process.env.VALIDATION_DISABLED && !/^(0|false|no)$/i.test(process.env.VALIDATION_DISABLED)) fail("bypass mechanism rejected: env VALIDATION_DISABLED");
const ts = loadTs(ROOT);
if (!ts) fail("TypeScript compiler API unavailable (fail closed)");
const parse = (name, text, kind) => ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, kind ?? (name.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS));
const canon = (o) => JSON.stringify(o);
const readF = (rp) => fs.readFileSync(path.join(ROOT, rp), "utf8");
const T = (o, k) => o.get(k);

// ── Declared intent (each entry is VERIFIED against source below) ───────────────────────────────────────────────────
const OLD_ROUTE = R("routes/local-accounts.ts");
const OLD_ROUTE_BASELINE = path.join(BASE, "sources/artifacts__api-server__src__routes__local-accounts.ts");
const FRONTEND = [
  { file: RA("components/local-accounts.tsx"), kind: "ui-component" },
  { file: RA("config/fields/local-account-create.ts"), kind: "declarative-config" },
  { file: RA("config/fields/local-account-buy.ts"), kind: "declarative-config" },
];
const baselineCopy = (f) => path.join(BASE, "sources", f.replace(/\//g, "__"));
const OWNER_DOMAIN = [R("vault/domain/local-account.ts"), R("vault/domain/local-account-values.ts")];
const OWNER_SECURITY = [R("vault/security/local-account-ownership.ts")];
const OWNER_APP = ["accounts", "bridge", "bulk", "receipt", "value"].map((n) => R(`vault/application/local-account/${n}.ts`));
const OWNER_INFRA = [R("vault/infrastructure/repositories/local-account-repository.ts"), R("vault/infrastructure/repositories/local-account-consumer-repository.ts")];
const OWNER_FILES = [...OWNER_DOMAIN, ...OWNER_SECURITY, ...OWNER_APP, ...OWNER_INFRA];
const ROUTE_ALLOWED_EXTERNAL = new Set(["express", "../middlewares/auth", "../lib/policy/pep/middleware", "../lib/receipt-theme", "../services/credit-meter"]);
const ROUTE_ALLOWED_VAULT = /^\.\.\/vault\/(application|security)\//;
const RESPONSE_MAPPER_IMPORTS = new Set(["streamFantasticReceiptPdf"]);
const SUPERSEDED_BY_02C = {
  "route-keeps-compat-export-requireLocalAccountOwnership": "02-C removed the compat re-export (re-proven: check compat:reexport-removed)",
  "security:exported-requireLocalAccountOwnership-identical": "the export no longer exists on the route (re-proven: check compat:reexport-removed and route imports the owner gate)",
  "diff-audit:no-unrelated-changes": "02-B audited against the pre-02-C tree; 02-C changed consumers by design (re-proven: check diff-audit:no-change-since-02C-seal)",
};
const REFACTOR_UNIT_PROOF = { computeCategoryAggregate: ["unit:computeCategoryAggregate:mixed", "unit:computeCategoryAggregate:empty", "unit:computeCategoryAggregate:all-no-buy"], findCategoryReceiptByToken: ["unit:findCategoryReceiptByToken:found", "unit:findCategoryReceiptByToken:missing"], fmtPublicCategoryReceipt: ["unit:fmtPublicCategoryReceipt"] };
const DISPLAY_HELPERS = ["calcAge", "calcROI"];
const ALLOWED_GAP_FILES_ADDED = new Set([`${GAP}validate-vlt-gap-02-D.mjs`, `${GAP}freeze-vlt-gap-02-D-baseline.mjs`]);
const UNIT_TESTED_GAP = /^VLT-GAP-(0[3-9]|1\d|20)$/;

// ── AST primitives ──────────────────────────────────────────────────────────────────────────────────────────────────
const lineOf = (sf, pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;
const hasExport = (s) => s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
function tokensOf(node, sf) { const t = []; (function w(n) { if (ts.isJSDoc(n)) return; if (n.getChildCount(sf) === 0) { if (n.kind !== ts.SyntaxKind.EndOfFileToken) t.push(n.getText(sf)); } else n.getChildren(sf).forEach(w); })(node); return t; }
const fp = (node, sf) => { const t = tokensOf(node, sf); if (t[0] === "export") t.shift(); return sha256(t.join(" ")); };
const norm = (s) => s.replace(/\s+/g, " ").trim();
const collapse = (s) => s.replace(/\$\{[^}]*\}/g, "${}");
const HTTP = new Set(["get", "post", "put", "patch", "delete", "head", "options", "all"]);

function scanTop(text, fileName) {
  const sf = parse(fileName, text); const syms = []; const imports = [];
  for (const s of sf.statements) {
    const L = { start: lineOf(sf, s.getStart(sf)), end: lineOf(sf, s.getEnd()) };
    if (ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier)) {
      const c = s.importClause; const names = [];
      if (c?.name) names.push({ imported: "default", local: c.name.text });
      if (c?.namedBindings && ts.isNamedImports(c.namedBindings)) for (const e of c.namedBindings.elements) names.push({ imported: (e.propertyName ?? e.name).text, local: e.name.text });
      if (c?.namedBindings && ts.isNamespaceImport(c.namedBindings)) names.push({ imported: "*", local: c.namedBindings.name.text });
      imports.push({ spec: s.moduleSpecifier.text, names, typeOnly: Boolean(c?.isTypeOnly), line: L.start });
      continue;
    }
    if (ts.isExportDeclaration(s)) { syms.push({ key: `export-decl@${L.start}`, kind: "export-decl", node: s, ...L, exported: true }); continue; }
    if (ts.isExportAssignment(s)) { syms.push({ key: "default", kind: "export-default", node: s, ...L, exported: true }); continue; }
    if (ts.isFunctionDeclaration(s) && s.name) { syms.push({ key: s.name.text, kind: "function", node: s, ...L, exported: hasExport(s) }); continue; }
    if (ts.isVariableStatement(s)) { for (const d of s.declarationList.declarations) syms.push({ key: d.name.getText(sf), kind: "const", node: s, decl: d, ...L, exported: hasExport(s) }); continue; }
    if (ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s)) { syms.push({ key: s.name.text, kind: "type", node: s, ...L, exported: hasExport(s) }); continue; }
    if (ts.isExpressionStatement(s) && ts.isCallExpression(s.expression)) {
      const c = s.expression;
      if (ts.isPropertyAccessExpression(c.expression) && c.expression.expression.getText(sf) === "router" && HTTP.has(c.expression.name.text)) {
        const p = c.arguments[0]; const h = c.arguments[c.arguments.length - 1];
        syms.push({ key: `${c.expression.name.text.toUpperCase()} ${ts.isStringLiteral(p) ? p.text : "?"}`, kind: "route", node: s, ...L, handler: h, middleware: [...c.arguments].slice(1, -1), method: c.expression.name.text.toUpperCase(), path: ts.isStringLiteral(p) ? p.text : "?" });
        continue;
      }
    }
    syms.push({ key: `stmt@${L.start}`, kind: "unknown-statement", node: s, ...L });
  }
  return { sf, syms, imports };
}
function calleeChain(expr) {
  if (ts.isIdentifier(expr)) return [expr.text];
  if (ts.isPropertyAccessExpression(expr)) return [...calleeChain(expr.expression), expr.name.text];
  if (ts.isCallExpression(expr)) return calleeChain(expr.expression);
  if (ts.isNonNullExpression(expr) || ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isAwaitExpression(expr)) return calleeChain(expr.expression);
  return ["<expr>"];
}
const SQLISH = /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/i;
function sqlLiterals(sf) {
  const out = new Set();
  (function w(n) {
    let text = null;
    if (ts.isNoSubstitutionTemplateLiteral(n)) text = n.text; else if (ts.isTemplateExpression(n)) text = n.head.text + n.templateSpans.map((s) => "${}" + s.literal.text).join("");
    if (text !== null) { const t = norm(text); if (SQLISH.test(t)) out.add(t); }
    ts.forEachChild(n, w);
  })(sf);
  return out;
}
function analyze(nodes, sf) {
  const f = { db: 0, tables: [], sql: [], control: {}, calls: [], chains: [], req: [], awaits: 0, fetchLike: [], crypto: [] };
  const bump = (k) => { f.control[k] = (f.control[k] ?? 0) + 1; };
  const visit = (n) => {
    if (ts.isIdentifier(n)) {
      if (n.text === "db" || n.text === "sql" || n.text === "pool" || n.text === "prisma") f.db++;
      if (/Table$/.test(n.text)) f.tables.push(n.text);
      if (["fetch", "axios", "XMLHttpRequest"].includes(n.text)) f.fetchLike.push(n.text);
      if (/^(encryptField|decryptField|decryptRow|decryptRows|createHash|createHmac|randomBytes|randomUUID|createCipheriv|createDecipheriv)$/.test(n.text)) f.crypto.push(n.text);
      if (n.text === "req" && !(n.parent && ts.isParameter(n.parent))) {
        let cur = n; while (cur.parent && ((ts.isPropertyAccessExpression(cur.parent) && cur.parent.expression === cur) || (ts.isNonNullExpression(cur.parent) && cur.parent.expression === cur))) cur = cur.parent;
        f.req.push(cur.getText(sf).replace(/!/g, ""));
      }
    }
    if (ts.isCallExpression(n)) { const ch = calleeChain(n.expression); f.chains.push(ch); f.calls.push(ch.join(".")); }
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) { if (SQLISH.test(n.text) && /\b(FROM|INTO|SET|WHERE|VALUES)\b/i.test(n.text)) f.sql.push(norm(n.text).slice(0, 80)); }
    if (ts.isTemplateExpression(n)) { const t = norm(n.head.text + n.templateSpans.map((s) => "${}" + s.literal.text).join("")); if (SQLISH.test(t) && /\b(FROM|INTO|SET|WHERE|VALUES)\b/i.test(t)) f.sql.push(t.slice(0, 80)); }
    switch (n.kind) {
      case ts.SyntaxKind.IfStatement: bump("if"); break;
      case ts.SyntaxKind.ConditionalExpression: bump("ternary"); break;
      case ts.SyntaxKind.SwitchStatement: bump("switch"); break;
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
  return f;
}
const branches = (f) => Object.values(f.control).reduce((a, b) => a + b, 0);
function findDecl(text, fileName, name) { const { sf, syms } = scanTop(text, fileName); const s = syms.find((x) => x.key === name && (x.kind === "function" || x.kind === "const")); return s ? { ...s, sf } : null; }
function resolveSpec(fromRel, spec) { return spec.startsWith(".") ? path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec)).replace(/\.(ts|tsx|js|mjs)$/, "") : null; }

// ── Text access with overlays (used by the mutation self-tests; production runs use an empty overlay) ──────────────
const rd = (overlay, rp) => overlay.get(rp) ?? (fs.existsSync(path.join(ROOT, rp)) ? readF(rp) : null);
const exportedNames = (text, fileName) => { const { syms } = scanTop(text, fileName); return new Set(syms.filter((s) => s.exported).map((s) => s.key)); };

// ── 0. Seal: verify, never write ────────────────────────────────────────────────────────────────────────────────────
function loadSeal() {
  const sealFile = path.join(SEAL_DIR, "SEAL.json"), manFile = path.join(SEAL_DIR, "tree-manifest.json");
  if (!fs.existsSync(sealFile) || !fs.existsSync(manFile)) fail("baseline-02d/SEAL.json missing — run freeze-vlt-gap-02-D-baseline.mjs ONCE, before validating 02-D");
  return { seal: JSON.parse(fs.readFileSync(sealFile, "utf8")), manText: fs.readFileSync(manFile, "utf8"), manFile };
}
function sealChecks({ seal, manText }, cGraph) {
  const checks = []; const chk = (name, passed, details = "") => checks.push({ name, passed: Boolean(passed), details: String(details) });
  chk("seal:tree-manifest-hash-matches-seal", sha256(manText) === seal.tree_manifest_sha256, "tree-manifest.json edited after sealing");
  chk("seal:certified-by-02C-and-bound-to-fresh-02C-run", seal.certified_by?.sub_phase === "VLT-GAP-02-C" && cGraph?.status === "PASS" && cGraph.source_tree_sha256 === seal.certified_by.source_tree_sha256, `seal=${seal.certified_by?.source_tree_sha256?.slice(0, 12)} fresh-02C=${cGraph?.source_tree_sha256?.slice(0, 12)}`);
  const cur = walkFiles(path.join(ROOT, GAP), [], (p) => /\.mjs$/.test(p)).map((f) => [rel(f), sha256File(f)]);
  const curMap = Object.fromEntries(cur);
  const edited = Object.entries(seal.gap_scripts_at_freeze ?? {}).filter(([k, h]) => curMap[k] !== h).map(([k]) => k);
  chk("seal:earlier-validators-and-harness-byte-identical-since-freeze", edited.length === 0 && Object.keys(seal.gap_scripts_at_freeze ?? {}).length >= 10, edited.join(", "));
  const addedScripts = cur.map(([k]) => k).filter((k) => !(k in (seal.gap_scripts_at_freeze ?? {})) && !ALLOWED_GAP_FILES_ADDED.has(k));
  chk("seal:no-unexpected-new-validator-scripts", addedScripts.length === 0, addedScripts.join(", "));
  return checks;
}
function diffAudit({ manText }) {
  const man = JSON.parse(manText).files; const now = {};
  for (const f of walkFiles(ROOT)) { const k = rel(f); if (!k.startsWith(GAP)) now[k] = sha256File(f); }
  const changed = [], added = [], removed = [];
  for (const [k, v] of Object.entries(now)) { if (!(k in man)) added.push(k); else if (man[k] !== v) changed.push(k); }
  for (const k of Object.keys(man)) if (!(k in now)) removed.push(k);
  return { changed, added, removed, unexpected: [...changed, ...added, ...removed], files_compared: Object.keys(man).length };
}

// ── 1. Route retirement gate ────────────────────────────────────────────────────────────────────────────────────────
const middlewareText = (r, sf) => r.middleware.map((m) => norm(m.getText(sf)));
function routeGate({ overlay = new Map(), proof }) {
  const violations = []; const dispositions = []; const thin = [];
  const curText = rd(overlay, OLD_ROUTE); const oldText = fs.readFileSync(OLD_ROUTE_BASELINE, "utf8");
  const cur = scanTop(curText, OLD_ROUTE), old = scanTop(oldText, "baseline/routes/local-accounts.ts");
  const curByKey = new Map(cur.syms.map((s) => [s.key, s])); const consumed = new Set();
  const claims = new Map((proof.symbols_moved ?? []).filter((c) => c.from === OLD_ROUTE).map((c) => [c.symbol, c]));
  const impMap = new Map(); for (const i of cur.imports) for (const n of i.names) impMap.set(n.local, { spec: i.spec, imported: n.imported });
  const oldRoutes = old.syms.filter((s) => s.kind === "route"), curRoutes = cur.syms.filter((s) => s.kind === "route");

  // 1a. every current import is an adapter dependency
  const importRows = cur.imports.map((i) => ({ spec: i.spec, line: i.line, allowed: ROUTE_ALLOWED_EXTERNAL.has(i.spec) || ROUTE_ALLOWED_VAULT.test(i.spec) }));
  for (const i of importRows) if (!i.allowed) violations.push(`route:${i.line} imports ${i.spec}, which is not an adapter dependency (db/crypto/sync/provider access must live in vault/)`);
  // 1b. top level of the current route: router const, registrations, default export — nothing else
  for (const s of cur.syms) {
    const ok = s.kind === "route" || s.kind === "export-default" || (s.kind === "const" && s.key === "router" && /^Router\(\)$/.test(s.decl.initializer?.getText(cur.sf) ?? ""));
    if (!ok) violations.push(`route:${s.start} top-level ${s.kind} '${s.key}' is not adapter wiring (new/retained non-adapter symbol in old file)`);
  }
  // 1c. disposition of every baseline symbol
  for (const b of old.syms) {
    const out = { symbol: b.key, kind: b.kind, baseline_lines: [b.start, b.end], baseline_fingerprint: fp(b.node, old.sf) };
    if (b.kind === "route") {
      const c = curByKey.get(b.key);
      if (!c) { out.disposition = "MISSING_ROUTE"; violations.push(`${b.key}: public route disappeared`); }
      else {
        consumed.add(b.key);
        const t = thinCheck(c, cur.sf, impMap, cur.imports); out.disposition = t.thin ? "ADAPTER_THIN" : "AUTHORITATIVE_OLD_LOGIC"; out.thinness = t; out.new_owner = t.use_case;
        thin.push({ route: b.key, ...t, middleware: middlewareText(c, cur.sf) });
        if (!t.thin) violations.push(`${b.key}: route is not an adapter — ${t.violations.join("; ")}`);
        const ob = analyze([b.handler], old.sf); out.baseline_metrics = { db_refs: ob.db, sql: ob.sql.length, branches: branches(ob), handler_lines: lineOf(old.sf, b.handler.getEnd()) - lineOf(old.sf, b.handler.getStart(old.sf)) + 1 };
        out.current_metrics = t.metrics;
      }
      dispositions.push({ symbol: b.key, disposition: out.disposition }); continue;
    }
    if (b.kind === "export-default" || (b.kind === "const" && b.key === "router")) {
      const c = curByKey.get(b.key); if (c) consumed.add(b.key);
      out.disposition = c ? "ADAPTER_WIRING" : "MISSING_WIRING"; if (!c) violations.push(`${b.key}: router wiring missing`);
      dispositions.push({ symbol: b.key, disposition: out.disposition }); continue;
    }
    const still = curByKey.get(b.key);
    if (still) { consumed.add(b.key); out.disposition = "STILL_DECLARED_IN_OLD_FILE"; violations.push(`${b.key}: ${b.kind} is still declared in the old route file`); dispositions.push({ symbol: b.key, disposition: out.disposition }); continue; }
    const claim = claims.get(b.key);
    if (b.kind === "type") { out.disposition = "TYPE_REMOVED"; dispositions.push({ symbol: b.key, disposition: out.disposition }); continue; }
    if (!claim) { out.disposition = "UNACCOUNTED"; violations.push(`${b.key}: baseline symbol neither retained as adapter nor moved (no extraction claim)`); dispositions.push({ symbol: b.key, disposition: out.disposition }); continue; }
    const destRel = claim.to; const dtxt = rd(overlay, destRel); const dest = dtxt ? findDecl(dtxt, destRel, claim.symbol) : null;
    out.new_owner = `${destRel}#${claim.symbol}`;
    if (!dest) { out.disposition = "MOVE_UNPROVEN"; violations.push(`${b.key}: destination declaration missing in ${destRel}`); }
    else if (claim.mode === "verbatim") { const ok = fp(dest.node, dest.sf) === out.baseline_fingerprint; out.disposition = ok ? "MOVED_VERBATIM" : "MOVE_UNPROVEN"; if (!ok) violations.push(`${b.key}: verbatim move to ${destRel} not proven (fingerprint differs)`); }
    else if (claim.mode === "refactor") {
      const need = REFACTOR_UNIT_PROOF[b.key] ?? []; const have = need.length > 0 && need.every((n) => proof.__unit_checks?.get(n) === true);
      const df = analyze([dest.node], dest.sf); const exec = df.db > 0 || df.calls.length > 0 || branches(df) > 0;
      out.disposition = have && exec ? "MOVED_REFACTORED_WITH_UNIT_PROOF" : "MOVE_UNPROVEN"; out.unit_proof = need;
      if (!(have && exec)) violations.push(`${b.key}: refactored move not proven (unit proof present=${have}, executable=${exec})`);
    } else { out.disposition = "MOVE_UNPROVEN"; violations.push(`${b.key}: unknown claim mode '${claim.mode}'`); }
    if (dest) out.new_metrics = { tokens: tokensOf(dest.node, dest.sf).length, ...(() => { const f = analyze([dest.node], dest.sf); return { db_refs: f.db, branches: branches(f), calls: f.calls.length }; })() };
    dispositions.push({ symbol: b.key, disposition: out.disposition });
  }
  for (const c of cur.syms) if (!consumed.has(c.key) && !old.syms.some((b) => b.key === c.key)) { /* already reported by 1b when non-adapter */ }
  // 1d. route table identity (paths, order, middleware chains) — public routes stable, security chain untouched
  const table = (rs, sf) => rs.map((r) => ({ key: r.key, mw: middlewareText(r, sf) }));
  const tOld = table(oldRoutes, old.sf), tCur = table(curRoutes, cur.sf);
  const order = canon(tOld.map((r) => r.key)) === canon(tCur.map((r) => r.key));
  const mwDiffs = tOld.filter((r, i) => tCur[i] && canon(r.mw) !== canon(tCur[i].mw)).map((r) => r.key);
  if (!order) violations.push("route table: set/order of registered routes differs from the pre-extraction baseline (Express order is behavior)");
  for (const k of mwDiffs) violations.push(`${k}: middleware chain (auth/ownership/limiter/credit) differs from the pre-extraction baseline`);
  // 1d-bis. every ownership gate used by the route is the one owned by vault/security (no local/legacy copy)
  const ownerSecTxt = rd(overlay, OWNER_SECURITY[0]); const ownerSecExports = ownerSecTxt ? exportedNames(ownerSecTxt, OWNER_SECURITY[0]) : new Set();
  const gateNames = new Set(); for (const r of curRoutes) for (const m of r.middleware) (function w(n) { if (ts.isIdentifier(n) && /^require\w*Ownership$/.test(n.text)) gateNames.add(n.text); ts.forEachChild(n, w); })(m);
  const ownership_gates = [...gateNames].map((n) => { const im = impMap.get(n); return { gate: n, imported_from: im?.spec ?? null, exported_by_owner: ownerSecExports.has(im?.imported ?? n) }; });
  for (const g of ownership_gates) if (g.imported_from !== "../vault/security/local-account-ownership" || !g.exported_by_owner) violations.push(`ownership gate ${g.gate} does not come from vault/security/local-account-ownership (from=${g.imported_from}, owner exports=${g.exported_by_owner})`);
  if (!overlay.size && ownership_gates.length < 3) violations.push(`expected the three local-account ownership gates on the route, found ${ownership_gates.length}`);
  // 1e. compat re-export gone
  const compatGone = !cur.syms.some((s) => s.kind === "export-decl") && !/export\s*\{[^}]*requireLocalAccountOwnership/.test(curText);
  if (!compatGone) violations.push("compat re-export still present on the old route");
  const metrics = { baseline_lines: oldText.split("\n").length, current_lines: curText.split("\n").length, baseline_tokens: tokensOf(old.sf, old.sf).length, current_tokens: tokensOf(cur.sf, cur.sf).length, baseline_db_refs: analyze([old.sf], old.sf).db, current_db_refs: analyze([cur.sf], cur.sf).db, baseline_sql_literals: sqlLiterals(old.sf).size, current_sql_literals: sqlLiterals(cur.sf).size };
  return { violations, dispositions, thin, ownership_gates, imports: importRows, route_table: { baseline: tOld, current: tCur, same_order: order, middleware_diffs: mwDiffs, routes_baseline: oldRoutes.length, routes_current: curRoutes.length }, compat_reexport_removed: compatGone, metrics, baseline_symbols: old.syms.length, symbols: old.syms.map((b) => ({ symbol: b.key, kind: b.kind, lines: [b.start, b.end], baseline_fingerprint: fp(b.node, old.sf), disposition: dispositions.find((d) => d.symbol === b.key)?.disposition })), sha256: { baseline: sha256(oldText), current: sha256(curText) } };
}
function thinCheck(sym, sf, impMap, imports) {
  const v = []; const h = sym.handler;
  if (!h || !(ts.isArrowFunction(h) || ts.isFunctionExpression(h)) || !h.body || !ts.isBlock(h.body)) return { thin: false, violations: ["handler is not an inline block function"], metrics: null, use_case: null };
  const fe = analyze([h.body], sf); const stmts = h.body.statements.length;
  if (fe.db) v.push(`database access (${fe.db} refs)`);
  if (fe.tables.length) v.push(`table reference: ${[...new Set(fe.tables)].join(",")}`);
  if (fe.sql.length) v.push(`SQL literal in route (${fe.sql.length})`);
  if (fe.fetchLike.length) v.push(`provider/network call: ${[...new Set(fe.fetchLike)].join(",")}`);
  if (fe.crypto.length) v.push(`crypto call: ${[...new Set(fe.crypto)].join(",")}`);
  for (const k of ["ternary", "switch", "loop", "try", "catch", "throw", "&&", "||", "??", "optional-chain"]) if (fe.control[k]) v.push(`decision/flow construct: ${k} x${fe.control[k]}`);
  const ifs = []; (function w(n) { if (ts.isIfStatement(n)) ifs.push(n); ts.forEachChild(n, w); })(h.body);
  for (const i of ifs) if (!/^!\w+\.streamed$/.test(i.expression.getText(sf).trim())) v.push(`business branch: if (${i.expression.getText(sf).slice(0, 50)})`);
  if (ifs.length > 1) v.push(`more than one response-mapping branch (${ifs.length})`);
  if (stmts > 3) v.push(`handler has ${stmts} statements (max 3: parse → delegate → respond)`);
  for (const r of fe.req) if (!/^req\.(user\.userId|params\.\w+|body|query\.\w+)$/.test(r)) v.push(`request access outside the parsing allow-list: ${r}`);
  let delegates = 0; let useCase = null; const bad = [];
  for (const ch of fe.chains) {
    if (ch[0] === "res") { if (!ch.slice(1).every((x) => x === "status" || x === "json")) bad.push(ch.join(".")); continue; }
    if (ch.length !== 1) { bad.push(ch.join(".")); continue; }
    const imp = impMap.get(ch[0]);
    if (imp && RESPONSE_MAPPER_IMPORTS.has(imp.imported) && imp.spec === "../lib/receipt-theme") continue;
    if (imp && /^\.\.\/vault\/application\//.test(imp.spec)) { delegates++; useCase ??= `${imp.spec.replace(/^\.\.\//, "artifacts/api-server/src/")}.ts#${imp.imported}`; continue; }
    bad.push(ch.join("."));
  }
  if (bad.length) v.push(`non-adapter calls: ${[...new Set(bad)].slice(0, 5).join(", ")}`);
  if (delegates === 0) v.push("route does not delegate to a vault/application use-case");
  for (const m of sym.middleware ?? []) (function w(n) { if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && n.body) { const mf = analyze([n.body], sf); if (mf.db || mf.calls.some((c) => !/^res\.(status|json)/.test(c)) || Object.keys(mf.control).length) v.push("inline middleware callback does more than write a response"); return; } ts.forEachChild(n, w); })(m);
  return { thin: v.length === 0, violations: v, use_case: useCase, metrics: { db_refs: fe.db, tables: new Set(fe.tables).size, sql_literals: fe.sql.length, branches: branches(fe), delegated_calls: delegates, statements: stmts, awaits: fe.awaits } };
}

// ── 2. Use-case ownership: every delegate target must be an exported, executable, application-layer function ─────
function useCaseProof(thin, overlay = new Map()) {
  const out = []; const bad = [];
  const seen = new Map();
  for (const t of thin) {
    if (!t.use_case) continue; const [file, sym] = t.use_case.split("#");
    if (!seen.has(t.use_case)) {
      const txt = rd(overlay, file); const d = txt ? findDecl(txt, file, sym) : null; const exp = txt ? exportedNames(txt, file).has(sym) : false;
      const f = d ? analyze([d.node], d.sf) : null;
      const executable = Boolean(f) && (f.db > 0 || f.calls.length > 0 || branches(f) > 0 || f.awaits > 0);
      seen.set(t.use_case, { file, symbol: sym, exists: Boolean(d), exported: exp, executable, tokens: d ? tokensOf(d.node, d.sf).length : 0, branches: f ? branches(f) : 0, calls: f ? f.calls.length : 0, routes: [] });
    }
    seen.get(t.use_case).routes.push(t.route);
  }
  for (const u of seen.values()) { out.push(u); if (!u.exists || !u.exported || !u.executable) bad.push(`${u.file}#${u.symbol}: exists=${u.exists} exported=${u.exported} executable=${u.executable}`); }
  return { use_cases: out, violations: bad };
}

// ── 3. Hidden import / bypass scan ──────────────────────────────────────────────────────────────────────────────────
function allSourceFiles() {
  const roots = ["artifacts", "scripts", "tests", "lib", "services", "apps", "packages"].map((d) => path.join(ROOT, d)).filter((d) => fs.existsSync(d));
  const files = []; for (const d of roots) walkFiles(d, files, (p) => /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(p) && !p.endsWith(".d.ts"));
  return files.map((f) => rel(f)).filter((r) => !r.startsWith("scripts/antas/"));
}
function importsOfText(text, fileRel) {
  const sf = parse(fileRel, text); const out = [];
  const add = (spec, kind, names, pos) => out.push({ spec, kind, names, line: lineOf(sf, pos), resolved: resolveSpec(fileRel, spec) });
  for (const s of sf.statements) {
    if (ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier)) { const c = s.importClause; const names = []; if (c?.name) names.push("default"); if (c?.namedBindings && ts.isNamedImports(c.namedBindings)) c.namedBindings.elements.forEach((e) => names.push((e.propertyName ?? e.name).text)); if (c?.namedBindings && ts.isNamespaceImport(c.namedBindings)) names.push("*"); add(s.moduleSpecifier.text, "import", names, s.getStart(sf)); }
    else if (ts.isExportDeclaration(s) && s.moduleSpecifier && ts.isStringLiteral(s.moduleSpecifier)) add(s.moduleSpecifier.text, "re-export", s.exportClause && ts.isNamedExports(s.exportClause) ? s.exportClause.elements.map((e) => (e.propertyName ?? e.name).text) : ["*"], s.getStart(sf));
  }
  (function w(n) { if (ts.isCallExpression(n) && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0]) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require"))) add(n.arguments[0].text, n.expression.kind === ts.SyntaxKind.ImportKeyword ? "dynamic-import" : "require", ["*"], n.getStart(sf)); ts.forEachChild(n, w); })(sf);
  return out;
}
function hiddenImportScan({ overlay = new Map(), moved }) {
  const files = [...new Set([...allSourceFiles(), ...overlay.keys()])]; const edges = [], violations = [];
  for (const r of files) {
    const text = rd(overlay, r); if (text === null || !/local-accounts/.test(text)) continue;
    for (const im of importsOfText(text, r)) {
      const isOld = im.resolved === OLD_ROUTE.replace(/\.ts$/, "") || /(^|\/)routes\/local-accounts$/.test(im.spec);
      if (!isOld) continue;
      const e = { consumer: r, symbols: im.names, kind: im.kind, line: im.line };
      const movedHit = im.names.filter((n) => moved.has(n));
      if (r === R("routes/index.ts") && im.kind === "import" && im.names.length === 1 && im.names[0] === "default") e.verdict = "router-mount";
      else if (movedHit.length) { e.verdict = "HIDDEN_BYPASS"; violations.push(`${r}:${im.line} imports moved symbol(s) ${movedHit.join(",")} from the old route module`); }
      else if (im.kind !== "import" || im.names.includes("*")) { e.verdict = "UNKNOWN_MEMBER_USE"; violations.push(`${r}:${im.line} ${im.kind} of the old route module with unknown member use`); }
      else { e.verdict = "UNEXPECTED_IMPORTER"; violations.push(`${r}:${im.line} imports ${im.names.join(",")} from the old route module (only the router mount may)`); }
      edges.push(e);
    }
  }
  const mounted = edges.some((e) => e.verdict === "router-mount");
  if (!mounted && !overlay.size) violations.push("routes/index.ts no longer mounts the local-accounts router (route table would silently disappear)");
  return { edges, violations };
}

// ── 4. Duplicate implementation scan ────────────────────────────────────────────────────────────────────────────────
function fnFingerprints(sf, minTokens = 20) {
  const res = [];
  const visit = (node, name) => { const t = tokensOf(node, sf); if (t[0] === "export") t.shift(); if (t.length >= minTokens) res.push({ name, fp: sha256(t.map((x) => (x === name ? "§" : x)).join(" ")), tokens: t.length }); };
  for (const s of sf.statements) {
    if (ts.isFunctionDeclaration(s) && s.name) visit(s, s.name.text);
    if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) if (d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) visit(d, d.name.getText(sf));
  }
  return res;
}
function duplicateScan({ overlay = new Map(), seal, thinRoutes }) {
  const man = JSON.parse(seal.manText).files;
  const oldSf = scanTop(fs.readFileSync(OLD_ROUTE_BASELINE, "utf8"), "baseline/local-accounts.ts");
  const baseFps = new Map();
  for (const s of oldSf.syms) {
    if (s.kind === "function" || (s.kind === "const" && s.decl.initializer && (ts.isArrowFunction(s.decl.initializer) || ts.isFunctionExpression(s.decl.initializer)))) for (const x of fnFingerprints(oldSf.sf, 12).filter((y) => y.name === s.key)) baseFps.set(x.fp, `baseline#${s.key}`);
    if (s.kind === "route" && s.handler?.body && ts.isBlock(s.handler.body)) { const t = tokensOf(s.handler.body, oldSf.sf); if (t.length >= 20) baseFps.set(sha256(t.join(" ")), `baseline#${s.key}`); }
  }
  const ownerFps = new Map(); const ownerDup = []; const ownerSql = new Set();
  for (const f of OWNER_FILES) { const txt = rd(overlay, f); if (!txt) continue; const sf = parse(f, txt); for (const x of fnFingerprints(sf, 12)) { if (ownerFps.has(x.fp) && ownerFps.get(x.fp).split("#")[0] !== f) ownerDup.push({ a: ownerFps.get(x.fp), b: `${f}#${x.name}` }); else ownerFps.set(x.fp, `${f}#${x.name}`); } if (OWNER_INFRA.includes(f)) for (const s of sqlLiterals(sf)) ownerSql.add(collapse(s)); }
  const scan = [...new Set([...allSourceFiles(), ...overlay.keys()])];
  const newHits = [], preExisting = [], sqlNew = [], sqlPre = [], survivors = [];
  const deferredFiles = new Map((thinRoutes.deferred ?? []).map((d) => [d.file, d.deferred_to]));
  for (const r of scan) {
    if (OWNER_FILES.includes(r) || r.startsWith(R("vault/")) && /local-account/.test(r)) continue;
    const text = rd(overlay, r); if (!text) continue;
    const untouched = !overlay.has(r) && man[r] !== undefined && man[r] === sha256(text);
    if (/\bfunction\b|=>|SELECT|INSERT|UPDATE|DELETE/i.test(text)) {
      const sf = parse(r, text);
      for (const x of fnFingerprints(sf, 12)) {
        const hit = baseFps.get(x.fp) ?? ownerFps.get(x.fp);
        if (hit) (untouched ? preExisting : newHits).push({ file: r, symbol: x.name, duplicates: hit, tokens: x.tokens, ...(untouched ? { reason: "file unchanged since the 02-C seal; pre-dates GAP-02 (independent idiom, reported to GAP-16)" } : {}) });
      }
      for (const s of sqlLiterals(sf)) if (ownerSql.has(collapse(s))) { const row = { file: r, sql: s.slice(0, 100), deferred_to: deferredFiles.get(r) ?? null }; (untouched ? sqlPre : sqlNew).push(row); }
    }
  }
  // baseline route handler bodies surviving anywhere in the routes dir (including the current old route)
  const curTxt = rd(overlay, OLD_ROUTE); const cur = scanTop(curTxt, OLD_ROUTE);
  for (const s of cur.syms) if (s.kind === "route" && s.handler?.body && ts.isBlock(s.handler.body)) { const t = tokensOf(s.handler.body, cur.sf); if (t.length >= 20 && baseFps.has(sha256(t.join(" ")))) survivors.push({ file: OLD_ROUTE, route: s.key, same_as: baseFps.get(sha256(t.join(" "))) }); }
  for (const s of cur.syms) if (s.kind === "function") for (const x of fnFingerprints(cur.sf, 12).filter((y) => y.name === s.key)) if (baseFps.has(x.fp)) survivors.push({ file: OLD_ROUTE, symbol: s.key, same_as: baseFps.get(x.fp) });
  return { newHits, preExisting, sqlNew, sqlPre, survivors, ownerDup, owner_functions_fingerprinted: ownerFps.size, baseline_fingerprints: baseFps.size, owner_sql_statements: ownerSql.size };
}

// ── 5. Layering of the owner modules ────────────────────────────────────────────────────────────────────────────────
function layeringScan(overlay = new Map()) {
  const v = []; const notes = [];
  for (const f of OWNER_FILES) {
    const txt = rd(overlay, f); if (txt === null) { v.push(`${f}: owner file missing`); continue; }
    const sf = parse(f, txt); const ims = importsOfText(txt, f); const layer = f.split("/")[4]; // artifacts/api-server/src/vault/<layer>/ → index 4 (src=2, vault=3)
    const clean = txt.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const im of ims) {
      const target = im.resolved ?? im.spec;
      if (/(^|\/)routes(\/|$)/.test(target)) v.push(`${f}:${im.line} ${layer} layer imports the API route layer (${im.spec})`);
      if (layer === "domain" && (im.spec === "@workspace/db" || im.spec === "drizzle-orm" || /infrastructure|application|security|\/lib\/|\/services\//.test(im.spec))) v.push(`${f}:${im.line} domain layer imports ${im.spec}`);
      if (layer === "application" && (im.spec === "@workspace/db" || im.spec === "drizzle-orm") ) v.push(`${f}:${im.line} application layer accesses the database directly (${im.spec}); persistence belongs to infrastructure/repositories`);
      if (["application", "infrastructure", "domain"].includes(layer) && im.spec === "express" && !/import\s+type[^;]*from\s+["']express["']/.test(txt)) v.push(`${f}:${im.line} runtime import of express in ${layer} layer`);
      if (layer === "infrastructure" && /\/application\//.test(target)) v.push(`${f}:${im.line} infrastructure imports the application layer`);
      if (layer === "infrastructure" && im.spec === "express") v.push(`${f}:${im.line} infrastructure imports express`);
    }
    if (!["domain", "application", "infrastructure", "security"].includes(layer)) v.push(`${f}: cannot determine vault layer (got '${layer}'); layer rules would be skipped`);
    if (layer === "application" && /\b(req|res)\b\s*[.:,)]/.test(clean)) v.push(`${f}: application layer references Express req/res identifiers`);
    if (layer === "security") { const a = analyze([sf], sf); if (a.db) notes.push(`${f}: security layer resolves ownership through the database (${a.db} refs) — permitted PEP resource resolver`); }
  }
  return { violations: v, notes };
}

// ── 6. Frontend disposition ─────────────────────────────────────────────────────────────────────────────────────────
function frontendGate({ overlay = new Map(), routeTable }) {
  const violations = []; const files = [];
  const routeRegex = routeTable.map((r) => ({ method: r.key.split(" ")[0], path: r.key.slice(r.key.indexOf(" ") + 1), re: new RegExp(`^${r.key.slice(r.key.indexOf(" ") + 1).replace(/:[^/]+/g, "[^/]+")}$`) }));
  for (const fe of FRONTEND) {
    const text = rd(overlay, fe.file); const basePath = baselineCopy(fe.file);
    const baseText = fs.existsSync(basePath) ? fs.readFileSync(basePath, "utf8") : null;
    const rec = { file: fe.file, kind: fe.kind, sha256: sha256(text ?? ""), baseline_sha256: baseText ? sha256(baseText) : null, unchanged_since_pre_extraction_baseline: baseText !== null && text === baseText };
    if (baseText === null) violations.push(`${fe.file}: pre-extraction baseline copy missing`);
    else if (text !== baseText) violations.push(`${fe.file}: modified since the pre-extraction baseline (GAP-02 API extraction must not alter the UI source)`);
    const { sf, syms } = scanTop(text, fe.file); const a = analyze([sf], sf);
    if (a.db) violations.push(`${fe.file}: database access identifier(s) in a UI/config file (${a.db})`);
    if (a.sql.length) violations.push(`${fe.file}: SQL literal(s) in a UI/config file`);
    if (a.fetchLike.length) violations.push(`${fe.file}: direct provider/network call ${[...new Set(a.fetchLike)].join(",")} (only customFetch to the public API is permitted)`);
    if (a.crypto.length) violations.push(`${fe.file}: crypto call in a UI/config file (${[...new Set(a.crypto)].join(",")})`);
    rec.metrics = { lines: text.split("\n").length, db_refs: a.db, sql_literals: a.sql.length, crypto_calls: a.crypto.length };
    if (fe.kind === "declarative-config") {
      const consts = syms.filter((s) => s.kind === "const"); const ok = consts.length > 0 && consts.every((s) => { let pure = true; (function w(n) { if (ts.isCallExpression(n) || ts.isNewExpression(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isConditionalExpression(n)) pure = false; ts.forEachChild(n, w); })(s.decl.initializer); return pure; });
      rec.disposition = ok ? "DECLARATIVE_CONFIG" : "CONFIG_HAS_LOGIC"; if (!ok) violations.push(`${fe.file}: configuration contains executable logic`);
      rec.symbols = syms.filter((s) => s.kind !== "type").map((s) => ({ symbol: s.key, disposition: ok ? "DECLARATIVE_DATA" : "LOGIC", lines: [s.start, s.end] }));
    } else {
      // endpoint contract: every customFetch call resolves to a registered route with the same method
      const endpoints = [];
      (function w(n) {
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "customFetch" && n.arguments[0]) {
          const a0 = n.arguments[0]; let p = null;
          if (ts.isStringLiteralLike(a0)) p = a0.text; else if (ts.isTemplateExpression(a0)) p = a0.head.text + a0.templateSpans.map((s) => "\u0000" + s.literal.text).join("");
          let method = "GET"; const a1 = n.arguments[1];
          if (a1 && ts.isObjectLiteralExpression(a1)) for (const pr of a1.properties) if (ts.isPropertyAssignment(pr) && pr.name.getText(sf) === "method" && ts.isStringLiteralLike(pr.initializer)) method = pr.initializer.text.toUpperCase();
          if (p !== null) endpoints.push({ method, path: p.replace(/\u0000/g, "${}"), line: lineOf(sf, n.getStart(sf)), probe: p.replace(/\u0000/g, "1").replace(/^\/api/, "") });
        }
        ts.forEachChild(n, w);
      })(sf);
      const unresolved = endpoints.filter((e) => !e.probe.startsWith("/local-accounts") ? false : !routeRegex.some((r) => r.method === e.method && r.re.test(e.probe)));
      for (const e of unresolved) violations.push(`${fe.file}:${e.line} calls ${e.method} ${e.path}, which is not a registered local-account route`);
      rec.api_calls = endpoints.map((e) => ({ method: e.method, path: e.path, line: e.line, resolves_to_registered_route: e.probe.startsWith("/local-accounts") ? routeRegex.some((r) => r.method === e.method && r.re.test(e.probe)) : null }));
      if (endpoints.length === 0) violations.push(`${fe.file}: no API calls found (component would not be a consumer of the Vault routes)`);
      // residual helpers
      const residual = []; const helperCalls = [];
      for (const s of syms) {
        if (s.kind === "type") { residual.push({ symbol: s.key, lines: [s.start, s.end], disposition: "TYPE_CONTRACT_SHAPE" }); continue; }
        if (s.kind !== "function" && s.kind !== "const") { residual.push({ symbol: s.key, lines: [s.start, s.end], disposition: "OTHER" }); continue; }
        const isComp = s.kind === "function" && /^[A-Z]/.test(s.key); const f = analyze([s.node], sf);
        if (DISPLAY_HELPERS.includes(s.key)) residual.push({ symbol: s.key, lines: [s.start, s.end], disposition: "DISPLAY_CALC_DEFERRED_GAP-16", fingerprint: fp(s.node, sf), branches: branches(f) });
        else if (isComp) residual.push({ symbol: s.key, lines: [s.start, s.end], disposition: "UI_ADAPTER", api_calls: f.calls.filter((c) => c === "customFetch").length, branches: branches(f), db_refs: f.db });
        else if (s.key === "toFormState") { const ok = f.calls.every((c) => /\.slice$/.test(c)) && f.db === 0; residual.push({ symbol: s.key, lines: [s.start, s.end], disposition: ok ? "COMPAT_MAPPING_API_TO_FORM" : "LOGIC" }); if (!ok) violations.push(`${fe.file}: toFormState performs more than compatibility mapping`); }
        else if (s.key === "EMPTY") { const ok = s.decl.initializer && ts.isObjectLiteralExpression(s.decl.initializer); residual.push({ symbol: s.key, lines: [s.start, s.end], disposition: ok ? "FORM_DEFAULTS_DATA" : "LOGIC" }); if (!ok) violations.push(`${fe.file}: EMPTY is not a data literal`); }
        else { residual.push({ symbol: s.key, lines: [s.start, s.end], disposition: "UNCLASSIFIED" }); violations.push(`${fe.file}: unclassified symbol ${s.key}`); }
      }
      // display helpers must never feed persisted/requested data
      (function w(n, ancestors) {
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && DISPLAY_HELPERS.includes(n.expression.text)) {
          const inFetch = ancestors.some((a) => ts.isCallExpression(a) && ts.isIdentifier(a.expression) && a.expression.text === "customFetch");
          const inPayload = ancestors.some((a) => ts.isVariableDeclaration(a) && /payload|body/i.test(a.name.getText(sf)));
          helperCalls.push({ helper: n.expression.text, line: lineOf(sf, n.getStart(sf)), feeds_request: inFetch || inPayload });
        }
        ts.forEachChild(n, (c) => w(c, [...ancestors, n]));
      })(sf, []);
      for (const c of helperCalls) if (c.feeds_request) violations.push(`${fe.file}:${c.line} ${c.helper}() feeds a request payload — display calc would be authoritative`);
      rec.symbols = residual; rec.display_helper_call_sites = helperCalls; rec.disposition = "UI_ADAPTER_WITH_DEFERRED_DISPLAY_CALC";
    }
    files.push(rec);
  }
  // duplicated display helpers across the frontend (the deferral must be real and still current)
  const dup = { helpers: {} }; const uiFiles = walkFiles(AYZEN, [], (p) => /\.(ts|tsx)$/.test(p)).map((f) => rel(f));
  for (const r of uiFiles) { const txt = rd(overlay, r); if (!txt || !/calcAge|calcROI/.test(txt)) continue; const { sf, syms } = scanTop(txt, r); for (const s of syms) if (s.kind === "function" && DISPLAY_HELPERS.includes(s.key)) (dup.helpers[s.key] ??= []).push({ file: r, fingerprint: fp(s.node, sf).slice(0, 16), lines: [s.start, s.end] }); }
  for (const h of DISPLAY_HELPERS) {
    const copies = dup.helpers[h] ?? [];
    if (copies.length < 2) violations.push(`deferral to GAP-16 for ${h} is stale: only ${copies.length} copy found (nothing left to de-duplicate — remove the residual instead)`);
    dup[`${h}_distinct_bodies`] = new Set(copies.map((c) => c.fingerprint)).size;
  }
  // server-side owner of the same math must exist (client display value is not the only implementation)
  const ownerHas = (n) => { const t = rd(overlay, R("vault/domain/local-account-values.ts")); return Boolean(t) && exportedNames(t, "values.ts").has(n); };
  dup.server_owner = { calcAgeLabel: ownerHas("calcAgeLabel"), calcRoiPct: ownerHas("calcRoiPct") };
  if (!dup.server_owner.calcAgeLabel || !dup.server_owner.calcRoiPct) violations.push("server-side owner of age/ROI calculation missing from vault/domain/local-account-values.ts");
  return { violations, files, duplicated_display_helpers: dup, deferral: { gap: "VLT-GAP-16", reason: "calcAge/calcROI are display formatters copy-pasted across the frontend (component + local/KYC pages); removing one copy would not retire anything, and the frontend has no shared owner module. GAP-16 finds and removes duplicate account/KYC logic repo-wide.", still_current: DISPLAY_HELPERS.every((h) => (dup.helpers[h] ?? []).length >= 2) } };
}

// ── 7. Executed prerequisites ───────────────────────────────────────────────────────────────────────────────────────
function runNode(script, cwd, args = []) { const r = spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8", env: process.env, timeout: 600000 }); return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` }; }
function runPrerequisites() {
  const commands = []; const exit_codes = {};
  const c = runNode(path.join(ROOT, `${GAP}validate-vlt-gap-02-C.mjs`), ROOT); commands.push("node scripts/antas/vault/gap/validate-vlt-gap-02-C.mjs (in place)"); exit_codes["02-C"] = c.status;
  const cGraph = fs.existsSync(path.join(EVID, "consumer-graph.json")) ? JSON.parse(fs.readFileSync(path.join(EVID, "consumer-graph.json"), "utf8")) : null;
  // 02-B in a temp copy: it rewrites extraction-proof.json (which 02-C's seal is anchored to) and audits against a pre-02-C tree.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vlt-gap-02d-"));
  let b = { status: null, out: "" }; let bEv = null;
  try {
    fs.cpSync(ROOT, tmp, { recursive: true, filter: (s) => !/(^|\/)(node_modules|\.git)(\/|$)/.test(s) });
    b = runNode(path.join(tmp, `${GAP}validate-vlt-gap-02-B.mjs`), tmp); commands.push("node scripts/antas/vault/gap/validate-vlt-gap-02-B.mjs (temp copy of the current tree)"); exit_codes["02-B(temp)"] = b.status;
    const p = path.join(tmp, "reports/antas/vault/gap/VLT-GAP-02/extraction-proof.json"); bEv = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  return { commands, exit_codes, c, cGraph, b, bEv };
}
function prerequisiteChecks(pre, chk) {
  chk("prerequisite:02-C-executed-and-passed (consumer rewire, differential vs sealed 02-B consumers, mutation tests, CI lint)", pre.c.status === 0 && pre.cGraph?.status === "PASS", pre.c.out.slice(-300));
  chk("prerequisite:02-C-census-has-no-unclassified-table-access", pre.cGraph && !pre.cGraph.table_access_census.some((x) => x.kind === "UNCLASSIFIED"), "");
  chk("prerequisite:02-C-deferrals-all-name-a-later-gap", pre.cGraph && (pre.cGraph.deferred_consumers ?? []).every((d) => UNIT_TESTED_GAP.test(d.deferred_to)), (pre.cGraph?.deferred_consumers ?? []).map((d) => d.deferred_to).join(","));
  const ev = pre.bEv; const failing = ev ? ev.checks.filter((c) => !c.passed).map((c) => c.name) : ["<no evidence>"]; const unexplained = failing.filter((n) => !(n in SUPERSEDED_BY_02C));
  chk("prerequisite:02-B-executed-in-temp-copy-and-produced-evidence", Boolean(ev) && ev.sub_phase === "VLT-GAP-02-B" && typeof ev.evidence_body_sha256 === "string", pre.b.out.slice(-200));
  chk("prerequisite:02-B-every-failing-check-is-a-named-02-C-supersession", unexplained.length === 0, unexplained.join(", "));
  const t = ev?.tests ?? {};
  chk("prerequisite:02-B-differential-115-cases-all-identical (old baseline route vs current route, no skips)", t.differential_cases >= 100 && t.differential_passed === t.differential_cases, canon(t));
  chk("prerequisite:02-B-unit-parity-and-mutation-suites-complete", t.unit_parity > 0 && t.unit_passed === t.unit_parity && t.mutation_tests > 0 && t.mutation_detected === t.mutation_tests, canon(t));
  chk("prerequisite:02-B-security-only-superseded-check-failed", t.security_checks - t.security_passed <= 1 && failing.filter((n) => /^security:/.test(n)).every((n) => n in SUPERSEDED_BY_02C), `${t.security_passed}/${t.security_checks}`);
  return { failing, unexplained };
}

// ── 8. Degraded differential typecheck ──────────────────────────────────────────────────────────────────────────────
function typecheck() {
  const cfgRaw = ts.readConfigFile(path.join(ROOT, "tsconfig.base.json"), ts.sys.readFile).config?.compilerOptions ?? {};
  const opts = ts.convertCompilerOptionsFromJson({ ...cfgRaw, noEmit: true, skipLibCheck: true, types: [], incremental: false, composite: false, baseUrl: ROOT }, ROOT).options;
  const route = path.join(SRC, "routes/local-accounts.ts"); const ownerAbs = OWNER_FILES.map((f) => path.join(ROOT, f)); const scope = [route, ...ownerAbs];
  const run = (useBaseline) => {
    const host = ts.createCompilerHost(opts); const rf = host.readFile.bind(host), gs = host.getSourceFile.bind(host);
    const ov = (f) => (useBaseline && f === route ? OLD_ROUTE_BASELINE : undefined);
    host.readFile = (f) => rf(ov(f) ?? f);
    host.getSourceFile = (f, lv, ...r) => { const o = ov(f); return o ? ts.createSourceFile(f, fs.readFileSync(o, "utf8"), lv, true) : gs(f, lv, ...r); };
    const roots = useBaseline ? [route] : scope; const prog = ts.createProgram(roots, opts, host); const tally = {}; const syntactic = [];
    for (const f of roots) { const sf = prog.getSourceFile(f); if (sf) for (const d of prog.getSyntacticDiagnostics(sf)) syntactic.push(`${rel(f)}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`); }
    for (const sf of prog.getSourceFiles()) {
      if (!scope.includes(sf.fileName) || (useBaseline && ownerAbs.includes(sf.fileName))) continue;
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
  return { mode: "degraded-differential (project dependencies are not installed in the upload; full tsc/build was NOT executed)", before_total: Object.values(before.tally).reduce((a, b) => a + b, 0), after_total: Object.values(after.tally).reduce((a, b) => a + b, 0), syntactic_errors: after.syntactic, new_diagnostics: regress, real_class_new: regress.filter((r) => real.includes(parseInt(r, 10))) };
}

// ── 9. Mutation self-tests: the gate must FAIL when the retirement is undone ────────────────────────────────────────
function selfTests(ctx) {
  const out = []; const t = (name, passed, details = "") => out.push({ name, passed: Boolean(passed), details });
  const cur = fs.readFileSync(path.join(ROOT, OLD_ROUTE), "utf8"); const ov = (rp, txt) => new Map([[rp, txt]]);
  const mutate = (re, repl) => { const m = cur.replace(re, repl); return m === cur ? null : m; };
  const gate = (overlay) => routeGate({ overlay, proof: ctx.proof }).violations;
  const anchor = (n, m) => t(`selftest:mutation-anchor-${n}`, m !== null);
  const hasV = (overlay, re) => gate(overlay).some((v) => re.test(v));
  // (a) DB query smuggled into a thin route
  let m = mutate(/(router\.get\("\/local-accounts\/categories", requireAuth, async \(req, res\): Promise<void> => \{\n)/, "$1  await db.execute(sql`SELECT 1`);\n"); anchor("a", m);
  if (m) t("selftest:db-query-in-route-is-detected", hasV(ov(OLD_ROUTE, m), /GET \/local-accounts\/categories.*database access/));
  // (b) decision tree smuggled into a thin route
  m = mutate(/(router\.post\("\/local-accounts", requireAuth, async \(req, res\): Promise<void> => \{\n)/, "$1  const q = req.body.category ? 1 : 2;\n"); anchor("b", m);
  if (m) t("selftest:decision-tree-in-route-is-detected", hasV(ov(OLD_ROUTE, m), /POST \/local-accounts.*(ternary|non-adapter|statements)/));
  // (c) moved helper re-declared in the old file
  m = cur + "\nfunction safeNum(v: unknown) { return Number(v) || 0; }\n"; t("selftest:redeclared-moved-symbol-is-detected", hasV(ov(OLD_ROUTE, m), /safeNum|top-level function/));
  // (d) forbidden import (db) added
  m = mutate(/(import \{ Router \} from "express";\n)/, '$1import { db } from "@workspace/db";\n'); anchor("d", m);
  if (m) t("selftest:db-import-in-route-is-detected", hasV(ov(OLD_ROUTE, m), /@workspace\/db/));
  // (e) ownership middleware dropped from a route
  m = mutate(/requireAuth, requireLocalAccountOwnership\("local_account\.delete", denySilentSuccess\), /, "requireAuth, "); anchor("e", m);
  if (m) t("selftest:dropped-ownership-middleware-is-detected", hasV(ov(OLD_ROUTE, m), /DELETE \/local-accounts\/:id.*middleware chain/));
  // (f) routes reordered (literal sub-path must precede /:id)
  { const a = cur.indexOf('router.get("/local-accounts/categories"'), b = cur.indexOf('router.get("/local-accounts/:id", requireAuth'); anchor("f", a > 0 && b > a ? "ok" : null);
    if (a > 0 && b > a) { const blockA = cur.slice(a, cur.indexOf("\n});\n", a) + 5), blockB = cur.slice(b, cur.indexOf("\n});\n", b) + 5); const swapped = cur.replace(blockA, "\u0001").replace(blockB, blockA).replace("\u0001", blockB); t("selftest:route-reorder-is-detected", hasV(ov(OLD_ROUTE, swapped), /route table: set\/order/)); } }
  // (g) compat re-export restored
  m = cur.replace(/export default router;/, "export { requireLocalAccountOwnership } from \"../vault/security/local-account-ownership\";\nexport default router;"); t("selftest:compat-reexport-restored-is-detected", hasV(ov(OLD_ROUTE, m), /compat re-export|top-level/));
  // (h) a use-case whose body is hollowed out (scaffold-only destination)
  { const f = R("vault/application/local-account/accounts.ts"); const txt = fs.readFileSync(path.join(ROOT, f), "utf8"); const hollow = txt.replace(/export async function listLocalAccounts\b[\s\S]*?\n\}\n/, "export async function listLocalAccounts(..._a: unknown[]): Promise<any> { return { status: 200, body: [] }; }\n");
    t("selftest:mutation-anchor-h", hollow !== txt); t("selftest:scaffold-only-use-case-is-detected", useCaseProof(ctx.thin, ov(f, hollow)).violations.some((v) => /listLocalAccounts/.test(v))); }
  // (i) hidden import of a moved symbol from the old route module
  { const moved = ctx.moved; t("selftest:hidden-import-of-moved-symbol-is-detected", hiddenImportScan({ overlay: ov(R("routes/zz-hidden.ts"), 'import { safeNum } from "./local-accounts";\nexport const x = safeNum;\n'), moved }).violations.some((v) => /zz-hidden/.test(v)));
    t("selftest:dynamic-import-of-old-route-is-detected", hiddenImportScan({ overlay: ov(R("routes/zz-dyn.ts"), 'export async function f() { return import("./local-accounts"); }\n'), moved }).violations.some((v) => /zz-dyn/.test(v))); }
  // (j) copied implementation outside vault/ (renamed to defeat name matching)
  { const own = fs.readFileSync(path.join(ROOT, R("vault/domain/local-account-values.ts")), "utf8").replace(/\bcalcRoiPct\b/g, "someOtherName"); t("selftest:renamed-copy-outside-vault-is-detected", duplicateScan({ overlay: ov(R("routes/zz-copy.ts"), own), seal: ctx.seal, thinRoutes: ctx.cGraphInfo }).newHits.some((h) => h.file.endsWith("zz-copy.ts"))); }
  // (k) persistence statement pasted outside the repository
  { const repo = fs.readFileSync(path.join(ROOT, OWNER_INFRA[1]), "utf8"); const one = [...sqlLiterals(parse("r.ts", repo))][0]; t("selftest:mutation-anchor-k", Boolean(one));
    if (one) t("selftest:moved-sql-pasted-outside-repository-is-detected", duplicateScan({ overlay: ov(R("routes/zz-sql.ts"), `export const q = \`${one.replace(/\$\{\}/g, "${x}")}\`;\n`), seal: ctx.seal, thinRoutes: ctx.cGraphInfo }).sqlNew.some((h) => h.file.endsWith("zz-sql.ts"))); }
  // (l) application layer reaching back into the API layer / database
  { const f = R("vault/application/local-account/bulk.ts"); const txt = fs.readFileSync(path.join(ROOT, f), "utf8");
    t("selftest:application-importing-routes-is-detected", layeringScan(ov(f, `import { x } from "../../../routes/events";\n${txt}`)).violations.some((v) => /API route layer/.test(v)));
    t("selftest:application-importing-db-is-detected", layeringScan(ov(f, `import { db } from "@workspace/db";\n${txt}`)).violations.some((v) => /database directly/.test(v))); }
  // (m) frontend: SQL / provider call / request-feeding calc / unknown endpoint
  { const f = FRONTEND[0].file; const txt = fs.readFileSync(path.join(ROOT, f), "utf8"); const rt = ctx.routeTable; const fg = (s) => frontendGate({ overlay: ov(f, s), routeTable: rt }).violations;
    t("selftest:sql-in-component-is-detected", fg(txt + '\nconst q = `SELECT * FROM local_accounts WHERE id = 1`;\n').some((v) => /SQL literal/.test(v)));
    t("selftest:provider-call-in-component-is-detected", fg(txt + '\nvoid fetch("/x");\n').some((v) => /provider\/network/.test(v)));
    t("selftest:unknown-endpoint-in-component-is-detected", fg(txt + '\nvoid customFetch("/api/local-accounts/nope/nope/nope", { method: "PATCH" });\n').some((v) => /not a registered local-account route/.test(v)));
    t("selftest:display-calc-feeding-request-is-detected", fg(txt + '\nvoid customFetch("/api/local-accounts", { method: "POST", body: JSON.stringify({ roi: calcROI(1, 2) }) });\n').some((v) => /feeds a request payload/.test(v)));
    const cfg = FRONTEND[1].file; const ctxt = fs.readFileSync(path.join(ROOT, cfg), "utf8");
    t("selftest:logic-in-declarative-config-is-detected", frontendGate({ overlay: ov(cfg, ctxt + "\nexport const X = [1].map((a) => a);\n"), routeTable: rt }).violations.some((v) => /executable logic/.test(v))); }
  // (n) seal tampering
  { const forged = { ...ctx.seal, manText: ctx.seal.manText.replace(/"files": \{/, '"files": { "zz": "0",') }; t("selftest:tampered-seal-manifest-is-detected", sealChecks(forged, ctx.cGraph).some((c) => c.name === "seal:tree-manifest-hash-matches-seal" && !c.passed)); }
  // (o) stale display-helper deferral: when only one copy is left, the GAP-16 deferral must be rejected
  { const f = FRONTEND[0].file; const others = Object.values(ctx.frontendClean.duplicated_display_helpers.helpers).flat().map((c) => c.file).filter((x) => x !== f); const ovl = new Map(others.map((x) => [x, "export {};\n"]));
    t("selftest:mutation-anchor-o", others.length >= 3); t("selftest:stale-deferral-is-rejected", frontendGate({ overlay: ovl, routeTable: ctx.routeTable }).violations.some((v) => /deferral to GAP-16 for calc(Age|ROI) is stale/.test(v))); }
  // (p) ownership gate sourced from a look-alike module instead of vault/security
  m = mutate(/requireLocalAccountOwnership, requireLocalAccountCategoryOwnership,/, "requireLocalAccountCategoryOwnership,"); anchor("p", m);
  if (m) { m = m.replace('import { requireAuth, pepDecisionObserver } from "../middlewares/auth";', 'import { requireAuth, pepDecisionObserver, requireLocalAccountOwnership } from "../middlewares/auth";'); t("selftest:mutation-anchor-p2", m.includes("pepDecisionObserver, requireLocalAccountOwnership }")); t("selftest:ownership-gate-from-wrong-module-is-detected", hasV(ov(OLD_ROUTE, m), /ownership gate requireLocalAccountOwnership does not come from vault\/security/)); }
  // (q) layer rules are live (guards against a mis-derived layer silently disabling them)
  { const dom = OWNER_DOMAIN[1]; const dt = fs.readFileSync(path.join(ROOT, dom), "utf8");
    t("selftest:domain-importing-db-is-detected", layeringScan(ov(dom, `import { db } from "@workspace/db";\n${dt}`)).violations.some((v) => /domain layer imports/.test(v)));
    const inf = OWNER_INFRA[0]; const it = fs.readFileSync(path.join(ROOT, inf), "utf8");
    t("selftest:infrastructure-importing-application-is-detected", layeringScan(ov(inf, `import { x } from "../../application/local-account/accounts";\n${it}`)).violations.some((v) => /infrastructure imports the application layer/.test(v)));
    t("selftest:express-runtime-import-in-application-is-detected", layeringScan(ov(OWNER_APP[2], `import express from "express";\n${fs.readFileSync(path.join(ROOT, OWNER_APP[2]), "utf8")}`)).violations.some((v) => /runtime import of express/.test(v)));
    t("selftest:req-res-in-application-is-detected", layeringScan(ov(OWNER_APP[2], `${fs.readFileSync(path.join(ROOT, OWNER_APP[2]), "utf8")}\nexport function bad(req: any, res: any) { return res.json(req.body); }\n`)).violations.some((v) => /req\/res identifiers/.test(v))); }
  return out;
}
function bypassAttempts() {
  const out = [];
  const tries = [{ name: "flag --skip-tests", args: ["--skip-tests"], env: {} }, { name: "flag --force-pass", args: ["--force-pass"], env: {} }, { name: "flag --ignore-failures", args: ["--ignore-failures"], env: {} }, { name: "flag --continue-on-error", args: ["--continue-on-error"], env: {} }, { name: "unknown flag --whatever", args: ["--whatever"], env: {} }, { name: "env ANTAS_BYPASS=true", args: [], env: { ANTAS_BYPASS: "true" } }, { name: "env VALIDATION_DISABLED=true", args: [], env: { VALIDATION_DISABLED: "true" } }];
  for (const tr of tries) { const r = spawnSync(process.execPath, [HERE, ...tr.args], { encoding: "utf8", env: { ...process.env, ...tr.env }, timeout: 60000 }); out.push({ attempt: tr.name, exit_code: r.status, rejected: r.status === 1 && /bypass mechanism rejected/.test(r.stderr ?? "") }); }
  return out;
}

// ── main ────────────────────────────────────────────────────────────────────────────────────────────────────────────
const OLD_FILES = [OLD_ROUTE, ...FRONTEND.map((f) => f.file)];
function sourceHashes() {
  const files = [...OLD_FILES, ...OWNER_FILES, R("routes/index.ts"), `${GAP}harness.mjs`, `${GAP}gap-common.mjs`, `${GAP}freeze-vlt-gap-02-D-baseline.mjs`, rel(path.join(SEAL_DIR, "SEAL.json")), rel(path.join(SEAL_DIR, "tree-manifest.json")), rel(OLD_ROUTE_BASELINE), ...FRONTEND.map((f) => rel(baselineCopy(f.file)))];
  return Object.fromEntries(files.map((f) => [f, sha256File(path.join(ROOT, f))]));
}
const writeEv = (name, obj) => { const txt = `${JSON.stringify(obj, null, 2)}\n`; fs.writeFileSync(path.join(EVID, name), txt); return sha256(txt); };

function verifyMode() {
  const gp = path.join(EVID, EV.gate); if (!fs.existsSync(gp)) fail("evidence missing: run the validator first");
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
  const started = Date.now();
  const sealData = loadSeal();
  for (const f of [OLD_ROUTE_BASELINE, path.join(BASE, "tree-manifest.json"), path.join(EVID, "extraction-proof.json"), path.join(BASE, "symbol-inventory.pre-extraction.json"), ...FRONTEND.map((f) => baselineCopy(f.file))]) if (!fs.existsSync(f)) fail(`sealed pre-extraction baseline/evidence missing: ${rel(f)}`);

  // executed prerequisites (before anything is read from the evidence they regenerate)
  const pre = runPrerequisites();
  const proof = JSON.parse(fs.readFileSync(path.join(EVID, "extraction-proof.json"), "utf8"));
  proof.__unit_checks = new Map((pre.bEv?.checks ?? []).map((c) => [c.name, c.passed]));
  const cGraphInfo = { deferred: (pre.cGraph?.deferred_consumers ?? []) };

  const gate = routeGate({ proof });
  const ucp = useCaseProof(gate.thin);
  const moved = new Set(gate.dispositions.filter((d) => /^MOVED/.test(d.disposition)).map((d) => d.symbol));
  const hidden = hiddenImportScan({ moved });
  const dup = duplicateScan({ seal: sealData, thinRoutes: cGraphInfo });
  const layering = layeringScan();
  const fe = frontendGate({ routeTable: gate.route_table.current });
  const audit = diffAudit(sealData);
  const tc = typecheck();

  // census consistency with the 02-A pre-extraction inventory (line-anchored, independent of my own scan)
  const preRecs = JSON.parse(fs.readFileSync(path.join(BASE, "symbol-inventory.pre-extraction.json"), "utf8")).filter((r) => r.id.startsWith(`${OLD_ROUTE}#`));
  const mineLines = new Set(gate.symbols.map((s) => s.lines[0])); const recLines = new Set(preRecs.map((r) => r.line_start));
  const missingFromMine = [...recLines].filter((l) => !mineLines.has(l)), extraInMine = [...mineLines].filter((l) => !recLines.has(l));

  const ctx = { proof, thin: gate.thin, moved, seal: sealData, cGraph: pre.cGraph, cGraphInfo, routeTable: gate.route_table.current, frontendClean: fe };
  const selft = selfTests(ctx);
  const bypassRes = bypassAttempts();

  const checks = []; const chk = (name, passed, details = "") => checks.push({ name, passed: Boolean(passed), details: typeof details === "string" ? details : canon(details) });
  const prereq = prerequisiteChecks(pre, chk);
  for (const c of sealChecks(sealData, pre.cGraph)) checks.push(c);
  chk("diff-audit:no-change-since-02C-seal (application source, frontend, configs, manifests all byte-identical)", audit.unexpected.length === 0, audit.unexpected.join(", "));
  const rt = gate.route_table;
  chk("census:every-02A-pre-extraction-route-symbol-is-in-the-independent-scan", recLines.size > 0 && missingFromMine.length === 0, `02-A records not found by this scan (by line): ${missingFromMine.join(",")}`);
  chk("census:scan-found-no-baseline-symbol-outside-the-02A-inventory", extraInMine.length === 0, `extra lines: ${extraInMine.join(",")}`);
  chk("retirement:every-baseline-symbol-has-a-proven-disposition", gate.violations.length === 0, gate.violations.slice(0, 10).join(" | "));
  const oldBusiness = gate.symbols.filter((s) => ["AUTHORITATIVE_OLD_LOGIC", "STILL_DECLARED_IN_OLD_FILE", "UNACCOUNTED", "MOVE_UNPROVEN", "MISSING_ROUTE", "MISSING_WIRING", undefined].includes(s.disposition)).map((s) => s.symbol);
  chk("retirement:no-business-symbol-remains-authoritative-in-old-route", oldBusiness.length === 0, oldBusiness.join(", "));
  chk("retirement:all-23-route-handlers-are-thin-adapters", gate.thin.length > 0 && gate.thin.length === rt.routes_baseline && gate.thin.every((x) => x.thin), `${gate.thin.filter((x) => x.thin).length}/${rt.routes_baseline} thin`);
  chk("retirement:route-census-equals-baseline (no route added or dropped)", rt.routes_baseline === rt.routes_current && rt.routes_baseline >= 20, `${rt.routes_baseline} vs ${rt.routes_current}`);
  chk("retirement:route-table-order-and-middleware-chains-identical-to-baseline", rt.same_order && rt.middleware_diffs.length === 0, rt.middleware_diffs.join(", "));
  chk("retirement:old-route-has-zero-db-sql-crypto (measured)", gate.metrics.current_db_refs === 0 && gate.metrics.current_sql_literals === 0 && gate.metrics.baseline_db_refs > 20, canon(gate.metrics));
  chk("retirement:old-route-only-imports-adapter-dependencies", gate.imports.every((i) => i.allowed), gate.imports.filter((i) => !i.allowed).map((i) => i.spec).join(", "));
  chk("compat:reexport-removed", gate.compat_reexport_removed, "");
  chk("security:ownership-gates-are-imported-from-vault-security (no local or legacy copy)", gate.ownership_gates.length >= 3 && gate.ownership_gates.every((g) => g.imported_from === "../vault/security/local-account-ownership" && g.exported_by_owner), canon(gate.ownership_gates));
  chk("retirement:every-delegate-target-is-an-exported-executable-use-case", ucp.violations.length === 0 && ucp.use_cases.length >= 12, ucp.violations.join(" | ") || `${ucp.use_cases.length} use-cases`);
  chk("retirement:every-refactored-move-has-executed-unit-proof", Object.keys(REFACTOR_UNIT_PROOF).every((k) => gate.dispositions.find((d) => d.symbol === k)?.disposition === "MOVED_REFACTORED_WITH_UNIT_PROOF"), "");
  chk("imports:no-hidden-import-keeps-old-code-authoritative", hidden.violations.length === 0, hidden.violations.join(" | "));
  chk("duplicates:no-copy-of-extracted-implementation-added-outside-owner", dup.newHits.length === 0, canon(dup.newHits));
  chk("duplicates:no-moved-sql-added-outside-repositories", dup.sqlNew.length === 0, canon(dup.sqlNew));
  chk("duplicates:no-baseline-implementation-survives-in-old-route", dup.survivors.length === 0, canon(dup.survivors));
  chk("duplicates:no-two-owner-modules-implement-the-same-function", dup.ownerDup.length === 0, canon(dup.ownerDup));
  chk("duplicates:fingerprint-corpus-is-non-trivial", dup.baseline_fingerprints >= 10 && dup.owner_functions_fingerprinted >= 10, `${dup.baseline_fingerprints} baseline / ${dup.owner_functions_fingerprinted} owner fingerprints`);
  chk("layering:owner-modules-do-not-reach-the-API-layer-or-bypass-repositories", layering.violations.length === 0, layering.violations.join(" | "));
  chk("frontend:files-classified-unchanged-and-free-of-db-sql-provider-crypto", fe.violations.length === 0, fe.violations.slice(0, 8).join(" | "));
  chk("frontend:every-component-api-call-resolves-to-a-registered-route", fe.files.filter((f) => f.api_calls).every((f) => f.api_calls.length > 0 && f.api_calls.every((c) => c.resolves_to_registered_route !== false)), "");
  chk("frontend:display-helper-deferral-to-GAP-16-is-current", fe.deferral.still_current, canon(fe.duplicated_display_helpers.helpers));
  chk("typecheck:no-syntax-errors-in-route-or-owner-files", tc.syntactic_errors.length === 0, tc.syntactic_errors.join(" | "));
  chk("typecheck:no-new-real-class-diagnostics-vs-baseline-route", tc.real_class_new.length === 0, tc.real_class_new.join(" | "));
  for (const r of selft) chk(r.name, r.passed, r.details);
  chk("selftest:coverage-at-least-30-mutations-executed", selft.length >= 30, `${selft.length}`);
  chk("bypass:every-bypass-attempt-is-rejected-by-the-validator-itself", bypassRes.length >= 7 && bypassRes.every((b) => b.rejected), canon(bypassRes.filter((b) => !b.rejected)));
  const failed = checks.filter((c) => !c.passed);

  fs.mkdirSync(EVID, { recursive: true });
  const hashes = sourceHashes(); const bd = binding(hashes);
  const common = { phase: PHASE, sub_phase: SUB_PHASE, commit_sha: bd.commit_sha, commit_binding: bd.commit_binding, source_tree_sha256: bd.source_tree_sha256, validator_version: VALIDATOR_VERSION, validator_sha256: sha256File(HERE) };
  const companion = {};
  const dispCount = gate.dispositions.reduce((m, d) => (m[d.disposition] = (m[d.disposition] ?? 0) + 1, m), {});
  companion[EV.old] = writeEv(EV.old, { ...common, description: "Pre-extraction (sealed) vs current fingerprint and disposition of every symbol in the old local-account sources", route: { file: OLD_ROUTE, metrics: gate.metrics, sha256: gate.sha256, symbols: gate.symbols, disposition_summary: dispCount }, frontend: fe.files.map((f) => ({ file: f.file, kind: f.kind, disposition: f.disposition, sha256: f.sha256, baseline_sha256: f.baseline_sha256, unchanged_since_pre_extraction_baseline: f.unchanged_since_pre_extraction_baseline, metrics: f.metrics, symbols: f.symbols })), census_consistency_with_02A: { records: recLines.size, missing_from_scan: missingFromMine, extra_in_scan: extraInMine } });
  const ownerRows = OWNER_FILES.map((f) => { const txt = fs.readFileSync(path.join(ROOT, f), "utf8"); const { sf, syms } = scanTop(txt, f); const a = analyze([sf], sf); return { file: f, sha256: sha256(txt), lines: txt.split("\n").length, exports: syms.filter((s) => s.exported && s.kind !== "type").map((s) => s.key), executable_business: { db_refs: a.db, sql_literals: sqlLiterals(sf).size, branches: branches(a), calls: a.calls.length } }; });
  companion[EV.neu] = writeEv(EV.neu, { ...common, description: "Fingerprints of the new owner modules and proof that the old routes actually call them", owner_files: ownerRows, use_cases: ucp.use_cases, moved_symbols: gate.symbols.filter((s) => /^MOVED/.test(s.disposition ?? "")).map((s) => ({ symbol: s.symbol, disposition: s.disposition })), layering_notes: layering.notes });
  companion[EV.thin] = writeEv(EV.thin, { ...common, description: "Per-route thinness of every route left in the old file", allowed_in_old_route: ["request parsing (req.user.userId / req.params.* / req.body / req.query.*)", "auth-context construction", "response mapping (res.status/json, PDF streaming callback)", "middleware wiring", "router default export"], rejected_in_old_route: ["db/sql/table access", "provider/crypto/event/sync calls", "domain calculations", "decision trees", "duplicated authorization/persistence", "non-adapter imports", "compat re-exports"], routes: gate.thin, imports: gate.imports, route_table: rt, summary: { routes: gate.thin.length, thin: gate.thin.filter((x) => x.thin).length, not_thin: gate.thin.filter((x) => !x.thin).length, ...gate.metrics } });
  companion[EV.dup] = writeEv(EV.dup, { ...common, description: "Duplicate implementation scan (name-agnostic token fingerprints + normalized SQL)", added_copies_outside_owner: dup.newHits, added_sql_outside_repositories: dup.sqlNew, baseline_bodies_surviving_in_old_route: dup.survivors, owner_module_duplicates: dup.ownerDup, pre_existing_function_overlaps_reported_to_GAP_16: dup.preExisting, pre_existing_sql_overlaps_with_deferred_consumers: dup.sqlPre, corpus: { baseline_fingerprints: dup.baseline_fingerprints, owner_functions_fingerprinted: dup.owner_functions_fingerprinted, owner_sql_statements: dup.owner_sql_statements }, hidden_import_edges: hidden.edges, hidden_import_violations: hidden.violations, layering_violations: layering.violations, frontend_duplicated_display_helpers: fe.duplicated_display_helpers, frontend_deferral: fe.deferral });
  companion[EV.beh] = writeEv(EV.beh, { ...common, description: "Old sealed baseline route vs current route executed side by side (02-B differential, run in a temp copy) plus 02-C consumer differential (run in place)", stubbed: "no network and no real database; deterministic stand-ins are identical for OLD and NEW", differential_02B: pre.bEv?.tests, superseded_02B_checks: Object.fromEntries(prereq.failing.map((n) => [n, SUPERSEDED_BY_02C[n] ?? "UNEXPLAINED"])), consumer_differential_02C: pre.cGraph?.tests, typecheck: tc });
  companion[EV.sec] = writeEv(EV.sec, { ...common, description: "Security regression: middleware chains and route order identical to baseline; ownership gate imported from vault/security; bypass attempts rejected; gate mutation tests", route_middleware_chains: { same_order: rt.same_order, differences: rt.middleware_diffs, per_route: rt.current }, ownership_gates: gate.ownership_gates, security_02B: { passed: pre.bEv?.tests?.security_passed, total: pre.bEv?.tests?.security_checks }, validator_bypass_test: bypassRes, mutation_evidence: selft });
  const g = { ...common, source_hashes: hashes, commands: [...pre.commands, "in-process AST retirement gate / duplicate scan / layering / frontend classification", "in-process mutation self-tests", "child-process bypass attempts against this validator"], exit_codes: { ...pre.exit_codes, retirement_gate: gate.violations.length ? 1 : 0, mutation_self_tests: selft.every((r) => r.passed) ? 0 : 1, bypass_attempts: bypassRes.every((b) => b.rejected) ? 0 : 1, typecheck_degraded: tc.real_class_new.length || tc.syntactic_errors.length ? 1 : 0 },
    baseline: { mode: "write-once seal (verified, never written by this validator)", seal_file: rel(path.join(SEAL_DIR, "SEAL.json")), sealed_at: sealData.seal.sealed_at, certified_by: sealData.seal.certified_by },
    symbols_moved: gate.symbols.filter((s) => /^MOVED/.test(s.disposition ?? "")).map((s) => `${OLD_ROUTE}#${s.symbol}`), consumers_migrated: pre.cGraph?.consumer_graph?.rewired_consumers?.map((c) => c.file) ?? [], old_business_symbols_remaining: oldBusiness, duplicate_implementations: dup.newHits, disposition_summary: dispCount,
    module_status: failed.length === 0 ? { "routes/local-accounts.ts": "ADAPTER", "vault/{domain,security,application,infrastructure}/local-account*": "MIGRATED", "components/local-accounts.tsx + config/fields/local-account-*.ts": "DISCOVERED (UI adapter / declarative config; display helpers deferred to VLT-GAP-16)", promotion_ceiling: "VERIFIED/RETIRED are withheld: GAP-15 (behavioral equivalence), GAP-16 (duplicate elimination) and GAP-17 (migration-map truth) have not run; the old route is retained as the public HTTP adapter, so it is ADAPTER, not RETIRED.", assigned_by: "validator (this run), not manually" } : null,
    frontend: { files: fe.files.map((f) => ({ file: f.file, disposition: f.disposition })), residual_business_logic_deferred: [{ symbols: DISPLAY_HELPERS, deferred_to: fe.deferral.gap, reason: fe.deferral.reason }] },
    deferred_consumers_from_02C: cGraphInfo.deferred.map((d) => ({ file: d.file, deferred_to: d.deferred_to })),
    summary: { old_route_thin_handlers: gate.thin.filter((x) => x.thin).length, old_route_total_handlers: gate.thin.length, route_db_refs_before: gate.metrics.baseline_db_refs, route_db_refs_after: gate.metrics.current_db_refs, old_route_lines_before: gate.metrics.baseline_lines, old_route_lines_after: gate.metrics.current_lines, use_cases_verified: ucp.use_cases.length, differential_cases_02B: pre.bEv?.tests?.differential_cases, mutation_self_tests: selft.length, mutation_self_tests_passed: selft.filter((s) => s.passed).length, bypass_attempts_rejected: bypassRes.filter((b) => b.rejected).length },
    limitations: ["Full tsc/build was NOT executed: project dependencies are not installed in the upload; a differential typecheck against the sealed baseline route is used and recorded as degraded.", "No git repository is present in the upload; evidence is bound to a source-tree hash instead of a commit SHA (commit_sha is null).", "Behavioral equivalence runs against stubbed DB/provider/event layers, not a live database.", "components/local-accounts.tsx still contains calcAge/calcROI display formatters duplicated across the frontend; they are named and deferred to VLT-GAP-16 (duplicate elimination), not retired here.", "02-A cannot be re-executed on the extracted tree (it regenerates its own baseline and censuses the pre-extraction route); its census is instead cross-checked line-by-line against an independent scan of the sealed baseline."],
    companion_evidence_sha256: companion, checks, status: failed.length === 0 ? "PASS" : "FAIL" };
  g.evidence_body_sha256 = sha256(JSON.stringify(g)); g.generated_at = new Date().toISOString();
  fs.writeFileSync(path.join(EVID, EV.gate), `${JSON.stringify(g, null, 2)}\n`);
  console.log(`${SUB_PHASE} ${g.status} — thin=${g.summary.old_route_thin_handlers}/${g.summary.old_route_total_handlers} route-db-refs=${g.summary.route_db_refs_before}→${g.summary.route_db_refs_after} use-cases=${ucp.use_cases.length} 02B-diff=${g.summary.differential_cases_02B} selftests=${g.summary.mutation_self_tests_passed}/${g.summary.mutation_self_tests} bypass-rejected=${g.summary.bypass_attempts_rejected}/${bypassRes.length} (${Date.now() - started}ms)`);
  if (failed.length) { console.error(failed.map((c) => `- ${c.name}: ${String(c.details).slice(0, 400) || "not satisfied"}`).join("\n")); process.exit(1); }
}
main().catch((e) => fail(`validator crashed: ${e.stack || e}`));
