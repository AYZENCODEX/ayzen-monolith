#!/usr/bin/env node
// VLT-GAP-01-A — Symbol / Behavior Census (source-derived, fail-closed).
// Evidence: reports/antas/vault/gap/VLT-GAP-01/symbol-inventory.json
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const VALIDATOR_VERSION = "1.0.0";
const PHASE = "VLT-GAP-01";
const SUB_PHASE = "VLT-GAP-01-A";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const ROUTES_DIR = "artifacts/api-server/src/routes";
const SOURCES = ["vault.ts", "vault-entity-links.ts", "vault-snapshot.ts", "vault-shares.ts"].map((f) => `${ROUTES_DIR}/${f}`);
const EVIDENCE_DIR = path.join(ROOT, "reports/antas/vault/gap/VLT-GAP-01");
const EVIDENCE_FILE = path.join(EVIDENCE_DIR, "symbol-inventory.json");

// ── 1. Bypass rejection (fail closed) ─────────────────────────────────────
const BYPASS_ARGS = /^--(skip|skip-validation|skip-tests|force|force-pass|ignore-failures|continue-on-error|no-verify|bypass|disable|dry-run|pass|assume-pass|no-tests|allow-failure)/i;
const BYPASS_ENV = /(SKIP|BYPASS|DISABLE|FORCE|IGNORE|NOVALIDATE|ASSUME_PASS|CONTINUE_ON_ERROR)/i;
function rejectBypass() {
  const hits = [];
  for (const a of process.argv.slice(2)) if (BYPASS_ARGS.test(a) && a !== "--verify") hits.push(`arg ${a}`);
  for (const [k, v] of Object.entries(process.env)) {
    if (!/^(ANTAS|VALIDATION|VLT|VAULT|CI_)/i.test(k) && !/^VALIDATION_/i.test(k)) continue;
    if (BYPASS_ENV.test(k) && v && !/^(0|false|no|)$/i.test(v)) hits.push(`env ${k}=${v}`);
  }
  if (process.env.VALIDATION_DISABLED && !/^(0|false|no)$/i.test(process.env.VALIDATION_DISABLED)) hits.push("env VALIDATION_DISABLED");
  const unknown = process.argv.slice(2).filter((a) => a.startsWith("--") && a !== "--verify");
  for (const a of unknown) if (!hits.some((h) => h.endsWith(a))) hits.push(`unknown flag ${a}`);
  return hits;
}
function fail(msg, code = 1) { console.error(`${SUB_PHASE} FAIL — ${msg}`); process.exit(code); }
const bypass = rejectBypass();
if (bypass.length) fail(`bypass mechanism rejected: ${bypass.join(", ")}`);

// ── 2. TypeScript compiler (real AST) ─────────────────────────────────────
function loadTs() {
  const candidates = [() => createRequire(path.join(ROOT, "package.json"))("typescript")];
  candidates.push(() => {
    const g = spawnSync("npm", ["root", "-g"], { encoding: "utf8" });
    if (g.status !== 0) throw new Error("npm root -g failed");
    return createRequire(path.join(g.stdout.trim(), "x.js"))("typescript");
  });
  for (const c of candidates) { try { return c(); } catch { /* next */ } }
  return null;
}
const ts = loadTs();
if (!ts) fail("TypeScript compiler API unavailable; AST census cannot run (fail closed)");

// ── helpers ───────────────────────────────────────────────────────────────
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join("/");
const read = (r) => fs.readFileSync(path.join(ROOT, r), "utf8");
const HTTP = new Set(["get", "post", "put", "patch", "delete", "head", "options", "all"]);

function parse(fileName, text) {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}
const lines = (sf, node) => ({
  start: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
  end: sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
});
// Comment/whitespace-insensitive fingerprint: re-print the node via the token stream.
function semanticFingerprint(node, sf) {
  const toks = [];
  (function walk(n) {
    if (n.getChildCount(sf) === 0 && n.kind !== ts.SyntaxKind.EndOfFileToken) toks.push(n.getText(sf));
    else n.getChildren(sf).forEach(walk);
  })(node);
  return sha256(toks.join(" "));
}
function importsOf(sf) {
  const map = new Map(); // localName -> { module, imported }
  for (const s of sf.statements) {
    if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier)) continue;
    const mod = s.moduleSpecifier.text;
    const c = s.importClause;
    if (!c) continue;
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
  ["crypto", /^(encryptField|decryptField|decryptRows|encryptSeedPhrase|decryptSeedPhrase|createCipheriv|createDecipheriv|scryptSync|scrypt|randomBytes|randomUUID|createHash|createHmac|timingSafeEqual|pbkdf2Sync|generateSerial)$/],
  ["authz", /^(requireAuth|requireAdmin|requireOwnership|authorizeMany|createResourceOwnershipRule|consumeRevealToken|hasNoEntityPin|PolicyEngine)$/],
  ["provider", /^(fetch|axios|request|streamFantasticReceiptPdf)$/],
  ["sync", /^(syncOnVault\w+|delistVaultMarketplaceListings)$/],
  ["storage", /^(readFileSync|writeFileSync|createReadStream|createWriteStream|readFile|writeFile|unlink|download|sendFile)$/],
  ["job", /^(setInterval|setTimeout|schedule|cron)$/],
  ["worth", /^(computeEntityWorth|computeEntityBuyValue|computeEntityProfitPct|computeAge|computeAutoScore|evalHealthRules)$/],
];
const DB_METHODS = new Set(["select", "insert", "update", "delete", "execute", "transaction", "query", "selectDistinct"]);

