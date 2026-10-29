#!/usr/bin/env node
// VLT-GAP-05-A — Secret/Core Symbol / Behavior Census (source-derived, fail-closed).
// Evidence: reports/antas/vault/gap/VLT-GAP-05/symbol-inventory.json
// Baseline: reports/antas/vault/gap/VLT-GAP-05/baseline/ (frozen pre-extraction source + manifest; WRITE-ONCE: never rewritten once present)
//
// 05-A is a census only. No code is moved; symbols_moved / consumers_migrated stay empty.
//
// Scope decision (recorded in the evidence, not hidden): the roadmap lists three Sources. services/vault/src/index.mjs is a composition root
// that wires the service; the implementation it composes (application / domain / crypto / security / infrastructure / api) lives in the other
// files under services/vault/src. Those are enumerated by DIRECTORY WALK (never hand-listed) and censused as `service-module` sources, flagged
// in_roadmap_sources=false. Without them none of the roadmap's required behaviors (creation, listing, reveal, step-up, audit, events) could be
// evidenced from index.mjs alone.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { ROOT, sha256, rel, rejectBypass, binding, walkFiles } from "./gap-common.mjs";

const VALIDATOR_VERSION = "1.0.0";
const PHASE = "VLT-GAP-05";
const SUB_PHASE = "VLT-GAP-05-A";
const SELF = fileURLToPath(import.meta.url);

// Roadmap GAP-05 Sources (exactly the three listed).
const FIXED_SOURCES = [
  "services/vault/src/index.mjs",
  "artifacts/api-server/src/routes/vault.ts",
  "artifacts/api-server/src/lib/vault-crypto.ts",
];
const SERVICE_DIR = "services/vault/src";
// Existing Vault-side destination state (recorded, not censused as legacy source). Only files that exist are recorded.
const DESTINATION_CANDIDATES = [
  "artifacts/api-server/src/vault/crypto/field-encryption.ts",
  "artifacts/api-server/src/vault/crypto/seed-phrase.ts",
  "artifacts/api-server/src/vault/domain/secret-fields.ts",
  "artifacts/api-server/src/vault/security/entity-ownership.ts",
  "artifacts/api-server/src/vault/application/entity/create.ts",
  "artifacts/api-server/src/vault/application/entity/lifecycle.ts",
  "artifacts/api-server/src/vault/application/entity/update.ts",
  "artifacts/api-server/src/vault/application/entity/representation.ts",
  "artifacts/api-server/src/vault/application/entity/activity.ts",
  "artifacts/api-server/src/vault/application/entity/activity-feed.ts",
  "artifacts/api-server/src/vault/application/entity/bulk.ts",
  "artifacts/api-server/src/vault/application/entity/analytics.ts",
  "artifacts/api-server/src/vault/application/entity/admin.ts",
  "artifacts/api-server/src/vault/application/entity/receipt.ts",
  "artifacts/api-server/src/vault/infrastructure/repositories/entity-repository.ts",
];
const DESTINATION_CONTEXT = DESTINATION_CANDIDATES.filter((p) => fs.existsSync(path.join(ROOT, p)));
const SCHEMA_DIR = "lib/db/src/schema";
const UI_ALIAS_ROOT = "artifacts/ayzen/src";
const EVIDENCE_DIR = path.join(ROOT, "reports/antas/vault/gap/VLT-GAP-05");
const EVIDENCE_FILE = path.join(EVIDENCE_DIR, "symbol-inventory.json");
const BASELINE_DIR = path.join(EVIDENCE_DIR, "baseline");

function fail(msg, code = 1) { console.error(`${SUB_PHASE} FAIL — ${msg}`); process.exit(code); }

