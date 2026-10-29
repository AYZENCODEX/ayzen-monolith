#!/usr/bin/env node
// VLT-GAP-04-A — Game Symbol / Behavior Census (source-derived, fail-closed).
// Evidence: reports/antas/vault/gap/VLT-GAP-04/symbol-inventory.json
// Baseline: reports/antas/vault/gap/VLT-GAP-04/baseline/ (frozen pre-extraction source + manifest)
//
// 04-A is a census only. No code is moved; symbols_moved / consumers_migrated stay empty.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { ROOT, sha256, rel, rejectBypass, binding, walkFiles } from "./gap-common.mjs";

const VALIDATOR_VERSION = "1.0.0";
const PHASE = "VLT-GAP-04";
const SUB_PHASE = "VLT-GAP-04-A";
const SELF = fileURLToPath(import.meta.url);

// Roadmap GAP-04 Sources (exactly the three listed; enumerated, never hand-trimmed).
const FIXED_SOURCES = [
  "artifacts/api-server/src/routes/game-entries.ts",
  "artifacts/api-server/src/routes/marketplace-game.ts",
  "artifacts/ayzen/src/components/game-entries.tsx",
];
const SOURCES = [...FIXED_SOURCES];
// Existing destination state (recorded, not censused as legacy source).
const DESTINATION_CONTEXT = ["artifacts/api-server/src/vault/domain/game.ts"];
// Game-named files NOT listed in the roadmap Sources: recorded so nothing is silently dropped.
const RELATED_GAME_PATTERN = /game/i;
const UI_ALIAS_ROOT = "artifacts/ayzen/src";
const EVIDENCE_DIR = path.join(ROOT, "reports/antas/vault/gap/VLT-GAP-04");
const EVIDENCE_FILE = path.join(EVIDENCE_DIR, "symbol-inventory.json");
const BASELINE_DIR = path.join(EVIDENCE_DIR, "baseline");

function fail(msg, code = 1) { console.error(`${SUB_PHASE} FAIL — ${msg}`); process.exit(code); }

// ── 1. Bypass rejection (fail closed) ─────────────────────────────────────
const bypass = rejectBypass(["--verify"]);
if (bypass.length) fail(`bypass mechanism rejected: ${bypass.join(", ")}`);
if (process.env.VALIDATION_DISABLED && !/^(0|false|no)$/i.test(process.env.VALIDATION_DISABLED)) fail("bypass mechanism rejected: env VALIDATION_DISABLED");

// ── 2. TypeScript compiler (real AST) ─────────────────────────────────────
function loadTs() {
  const tries = [
    () => createRequire(path.join(ROOT, "package.json"))("typescript"),
    () => { const g = spawnSync("npm", ["root", "-g"], { encoding: "utf8" }); if (g.status !== 0) throw new Error("npm root -g failed"); return createRequire(path.join(g.stdout.trim(), "x.js"))("typescript"); },
  ];
  for (const t of tries) { try { return t(); } catch { /* next */ } }
  return null;
}
const ts = loadTs();
if (!ts) fail("TypeScript compiler API unavailable; AST census cannot run (fail closed)");

const read = (r) => fs.readFileSync(path.join(ROOT, r), "utf8");
const HTTP = new Set(["get", "post", "put", "patch", "delete", "head", "options", "all"]);
const fileKind = (f) => (/\/routes\//.test(f) ? "route" : /\/pages\//.test(f) ? "page" : /\.tsx$/.test(f) ? "component" : "config");

function parse(fileName, text) {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}
const lines = (sf, node) => ({ start: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, end: sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1 });
function semanticFingerprint(node, sf) {
  const toks = [];
  (function w(n) { if (n.getChildCount(sf) === 0 && n.kind !== ts.SyntaxKind.EndOfFileToken) toks.push(n.getText(sf)); else n.getChildren(sf).forEach(w); })(node);
  return sha256(toks.join(" "));
}
function importsOf(sf) {
  const map = new Map();
  for (const s of sf.statements) {
    if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier)) continue;
    const mod = s.moduleSpecifier.text; const c = s.importClause; if (!c) continue;
    if (c.name) map.set(c.name.text, { module: mod, imported: "default" });
    if (c.namedBindings) {
      if (ts.isNamespaceImport(c.namedBindings)) map.set(c.namedBindings.name.text, { module: mod, imported: "*" });
      else for (const el of c.namedBindings.elements) map.set(el.name.text, { module: mod, imported: (el.propertyName ?? el.name).text });
    }
  }
  return map;
}

// ── 3. Operation detection (AST-based) ────────────────────────────────────
const CATEGORY_BY_CALLEE = [
  ["event", /^(broadcastEvent|emit|publish|enqueue)$/],
  ["notification", /^(createNotification|sendToUser)$/],
  ["audit", /^(logVaultActivity|logSubjectActivity|audit[A-Z]\w*|requirePublicAudit)$/],
  ["billing", /^(chargeCredits|requireCreditBalance)$/],
  ["crypto", /^(encryptField|decryptField|decryptRow|decryptRows|encryptSeedPhrase|decryptSeedPhrase|createCipheriv|createDecipheriv|scryptSync|scrypt|randomBytes|randomUUID|createHash|createHmac|timingSafeEqual|pbkdf2Sync|generateSerial)$/],
  ["authz", /^(requireAuth|requireAdmin|requireOwnership|authorizeMany|createResourceOwnershipRule|consumeRevealToken|PolicyEngine)$/],
  ["provider", /^(axios|request|streamFantasticReceiptPdf)$/],
  ["sync", /^(syncOnKyc\w+|syncOnVault\w+|delistVaultMarketplaceListings)$/],
  ["storage", /^(readFileSync|writeFileSync|createReadStream|createWriteStream|readFile|writeFile|unlink|download|sendFile)$/],
  ["job", /^(setInterval|setTimeout|schedule|cron)$/],
  ["api-client", /^(customFetch)$/],
  ["hook", /^use[A-Z]\w*$/],
  ["email", /^(sendMail|sendEmail|sendTemplatedEmail)$/],
  ["config", /^(getMarketConfig)$/],
];
const DB_METHODS = new Set(["select", "insert", "update", "delete", "execute", "transaction", "query", "selectDistinct"]);
const NON_TARGET_ROOTS = ["res", "req", "Math", "JSON", "Object", "Array", "String", "Number", "Date", "Buffer", "Promise", "Set", "Map", "console"];