function analyze(node, sf, imports) {
  const ops = { db: [], sql: [], tables: new Set(), calls: new Map(), branches: { if: 0, else: 0, switch_case: 0, ternary: 0, logical: 0, catch: 0, loop: 0, throw: 0 }, statuses: new Set(), error_literals: new Set(), inputs: new Set(), transactional: false, responses: 0 };
  const cats = {};
  const addCat = (c, n) => { (cats[c] ??= new Set()).add(n); };
  (function walk(n) {
    switch (n.kind) {
      case ts.SyntaxKind.IfStatement: ops.branches.if++; if (n.elseStatement) ops.branches.else++; break;
      case ts.SyntaxKind.CaseClause: case ts.SyntaxKind.DefaultClause: ops.branches.switch_case++; break;
      case ts.SyntaxKind.ConditionalExpression: ops.branches.ternary++; break;
      case ts.SyntaxKind.CatchClause: ops.branches.catch++; break;
      case ts.SyntaxKind.ForStatement: case ts.SyntaxKind.ForOfStatement: case ts.SyntaxKind.ForInStatement: case ts.SyntaxKind.WhileStatement: case ts.SyntaxKind.DoStatement: ops.branches.loop++; break;
      case ts.SyntaxKind.ThrowStatement: ops.branches.throw++; break;
      case ts.SyntaxKind.BinaryExpression: {
        const k = n.operatorToken.kind;
        if (k === ts.SyntaxKind.AmpersandAmpersandToken || k === ts.SyntaxKind.BarBarToken || k === ts.SyntaxKind.QuestionQuestionToken) ops.branches.logical++;
        break;
      }
      case ts.SyntaxKind.PropertyAccessExpression: {
        const t = n.expression.getText(sf);
        if (/^req(uest)?$/.test(t) || /^req\.(params|query|body)$/.test(t)) {
          if (/^req\.(params|query|body)$/.test(t)) ops.inputs.add(`${t}.${n.name.text}`);
          else if (["params", "query", "body", "headers", "cookies"].includes(n.name.text)) ops.inputs.add(`req.${n.name.text}`);
        }
        break;
      }
      case ts.SyntaxKind.Identifier: {
        const t = n.text;
        if (/Table$/.test(t) && imports.get(t)?.module?.startsWith("@workspace/db")) ops.tables.add(t);
        break;
      }
      case ts.SyntaxKind.TaggedTemplateExpression: {
        if (n.tag.getText(sf) === "sql") {
          const raw = n.template.getText(sf);
          const verbs = [...raw.matchAll(/\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|WITH|CREATE|ALTER|DROP|TRUNCATE)\b/gi)].map((m) => m[1].toUpperCase().replace(/\s+/g, " "));
          const tabs = [...raw.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+"?([a-z_][a-z0-9_.]*)"?/gi)].map((m) => m[1].toLowerCase()).filter((t) => !["set", "select", "lateral"].includes(t));
          ops.sql.push({ verbs: [...new Set(verbs)], tables: [...new Set(tabs)] });
        }
        break;
      }
      case ts.SyntaxKind.CallExpression: {
        const callee = n.expression;
        let name = null, root = null, member = null;
        if (ts.isIdentifier(callee)) { name = callee.text; root = name; }
        else if (ts.isPropertyAccessExpression(callee)) {
          member = callee.name.text; name = member;
          let r = callee.expression; while (ts.isPropertyAccessExpression(r) || ts.isCallExpression(r)) r = ts.isCallExpression(r) ? r.expression : r.expression;
          root = ts.isIdentifier(r) ? r.text : null;
        }
        if (name) {
          const imp = root ? imports.get(root) : undefined;
          if (imp || (root && !["res", "req", "Math", "JSON", "Object", "Array", "String", "Number", "Date", "Buffer", "Promise", "Set", "Map"].includes(root))) {
            const key = imp ? `${imp.module}::${imp.imported === "*" || imp.imported === "default" ? name : imp.imported}` : `local::${name}`;
            ops.calls.set(key, (ops.calls.get(key) ?? 0) + 1);
          }
          if ((root === "db" || root === "tx" || root === "pool" || root === "client") && member && DB_METHODS.has(member)) {
            ops.db.push(`${root}.${member}`);
            if (member === "transaction") ops.transactional = true;
          }
          for (const [cat, rx] of CATEGORY_BY_CALLEE) if (rx.test(name)) addCat(cat, name);
          if (root === "crypto" || root === "nodeCrypto") addCat("crypto", `crypto.${name}`);
          if (root === "fs") addCat("storage", `fs.${name}`);
          if (root === "res" && ["json", "send", "end", "download", "redirect", "sendFile", "write", "pipe"].includes(name)) ops.responses++;
          if (root === "res" && name === "status" && n.arguments[0] && ts.isNumericLiteral(n.arguments[0])) ops.statuses.add(Number(n.arguments[0].text));
        }
        break;
      }
      case ts.SyntaxKind.PropertyAssignment: {
        const pn = n.name.getText(sf);
        if ((pn === "error" || pn === "message") && ts.isStringLiteralLike(n.initializer)) ops.error_literals.add(n.initializer.text);
        break;
      }
      default: break;
    }
    ts.forEachChild(n, walk);
  })(node);
  const cat = Object.fromEntries(Object.entries(cats).map(([k, v]) => [k, [...v].sort()]));
  const dbOps = [...new Set(ops.db)].sort();
  if (dbOps.length) cat.db = dbOps;
  if (ops.sql.length) cat.raw_sql = ops.sql;
  return {
    operations: cat,
    tables: [...ops.tables].sort(),
    external_calls: [...ops.calls.entries()].map(([k, c]) => ({ target: k, count: c })).sort((a, b) => a.target.localeCompare(b.target)),
    branches: ops.branches,
    branch_total: Object.values(ops.branches).reduce((a, b) => a + b, 0),
    response_statuses: [...ops.statuses].sort((a, b) => a - b),
    error_literals: [...ops.error_literals].sort(),
    request_inputs: [...ops.inputs].sort(),
    transactional: ops.transactional,
    response_calls: ops.responses,
    touches_db: dbOps.length > 0 || ops.sql.length > 0 || ops.tables.size > 0,
  };
}

