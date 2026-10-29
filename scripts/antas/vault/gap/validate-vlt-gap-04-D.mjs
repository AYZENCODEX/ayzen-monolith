#!/usr/bin/env node
// VLT-GAP-04-D — Old Source Retirement Gate (Game). Fail-closed validator.
// Evidence: reports/antas/vault/gap/VLT-GAP-04/{old-source-fingerprint,new-source-fingerprint,route-thinness,
//           duplicate-implementation,behavior-regression,security-regression,gate}.json
//
// Question answered: after GAP-04 extraction (04-B) and consumer rewire (04-C), is any OLD Game source
// (routes/game-entries.ts, routes/marketplace-game.ts, components/game-entries.tsx) still authoritative for Game behavior?
//
// Method (everything is derived from source; nothing declared here is trusted):
//   1. re-scan the pre-extraction routes (04-A frozen sources) and the current routes with an AST census;
//   2. every baseline symbol must have a proven disposition (adapter / moved verbatim / moved with executed proof);
//   3. every current route handler must be a thin adapter: parse request -> ONE `const out = await <vault use-case>(...)`
//      -> the canonical response mapping `res.status(out.status).json(out.body)`. The only inline callback permitted is an
//      expression-bodied arrow that binds the request subject to a vault/security decision function (auth-context construction);
//   4. route tables (order, paths, middleware chains incl. resolved ownership deny behavior) must equal the baseline;
//   5. no hidden import, duplicate implementation, or layering breach keeps old code authoritative;
//   6. the UI file is classified, unchanged, and every game API call resolves to a registered route;
//   7. 04-C is executed on a temp copy reconstructed to its certified state (+ --verify in place); 04-B is executed on a temp
//      copy reconstructed to ITS certified state (04-C later added listing.ts and changed two files, which 04-B correctly rejects);
//   8. the gate is mutation-tested: it must FAIL when the retirement is undone, and must reject bypass attempts.
// This validator NEVER writes a baseline; it only verifies the write-once seal from freeze-vlt-gap-04-D-baseline.mjs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { ROOT, sha256, sha256File, rel, rejectBypass, binding, walkFiles } from "./gap-common.mjs";
import { loadTs } from "./harness.mjs";