const taggedTemplates = new WeakSet();
function analyze(node, sf, imports) {
  const st = { db: [], sql: [], tables: new Set(), calls: new Map(), statuses: new Set(), errs: new Set(), inputs: new Set(), api: new Set(), state: new Set(), transactional: false, responses: 0, jsx: false, fetchCalls: 0,
    branches: { if: 0, else: 0, switch_case: 0, ternary: 0, logical: 0, catch: 0, loop: 0, throw: 0 } };
  const cats = {}; const addCat = (c, n) => { (cats[c] ??= new Set()).add(n); };
  (function walk(n) {
    switch (n.kind) {
      case ts.SyntaxKind.IfStatement: st.branches.if++; if (n.elseStatement) st.branches.else++; break;
      case ts.SyntaxKind.CaseClause: case ts.SyntaxKind.DefaultClause: st.branches.switch_case++; break;
      case ts.SyntaxKind.ConditionalExpression: st.branches.ternary++; break;
      case ts.SyntaxKind.CatchClause: st.branches.catch++; break;
      case ts.SyntaxKind.ForStatement: case ts.SyntaxKind.ForOfStatement: case ts.SyntaxKind.ForInStatement: case ts.SyntaxKind.WhileStatement: case ts.SyntaxKind.DoStatement: st.branches.loop++; break;
      case ts.SyntaxKind.ThrowStatement: st.branches.throw++; break;
      case ts.SyntaxKind.JsxElement: case ts.SyntaxKind.JsxSelfClosingElement: case ts.SyntaxKind.JsxFragment: st.jsx = true; break;
      case ts.SyntaxKind.BinaryExpression: {
        const k = n.operatorToken.kind;
        if (k === ts.SyntaxKind.AmpersandAmpersandToken || k === ts.SyntaxKind.BarBarToken || k === ts.SyntaxKind.QuestionQuestionToken) st.branches.logical++;
        break;
      }
      case ts.SyntaxKind.PropertyAccessExpression: {
        const t = n.expression.getText(sf);
        if (/^req\.(params|query|body)$/.test(t)) st.inputs.add(`${t}.${n.name.text}`);
        else if (/^req(uest)?$/.test(t) && ["params", "query", "body", "headers", "cookies"].includes(n.name.text)) st.inputs.add(`req.${n.name.text}`);
        break;
      }
      case ts.SyntaxKind.Identifier: {
        if (/Table$/.test(n.text) && imports.get(n.text)?.module?.startsWith("@workspace/db")) st.tables.add(n.text);
        break;
      }
      case ts.SyntaxKind.StringLiteral: case ts.SyntaxKind.NoSubstitutionTemplateLiteral: case ts.SyntaxKind.TemplateExpression: {
        // String-built SQL (e.g. sql.raw(`SELECT ...`) or SQL fragment constants). Route files only; uppercase SQL keywords only,
        // so UI toast text such as `Delete ${x}` is never mistaken for SQL. Tagged templates are handled in their own case.
        if (!/\/routes\//.test(sf.fileName) || taggedTemplates.has(n)) break;
        const raw = n.getText(sf);
        if (!/\b(SELECT|INSERT INTO|UPDATE|DELETE FROM|LEFT JOIN|JOIN|EXISTS)\b/.test(raw)) break;
        if (n.kind === ts.SyntaxKind.StringLiteral && !/\b(FROM|SET|INTO)\b/.test(raw)) break; // plain string literals: must look like real SQL
        const verbs = [...raw.matchAll(/\b(SELECT|INSERT INTO|UPDATE|DELETE FROM|EXISTS|JOIN)\b/g)].map((m) => m[1].replace(/\s+/g, " "));
        const tabs = [...raw.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+"?([a-z_][a-z0-9_.]*)"?/g)].map((m) => m[1].toLowerCase()).filter((t) => !["set", "select", "lateral"].includes(t));
        // string_built = value interpolation into SQL text (sql.raw style). Parameterized queries ($1.. or $${n} placeholders) are recorded but not flagged.
        const isParam = /\$\d+|\$\$\{/.test(raw);
        st.sql.push({ verbs: [...new Set(verbs)], tables: [...new Set(tabs)], string_built: n.kind === ts.SyntaxKind.TemplateExpression && !isParam, parameterized: isParam });
        break;
      }
      case ts.SyntaxKind.TaggedTemplateExpression: {
        taggedTemplates.add(n.template);
        if (n.tag.getText(sf) === "sql") {
          const raw = n.template.getText(sf);
          const verbs = [...raw.matchAll(/\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|WITH|CREATE|ALTER|DROP|TRUNCATE)\b/gi)].map((m) => m[1].toUpperCase().replace(/\s+/g, " "));
          const tabs = [...raw.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+"?([a-z_][a-z0-9_.]*)"?/gi)].map((m) => m[1].toLowerCase()).filter((t) => !["set", "select", "lateral"].includes(t));
          st.sql.push({ verbs: [...new Set(verbs)], tables: [...new Set(tabs)] });
        }
        break;
      }
      case ts.SyntaxKind.CallExpression: {
        const callee = n.expression; let name = null, root = null, member = null;
        if (ts.isIdentifier(callee)) { name = callee.text; root = name; }
        else if (ts.isPropertyAccessExpression(callee)) {
          member = callee.name.text; name = member;
          let r = callee.expression; while (ts.isPropertyAccessExpression(r) || ts.isCallExpression(r)) r = r.expression;
          root = ts.isIdentifier(r) ? r.text : null;
        }
        if (name) {
          const imp = root ? imports.get(root) : undefined;
          if (imp || (root && !NON_TARGET_ROOTS.includes(root))) {
            const key = imp ? `${imp.module}::${imp.imported === "*" || imp.imported === "default" ? name : imp.imported}` : `local::${name}`;
            st.calls.set(key, (st.calls.get(key) ?? 0) + 1);
          }
          if ((root === "db" || root === "tx" || root === "pool" || root === "client") && member && DB_METHODS.has(member)) { st.db.push(`${root}.${member}`); if (member === "transaction") st.transactional = true; }
          for (const [cat, rx] of CATEGORY_BY_CALLEE) if (rx.test(name)) addCat(cat, name);
          if (root === "sql" && member === "raw") addCat("raw-sql-call", "sql.raw");
          if (name === "fetch" && !member) { st.fetchCalls++; addCat("provider", "fetch"); }
          if (name === "customFetch" && n.arguments[0]) st.api.add(n.arguments[0].getText(sf).replace(/\s+/g, " ").slice(0, 120));
          if (name === "useState" && ts.isVariableDeclaration(n.parent) && ts.isArrayBindingPattern(n.parent.name)) st.state.add(n.parent.name.elements[0]?.getText(sf) ?? "?");
          if (root === "crypto" || root === "nodeCrypto") addCat("crypto", `crypto.${name}`);
          if (root === "fs") addCat("storage", `fs.${name}`);
          if (root === "res" && ["json", "send", "end", "download", "redirect", "sendFile", "write", "pipe"].includes(name)) st.responses++;
          if (root === "res" && name === "status" && n.arguments[0] && ts.isNumericLiteral(n.arguments[0])) st.statuses.add(Number(n.arguments[0].text));
        }
        break;
      }
      case ts.SyntaxKind.PropertyAssignment: {
        const pn = n.name.getText(sf);
        if ((pn === "error" || pn === "message") && ts.isStringLiteralLike(n.initializer)) st.errs.add(n.initializer.text);
        break;
      }
      default: break;
    }
    ts.forEachChild(n, walk);
  })(node);
  const cat = Object.fromEntries(Object.entries(cats).map(([k, v]) => [k, [...v].sort()]));
  const dbOps = [...new Set(st.db)].sort();
  if (dbOps.length) cat.db = dbOps;
  if (st.sql.length) cat.raw_sql = st.sql;
  return {
    operations: cat,
    tables: [...st.tables].sort(),
    external_calls: [...st.calls.entries()].map(([k, c]) => ({ target: k, count: c })).sort((a, b) => a.target.localeCompare(b.target)),
    api_endpoints_called: [...st.api].sort(),
    react_state_vars: [...st.state].sort(),
    renders_jsx: st.jsx,
    branches: st.branches,
    branch_total: Object.values(st.branches).reduce((a, b) => a + b, 0),
    response_statuses: [...st.statuses].sort((a, b) => a - b),
    error_literals: [...st.errs].sort(),
    request_inputs: [...st.inputs].sort(),
    transactional: st.transactional,
    response_calls: st.responses,
    touches_db: dbOps.length > 0 || st.sql.length > 0 || st.tables.size > 0,
  };
}