// ── 4. Classification (rule-based; no rule ⇒ UNCLASSIFIED ⇒ FAIL) ────────
const CLASSES = new Set(["domain", "application", "security", "infrastructure", "API", "adapter", "legacy"]);
function behaviorDomain(file, name, routePath) {
  const base = path.basename(file, ".ts");
  if (name === "autoCreateLocalAccountsForEntity") return "local-account";
  if (base === "vault-entity-links") return /Resource$|Ownership|ownsEntity/.test(name ?? "") ? "ownership-resource-builders" : "entity-links";
  if (base === "vault-shares") return "share";
  if (base === "vault-snapshot") return "snapshot";
  if (routePath) {
    if (/^\/admin\//.test(routePath)) return "admin";
    if (/health/.test(routePath)) return "health";
    if (/analytics|gas/.test(routePath)) return "entity-calculations";
    if (/receipt/.test(routePath)) return "receipt";
    if (/seed|wallet|validate-key/.test(routePath)) return "secret-wallet";
    if (/activity|field-history/.test(routePath)) return "activity";
    return "entity-crud";
  }
  if (/Resource$|Ownership|BulkOwnership/.test(name ?? "")) return "ownership-resource-builders";
  if (/Health|health/.test(name ?? "")) return "health";
  if (/Receipt/.test(name ?? "")) return "receipt";
  if (/Gas|addresses/.test(name ?? "")) return "entity-calculations";
  if (/^(select|hardDelete|legacyFormat|SAFE_COLS|NEW_VAULT|BASE_VAULT|DATE_FIELDS|SINGLE_FIELD|fieldLabel|BULK_|BRIDGE_|logVaultActivity)/.test(name ?? "")) return "entity-crud";
  return "shared-support";
}
const OWNER_GAP = { "entity-crud": "GAP-01", "ownership-resource-builders": "GAP-01", "entity-links": "GAP-01", "entity-calculations": "GAP-01", "local-account": "GAP-02", "secret-wallet": "GAP-05", snapshot: "GAP-09", share: "GAP-10", health: "GAP-11", admin: "GAP-01", activity: "GAP-01", receipt: "GAP-01", "shared-support": "GAP-01" };

function classifySymbol(rec, node, sf) {
  const n = rec.name ?? "";
  const ops = rec.operations ?? {};
  const has = (c) => Boolean(ops[c]?.length);
  const io = rec.touches_db || has("provider") || has("event") || has("notification") || has("storage") || has("billing") || has("sync");
  const rule = (cls, id) => ({ classification: cls, classification_rule: id });
  if (rec.kind === "router-instance") return rule("adapter", "R01:express-router-instance");
  if (rec.kind === "export-assignment") return rule("adapter", "R02:default-export-router");
  if (rec.kind === "type" || rec.kind === "interface") return rule("domain", "R03:type-declaration");
  if (rec.kind === "rule-registration") return rule("security", "R04:policy-rule-registration");
  if (/^legacy[A-Z]/.test(n)) return rule("legacy", "R05:legacy-prefixed-symbol");
  if (/(Resource|Ownership|OwnershipEngine|_SENTINEL_NONE|denyVault\w+NotFound)$|^(require|audit)\w*Ownership|^ownsEntity$|^denyVault/.test(n)) return rule("security", "R06:ownership-resource-builder");
  if (rec.kind === "function" || rec.kind === "arrow-function") {
    if (/BodyParser$/.test(n)) return rule("adapter", "R07:request-body-parser");
    if (has("crypto") && !io && !rec.touches_db) return rule("security", "R08:crypto-no-io");
    if (rec.touches_db && !has("provider") && !has("event") && !has("notification") && rec.branch_total <= 6 && /^(select|find|hardDelete|store|prune|load|fetch|get)/.test(n)) return rule("infrastructure", "R09:repository-style-data-access");
    if (rec.touches_db || io) return rule("application", "R10:orchestrates-io");
    if (has("audit")) return rule("application", "R11:audit-orchestration");
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
    if (/^(Router|express\.\w+|\w+\.json|\w+\.raw|\w+\.urlencoded)$/.test(t)) return "call-adapter";
    if (/^(Object\.freeze|new Set|Object\.fromEntries|Array\.from)$/.test(t) || /^(Object|Array)\./.test(t)) return "call-pure";
    return "call-other";
  }
  return "other";
}

// ── 5. Per-file census ────────────────────────────────────────────────────
function censusFile(relFile) {
  const text = read(relFile);
  const sf = parse(relFile, text);
  const imports = importsOf(sf);
  const records = [];
  const covered = []; // [start,end] of every non-import top-level statement
  const exportedNames = new Set();
  const stmts = sf.statements.filter((s) => !ts.isImportDeclaration(s));
  const isExported = (s) => (ts.getCombinedModifierFlags?.(s) & ts.ModifierFlags.Export) !== 0 || s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  let routeOrdinal = 0;

  for (const s of stmts) {
    const L = lines(sf, s);
    covered.push([L.start, L.end]);
    const base = { file: relFile, line_start: L.start, line_end: L.end, line_count: L.end - L.start + 1, exported: false };
    const attach = (rec, node) => {
      const a = analyze(node, sf, imports);
      Object.assign(rec, a);
      rec.fingerprint_sha256 = semanticFingerprint(node, sf);
      rec.raw_sha256 = sha256(node.getText(sf));
      return rec;
    };

    if (ts.isFunctionDeclaration(s) && s.name) {
      const rec = attach({ ...base, id: `${relFile}#${s.name.text}`, name: s.name.text, kind: "function", exported: isExported(s) }, s);
      if (rec.exported) exportedNames.add(rec.name);
      rec.async = Boolean(s.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword));
      rec.parameters = s.parameters.map((p) => p.name.getText(sf));
      records.push(rec);
    } else if (ts.isVariableStatement(s)) {
      const exp = isExported(s);
      for (const d of s.declarationList.declarations) {
        const nm = d.name.getText(sf);
        const ik = initializerKind(d.initializer, sf);
        const kind = ik === "arrow-function" ? "arrow-function" : nm === "router" && ik === "call-adapter" ? "router-instance" : "constant";
        const rec = attach({ ...base, id: `${relFile}#${nm}`, name: nm, kind, exported: exp, initializer_kind: ik }, d);
        if (exp) exportedNames.add(nm);
        records.push(rec);
      }
    } else if (ts.isTypeAliasDeclaration(s) || ts.isInterfaceDeclaration(s)) {
      const rec = attach({ ...base, id: `${relFile}#${s.name.text}`, name: s.name.text, kind: ts.isInterfaceDeclaration(s) ? "interface" : "type", exported: isExported(s) }, s);
      if (rec.exported) exportedNames.add(rec.name);
      records.push(rec);
    } else if (ts.isExportAssignment(s)) {
      records.push(attach({ ...base, id: `${relFile}#export-default`, name: "default", kind: "export-assignment", exported: true, exports: s.expression.getText(sf) }, s));
      exportedNames.add("default");
    } else if (ts.isExportDeclaration(s)) {
      records.push(attach({ ...base, id: `${relFile}#export-decl@${L.start}`, name: `export@${L.start}`, kind: "export-assignment", exported: true }, s));
      s.exportClause && ts.isNamedExports(s.exportClause) && s.exportClause.elements.forEach((e) => exportedNames.add(e.name.text));
    } else if (ts.isExpressionStatement(s) && ts.isCallExpression(s.expression)) {
      const call = s.expression;
      const callee = call.expression;
      if (ts.isPropertyAccessExpression(callee) && callee.expression.getText(sf) === "router" && HTTP.has(callee.name.text)) {
        routeOrdinal++;
        const method = callee.name.text.toUpperCase();
        const first = call.arguments[0];
        const routePath = first && ts.isStringLiteralLike(first) ? first.text : null;
        const args = call.arguments.slice(1);
        const handler = args[args.length - 1];
        const middleware = args.slice(0, -1).map((a) => (ts.isIdentifier(a) ? a.text : ts.isCallExpression(a) ? a.expression.getText(sf) + "()" : a.getText(sf).slice(0, 40)));
        const rec = attach({ ...base, id: `${relFile}#route:${method} ${routePath}@${L.start}`, name: `${method} ${routePath}`, kind: "route-handler", method, route_path: routePath, middleware, handler_line_count: handler ? lines(sf, handler).end - lines(sf, handler).start + 1 : 0, handler_is_inline: Boolean(handler && (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler))), ordinal: routeOrdinal }, s);
        rec.classification = "API";
        rec.classification_rule = "R00:express-route-handler";
        rec.business_behavior_in_route = rec.touches_db || rec.branch_total > 0 || ["provider", "event", "notification", "billing", "crypto", "sync", "storage"].some((c) => rec.operations[c]?.length);
        records.push(rec);
      } else if (ts.isPropertyAccessExpression(callee) && callee.name.text === "registerRule") {
        records.push(attach({ ...base, id: `${relFile}#rule@${L.start}`, name: `${callee.expression.getText(sf)}.registerRule`, kind: "rule-registration" }, s));
      } else {
        records.push(attach({ ...base, id: `${relFile}#stmt@${L.start}`, name: `stmt@${L.start}`, kind: "unknown-statement" }, s));
      }
    } else {
      records.push(attach({ ...base, id: `${relFile}#stmt@${L.start}`, name: `stmt@${L.start}`, kind: "unknown-statement" }, s));
    }
  }

  for (const rec of records) {
    if (rec.kind !== "route-handler") Object.assign(rec, classifySymbol(rec));
    rec.behavior_domain = behaviorDomain(relFile, rec.name, rec.route_path);
    rec.owner_gap = OWNER_GAP[rec.behavior_domain] ?? "UNKNOWN";
  }

  // intra-file callers: which other top-level records reference this symbol identifier
  const named = records.filter((r) => r.kind !== "route-handler" && r.kind !== "export-assignment" && r.kind !== "unknown-statement" && r.kind !== "rule-registration");
  const nodeByLine = new Map(stmts.map((s) => [lines(sf, s).start, s]));
  for (const r of named) {
    const users = new Set();
    for (const o of records) {
      if (o === r) continue;
      const node = nodeByLine.get(o.line_start);
      if (!node) continue;
      let found = false;
      (function w(x) { if (found) return; if (ts.isIdentifier(x) && x.text === r.name) { found = true; return; } ts.forEachChild(x, w); })(node);
      if (found) users.add(o.id);
    }
    r.intra_file_callers = [...users].sort();
  }
  return {
    file: relFile, records, exportedNames: [...exportedNames], covered,
    imports: [...imports.entries()].map(([local, v]) => ({ local, ...v })),
    stmtCount: stmts.length, sf, text,
    lineCount: text.split("\n").length,
  };
}