const serviceFiles = () => walkFiles(path.join(ROOT, SERVICE_DIR), [], (p) => /\.(mjs|js|cjs)$/.test(p)).map(rel).sort();
const SOURCES = [...new Set([...FIXED_SOURCES, ...serviceFiles()])];

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
const fileKind = (f) => (/^services\/vault\/src\/index\.mjs$/.test(f) ? "service-entry" : /^services\/vault\/src\//.test(f) ? "service-module" : /\/routes\//.test(f) ? "route" : /\/lib\//.test(f) ? "lib" : /\/pages\//.test(f) ? "page" : /\.tsx$/.test(f) ? "component" : "config");

function parse(fileName, text) {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, /\.(mjs|js|cjs)$/.test(fileName) ? ts.ScriptKind.JS : /x$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
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
  ["step-up", /^(verifyStepUpToken|verifyReveal|consumeRevealToken|hasNoEntityPin)$/],
  ["tenant", /^(tenantScopeFromHeaders|requireTenantScope|tenantMatches)$/],
  ["infra-factory", /^(createPostgresQuery|createStateStore|createSharedIdempotencyStore|createAuditLog|createTransactionalEventPublisher|createHttpEnvelopeTransport|createServiceServer|createConfiguredAuthenticator)$/],
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


// ── 4. Behavior evidence (GAP-05 required behaviors) ─────────────────────
// Roadmap "must become owned by the new module": secret creation, listing, reveal, versioning, tenant scope, step-up, audit, events.
// A behavior is attached to a symbol ONLY by evidence found in its AST (identifiers, member names, string literals, route shape, object-literal
// members). A symbol may evidence several behaviors (e.g. one factory returning list/create/reveal methods). A required behavior with zero
// evidencing symbols FAILS the census (no invented behaviors).
const REQUIRED_BEHAVIORS = ["secret-creation", "secret-listing", "secret-reveal", "versioning", "tenant-scope", "step-up", "audit", "events"];
const EVIDENCE_RULES = {
  "secret-creation": { idents: ["createEntity", "createSecretRecord", "encryptField", "encryptSeedPhrase"], members: [], routes: [["POST", /^\/vault$/]], objectMembers: ["create", "encrypt"] },
  "secret-listing": { idents: ["listEntities", "listEntityTags", "listTrashedEntities", "adminListEntities", "adminFullVault", "adminListLocalAccounts", "adminListVaultUsers", "adminGetUserVault", "selectVault", "metadataOnly"], members: [], routes: [["GET", /^\/(admin\/)?vault(\/(trash|tags|full|users|local-accounts))?$/]], objectMembers: ["list"] },
  "secret-reveal": { idents: ["decryptSeedPhrase", "getEntity", "decryptRow", "decryptRows", "decryptField"], members: ["decrypt"], routes: [["GET", /^\/vault\/:id$/], ["GET", /^\/vault\/:id\/seed$/]], objectMembers: ["reveal", "decrypt"] },
  "versioning": { idents: ["updateEntityField", "listEntityFieldHistory"], members: [], routes: [["PATCH", /^\/vault\/:id\/field$/], ["GET", /^\/vault\/:id\/field-history$/]], objectProps: ["version"] },
  "tenant-scope": { idents: ["requireVaultEntryOwnership", "auditVaultBulkOwnership", "tenantMatches", "tenantScopeFromHeaders", "requireTenantScope", "createResourceOwnershipRule", "workspaceId", "organizationId"], members: [], strings: [/^TENANT_MISMATCH$/] },
  "step-up": { idents: ["consumeRevealToken", "hasNoEntityPin", "verifyStepUpToken", "verifyReveal", "createVaultAccess"], members: ["verifyReveal"], strings: [/step-up/i], statuses: [428] },
  "audit": { idents: ["logVaultActivity", "logSubjectActivity", "requirePublicAudit", "createAuditLog", "listMyVaultActivity", "listEntityActivity", "adminVaultActivityFeed"], members: [], memberOnRoot: [["audit", "record"], ["audit", "list"]], strings: [/^vault\.secret\.(create|access)$/] },
  "events": { idents: ["broadcastEvent", "createTransactionalEventPublisher", "createHttpEnvelopeTransport"], members: [], memberOnRoot: [["publish", "publish"]], strings: [/^vault\.secret\.(updated|accessed)$/] },
};
const TOPIC_BY_ROUTE = [[/health/, "health"], [/analytics|gas|value-history/, "analytics"], [/receipt/, "receipt"], [/wallet|validate-key/, "wallet"], [/activity/, "activity"], [/bulk/, "bulk"], [/trash|restore/, "lifecycle"]];
const isRequired = (b) => REQUIRED_BEHAVIORS.includes(b);
function collectEvidence(node, sf) {
  const idents = new Set(), members = new Set(), strings = new Set(), objectMembers = new Set(), objectProps = new Map(), statuses = new Set(), memberOnRoot = new Set(), newSets = [];
  (function w(n) {
    if (ts.isIdentifier(n)) idents.add(n.text);
    if (ts.isPropertyAccessExpression(n)) { members.add(n.name.text); let r = n.expression; while (ts.isPropertyAccessExpression(r) || ts.isCallExpression(r)) r = r.expression; if (ts.isIdentifier(r)) memberOnRoot.add(`${r.text}.${n.name.text}`); }
    if (ts.isStringLiteralLike(n)) strings.add(n.text);
    if (ts.isMethodDeclaration(n) && n.name) objectMembers.add(n.name.getText(sf));
    if (ts.isPropertyAssignment(n)) { const pn = n.name.getText(sf); objectProps.set(pn, (objectProps.get(pn) ?? []).concat(n.initializer.getText(sf).slice(0, 40))); if (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer)) objectMembers.add(pn); }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "status" && n.arguments[0] && ts.isNumericLiteral(n.arguments[0])) statuses.add(Number(n.arguments[0].text));
    if (ts.isPropertyAssignment(n) && n.name.getText(sf) === "status" && ts.isNumericLiteral(n.initializer)) statuses.add(Number(n.initializer.text));
    if (ts.isVariableDeclaration(n) && n.initializer && ts.isNewExpression(n.initializer) && n.initializer.expression.getText(sf) === "Set") newSets.push(n.name.getText(sf));
    ts.forEachChild(n, w);
  })(node);
  return { idents, members, strings, objectMembers, objectProps, statuses, memberOnRoot, newSets };
}
function behaviorEvidence(rec, relFile, sf, stmts) {
  const node = stmts.find((s) => sf.getLineAndCharacterOfPosition(s.getStart(sf)).line + 1 === rec.line_start);
  const ev = node ? collectEvidence(node, sf) : null;
  const matched = {};
  const add = (b, tok) => { (matched[b] ??= new Set()).add(tok); };
  if (ev) for (const [b, r] of Object.entries(EVIDENCE_RULES)) {
    for (const i of r.idents ?? []) if (ev.idents.has(i)) add(b, i);
    for (const m of r.members ?? []) if (ev.members.has(m)) add(b, `.${m}`);
    for (const [root, mem] of r.memberOnRoot ?? []) if (ev.memberOnRoot.has(`${root}.${mem}`)) add(b, `${root}.${mem}`);
    for (const rx of r.strings ?? []) for (const s of ev.strings) if (rx.test(s)) add(b, `"${s}"`);
    for (const st of r.statuses ?? []) if (ev.statuses.has(st)) add(b, `status ${st}`);
    for (const om of r.objectMembers ?? []) if (ev.objectMembers.has(om)) add(b, `method ${om}()`);
    for (const op of r.objectProps ?? []) if (ev.objectProps.has(op)) add(b, `property ${op}`);
  }
  if (rec.kind === "route-handler") for (const [b, r] of Object.entries(EVIDENCE_RULES)) for (const [m, rx] of r.routes ?? []) if (rec.method === m && rx.test(rec.route_path ?? "")) add(b, `route ${m} ${rec.route_path}`);
  // the factory's own name is evidence for the behavior it constructs (e.g. createVaultAccess → step-up)
  const behaviors = REQUIRED_BEHAVIORS.filter((b) => matched[b]);
  const topic = behaviors.length ? null : (rec.route_path ? (TOPIC_BY_ROUTE.find(([rx]) => rx.test(rec.route_path))?.[1] ?? "other-vault") : (/health|Health|score|Score|Risk/.test(rec.name ?? "") ? "health" : "shared-support"));
  return {
    behaviors,
    behavior_evidence: Object.fromEntries(behaviors.map((b) => [b, [...matched[b]].sort()])),
    behavior_domain: behaviors[0] ?? topic,
    required_behavior: behaviors[0] ?? null,
    non_required_topic: topic,
    state_set_declarations: ev ? ev.newSets : [],
  };
}