// ── 4. Behavior domain mapping (GAP-04 required behaviors) ────────────────
// Roadmap "must become owned by the new module": game entry, Vault entity, metadata, ownership, access, marketplace boundary.
// Mapping is rule-based on file/route/symbol; a behavior with zero evidencing symbols FAILS the census (no invented behaviors).
const REQUIRED_BEHAVIORS = ["game-entry", "vault-entity", "metadata", "ownership", "access", "marketplace-boundary"];
function behaviorOf(file, name, routePath, method) {
  const kind = fileKind(file);
  const n = name ?? "";
  if (/routes\/marketplace-game\.ts$/.test(file)) {
    if (/gameListingOwnerOrAdminEngine/.test(n)) return "ownership"; // seller-OR-admin listing ownership decision
    if (/^(router|default)$/.test(n) || /^export@/.test(n)) return "shared-support";
    return "marketplace-boundary";
  }
  if (/routes\/game-entries\.ts$/.test(file)) {
    if (kind === "route" && routePath) return method === "GET" && /^\/game-entries\/:id$/.test(routePath) ? "access" : "game-entry"; // single fetch = ownership-gated + credit-metered view
    if (/Ownership|Resource$|SENTINEL_NONE/.test(n)) return "ownership";
    if (/^safeTags$/.test(n)) return "metadata";
    if (/^safe$/.test(n)) return "sql-support";
    return "shared-support";
  }
  if (/components\/game-entries\.tsx$/.test(file)) {
    if (/^(GameEntry|EMPTY_FORM|rowToForm)$/.test(n)) return "vault-entity";
    if (/^(FORM_TABS|FormTab|INFO_SCHEMA_FIELDS|CategoryBadge|TagInput)$/.test(n)) return "metadata";
    if (/^(GameDialog|default)$/.test(n)) return "game-entry";
    return "ui-view";
  }
  return "shared-support";
}
const isRequired = (b) => REQUIRED_BEHAVIORS.includes(b);

// ── 5. Classification (rule-based; no rule ⇒ UNCLASSIFIED ⇒ FAIL) ─────────
const CLASSES = new Set(["domain", "application", "security", "infrastructure", "API", "adapter", "legacy"]);
function classifySymbol(rec) {
  const n = rec.name ?? ""; const ops = rec.operations ?? {};
  const has = (c) => Boolean(ops[c]?.length);
  const io = rec.touches_db || has("provider") || has("event") || has("notification") || has("storage") || has("billing") || has("sync") || has("email");
  const rule = (cls, id) => ({ classification: cls, classification_rule: id });
  if (rec.kind === "router-instance") return rule("adapter", "R01:express-router-instance");
  if (rec.kind === "export-assignment") return rule("adapter", "R02:default-export-router");
  if (rec.kind === "type" || rec.kind === "interface") return rule("domain", "R03:type-declaration");
  if (rec.kind === "rule-registration") return rule("security", "R04:policy-rule-registration");
  if (/^legacy[A-Z]/.test(n)) return rule("legacy", "R05:legacy-prefixed-symbol");
  if (/(Resource|Ownership|_SENTINEL_NONE)$|^(require|audit)\w*Ownership|^deny[A-Z]/.test(n)) return rule("security", "R06:ownership-resource-builder");
  if (rec.kind === "function" || rec.kind === "arrow-function") {
    if (rec.renders_jsx) return rule("adapter", "R20:react-ui-component");
    if (has("crypto") && !io && !rec.touches_db) return rule("security", "R08:crypto-no-io");
    if (rec.touches_db && !has("provider") && !has("event") && !has("notification") && rec.branch_total <= 6 && /^(select|find|hardDelete|store|prune|load|fetch|get)/.test(n)) return rule("infrastructure", "R09:repository-style-data-access");
    if (rec.touches_db || io) return rule("application", "R10:orchestrates-io");
    if (has("api-client") || has("audit")) return rule("application", "R11:client-or-audit-orchestration");
    return rule("domain", "R12:pure-computation");
  }
  if (rec.kind === "constant") {
    if (rec.initializer_kind === "template-sql") return rule("infrastructure", "R13:sql-fragment-constant");
    if (rec.initializer_kind === "call-adapter") return rule("adapter", "R14:framework-call-constant");
    if (rec.initializer_kind === "new-engine") return rule("security", "R15:policy-engine-instance");
    if (["literal", "array", "object", "set", "as-const", "expression", "prefix-unary"].includes(rec.initializer_kind)) return rule("domain", "R16:pure-constant");
    if (rec.initializer_kind === "call-pure") return rule("domain", "R17:pure-derived-constant");
  }
  return { classification: "UNCLASSIFIED", classification_rule: null };
}
function initializerKind(init, sf) {
  if (!init) return "none";
  let e = init;
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression?.(e)) e = e.expression;
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return "arrow-function";
  if (ts.isNoSubstitutionTemplateLiteral(e) || ts.isTemplateExpression(e)) return /\b(select|from|where|join|coalesce|as)\b/i.test(e.getText(sf)) ? "template-sql" : "literal";
  if (ts.isStringLiteralLike(e) || ts.isNumericLiteral(e) || e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword) return "literal";
  if (ts.isPrefixUnaryExpression(e)) return "prefix-unary";
  if (ts.isArrayLiteralExpression(e)) return "array";
  if (ts.isObjectLiteralExpression(e)) return "object";
  if (ts.isBinaryExpression(e)) return "expression";
  if (ts.isNewExpression(e)) { const t = e.expression.getText(sf); return t === "Set" || t === "Map" ? "set" : /PolicyEngine$/.test(t) ? "new-engine" : "new-other"; }
  if (ts.isCallExpression(e)) {
    const t = e.expression.getText(sf);
    if (t === "sql.raw") return "template-sql";
    if (/^(Router|express\.\w+|\w+\.json|\w+\.raw|\w+\.urlencoded)$/.test(t)) return "call-adapter";
    if (/\.(filter|map|find|some|every|reduce|slice|concat|flatMap)$/.test(t)) return "call-pure";
    if (/^(Object\.freeze|new Set|Object\.fromEntries|Array\.from)$/.test(t) || /^(Object|Array)\./.test(t)) return "call-pure";
    return "call-other";
  }
  return "other";
}