// ── 6. Repository-wide consumer scan ──────────────────────────────────────
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "reports", "build", "coverage", ".next", ".turbo"]);
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}
function consumerScan(census) {
  const targets = new Map(SOURCES.map((s) => [s.replace(/\.ts$/, ""), s]));
  const baseNames = new Map(SOURCES.map((s) => [path.basename(s, ".ts"), s]));
  const all = walk(ROOT);
  const prefilter = /(vault-entity-links|vault-snapshot|vault-shares|\/vault["'`.]|routes\/vault)/;
  const consumers = [];
  for (const abs of all) {
    const r = rel(abs);
    if (SOURCES.includes(r)) continue;
    let text;
    try { text = fs.readFileSync(abs, "utf8"); } catch { continue; }
    if (!prefilter.test(text)) continue;
    const sf = parse(abs, text);
    const hits = [];
    const resolveSpec = (spec) => {
      if (spec.startsWith(".")) {
        const p = path.resolve(path.dirname(abs), spec.replace(/\.(js|ts|mjs)$/, ""));
        return targets.get(rel(p)) ?? null;
      }
      const m = spec.match(/(?:^|\/)routes\/(vault(?:-entity-links|-snapshot|-shares)?)(?:\.(?:js|ts))?$/);
      return m ? baseNames.get(m[1]) ?? null : null;
    };
    (function scan(n) {
      let spec = null, kind = null, names = [];
      if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
        spec = n.moduleSpecifier.text; kind = n.importClause?.isTypeOnly ? "import-type" : "import";
        const c = n.importClause;
        if (c?.name) names.push({ imported: "default", local: c.name.text });
        if (c?.namedBindings) { if (ts.isNamespaceImport(c.namedBindings)) names.push({ imported: "*", local: c.namedBindings.name.text }); else c.namedBindings.elements.forEach((e) => names.push({ imported: (e.propertyName ?? e.name).text, local: e.name.text })); }
      } else if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
        spec = n.moduleSpecifier.text; kind = "re-export";
        if (n.exportClause && ts.isNamedExports(n.exportClause)) n.exportClause.elements.forEach((e) => names.push({ imported: (e.propertyName ?? e.name).text, local: e.name.text })); else names.push({ imported: "*", local: "*" });
      } else if (ts.isCallExpression(n) && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0]) && ((n.expression.kind === ts.SyntaxKind.ImportKeyword) || (ts.isIdentifier(n.expression) && n.expression.text === "require"))) {
        spec = n.arguments[0].text; kind = n.expression.kind === ts.SyntaxKind.ImportKeyword ? "dynamic-import" : "require"; names.push({ imported: "*", local: "?" });
      }
      if (spec) {
        const target = resolveSpec(spec);
        if (target) hits.push({ kind, specifier: spec, target, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, names });
      }
      ts.forEachChild(n, scan);
    })(sf);
    for (const h of hits) {
      const uses = {};
      for (const nm of h.names) {
        if (nm.local === "*" || nm.local === "?") continue;
        let c = 0;
        (function w(x) { if (ts.isIdentifier(x) && x.text === nm.local && !(x.parent && (ts.isImportSpecifier(x.parent) || ts.isImportClause(x.parent) || ts.isNamespaceImport(x.parent)))) c++; ts.forEachChild(x, w); })(sf);
        uses[nm.local] = c;
      }
      consumers.push({ consumer: r, consumer_kind: /(^|\/)(tests?|__tests__)\/|\.(test|spec)\./.test(r) ? "test" : /^scripts\//.test(r) ? "script" : "source", ...h, local_usage_counts: uses, unused_import: Object.values(uses).length > 0 && Object.values(uses).every((c) => c === 0) });
    }
  }
  consumers.sort((a, b) => a.consumer.localeCompare(b.consumer) || a.line - b.line);
  return consumers;
}