// ── 5. Classification (rule-based; no rule ⇒ UNCLASSIFIED ⇒ FAIL) ─────────
const CLASSES = new Set(["domain", "application", "security", "infrastructure", "API", "adapter", "legacy"]);
function classifySymbol(rec) {
  const n = rec.name ?? ""; const ops = rec.operations ?? {};
  const has = (c) => Boolean(ops[c]?.length);
  const io = rec.touches_db || has("provider") || has("event") || has("notification") || has("storage") || has("billing") || has("sync") || has("email");
  const rule = (cls, id) => ({ classification: cls, classification_rule: id });
  if (rec.kind === "router-instance") return rule("adapter", "R01:express-router-instance");
  if (rec.kind === "export-assignment") return rule("adapter", rec.file_kind === "route" ? "R02:default-export-router" : "R02b:compat-reexport");
  if (rec.kind === "service-bootstrap") return rule("adapter", "R19:service-composition-root");
  if (rec.file_kind === "service-entry" && rec.kind === "constant") return rule("adapter", "R19:service-composition-root");
  if (rec.kind === "type" || rec.kind === "interface") return rule("domain", "R03:type-declaration");
  if (rec.kind === "rule-registration") return rule("security", "R04:policy-rule-registration");
  if (/^legacy[A-Z]/.test(n)) return rule("legacy", "R05:legacy-prefixed-symbol");
  if (rec.kind === "constant" && /Deps$/.test(n)) return rule("adapter", "R18:dependency-injection-wiring");
  if (rec.kind === "function" && /^actorFrom$/.test(n)) return rule("security", "R24:auth-context-mapping");
  if (/_CONTRACT$/.test(n)) return rule("API", "R21:service-api-contract");
  if (rec.kind === "function" && /HttpHandler$/.test(n)) return rule("API", "R22:service-http-handler-factory");
  if (/(Resource|Ownership|_SENTINEL_NONE)$|^(require|audit)\w*Ownership|^deny[A-Z]/.test(n)) return rule("security", "R06:ownership-resource-builder");
  if (rec.kind === "function" || rec.kind === "arrow-function") {
    if (rec.renders_jsx) return rule("adapter", "R20:react-ui-component");
    if (has("step-up") && !rec.touches_db) return rule("security", "R07:step-up-verification");
    if (has("infra-factory") && !rec.touches_db && !has("event")) return rule("infrastructure", "R23:infrastructure-factory");
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
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression?.(e) || ts.isAwaitExpression(e)) e = e.expression;
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
        rec.delegates_to_vault = rec.external_calls.filter((c) => /(^|\/)vault\//.test(c.target) || /^\.\.\/vault\//.test(c.target)).map((c) => c.target);
        rec.business_behavior_in_route = rec.touches_db || rec.branch_total > 0 || ["provider", "event", "notification", "billing", "crypto", "sync", "storage", "email"].some((c) => rec.operations[c]?.length);
        records.push(rec);
      } else if (ts.isPropertyAccessExpression(callee) && callee.name.text === "registerRule") {
        records.push(attach({ ...base, id: `${relFile}#rule@${L.start}`, name: `${callee.expression.getText(sf)}.registerRule`, kind: "rule-registration" }, s));
      } else if (/^createServiceServer\(/.test(call.getText(sf))) {
        records.push(attach({ ...base, id: `${relFile}#service-bootstrap`, name: "createServiceServer.start", kind: "service-bootstrap" }, s));
      } else records.push(attach({ ...base, id: `${relFile}#stmt@${L.start}`, name: `stmt@${L.start}`, kind: "unknown-statement" }, s));
    } else records.push(attach({ ...base, id: `${relFile}#stmt@${L.start}`, name: `stmt@${L.start}`, kind: "unknown-statement" }, s));
  }

  for (const rec of records) {
    if (rec.kind !== "route-handler") Object.assign(rec, classifySymbol(rec));
    rec.file_kind = kind;
    Object.assign(rec, behaviorEvidence(rec, relFile, sf, stmts));
    rec.owner_gap = "GAP-05";
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
  const prefilter = /(vault|Vault|VAULT)/;
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


// ── 7b. Table / endpoint / service-dispatch scans ─────────────────────────
function drizzleTableNames() {
  const map = new Map();
  const dir = path.join(ROOT, SCHEMA_DIR);
  if (!fs.existsSync(dir)) return map;
  for (const abs of walkFiles(dir, [], (p) => /\.ts$/.test(p))) {
    const t = fs.readFileSync(abs, "utf8");
    for (const m of t.matchAll(/export const (\w+Table)\s*=\s*pgTable\(\s*["']([a-z0-9_]+)["']/g)) map.set(m[1], m[2]);
  }
  return map;
}
function tableConsumerScan(records, allSources) {
  const idMap = drizzleTableNames();
  const touched = new Map(); // sql table -> {identifiers:Set, via:Set(raw|drizzle)}
  const note = (sqlName, ident, via) => { const e = touched.get(sqlName) ?? { identifiers: new Set(), via: new Set() }; if (ident) e.identifiers.add(ident); e.via.add(via); touched.set(sqlName, e); };
  for (const r of records) {
    for (const id of r.tables ?? []) note(idMap.get(id) ?? `?${id}`, id, "drizzle");
    for (const q of r.operations?.raw_sql ?? []) for (const t of q.tables ?? []) note(t, null, "raw-sql");
  }
  const all = [...touched.entries()].map(([sql, e]) => ({ sql_table: sql, identifiers: [...e.identifiers].sort(), via: [...e.via].sort(), vault_owned: /vault/.test(sql) }));
  const owned = all.filter((t) => t.vault_owned);
  const out = [];
  if (owned.length) {
    const needles = [...new Set(owned.flatMap((t) => [t.sql_table, ...t.identifiers]))];
    const rx = new RegExp(`\\b(${needles.join("|")})\\b`, "g");
    const exts = /\.(ts|tsx|mjs|js|cjs|sql)$/;
    for (const abs of walkFiles(ROOT, [], (p) => exts.test(p))) {
      const r = rel(abs);
      if (allSources.includes(r) || r.startsWith("scripts/antas/") || r.startsWith("reports/") || /pnpm-lock/.test(r) || r.startsWith(`${SCHEMA_DIR}/`) || r.startsWith("lib/db/src/src/")) continue;
      let text; try { text = fs.readFileSync(abs, "utf8"); } catch { continue; }
      const hits = {};
      for (const m of text.matchAll(rx)) hits[m[1]] = (hits[m[1]] ?? 0) + 1;
      if (!Object.keys(hits).length) continue;
      out.push({ file: r, kind: /(^|\/)(tests?|__tests__)\/|\.(test|spec)\./.test(r) ? "test" : /migration/.test(r) ? "schema-or-migration" : /^artifacts\/ayzen\//.test(r) ? "ui" : "source", tables: hits });
    }
  }
  return { tables: owned.map((t) => t.sql_table).sort(), tables_touched: all.sort((a, b) => a.sql_table.localeCompare(b.sql_table)), consumers: out.sort((a, b) => a.file.localeCompare(b.file)) };
}
function endpointConsumerScan(routeRecords, allSources, serviceRoutes) {
  const paths = [...new Set(routeRecords.filter((r) => r.kind === "route-handler").map((r) => r.route_path))].sort();
  const svcPaths = [...new Set(serviceRoutes.map((r) => r.path))].sort();
  const out = [];
  for (const abs of scanFiles()) {
    const r = rel(abs); if (allSources.includes(r)) continue;
    let text; try { text = fs.readFileSync(abs, "utf8"); } catch { continue; }
    if (!/vault/.test(text)) continue;
    const found = new Set();
    for (const m of text.matchAll(/["'`](\/?(?:api\/)?(?:admin\/)?vault(?:\/[^"'`\s)]*)?)["'`]/g)) found.add(m[1].replace(/\$\{[^}]*\}/g, ":param"));
    for (const m of text.matchAll(/["'`](\/?api\/vault\/secrets[^"'`\s)]*)["'`]/g)) found.add(m[1].replace(/\$\{[^}]*\}/g, ":param"));
    if (found.size) out.push({ file: r, endpoints: [...found].sort() });
  }
  return { route_paths: paths, service_route_paths: svcPaths, callers: out.sort((a, b) => a.file.localeCompare(b.file)) };
}
// The vault service dispatches by `url.pathname`/`req.method` comparisons inside its HTTP handler (no router object). Derived from the AST.
function serviceDispatch(sf, file) {
  const out = [];
  const regexVars = new Map();
  (function w(n) {
    if (ts.isVariableDeclaration(n) && n.initializer && ts.isCallExpression(n.initializer) && ts.isPropertyAccessExpression(n.initializer.expression) && n.initializer.expression.name.text === "match" && /pathname$/.test(n.initializer.expression.expression.getText(sf)) && n.initializer.arguments[0] && ts.isRegularExpressionLiteral(n.initializer.arguments[0])) regexVars.set(n.name.getText(sf), n.initializer.arguments[0].text);
    ts.forEachChild(n, w);
  })(sf);
  (function w(n) {
    if (ts.isIfStatement(n)) {
      const c = n.expression.getText(sf);
      const method = c.match(/req\.method\s*===\s*["'](\w+)["']/)?.[1];
      const lit = c.match(/url\.pathname\s*===\s*["']([^"']+)["']/)?.[1];
      let pat = null; for (const [v, rx] of regexVars) if (new RegExp(`\\b${v}\\b`).test(c)) pat = rx;
      if (method && (lit || pat)) out.push({ file, method, path: lit ?? pat, kind: lit ? "literal" : "pattern", line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1 });
    }
    ts.forEachChild(n, w);
  })(sf);
  return out;
}
function contractRoutes(sf) {
  const routes = []; const events = [];
  (function w(n) {
    if (ts.isPropertyAssignment(n) && n.name.getText(sf) === "routes" && ts.isArrayLiteralExpression(n.initializer)) for (const el of n.initializer.elements) if (ts.isObjectLiteralExpression(el)) { const o = {}; for (const p of el.properties) if (ts.isPropertyAssignment(p) && ts.isStringLiteralLike(p.initializer)) o[p.name.getText(sf)] = p.initializer.text; if (o.method && o.path) routes.push(o); }
    if (ts.isPropertyAssignment(n) && n.name.getText(sf) === "events" && ts.isArrayLiteralExpression(n.initializer)) for (const el of n.initializer.elements) if (ts.isStringLiteralLike(el)) events.push(el.text);
    ts.forEachChild(n, w);
  })(sf);
  return { routes, events };
}
function publishedEvents(sf) {
  const out = new Set();
  (function w(n) { if (ts.isPropertyAssignment(n) && n.name.getText(sf) === "eventType" && ts.isStringLiteralLike(n.initializer)) out.add(n.initializer.text); ts.forEachChild(n, w); })(sf);
  return [...out].sort();
}
function cryptoFacts(text) {
  return {
    algorithms: [...new Set([...text.matchAll(/create(?:Cipheriv|Decipheriv)\(\s*["']([a-z0-9-]+)["']/g)].map((m) => m[1]))].sort(),
    encodings: [...new Set([...text.matchAll(/["'](base64url|base64|hex)["']/g)].map((m) => m[1]))].sort(),
    key_derivation: [...new Set([...text.matchAll(/\b(createHash|scryptSync|scrypt|pbkdf2Sync|hkdf)\b/g)].map((m) => m[1]))].sort(),
  };
}


// ── 8. Core build (deterministic; no timestamps inside hashed body) ───────
const exportList = (sf) => sf.statements.filter((s) => s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)).flatMap((s) => ts.isVariableStatement(s) ? s.declarationList.declarations.map((x) => x.name.getText(sf)) : s.name ? [s.name.text] : []).sort();
function workspacePackages() {
  const map = new Map();
  for (const base of ["packages", "lib"]) {
    const dir = path.join(ROOT, base); if (!fs.existsSync(dir)) continue;
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) if (d.isDirectory()) { const pj = path.join(dir, d.name, "package.json"); if (fs.existsSync(pj)) { try { map.set(JSON.parse(fs.readFileSync(pj, "utf8")).name, `${base}/${d.name}`); } catch { /* ignore */ } } }
  }
  return map;
}
const normalizeSvcPath = (p) => (p.startsWith("/^") ? p.replace(/^\/(.*)\/[a-z]*$/s, "$1") : p).replace(/^\^/, "").replace(/\$$/, "").replace(/\\\//g, "/").replace(/\(\[\^\/\]\+\)/g, ":id");
function buildInventory() {
  const perFile = SOURCES.map((s) => { if (!fs.existsSync(path.join(ROOT, s))) fail(`required source missing: ${s}`); const f = censusFile(s); f.in_roadmap_sources = FIXED_SOURCES.includes(s); return f; });
  const records = perFile.flatMap((f) => f.records);
  const consumers = consumerScan(SOURCES);
  for (const f of perFile) for (const r of f.records) {
    if (!r.exported) { r.external_consumers = []; continue; }
    r.external_consumers = consumers.filter((c) => c.target === f.file && c.names.some((n) => n.imported === r.name || n.imported === "*" || (r.name === "default" && n.imported === "default") || (r.default_export && n.imported === "default")))
      .map((c) => ({ consumer: c.consumer, kind: c.kind, line: c.line })).sort((a, b) => a.consumer.localeCompare(b.consumer));
  }
  const exportsByFile = new Map(perFile.map((f) => [f.file, new Set(f.exportedNames)]));
  const destination = DESTINATION_CONTEXT.map((d) => {
    const text = read(d); const sf = parse(d, text); let fn = 0; (function w(n) { if (ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n)) fn++; ts.forEachChild(n, w); })(sf);
    return { file: d, exists: true, sha256: sha256(text), lines: text.split("\n").length, exports: exportList(sf), function_count: fn, holds_business_logic: fn > 0, crypto: /crypto/.test(d) ? cryptoFacts(text) : undefined };
  });
  const svcFile = (n) => perFile.find((f) => f.file === `${SERVICE_DIR}/${n}`);
  const contractF = svcFile("api/contracts.mjs"); const handlerF = svcFile("api/http-handler.mjs"); const appF = svcFile("application/secret-service.mjs");
  const contract = contractF ? contractRoutes(contractF.sf) : { routes: [], events: [] };
  const dispatch = handlerF ? serviceDispatch(handlerF.sf, handlerF.file).map((d) => ({ ...d, normalized_path: normalizeSvcPath(d.path) })) : [];
  const published = appF ? publishedEvents(appF.sf) : [];
  const ownedResources = contractF ? [...contractF.text.matchAll(/ownedResources:\s*\[([^\]]*)\]/g)].flatMap((m) => [...m[1].matchAll(/["']([^"']+)["']/g)].map((x) => x[1])) : [];
  const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const ownedEvidence = ownedResources.map((name) => {
    const files = [];
    for (const abs of walkFiles(ROOT, [], (p) => /\.(ts|tsx|mjs|js|cjs|sql)$/.test(p))) { const r = rel(abs); if (r.startsWith("scripts/antas/") || r.startsWith("reports/") || r === `${SERVICE_DIR}/api/contracts.mjs`) continue; let t; try { t = fs.readFileSync(abs, "utf8"); } catch { continue; } if (new RegExp(`\\b${name}\\b`).test(stripComments(t))) files.push(r); }
    return { resource: name, referenced_outside_contract_by: files };
  });
  const pkgs = workspacePackages();
  const svcDeps = [...new Set(perFile.filter((f) => f.file.startsWith(SERVICE_DIR)).flatMap((f) => f.imports.map((i) => i.module)).filter((m) => m.startsWith("@ayzen/") || m.startsWith("@workspace/")))].sort().map((m) => ({ package: m, resolves_to: pkgs.get(m) ?? null }));
  const svcState = [...new Set(records.filter((r) => r.file.startsWith(SERVICE_DIR)).flatMap((r) => r.state_set_declarations ?? []))].sort();
  const cryptoSvc = svcFile("crypto/envelope.mjs") ? cryptoFacts(svcFile("crypto/envelope.mjs").text) : null;
  const cryptoApi = destination.find((d) => /vault\/crypto\/field-encryption\.ts$/.test(d.file))?.crypto ?? null;
  const versionWrites = perFile.filter((f) => f.file.startsWith(SERVICE_DIR)).flatMap((f) => [...stripComments(f.text).matchAll(/\bversion\b\s*(\+\+|\+=|=[^=][^;\n]*\+\s*1|:\s*[^,\n}]*\+\s*1)/g)].map((m) => `${f.file}: ${m[0].trim()}`));
  const versionLiterals = perFile.filter((f) => f.file.startsWith(SERVICE_DIR)).flatMap((f) => [...stripComments(f.text).matchAll(/\bversion:\s*(\d+)\b/g)].map((m) => `${f.file}: version: ${m[1]}`));
  const compat = perFile.map((f) => { const allRe = f.records.length > 0 && f.records.every((r) => r.kind === "export-assignment"); if (!allRe) return null; const targets = [...f.text.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]); return { file: f.file, targets, resolved: targets.map((t) => { const abs = path.resolve(path.dirname(path.join(ROOT, f.file)), t); const cands = [abs, `${abs}.ts`, `${abs}.mjs`, `${abs}.js`, path.join(abs, "index.ts")]; const hit = cands.find((c) => fs.existsSync(c) && fs.statSync(c).isFile()); return hit ? rel(hit) : null; }) }; }).filter(Boolean);
  const service = { contract_routes: contract.routes, dispatch_routes: dispatch, contract_events: contract.events, published_events: published, owned_resources: ownedEvidence, workspace_dependencies: svcDeps, in_process_state_sets: svcState, crypto_envelope: cryptoSvc, crypto_field_encryption: cryptoApi, version_increments: versionWrites, version_literals: versionLiterals, compat_adapters: compat };
  const findings = [];
  for (const c of consumers) {
    const ex = exportsByFile.get(c.target);
    for (const n of c.names) {
      if (n.imported === "*") { n.resolved = true; continue; }
      if (!ex) { n.resolved = true; continue; }
      n.resolved = ex.has(n.imported);
      if (!n.resolved) findings.push({ id: `dangling-import:${c.consumer}:${n.imported}`, severity: "HIGH", kind: "consumer-imports-symbol-not-exported-by-target", consumer: c.consumer, line: c.line, target: c.target, symbol: n.imported, detail: `${c.consumer}:${c.line} imports '${n.imported}' from ${c.target}, which does not export it` });
    }
    if (c.unused_import) findings.push({ id: `unused-import:${c.consumer}:${c.target}`, severity: "LOW", kind: "unused-import-of-vault-source", consumer: c.consumer, line: c.line, target: c.target, detail: "import is never referenced" });
  }
  for (const r of records) if (r.kind === "route-handler" && r.touches_db) findings.push({ id: `route-owns-db:${r.id}`, severity: "INFO", kind: "route-handler-owns-db-access", symbol: r.id, detail: `${r.name} performs DB access inline (${[...(r.operations.db ?? []), ...(r.operations.raw_sql ?? []).flatMap((q) => q.tables)].slice(0, 4).join(", ")})` });
  for (const r of records) if (r.kind === "route-handler" && (r.operations.raw_sql ?? []).some((q) => q.string_built)) findings.push({ id: `string-built-sql:${r.id}`, severity: "INFO", kind: "route-uses-string-built-sql", symbol: r.id, detail: `${r.name} builds SQL by string interpolation` });
  {
    const apiRoutes = records.filter((r) => r.kind === "route-handler");
    const inline = apiRoutes.filter((r) => r.business_behavior_in_route && !(r.delegates_to_vault ?? []).length);
    findings.push({ id: "routes-without-vault-delegation:vault.ts", severity: "INFO", kind: "route-handlers-not-delegating-to-vault-owner", detail: `${inline.length}/${apiRoutes.length} handlers in routes/vault.ts hold business behavior and call no vault/* module: ${inline.map((r) => r.name).join(", ")}` });
    const seed = apiRoutes.find((r) => r.route_path === "/vault/:id/seed");
    if (seed) findings.push({ id: "reveal-logic-inline-in-route:GET /vault/:id/seed", severity: "INFO", kind: "reveal-step-up-audit-inline-in-route", symbol: seed.id, detail: `GET /vault/:id/seed performs seed reveal inline: step-up (${(seed.operations["step-up"] ?? []).join(",") || "none"}), crypto (${(seed.operations.crypto ?? []).join(",") || "none"}), db (${(seed.operations.db ?? []).join(",") || "none"}), events/audit (${[...(seed.operations.event ?? []), ...(seed.operations.audit ?? [])].join(",") || "none"}), ${seed.branch_total} branches` });
    const dispatchKeys = new Set(dispatch.map((d) => `${d.method} ${d.normalized_path}`)); const contractKeys = new Set(contract.routes.map((r) => `${r.method} ${r.path}`));
    for (const k of contractKeys) if (!dispatchKeys.has(k)) findings.push({ id: `contract-route-not-dispatched:${k}`, severity: "HIGH", kind: "service-contract-route-without-handler", detail: `${k} is declared in VAULT_CONTRACT but the HTTP handler has no matching dispatch branch` });
    for (const k of dispatchKeys) if (!contractKeys.has(k)) findings.push({ id: `dispatch-route-not-in-contract:${k}`, severity: "HIGH", kind: "service-handler-route-not-in-contract", detail: `${k} is dispatched by the HTTP handler but not declared in VAULT_CONTRACT` });
    for (const e of published) if (!contract.events.includes(e)) findings.push({ id: `event-not-in-contract:${e}`, severity: "HIGH", kind: "published-event-not-declared", detail: `${e} is published but not listed in VAULT_CONTRACT.events` });
    for (const e of contract.events) if (!published.includes(e)) findings.push({ id: `contract-event-never-published:${e}`, severity: "HIGH", kind: "declared-event-never-published", detail: `${e} is declared in VAULT_CONTRACT.events but no code publishes it` });
    for (const o of ownedEvidence) if (!o.referenced_outside_contract_by.length) findings.push({ id: `owned-resource-without-implementation:${o.resource}`, severity: "INFO", kind: "declared-owned-resource-never-referenced", detail: `VAULT_CONTRACT.ownedResources lists '${o.resource}' but no source or SQL references it` });
    if (!versionWrites.length && versionLiterals.length) findings.push({ id: "versioning-never-incremented:services/vault", severity: "INFO", kind: "version-is-constant", detail: `the service stamps ${versionLiterals.join("; ")} and no code path increments a version (no update/rotate route exists), although 'versioning' is a required behavior` });
    if (svcState.length) findings.push({ id: "step-up-consumption-state-in-process", severity: "INFO", kind: "single-use-state-held-in-process-memory", detail: `${svcState.join(", ")} is an in-process Set; step-up single-use is not shared across instances or restarts` });
    if (cryptoSvc && cryptoApi) {
      const diff = []; if (JSON.stringify(cryptoSvc.encodings) !== JSON.stringify(cryptoApi.encodings)) diff.push(`encodings ${cryptoSvc.encodings.join("/")} vs ${cryptoApi.encodings.join("/")}`); if (JSON.stringify(cryptoSvc.key_derivation) !== JSON.stringify(cryptoApi.key_derivation)) diff.push(`key derivation ${cryptoSvc.key_derivation.join("/") || "none"} vs ${cryptoApi.key_derivation.join("/") || "none"}`);
      if (diff.length) findings.push({ id: "two-crypto-envelope-formats", severity: "INFO", kind: "parallel-encryption-implementations", detail: `services/vault/src/crypto/envelope.mjs and ${DESTINATION_CONTEXT.find((d) => /field-encryption/.test(d))} both use ${cryptoSvc.algorithms.join(",")} but differ in ${diff.join("; ")}; ciphertexts are not interchangeable` });
    }
    for (const d of svcDeps) if (!d.resolves_to) findings.push({ id: `unresolved-workspace-dependency:${d.package}`, severity: "HIGH", kind: "service-imports-unresolvable-workspace-package", detail: `${d.package} is imported by services/vault but no workspace package with that name was found` });
    const svcCallers = []; for (const abs of scanFiles()) { const r = rel(abs); if (r.startsWith(`${SERVICE_DIR}/`)) continue; let t; try { t = fs.readFileSync(abs, "utf8"); } catch { continue; } if (/VAULT_SERVICE_URL|\/api\/vault\/secrets/.test(t)) svcCallers.push(r); }
    service.service_callers = svcCallers.sort();
    if (!svcCallers.length) findings.push({ id: "service-has-no-callers", severity: "INFO", kind: "service-routes-unreferenced", detail: "no file outside services/vault references VAULT_SERVICE_URL or /api/vault/secrets; the service store (state collection 'records') and the api-server vault_entries table are parallel, unconnected secret stores" });
  }
  findings.sort((a, b) => a.id.localeCompare(b.id));
  const tableScan = tableConsumerScan(records, SOURCES);
  const endpointScan = endpointConsumerScan(records, SOURCES, dispatch);
  const related = [];
  for (const abs of walkFiles(ROOT, [], (p) => /\.(ts|tsx|mjs|js|cjs|sql|json)$/.test(p))) { const r = rel(abs); if (SOURCES.includes(r) || DESTINATION_CONTEXT.includes(r) || r.startsWith("scripts/antas/") || r.startsWith("reports/") || /pnpm-lock/.test(r)) continue; if (/vault/i.test(r)) related.push({ file: r, reason: "path-contains-vault", in_roadmap_sources: false }); }
  related.sort((a, b) => a.file.localeCompare(b.file));
  const sourceHashes = Object.fromEntries(perFile.map((f) => [f.file, sha256(f.text)]));
  for (const d of destination) sourceHashes[d.file] = d.sha256;
  return { perFile, records, consumers, findings, destination, tableScan, endpointScan, relatedVault: related, service, sourceHashes };
}

// ── 9. Checks ─────────────────────────────────────────────────────────────
const behaviorGaps = (records) => REQUIRED_BEHAVIORS.filter((b) => !records.some((r) => (r.behaviors ?? []).includes(b)));
function runChecks(inv) {
  const checks = []; const chk = (name, pass, details = "") => checks.push({ name, passed: Boolean(pass), details });
  const { perFile, records, consumers, service } = inv;
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
  for (const f of perFile) {
    if (f.kind === "route") { const rx = (f.text.match(/^router\.(get|post|put|patch|delete|head|options|all)\s*\(/gm) ?? []).length; const ast = f.records.filter((r) => r.kind === "route-handler").length; chk(`independent-route-count:${f.file}`, rx === ast, `regex=${rx} ast=${ast}`); }
    const fx = (f.text.match(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+[A-Za-z_$][\w$]*/gm) ?? []).length; const fa = f.records.filter((r) => r.kind === "function").length; chk(`independent-function-count:${f.file}`, fx === fa, `regex=${fx} ast=${fa}`);
    const ix = (f.text.match(/^(?:export\s+)?(?:interface|type)\s+[A-Za-z_$][\w$]*/gm) ?? []).length; const ia = f.records.filter((r) => r.kind === "interface" || r.kind === "type").length; chk(`independent-type-count:${f.file}`, ix === ia, `regex=${ix} ast=${ia}`);
    const cx = (f.text.match(/^(?:export\s+)?const\s+[A-Za-z_$][\w$]*/gm) ?? []).length; const ca = f.records.filter((r) => r.kind === "constant" || r.kind === "arrow-function" || r.kind === "router-instance").length; chk(`independent-const-count:${f.file}`, cx === ca, `regex=${cx} ast=${ca}`);
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
  for (const b of REQUIRED_BEHAVIORS) { const n = records.filter((r) => (r.behaviors ?? []).includes(b)).length; chk(`required-behavior-present:${b}`, n > 0, `records=${n}`); }
  chk("required-behavior-evidence-is-recorded-per-symbol", records.filter((r) => (r.behaviors ?? []).length).every((r) => r.behaviors.every((b) => (r.behavior_evidence?.[b] ?? []).length > 0)), "");
  for (const f of perFile) chk(`file-contributes-behaviors:${f.file}`, f.records.some((r) => (r.behaviors ?? []).length > 0) || service.compat_adapters.some((c) => c.file === f.file), service.compat_adapters.some((c) => c.file === f.file) ? "pure re-export adapter: carries no behavior of its own; target resolved" : "");
  chk("service-implementation-files-enumerated-by-directory-walk", SOURCES.filter((s) => s.startsWith(`${SERVICE_DIR}/`)).length >= 8 && serviceFiles().every((s) => SOURCES.includes(s)), `${SOURCES.filter((s) => s.startsWith(`${SERVICE_DIR}/`)).length} service files`);
  chk("service-contract-routes-extracted-from-source", service.contract_routes.length >= 4, `${service.contract_routes.length}`);
  chk("service-dispatch-routes-extracted-from-handler-ast", service.dispatch_routes.length >= 4, `${service.dispatch_routes.length}`);
  chk("service-contract-equals-dispatch", (() => { const a = new Set(service.contract_routes.map((r) => `${r.method} ${r.path}`)), b = new Set(service.dispatch_routes.map((r) => `${r.method} ${r.normalized_path}`)); return a.size === b.size && [...a].every((x) => b.has(x)); })(), `contract=${service.contract_routes.map((r) => `${r.method} ${r.path}`).join(" | ")} dispatch=${service.dispatch_routes.map((r) => `${r.method} ${r.normalized_path}`).join(" | ")}`);
  chk("service-events-published-equal-contract", JSON.stringify(service.published_events) === JSON.stringify([...service.contract_events].sort()), `published=${service.published_events.join(",")} contract=${service.contract_events.join(",")}`);
  chk("service-workspace-dependencies-resolve", service.workspace_dependencies.length >= 5 && service.workspace_dependencies.every((d) => d.resolves_to), service.workspace_dependencies.filter((d) => !d.resolves_to).map((d) => d.package).join(", "));
  chk("compat-adapters-resolve-to-existing-targets", service.compat_adapters.length >= 4 && service.compat_adapters.every((c) => c.resolved.every(Boolean)), JSON.stringify(service.compat_adapters.filter((c) => !c.resolved.every(Boolean))));
  chk("destination-context-recorded", inv.destination.length >= 10 && inv.destination.every((d) => d.exists), `${inv.destination.length} files`);
  chk("table-scan-derived-from-source", inv.tableScan.tables.length > 0 && inv.tableScan.tables_touched.length > 0, `vault tables=${inv.tableScan.tables.join(",")}`);
  chk("table-scan-resolved-every-drizzle-identifier", inv.tableScan.tables_touched.every((t) => !t.sql_table.startsWith("?")), inv.tableScan.tables_touched.filter((t) => t.sql_table.startsWith("?")).map((t) => t.identifiers.join(",")).join(" | "));
  chk("endpoint-caller-scan-derived-from-source", inv.endpointScan.route_paths.length > 0 && inv.endpointScan.callers.length > 0, `route_paths=${inv.endpointScan.route_paths.length} callers=${inv.endpointScan.callers.length}`);
  chk("all-fixed-sources-present", FIXED_SOURCES.every((p) => fs.existsSync(path.join(ROOT, p))), FIXED_SOURCES.filter((p) => !fs.existsSync(path.join(ROOT, p))).join(", "));
  chk("db-access-detected-in-vault-routes", records.some((r) => r.file.endsWith("routes/vault.ts") && r.kind === "route-handler" && r.touches_db), "routes/vault.ts must show DB access in at least one handler");
  chk("related-vault-files-recorded", Array.isArray(inv.relatedVault) && inv.relatedVault.length > 0, `related=${inv.relatedVault.length}`);
  return checks;
}

function selfTests() {
  const out = []; const t = (name, pass, details = "") => out.push({ name, passed: Boolean(pass), details });
  t("selftest:unrecognised-symbol-is-unclassified", classifySymbol({ kind: "constant", name: "MYSTERY", initializer_kind: "call-other", operations: {}, branch_total: 0 }).classification === "UNCLASSIFIED");
  t("selftest:db-function-is-application", classifySymbol({ kind: "function", name: "doThing", operations: { db: ["db.update"] }, touches_db: true, branch_total: 9 }).classification === "application");
  t("selftest:pure-function-is-domain", classifySymbol({ kind: "function", name: "calcAge", operations: {}, touches_db: false, branch_total: 1 }).classification === "domain");
  t("selftest:crypto-no-io-is-security", classifySymbol({ kind: "function", name: "seal", operations: { crypto: ["createCipheriv"] }, touches_db: false, branch_total: 0 }).classification === "security");
  t("selftest:step-up-is-security", classifySymbol({ kind: "function", name: "makeAccess", operations: { "step-up": ["verifyStepUpToken"] }, touches_db: false, branch_total: 0 }).classification === "security");
  const src = 'import { db, vaultEntriesTable } from "@workspace/db";\nrouter.post("/vault", requireAuth, async (req, res) => { if (!req.body.a) { res.status(400).json({ error: "bad" }); return; } await db.insert(vaultEntriesTable).values({}); await logVaultActivity(1); broadcastEvent("x"); res.json({}); });';
  const sf = parse("/x/routes/synthetic.ts", src); const a = analyze(sf.statements[1], sf, importsOf(sf));
  t("selftest:ast-detects-db-branch-status-audit-event", a.touches_db && a.operations.db?.includes("db.insert") && a.branches.if === 1 && a.response_statuses.includes(400) && a.operations.audit?.includes("logVaultActivity") && a.operations.event?.includes("broadcastEvent") && a.tables.includes("vaultEntriesTable"));
  const rec = { kind: "route-handler", method: "POST", route_path: "/vault", line_start: 2, name: "POST /vault" };
  const ev = behaviorEvidence(rec, "x/routes/synthetic.ts", sf, sf.statements.filter((s) => !ts.isImportDeclaration(s)));
  t("selftest:behavior-evidence-is-ast-and-route-derived", ev.behaviors.includes("secret-creation") && ev.behaviors.includes("audit") && ev.behaviors.includes("events") && ev.behavior_evidence.audit.includes("logVaultActivity"));
  const jsSrc = 'export function createAccess() { const consumed = new Set(); return { verifyReveal(request, { auth, tenant }) { return verifyStepUpToken(request.headers["x-step-up-token"], { workspaceId: tenant.workspaceId, consumed }); } }; }';
  const sfj = parse("/x/svc/access.mjs", jsSrc); const evj = behaviorEvidence({ kind: "function", name: "createAccess", line_start: 1 }, "svc/access.mjs", sfj, sfj.statements);
  t("selftest:mjs-parsed-and-step-up-tenant-evidence-detected", evj.behaviors.includes("step-up") && evj.behaviors.includes("tenant-scope") && evj.state_set_declarations.includes("consumed"));
  const sfh = parse("/x/svc/h.mjs", 'async function handle({ req, url }) { const m = url.pathname.match(/^\\/api\\/vault\\/secrets\\/([^/]+)$/); if (url.pathname === "/api/vault/secrets" && req.method === "GET") return 1; if (m && req.method === "GET") return 2; }');
  const dsp = serviceDispatch(sfh, "h.mjs");
  t("selftest:service-dispatch-extracted-from-ast", dsp.length === 2 && dsp.some((d) => d.kind === "literal" && d.path === "/api/vault/secrets") && dsp.some((d) => d.kind === "pattern" && normalizeSvcPath(d.path) === "/api/vault/secrets/:id"));
  const sfc = parse("/x/c.mjs", 'export const C = Object.freeze({ routes: [{ method: "GET", path: "/a" }], events: ["e.one"] });'); const cr = contractRoutes(sfc);
  t("selftest:contract-routes-and-events-extracted", cr.routes.length === 1 && cr.routes[0].path === "/a" && cr.events[0] === "e.one");
  t("selftest:crypto-facts-extracted", (() => { const f = cryptoFacts('createCipheriv("aes-256-gcm", k, iv); x.toString("base64url"); createHash("sha256")'); return f.algorithms[0] === "aes-256-gcm" && f.encodings[0] === "base64url" && f.key_derivation[0] === "createHash"; })());
  t("selftest:missing-behavior-evidence-fails-the-gap-check", behaviorGaps([{ behaviors: ["secret-creation"] }]).length === REQUIRED_BEHAVIORS.length - 1 && behaviorGaps([]).length === REQUIRED_BEHAVIORS.length);
  t("selftest:bypass-detector-rejects-flags", ["--skip-tests", "--force-pass", "--continue-on-error", "--skip"].every((f) => rejectBypassArgs([f]).length > 0));
  t("selftest:string-literal-sql-parsed", (() => { const s = 'import { pool } from "@workspace/db";\nasync function f(){ return pool.query("UPDATE vault_entries SET user_id=$1 WHERE id=$2", [1,2]); }'; const sf5 = parse("/x/routes/s.ts", s); const r = analyze(sf5.statements[1], sf5, importsOf(sf5)); return r.touches_db && r.operations.raw_sql?.some((q) => q.tables.includes("vault_entries")); })());
  return out;
}
function rejectBypassArgs(args) {
  const rx = /^--(skip|skip-validation|skip-tests|force|force-pass|ignore-failures|continue-on-error|no-verify|bypass|disable|dry-run|pass|assume-pass|no-tests|allow-failure)/i;
  return args.filter((a) => rx.test(a));
}

// ── 10. Baseline snapshot (pre-extraction freeze, WRITE-ONCE) ─────────────
function writeBaselineOnce(inv) {
  const manifestPath = path.join(BASELINE_DIR, "repo-manifest.json");
  if (fs.existsSync(manifestPath)) {
    const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const drift = m.sources.filter((s) => !fs.existsSync(path.join(ROOT, s.file)) || sha256(read(s.file)) !== s.sha256).map((s) => s.file);
    return { written: false, sources_identical_to_baseline: drift.length === 0, drift };
  }
  fs.mkdirSync(path.join(BASELINE_DIR, "sources"), { recursive: true });
  const manifest = [];
  for (const f of [...SOURCES, ...DESTINATION_CONTEXT]) {
    const dst = path.join(BASELINE_DIR, "sources", f.replace(/\//g, "__")); fs.copyFileSync(path.join(ROOT, f), dst);
    manifest.push({ file: f, baseline_copy: rel(dst), sha256: inv.sourceHashes[f], lines: read(f).split("\n").length });
  }
  const consumerFiles = [...new Set(inv.consumers.map((c) => c.consumer))];
  fs.writeFileSync(manifestPath, `${JSON.stringify({ sub_phase: SUB_PHASE, purpose: "Frozen pre-extraction sources for OLD→NEW differential proof in 05-B/05-D. Write-once: 05-A never overwrites an existing baseline.", sources: manifest, consumer_files: consumerFiles.map((c) => ({ file: c, sha256: sha256(read(c)) })) }, null, 2)}\n`);
  fs.writeFileSync(path.join(BASELINE_DIR, "symbol-inventory.pre-extraction.json"), `${JSON.stringify(inv.records.map((r) => ({ id: r.id, kind: r.kind, fingerprint_sha256: r.fingerprint_sha256, line_start: r.line_start, line_end: r.line_end, classification: r.classification, behaviors: r.behaviors })), null, 2)}\n`);
  return { written: true, sources_identical_to_baseline: true, drift: [] };
}

// ── 11. Summary / main ────────────────────────────────────────────────────
function summarize(inv) {
  const tally = (k) => inv.records.reduce((m, r) => ((m[r[k]] = (m[r[k]] ?? 0) + 1), m), {});
  const routes = inv.records.filter((r) => r.kind === "route-handler");
  const perFile = Object.fromEntries(inv.perFile.map((f) => [f.file, { kind: f.kind, in_roadmap_sources: f.in_roadmap_sources, lines: f.lineCount, records: f.records.length }]));
  return {
    files: inv.perFile.length, roadmap_source_files: inv.perFile.filter((f) => f.in_roadmap_sources).length, total_records: inv.records.length, per_file: perFile,
    by_kind: tally("kind"), by_classification: tally("classification"), by_behavior_domain: tally("behavior_domain"),
    required_behaviors: Object.fromEntries(REQUIRED_BEHAVIORS.map((b) => [b, inv.records.filter((r) => (r.behaviors ?? []).includes(b)).map((r) => r.id)])),
    route_handlers: routes.length, routes_with_business_behavior: routes.filter((r) => r.business_behavior_in_route).length, routes_touching_db: routes.filter((r) => r.touches_db).length,
    routes_delegating_to_vault: routes.filter((r) => (r.delegates_to_vault ?? []).length).length, routes_total_branches: routes.reduce((a, r) => a + r.branch_total, 0),
    external_consumer_files: new Set(inv.consumers.map((c) => c.consumer)).size, external_consumer_edges: inv.consumers.length,
    db_tables: inv.tableScan.tables, table_consumer_files: inv.tableScan.consumers.length, endpoint_caller_files: inv.endpointScan.callers.length,
    service: { contract_routes: inv.service.contract_routes.length, dispatch_routes: inv.service.dispatch_routes.length, events: inv.service.contract_events, compat_adapters: inv.service.compat_adapters.length },
    destination_state: inv.destination.map((d) => ({ file: d.file, holds_business_logic: d.holds_business_logic, exports: d.exports.length })),
    findings_high: inv.findings.filter((f) => f.severity === "HIGH").length, findings_low: inv.findings.filter((f) => f.severity === "LOW").length, findings_info: inv.findings.filter((f) => f.severity === "INFO").length,
  };
}
const hashBody = (inv) => JSON.stringify({ sourceHashes: inv.sourceHashes, records: inv.records, consumers: inv.consumers, findings: inv.findings, destination: inv.destination, tableScan: inv.tableScan, endpointScan: inv.endpointScan, service: inv.service });

function main() {
  const verify = process.argv.includes("--verify"); const started = Date.now();
  if (verify) {
    if (!fs.existsSync(EVIDENCE_FILE)) fail("evidence missing: run the validator without --verify first");
    const ev = JSON.parse(fs.readFileSync(EVIDENCE_FILE, "utf8")); const inv = buildInventory(); const b = binding(inv.sourceHashes); const problems = [];
    if (ev.sub_phase !== SUB_PHASE) problems.push("sub_phase mismatch");
    if (ev.commit_sha !== b.commit_sha) problems.push(`commit_sha mismatch (${ev.commit_sha} vs ${b.commit_sha})`);
    if (ev.source_tree_sha256 !== b.source_tree_sha256) problems.push("source tree changed since evidence was generated (stale)");
    if (ev.inventory_sha256 !== sha256(hashBody(inv))) problems.push("inventory content does not match a fresh census (tampered or stale)");
    const stored = sha256(JSON.stringify({ sourceHashes: ev.source_hashes, records: ev.records, consumers: ev.consumers, findings: ev.findings, destination: ev.destination_context, tableScan: ev.table_consumers, endpointScan: ev.endpoint_callers, service: ev.service }));
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
  const baseline = writeBaselineOnce(inv);
  checks.push({ name: "baseline-frozen-write-once", passed: fs.existsSync(path.join(BASELINE_DIR, "repo-manifest.json")), details: baseline.written ? "written now" : `existing baseline kept; sources identical=${baseline.sources_identical_to_baseline}${baseline.drift.length ? ` drift=${baseline.drift.join(",")}` : ""}` });
  const failed = checks.filter((c) => !c.passed); const b = binding(inv.sourceHashes);
  const evidence = {
    phase: PHASE, sub_phase: SUB_PHASE,
    commit_sha: b.commit_sha, commit_binding: b.commit_binding, source_tree_sha256: b.source_tree_sha256,
    validator_version: VALIDATOR_VERSION, validator_sha256: sha256(fs.readFileSync(SELF, "utf8")),
    generated_at: new Date().toISOString(),
    source_hashes: inv.sourceHashes,
    commands: ["node scripts/antas/vault/gap/validate-vlt-gap-05-A.mjs"],
    exit_codes: { validator: failed.length ? 1 : 0, typescript_parse: inv.perFile.every((f) => (f.sf.parseDiagnostics ?? []).length === 0) ? 0 : 1 },
    symbols_moved: [], consumers_migrated: [],
    old_business_symbols_remaining: inv.records.filter((r) => r.kind !== "router-instance" && r.kind !== "export-assignment").map((r) => r.id),
    duplicate_implementations: [],
    scope: { roadmap_sources: FIXED_SOURCES, censused_sources: SOURCES, additional_service_sources_reason: "services/vault/src/index.mjs is the composition root; the composed implementation lives in sibling modules which were enumerated by directory walk so the roadmap's required behaviors can be evidenced from source.", destination_context: DESTINATION_CONTEXT },
    baseline: { dir: rel(BASELINE_DIR), ...baseline },
    summary: summarize(inv), checks, inventory_sha256: sha256(hashBody(inv)),
    notes: [
      "05-A is a census only: no code was moved; symbols_moved/consumers_migrated are intentionally empty. duplicate_implementations is computed in 05-B/05-D.",
      "Behavior attribution is by AST evidence only (identifiers, member calls, string literals, route shape, object-literal methods/properties); each attributed behavior lists the exact evidence tokens. A symbol may evidence several behaviors.",
      "routes/vault.ts is already partly extracted by GAP-01/02 (entity lifecycle/create/update/bulk/analytics/admin/receipt/activity live under vault/application/entity/*); the census records which handlers still hold business behavior inline (routes-without-vault-delegation finding).",
      "lib/vault-crypto.ts is a compatibility re-export of vault/crypto/field-encryption.ts; the census records the re-exported symbols and resolves the target.",
      "services/vault is a self-contained service with its own state store (collection 'records'), crypto envelope, step-up verification, audit log and outbox publisher; it does not use the api-server vault_entries table. See findings for the parallel-store / two-crypto-format observations.",
      "Build/typecheck and behavioral differential tests are required from 05-B onward; a write-once pre-extraction baseline is written to baseline/.",
    ],
    status: failed.length === 0 ? "PASS" : "FAIL",
    findings: inv.findings,
    destination_context: inv.destination, table_consumers: inv.tableScan, endpoint_callers: inv.endpointScan, related_vault_files: inv.relatedVault, service: inv.service,
    files: inv.perFile.map((f) => ({ file: f.file, kind: f.kind, in_roadmap_sources: f.in_roadmap_sources, sha256: inv.sourceHashes[f.file], lines: f.lineCount, top_level_statements: f.stmtCount, records: f.records.length, imports: f.imports })),
    records: inv.records, consumers: inv.consumers,
  };
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(EVIDENCE_FILE, `${JSON.stringify(evidence, null, 2)}\n`);
  for (const f of inv.findings.filter((x) => x.severity === "HIGH")) console.warn(`  FINDING[${f.severity}] ${f.detail}`);
  const s = evidence.summary;
  console.log(`${SUB_PHASE} ${evidence.status} — ${s.total_records} records in ${s.files} files, ${s.route_handlers} routes, ${s.external_consumer_edges} consumer edges, ${s.table_consumer_files} table-access files, ${evidence.findings.length} findings (${Date.now() - started}ms)`);
  if (failed.length) { console.error(failed.map((c) => `- ${c.name}: ${String(c.details || "not satisfied").slice(0, 400)}`).join("\n")); process.exit(1); }
}
main();