// ── 6. Per-file census ────────────────────────────────────────────────────
function censusFile(relFile) {
  const text = read(relFile); const sf = parse(relFile, text); const imports = importsOf(sf);
  const kind = fileKind(relFile);
  const records = []; const covered = []; const exportedNames = new Set();
  const stmts = sf.statements.filter((s) => !ts.isImportDeclaration(s));
  const isExported = (s) => s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  const isDefault = (s) => s.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
  let routeOrdinal = 0;

  for (const s of stmts) {
    const L = lines(sf, s); covered.push([L.start, L.end]);
    const base = { file: relFile, file_kind: kind, line_start: L.start, line_end: L.end, line_count: L.end - L.start + 1, exported: false };
    const attach = (rec, node) => { Object.assign(rec, analyze(node, sf, imports)); rec.fingerprint_sha256 = semanticFingerprint(node, sf); rec.raw_sha256 = sha256(node.getText(sf)); return rec; };

    if (ts.isFunctionDeclaration(s) && s.name) {
      const rec = attach({ ...base, id: `${relFile}#${s.name.text}`, name: s.name.text, kind: "function", exported: Boolean(isExported(s)), default_export: Boolean(isDefault(s)) }, s);
      if (rec.exported) exportedNames.add(rec.default_export ? "default" : rec.name);
      rec.async = Boolean(s.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword));
      rec.parameters = s.parameters.map((p) => p.name.getText(sf));
      records.push(rec);
    } else if (ts.isVariableStatement(s)) {
      const exp = Boolean(isExported(s));
      for (const d of s.declarationList.declarations) {
        const nm = d.name.getText(sf); const ik = initializerKind(d.initializer, sf);
        const k = ik === "arrow-function" ? "arrow-function" : nm === "router" && ik === "call-adapter" ? "router-instance" : "constant";
        const rec = attach({ ...base, id: `${relFile}#${nm}`, name: nm, kind: k, exported: exp, initializer_kind: ik }, d);
        if (exp) exportedNames.add(nm);
        records.push(rec);
      }
    } else if (ts.isTypeAliasDeclaration(s) || ts.isInterfaceDeclaration(s)) {
      const rec = attach({ ...base, id: `${relFile}#${s.name.text}`, name: s.name.text, kind: ts.isInterfaceDeclaration(s) ? "interface" : "type", exported: Boolean(isExported(s)) }, s);
      if (rec.exported) exportedNames.add(rec.name);
      records.push(rec);
    } else if (ts.isExportAssignment(s)) {
      records.push(attach({ ...base, id: `${relFile}#export-default`, name: "default", kind: "export-assignment", exported: true, exports: s.expression.getText(sf) }, s));
      exportedNames.add("default");
    } else if (ts.isExportDeclaration(s)) {
      records.push(attach({ ...base, id: `${relFile}#export-decl@${L.start}`, name: `export@${L.start}`, kind: "export-assignment", exported: true }, s));
      s.exportClause && ts.isNamedExports(s.exportClause) && s.exportClause.elements.forEach((e) => exportedNames.add(e.name.text));
    } else if (ts.isExpressionStatement(s) && ts.isCallExpression(s.expression)) {
      const call = s.expression; const callee = call.expression;
      if (ts.isPropertyAccessExpression(callee) && callee.expression.getText(sf) === "router" && HTTP.has(callee.name.text)) {
        routeOrdinal++;
        const method = callee.name.text.toUpperCase(); const first = call.arguments[0];
        const routePath = first && ts.isStringLiteralLike(first) ? first.text : null;
        const args = call.arguments.slice(1); const handler = args[args.length - 1];
        const middleware = args.slice(0, -1).map((a) => (ts.isIdentifier(a) ? a.text : ts.isCallExpression(a) ? a.expression.getText(sf) + "(" + a.arguments.map((x) => x.getText(sf)).join(", ").slice(0, 60) + ")" : a.getText(sf).slice(0, 40)));
        const hl = handler ? lines(sf, handler) : null;
        const rec = attach({ ...base, id: `${relFile}#route:${method} ${routePath}@${L.start}`, name: `${method} ${routePath}`, kind: "route-handler", method, route_path: routePath, middleware, handler_line_count: hl ? hl.end - hl.start + 1 : 0, handler_is_inline: Boolean(handler && (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler))), ordinal: routeOrdinal }, s);
        rec.classification = "API"; rec.classification_rule = "R00:express-route-handler";
        rec.business_behavior_in_route = rec.touches_db || rec.branch_total > 0 || ["provider", "event", "notification", "billing", "crypto", "sync", "storage", "email"].some((c) => rec.operations[c]?.length);
        records.push(rec);
      } else if (ts.isPropertyAccessExpression(callee) && callee.name.text === "registerRule") {
        records.push(attach({ ...base, id: `${relFile}#rule@${L.start}`, name: `${callee.expression.getText(sf)}.registerRule`, kind: "rule-registration" }, s));
      } else records.push(attach({ ...base, id: `${relFile}#stmt@${L.start}`, name: `stmt@${L.start}`, kind: "unknown-statement" }, s));
    } else records.push(attach({ ...base, id: `${relFile}#stmt@${L.start}`, name: `stmt@${L.start}`, kind: "unknown-statement" }, s));
  }

  for (const rec of records) {
    if (rec.kind !== "route-handler") Object.assign(rec, classifySymbol(rec));
    rec.behavior_domain = behaviorOf(relFile, rec.name, rec.route_path, rec.method);
    rec.required_behavior = isRequired(rec.behavior_domain) ? rec.behavior_domain : null;
    rec.owner_gap = "GAP-04";
  }

  // intra-file callers
  const named = records.filter((r) => !["route-handler", "export-assignment", "unknown-statement", "rule-registration"].includes(r.kind));
  const nodeByLine = new Map(stmts.map((s) => [lines(sf, s).start, s]));
  for (const r of named) {
    const users = new Set();
    for (const o of records) {
      if (o === r) continue; const node = nodeByLine.get(o.line_start); if (!node) continue;
      let found = false;
      (function w(x) { if (found) return; if (ts.isIdentifier(x) && x.text === r.name) { found = true; return; } ts.forEachChild(x, w); })(node);
      if (found) users.add(o.id);
    }
    r.intra_file_callers = [...users].sort();
  }
  return { file: relFile, kind, records, exportedNames: [...exportedNames], covered, imports: [...imports.entries()].map(([local, v]) => ({ local, ...v })), stmtCount: stmts.length, sf, text, lineCount: text.split("\n").length };
}

// ── 7. Repository-wide consumer scan (imports, re-exports, dynamic) ───────
const SCAN_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const stripExt = (p) => p.replace(/\.(tsx?|mts|cts|jsx?|mjs|cjs)$/, "");
function scanFiles() {
  return walkFiles(ROOT, [], (p) => SCAN_EXT.test(p) && !/\.d\.ts$/.test(p)).filter((p) => !rel(p).startsWith("scripts/antas/vault/gap/"));
}
function resolveSpec(spec, fromAbs, targets) {
  let base = null;
  if (spec.startsWith(".")) base = path.resolve(path.dirname(fromAbs), spec);
  else if (spec.startsWith("@/")) base = path.join(ROOT, UI_ALIAS_ROOT, spec.slice(2));
  else return null;
  const stem = stripExt(rel(base).replace(/\/index$/, ""));
  for (const cand of [stem, `${stem}/index`]) if (targets.has(cand)) return targets.get(cand);
  return null;
}
function consumerScan(allSources) {
  const targets = new Map([...SOURCES, ...DESTINATION_CONTEXT].map((s) => [stripExt(s), s]));
  const prefilter = /(game|Game|GAME)/;
  const consumers = [];
  for (const abs of scanFiles()) {
    const r = rel(abs); if (allSources.includes(r)) continue;
    let text; try { text = fs.readFileSync(abs, "utf8"); } catch { continue; }
    if (!prefilter.test(text)) continue;
    const sf = parse(abs, text); const hits = [];
    (function scan(n) {
      let spec = null, kind = null; const names = [];
      if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
        spec = n.moduleSpecifier.text; kind = n.importClause?.isTypeOnly ? "import-type" : "import";
        const c = n.importClause;
        if (c?.name) names.push({ imported: "default", local: c.name.text });
        if (c?.namedBindings) { if (ts.isNamespaceImport(c.namedBindings)) names.push({ imported: "*", local: c.namedBindings.name.text }); else c.namedBindings.elements.forEach((e) => names.push({ imported: (e.propertyName ?? e.name).text, local: e.name.text })); }
      } else if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
        spec = n.moduleSpecifier.text; kind = "re-export";
        if (n.exportClause && ts.isNamedExports(n.exportClause)) n.exportClause.elements.forEach((e) => names.push({ imported: (e.propertyName ?? e.name).text, local: e.name.text })); else names.push({ imported: "*", local: "*" });
      } else if (ts.isCallExpression(n) && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0]) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require"))) {
        spec = n.arguments[0].text; kind = n.expression.kind === ts.SyntaxKind.ImportKeyword ? "dynamic-import" : "require"; names.push({ imported: "*", local: "?" });
      }
      if (spec) { const target = resolveSpec(spec, abs, targets); if (target) hits.push({ kind, specifier: spec, target, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, names }); }
      ts.forEachChild(n, scan);
    })(sf);
    for (const h of hits) {
      const uses = {};
      for (const nm of h.names) {
        if (nm.local === "*" || nm.local === "?") continue; let c = 0;
        (function w(x) { if (ts.isIdentifier(x) && x.text === nm.local && !(x.parent && (ts.isImportSpecifier(x.parent) || ts.isImportClause(x.parent) || ts.isNamespaceImport(x.parent)))) c++; ts.forEachChild(x, w); })(sf);
        uses[nm.local] = c;
      }
      consumers.push({ consumer: r, consumer_kind: /(^|\/)(tests?|__tests__)\/|\.(test|spec)\./.test(r) ? "test" : /^scripts\//.test(r) ? "script" : "source", ...h, local_usage_counts: uses, unused_import: Object.values(uses).length > 0 && Object.values(uses).every((c) => c === 0) });
    }
  }
  return consumers.sort((a, b) => a.consumer.localeCompare(b.consumer) || a.line - b.line);
}