// ── 7. Git / source-binding ───────────────────────────────────────────────
function gitSha() {
  const r = spawnSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}
function binding(sourceHashes) {
  const sha = gitSha();
  const treeHash = sha256(Object.entries(sourceHashes).sort().map(([k, v]) => `${k}:${v}`).join("\n"));
  return sha ? { commit_sha: sha, commit_binding: "git-head", source_tree_sha256: treeHash }
             : { commit_sha: null, commit_binding: "source-tree-hash (no git repository available)", source_tree_sha256: treeHash };
}

// ── 8. Core build (deterministic; no timestamps inside the hashed body) ──
function buildInventory() {
  const perFile = SOURCES.map((s) => {
    if (!fs.existsSync(path.join(ROOT, s))) fail(`required source missing: ${s}`);
    return censusFile(s);
  });
  const records = perFile.flatMap((f) => f.records);
  const consumers = consumerScan(perFile);
  // exported-symbol → external consumers
  for (const f of perFile) for (const r of f.records) {
    if (!r.exported) { r.external_consumers = []; continue; }
    const name = r.name;
    r.external_consumers = consumers.filter((c) => c.target === f.file && c.names.some((n) => n.imported === name || (n.imported === "*" && true) || (name === "default" && n.imported === "default")))
      .map((c) => ({ consumer: c.consumer, kind: c.kind, line: c.line })).sort((a, b) => a.consumer.localeCompare(b.consumer));
  }
  const exportsByFile = new Map(perFile.map((f) => [f.file, new Set(f.exportedNames)]));
  const findings = [];
  for (const c of consumers) {
    const ex = exportsByFile.get(c.target);
    for (const n of c.names) {
      if (n.imported === "*") { n.resolved = true; continue; }
      n.resolved = ex.has(n.imported);
      if (!n.resolved) findings.push({
        id: `dangling-import:${c.consumer}:${n.imported}`,
        severity: "HIGH",
        kind: "consumer-imports-symbol-not-exported-by-target",
        consumer: c.consumer, line: c.line, target: c.target, symbol: n.imported,
        detail: `${c.consumer}:${c.line} imports "${n.imported}" from ${c.target}, which does not export it (would not typecheck/link).`,
      });
    }
    if (c.unused_import) findings.push({ id: `unused-import:${c.consumer}:${c.target}`, severity: "LOW", kind: "unused-import-of-vault-route", consumer: c.consumer, line: c.line, target: c.target, detail: "import is never referenced" });
  }
  findings.sort((a, b) => a.id.localeCompare(b.id));
  const sourceHashes = Object.fromEntries(perFile.map((f) => [f.file, sha256(f.text)]));
  return { perFile, records, consumers, findings, sourceHashes };
}

