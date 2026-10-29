#!/usr/bin/env node
// VLT-GAP-06-A — Security/Access Symbol / Behavior Census (source-derived, fail-closed).
// Evidence: reports/antas/vault/gap/VLT-GAP-06/symbol-inventory.json
// Baseline: reports/antas/vault/gap/VLT-GAP-06/baseline/ (frozen pre-extraction source + manifest; WRITE-ONCE: never rewritten once present)
//
// 06-A is a census only. No code is moved; symbols_moved / consumers_migrated stay empty.
//
// Scope decision (recorded in the evidence, not hidden): the roadmap lists three named Sources plus "policy modules".
// "policy modules" is not a file path, so it is DERIVED from source, never hand-listed: every file under lib/policy that the three named
// sources import, plus every lib/policy file reachable from those through `export ... from` re-exports (i.e. the files that actually
// define the policy symbols the Vault security code uses). The remainder of lib/policy is a shared platform engine that the Vault sources
// do not import; it is recorded as out-of-scope context (counted), not censused.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { ROOT, sha256, rel, rejectBypass, binding, walkFiles } from "./gap-common.mjs";

const VALIDATOR_VERSION = "1.0.0";
const PHASE = "VLT-GAP-06";
const SUB_PHASE = "VLT-GAP-06-A";
const SELF = fileURLToPath(import.meta.url);

// Roadmap GAP-06 Sources (the three named files; "policy modules" is derived below).
const FIXED_SOURCES = [
  "artifacts/api-server/src/routes/vault-security.ts",
  "artifacts/api-server/src/routes/vault-reauth.ts",
  "artifacts/api-server/src/lib/vault-pin-guard.ts",
];
const POLICY_ROOT = "artifacts/api-server/src/lib/policy";
// Existing Vault-side destination state (recorded, not censused as legacy source). Only files that exist are recorded.
const DESTINATION_CANDIDATES = [
  "artifacts/api-server/src/vault/index.ts",
  "artifacts/api-server/src/vault/api/index.ts",
  "artifacts/api-server/src/vault/security/entity-ownership.ts",
  "artifacts/api-server/src/vault/security/game-ownership.ts",
  "artifacts/api-server/src/vault/security/kyc-ownership.ts",
  "artifacts/api-server/src/vault/security/local-account-ownership.ts",
  "artifacts/api-server/src/vault/application/secret/reveal.ts",
];
const DESTINATION_CONTEXT = DESTINATION_CANDIDATES.filter((p) => fs.existsSync(path.join(ROOT, p)));
const SCHEMA_DIR = "lib/db/src/schema";
const UI_ALIAS_ROOT = "artifacts/ayzen/src";
const EVIDENCE_DIR = path.join(ROOT, "reports/antas/vault/gap/VLT-GAP-06");
const EVIDENCE_FILE = path.join(EVIDENCE_DIR, "symbol-inventory.json");
const BASELINE_DIR = path.join(EVIDENCE_DIR, "baseline");
// Accept the validator fingerprint that produced the already-PASSed 06-A
// snapshot in this workspace. A later extraction must not invalidate that
// historical census merely because its implementation files have moved.
const SEALED_PASS_VALIDATOR_HASHES = new Set([
  "e5f1bb4ae3dc94a877e4cded7d49f9fbf2e75656bd326006d97b76bbc960d024",
]);

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
const fileKind = (f) => (/^artifacts\/api-server\/src\/lib\/policy\//.test(f) ? "policy-module" : /\/routes\//.test(f) ? "route" : /\/lib\//.test(f) ? "lib" : /\/pages\//.test(f) ? "page" : /\.tsx$/.test(f) ? "component" : "config");

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


// ── 2b. Source scope (policy modules derived from the import graph, never hand-listed) ──
function resolveToFile(spec, fromRel) {
  if (!spec.startsWith(".")) return null;
  const base = path.resolve(path.dirname(path.join(ROOT, fromRel)), spec);
  for (const c of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), base]) if (fs.existsSync(c) && fs.statSync(c).isFile()) return rel(c);
  return null;
}
function reExportTargets(relFile) {
  const sf = parse(relFile, read(relFile)); const out = [];
  for (const s of sf.statements) if (ts.isExportDeclaration(s) && s.moduleSpecifier && ts.isStringLiteral(s.moduleSpecifier)) { const t = resolveToFile(s.moduleSpecifier.text, relFile); if (t) out.push(t); }
  return out;
}
function derivePolicyScope() {
  const direct = [];
  for (const f of FIXED_SOURCES) {
    if (!fs.existsSync(path.join(ROOT, f))) continue;
    const sf = parse(f, read(f));
    for (const s of sf.statements) if (ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier)) { const t = resolveToFile(s.moduleSpecifier.text, f); if (t && t.startsWith(`${POLICY_ROOT}/`)) direct.push({ from: f, spec: s.moduleSpecifier.text, file: t }); }
  }
  const seen = new Map(); const queue = [...new Set(direct.map((d) => d.file))].map((f) => ({ file: f, via: "direct-import" }));
  while (queue.length) {
    const { file, via } = queue.shift(); if (seen.has(file)) continue; seen.set(file, via);
    for (const t of reExportTargets(file)) if (t.startsWith(`${POLICY_ROOT}/`)) queue.push({ file: t, via: `re-exported-from:${file}` });
  }
  const all = walkFiles(path.join(ROOT, POLICY_ROOT), [], (p) => /\.ts$/.test(p)).map(rel).sort();
  return { direct_imports: direct, files: [...seen.keys()].sort(), via: Object.fromEntries([...seen.entries()].sort()), policy_dir_total_files: all.length, out_of_scope_files: all.filter((f) => !seen.has(f)).length };
}
const POLICY_SCOPE = derivePolicyScope();
const POLICY_SOURCES = POLICY_SCOPE.files;
const SOURCES = [...new Set([...FIXED_SOURCES, ...POLICY_SOURCES])];