// Table-level (DB access) consumers: files outside the sources that touch the same tables.
function tableConsumerScan(records, allSources) {
  const names = new Set();
  for (const r of records) for (const s of r.operations?.raw_sql ?? []) for (const t of s.tables) if (/game/.test(t)) names.add(t);
  const tables = [...names].sort();
  const out = [];
  if (!tables.length) return { tables, consumers: out };
  const rx = new RegExp(`\\b(${tables.join("|")})\\b`, "g");
  const exts = /\.(ts|tsx|mjs|js|cjs|sql|json)$/;
  for (const abs of walkFiles(ROOT, [], (p) => exts.test(p))) {
    const r = rel(abs);
    if (allSources.includes(r) || r.startsWith("scripts/antas/") || r.startsWith("reports/") || /pnpm-lock/.test(r)) continue;
    let text; try { text = fs.readFileSync(abs, "utf8"); } catch { continue; }
    const hits = {};
    for (const m of text.matchAll(rx)) hits[m[1]] = (hits[m[1]] ?? 0) + 1;
    if (!Object.keys(hits).length) continue;
    out.push({ file: r, kind: /(^|\/)(tests?|__tests__)\/|\.(test|spec)\./.test(r) ? "test" : /migration|schema/.test(r) ? "schema-or-migration" : /^artifacts\/ayzen\//.test(r) ? "ui" : "source", tables: hits });
  }
  return { tables, consumers: out.sort((a, b) => a.file.localeCompare(b.file)) };
}

// API-endpoint edges: which UI/source files call the routes owned by the censused route file.
function relatedGameScan(allSources) {
  const out = [];
  for (const abs of walkFiles(ROOT, [], (p) => /\.(ts|tsx|mjs|js|cjs|sql|json)$/.test(p))) {
    const r = rel(abs); if (allSources.includes(r) || DESTINATION_CONTEXT.includes(r) || r.startsWith("scripts/antas/") || /pnpm-lock/.test(r)) continue;
    const byPath = RELATED_GAME_PATTERN.test(r);
    if (byPath) out.push({ file: r, reason: "path-contains-game", in_roadmap_sources: false });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}
function endpointConsumerScan(routeRecords, allSources) {
  const paths = [...new Set(routeRecords.filter((r) => r.kind === "route-handler").map((r) => r.route_path))];
  const out = [];
  for (const abs of scanFiles()) {
    const r = rel(abs); if (allSources.includes(r)) continue;
    let text; try { text = fs.readFileSync(abs, "utf8"); } catch { continue; }
    if (!/game-entries|marketplace\/game/.test(text)) continue;
    const found = new Set();
    for (const m of text.matchAll(/["'`](\/?(?:api\/)?(?:game-entries|marketplace\/game)[^"'`\s)]*)["'`]/g)) found.add(m[1].replace(/\$\{[^}]*\}/g, ":param"));
    if (found.size) out.push({ file: r, endpoints: [...found].sort() });
  }
  return { route_paths: paths.sort(), callers: out.sort((a, b) => a.file.localeCompare(b.file)) };
}

// ── 8. Core build (deterministic; no timestamps inside hashed body) ───────
function buildInventory() {
  const perFile = SOURCES.map((s) => { if (!fs.existsSync(path.join(ROOT, s))) fail(`required source missing: ${s}`); return censusFile(s); });
  const records = perFile.flatMap((f) => f.records);
  const consumers = consumerScan(SOURCES);
  for (const f of perFile) for (const r of f.records) {
    if (!r.exported) { r.external_consumers = []; continue; }
    r.external_consumers = consumers.filter((c) => c.target === f.file && c.names.some((n) => n.imported === r.name || n.imported === "*" || (r.name === "default" && n.imported === "default") || (r.default_export && n.imported === "default")))
      .map((c) => ({ consumer: c.consumer, kind: c.kind, line: c.line })).sort((a, b) => a.consumer.localeCompare(b.consumer));
  }
  const exportsByFile = new Map(perFile.map((f) => [f.file, new Set(f.exportedNames)]));
  const destination = DESTINATION_CONTEXT.map((d) => {
    const text = fs.existsSync(path.join(ROOT, d)) ? read(d) : null;
    if (text === null) return { file: d, exists: false };
    const sf = parse(d, text);
    const exportsList = sf.statements.filter((s) => s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)).flatMap((s) => ts.isVariableStatement(s) ? s.declarationList.declarations.map((x) => x.name.getText(sf)) : s.name ? [s.name.text] : []);
    let fn = 0; (function w(n) { if (ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n)) fn++; ts.forEachChild(n, w); })(sf);
    return { file: d, exists: true, sha256: sha256(text), lines: text.split("\n").length, exports: exportsList.sort(), function_count: fn, holds_business_logic: fn > 0, note: fn === 0 ? "constants-only destination: contains no executable business logic" : "contains functions" };
  });
  const findings = [];
  for (const c of consumers) {
    const ex = exportsByFile.get(c.target);
    for (const n of c.names) {
      if (n.imported === "*") { n.resolved = true; continue; }
      if (!ex) { n.resolved = true; continue; } // destination-context target (not a censused source)
      n.resolved = ex.has(n.imported);
      if (!n.resolved) findings.push({ id: `dangling-import:${c.consumer}:${n.imported}`, severity: "HIGH", kind: "consumer-imports-symbol-not-exported-by-target", consumer: c.consumer, line: c.line, target: c.target, symbol: n.imported, detail: `${c.consumer}:${c.line} imports "${n.imported}" from ${c.target}, which does not export it.` });
    }
    if (c.unused_import) findings.push({ id: `unused-import:${c.consumer}:${c.target}`, severity: "LOW", kind: "unused-import-of-game-source", consumer: c.consumer, line: c.line, target: c.target, detail: "import is never referenced" });
  }
  // Business logic sitting in the UI or route layers that the extraction must account for.
  for (const r of records) {
    if (r.kind === "route-handler" && r.business_behavior_in_route && r.touches_db) findings.push({ id: `route-owns-db:${r.id}`, severity: "INFO", kind: "route-handler-owns-db-access", symbol: r.id, detail: `${r.name} performs DB access inline (${(r.operations.db ?? []).join(",") || "raw sql"})` });
  }
  for (const r of records) {
    if (r.kind === "route-handler" && (r.operations.raw_sql ?? []).some((q) => q.string_built)) findings.push({ id: `string-built-sql:${r.id}`, severity: "INFO", kind: "route-uses-string-built-sql", symbol: r.id, detail: `${r.name} builds SQL via sql.raw/string interpolation; extraction (04-B) must preserve SQL semantics exactly and may not silently change it.` });
  }
  for (const c of consumers) for (const [nm, cnt] of Object.entries(c.local_usage_counts)) if (cnt === 0 && !c.unused_import) findings.push({ id: `unused-imported-symbol:${c.consumer}:${nm}`, severity: "LOW", kind: "imported-symbol-never-referenced", consumer: c.consumer, line: c.line, target: c.target, symbol: nm, detail: `${c.consumer}:${c.line} imports "${nm}" but never references it.` });
  {
    // Derived cross-check 1: every GAME_SENSITIVE_FIELDS column (destination constant) must be encrypted on write by the route.
    const routeSf = perFile.find((f) => f.file.endsWith("routes/game-entries.ts"));
    const dest = destination.find((d) => d.exists);
    const camel = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
    if (routeSf && dest) {
      const fieldsM = read(dest.file).match(/GAME_SENSITIVE_FIELDS\s*=\s*\[([^\]]*)\]/);
      const fields = fieldsM ? [...fieldsM[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
      const unenc = fields.filter((f) => !new RegExp(`encryptField\\(\\s*${camel(f)}\\s*\\)`).test(routeSf.text));
      if (unenc.length) findings.push({ id: "sensitive-field-not-encrypted-by-route:game", severity: "HIGH", kind: "sensitive-field-not-encrypted-by-route", detail: `${dest.file} lists {${unenc.join(",")}} as sensitive but routes/game-entries.ts never calls encryptField() on them.` });
      const encrypted = [...routeSf.text.matchAll(/encryptField\(\s*([A-Za-z0-9_]+)\s*\)/g)].map((m) => m[1]);
      const declared = new Set(fields.map(camel));
      const extra = [...new Set(encrypted)].filter((e) => !declared.has(e));
      if (extra.length) findings.push({ id: "encrypted-field-not-in-sensitive-list:game", severity: "INFO", kind: "encrypted-field-not-in-sensitive-list", detail: `routes/game-entries.ts encrypts {${extra.join(",")}} which are absent from GAME_SENSITIVE_FIELDS; decryptRow would not decrypt them.` });
    }
    // Derived cross-check 2: marketplace boundary. Does marketplace-game.ts touch game_entries (transfer/copy of the entity on sale)?
    const mkt = records.filter((r) => /routes\/marketplace-game\.ts$/.test(r.file) && r.kind === "route-handler");
    const mktTables = new Set(mkt.flatMap((r) => (r.operations.raw_sql ?? []).flatMap((q) => q.tables)));
    if (mkt.length && !mktTables.has("game_entries")) findings.push({ id: "marketplace-game-does-not-touch-game-entries", severity: "INFO", kind: "marketplace-boundary-gap", detail: `routes/marketplace-game.ts operates only on {${[...mktTables].sort().join(",")}}; it never reads/copies/transfers a game_entries row when a listing sells. Any game-entry ownership transfer on sale lives elsewhere (see table_consumers; routes/marketplace-vault.ts is deferred to GAP-04 by GAP-02/03-C). 04-B must preserve this exactly and not add transfer logic.` });
    // Derived cross-check 3: wallet mutation inside the marketplace route (financial logic owned by a game route).
    const walletMut = mkt.filter((r) => (r.operations.raw_sql ?? []).some((q) => q.tables.includes("marketplace_wallets") && q.verbs.some((v) => /UPDATE|INSERT/.test(v))));
    for (const r of walletMut) findings.push({ id: `route-mutates-wallet:${r.id}`, severity: "INFO", kind: "route-mutates-marketplace-wallet", symbol: r.id, detail: `${r.name} debits/credits marketplace_wallets inside a transaction (BEGIN/COMMIT on a dedicated pool client). 04-B must keep the transaction and guarded UPDATE semantics byte-for-byte.` });
    // Derived cross-check 4: destination is constants-only while the routes hold all the logic.
    if (dest && !dest.holds_business_logic) findings.push({ id: "destination-constants-only:game", severity: "INFO", kind: "destination-holds-no-business-logic", detail: `${dest.file} exports constants only (${dest.exports.join(", ")}); all game business logic still lives in the legacy sources.` });
  }
  findings.sort((a, b) => a.id.localeCompare(b.id));
  const tableScan = tableConsumerScan(records, SOURCES);
  const endpointScan = endpointConsumerScan(records, SOURCES);
  const relatedGame = relatedGameScan(SOURCES);
  const sourceHashes = Object.fromEntries(perFile.map((f) => [f.file, sha256(f.text)]));
  for (const d of destination) if (d.exists) sourceHashes[d.file] = d.sha256;
  return { perFile, records, consumers, findings, destination, tableScan, endpointScan, relatedGame, sourceHashes };
}

// ── 9. Checks ─────────────────────────────────────────────────────────────
function runChecks(inv) {
  const checks = []; const chk = (name, pass, details = "") => checks.push({ name, passed: Boolean(pass), details });
  const { perFile, records, consumers } = inv;
  for (const f of perFile) { const d = f.sf.parseDiagnostics ?? []; chk(`parse:${f.file}`, d.length === 0, d.map((x) => ts.flattenDiagnosticMessageText(x.messageText, "\n")).join("; ")); }
  const unclassified = records.filter((r) => !CLASSES.has(r.classification));
  chk("all-records-classified", unclassified.length === 0, unclassified.map((r) => `${r.id}(${r.kind})`).join(", "));
  const unknownKinds = records.filter((r) => r.kind === "unknown-statement");
  chk("no-unknown-top-level-statements", unknownKinds.length === 0, unknownKinds.map((r) => r.id).join(", "));
  for (const f of perFile) {
    const mapped = new Set(f.records.map((r) => `${r.line_start}-${r.line_end}`));
    const missing = f.covered.filter(([a, b]) => !mapped.has(`${a}-${b}`));
    chk(`coverage:${f.file}`, missing.length === 0 && f.records.length >= f.stmtCount, `statements=${f.stmtCount} records=${f.records.length} unmapped=${missing.length}`);
  }
  // independent (non-AST) cross-checks
  for (const f of perFile) {
    if (f.kind === "route") {
      const rx = (f.text.match(/^router\.(get|post|put|patch|delete|head|options|all)\s*\(/gm) ?? []).length;
      const ast = f.records.filter((r) => r.kind === "route-handler").length;
      chk(`independent-route-count:${f.file}`, rx === ast, `regex=${rx} ast=${ast}`);
    }
    const fx = (f.text.match(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+[A-Za-z_$][\w$]*/gm) ?? []).length;
    const fa = f.records.filter((r) => r.kind === "function").length;
    chk(`independent-function-count:${f.file}`, fx === fa, `regex=${fx} ast=${fa}`);
    const ix = (f.text.match(/^(?:export\s+)?(?:interface|type)\s+[A-Za-z_$][\w$]*/gm) ?? []).length;
    const ia = f.records.filter((r) => r.kind === "interface" || r.kind === "type").length;
    chk(`independent-type-count:${f.file}`, ix === ia, `regex=${ix} ast=${ia}`);
    const cx = (f.text.match(/^(?:export\s+)?const\s+[A-Za-z_$][\w$]*/gm) ?? []).length;
    const ca = f.records.filter((r) => r.kind === "constant" || r.kind === "arrow-function" || r.kind === "router-instance").length;
    chk(`independent-const-count:${f.file}`, cx === ca, `regex=${cx} ast=${ca}`);
  }
  const malformed = records.filter((r) => !(r.line_start > 0 && r.line_end >= r.line_start) || !/^[0-9a-f]{64}$/.test(r.fingerprint_sha256 ?? "") || !/^[0-9a-f]{64}$/.test(r.raw_sha256 ?? ""));
  chk("records-have-ranges-and-fingerprints", malformed.length === 0, malformed.map((r) => r.id).join(", "));
  const ids = new Set(); const dup = []; for (const r of records) { if (ids.has(r.id)) dup.push(r.id); ids.add(r.id); }
  chk("record-ids-unique", dup.length === 0, dup.join(", "));
  const silent = records.filter((r) => r.touches_db && !(r.operations.db?.length || r.operations.raw_sql?.length || r.tables.length));
  chk("db-touching-records-enumerate-operations", silent.length === 0, silent.map((r) => r.id).join(", "));
  const badRoutes = records.filter((r) => r.kind === "route-handler" && (!r.method || !r.route_path || !Array.isArray(r.middleware) || typeof r.branch_total !== "number"));
  chk("route-handlers-complete", badRoutes.length === 0, badRoutes.map((r) => r.id).join(", "));
  chk("census-non-empty", records.some((r) => r.kind === "route-handler") && records.some((r) => r.kind === "function") && perFile.every((f) => f.records.length > 0), `records=${records.length}`);
  const noCons = records.filter((r) => r.exported && !Array.isArray(r.external_consumers));
  chk("exported-symbols-have-consumer-inventory", noCons.length === 0, noCons.map((r) => r.id).join(", "));
  chk("consumer-scan-found-consumers", consumers.length > 0, `consumers=${consumers.length}`);
  // every roadmap-required behavior must be evidenced by at least one source symbol
  for (const b of REQUIRED_BEHAVIORS) {
    const n = records.filter((r) => r.behavior_domain === b).length;
    chk(`required-behavior-present:${b}`, n > 0, `records=${n}`);
  }
  // each in-scope source file must contribute; frontend sources must be classified into a behavior (not left as shared-support only)
  for (const f of perFile) chk(`file-contributes-behaviors:${f.file}`, f.records.some((r) => r.behavior_domain !== "shared-support"), "");
  // every route middleware guard is enumerated (no unguarded route slips through unrecorded)
  const routes = records.filter((r) => r.kind === "route-handler");
  const unguarded = routes.filter((r) => !r.middleware.length).map((r) => r.id);
  chk("routes-with-no-middleware-enumerated", true, `unguarded=${unguarded.length}${unguarded.length ? `: ${unguarded.join(", ")}` : ""}`);
  // route-table reconciliation: every drizzle/sql table touched is listed
  chk("table-scan-derived-from-source", inv.tableScan.tables.length > 0, `tables=${inv.tableScan.tables.join(",")}`);
  chk("endpoint-caller-scan-derived-from-source", inv.endpointScan.route_paths.length > 0, `route_paths=${inv.endpointScan.route_paths.length} callers=${inv.endpointScan.callers.length}`);
  chk("all-fixed-sources-present", FIXED_SOURCES.every((p) => fs.existsSync(path.join(ROOT, p))), FIXED_SOURCES.filter((p) => !fs.existsSync(path.join(ROOT, p))).join(", "));
  chk("db-access-detected-in-every-game-route", records.filter((r) => /routes\/game-entries\.ts$|routes\/marketplace-game\.ts$/.test(r.file) && r.kind === "route-handler").every((r) => r.touches_db), "every game route handler must enumerate DB access (sql.raw and pool.query included)");
  chk("marketplace-tables-derived-from-string-sql", inv.records.some((r) => /marketplace-game\.ts$/.test(r.file) && (r.operations.raw_sql ?? []).some((q) => q.tables.includes("game_market_listings"))), "pool.query(\"...\") string-literal SQL must be parsed into tables");
  chk("related-game-files-recorded", Array.isArray(inv.relatedGame), `related=${inv.relatedGame.length}`);
  chk("destination-context-recorded", inv.destination.every((d) => d.exists), inv.destination.map((d) => `${d.file}:${d.exists}`).join(", "));
  return checks;
}

function selfTests() {
  const out = []; const t = (name, pass, details = "") => out.push({ name, passed: Boolean(pass), details });
  t("selftest:unrecognised-symbol-is-unclassified", classifySymbol({ kind: "constant", name: "MYSTERY", initializer_kind: "call-other", operations: {}, branch_total: 0 }).classification === "UNCLASSIFIED");
  t("selftest:db-function-not-domain", classifySymbol({ kind: "function", name: "doThing", operations: { db: ["db.update"] }, touches_db: true, branch_total: 9 }).classification === "application");
  t("selftest:pure-function-is-domain", classifySymbol({ kind: "function", name: "calcAge", operations: {}, touches_db: false, branch_total: 1 }).classification === "domain");
  t("selftest:jsx-function-is-ui-adapter", classifySymbol({ kind: "function", name: "AccountCard", operations: {}, renders_jsx: true, branch_total: 3 }).classification === "adapter");
  const src = 'import { db, tTable } from "@workspace/db";\nrouter.post("/x", requireAuth, async (req, res) => { if (!req.body.a) { res.status(400).json({ error: "bad" }); return; } await db.insert(tTable).values({}); res.json({}); });';
  const sf = parse("synthetic.ts", src); const a = analyze(sf.statements[1], sf, importsOf(sf));
  t("selftest:ast-detects-db-branch-status", a.touches_db && a.operations.db?.includes("db.insert") && a.branches.if === 1 && a.response_statuses.includes(400) && a.error_literals.includes("bad") && a.request_inputs.includes("req.body.a"));
  const tsx = 'function C(){ const [x,setX]=useState(0); const r = customFetch("/api/game-entries"); return <div>{x?1:2}</div>; }';
  const sf2 = parse("synthetic.tsx", tsx); const b = analyze(sf2.statements[0], sf2, importsOf(sf2));
  t("selftest:ast-detects-jsx-hook-api-call", b.renders_jsx && b.operations.hook?.includes("useState") && b.operations["api-client"]?.includes("customFetch") && b.api_endpoints_called.length === 1 && b.react_state_vars.includes("x") && b.branches.ternary === 1);
  const rawSrc = 'import { db } from "@workspace/db";\nimport { sql } from "drizzle-orm";\nasync function f(id: number){ return db.execute(sql.raw(`SELECT id FROM game_entries WHERE id = ${id}`)); }';
  const sf3 = parse("/x/routes/synthetic.ts", rawSrc); const c = analyze(sf3.statements[2], sf3, importsOf(sf3));
  t("selftest:string-built-sql-detected", c.touches_db && c.operations.raw_sql?.some((q) => q.string_built && q.tables.includes("game_entries")));
  t("selftest:bypass-detector-rejects-flags", ["--skip-tests", "--force-pass", "--continue-on-error", "--skip"].every((f) => rejectBypassArgs([f]).length > 0));
  t("selftest:behavior-mapping-game", behaviorOf("artifacts/api-server/src/routes/game-entries.ts", "requireGameEntryOwnership") === "ownership" && behaviorOf("artifacts/api-server/src/routes/game-entries.ts", "GET /game-entries/:id", "/game-entries/:id", "GET") === "access" && behaviorOf("artifacts/api-server/src/routes/marketplace-game.ts", "POST /marketplace/game/buy", "/marketplace/game/buy", "POST") === "marketplace-boundary" && behaviorOf("artifacts/ayzen/src/components/game-entries.tsx", "TagInput") === "metadata" && behaviorOf("artifacts/ayzen/src/components/game-entries.tsx", "GameEntry") === "vault-entity");
  t("selftest:string-literal-sql-parsed", (() => { const s = 'import { pool } from "@workspace/db";\nasync function f(){ return pool.query("UPDATE marketplace_wallets SET balance=balance-$1 WHERE user_id=$2", [1,2]); }'; const f = parse("/x/routes/synthetic.ts", s); const r = analyze(f.statements[1], f, importsOf(f)); return r.touches_db && r.operations.raw_sql?.some((q) => q.tables.includes("marketplace_wallets") && q.parameterized && !q.string_built); })());
  return out;
}
function rejectBypassArgs(args) { // pure helper for the self-test (mirrors gap-common.rejectBypass on an explicit arg list)
  const rx = /^--(skip|skip-validation|skip-tests|force|force-pass|ignore-failures|continue-on-error|no-verify|bypass|disable|dry-run|pass|assume-pass|no-tests|allow-failure)/i;
  return args.filter((a) => rx.test(a));
}

// ── 10. Baseline snapshot (pre-extraction freeze) ─────────────────────────
function writeBaseline(inv) {
  fs.mkdirSync(path.join(BASELINE_DIR, "sources"), { recursive: true });
  const manifest = [];
  for (const f of [...SOURCES, ...DESTINATION_CONTEXT]) {
    const dst = path.join(BASELINE_DIR, "sources", f.replace(/\//g, "__"));
    fs.copyFileSync(path.join(ROOT, f), dst);
    manifest.push({ file: f, baseline_copy: rel(dst), sha256: inv.sourceHashes[f], lines: read(f).split("\n").length });
  }
  const consumerCopies = [...new Set(inv.consumers.filter((c) => c.consumer_kind !== "source" || true).map((c) => c.consumer))];
  fs.writeFileSync(path.join(BASELINE_DIR, "repo-manifest.json"), `${JSON.stringify({
    sub_phase: SUB_PHASE, purpose: "Frozen pre-extraction sources for OLD→NEW differential proof in 04-B/04-D.",
    sources: manifest, consumer_files: consumerCopies.map((c) => ({ file: c, sha256: sha256(fs.readFileSync(path.join(ROOT, c), "utf8")) })),
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(BASELINE_DIR, "symbol-inventory.pre-extraction.json"), `${JSON.stringify(inv.records.map((r) => ({ id: r.id, kind: r.kind, fingerprint_sha256: r.fingerprint_sha256, line_start: r.line_start, line_end: r.line_end })), null, 2)}\n`);
}

// ── 11. Summary / main ────────────────────────────────────────────────────
function summarize(inv) {
  const tally = (k) => inv.records.reduce((m, r) => ((m[r[k]] = (m[r[k]] ?? 0) + 1), m), {});
  const routes = inv.records.filter((r) => r.kind === "route-handler");
  const perFile = Object.fromEntries(inv.perFile.map((f) => [f.file, { kind: f.kind, lines: f.lineCount, records: f.records.length }]));
  return {
    files: inv.perFile.length, total_records: inv.records.length, per_file: perFile,
    by_kind: tally("kind"), by_classification: tally("classification"), by_behavior_domain: tally("behavior_domain"),
    required_behaviors: Object.fromEntries(REQUIRED_BEHAVIORS.map((b) => [b, inv.records.filter((r) => r.behavior_domain === b).map((r) => r.id)])),
    route_handlers: routes.length,
    routes_with_business_behavior: routes.filter((r) => r.business_behavior_in_route).length,
    routes_touching_db: routes.filter((r) => r.touches_db).length,
    routes_total_branches: routes.reduce((a, r) => a + r.branch_total, 0),
    ui_components_with_api_calls: inv.records.filter((r) => r.renders_jsx && r.api_endpoints_called.length).map((r) => r.name),
    external_consumer_files: new Set(inv.consumers.map((c) => c.consumer)).size, external_consumer_edges: inv.consumers.length,
    db_tables: inv.tableScan.tables, table_consumer_files: inv.tableScan.consumers.length,
    endpoint_caller_files: inv.endpointScan.callers.length,
    destination_state: inv.destination.map((d) => ({ file: d.file, holds_business_logic: d.holds_business_logic, exports: d.exports })),
    findings_high: inv.findings.filter((f) => f.severity === "HIGH").length, findings_low: inv.findings.filter((f) => f.severity === "LOW").length, findings_info: inv.findings.filter((f) => f.severity === "INFO").length,
  };
}
const hashBody = (inv) => JSON.stringify({ sourceHashes: inv.sourceHashes, records: inv.records, consumers: inv.consumers, findings: inv.findings, destination: inv.destination, tableScan: inv.tableScan, endpointScan: inv.endpointScan, relatedGame: inv.relatedGame });

function main() {
  const verify = process.argv.includes("--verify"); const started = Date.now();
  if (verify) {
    if (!fs.existsSync(EVIDENCE_FILE)) fail("evidence missing: run the validator without --verify first");
    const ev = JSON.parse(fs.readFileSync(EVIDENCE_FILE, "utf8")); const inv = buildInventory(); const b = binding(inv.sourceHashes); const problems = [];
    if (ev.sub_phase !== SUB_PHASE) problems.push("sub_phase mismatch");
    if (ev.commit_sha !== b.commit_sha) problems.push(`commit_sha mismatch (${ev.commit_sha} vs ${b.commit_sha})`);
    if (ev.source_tree_sha256 !== b.source_tree_sha256) problems.push("source tree changed since evidence was generated (stale)");
    if (ev.inventory_sha256 !== sha256(hashBody(inv))) problems.push("inventory content does not match a fresh census (tampered or stale)");
    const stored = sha256(JSON.stringify({ sourceHashes: ev.source_hashes, records: ev.records, consumers: ev.consumers, findings: ev.findings, destination: ev.destination_context, tableScan: ev.table_consumers, endpointScan: ev.endpoint_callers, relatedGame: ev.related_game_files }));
    if (stored !== ev.inventory_sha256) problems.push("stored evidence body was edited after generation (hash mismatch)");
    if (ev.validator_sha256 !== sha256(fs.readFileSync(SELF, "utf8"))) problems.push("evidence was produced by a different validator version");
    if (ev.status !== "PASS") problems.push(`recorded status is ${ev.status}`);
    if (problems.length) fail(`evidence rejected: ${problems.join("; ")}`);
    console.log(`${SUB_PHASE} evidence verified against current source (${b.commit_binding})`);
    return;
  }

  const inv = buildInventory(); const inv2 = buildInventory();
  const reproducible = hashBody(inv) === hashBody(inv2);
  const checks = runChecks(inv);
  checks.push({ name: "census-reproducible", passed: reproducible, details: reproducible ? "" : "two consecutive runs differ" });
  checks.push(...selfTests());
  const failed = checks.filter((c) => !c.passed); const b = binding(inv.sourceHashes);

  const evidence = {
    phase: PHASE, sub_phase: SUB_PHASE,
    commit_sha: b.commit_sha, commit_binding: b.commit_binding, source_tree_sha256: b.source_tree_sha256,
    validator_version: VALIDATOR_VERSION, validator_sha256: sha256(fs.readFileSync(SELF, "utf8")),
    generated_at: new Date().toISOString(),
    source_hashes: inv.sourceHashes,
    commands: [`node scripts/antas/vault/gap/validate-vlt-gap-04-A.mjs`],
    exit_codes: { validator: failed.length ? 1 : 0, typescript_parse: inv.perFile.every((f) => (f.sf.parseDiagnostics ?? []).length === 0) ? 0 : 1 },
    symbols_moved: [], consumers_migrated: [],
    old_business_symbols_remaining: inv.records.filter((r) => r.kind !== "router-instance" && r.kind !== "export-assignment").map((r) => r.id),
    duplicate_implementations: [],
    summary: summarize(inv), checks, inventory_sha256: sha256(hashBody(inv)),
    notes: [
      "04-A is a census only: no code was moved; symbols_moved/consumers_migrated are intentionally empty.",
      "duplicate_implementations is computed in 04-B/04-D; it is not asserted here.",
      "Build/typecheck and behavioral differential tests are required from 04-B onward; a frozen pre-extraction baseline is written to baseline/.",
      "vault/domain/game.ts is recorded as destination context: it holds GAME_SENSITIVE_FIELDS and GAME_ENTRY_OWNER_SENTINEL_NONE constants only; no executable business logic has been extracted yet.",
      "Behavior mapping: `access` = the ownership-gated, credit-metered single-entry view (GET /game-entries/:id); `ownership` = gameEntryResource/requireGameEntryOwnership plus the marketplace seller-OR-admin listing engine; `marketplace-boundary` = every route/helper in routes/marketplace-game.ts; `vault-entity` = the GameEntry shape/form mapping in the UI component; `metadata` = category/tags/rank/level handling. No behavior is invented: a required behavior with zero evidencing symbols fails the census.",
      "routes/marketplace-game.ts operates on game_market_listings/marketplace_wallets/marketplace_transactions only; it does not touch game_entries (see findings). Game-entry transfer/copy on sale, if any, is in routes/marketplace-vault.ts, which GAP-02/03-C deferred to GAP-04 and which is NOT a roadmap Source here.",
      "related_game_files lists Game-named files outside the roadmap Sources (pages/user/marketplace-game.tsx, config/vault-game.ts, config/fields/game-create.ts, ...); they are recorded but NOT censused, and need an explicit scope decision before 04-B.",
    ],
    status: failed.length === 0 ? "PASS" : "FAIL",
    findings: inv.findings,
    destination_context: inv.destination, table_consumers: inv.tableScan, endpoint_callers: inv.endpointScan, related_game_files: inv.relatedGame,
    files: inv.perFile.map((f) => ({ file: f.file, kind: f.kind, sha256: inv.sourceHashes[f.file], lines: f.lineCount, top_level_statements: f.stmtCount, records: f.records.length, imports: f.imports })),
    records: inv.records, consumers: inv.consumers,
  };
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(EVIDENCE_FILE, `${JSON.stringify(evidence, null, 2)}\n`);
  writeBaseline(inv);
  for (const f of inv.findings.filter((x) => x.severity === "HIGH")) console.warn(`  FINDING[${f.severity}] ${f.detail}`);
  const s = evidence.summary;
  console.log(`${SUB_PHASE} ${evidence.status} — ${s.total_records} records, ${s.route_handlers} routes, ${s.external_consumer_edges} consumer edges, ${s.table_consumer_files} table-access files (${Date.now() - started}ms)`);
  if (failed.length) { console.error(failed.map((c) => `- ${c.name}: ${c.details || "not satisfied"}`).join("\n")); process.exit(1); }
}
main();