// ── 9. Checks ─────────────────────────────────────────────────────────────
function runChecks(inv) {
  const checks = [];
  const chk = (name, pass, details = "") => checks.push({ name, passed: Boolean(pass), details });
  const { perFile, records, consumers } = inv;

  // C1 — every source parsed with 0 syntax diagnostics
  for (const f of perFile) {
    const diags = f.sf.parseDiagnostics ?? [];
    chk(`parse:${f.file}`, diags.length === 0, diags.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")).join("; "));
  }
  // C2 — no unclassified / unknown records
  const unclassified = records.filter((r) => !CLASSES.has(r.classification));
  chk("all-records-classified", unclassified.length === 0, unclassified.map((r) => `${r.id}(${r.kind})`).join(", "));
  const unknownKinds = records.filter((r) => r.kind === "unknown-statement");
  chk("no-unknown-top-level-statements", unknownKinds.length === 0, unknownKinds.map((r) => r.id).join(", "));
  // C3 — coverage: every non-import top-level statement mapped to ≥1 record, and record count reconciles
  for (const f of perFile) {
    const mapped = new Set(f.records.map((r) => `${r.line_start}-${r.line_end}`));
    const missing = f.covered.filter(([a, b]) => !mapped.has(`${a}-${b}`));
    chk(`coverage:${f.file}`, missing.length === 0 && f.records.length >= f.stmtCount, `statements=${f.stmtCount} records=${f.records.length} unmapped=${missing.length}`);
  }
  // C4 — independent (non-AST) cross-checks
  for (const f of perFile) {
    const rx = (f.text.match(/^router\.(get|post|put|patch|delete|head|options|all)\s*\(/gm) ?? []).length;
    const ast = f.records.filter((r) => r.kind === "route-handler").length;
    chk(`independent-route-count:${f.file}`, rx === ast, `regex=${rx} ast=${ast}`);
    const fx = (f.text.match(/^(?:export\s+)?(?:async\s+)?function\s+[A-Za-z_$][\w$]*/gm) ?? []).length;
    const fa = f.records.filter((r) => r.kind === "function").length;
    chk(`independent-function-count:${f.file}`, fx === fa, `regex=${fx} ast=${fa}`);
  }
  // C5 — every record has range, fingerprints, callers array
  const malformed = records.filter((r) => !(r.line_start > 0 && r.line_end >= r.line_start) || !/^[0-9a-f]{64}$/.test(r.fingerprint_sha256 ?? "") || !/^[0-9a-f]{64}$/.test(r.raw_sha256 ?? ""));
  chk("records-have-ranges-and-fingerprints", malformed.length === 0, malformed.map((r) => r.id).join(", "));
  // C6 — unique ids
  const ids = new Set(); const dup = [];
  for (const r of records) { if (ids.has(r.id)) dup.push(r.id); ids.add(r.id); }
  chk("record-ids-unique", dup.length === 0, dup.join(", "));
  // C7 — every DB-touching record lists operations/tables (no silent DB access)
  const silent = records.filter((r) => r.touches_db && !(r.operations.db?.length || r.operations.raw_sql?.length || r.tables.length));
  chk("db-touching-records-enumerate-operations", silent.length === 0, silent.map((r) => r.id).join(", "));
  // C8 — every route handler has method, path, middleware list, branch metrics
  const badRoutes = records.filter((r) => r.kind === "route-handler" && (!r.method || !r.route_path || !Array.isArray(r.middleware) || typeof r.branch_total !== "number"));
  chk("route-handlers-complete", badRoutes.length === 0, badRoutes.map((r) => r.id).join(", "));
  // C9 — non-empty census
  chk("census-non-empty", records.length > 0 && records.some((r) => r.kind === "route-handler") && records.some((r) => r.kind === "function"), `records=${records.length}`);
  // C10 — every exported symbol has consumer info (may be empty but must be enumerated)
  const noCons = records.filter((r) => r.exported && !Array.isArray(r.external_consumers));
  chk("exported-symbols-have-consumer-inventory", noCons.length === 0, noCons.map((r) => r.id).join(", "));
  // C11 — consumer scan is repository-derived
  chk("consumer-scan-found-consumers", consumers.length > 0, `consumers=${consumers.length}`);
  // C12 — every non-router domain in scope has an owning GAP
  const noOwner = records.filter((r) => !r.owner_gap || r.owner_gap === "UNKNOWN");
  chk("every-record-has-owner-gap", noOwner.length === 0, noOwner.map((r) => r.id).join(", "));
  return checks;
}

// Mutation self-tests: prove the validator cannot silently accept bad input.
function selfTests() {
  const results = [];
  const t = (name, pass, details = "") => results.push({ name, passed: Boolean(pass), details });
  // (a) an unrecognised constant shape must be UNCLASSIFIED
  const c1 = classifySymbol({ kind: "constant", name: "MYSTERY", initializer_kind: "call-other", operations: {}, branch_total: 0 });
  t("selftest:unrecognised-symbol-is-unclassified", c1.classification === "UNCLASSIFIED");
  // (b) a DB-touching helper must not classify as pure domain
  const c2 = classifySymbol({ kind: "function", name: "doThing", operations: { db: ["db.update"] }, touches_db: true, branch_total: 9 });
  t("selftest:db-function-not-domain", c2.classification === "application");
  // (c) a pure function classifies as domain
  const c3 = classifySymbol({ kind: "function", name: "fieldLabel", operations: {}, touches_db: false, branch_total: 1 });
  t("selftest:pure-function-is-domain", c3.classification === "domain");
  // (d) AST analysis detects db + branches + status in a synthetic route body
  const src = 'import { db, tTable } from "@workspace/db";\nrouter.post("/x", requireAuth, async (req, res) => { if (!req.body.a) { res.status(400).json({ error: "bad" }); return; } await db.insert(tTable).values({}); res.json({}); });';
  const sf = parse("synthetic.ts", src);
  const a = analyze(sf.statements[1], sf, importsOf(sf));
  t("selftest:ast-detects-db-branch-status", a.touches_db && a.operations.db?.includes("db.insert") && a.branches.if === 1 && a.response_statuses.includes(400) && a.error_literals.includes("bad") && a.request_inputs.includes("req.body.a"), JSON.stringify({ db: a.operations.db, b: a.branches }));
  // (e) bypass detector rejects a bypass flag
  t("selftest:bypass-regex-rejects-skip-tests", BYPASS_ARGS.test("--skip-tests") && BYPASS_ARGS.test("--force-pass") && BYPASS_ARGS.test("--continue-on-error"));
  return results;
}

// ── 10. Main ──────────────────────────────────────────────────────────────
function summarize(inv) {
  const byKind = {}, byClass = {}, byDomain = {}, byOwner = {};
  for (const r of inv.records) {
    byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
    byClass[r.classification] = (byClass[r.classification] ?? 0) + 1;
    byDomain[r.behavior_domain] = (byDomain[r.behavior_domain] ?? 0) + 1;
    byOwner[r.owner_gap] = (byOwner[r.owner_gap] ?? 0) + 1;
  }
  const routes = inv.records.filter((r) => r.kind === "route-handler");
  return {
    files: inv.perFile.length,
    total_records: inv.records.length,
    by_kind: byKind, by_classification: byClass, by_behavior_domain: byDomain, by_owner_gap: byOwner,
    route_handlers: routes.length,
    routes_with_business_behavior: routes.filter((r) => r.business_behavior_in_route).length,
    routes_touching_db: routes.filter((r) => r.touches_db).length,
    routes_total_branches: routes.reduce((a, r) => a + r.branch_total, 0),
    external_consumer_files: new Set(inv.consumers.map((c) => c.consumer)).size,
    external_consumer_edges: inv.consumers.length,
    findings_high: inv.findings.filter((f) => f.severity === "HIGH").length,
    findings_low: inv.findings.filter((f) => f.severity === "LOW").length,
  };
}

function stripForHash(inv) {
  return JSON.stringify({ sourceHashes: inv.sourceHashes, records: inv.records, consumers: inv.consumers, findings: inv.findings });
}

function main() {
  const verify = process.argv.includes("--verify");
  const started = Date.now();

  if (verify) {
    // Reject missing / stale / hand-edited evidence.
    if (!fs.existsSync(EVIDENCE_FILE)) fail("evidence missing: run the validator without --verify first");
    const ev = JSON.parse(fs.readFileSync(EVIDENCE_FILE, "utf8"));
    const inv = buildInventory();
    const b = binding(inv.sourceHashes);
    const problems = [];
    if (ev.sub_phase !== SUB_PHASE) problems.push("sub_phase mismatch");
    if (ev.commit_sha !== b.commit_sha) problems.push(`commit_sha mismatch (${ev.commit_sha} vs ${b.commit_sha})`);
    if (ev.source_tree_sha256 !== b.source_tree_sha256) problems.push("source tree changed since evidence was generated (stale)");
    if (ev.inventory_sha256 !== sha256(stripForHash(inv))) problems.push("inventory content does not match a fresh census (tampered or stale)");
    const storedHash = sha256(JSON.stringify({ sourceHashes: ev.source_hashes, records: ev.records, consumers: ev.consumers, findings: ev.findings }));
    if (storedHash !== ev.inventory_sha256) problems.push("stored evidence body was edited after generation (hash mismatch)");
    if (ev.validator_sha256 !== sha256(fs.readFileSync(fileURLToPath(import.meta.url), "utf8"))) problems.push("evidence was produced by a different validator version");
    if (ev.status !== "PASS") problems.push(`recorded status is ${ev.status}`);
    if (problems.length) fail(`evidence rejected: ${problems.join("; ")}`);
    console.log(`${SUB_PHASE} evidence verified against current source (${b.commit_binding})`);
    return;
  }

  const inv = buildInventory();
  const inv2 = buildInventory(); // reproducibility
  const reproducible = stripForHash(inv) === stripForHash(inv2);
  const checks = runChecks(inv);
  checks.push({ name: "census-reproducible", passed: reproducible, details: reproducible ? "" : "two consecutive runs differ" });
  const selfResults = selfTests();
  checks.push(...selfResults);
  const failed = checks.filter((c) => !c.passed);
  const b = binding(inv.sourceHashes);

  const evidence = {
    phase: PHASE,
    sub_phase: SUB_PHASE,
    commit_sha: b.commit_sha,
    commit_binding: b.commit_binding,
    source_tree_sha256: b.source_tree_sha256,
    validator_version: VALIDATOR_VERSION,
    validator_sha256: sha256(fs.readFileSync(fileURLToPath(import.meta.url), "utf8")),
    generated_at: new Date().toISOString(),
    source_hashes: inv.sourceHashes,
    commands: [`node scripts/antas/vault/gap/validate-vlt-gap-01-A.mjs`],
    exit_codes: { validator: failed.length ? 1 : 0, typescript_parse: inv.perFile.every((f) => (f.sf.parseDiagnostics ?? []).length === 0) ? 0 : 1 },
    symbols_moved: [],
    consumers_migrated: [],
    old_business_symbols_remaining: inv.records.filter((r) => r.kind !== "router-instance" && r.kind !== "export-assignment").map((r) => r.id),
    duplicate_implementations: [],
    summary: summarize(inv),
    checks,
    inventory_sha256: sha256(stripForHash(inv)),
    notes: [
      "01-A is a census only: no code was moved; symbols_moved/consumers_migrated are intentionally empty.",
      "duplicate_implementations is computed in 01-B/01-D; here it is not asserted.",
      "Build/typecheck and behavioral tests are not part of 01-A (no code change); they are required from 01-B onward.",
    ],
    status: failed.length === 0 ? "PASS" : "FAIL",
    findings: inv.findings,
    files: inv.perFile.map((f) => ({ file: f.file, sha256: inv.sourceHashes[f.file], lines: f.lineCount, top_level_statements: f.stmtCount, records: f.records.length, imports: f.imports })),
    records: inv.records,
    consumers: inv.consumers,
  };

  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(EVIDENCE_FILE, `${JSON.stringify(evidence, null, 2)}\n`);
  for (const f of inv.findings.filter((x) => x.severity === "HIGH")) console.warn(`  FINDING[${f.severity}] ${f.detail}`);
  console.log(`${SUB_PHASE} ${evidence.status} — ${evidence.summary.total_records} records, ${evidence.summary.route_handlers} routes, ${evidence.summary.external_consumer_edges} consumer edges (${Date.now() - started}ms)`);
  if (failed.length) {
    console.error(failed.map((c) => `- ${c.name}: ${c.details || "not satisfied"}`).join("\n"));
    process.exit(1);
  }
}
main();