const VALIDATOR_VERSION = "1.0.0";
const PHASE = "VLT-GAP-04";
const SUB_PHASE = "VLT-GAP-04-D";
const HERE = fileURLToPath(import.meta.url);
const GAP = "scripts/antas/vault/gap/";
const AYZEN = path.join(ROOT, "artifacts/ayzen/src");
const EVID = path.join(ROOT, "reports/antas/vault/gap/VLT-GAP-04");
const BASE = path.join(EVID, "baseline");
const SEAL_DIR = path.join(EVID, "baseline-04d");
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
const baselineCopy = (f) => path.join(BASE, "sources", f.replace(/\//g, "__"));

// ── Declared intent (each entry is VERIFIED against source below) ───────────────────────────────────────────────────
const OLD_ROUTES = [
  { id: "entries", file: R("routes/game-entries.ts"), baseline: baselineCopy(R("routes/game-entries.ts")), gate: "requireGameEntryOwnership", minRoutes: 5 },
  { id: "market", file: R("routes/marketplace-game.ts"), baseline: baselineCopy(R("routes/marketplace-game.ts")), gate: null, minRoutes: 5 },
];
const OWNERSHIP_SPEC = "../vault/security/game-ownership";
const OWNER_DOMAIN = [R("vault/domain/game.ts")];
const OWNER_SECURITY = [R("vault/security/game-ownership.ts")];
const OWNER_APP = ["entries", "marketplace", "listing"].map((n) => R(`vault/application/game/${n}.ts`));
const OWNER_INFRA = [R("vault/infrastructure/repositories/game-repository.ts")];
const OWNER_FILES = [...OWNER_DOMAIN, ...OWNER_SECURITY, ...OWNER_APP, ...OWNER_INFRA];
const ROUTE_ALLOWED_EXTERNAL = new Set(["express", "../middlewares/auth", "../services/credit-meter"]);
const ROUTE_ALLOWED_VAULT = /^\.\.\/vault\/(application|security)\//;
const RESPONSE_MAPPER = /^res\.status\(out\.status\)\.json\(out\.body\);?$/;
const REQ_ALLOWED = /^req\.(user\.userId|params\.\w+|body|query(\.\w+)?)$/;
// Top-level symbols of the pre-extraction routes and where they went (mirrors 04-B; each row is re-verified against source).
const MOVES = [
  { from: R("routes/game-entries.ts"), name: "safe", to: OWNER_INFRA[0], as: "safe" },
  { from: R("routes/game-entries.ts"), name: "safeTags", to: OWNER_INFRA[0], as: "safeTags" },
  { from: R("routes/game-entries.ts"), name: "gameEntryResource", to: OWNER_SECURITY[0], as: "gameEntryResource" },
  { from: R("routes/game-entries.ts"), name: "requireGameEntryOwnership", to: OWNER_SECURITY[0], as: "requireGameEntryOwnership" },
  { from: R("routes/marketplace-game.ts"), name: "gameListingOwnerOrAdminEngine", to: OWNER_SECURITY[0], as: "gameListingOwnerOrAdminEngine" },
  { from: R("routes/marketplace-game.ts"), name: "ensureWallet", to: OWNER_INFRA[0], as: "ensureGameWallet" },
  { from: R("routes/marketplace-game.ts"), name: "parseListing", to: OWNER_APP[1], as: "parseListing" },
];
// A non-verbatim move must be backed by EXECUTED proof from the 04-B suite.
const EXECUTED_PROOF_REQUIRED = { safeTags: ["unit:safeTags() identical over 9 inputs"], gameEntryResource: ["security:owner-resolved-from-game_entries.user_id", "security:missing-row-resolves-to-no-owner-sentinel", "security:non-numeric-id-does-no-db-lookup"] };
const FRONTEND = [{ file: RA("components/game-entries.tsx"), kind: "ui-component" }];
const RELATED_UI = [RA("pages/user/marketplace-game.tsx"), RA("config/vault-game.ts"), RA("config/fields/game-create.ts")];
const UI_CONFIG = new Set(["EMPTY_FORM", "FORM_TABS", "INFO_SCHEMA_FIELDS"]);
const ALLOWED_GAP_FILES_ADDED = new Set([`${GAP}validate-vlt-gap-04-D.mjs`, `${GAP}freeze-vlt-gap-04-D-baseline.mjs`]);
const CHANGED_ALLOWED = new Set([R("routes/marketplace-game.ts"), R("vault/security/game-ownership.ts")]);
const LATER_GAP = /^VLT-GAP-(0[5-9]|1\d|20)$/;

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
    if (ts.isNoSubstitutionTemplateLiteral(n) || ts.isStringLiteral(n)) text = n.text; else if (ts.isTemplateExpression(n)) text = n.head.text + n.templateSpans.map((s) => "${}" + s.literal.text).join("");
    if (text !== null) { const t = norm(text); if (SQLISH.test(t) && /\b(FROM|INTO|SET|WHERE|VALUES)\b/i.test(t)) out.add(t); }
    ts.forEachChild(n, w);
  })(sf);
  return out;
}
function analyze(nodes, sf, skip = null) {
  const f = { db: 0, tables: [], sql: [], control: {}, calls: [], chains: [], req: [], awaits: 0, fetchLike: [], crypto: [] };
  const bump = (k) => { f.control[k] = (f.control[k] ?? 0) + 1; };
  const visit = (n) => {
    if (skip && skip.has(n)) return;
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
  if (!fs.existsSync(sealFile) || !fs.existsSync(manFile)) fail("baseline-04d/SEAL.json missing — run freeze-vlt-gap-04-D-baseline.mjs ONCE, before validating 04-D");
  return { seal: JSON.parse(fs.readFileSync(sealFile, "utf8")), manText: fs.readFileSync(manFile, "utf8"), manFile };
}
function sealChecks({ seal, manText }, cGraph) {
  const checks = []; const chk = (name, passed, details = "") => checks.push({ name, passed: Boolean(passed), details: String(details) });
  chk("seal:tree-manifest-hash-matches-seal", sha256(manText) === seal.tree_manifest_sha256, "tree-manifest.json edited after sealing");
  chk("seal:certified-by-04C-and-bound-to-fresh-04C-run", seal.certified_by?.sub_phase === "VLT-GAP-04-C" && cGraph?.status === "PASS" && cGraph.source_tree_sha256 === seal.certified_by.source_tree_sha256, `seal=${seal.certified_by?.source_tree_sha256?.slice(0, 12)} fresh-04C=${cGraph?.source_tree_sha256?.slice(0, 12)}`);
  const frozenBad = Object.entries(seal.frozen_files ?? {}).filter(([n, v]) => !fs.existsSync(path.join(SEAL_DIR, "frozen", n)) || sha256File(path.join(SEAL_DIR, "frozen", n)) !== v.sha256 || JSON.parse(manText).files[v.source] !== v.sha256);
  chk("seal:frozen-04C-certified-copies-intact-and-equal-to-manifest", frozenBad.length === 0 && Object.keys(seal.frozen_files ?? {}).length === 2, frozenBad.map(([n]) => n).join(", "));
  const cur = walkFiles(path.join(ROOT, GAP), [], (p) => /\.mjs$/.test(p)).map((f) => [rel(f), sha256File(f)]);
  const curMap = Object.fromEntries(cur);
  const edited = Object.entries(seal.gap_scripts_at_freeze ?? {}).filter(([k, h]) => curMap[k] !== h).map(([k]) => k);
  chk("seal:earlier-validators-and-harness-byte-identical-since-freeze", edited.length === 0 && Object.keys(seal.gap_scripts_at_freeze ?? {}).length >= 20, edited.join(", "));
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
  return { changed, added, removed, unexpected: [...changed.filter((k) => !CHANGED_ALLOWED.has(k)), ...added, ...removed], files_compared: Object.keys(man).length };
}

// ── 1. Route retirement gate (one call per old route file) ──────────────────────────────────────────────────────────
// Middleware chains are compared SEMANTICALLY: an ownership gate's deny callback is resolved to its normalized body, so the
// baseline's inline `(_req, res) => { res.status(404).json(...) }` equals the current named `denyGameEntryNotFound` only if the
// response bodies are token-identical; an unresolvable deny identifier can never match the baseline.
function denyBodies(overlay = new Map()) {
  const txt = rd(overlay, OWNER_SECURITY[0]); const out = new Map(); if (!txt) return out;
  const { sf, syms } = scanTop(txt, OWNER_SECURITY[0]);
  for (const s of syms) if (s.kind === "const" && /^deny[A-Z]/.test(s.key) && s.decl.initializer && ts.isArrowFunction(s.decl.initializer)) out.set(s.key, norm(s.decl.initializer.body.getText(sf)));
  return out;
}
function canonMw(m, sf, deny) {
  if (ts.isCallExpression(m) && ts.isIdentifier(m.expression) && /^require\w*Ownership$/.test(m.expression.text) && m.arguments.length === 2) {
    const a1 = m.arguments[1]; let body;
    if (ts.isArrowFunction(a1)) body = norm(a1.body.getText(sf)); else if (ts.isIdentifier(a1)) body = deny.get(a1.text) ?? `UNRESOLVED:${a1.text}`; else body = `UNSUPPORTED:${norm(a1.getText(sf))}`;
    return `${m.expression.text}(${norm(m.arguments[0].getText(sf))}, DENY{${body}})`;
  }
  return norm(m.getText(sf));
}
const middlewareText = (r, sf, deny) => r.middleware.map((m) => canonMw(m, sf, deny));
const isMapperStmt = (st, sf) => ts.isExpressionStatement(st) && RESPONSE_MAPPER.test(norm(st.getText(sf)));
const registerRuleStmts = (text, name) => { const { sf, syms } = scanTop(text, name); return syms.filter((s) => s.kind === "unknown-statement" && /\.registerRule\(/.test(s.node.getText(sf))).map((s) => norm(s.node.getText(sf))); };

function routeGate({ route, overlay = new Map(), unit }) {
  const violations = []; const dispositions = []; const thin = [];
  const deny = denyBodies(overlay);
  const curText = rd(overlay, route.file); const oldText = fs.readFileSync(route.baseline, "utf8");
  const cur = scanTop(curText, route.file), old = scanTop(oldText, `baseline/${route.file}`);
  const curByKey = new Map(cur.syms.map((s) => [s.key, s])); const tag = route.id;
  const impMap = new Map(); for (const i of cur.imports) for (const n of i.names) impMap.set(n.local, { spec: i.spec, imported: n.imported });
  const oldRoutes = old.syms.filter((s) => s.kind === "route"), curRoutes = cur.syms.filter((s) => s.kind === "route");
  const claims = new Map(MOVES.filter((c) => c.from === route.file).map((c) => [c.name, c]));

  const importRows = cur.imports.map((i) => ({ spec: i.spec, line: i.line, allowed: ROUTE_ALLOWED_EXTERNAL.has(i.spec) || ROUTE_ALLOWED_VAULT.test(i.spec) }));
  for (const i of importRows) if (!i.allowed) violations.push(`${tag}:${i.line} imports ${i.spec}, which is not an adapter dependency (db/crypto/market-config/policy access must live in vault/)`);
  for (const s of cur.syms) {
    const ok = s.kind === "route" || s.kind === "export-default" || (s.kind === "const" && s.key === "router" && /^Router\(\)$/.test(s.decl.initializer?.getText(cur.sf) ?? ""));
    if (!ok) violations.push(`${tag}:${s.start} top-level ${s.kind} '${s.key}' is not adapter wiring (new/retained non-adapter symbol in old file)`);
  }
  const ruleClaimOk = (() => { const o = registerRuleStmts(oldText, "old"); const st = rd(overlay, OWNER_SECURITY[0]); const n = st ? registerRuleStmts(st, "sec") : []; return o.length > 0 && canon(o) === canon(n); })();
  for (const b of old.syms) {
    const out = { symbol: b.key, kind: b.kind, baseline_lines: [b.start, b.end], baseline_fingerprint: fp(b.node, old.sf) };
    const push = () => dispositions.push({ file: route.file, symbol: b.key, disposition: out.disposition, new_owner: out.new_owner ?? null });
    if (b.kind === "route") {
      const c = curByKey.get(b.key);
      if (!c) { out.disposition = "MISSING_ROUTE"; violations.push(`${b.key}: public route disappeared`); }
      else {
        const t = thinCheck(c, cur.sf, impMap); out.disposition = t.thin ? "ADAPTER_THIN" : "AUTHORITATIVE_OLD_LOGIC"; out.new_owner = t.use_case;
        thin.push({ file: route.file, route: b.key, ...t, middleware: middlewareText(c, cur.sf, deny) });
        if (!t.thin) violations.push(`${b.key}: route is not an adapter — ${t.violations.join("; ")}`);
      }
      push(); continue;
    }
    if (b.kind === "export-default" || (b.kind === "const" && b.key === "router")) {
      const c = curByKey.get(b.key); out.disposition = c ? "ADAPTER_WIRING" : "MISSING_WIRING"; if (!c) violations.push(`${b.key}: router wiring missing`); push(); continue;
    }
    if (b.kind === "unknown-statement" && /\.registerRule\(/.test(b.node.getText(old.sf))) {
      out.disposition = ruleClaimOk ? "MOVED_VERBATIM" : "MOVE_UNPROVEN"; out.new_owner = `${OWNER_SECURITY[0]}#registerRule`;
      if (!ruleClaimOk) violations.push(`${b.key}: policy-engine rule registrations are not identical in ${OWNER_SECURITY[0]}`);
      push(); continue;
    }
    if (curByKey.get(b.key)) { out.disposition = "STILL_DECLARED_IN_OLD_FILE"; violations.push(`${b.key}: ${b.kind} is still declared in the old route file`); push(); continue; }
    if (b.kind === "type") { out.disposition = "TYPE_REMOVED"; push(); continue; }
    const claim = claims.get(b.key);
    if (!claim) { out.disposition = "UNACCOUNTED"; violations.push(`${b.key}: baseline symbol neither retained as adapter nor moved (no extraction claim)`); push(); continue; }
    const dtxt = rd(overlay, claim.to); const dest = dtxt ? findDecl(dtxt, claim.to, claim.as) : null;
    out.new_owner = `${claim.to}#${claim.as}`;
    if (!dest) { out.disposition = "MOVE_UNPROVEN"; violations.push(`${b.key}: destination declaration missing in ${claim.to}`); }
    else {
      // trailing commas are formatting, not behavior (same normalisation as the 04-B validator)
      const rn = (t) => t.map((x) => (x === claim.name || x === claim.as ? "§" : x)).filter((x, i, a) => !(x === "," && [")", "]", "}"].includes(a[i + 1]))).join(" ");
      const same = sha256(rn(tokensOf(dest.node, dest.sf)).replace(/^export /, "")) === sha256(rn(tokensOf(b.node, old.sf)).replace(/^export /, ""));
      const df = analyze([dest.node], dest.sf); const exec = df.db > 0 || df.calls.length > 0 || branches(df) > 0 || df.awaits > 0 || dest.decl?.initializer !== undefined;
      if (same && exec) out.disposition = "MOVED_VERBATIM";
      else {
        const need = EXECUTED_PROOF_REQUIRED[b.key] ?? []; const have = need.length > 0 && need.every((n) => unit?.get(n) === true);
        out.disposition = exec && have ? "MOVED_REFACTORED_WITH_EXECUTED_PROOF" : "MOVE_UNPROVEN"; out.executed_proof = need;
        if (out.disposition === "MOVE_UNPROVEN") violations.push(`${b.key}: refactored move to ${claim.to} not proven (fingerprint differs; executed-proof=${have} executable=${exec})`);
      }
      out.new_metrics = { tokens: tokensOf(dest.node, dest.sf).length, db_refs: df.db, branches: branches(df), calls: df.calls.length };
    }
    push();
  }
  const table = (rs, sf) => rs.map((r) => ({ key: r.key, mw: middlewareText(r, sf, deny) }));
  const tOld = table(oldRoutes, old.sf), tCur = table(curRoutes, cur.sf);
  const order = canon(tOld.map((r) => r.key)) === canon(tCur.map((r) => r.key));
  const mwDiffs = tOld.filter((r, i) => tCur[i] && canon(r.mw) !== canon(tCur[i].mw)).map((r) => r.key);
  if (!order) violations.push(`route table: set/order of registered routes differs from the pre-extraction baseline in ${tag} (Express order is behavior)`);
  for (const k of mwDiffs) violations.push(`${k}: middleware chain (auth/ownership/credit) differs from the pre-extraction baseline`);
  const ownerSecTxt = rd(overlay, OWNER_SECURITY[0]); const ownerSecExports = ownerSecTxt ? exportedNames(ownerSecTxt, OWNER_SECURITY[0]) : new Set();
  const gateNames = new Set(); for (const r of curRoutes) for (const m of r.middleware) (function w(n) { if (ts.isIdentifier(n) && (/^require\w*Ownership$/.test(n.text) || /^deny\w+$/.test(n.text))) gateNames.add(n.text); ts.forEachChild(n, w); })(m);
  const secDelegates = [...impMap.entries()].filter(([, v]) => v.spec === OWNERSHIP_SPEC).map(([local, v]) => v.imported);
  const ownership_gates = [...new Set([...gateNames, ...secDelegates.filter((n) => /^can[A-Z]|^authorize/.test(n))])].map((n) => { const im = impMap.get(n); return { gate: n, imported_from: im?.spec ?? null, exported_by_owner: ownerSecExports.has(im?.imported ?? n) }; });
  for (const g of ownership_gates) if (g.imported_from !== OWNERSHIP_SPEC || !g.exported_by_owner) violations.push(`ownership/authorization gate ${g.gate} does not come from vault/security/game-ownership (from=${g.imported_from}, owner exports=${g.exported_by_owner})`);
  if (!overlay.size && route.gate && !ownership_gates.some((g) => g.gate === route.gate)) violations.push(`${tag}: expected ownership gate ${route.gate} on the route`);
  if (!overlay.size && !route.gate && !ownership_gates.some((g) => g.gate === "canCancelGameListing")) violations.push(`${tag}: expected the seller-or-admin cancel decision to be imported from vault/security (canCancelGameListing)`);
  const compatGone = !cur.syms.some((s) => s.kind === "export-decl") && !/export\s*\{/.test(curText);
  if (!compatGone) violations.push(`compat re-export still present on ${route.file}`);
  const ca = analyze([cur.sf], cur.sf), oa = analyze([old.sf], old.sf);
  const metrics = { baseline_lines: oldText.split("\n").length, current_lines: curText.split("\n").length, baseline_db_refs: oa.db, current_db_refs: ca.db, baseline_sql_literals: sqlLiterals(old.sf).size, current_sql_literals: sqlLiterals(cur.sf).size, baseline_branches: branches(oa), current_branches: branches(ca), baseline_crypto_calls: oa.crypto.length, current_crypto_calls: ca.crypto.length, baseline_tokens: tokensOf(old.sf, old.sf).length, current_tokens: tokensOf(cur.sf, cur.sf).length };
  return { violations, dispositions, thin, ownership_gates, imports: importRows, route_table: { baseline: tOld, current: tCur, same_order: order, middleware_diffs: mwDiffs, routes_baseline: oldRoutes.length, routes_current: curRoutes.length }, compat_reexport_removed: compatGone, metrics, symbols: old.syms.map((b) => ({ symbol: b.key, kind: b.kind, lines: [b.start, b.end], baseline_fingerprint: fp(b.node, old.sf), disposition: dispositions.find((d) => d.symbol === b.key)?.disposition })), sha256: { baseline: sha256(oldText), current: sha256(curText) } };
}
function thinCheck(sym, sf, impMap) {
  const v = []; const h = sym.handler;
  if (!h || !(ts.isArrowFunction(h) || ts.isFunctionExpression(h)) || !h.body || !ts.isBlock(h.body)) return { thin: false, violations: ["handler is not an inline block function"], metrics: null, use_case: null, security_delegates: [] };
  const stmts = [...h.body.statements]; const mapper = stmts.filter((s) => isMapperStmt(s, sf)); const rest = stmts.filter((s) => !isMapperStmt(s, sf));
  // callbacks handed to the use-case are validated separately (auth-context construction), not by the generic rules
  const cbs = []; for (const s of rest) (function w(n) { if (ts.isCallExpression(n)) for (const a of n.arguments) if (ts.isArrowFunction(a) || ts.isFunctionExpression(a)) cbs.push(a); ts.forEachChild(n, w); })(s);
  const fe = analyze(rest, sf, new Set(cbs)); let delegates = 0; let useCase = null; const bad = []; const secDelegates = [];
  if (fe.db) v.push(`database access (${fe.db} refs)`);
  if (fe.tables.length) v.push(`table reference: ${[...new Set(fe.tables)].join(",")}`);
  if (fe.sql.length) v.push(`SQL literal in route (${fe.sql.length})`);
  if (fe.fetchLike.length) v.push(`provider/network call: ${[...new Set(fe.fetchLike)].join(",")}`);
  if (fe.crypto.length) v.push(`crypto call: ${[...new Set(fe.crypto)].join(",")}`);
  for (const k of ["ternary", "switch", "loop", "try", "catch", "throw", "&&", "||", "??", "optional-chain", "if"]) if (fe.control[k]) v.push(`decision/flow construct: ${k} x${fe.control[k]}`);
  if (mapper.length !== 1) v.push(`handler must end with exactly one canonical response mapping (found ${mapper.length})`);
  else if (stmts[stmts.length - 1] !== mapper[0]) v.push("response mapping is not the final statement");
  if (rest.length !== 1) v.push(`handler has ${rest.length} non-mapping statements (max 1: delegate to the use-case)`);
  else if (!(ts.isVariableStatement(rest[0]) && /^const out = await \w+\(/.test(norm(rest[0].getText(sf))))) v.push("the single statement is not `const out = await <use-case>(...)`");
  for (const r of fe.req) if (!REQ_ALLOWED.test(r)) v.push(`request access outside the parsing allow-list: ${r}`);
  for (const ch of fe.chains) {
    if (ch.length !== 1) { bad.push(ch.join(".")); continue; }
    const imp = impMap.get(ch[0]);
    if (imp && /^\.\.\/vault\/application\//.test(imp.spec)) { delegates++; useCase ??= `${imp.spec.replace(/^\.\.\//, "artifacts/api-server/src/")}.ts#${imp.imported}`; continue; }
    bad.push(ch.join("."));
  }
  if (bad.length) v.push(`non-adapter calls: ${[...new Set(bad)].slice(0, 5).join(", ")}`);
  if (delegates !== 1) v.push(`route must delegate to exactly one vault/application use-case (found ${delegates})`);
  for (const cb of cbs) {
    if (!ts.isArrowFunction(cb) || ts.isBlock(cb.body)) { v.push("inline callback must be an expression-bodied arrow (auth-context binding only)"); continue; }
    let e = cb.body; while (ts.isParenthesizedExpression(e) || ts.isAwaitExpression(e)) e = e.expression;
    const cf = analyze([cb.body], sf);
    if (!ts.isCallExpression(e) || !ts.isIdentifier(e.expression)) { v.push("inline callback must be a single call to a vault/security decision function"); continue; }
    const imp = impMap.get(e.expression.text);
    if (!imp || imp.spec !== OWNERSHIP_SPEC) v.push(`inline callback calls ${e.expression.text}, which is not imported from vault/security/game-ownership`);
    else secDelegates.push(`${imp.spec.replace(/^\.\.\//, "artifacts/api-server/src/")}.ts#${imp.imported}`);
    if (cf.db || Object.keys(cf.control).length || cf.chains.length !== 1) v.push("inline callback does more than bind the request subject to the security decision");
    if (!e.arguments.every((a) => ts.isIdentifier(a) || (ts.isPropertyAccessExpression(a) && ts.isIdentifier(a.expression)))) v.push("inline callback arguments must be plain identifiers/properties");
  }
  for (const m of sym.middleware ?? []) (function w(n) { if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && n.body) { const mf = analyze([n.body], sf); if (mf.db || mf.calls.some((c) => !/^res\.(status|json)/.test(c)) || Object.keys(mf.control).length) v.push("inline middleware callback does more than write a response"); return; } ts.forEachChild(n, w); })(m);
  return { thin: v.length === 0, violations: v, use_case: useCase, security_delegates: secDelegates, metrics: { db_refs: fe.db, tables: new Set(fe.tables).size, sql_literals: fe.sql.length, branches: branches(fe), delegated_calls: delegates, statements: stmts.length, awaits: fe.awaits } };
}

// ── 2. Use-case ownership: every delegate target must be an exported, executable function in the right layer ───────
function useCaseProof(thin, overlay = new Map()) {
  const out = []; const bad = []; const seen = new Map();
  const targets = []; for (const t of thin) { if (t.use_case) targets.push([t.use_case, t.route, "application"]); for (const s of t.security_delegates ?? []) targets.push([s, t.route, "security"]); }
  for (const [uc, route, layer] of targets) {
    if (!seen.has(uc)) {
      const [file, sym] = uc.split("#"); const txt = rd(overlay, file); const d = txt ? findDecl(txt, file, sym) : null; const exp = txt ? exportedNames(txt, file).has(sym) : false;
      const f = d ? analyze([d.node], d.sf) : null;
      const executable = Boolean(f) && (f.db > 0 || f.calls.length > 0 || branches(f) > 0 || f.awaits > 0);
      seen.set(uc, { file, symbol: sym, layer, layer_ok: file.includes(`/vault/${layer}/`), exists: Boolean(d), exported: exp, executable, tokens: d ? tokensOf(d.node, d.sf).length : 0, branches: f ? branches(f) : 0, calls: f ? f.calls.length : 0, routes: [] });
    }
    seen.get(uc).routes.push(route);
  }
  for (const u of seen.values()) { out.push(u); if (!u.exists || !u.exported || !u.executable || !u.layer_ok) bad.push(`${u.file}#${u.symbol}: exists=${u.exists} exported=${u.exported} executable=${u.executable} layer_ok=${u.layer_ok}`); }
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
  const oldMods = OLD_ROUTES.map((r) => r.file.replace(/\.ts$/, ""));
  for (const r of files) {
    const text = rd(overlay, r); if (text === null || !/game-entries|marketplace-game/.test(text)) continue;
    for (const im of importsOfText(text, r)) {
      const isOld = oldMods.includes(im.resolved ?? "") || /(^|\/)routes\/(game-entries|marketplace-game)$/.test(im.spec);
      if (!isOld) continue;
      const e = { consumer: r, module: im.spec, symbols: im.names, kind: im.kind, line: im.line };
      const movedHit = im.names.filter((n) => moved.has(n));
      if (r === R("routes/index.ts") && im.kind === "import" && im.names.length === 1 && im.names[0] === "default") e.verdict = "router-mount";
      else if (movedHit.length) { e.verdict = "HIDDEN_BYPASS"; violations.push(`${r}:${im.line} imports moved symbol(s) ${movedHit.join(",")} from the old route module`); }
      else if (im.kind !== "import" || im.names.includes("*")) { e.verdict = "UNKNOWN_MEMBER_USE"; violations.push(`${r}:${im.line} ${im.kind} of the old route module with unknown member use`); }
      else { e.verdict = "UNEXPECTED_IMPORTER"; violations.push(`${r}:${im.line} imports ${im.names.join(",")} from the old route module (only the router mount may)`); }
      edges.push(e);
    }
  }
  if (!overlay.size) for (const r of OLD_ROUTES) if (!edges.some((e) => e.verdict === "router-mount" && e.module === `./${path.posix.basename(r.file, ".ts")}`)) violations.push(`routes/index.ts no longer mounts ${r.file} (route table would silently disappear)`);
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
function duplicateScan({ overlay = new Map(), seal, deferred }) {
  const man = JSON.parse(seal.manText).files;
  const baseFps = new Map();
  for (const r of OLD_ROUTES) {
    const oldSf = scanTop(fs.readFileSync(r.baseline, "utf8"), `baseline/${r.file}`);
    for (const s of oldSf.syms) {
      if (s.kind === "function" || (s.kind === "const" && s.decl.initializer && (ts.isArrowFunction(s.decl.initializer) || ts.isFunctionExpression(s.decl.initializer)))) for (const x of fnFingerprints(oldSf.sf, 12).filter((y) => y.name === s.key)) baseFps.set(x.fp, `baseline#${s.key}`);
      if (s.kind === "route" && s.handler?.body && ts.isBlock(s.handler.body)) { const t = tokensOf(s.handler.body, oldSf.sf); if (t.length >= 20) baseFps.set(sha256(t.join(" ")), `baseline#${r.id}:${s.key}`); }
    }
  }
  const ownerFps = new Map(); const ownerDup = []; const ownerSql = new Set();
  for (const f of OWNER_FILES) { const txt = rd(overlay, f); if (!txt) continue; const sf = parse(f, txt); for (const x of fnFingerprints(sf, 12)) { if (ownerFps.has(x.fp) && ownerFps.get(x.fp).split("#")[0] !== f) ownerDup.push({ a: ownerFps.get(x.fp), b: `${f}#${x.name}` }); else ownerFps.set(x.fp, `${f}#${x.name}`); } if (OWNER_INFRA.includes(f)) for (const s of sqlLiterals(sf)) ownerSql.add(collapse(s)); }
  const scan = [...new Set([...allSourceFiles(), ...overlay.keys()])];
  const newHits = [], preExisting = [], sqlNew = [], sqlPre = [], survivors = [];
  const deferredFiles = new Map(deferred.map((d) => [d.file, d.deferred_to]));
  for (const r of scan) {
    if (OWNER_FILES.includes(r)) continue;
    const text = rd(overlay, r); if (!text) continue;
    const untouched = !overlay.has(r) && man[r] !== undefined && man[r] === sha256(text);
    if (/\bfunction\b|=>|SELECT|INSERT|UPDATE|DELETE/i.test(text)) {
      const sf = parse(r, text);
      for (const x of fnFingerprints(sf, 12)) {
        const hit = baseFps.get(x.fp) ?? ownerFps.get(x.fp);
        if (hit) (untouched ? preExisting : newHits).push({ file: r, symbol: x.name, duplicates: hit, tokens: x.tokens, ...(untouched ? { reason: "file unchanged since the 04-C seal; pre-dates GAP-04 (independent idiom, reported to GAP-16)" } : {}) });
      }
      for (const s of sqlLiterals(sf)) if (ownerSql.has(collapse(s))) { const row = { file: r, sql: s.slice(0, 100), deferred_to: deferredFiles.get(r) ?? null }; (untouched ? sqlPre : sqlNew).push(row); }
    }
  }
  for (const r of OLD_ROUTES) {
    const curTxt = rd(overlay, r.file); const cur = scanTop(curTxt, r.file);
    for (const s of cur.syms) if (s.kind === "route" && s.handler?.body && ts.isBlock(s.handler.body)) { const t = tokensOf(s.handler.body, cur.sf); if (t.length >= 20 && baseFps.has(sha256(t.join(" ")))) survivors.push({ file: r.file, route: s.key, same_as: baseFps.get(sha256(t.join(" "))) }); }
    for (const s of cur.syms) if (s.kind === "function") for (const x of fnFingerprints(cur.sf, 12).filter((y) => y.name === s.key)) if (baseFps.has(x.fp)) survivors.push({ file: r.file, symbol: s.key, same_as: baseFps.get(x.fp) });
  }
  return { newHits, preExisting, sqlNew, sqlPre, survivors, ownerDup, owner_functions_fingerprinted: ownerFps.size, baseline_fingerprints: baseFps.size, owner_sql_statements: ownerSql.size };
}

// ── 5. Layering of the owner modules ────────────────────────────────────────────────────────────────────────────────
function layeringScan(overlay = new Map()) {
  const v = []; const notes = [];
  for (const f of OWNER_FILES) {
    const txt = rd(overlay, f); if (txt === null) { v.push(`${f}: owner file missing`); continue; }
    const sf = parse(f, txt); const ims = importsOfText(txt, f); const layer = f.split("/")[4];
    const clean = txt.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const im of ims) {
      const target = im.resolved ?? im.spec;
      if (/(^|\/)routes(\/|$)/.test(target)) v.push(`${f}:${im.line} ${layer} layer imports the API route layer (${im.spec})`);
      if (layer === "domain" && (im.spec === "@workspace/db" || im.spec === "drizzle-orm" || /infrastructure|application|security|\/lib\/|\/services\//.test(im.spec))) v.push(`${f}:${im.line} domain layer imports ${im.spec}`);
      if ((layer === "application" || layer === "security") && (im.spec === "@workspace/db" || im.spec === "drizzle-orm")) v.push(`${f}:${im.line} ${layer} layer accesses the database directly (${im.spec}); persistence belongs to infrastructure/repositories`);
      if (["application", "infrastructure", "domain"].includes(layer) && im.spec === "express" && !/import\s+type[^;]*from\s+["']express["']/.test(txt)) v.push(`${f}:${im.line} runtime import of express in ${layer} layer`);
      if (layer === "infrastructure" && /\/application\//.test(target)) v.push(`${f}:${im.line} infrastructure imports the application layer`);
    }
    if (!["domain", "application", "infrastructure", "security"].includes(layer)) v.push(`${f}: cannot determine vault layer (got '${layer}'); layer rules would be skipped`);
    if (layer === "application" && /\b(req|res)\b\s*[.:,)]/.test(clean)) v.push(`${f}: application layer references Express req/res identifiers`);
    if (layer === "application") { const a = analyze([sf], sf); if (a.sql.length) v.push(`${f}: application layer contains SQL (${a.sql.length})`); }
    if (layer === "security") { const a = analyze([sf], sf); if (a.db) notes.push(`${f}: security layer resolves ownership through the database (${a.db} refs) — permitted PEP resource resolver`); }
  }
  return { violations: v, notes };
}

// ── 6. Frontend disposition ─────────────────────────────────────────────────────────────────────────────────────────
function frontendGate({ overlay = new Map(), routeKeys, manifest }) {
  const violations = []; const files = [];
  const routeRegex = routeKeys.map((k) => ({ method: k.split(" ")[0], re: new RegExp(`^${k.slice(k.indexOf(" ") + 1).replace(/:[^/]+/g, "[^/]+")}$`) }));
  const resolves = (method, probes) => probes.some((p) => routeRegex.some((r) => r.method === method && r.re.test(p)));
  for (const fe of FRONTEND) {
    const text = rd(overlay, fe.file); const bp = baselineCopy(fe.file); const baseText = fs.existsSync(bp) ? fs.readFileSync(bp, "utf8") : null;
    const rec = { file: fe.file, kind: fe.kind, sha256: sha256(text ?? ""), baseline_sha256: baseText ? sha256(baseText) : null, unchanged_since_pre_extraction_baseline: baseText !== null && text === baseText };
    if (baseText === null) { violations.push(`${fe.file}: pre-extraction baseline copy missing`); files.push(rec); continue; }
    if (text !== baseText) violations.push(`${fe.file}: modified since the pre-extraction baseline (GAP-04 API extraction must not alter the UI source)`);
    const { sf, syms } = scanTop(text, fe.file); const a = analyze([sf], sf);
    if (a.db) violations.push(`${fe.file}: database access identifier(s) in a UI file (${a.db})`);
    if (a.sql.length) violations.push(`${fe.file}: SQL literal(s) in a UI file`);
    if (a.crypto.length) violations.push(`${fe.file}: crypto call in a UI file (${[...new Set(a.crypto)].join(",")})`);
    const rawFetch = []; (function w(n) { if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && ["fetch", "axios", "XMLHttpRequest"].includes(n.expression.text)) rawFetch.push(n); ts.forEachChild(n, w); })(sf);
    for (const n of rawFetch) violations.push(`${fe.file}:${lineOf(sf, n.getStart(sf))} direct provider/network call ${n.expression.text}() (only customFetch to the public API is permitted)`);
    if (a.fetchLike.length) violations.push(`${fe.file}: provider/network identifier(s) ${[...new Set(a.fetchLike)].join(",")}`);
    rec.metrics = { lines: text.split("\n").length, db_refs: a.db, sql_literals: a.sql.length, crypto_calls: a.crypto.length };
    const endpoints = [];
    (function w(n) {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "customFetch" && n.arguments[0]) {
        const a0 = n.arguments[0]; let p = null; let tail = false;
        if (ts.isStringLiteralLike(a0)) p = a0.text;
        else if (ts.isTemplateExpression(a0)) { p = a0.head.text + a0.templateSpans.map((s) => "\u0000" + s.literal.text).join(""); tail = a0.templateSpans.length > 0 && a0.templateSpans[a0.templateSpans.length - 1].literal.text === ""; }
        let method = "GET"; const a1 = n.arguments[1];
        if (a1 && ts.isObjectLiteralExpression(a1)) for (const pr of a1.properties) if (ts.isPropertyAssignment(pr) && pr.name.getText(sf) === "method" && ts.isStringLiteralLike(pr.initializer)) method = pr.initializer.text.toUpperCase();
        if (p !== null) { const base = p.replace(/^\/api/, ""); const probes = [base.replace(/\u0000/g, "1")]; if (tail) probes.push(base.replace(/\u0000$/, "")); endpoints.push({ method, path: p.replace(/\u0000/g, "${}"), line: lineOf(sf, n.getStart(sf)), probes }); }
      }
      ts.forEachChild(n, w);
    })(sf);
    const isGame = (e) => /^\/game-entries/.test(e.probes[0]);
    for (const e of endpoints) if (isGame(e) && !resolves(e.method, e.probes)) violations.push(`${fe.file}:${e.line} calls ${e.method} ${e.path}, which is not a registered Game route`);
    rec.api_calls = endpoints.map((e) => ({ method: e.method, path: e.path, line: e.line, game_endpoint: isGame(e), resolves_to_registered_route: isGame(e) ? resolves(e.method, e.probes) : null }));
    const residual = [];
    for (const s of syms) {
      const f = analyze([s.node], sf); const base = { symbol: s.key, lines: [s.start, s.end] };
      if (s.kind === "type") residual.push({ ...base, disposition: "TYPE_CONTRACT_SHAPE" });
      else if (s.kind === "export-default" || s.kind === "export-decl") residual.push({ ...base, disposition: "MODULE_EXPORT_WIRING" });
      else if (s.kind !== "function" && s.kind !== "const") { residual.push({ ...base, disposition: "UNCLASSIFIED" }); violations.push(`${fe.file}:${s.start} unclassified top-level ${s.kind}`); }
      else if (s.kind === "function" && /^use[A-Z]/.test(s.key)) residual.push({ ...base, disposition: "UI_ADAPTER_HOOK", api_calls: f.calls.filter((c) => c === "customFetch").length, db_refs: f.db });
      else if (s.kind === "function" && /^[A-Z]/.test(s.key)) residual.push({ ...base, disposition: "UI_ADAPTER", api_calls: f.calls.filter((c) => c === "customFetch").length, branches: branches(f), db_refs: f.db });
      else if (s.key === "rowToForm") { const ok = f.calls.every((c) => /^Array\.isArray$/.test(c)) && f.db === 0 && !f.calls.includes("customFetch"); residual.push({ ...base, disposition: ok ? "COMPAT_MAPPING_API_TO_FORM" : "LOGIC" }); if (!ok) violations.push(`${fe.file}: rowToForm performs more than compatibility mapping`); }
      else if (s.kind === "const" && UI_CONFIG.has(s.key)) { const ok = f.db === 0 && !f.calls.includes("customFetch") && f.fetchLike.length === 0; residual.push({ ...base, disposition: ok ? "UI_CONFIG_DATA" : "LOGIC" }); if (!ok) violations.push(`${fe.file}: ${s.key} performs data access`); }
      else { residual.push({ ...base, disposition: "UNCLASSIFIED" }); violations.push(`${fe.file}:${s.start} unclassified symbol ${s.key}`); }
    }
    rec.symbols = residual; rec.disposition = "UI_ADAPTER";
    files.push(rec);
  }
  // Game-related UI files outside the roadmap's source list: must be unchanged since the seal (no UI source was touched by GAP-04)
  const related = RELATED_UI.map((f) => { const t = rd(overlay, f); const same = manifest && t !== null && manifest[f] === sha256(t); if (!same) violations.push(`${f}: Game-related UI file changed since the 04-C seal or missing`); return { file: f, unchanged_since_04C_seal: Boolean(same) }; });
  return { violations, files, related };
}

// ── 7. Executed prerequisites ───────────────────────────────────────────────────────────────────────────────────────
function runNode(script, cwd, args = []) { const r = spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8", env: process.env, timeout: 900000 }); return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` }; }
const copyTree = (dst) => fs.cpSync(ROOT, dst, { recursive: true, filter: (s) => !/(^|\/)(node_modules|\.git)(\/|$)/.test(s) });
const dropOwnScripts = (dst) => { for (const f of ALLOWED_GAP_FILES_ADDED) fs.rmSync(path.join(dst, f), { force: true }); };
function runPrerequisites(sealData) {
  const commands = []; const exit_codes = {};
  const frozenDir = path.join(SEAL_DIR, "frozen");
  const restore04C = (dst) => { for (const [name, v] of Object.entries(sealData.seal.frozen_files)) { const src = path.join(frozenDir, name); if (sha256File(src) !== v.sha256) throw new Error(`sealed frozen file ${name} was edited`); fs.copyFileSync(src, path.join(dst, v.source)); } };
  // 04-C: (1) --verify in place (its evidence is bound only to files 04-D does not touch); (2) full re-execution on a temp copy reconstructed to the 04-C-certified state
  const cv = runNode(path.join(ROOT, `${GAP}validate-vlt-gap-04-C.mjs`), ROOT, ["--verify"]); commands.push("node scripts/antas/vault/gap/validate-vlt-gap-04-C.mjs --verify (in place)"); exit_codes["04-C(verify,in-place)"] = cv.status;
  let c = { status: null, out: "" }; let cGraph = null; let tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vlt-gap-04d-c-"));
  try {
    copyTree(tmp); dropOwnScripts(tmp); restore04C(tmp);
    c = runNode(path.join(tmp, `${GAP}validate-vlt-gap-04-C.mjs`), tmp); commands.push("node scripts/antas/vault/gap/validate-vlt-gap-04-C.mjs (full run, temp copy reconstructed to the 04-C-certified state)"); exit_codes["04-C(temp,reconstructed)"] = c.status;
    const p = path.join(tmp, "reports/antas/vault/gap/VLT-GAP-04/consumer-graph.json"); cGraph = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  // 04-B: 04-C legitimately added listing.ts and changed marketplace-vault.ts + game-repository.ts, which 04-B's diff audit and SQL/usage
  // checks correctly reject on the current tree. It is therefore executed on a temp copy reconstructed to the 04-B-certified bytes.
  const sealC = JSON.parse(fs.readFileSync(path.join(EVID, "baseline-04c/SEAL.json"), "utf8"));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vlt-gap-04d-b-"));
  let b = { status: null, out: "" }; let bEv = null; const restored = [];
  try {
    copyTree(tmp); dropOwnScripts(tmp);
    // The two files 04-D itself edited are deliberately KEPT at their current bytes, so 04-B's differential (frozen OLD routes vs
    // new tree) executes against the post-04-D cancel route and security module; everything 04-C touched is restored.
    const KEEP = new Set(Object.values(sealData.seal.frozen_files).map((v) => v.source));
    for (const [name, v] of Object.entries(sealC.frozen_consumers)) { const src = path.join(EVID, "baseline-04c/consumers", name); if (sha256File(src) !== v.sha256) throw new Error(`sealed frozen consumer ${name} was edited`); if (KEEP.has(v.source)) continue; fs.copyFileSync(src, path.join(tmp, v.source)); restored.push(v.source); }
    fs.rmSync(path.join(tmp, R("vault/application/game/listing.ts")), { force: true });
    b = runNode(path.join(tmp, `${GAP}validate-vlt-gap-04-B.mjs`), tmp); commands.push("node scripts/antas/vault/gap/validate-vlt-gap-04-B.mjs (temp copy reconstructed to the 04-B-certified state)"); exit_codes["04-B(temp,reconstructed)"] = b.status;
    const p = path.join(tmp, "reports/antas/vault/gap/VLT-GAP-04/extraction-proof.json"); bEv = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  return { commands, exit_codes, cv, c, cGraph, b, bEv, restored, sealC };
}
function prerequisiteChecks(pre, chk) {
  chk("prerequisite:04-C-evidence-verifies-in-place", pre.cv.status === 0, pre.cv.out.slice(-200));
  chk("prerequisite:04-C-re-executed-and-passed (consumer rewire, differential vs sealed 04-B route, mutation tests)", pre.c.status === 0 && pre.cGraph?.status === "PASS", pre.c.out.slice(-300));
  chk("prerequisite:04-C-census-has-no-unclassified-table-access", pre.cGraph && !pre.cGraph.table_access_census.some((x) => x.kind === "UNCLASSIFIED"), "");
  chk("prerequisite:04-C-deferrals-all-name-a-later-gap", pre.cGraph && (pre.cGraph.deferred_consumers ?? []).length > 0 && (pre.cGraph.deferred_consumers ?? []).every((d) => LATER_GAP.test(d.deferred_to)), (pre.cGraph?.deferred_consumers ?? []).map((d) => d.deferred_to).join(","));
  const ev = pre.bEv; const failing = ev ? ev.checks.filter((x) => !x.passed) : [{ name: "<no evidence>", details: "" }];
  chk("prerequisite:04-B-executed-on-the-04-B-certified-tree-and-every-check-passes", Boolean(ev) && ev.sub_phase === "VLT-GAP-04-B" && ev.status === "PASS" && failing.length === 0 && pre.b.status === 0 && pre.restored.length === Object.keys(pre.sealC.frozen_consumers ?? {}).length - 2 && pre.restored.length >= 5, failing.map((x) => x.name).join(", ") || pre.b.out.slice(-200));
  const t = ev?.tests ?? {};
  chk("prerequisite:04-B-differential-59-cases-all-identical (frozen OLD routes vs extracted tree, no skips)", t.differential_cases >= 59 && t.differential_passed === t.differential_cases, canon(t));
  chk("prerequisite:04-B-security-unit-and-mutation-suites-complete", t.security_checks >= 20 && t.security_passed === t.security_checks && t.unit_parity >= 3 && t.unit_passed === t.unit_parity && t.mutations_seeded >= 22 && t.mutations_detected === t.mutations_seeded, canon(t));
  const unit = new Map((ev?.checks ?? []).map((x) => [x.name, x.passed]));
  return { failing: failing.map((x) => x.name), unit };
}

// ── 8. Degraded differential typecheck ──────────────────────────────────────────────────────────────────────────────
function typecheck() {
  const cfgRaw = ts.readConfigFile(path.join(ROOT, "tsconfig.base.json"), ts.sys.readFile).config?.compilerOptions ?? {};
  const opts = ts.convertCompilerOptionsFromJson({ ...cfgRaw, noEmit: true, skipLibCheck: true, types: [], incremental: false, composite: false, baseUrl: ROOT }, ROOT).options;
  const routes = OLD_ROUTES.map((r) => path.join(ROOT, r.file)); const baseOf = new Map(OLD_ROUTES.map((r) => [path.join(ROOT, r.file), r.baseline]));
  const ownerAbs = OWNER_FILES.map((f) => path.join(ROOT, f)); const scope = [...routes, ...ownerAbs];
  const run = (useBaseline) => {
    const host = ts.createCompilerHost(opts); const rf = host.readFile.bind(host), gs = host.getSourceFile.bind(host);
    const ov = (f) => (useBaseline ? baseOf.get(f) : undefined);
    host.readFile = (f) => rf(ov(f) ?? f);
    host.getSourceFile = (f, lv, ...r) => { const o = ov(f); return o ? ts.createSourceFile(f, fs.readFileSync(o, "utf8"), lv, true) : gs(f, lv, ...r); };
    const roots = useBaseline ? routes : scope; const prog = ts.createProgram(roots, opts, host); const tally = {}; const syntactic = [];
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
  const E = OLD_ROUTES[0], M = OLD_ROUTES[1]; const ov = (rp, txt) => new Map([[rp, txt]]);
  const curE = readF(E.file), curM = readF(M.file);
  const mut = (cur, re, repl) => { const m = cur.replace(re, repl); return m === cur ? null : m; };
  const gate = (route, overlay) => routeGate({ route, overlay, unit: ctx.unit }).violations;
  const hasV = (route, overlay, re) => gate(route, overlay).some((v) => re.test(v));
  const anchor = (n, m) => t(`selftest:mutation-anchor-${n}`, m !== null);
  // (a) DB query smuggled into a thin route
  let m = mut(curE, /(router\.get\("\/game-entries", requireAuth, async \(req, res\): Promise<void> => \{\n)/, "$1  await db.execute(sql`SELECT 1`);\n"); anchor("a1", m);
  if (m) t("selftest:db-query-in-entries-route-is-detected", hasV(E, ov(E.file, m), /GET \/game-entries.*database access/));
  m = mut(curM, /(router\.get\("\/marketplace\/game\/stats", requireAuth, async \(_req, res\): Promise<void> => \{\n)/, "$1  await pool.query(\"SELECT 1\");\n"); anchor("a2", m);
  if (m) t("selftest:pool-query-in-market-route-is-detected", hasV(M, ov(M.file, m), /GET \/marketplace\/game\/stats.*database access/));
  m = mut(curE, /(router\.post\("\/game-entries", requireAuth, async \(req, res\): Promise<void> => \{\n)/, "$1  const pw = encryptField(req.body.accountPassword);\n"); anchor("a3", m);
  if (m) t("selftest:crypto-call-in-route-is-detected", hasV(E, ov(E.file, m), /POST \/game-entries.*crypto call/));
  m = mut(curM, /(router\.post\("\/marketplace\/game\/buy", requireAuth, async \(req, res\): Promise<void> => \{\n)/, "$1  const fee = Number(req.body.price) * 0.05;\n"); anchor("a4", m);
  if (m) t("selftest:fee-calculation-in-route-is-detected", hasV(M, ov(M.file, m), /POST \/marketplace\/game\/buy.*(non-mapping|non-adapter|statements)/));
  // (b) decision trees
  m = mut(curE, /(router\.post\("\/game-entries", requireAuth, async \(req, res\): Promise<void> => \{\n)/, "$1  const q = req.body.category ? 1 : 2;\n"); anchor("b1", m);
  if (m) t("selftest:ternary-in-route-is-detected", hasV(E, ov(E.file, m), /POST \/game-entries.*(ternary|non-mapping)/));
  m = mut(curE, /(router\.put\("\/game-entries\/:id"[^\n]*=> \{\n)/, "$1  if (!req.body) { res.status(400).json({}); return; }\n"); anchor("b2", m);
  if (m) t("selftest:if-branch-in-route-is-detected", hasV(E, ov(E.file, m), /PUT \/game-entries\/:id.*(decision|non-mapping)/));
  m = mut(curM, /(router\.get\("\/marketplace\/game\/listings", requireAuth, async \(req, res\): Promise<void> => \{\n)/, "$1  try { await Promise.resolve(); } catch { return; }\n"); anchor("b3", m);
  if (m) t("selftest:try-catch-in-route-is-detected", hasV(M, ov(M.file, m), /GET \/marketplace\/game\/listings.*(try|catch|non-mapping)/));
  // (c) response mapping
  m = mut(curE, /res\.status\(out\.status\)\.json\(out\.body\);/, "res.status(500).json(out.body);"); anchor("c1", m);
  if (m) t("selftest:altered-response-mapping-is-detected", hasV(E, ov(E.file, m), /canonical response mapping/));
  m = mut(curM, /res\.status\(out\.status\)\.json\(out\.body\);/, "res.json(out.body);"); anchor("c2", m);
  if (m) t("selftest:non-canonical-response-mapping-is-detected", hasV(M, ov(M.file, m), /canonical response mapping/));
  // (d) moved helper re-declared in an old file
  t("selftest:redeclared-moved-symbol-is-detected", hasV(E, ov(E.file, `${curE}\nconst safe = (v: unknown) => v;\n`), /top-level|still declared/));
  t("selftest:redeclared-policy-engine-is-detected", hasV(M, ov(M.file, `${curM}\nconst gameListingOwnerOrAdminEngine = {};\n`), /top-level|still declared/));
  // (e) forbidden imports
  m = mut(curE, /(import \{ Router \} from "express";\n)/, '$1import { db } from "@workspace/db";\n'); anchor("e1", m);
  if (m) t("selftest:db-import-in-route-is-detected", hasV(E, ov(E.file, m), /@workspace\/db/));
  m = mut(curM, /(import \{ Router \} from "express";\n)/, '$1import { getMarketConfig } from "../lib/market-config";\n'); anchor("e2", m);
  if (m) t("selftest:market-config-import-in-route-is-detected", hasV(M, ov(M.file, m), /market-config/));
  // (f) ownership middleware
  m = mut(curE, /requireAuth, requireGameEntryOwnership\("game_entry\.delete", denyGameEntrySilentSuccess\), /, "requireAuth, "); anchor("f1", m);
  if (m) t("selftest:dropped-ownership-middleware-is-detected", hasV(E, ov(E.file, m), /DELETE \/game-entries\/:id.*middleware chain/));
  m = mut(curE, /requireGameEntryOwnership\("game_entry\.delete", denyGameEntrySilentSuccess\)/, 'requireGameEntryOwnership("game_entry.delete", denyGameEntryNotFound)'); anchor("f2", m);
  if (m) t("selftest:changed-deny-behavior-on-delete-is-detected", hasV(E, ov(E.file, m), /DELETE \/game-entries\/:id.*middleware chain/));
  m = mut(curE, /requireGameEntryOwnership\("game_entry\.delete", denyGameEntrySilentSuccess\)/, 'requireGameEntryOwnership("game_entry.delete", denyMystery)'); anchor("f3", m);
  if (m) t("selftest:unresolvable-deny-handler-is-detected", hasV(E, ov(E.file, m), /DELETE \/game-entries\/:id.*middleware chain/));
  m = mut(curE, /requireCreditBalance\("sylo\.game_entry_view"\)/, 'requireCreditBalance("sylo.other")'); anchor("f4", m);
  if (m) t("selftest:changed-credit-middleware-is-detected", hasV(E, ov(E.file, m), /GET \/game-entries\/:id.*middleware chain/));
  m = mut(curE, /requireGameEntryOwnership\("game_entry\.update"/, 'requireGameEntryOwnership("game_entry.read"'); anchor("f5", m);
  if (m) t("selftest:changed-ownership-action-is-detected", hasV(E, ov(E.file, m), /PUT \/game-entries\/:id.*middleware chain/));
  // (g) route reorder
  { const a = curE.indexOf('router.get("/game-entries", requireAuth'), b = curE.indexOf('router.post("/game-entries", requireAuth'); anchor("g", a > 0 && b > a ? "ok" : null);
    if (a > 0 && b > a) { const blockA = curE.slice(a, curE.indexOf("\n});\n", a) + 5), blockB = curE.slice(b, curE.indexOf("\n});\n", b) + 5); const sw = curE.replace(blockA, "\u0001").replace(blockB, blockA).replace("\u0001", blockB); t("selftest:route-reorder-is-detected", hasV(E, ov(E.file, sw), /route table: set\/order/)); } }
  // (h) compat re-export restored
  t("selftest:compat-reexport-restored-is-detected", hasV(E, ov(E.file, curE.replace(/export default router;/, 'export { requireGameEntryOwnership } from "../vault/security/game-ownership";\nexport default router;')), /compat re-export|top-level/));
  // (i) hollowed-out use-cases (scaffold-only destination)
  for (const [n, f, fn] of [["i1", OWNER_APP[0], "listGameEntries"], ["i2", OWNER_APP[1], "buyGameMarketListing"], ["i3", OWNER_APP[1], "cancelGameMarketListing"]]) {
    const txt = readF(f); const hollow = txt.replace(new RegExp(`export async function ${fn}\\b[\\s\\S]*?\\n\\}\\n`), `export async function ${fn}(..._a: unknown[]): Promise<any> { return { status: 200, body: [] }; }\n`);
    t(`selftest:mutation-anchor-${n}`, hollow !== txt); t(`selftest:scaffold-only-use-case-${fn}-is-detected`, useCaseProof(ctx.thin, ov(f, hollow)).violations.some((v) => new RegExp(fn).test(v)));
  }
  { const f = OWNER_SECURITY[0]; const txt = readF(f); const hollow = txt.replace(/export async function canCancelGameListing\b[\s\S]*?\n\}\n/, "export async function canCancelGameListing(..._a: unknown[]): Promise<boolean> { return true; }\n");
    t("selftest:mutation-anchor-i4", hollow !== txt); t("selftest:scaffold-only-security-decision-is-detected", useCaseProof(ctx.thin, ov(f, hollow)).violations.some((v) => /canCancelGameListing/.test(v))); }
  // (j) hidden imports of the old route modules
  t("selftest:hidden-import-of-moved-symbol-is-detected", hiddenImportScan({ overlay: ov(R("routes/zz-hidden.ts"), 'import { safe } from "./game-entries";\nexport const x = safe;\n'), moved: ctx.moved }).violations.some((v) => /zz-hidden/.test(v)));
  t("selftest:compat-import-of-ownership-gate-from-old-route-is-detected", hiddenImportScan({ overlay: ov(R("routes/zz-compat.ts"), 'import { requireGameEntryOwnership } from "./game-entries";\nexport const x = requireGameEntryOwnership;\n'), moved: ctx.moved }).violations.some((v) => /zz-compat/.test(v)));
  t("selftest:dynamic-import-of-old-route-is-detected", hiddenImportScan({ overlay: ov(R("routes/zz-dyn.ts"), 'export async function f() { return import("./marketplace-game"); }\n'), moved: ctx.moved }).violations.some((v) => /zz-dyn/.test(v)));
  // (k) copied implementation outside vault/ (renamed to defeat name matching)
  { const own = readF(OWNER_APP[1]).replace(/\bparseListing\b/g, "someOtherName"); t("selftest:renamed-copy-outside-vault-is-detected", duplicateScan({ overlay: ov(R("routes/zz-copy.ts"), own), seal: ctx.seal, deferred: ctx.deferred }).newHits.some((h) => h.file.endsWith("zz-copy.ts"))); }
  { const own = readF(OWNER_INFRA[0]).replace(/\bensureGameWallet\b/g, "walletThing"); t("selftest:renamed-repository-copy-outside-vault-is-detected", duplicateScan({ overlay: ov(R("routes/zz-copy2.ts"), own), seal: ctx.seal, deferred: ctx.deferred }).newHits.some((h) => h.file.endsWith("zz-copy2.ts"))); }
  // (l) persistence statement pasted outside the repository
  { const one = [...sqlLiterals(parse("r.ts", readF(OWNER_INFRA[0])))].find((s) => /game_market_listings SET status='cancelled'/.test(s)); t("selftest:mutation-anchor-l", Boolean(one));
    if (one) t("selftest:moved-sql-pasted-outside-repository-is-detected", duplicateScan({ overlay: ov(R("routes/zz-sql.ts"), `export const q = \`${one.replace(/\$\{\}/g, "${x}")}\`;\n`), seal: ctx.seal, deferred: ctx.deferred }).sqlNew.some((h) => h.file.endsWith("zz-sql.ts"))); }
  // (m) layer rules are live
  { const f = OWNER_APP[0]; const txt = readF(f);
    t("selftest:application-importing-routes-is-detected", layeringScan(ov(f, `import { x } from "../../../routes/events";\n${txt}`)).violations.some((v) => /API route layer/.test(v)));
    t("selftest:application-importing-db-is-detected", layeringScan(ov(f, `import { db } from "@workspace/db";\n${txt}`)).violations.some((v) => /database directly/.test(v)));
    t("selftest:express-runtime-import-in-application-is-detected", layeringScan(ov(f, `import express from "express";\n${txt}`)).violations.some((v) => /runtime import of express/.test(v)));
    t("selftest:req-res-in-application-is-detected", layeringScan(ov(f, `${txt}\nexport function bad(req: any, res: any) { return res.json(req.body); }\n`)).violations.some((v) => /req\/res identifiers/.test(v)));
    t("selftest:sql-in-application-is-detected", layeringScan(ov(f, `${txt}\nexport const q = "SELECT * FROM game_entries WHERE id = 1";\n`)).violations.some((v) => /contains SQL/.test(v)));
    const dom = OWNER_DOMAIN[0]; t("selftest:domain-importing-db-is-detected", layeringScan(ov(dom, `import { db } from "@workspace/db";\n${readF(dom)}`)).violations.some((v) => /domain layer imports/.test(v)));
    const inf = OWNER_INFRA[0]; t("selftest:infrastructure-importing-application-is-detected", layeringScan(ov(inf, `import { x } from "../../application/game/entries";\n${readF(inf)}`)).violations.some((v) => /infrastructure imports the application layer/.test(v)));
    const sec = OWNER_SECURITY[0]; t("selftest:security-importing-db-directly-is-detected", layeringScan(ov(sec, `import { db } from "@workspace/db";\n${readF(sec)}`)).violations.some((v) => /security layer accesses the database directly/.test(v))); }
  // (n) frontend
  { const f = FRONTEND[0].file; const txt = readF(f); const fg = (file, s) => frontendGate({ overlay: ov(file, s), routeKeys: ctx.routeKeys, manifest: ctx.manifest }).violations;
    t("selftest:sql-in-component-is-detected", fg(f, txt + '\nconst q = `SELECT * FROM game_entries WHERE id = 1`;\n').some((v) => /SQL literal/.test(v)));
    t("selftest:provider-call-in-component-is-detected", fg(f, txt + '\nvoid fetch("/x");\n').some((v) => /direct provider\/network call/.test(v)));
    t("selftest:unknown-game-endpoint-in-component-is-detected", fg(f, txt + '\nvoid customFetch("/api/game-entries/nope/nope/nope", { method: "PATCH" });\n').some((v) => /not a registered Game route/.test(v)));
    t("selftest:unclassified-ui-symbol-is-detected", fg(f, txt + "\nfunction computeRank(e: any) { return e.level ? 1 : 0; }\n").some((v) => /unclassified symbol computeRank/.test(v)));
    t("selftest:modified-ui-file-is-detected", fg(f, txt + "\n// edited\n").some((v) => /modified since the pre-extraction baseline/.test(v)));
    t("selftest:modified-related-ui-file-is-detected", fg(RELATED_UI[0], readF(RELATED_UI[0]) + "\n// edited\n").some((v) => /Game-related UI file changed/.test(v))); }
  // (o) ownership / authorization gate sourced from a look-alike module
  m = mut(curE, /import \{\n  requireGameEntryOwnership, /, "import {\n  "); if (m === null) m = mut(curE, /requireGameEntryOwnership, denyGameEntryNotFound,/, "denyGameEntryNotFound,"); anchor("o1", m);
  if (m) { m = m.replace('import { requireAuth } from "../middlewares/auth";', 'import { requireAuth, requireGameEntryOwnership } from "../middlewares/auth";'); t("selftest:mutation-anchor-o2", m.includes("requireAuth, requireGameEntryOwnership }")); t("selftest:ownership-gate-from-wrong-module-is-detected", hasV(E, ov(E.file, m), /ownership\/authorization gate requireGameEntryOwnership does not come from vault\/security/)); }
  m = mut(curM, /import \{ canCancelGameListing \} from "\.\.\/vault\/security\/game-ownership";/, 'import { canCancelGameListing } from "../middlewares/auth";'); anchor("o3", m);
  if (m) t("selftest:cancel-decision-from-wrong-module-is-detected", hasV(M, ov(M.file, m), /does not come from vault\/security\/game-ownership|not imported from vault\/security/));
  // (r) authorization logic duplicated back into the adapter
  m = mut(curM, /\(id, listing\) => canCancelGameListing\(req, id, listing\.seller_id\)/, "async (id, listing) => (await canCancelGameListing(req, id, listing.seller_id)) === true"); anchor("r1", m);
  if (m) t("selftest:decision-compare-in-cancel-callback-is-detected", hasV(M, ov(M.file, m), /inline callback/));
  m = mut(curM, /\(id, listing\) => canCancelGameListing\(req, id, listing\.seller_id\)/, "(id, listing) => listing.seller_id === 1"); anchor("r2", m);
  if (m) t("selftest:inline-owner-check-in-cancel-callback-is-detected", hasV(M, ov(M.file, m), /inline callback/));
  m = mut(curM, /\(id, listing\) => canCancelGameListing\(req, id, listing\.seller_id\)/, "async (id, listing) => { return canCancelGameListing(req, id, listing.seller_id); }"); anchor("r3", m);
  if (m) t("selftest:block-bodied-callback-is-detected", hasV(M, ov(M.file, m), /expression-bodied arrow/));
  m = mut(curM, /\(id, listing\) => canCancelGameListing\(req, id, listing\.seller_id\)/, "(id, listing) => true"); anchor("r4", m);
  if (m) t("selftest:always-allow-callback-is-detected", hasV(M, ov(M.file, m), /inline callback/));
  // (p) seal tampering
  { const forged = { ...ctx.seal, manText: ctx.seal.manText.replace(/"files": \{/, '"files": { "zz": "0",') }; t("selftest:tampered-seal-manifest-is-detected", sealChecks(forged, ctx.cGraph).some((c) => c.name === "seal:tree-manifest-hash-matches-seal" && !c.passed)); }
  // (q) an unproven refactored move must not be accepted
  { const un = new Map(ctx.unit); for (const k of EXECUTED_PROOF_REQUIRED.gameEntryResource) un.set(k, false); const r = routeGate({ route: E, unit: un }); t("selftest:refactored-move-without-executed-proof-is-rejected", r.violations.some((v) => /^gameEntryResource\b.*not proven/.test(v)) && r.dispositions.find((d) => d.symbol === "gameEntryResource")?.disposition === "MOVE_UNPROVEN"); }
  // (s) a moved policy registration that is altered is rejected
  { const sec = OWNER_SECURITY[0]; const txt = readF(sec); const alt = txt.replace('createRoleOverrideRule(["admin"])', 'createRoleOverrideRule(["admin", "moderator"])'); t("selftest:mutation-anchor-s", alt !== txt); t("selftest:altered-policy-registration-is-detected", hasV(M, ov(sec, alt), /policy-engine rule registrations are not identical/)); }
  return out;
}
function bypassAttempts() {
  const out = [];
  const tries = [{ name: "flag --skip-tests", args: ["--skip-tests"], env: {} }, { name: "flag --force-pass", args: ["--force-pass"], env: {} }, { name: "flag --ignore-failures", args: ["--ignore-failures"], env: {} }, { name: "flag --continue-on-error", args: ["--continue-on-error"], env: {} }, { name: "unknown flag --whatever", args: ["--whatever"], env: {} }, { name: "env ANTAS_BYPASS=true", args: [], env: { ANTAS_BYPASS: "true" } }, { name: "env VALIDATION_DISABLED=true", args: [], env: { VALIDATION_DISABLED: "true" } }];
  for (const tr of tries) { const r = spawnSync(process.execPath, [HERE, ...tr.args], { encoding: "utf8", env: { ...process.env, ...tr.env }, timeout: 60000 }); out.push({ attempt: tr.name, exit_code: r.status, rejected: r.status === 1 && /bypass mechanism rejected/.test(r.stderr ?? "") }); }
  return out;
}

// ── main ────────────────────────────────────────────────────────────────────────────────────────────────────────────
const OLD_FILES = [...OLD_ROUTES.map((r) => r.file), ...FRONTEND.map((f) => f.file)];
function sourceHashes() {
  const files = [...OLD_FILES, ...OWNER_FILES, R("routes/index.ts"), R("routes/marketplace-vault.ts"), `${GAP}harness.mjs`, `${GAP}gap-common.mjs`, `${GAP}freeze-vlt-gap-04-D-baseline.mjs`, rel(path.join(SEAL_DIR, "SEAL.json")), rel(path.join(SEAL_DIR, "tree-manifest.json")), ...OLD_ROUTES.map((r) => rel(r.baseline)), ...FRONTEND.map((f) => rel(baselineCopy(f.file))), ...RELATED_UI];
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
  for (const f of [...OLD_ROUTES.map((r) => r.baseline), path.join(EVID, "baseline-04c/SEAL.json"), path.join(EVID, "extraction-proof.json"), path.join(EVID, "consumer-graph.json"), path.join(BASE, "symbol-inventory.pre-extraction.json"), ...FRONTEND.map((f) => baselineCopy(f.file))]) if (!fs.existsSync(f)) fail(`sealed pre-extraction baseline/evidence missing: ${rel(f)}`);
  const manifest = JSON.parse(sealData.manText).files;

  const pre = runPrerequisites(sealData);
  const proof = JSON.parse(fs.readFileSync(path.join(EVID, "extraction-proof.json"), "utf8"));
  const chk0 = []; const prereqProbe = prerequisiteChecks(pre, (n, p, d) => chk0.push({ name: n, passed: Boolean(p), details: String(d ?? "") }));
  const unit = prereqProbe.unit; const deferred = pre.cGraph?.deferred_consumers ?? [];

  const gates = OLD_ROUTES.map((route) => ({ route, ...routeGate({ route, unit }) }));
  const allThin = gates.flatMap((g) => g.thin); const allViolations = gates.flatMap((g) => g.violations);
  const allDisp = gates.flatMap((g) => g.dispositions);
  const ucp = useCaseProof(allThin);
  const moved = new Set(allDisp.filter((d) => /^MOVED/.test(d.disposition)).map((d) => d.symbol));
  const hidden = hiddenImportScan({ moved });
  const dup = duplicateScan({ seal: sealData, deferred });
  const layering = layeringScan();
  const routeKeys = [...gates.flatMap((g) => g.route_table.current.map((r) => r.key))];
  const fe = frontendGate({ routeKeys, manifest });
  const audit = diffAudit(sealData);
  const tc = typecheck();

  // census consistency with the 04-A pre-extraction inventory (line-anchored, independent of this scan)
  const invRaw = JSON.parse(fs.readFileSync(path.join(BASE, "symbol-inventory.pre-extraction.json"), "utf8")); const inv = Array.isArray(invRaw) ? invRaw : (invRaw.records ?? []);
  const censusRows = [...OLD_ROUTES.map((r) => ({ file: r.file, text: fs.readFileSync(r.baseline, "utf8") })), ...FRONTEND.map((f) => ({ file: f.file, text: fs.readFileSync(baselineCopy(f.file), "utf8") }))].map(({ file, text }) => {
    const mine = new Set(scanTop(text, file).syms.map((s) => s.start)); const recs = inv.filter((r) => r.id.startsWith(`${file}#`)); const rec = new Set(recs.map((r) => r.line_start));
    return { file, records: rec.size, scan: mine.size, missing_from_scan: [...rec].filter((l) => !mine.has(l)), extra_in_scan: [...mine].filter((l) => !rec.has(l)) };
  });

  const ctx = { unit, thin: allThin, moved, seal: sealData, cGraph: pre.cGraph, deferred, routeKeys, manifest };
  const selft = selfTests(ctx);
  const bypassRes = bypassAttempts();

  const checks = []; const chk = (name, passed, details = "") => checks.push({ name, passed: Boolean(passed), details: typeof details === "string" ? details : canon(details) });
  const prereq = prerequisiteChecks(pre, chk);
  for (const c of sealChecks(sealData, pre.cGraph)) checks.push(c);
  chk("diff-audit:only-the-two-declared-residue-files-changed-since-the-04C-seal", audit.unexpected.length === 0 && [...CHANGED_ALLOWED].every((f) => audit.changed.includes(f)), canon({ unexpected: audit.unexpected, changed: audit.changed }));
  chk("census:every-04A-pre-extraction-symbol-is-in-the-independent-scan (2 routes + UI component)", censusRows.every((c) => c.records > 0 && c.missing_from_scan.length === 0), censusRows.filter((c) => c.missing_from_scan.length).map((c) => `${c.file}:${c.missing_from_scan}`).join(" | "));
  chk("census:scan-found-no-baseline-symbol-outside-the-04A-inventory", censusRows.every((c) => c.extra_in_scan.length === 0), censusRows.filter((c) => c.extra_in_scan.length).map((c) => `${c.file}:${c.extra_in_scan}`).join(" | "));
  chk("retirement:every-baseline-symbol-has-a-proven-disposition", allViolations.length === 0, allViolations.slice(0, 10).join(" | "));
  const BAD = ["AUTHORITATIVE_OLD_LOGIC", "STILL_DECLARED_IN_OLD_FILE", "UNACCOUNTED", "MOVE_UNPROVEN", "MISSING_ROUTE", "MISSING_WIRING", undefined];
  const oldBusiness = allDisp.filter((d) => BAD.includes(d.disposition)).map((d) => d.symbol);
  chk("retirement:no-business-symbol-remains-authoritative-in-old-routes", oldBusiness.length === 0, oldBusiness.join(", "));
  const rb = gates.reduce((n, g) => n + g.route_table.routes_baseline, 0), rc = gates.reduce((n, g) => n + g.route_table.routes_current, 0);
  chk("retirement:all-10-route-handlers-are-thin-adapters", allThin.length === rb && allThin.every((x) => x.thin) && rb === 10, `${allThin.filter((x) => x.thin).length}/${rb} thin`);
  chk("retirement:route-census-equals-baseline (no route added or dropped)", gates.every((g) => g.route_table.routes_baseline === g.route_table.routes_current && g.route_table.routes_baseline >= g.route.minRoutes) && rb === rc, `${rb} vs ${rc}`);
  chk("retirement:route-table-order-and-middleware-chains-identical-to-baseline", gates.every((g) => g.route_table.same_order && g.route_table.middleware_diffs.length === 0), gates.flatMap((g) => g.route_table.middleware_diffs).join(", "));
  chk("retirement:old-routes-have-zero-db-sql-crypto-branches (measured)", gates.every((g) => g.metrics.current_db_refs === 0 && g.metrics.current_sql_literals === 0 && g.metrics.current_crypto_calls === 0 && g.metrics.current_branches === 0) && gates.reduce((n, g) => n + g.metrics.baseline_db_refs, 0) > 20 && gates.reduce((n, g) => n + g.metrics.baseline_branches, 0) > 30, canon(gates.map((g) => g.metrics)));
  chk("retirement:old-routes-only-import-adapter-dependencies", gates.every((g) => g.imports.every((i) => i.allowed)), gates.flatMap((g) => g.imports.filter((i) => !i.allowed).map((i) => i.spec)).join(", "));
  chk("compat:reexports-removed", gates.every((g) => g.compat_reexport_removed), "");
  chk("security:ownership-and-cancel-decision-gates-are-imported-from-vault-security (no local or legacy copy)", gates.every((g) => g.ownership_gates.length >= 1 && g.ownership_gates.every((x) => x.imported_from === OWNERSHIP_SPEC && x.exported_by_owner)) && gates[0].ownership_gates.length >= 4, canon(gates.map((g) => g.ownership_gates)));
  chk("security:no-authorization-decision-comparison-remains-in-any-route (effect/ALLOW/role)", OLD_ROUTES.every((r) => !/decision\.effect|["']ALLOW["']|["']DENY["']|\.role\b/.test(readF(r.file))) && /decision\.effect === "ALLOW"/.test(readF(OWNER_SECURITY[0])) && /decision\.effect\s*!==?\s*"ALLOW"/.test(fs.readFileSync(OLD_ROUTES[1].baseline, "utf8")), "");
  chk("retirement:every-delegate-target-is-an-exported-executable-function-in-the-right-vault-layer", ucp.violations.length === 0 && ucp.use_cases.length >= 11 && ucp.use_cases.some((u) => u.layer === "security"), ucp.violations.join(" | ") || `${ucp.use_cases.length} delegate targets`);
  chk("retirement:every-moved-symbol-has-a-proven-disposition-from-the-reconstructed-04B-run", allDisp.filter((d) => /^MOVED/.test(d.disposition)).length === MOVES.length + 2 && !allDisp.some((d) => d.disposition === "MOVE_UNPROVEN"), `${allDisp.filter((d) => /^MOVED/.test(d.disposition)).length}/${MOVES.length + 2} moved (incl. 2 rule registrations)`);
  chk("retirement:04B-move-claims-equal-the-declared-move-table", (() => { const claimed = new Set(proof.symbols_moved.map((s) => s.replace(/\s/g, ""))); return MOVES.every((c) => [...claimed].some((s) => s.includes(`${path.posix.basename(c.from)}#${c.name}`) && s.includes(`#${c.as}`))); })(), "");
  chk("imports:no-hidden-import-keeps-old-code-authoritative", hidden.violations.length === 0 && hidden.edges.filter((e) => e.verdict === "router-mount").length === 2, hidden.violations.join(" | "));
  chk("duplicates:no-copy-of-extracted-implementation-added-outside-owner", dup.newHits.length === 0, canon(dup.newHits));
  chk("duplicates:no-moved-sql-added-outside-repositories", dup.sqlNew.length === 0, canon(dup.sqlNew));
  chk("duplicates:every-pre-existing-sql-overlap-is-a-named-04C-deferral", dup.sqlPre.every((r) => r.deferred_to && LATER_GAP.test(r.deferred_to)), canon(dup.sqlPre.filter((r) => !r.deferred_to)));
  chk("duplicates:no-baseline-implementation-survives-in-old-routes", dup.survivors.length === 0, canon(dup.survivors));
  chk("duplicates:no-two-owner-modules-implement-the-same-function", dup.ownerDup.length === 0, canon(dup.ownerDup));
  chk("duplicates:fingerprint-corpus-is-non-trivial", dup.baseline_fingerprints >= 8 && dup.owner_functions_fingerprinted >= 14, `${dup.baseline_fingerprints} baseline / ${dup.owner_functions_fingerprinted} owner fingerprints`);
  chk("layering:owner-modules-do-not-reach-the-API-layer-or-bypass-repositories", layering.violations.length === 0, layering.violations.join(" | "));
  chk("frontend:component-classified-unchanged-and-free-of-db-sql-crypto-and-raw-provider-calls", fe.violations.length === 0, fe.violations.slice(0, 8).join(" | "));
  chk("frontend:every-game-api-call-resolves-to-a-registered-route", fe.files.filter((f) => f.api_calls).every((f) => f.api_calls.filter((c) => c.game_endpoint).every((c) => c.resolves_to_registered_route === true)) && fe.files.flatMap((f) => f.api_calls ?? []).filter((c) => c.game_endpoint).length >= 4, "");
  chk("frontend:no-client-side-game-derivation-exists-to-defer (nothing computes server-authoritative values)", fe.files.every((f) => (f.symbols ?? []).every((s) => !/DERIVATION/.test(s.disposition))), "");
  chk("typecheck:no-syntax-errors-in-route-or-owner-files", tc.syntactic_errors.length === 0, tc.syntactic_errors.join(" | "));
  chk("typecheck:no-new-real-class-diagnostics-vs-baseline-routes", tc.real_class_new.length === 0, tc.real_class_new.join(" | "));
  for (const r of selft) chk(r.name, r.passed, r.details);
  chk("selftest:coverage-at-least-45-mutations-executed", selft.length >= 45, `${selft.length}`);
  chk("bypass:every-bypass-attempt-is-rejected-by-the-validator-itself", bypassRes.length >= 7 && bypassRes.every((b) => b.rejected), canon(bypassRes.filter((b) => !b.rejected)));
  const failed = checks.filter((c) => !c.passed);

  fs.mkdirSync(EVID, { recursive: true });
  const hashes = sourceHashes(); const bd = binding(hashes);
  const common = { phase: PHASE, sub_phase: SUB_PHASE, commit_sha: bd.commit_sha, commit_binding: bd.commit_binding, source_tree_sha256: bd.source_tree_sha256, validator_version: VALIDATOR_VERSION, validator_sha256: sha256File(HERE) };
  const companion = {};
  const dispCount = allDisp.reduce((m, d) => (m[d.disposition] = (m[d.disposition] ?? 0) + 1, m), {});
  companion[EV.old] = writeEv(EV.old, { ...common, description: "Pre-extraction (04-A frozen) vs current fingerprint and disposition of every top-level symbol in the old Game sources", routes: gates.map((g) => ({ file: g.route.file, metrics: g.metrics, sha256: g.sha256, symbols: g.symbols })), disposition_summary: dispCount, frontend: fe.files.map((f) => ({ file: f.file, kind: f.kind, disposition: f.disposition, sha256: f.sha256, baseline_sha256: f.baseline_sha256, unchanged_since_pre_extraction_baseline: f.unchanged_since_pre_extraction_baseline, metrics: f.metrics, symbols: f.symbols })), related_ui_files: fe.related, census_consistency_with_04A: censusRows });
  const ownerRows = OWNER_FILES.map((f) => { const txt = readF(f); const { sf, syms } = scanTop(txt, f); const a = analyze([sf], sf); return { file: f, sha256: sha256(txt), lines: txt.split("\n").length, exports: syms.filter((s) => s.exported && s.kind !== "type").map((s) => s.key), executable_business: { db_refs: a.db, sql_literals: sqlLiterals(sf).size, branches: branches(a), calls: a.calls.length } }; });
  companion[EV.neu] = writeEv(EV.neu, { ...common, description: "Fingerprints of the new owner modules and proof that the old routes actually call them", owner_files: ownerRows, delegate_targets: ucp.use_cases, moved_symbols: allDisp.filter((d) => /^MOVED/.test(d.disposition)).map((d) => ({ symbol: d.symbol, disposition: d.disposition, new_owner: d.new_owner })), layering_notes: layering.notes });
  companion[EV.thin] = writeEv(EV.thin, { ...common, description: "Per-route thinness of every route left in the old files", allowed_in_old_route: ["request parsing (req.user.userId / req.params.* / req.body / req.query[.*])", "auth-context construction: one expression-bodied callback that binds `req` to a vault/security decision function", "exactly one `const out = await <use-case>(...)`", "exactly one canonical response mapping `res.status(out.status).json(out.body)`", "middleware wiring (auth / ownership gate with resolved deny behavior / credit gate)", "router default export"], rejected_in_old_route: ["db/sql/table access", "provider/crypto/event/sync calls", "domain calculations", "decision trees (if/ternary/switch/loops/try, &&/||/??)", "duplicated authorization (decision.effect comparisons) or persistence logic", "non-adapter imports", "compat re-exports", "any second statement or non-canonical response mapping"], routes: allThin, per_file: gates.map((g) => ({ file: g.route.file, imports: g.imports, route_table: g.route_table, ownership_gates: g.ownership_gates })), summary: { routes: allThin.length, thin: allThin.filter((x) => x.thin).length, not_thin: allThin.filter((x) => !x.thin).length, per_file_metrics: gates.map((g) => ({ file: g.route.file, ...g.metrics })) } });
  companion[EV.dup] = writeEv(EV.dup, { ...common, description: "Duplicate implementation scan (name-agnostic token fingerprints + normalized SQL)", added_copies_outside_owner: dup.newHits, added_sql_outside_repositories: dup.sqlNew, baseline_bodies_surviving_in_old_routes: dup.survivors, owner_module_duplicates: dup.ownerDup, pre_existing_function_overlaps_reported_to_GAP_16: dup.preExisting, pre_existing_sql_overlaps_with_deferred_consumers: dup.sqlPre, corpus: { baseline_fingerprints: dup.baseline_fingerprints, owner_functions_fingerprinted: dup.owner_functions_fingerprinted, owner_sql_statements: dup.owner_sql_statements }, hidden_import_edges: hidden.edges, hidden_import_violations: hidden.violations, layering_violations: layering.violations });
  companion[EV.beh] = writeEv(EV.beh, { ...common, description: "Frozen OLD routes vs extracted tree executed side by side (04-B differential on the reconstructed 04-B-certified tree) plus the 04-C consumer differential (re-executed on a temp copy reconstructed to the 04-C-certified state)", stubbed: "no network and no real database; deterministic stand-ins are identical for OLD and NEW", differential_04B: pre.bEv?.tests, consumer_differential_04C: pre.cGraph?.tests, residue_fix_in_04D: { files: [...CHANGED_ALLOWED], what: "the seller-or-admin `decision.effect === \"ALLOW\"` comparison moved from routes/marketplace-game.ts into vault/security/game-ownership.ts#canCancelGameListing; DELETE /marketplace/game/listings/:id behavior (404/403/200 and the PDP call) is unchanged and proven by the 04-B differential (59 cases incl. cancel allow/deny/404/500) executed against the post-04-D bytes", note: "04-B ran on the post-04-D bytes of those two files; 04-C ran on their pre-04-D (04-C-certified) bytes. The cancel route is additionally pinned by the AST gate (callback must be a single call to vault/security)." }, typecheck: tc });
  companion[EV.sec] = writeEv(EV.sec, { ...common, description: "Security regression: middleware chains and route order identical to baseline; ownership/deny/cancel-decision gates imported from vault/security; bypass attempts rejected; gate mutation tests", route_middleware_chains: gates.map((g) => ({ file: g.route.file, same_order: g.route_table.same_order, differences: g.route_table.middleware_diffs, per_route: g.route_table.current })), ownership_gates: gates.map((g) => ({ file: g.route.file, gates: g.ownership_gates })), security_04B_on_post_04D_bytes: { passed: pre.bEv?.tests?.security_passed, total: pre.bEv?.tests?.security_checks }, validator_bypass_test: bypassRes, mutation_evidence: selft });
  const g = { ...common, source_hashes: hashes, commands: [...pre.commands, "in-process AST retirement gate / duplicate scan / layering / frontend classification", "in-process mutation self-tests", "child-process bypass attempts against this validator"], exit_codes: { ...pre.exit_codes, retirement_gate: allViolations.length ? 1 : 0, mutation_self_tests: selft.every((r) => r.passed) ? 0 : 1, bypass_attempts: bypassRes.every((b) => b.rejected) ? 0 : 1, typecheck_degraded: tc.real_class_new.length || tc.syntactic_errors.length ? 1 : 0 },
    baseline: { mode: "write-once seal (verified, never written by this validator)", seal_file: rel(path.join(SEAL_DIR, "SEAL.json")), sealed_at: sealData.seal.sealed_at, certified_by: sealData.seal.certified_by },
    symbols_moved: allDisp.filter((d) => /^MOVED/.test(d.disposition)).map((d) => `${d.file}#${d.symbol} -> ${d.new_owner}`), consumers_migrated: pre.cGraph?.consumer_graph?.rewired_consumers?.map((c) => c.file) ?? [], old_business_symbols_remaining: oldBusiness, duplicate_implementations: dup.newHits, disposition_summary: dispCount,
    findings_fixed_by_this_gate: [{ finding: "routes/marketplace-game.ts DELETE /marketplace/game/listings/:id still compared `ownership.decision.effect === \"ALLOW\"` inside the route callback (duplicated authorization logic, rejected by 04-D task 8)", fix: "moved into vault/security/game-ownership.ts#canCancelGameListing; the route callback is now a single expression-bodied call", files: [...CHANGED_ALLOWED] }],
    module_status: failed.length === 0 ? { "routes/game-entries.ts": "ADAPTER", "routes/marketplace-game.ts": "ADAPTER", "vault/{domain,security,application,infrastructure}/game*": "MIGRATED", "components/game-entries.tsx": "DISCOVERED (UI adapter; no client-side derivation)", promotion_ceiling: "VERIFIED/RETIRED are withheld: GAP-15 (behavioral equivalence), GAP-16 (duplicate elimination) and GAP-17 (migration-map truth) have not run; the old routes are retained as the public HTTP adapters, so they are ADAPTER, not RETIRED.", assigned_by: "validator (this run), not manually" } : null,
    frontend: { files: fe.files.map((f) => ({ file: f.file, disposition: f.disposition })), related_ui_unchanged: fe.related },
    deferred_consumers_from_04C: deferred.map((d) => ({ file: d.file, deferred_to: d.deferred_to })),
    carry_over_from_04C: pre.cGraph?.deferred_carry_over ?? [],
    summary: { old_route_thin_handlers: allThin.filter((x) => x.thin).length, old_route_total_handlers: allThin.length, route_db_refs_before: gates.reduce((n, x) => n + x.metrics.baseline_db_refs, 0), route_db_refs_after: gates.reduce((n, x) => n + x.metrics.current_db_refs, 0), route_branches_before: gates.reduce((n, x) => n + x.metrics.baseline_branches, 0), route_branches_after: gates.reduce((n, x) => n + x.metrics.current_branches, 0), old_route_lines_before: gates.reduce((n, x) => n + x.metrics.baseline_lines, 0), old_route_lines_after: gates.reduce((n, x) => n + x.metrics.current_lines, 0), delegate_targets_verified: ucp.use_cases.length, symbols_moved: moved.size, differential_cases_04B: pre.bEv?.tests?.differential_cases, differential_cases_04C: pre.cGraph?.tests?.differential_cases, mutation_self_tests: selft.length, mutation_self_tests_passed: selft.filter((s) => s.passed).length, bypass_attempts_rejected: bypassRes.filter((b) => b.rejected).length },
    limitations: ["Full tsc/build was NOT executed: project dependencies are not installed in the upload; a differential typecheck against the sealed baseline routes is used and recorded as degraded.", "No git repository is present in the upload; evidence is bound to a source-tree hash instead of a commit SHA (commit_sha is null).", "Behavioral equivalence runs against stubbed DB/provider/event layers, not a live database.", "04-B and 04-C cannot run unchanged on the current tree (04-C added listing.ts and edited two files; 04-D edited two more); 04-C is executed on a temp copy reconstructed to its certified bytes, 04-B on a temp copy with 04-C's changes undone, each from sealed copies, and must PASS there with zero failing checks.", "04-B is executed with the two 04-D-edited files kept at their CURRENT bytes (everything 04-C touched is restored), so its 59-case differential and 20 security checks run against the post-04-D cancel route and security module and must all pass.", "Carry-over from 04-C remains open: the entity/local/KYC branches of routes/marketplace-vault.ts and vault_market_listings persistence have no owning gap yet.", "Deferred table consumers (GAP-07/09/10/12) still access game tables directly; they are explicit, verified deferrals, not retirements."],
    companion_evidence_sha256: companion, checks, status: failed.length === 0 ? "PASS" : "FAIL" };
  g.evidence_body_sha256 = sha256(JSON.stringify(g)); g.generated_at = new Date().toISOString();
  fs.writeFileSync(path.join(EVID, EV.gate), `${JSON.stringify(g, null, 2)}\n`);
  console.log(`${SUB_PHASE} ${g.status} — thin=${g.summary.old_route_thin_handlers}/${g.summary.old_route_total_handlers} route-db-refs=${g.summary.route_db_refs_before}→${g.summary.route_db_refs_after} branches=${g.summary.route_branches_before}→${g.summary.route_branches_after} delegates=${ucp.use_cases.length} moved=${g.summary.symbols_moved} 04B-diff=${g.summary.differential_cases_04B} 04C-diff=${g.summary.differential_cases_04C} selftests=${g.summary.mutation_self_tests_passed}/${g.summary.mutation_self_tests} bypass-rejected=${g.summary.bypass_attempts_rejected}/${bypassRes.length} (${Date.now() - started}ms)`);
  if (failed.length) { console.error(failed.map((c) => `- ${c.name}: ${String(c.details).slice(0, 400) || "not satisfied"}`).join("\n")); process.exit(1); }
}
main().catch((e) => fail(`validator crashed: ${e.stack || e}`));