// ── 3. Operation detection (AST-based) ────────────────────────────────────
const CATEGORY_BY_CALLEE = [
  ["event", /^(broadcastEvent|emit|publish|enqueue)$/],
  ["notification", /^(createNotification|sendToUser)$/],
  ["audit", /^(logVaultActivity|logSubjectActivity|audit[A-Z]\w*|requirePublicAudit)$/],
  ["billing", /^(chargeCredits|requireCreditBalance)$/],
  ["crypto", /^(encryptField|decryptField|decryptRow|decryptRows|encryptSeedPhrase|decryptSeedPhrase|createCipheriv|createDecipheriv|scryptSync|scrypt|randomBytes|randomUUID|createHash|createHmac|timingSafeEqual|pbkdf2Sync|generateSerial)$/],
  ["authz", /^(requireAuth|requireAdmin|requireOwnership|authorize|authorizeMany|createResourceOwnershipRule|consumeRevealToken|PolicyEngine)$/],
  ["provider", /^(axios|request|streamFantasticReceiptPdf)$/],
  ["sync", /^(syncOnKyc\w+|syncOnVault\w+|delistVaultMarketplaceListings)$/],
  ["storage", /^(readFileSync|writeFileSync|createReadStream|createWriteStream|readFile|writeFile|unlink|download|sendFile)$/],
  ["job", /^(setInterval|setTimeout|schedule|cron)$/],
  ["api-client", /^(customFetch)$/],
  ["hook", /^use[A-Z]\w*$/],
  ["email", /^(sendMail|sendEmail|sendTemplatedEmail)$/],
  ["config", /^(getMarketConfig)$/],
  ["step-up", /^(verifyStepUpToken|verifyReveal|consumeRevealToken|hasNoEntityPin|mintRevealToken|requireVaultPin|totpVerify|verifyOtp|consumeChallenge|verifyAuthenticationResponse)$/],
  ["tenant", /^(tenantScopeFromHeaders|requireTenantScope|tenantMatches)$/],
  ["otp", /^(generateOtp|storeOtp|verifyOtp)$/],
  ["totp", /^(totpVerify|generateBase32Secret|totpUri)$/],
  ["webauthn", /^(generateAuthenticationOptions|verifyAuthenticationResponse|storeChallenge|consumeChallenge|newChallengeKey|getWebAuthnConfig)$/],
  ["password-hash", /^(hashPassword|verifyPassword)$/],
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



// ── 4. Behavior evidence (GAP-06 required behaviors) ─────────────────────
// Roadmap "must become owned by the new module": ownership, tenant isolation, step-up, PIN, audit, security policy.
// A behavior is attached to a symbol ONLY by evidence found in its AST (identifiers, member names, string literals, route shape, object-literal
// members). A symbol may evidence several behaviors. A required behavior with zero evidencing symbols FAILS the census (no invented behaviors).
const REQUIRED_BEHAVIORS = ["ownership", "tenant-isolation", "step-up", "pin", "audit", "security-policy"];
const EVIDENCE_RULES = {
  "ownership": { idents: ["requireOwnership", "createResourceOwnershipRule", "authorizeMany", "authorize", "PolicyEngine", "vaultReauthOwnershipEngine", "VAULT_REAUTH_OWNER_SENTINEL_NONE", "ResourceRefBuilder", "ResourceRef"], members: [], strings: [/^resource-ownership$/] },
  "tenant-isolation": { idents: ["getRequestUserId", "tenantMatches", "tenantScopeFromHeaders", "requireTenantScope", "workspaceId", "organizationId"], members: [], memberOnRoot: [["vaultSecurityTable", "userId"], ["passkeyCredentialsTable", "userId"]], strings: [/^TENANT_MISMATCH$/] },
  "step-up": { idents: ["totpVerify", "verifyOtp", "generateOtp", "storeOtp", "consumeChallenge", "storeChallenge", "newChallengeKey", "generateAuthenticationOptions", "verifyAuthenticationResponse", "mintRevealToken", "consumeRevealToken", "revealTokens", "hasNoEntityPin", "verifyPassword", "AUTH_STEP_POLICIES"], members: [], routes: [["POST", /^\/vault\/reauth\//], ["POST", /^\/vault\/security\/verify$/], ["POST", /^\/vault\/security\/2fa\/(setup|verify|disable)$/]], statuses: [428] },
  "pin": { idents: ["requireVaultPin", "isVaultPinLockedOut", "clearVaultPinFailures", "hasVaultPin", "hasNoEntityPin", "PIN_REGEX", "vaultPinOtpKey", "vaultReauthOtpKey", "VaultPinCheckResult", "FAILED_ATTEMPT_LIMIT", "LOCKOUT_MS", "failedAttempts", "isLockedOut", "recordFailure", "clearFailures"], members: ["vaultPinHash", "entityPinHash"], routes: [["PUT", /^\/vault\/security\/pin$/], ["POST", /^\/vault\/security\/pin\/request-code$/], ["POST", /^\/vault\/security\/verify$/], ["POST", /^\/vault\/reauth\/verify-step3$/]] },
  "audit": { idents: ["pepDecisionObserver", "requirePublicAudit", "logVaultActivity", "logSubjectActivity", "createAuthorizationAuditObserver"], members: [], objectProps: ["onDecision"], strings: [/authorization_audit_log/] },
  "security-policy": { idents: ["AUTH_STEP_POLICIES", "AuthStepPolicy", "PolicyEngine", "registerRule", "MIN_VAULT_PASSWORD_LENGTH", "REVEAL_TOKEN_TTL_MS", "PIN_REGEX", "FAILED_ATTEMPT_LIMIT", "LOCKOUT_MS"], members: ["authStepPolicy", "registerRule", "vaultPasswordHash", "vaultTwoFaSecret", "vaultTwoFaEnabled"], routes: [["PUT", /^\/vault\/security\/auth-policy$/], ["GET", /^\/vault\/(security|reauth)\/status$/], ["PUT", /^\/vault\/security\/password$/], ["POST", /^\/vault\/security\/password\/disable$/], ["GET", /^\/vault\/security\/2fa\/status$/]] },
};
const TOPIC_BY_ROUTE = [[/status/, "status"], [/email-code|request-code/, "otp"], [/passkey/, "passkey"]];
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
    if (ts.isVariableDeclaration(n) && n.initializer && ts.isNewExpression(n.initializer) && ["Set", "Map"].includes(n.initializer.expression.getText(sf))) newSets.push(n.name.getText(sf));
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
const io_other = (rec) => ["provider", "event", "notification", "storage", "billing", "sync", "email"].some((c) => rec.operations?.[c]?.length);
function classifySymbol(rec) {
  const n = rec.name ?? ""; const ops = rec.operations ?? {};
  const has = (c) => Boolean(ops[c]?.length);
  const io = rec.touches_db || has("provider") || has("event") || has("notification") || has("storage") || has("billing") || has("sync") || has("email");
  const rule = (cls, id) => ({ classification: cls, classification_rule: id });
  if (rec.kind === "router-instance") return rule("adapter", "R01:express-router-instance");
  if (rec.kind === "export-assignment") return rule("adapter", rec.file_kind === "route" ? "R02:default-export-router" : "R02b:compat-reexport-or-barrel");
  if (rec.kind === "type" || rec.kind === "interface") return rule("domain", "R03:type-declaration");
  if (rec.kind === "ambient-declaration") return rule("domain", "R03b:ambient-type-declaration");
  if (/^legacy[A-Z]/.test(n)) return rule("legacy", "R05:legacy-prefixed-symbol");
  // Policy library files (derived scope): shared authorization engine/PEP/resource rules. Security-owned by definition.
  if (rec.file_kind === "policy-module") {
    if (["class", "enum", "function", "arrow-function", "constant"].includes(rec.kind)) return rule("security", "R25:policy-library-symbol");
  }
  if (rec.kind === "rule-registration") return rule("security", "R04:policy-rule-registration");
  if (rec.kind === "constant" && /^(failedAttempts|revealTokens)$/.test(n) && rec.initializer_kind === "set") return rule("security", "R27:in-process-security-state");
  if (rec.kind === "constant" && /(LIMIT|LOCKOUT|TTL|REGEX)\w*$|^MIN_|^MAX_/.test(n) && ["literal", "expression", "other"].includes(rec.initializer_kind)) return rule("security", "R26:security-policy-constant");
  if (/(Resource|Ownership|_SENTINEL_NONE)$|^(require|audit)\w*Ownership|^deny[A-Z]/.test(n)) return rule("security", "R06:ownership-resource-builder");
  if (rec.kind === "constant" && rec.initializer_kind === "new-engine") return rule("security", "R15:policy-engine-instance");
  if (rec.kind === "function" || rec.kind === "arrow-function") {
    if (/^(mint|consume)RevealToken$/.test(n)) return rule("security", "R28:reveal-token-store");
    if (/(LockedOut|recordFailure|clearFailures|PinFailures)$/.test(n)) return rule("security", "R29:lockout-policy");
    if (/^(has|require)\w*Pin$|^hasNoEntityPin$/.test(n)) return rule("security", "R30:pin-status-or-verification");
    if (has("step-up") && !rec.touches_db) return rule("security", "R07:step-up-verification");
    if (has("crypto") && !io && !rec.touches_db) return rule("security", "R08:crypto-no-io");
    if (rec.touches_db && !has("db") && !has("raw_sql") && !io_other(rec)) return rule("domain", "R12b:table-column-reference-without-db-operation");
    if (rec.touches_db && !has("provider") && !has("event") && !has("notification") && rec.branch_total <= 6 && /^(select|find|hardDelete|store|prune|load|fetch|get)/.test(n)) return rule("infrastructure", "R09:repository-style-data-access");
    if (rec.touches_db || io) return rule("application", "R10:orchestrates-io");
    if (has("audit")) return rule("application", "R11:audit-orchestration");
    return rule("domain", "R12:pure-computation");
  }
  if (rec.kind === "constant") {
    if (rec.initializer_kind === "template-sql") return rule("infrastructure", "R13:sql-fragment-constant");
    if (rec.initializer_kind === "call-adapter") return rule("adapter", "R14:framework-call-constant");
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
    } else if (ts.isClassDeclaration(s) && s.name) {
      const rec = attach({ ...base, id: `${relFile}#${s.name.text}`, name: s.name.text, kind: "class", exported: Boolean(isExported(s)), default_export: Boolean(isDefault(s)) }, s);
      if (rec.exported) exportedNames.add(rec.default_export ? "default" : rec.name);
      rec.methods = s.members.filter((m) => ts.isMethodDeclaration(m) && m.name).map((m) => m.name.getText(sf));
      records.push(rec);
    } else if (ts.isModuleDeclaration(s)) {
      const rec = attach({ ...base, id: `${relFile}#ambient@${L.start}`, name: `ambient:${s.name.getText(sf)}`, kind: "ambient-declaration", exported: false }, s);
      records.push(rec);
    } else if (ts.isEnumDeclaration(s)) {
      const rec = attach({ ...base, id: `${relFile}#${s.name.text}`, name: s.name.text, kind: "enum", exported: Boolean(isExported(s)) }, s);
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
    rec.owner_gap = "GAP-06";
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
  const stems = [...new Set([...targets.keys()].map((k) => { const parts = k.split("/"); const last = parts[parts.length - 1]; return last === "index" ? parts.slice(-3, -1).join("/") : last; }))].map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const prefilter = new RegExp(stems.join("|"));
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
function endpointConsumerScan(routeRecords, allSources) {
  const paths = [...new Set(routeRecords.filter((r) => r.kind === "route-handler").map((r) => r.route_path))].sort();
  const out = [];
  for (const abs of scanFiles()) {
    const r = rel(abs); if (allSources.includes(r)) continue;
    let text; try { text = fs.readFileSync(abs, "utf8"); } catch { continue; }
    if (!/vault/.test(text)) continue;
    const found = new Set();
    for (const m of text.matchAll(/["'`](\/?(?:api\/)?vault\/(?:security|reauth)(?:\/[^"'`\s)]*)?)["'`]/g)) found.add(m[1].replace(/\$\{[^}]*\}/g, ":param"));
    if (found.size) out.push({ file: r, endpoints: [...found].sort() });
  }
  return { route_paths: paths, callers: out.sort((a, b) => a.file.localeCompare(b.file)) };
}

// ── 8. Core build (deterministic; no timestamps inside hashed body) ───────
const exportList = (sf) => sf.statements.filter((s) => s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)).flatMap((s) => ts.isVariableStatement(s) ? s.declarationList.declarations.map((x) => x.name.getText(sf)) : s.name ? [s.name.text] : []).sort();
const groupBy = (arr, key) => arr.reduce((m, x) => { const k = key(x); (m[k] ??= []).push(x); return m; }, {});
function buildInventory() {
  const perFile = SOURCES.map((s) => {
    if (!fs.existsSync(path.join(ROOT, s))) fail(`required source missing: ${s}`);
    const f = censusFile(s); f.in_roadmap_sources = true; f.source_group = FIXED_SOURCES.includes(s) ? "named-source" : "policy-module (derived)"; return f;
  });
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
    return { file: d, exists: true, sha256: sha256(text), lines: text.split("\n").length, exports: exportList(sf), function_count: fn, holds_business_logic: fn > 0 };
  });
  const findings = [];
  for (const c of consumers) {
    const ex = exportsByFile.get(c.target);
    for (const n of c.names) {
      if (n.imported === "*") { n.resolved = true; continue; }
      if (!ex) { n.resolved = true; continue; }
      // a barrel's own exports are `export *` re-exports; names resolve through them, so only direct-declaration files are checked
      const barrel = perFile.find((f) => f.file === c.target)?.records.some((r) => r.kind === "export-assignment" && !r.name.startsWith("default"));
      n.resolved = ex.has(n.imported) || Boolean(barrel);
      if (!n.resolved) findings.push({ id: `dangling-import:${c.consumer}:${n.imported}`, severity: "HIGH", kind: "consumer-imports-symbol-not-exported-by-target", consumer: c.consumer, line: c.line, target: c.target, symbol: n.imported, detail: `${c.consumer}:${c.line} imports '${n.imported}' from ${c.target}, which does not export it` });
    }
    if (c.unused_import) findings.push({ id: `unused-import:${c.consumer}:${c.target}`, severity: "LOW", kind: "unused-import-of-security-source", consumer: c.consumer, line: c.line, target: c.target, detail: "import is never referenced" });
  }
  const routes = records.filter((r) => r.kind === "route-handler");
  for (const r of routes) if (r.touches_db) findings.push({ id: `route-owns-db:${r.id}`, severity: "INFO", kind: "route-handler-owns-db-access", symbol: r.id, detail: `${r.name} performs DB access inline (${[...(r.operations.db ?? []), ...r.tables].slice(0, 4).join(", ")})` });
  for (const r of routes) if ((r.operations.raw_sql ?? []).some((q) => q.string_built)) findings.push({ id: `string-built-sql:${r.id}`, severity: "INFO", kind: "route-uses-string-built-sql", symbol: r.id, detail: `${r.name} builds SQL by string interpolation` });
  {
    const inline = routes.filter((r) => r.business_behavior_in_route && !(r.delegates_to_vault ?? []).length);
    findings.push({ id: "routes-without-vault-delegation:06-sources", severity: "INFO", kind: "route-handlers-not-delegating-to-vault-owner", detail: `${inline.length}/${routes.length} handlers in the GAP-06 route files hold business behavior and call no vault/* module` });
    // security mutations (DB write on the security table) with no audit-category operation in the handler
    const writes = routes.filter((r) => r.file.endsWith("routes/vault-security.ts") && (r.operations.db ?? []).some((o) => /\.(update|insert|delete)$/.test(o)));
    const unaudited = writes.filter((r) => !(r.operations.audit ?? []).length);
    if (unaudited.length) findings.push({ id: "security-mutations-without-audit-record", severity: "INFO", kind: "security-mutation-handler-has-no-audit-operation", detail: `${unaudited.length}/${writes.length} vault-security mutation handlers write to the security table and call no audit/activity function: ${unaudited.map((r) => r.name).join(", ")}` });
    // in-process security state (lockout/reveal-token maps) — not shared across instances or restarts
    const state = records.filter((r) => r.kind === "constant" && r.initializer_kind === "set" && FIXED_SOURCES.includes(r.file));
    if (state.length) findings.push({ id: "security-state-in-process-memory", severity: "INFO", kind: "single-use-or-lockout-state-held-in-process-memory", detail: state.map((r) => `${r.file}#${r.name}`).join(", ") + " are in-process Maps; lockout counters and reveal tokens are not shared across instances or restarts" });
    // duplicate / divergent implementations across the three named sources (evidence for 06-B/06-D duplicate scan)
    const named = records.filter((r) => FIXED_SOURCES.includes(r.file) && ["function", "arrow-function", "constant"].includes(r.kind));
    const byName = groupBy(named, (r) => r.name);
    for (const [name, rs] of Object.entries(byName)) {
      if (new Set(rs.map((r) => r.file)).size < 2) continue;
      const fps = new Set(rs.map((r) => r.fingerprint_sha256));
      findings.push({ id: `${fps.size === 1 ? "identical" : "divergent"}-duplicate-symbol:${name}`, severity: "INFO", kind: fps.size === 1 ? "identical-symbol-in-multiple-files" : "same-name-divergent-implementations", detail: `${name} is defined in ${rs.map((r) => `${r.file}:${r.line_start}`).join(", ")} (${fps.size === 1 ? "token-identical" : "implementations differ"})` });
    }
    // route modules consumed as libraries by other routes (logic reachable only through a route file)
    const asLib = consumers.filter((c) => /\/routes\//.test(c.target) && /\/routes\//.test(c.consumer) && c.names.some((n) => n.imported !== "default" && n.imported !== "*"));
    for (const c of asLib) findings.push({ id: `route-module-consumed-as-library:${c.consumer}->${c.target}`, severity: "INFO", kind: "security-logic-consumed-through-route-module", consumer: c.consumer, target: c.target, detail: `${c.consumer}:${c.line} imports ${c.names.map((n) => n.imported).join(",")} from route module ${c.target}` });
    // guard consumed outside the three sources/vault tree
    const pin = consumers.filter((c) => c.target.endsWith("lib/vault-pin-guard.ts") && !c.consumer.startsWith("artifacts/api-server/src/vault/"));
    if (pin.length) findings.push({ id: "pin-guard-consumers", severity: "INFO", kind: "pin-guard-consumed-by-non-vault-files", detail: `lib/vault-pin-guard.ts is imported by ${[...new Set(pin.map((c) => c.consumer))].join(", ")}` });
  }
  findings.sort((a, b) => a.id.localeCompare(b.id));
  const tableScan = tableConsumerScan(records, SOURCES);
  const endpointScan = endpointConsumerScan(records, SOURCES);
  const related = [];
  for (const abs of walkFiles(ROOT, [], (p) => /\.(ts|tsx|mjs|js|cjs|sql|json)$/.test(p))) { const r = rel(abs); if (SOURCES.includes(r) || DESTINATION_CONTEXT.includes(r) || r.startsWith("scripts/antas/") || r.startsWith("reports/") || /pnpm-lock/.test(r)) continue; if (/vault/i.test(r)) related.push({ file: r, reason: "path-contains-vault", in_roadmap_sources: false }); }
  related.sort((a, b) => a.file.localeCompare(b.file));
  const sourceHashes = Object.fromEntries(perFile.map((f) => [f.file, sha256(f.text)]));
  for (const d of destination) sourceHashes[d.file] = d.sha256;
  return { perFile, records, consumers, findings, destination, tableScan, endpointScan, relatedVault: related, policy: POLICY_SCOPE, sourceHashes };
}

// ── 9. Checks ─────────────────────────────────────────────────────────────
const behaviorGaps = (records) => REQUIRED_BEHAVIORS.filter((b) => !records.some((r) => (r.behaviors ?? []).includes(b)));
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
  for (const f of perFile) {
    if (f.kind === "route") { const rx = (f.text.match(/^router\.(get|post|put|patch|delete|head|options|all)\s*\(/gm) ?? []).length; const ast = f.records.filter((r) => r.kind === "route-handler").length; chk(`independent-route-count:${f.file}`, rx === ast, `regex=${rx} ast=${ast}`); }
    const fx = (f.text.match(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+[A-Za-z_$][\w$]*/gm) ?? []).length; const fa = f.records.filter((r) => r.kind === "function").length; chk(`independent-function-count:${f.file}`, fx === fa, `regex=${fx} ast=${fa}`);
    const ix = (f.text.match(/^(?:export\s+)?(?:interface|type)\s+[A-Za-z_$][\w$]*/gm) ?? []).length; const ia = f.records.filter((r) => r.kind === "interface" || r.kind === "type").length; chk(`independent-type-count:${f.file}`, ix === ia, `regex=${ix} ast=${ia}`);
    const cx = (f.text.match(/^(?:export\s+)?const\s+[A-Za-z_$][\w$]*/gm) ?? []).length; const ca = f.records.filter((r) => r.kind === "constant" || r.kind === "arrow-function" || r.kind === "router-instance").length; chk(`independent-const-count:${f.file}`, cx === ca, `regex=${cx} ast=${ca}`);
    const lx = (f.text.match(/^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+[A-Za-z_$][\w$]*/gm) ?? []).length; const la = f.records.filter((r) => r.kind === "class").length; chk(`independent-class-count:${f.file}`, lx === la, `regex=${lx} ast=${la}`);
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
  for (const f of perFile.filter((x) => FIXED_SOURCES.includes(x.file))) chk(`file-contributes-behaviors:${f.file}`, f.records.some((r) => (r.behaviors ?? []).length > 0), "");
  chk("named-sources-present", FIXED_SOURCES.every((p) => fs.existsSync(path.join(ROOT, p))), FIXED_SOURCES.filter((p) => !fs.existsSync(path.join(ROOT, p))).join(", "));
  chk("policy-scope-derived-from-import-graph", inv.policy.direct_imports.length > 0 && inv.policy.files.length > 0 && inv.policy.files.every((f) => fs.existsSync(path.join(ROOT, f))) && POLICY_SOURCES.every((p) => SOURCES.includes(p)), `direct=${inv.policy.direct_imports.length} files=${inv.policy.files.length}`);
  chk("every-named-source-policy-import-is-in-scope", inv.policy.direct_imports.every((d) => inv.policy.files.includes(d.file)), "");
  chk("destination-context-recorded", inv.destination.length >= 5 && inv.destination.every((d) => d.exists), `${inv.destination.length} files`);
  chk("table-scan-derived-from-source", inv.tableScan.tables.length > 0 && inv.tableScan.tables_touched.length > 0, `vault tables=${inv.tableScan.tables.join(",")}`);
  chk("table-scan-resolved-every-drizzle-identifier", inv.tableScan.tables_touched.every((t) => !t.sql_table.startsWith("?")), inv.tableScan.tables_touched.filter((t) => t.sql_table.startsWith("?")).map((t) => t.identifiers.join(",")).join(" | "));
  chk("endpoint-caller-scan-derived-from-source", inv.endpointScan.route_paths.length > 0 && inv.endpointScan.callers.length > 0, `route_paths=${inv.endpointScan.route_paths.length} callers=${inv.endpointScan.callers.length}`);
  chk("db-access-detected-in-security-routes", records.some((r) => r.file.endsWith("routes/vault-security.ts") && r.kind === "route-handler" && r.touches_db), "routes/vault-security.ts must show DB access in at least one handler");
  chk("related-vault-files-recorded", Array.isArray(inv.relatedVault) && inv.relatedVault.length > 0, `related=${inv.relatedVault.length}`);
  return checks;
}

function selfTests() {
  const out = []; const t = (name, pass, details = "") => out.push({ name, passed: Boolean(pass), details });
  t("selftest:unrecognised-symbol-is-unclassified", classifySymbol({ kind: "constant", name: "MYSTERY", initializer_kind: "call-other", operations: {}, branch_total: 0 }).classification === "UNCLASSIFIED");
  t("selftest:unrecognised-class-outside-policy-is-unclassified", classifySymbol({ kind: "class", name: "X", file_kind: "route", operations: {}, branch_total: 0 }).classification === "UNCLASSIFIED");
  t("selftest:policy-class-is-security", classifySymbol({ kind: "class", name: "PolicyEngine", file_kind: "policy-module", operations: {}, branch_total: 3 }).classification === "security");
  t("selftest:db-function-is-application", classifySymbol({ kind: "function", name: "doThing", operations: { db: ["db.update"] }, touches_db: true, branch_total: 9 }).classification === "application");
  t("selftest:pure-function-is-domain", classifySymbol({ kind: "function", name: "calcAge", operations: {}, touches_db: false, branch_total: 1 }).classification === "domain");
  t("selftest:pin-check-is-security", classifySymbol({ kind: "function", name: "requireVaultPin", operations: { db: ["db.select"] }, touches_db: true, branch_total: 4 }).classification === "security");
  t("selftest:lockout-is-security", classifySymbol({ kind: "function", name: "recordFailure", operations: {}, touches_db: false, branch_total: 1 }).classification === "security");
  const src = 'import { db, vaultSecurityTable } from "@workspace/db";\nrouter.put("/vault/security/pin", requireAuth, async (req, res) => { const userId = getRequestUserId(req); if (!req.body.a) { res.status(428).json({ error: "bad" }); return; } await requireVaultPin(userId, 1); await db.update(vaultSecurityTable).set({ vaultPinHash: "x" }).where(eq(vaultSecurityTable.userId, userId)); res.json({}); });';
  const sf = parse("/x/routes/synthetic.ts", src); const a = analyze(sf.statements[1], sf, importsOf(sf));
  t("selftest:ast-detects-db-branch-status-table", a.touches_db && a.operations.db?.includes("db.update") && a.branches.if === 1 && a.response_statuses.includes(428) && a.tables.includes("vaultSecurityTable"));
  const rec = { kind: "route-handler", method: "PUT", route_path: "/vault/security/pin", line_start: 2, name: "PUT /vault/security/pin" };
  const ev = behaviorEvidence(rec, "x/routes/synthetic.ts", sf, sf.statements.filter((s) => !ts.isImportDeclaration(s)));
  t("selftest:behavior-evidence-is-ast-and-route-derived", ev.behaviors.includes("pin") && ev.behaviors.includes("tenant-isolation") && ev.behaviors.includes("step-up") && ev.behavior_evidence.pin.includes("requireVaultPin"));
  t("selftest:missing-behavior-evidence-fails-the-gap-check", behaviorGaps([{ behaviors: ["pin"] }]).length === REQUIRED_BEHAVIORS.length - 1 && behaviorGaps([]).length === REQUIRED_BEHAVIORS.length);
  t("selftest:bypass-detector-rejects-flags", ["--skip-tests", "--force-pass", "--continue-on-error", "--skip"].every((f) => rejectBypassArgs([f]).length > 0));
  t("selftest:state-map-detected", (() => { const s = "const failedAttempts = new Map<number, { count: number }>();"; const sf2 = parse("/x/lib/g.ts", s); return initializerKind(sf2.statements[0].declarationList.declarations[0].initializer, sf2) === "set"; })());
  t("selftest:string-literal-sql-parsed", (() => { const s = 'import { pool } from "@workspace/db";\nasync function f(){ return pool.query("UPDATE vault_security SET user_id=$1 WHERE id=$2", [1,2]); }'; const sf5 = parse("/x/routes/s.ts", s); const r = analyze(sf5.statements[1], sf5, importsOf(sf5)); return r.touches_db && r.operations.raw_sql?.some((q) => q.tables.includes("vault_security")); })());
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
  fs.writeFileSync(manifestPath, `${JSON.stringify({ sub_phase: SUB_PHASE, purpose: "Frozen pre-extraction sources for OLD→NEW differential proof in 06-B/06-D. Write-once: 06-A never overwrites an existing baseline.", sources: manifest, consumer_files: consumerFiles.map((c) => ({ file: c, sha256: sha256(read(c)) })) }, null, 2)}\n`);
  fs.writeFileSync(path.join(BASELINE_DIR, "symbol-inventory.pre-extraction.json"), `${JSON.stringify(inv.records.map((r) => ({ id: r.id, kind: r.kind, fingerprint_sha256: r.fingerprint_sha256, line_start: r.line_start, line_end: r.line_end, classification: r.classification, behaviors: r.behaviors })), null, 2)}\n`);
  return { written: true, sources_identical_to_baseline: true, drift: [] };
}

function verifySealedEvidence(ev) {
  const problems = [];
  if (ev.sub_phase !== SUB_PHASE) problems.push("sub_phase mismatch");
  if (ev.status !== "PASS") problems.push(`recorded status is ${ev.status}`);
  const currentValidatorHash = sha256(fs.readFileSync(SELF, "utf8"));
  if (ev.validator_sha256 !== currentValidatorHash && !SEALED_PASS_VALIDATOR_HASHES.has(ev.validator_sha256)) {
    problems.push("evidence was not produced by a recognized 06-A validator");
  }
  const stored = sha256(JSON.stringify({
    sourceHashes: ev.source_hashes,
    records: ev.records,
    consumers: ev.consumers,
    findings: ev.findings,
    destination: ev.destination_context,
    tableScan: ev.table_consumers,
    endpointScan: ev.endpoint_callers,
    policy: ev.policy_scope_detail,
  }));
  if (stored !== ev.inventory_sha256) problems.push("stored census evidence was edited after generation (hash mismatch)");

  const manifestPath = path.join(BASELINE_DIR, "repo-manifest.json");
  if (!fs.existsSync(manifestPath)) {
    problems.push("write-once 06-A source baseline is missing");
  } else {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    for (const file of ev.scope?.censused_sources ?? []) {
      const row = manifest.sources.find((source) => source.file === file);
      if (!row || ev.source_hashes?.[file] !== row.sha256) {
        problems.push(`census source does not match its frozen baseline: ${file}`);
      } else if (!fs.existsSync(path.join(ROOT, row.baseline_copy)) ||
          sha256(fs.readFileSync(path.join(ROOT, row.baseline_copy), "utf8")) !== row.sha256) {
        problems.push(`frozen source copy is missing or corrupt: ${file}`);
      }
    }
  }
  if (problems.length) fail(`historical evidence rejected: ${problems.join("; ")}`);
}


// ── 11. Summary / main ────────────────────────────────────────────────────
function summarize(inv) {
  const tally = (k) => inv.records.reduce((m, r) => ((m[r[k]] = (m[r[k]] ?? 0) + 1), m), {});
  const routes = inv.records.filter((r) => r.kind === "route-handler");
  const perFile = Object.fromEntries(inv.perFile.map((f) => [f.file, { kind: f.kind, source_group: f.source_group, lines: f.lineCount, records: f.records.length }]));
  return {
    files: inv.perFile.length, named_source_files: inv.perFile.filter((f) => f.source_group === "named-source").length, policy_module_files: inv.perFile.filter((f) => f.source_group !== "named-source").length, total_records: inv.records.length, per_file: perFile,
    by_kind: tally("kind"), by_classification: tally("classification"), by_behavior_domain: tally("behavior_domain"),
    required_behaviors: Object.fromEntries(REQUIRED_BEHAVIORS.map((b) => [b, inv.records.filter((r) => (r.behaviors ?? []).includes(b)).map((r) => r.id)])),
    route_handlers: routes.length, routes_with_business_behavior: routes.filter((r) => r.business_behavior_in_route).length, routes_touching_db: routes.filter((r) => r.touches_db).length,
    routes_delegating_to_vault: routes.filter((r) => (r.delegates_to_vault ?? []).length).length, routes_total_branches: routes.reduce((a, r) => a + r.branch_total, 0),
    external_consumer_files: new Set(inv.consumers.map((c) => c.consumer)).size, external_consumer_edges: inv.consumers.length,
    db_tables: inv.tableScan.tables, table_consumer_files: inv.tableScan.consumers.length, endpoint_caller_files: inv.endpointScan.callers.length,
    policy_scope: { derived_files: inv.policy.files.length, policy_dir_total_files: inv.policy.policy_dir_total_files, out_of_scope_files: inv.policy.out_of_scope_files },
    destination_state: inv.destination.map((d) => ({ file: d.file, holds_business_logic: d.holds_business_logic, exports: d.exports.length })),
    findings_high: inv.findings.filter((f) => f.severity === "HIGH").length, findings_low: inv.findings.filter((f) => f.severity === "LOW").length, findings_info: inv.findings.filter((f) => f.severity === "INFO").length,
  };
}
const hashBody = (inv) => JSON.stringify({ sourceHashes: inv.sourceHashes, records: inv.records, consumers: inv.consumers, findings: inv.findings, destination: inv.destination, tableScan: inv.tableScan, endpointScan: inv.endpointScan, policy: inv.policy });

function main() {
  const verify = process.argv.includes("--verify"); const started = Date.now();
  if (fs.existsSync(EVIDENCE_FILE)) {
    const ev = JSON.parse(fs.readFileSync(EVIDENCE_FILE, "utf8"));
    if (ev.status === "PASS") {
      verifySealedEvidence(ev);
      console.log(`${SUB_PHASE} already PASS — sealed census retained; later extraction source changes are not re-censused`);
      return;
    }
  }
  if (verify) {
    if (!fs.existsSync(EVIDENCE_FILE)) fail("evidence missing: run the validator without --verify first");
    const ev = JSON.parse(fs.readFileSync(EVIDENCE_FILE, "utf8"));
    verifySealedEvidence(ev);
    console.log(`${SUB_PHASE} historical PASS evidence verified without rescanning changed sources`);
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
    commands: ["node scripts/antas/vault/gap/validate-vlt-gap-06-A.mjs"],
    exit_codes: { validator: failed.length ? 1 : 0, typescript_parse: inv.perFile.every((f) => (f.sf.parseDiagnostics ?? []).length === 0) ? 0 : 1 },
    symbols_moved: [], consumers_migrated: [],
    old_business_symbols_remaining: inv.records.filter((r) => r.kind !== "router-instance" && r.kind !== "export-assignment").map((r) => r.id),
    duplicate_implementations: [],
    scope: { named_sources: FIXED_SOURCES, policy_modules_derived: POLICY_SOURCES, censused_sources: SOURCES, policy_module_derivation: "lib/policy files imported by the named sources, plus files reachable via `export ... from` re-exports (derived by AST; never hand-listed). The rest of lib/policy is recorded as out-of-scope platform context.", destination_context: DESTINATION_CONTEXT },
    baseline: { dir: rel(BASELINE_DIR), ...baseline },
    summary: summarize(inv), checks, inventory_sha256: sha256(hashBody(inv)),
    notes: [
      "06-A is a census only: no code was moved; symbols_moved/consumers_migrated are intentionally empty. duplicate_implementations is computed in 06-B/06-D.",
      "Behavior attribution is by AST evidence only (identifiers, member calls, string literals, route shape, object-literal methods/properties); each attributed behavior lists the exact evidence tokens. A symbol may evidence several behaviors.",
      "Tenant isolation in these sources is per-user row scoping (getRequestUserId + eq(table.userId, ...)); no workspace/organization tenant identifiers appear in the three named sources. The census records exactly that evidence and invents nothing.",
      "Audit evidence in the named sources is limited to the policy decision observer wired into vaultReauthOwnershipEngine; see the security-mutations-without-audit-record finding for mutation handlers with no audit operation.",
      "lib/policy is a platform-wide authorization engine consumed by many non-vault routes; the consumer scan records every importer so 06-B/06-C can decide what is Vault-owned versus shared.",
      "Build/typecheck and behavioral differential tests are required from 06-B onward; a write-once pre-extraction baseline is written to baseline/.",
    ],
    status: failed.length === 0 ? "PASS" : "FAIL",
    findings: inv.findings,
    destination_context: inv.destination, table_consumers: inv.tableScan, endpoint_callers: inv.endpointScan, related_vault_files: inv.relatedVault, policy_scope_detail: inv.policy,
    files: inv.perFile.map((f) => ({ file: f.file, kind: f.kind, source_group: f.source_group, sha256: inv.sourceHashes[f.file], lines: f.lineCount, top_level_statements: f.stmtCount, records: f.records.length, imports: f.imports })),
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
