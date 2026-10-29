#!/usr/bin/env node
// VLT-GAP-03-C — Consumer Rewire (KYC). Fail-closed validator.
// Evidence: reports/antas/vault/gap/VLT-GAP-03/consumer-graph.json
//
// Proves, from source and by execution, that every cross-module consumer of KYC that used to bypass the Vault owner
// (routes/exchange-api.ts: exchange-credential read + write; routes/projects.ts: enroll-by-KYC-entity lookup, owner
// re-fetch, private decrypted-field copy, account_data mapping; the compat re-export in routes/kyc.ts; the ownership
// regression suite) now goes through vault/{application,infrastructure,security}; that the moved SQL is verbatim; that
// behavior is unchanged (sealed 03-B tree vs a differential suite); that every remaining KYC table access outside the
// owner is an explicit, owned deferral; and that nothing unrelated changed.
//
// This validator NEVER writes a baseline. It only VERIFIES the write-once seal produced by
// freeze-vlt-gap-03-C-baseline.mjs.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ROOT, sha256, sha256File, rel, rejectBypass, binding, walkFiles } from "./gap-common.mjs";
import { loadTs, createEnv, createLoader, fakeRes, summ, sliceSymbols } from "./harness.mjs";

const VALIDATOR_VERSION = "1.0.0";
const PHASE = "VLT-GAP-03";
const SUB_PHASE = "VLT-GAP-03-C";
const HERE = fileURLToPath(import.meta.url);
const GAP_DIR = "scripts/antas/vault/gap/";
const SRC = path.join(ROOT, "artifacts/api-server/src");
const ROUTES = path.join(SRC, "routes");
const EVIDENCE_DIR = path.join(ROOT, "reports/antas/vault/gap/VLT-GAP-03");
const EVIDENCE_FILE = path.join(EVIDENCE_DIR, "consumer-graph.json");
const BASE = path.join(EVIDENCE_DIR, "baseline-03c");
const SEAL_FILE = path.join(BASE, "SEAL.json");
const MANIFEST_FILE = path.join(BASE, "tree-manifest.json");
const FROZEN_DIR = path.join(BASE, "consumers");
const R = (f) => `artifacts/api-server/src/${f}`;
const canon = (r) => JSON.stringify(r) ?? "undefined";

const fail = (m) => { console.error(`${SUB_PHASE} FAIL — ${m}`); process.exit(1); };
const bypass = rejectBypass();
if (bypass.length) fail(`bypass mechanism rejected: ${bypass.join(", ")}`);
if (process.env.VALIDATION_DISABLED && !/^(0|false|no)$/i.test(process.env.VALIDATION_DISABLED)) fail("bypass mechanism rejected: env VALIDATION_DISABLED");
const ts = loadTs(ROOT);
if (!ts) fail("TypeScript compiler API unavailable (fail closed)");
const parse = (name, text) => ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

// ── 0. The write-once seal must exist and be internally consistent (this validator never creates it) ──
if (!fs.existsSync(SEAL_FILE)) fail("baseline-03c/SEAL.json missing — run freeze-vlt-gap-03-C-baseline.mjs ONCE, before any 03-C change");
if (!fs.existsSync(MANIFEST_FILE)) fail("baseline-03c/tree-manifest.json missing");
const SEAL = JSON.parse(fs.readFileSync(SEAL_FILE, "utf8"));
const frozenText = (name) => fs.readFileSync(path.join(FROZEN_DIR, name), "utf8");

// ── 1. Declared 03-C surface (intent). Every entry is VERIFIED against source below. ──
const OWNER = {
  exchange: "vault/application/kyc/exchange.ts",
  enrollment: "vault/application/kyc/enrollment.ts",
  repo: "vault/infrastructure/repositories/kyc-consumer-repository.ts",
  security: "vault/security/kyc-ownership.ts",
  entries: "vault/application/kyc/entries.ts",
};
const NEW_FILES = [OWNER.exchange, OWNER.enrollment, OWNER.repo];
const KYC_REPOS = [OWNER.repo, "vault/infrastructure/repositories/kyc-repository.ts", "vault/infrastructure/repositories/kyc-data-entity-repository.ts"];
const CONSUMERS = [
  { file: "routes/exchange-api.ts", frozen: "exchange-api.ts", uses: [["vault/security/kyc-ownership", ["requireKycEntryOwnership", "kycEntryResource"]], ["vault/application/kyc/exchange", ["loadKycExchangeCredentials", "setKycEntryExchangeKeys"]]] },
  { file: "routes/projects.ts", frozen: "projects.ts", uses: [["vault/security/kyc-ownership", ["kycEntryOwnerResource"]], ["vault/application/kyc/enrollment", ["loadKycEntryForEnrollment", "buildEnrollmentAccountData"]]] },
  { file: "routes/kyc.ts", frozen: "kyc.route.ts", uses: [["vault/security/kyc-ownership", ["requireKycEntryOwnership"]], ["vault/application/kyc/entries", ["listKycEntries", "createKycEntry", "getKycEntry", "editKycEntry", "setKycEntryStatus", "removeKycEntry", "listKycEnrollments"]]] },
  { file: "routes/kyc-data-entities.ts", frozen: "kyc-data-entities.route.ts", uses: [["vault/security/kyc-ownership", ["requireKycDataEntityOwnership"]], ["vault/application/kyc/data-entities", ["listKycDataEntities", "createKycDataEntity", "removeKycDataEntity"]]] },
];
const CONSUMER_BY_FILE = Object.fromEntries(CONSUMERS.map((c) => [c.file, c]));
const OWNER_SYMBOLS = [
  ["loadKycExchangeCredentials", OWNER.exchange], ["setKycEntryExchangeKeys", OWNER.exchange],
  ["loadKycEntryForEnrollment", OWNER.enrollment], ["buildEnrollmentAccountData", OWNER.enrollment],
  ["kycEntryOwnerResource", OWNER.security], ["kycEntryResource", OWNER.security], ["requireKycEntryOwnership", OWNER.security],
];
const REPO_SYMBOLS = ["selectKycEntryExchangeCredentials", "updateKycEntryExchangeKeys", "selectKycEntryForEnrollment"];
// Files 03-C may change relative to the sealed 03-B tree (the same eight the freeze sealed). Anything else is an unrelated change.
const FROZEN_SOURCES = Object.values(SEAL.frozen_consumers ?? {}).map((v) => v.source);
const CHANGED_ALLOWED = new Set(FROZEN_SOURCES);
const ADDED_ALLOWED = new Set(NEW_FILES.map(R));
const isAllowedAdd = (k) => ADDED_ALLOWED.has(k) || k === `${GAP_DIR}validate-vlt-gap-03-C.mjs` || k === `${GAP_DIR}freeze-vlt-gap-03-C-baseline.mjs`;

// Table-access census. Every file that touches kyc_entries / kyc_data_entities must be a KYC owner, or an EXPLICIT
// deferral to the later gap that owns that behavior. A new/unlisted access FAILS; a stale deferral FAILS.
const OWNER_TABLE_FILES = new Set([...KYC_REPOS.map(R), R(OWNER.security)]);
const DEFERRALS = {
  [R("routes/marketplace-vault.ts")]: { gap: "VLT-GAP-04", reason: "ownership transfer / copy of KYC entries on marketplace sale (marketplace boundary)" },
  [R("lib/vault-health-scan.ts")]: { gap: "VLT-GAP-11", reason: "health scan reads all KYC entries / data entities and writes flag columns" },
  [R("lib/vault-snapshot-restore.ts")]: { gap: "VLT-GAP-09", reason: "snapshot restore writes KYC entries / data entities back" },
  [R("lib/vault-snapshot-extra.ts")]: { gap: "VLT-GAP-09", reason: "snapshot export reads KYC data entities" },
  [R("routes/vault-snapshot.ts")]: { gap: "VLT-GAP-09", reason: "snapshot export reads KYC entries" },
  "scripts/src/reencrypt-vault.ts": { gap: "VLT-GAP-07", reason: "re-encryption script rewrites ciphertext columns" },
  [R("routes/search.ts")]: { gap: "VLT-GAP-12", reason: "remaining read: global search over KYC entries" },
  [R("routes/vault-shares.ts")]: { gap: "VLT-GAP-10", reason: "remaining read: share table registry (share lifecycle belongs to GAP-10)" },
  [R("lib/mail-sync.ts")]: { gap: "VLT-GAP-12", reason: "remaining read: mail-sync table registry" },
  [R("lib/schema-migrations.ts")]: { gap: "VLT-GAP-12", reason: "schema migrations (DDL)" },
};

// ── 2. AST helpers ──
const importsOfFile = (sf) => sf.statements.filter((s) => ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier)).map((s) => ({
  spec: s.moduleSpecifier.text,
  names: s.importClause?.namedBindings && ts.isNamedImports(s.importClause.namedBindings) ? s.importClause.namedBindings.elements.map((e) => ({ imported: (e.propertyName ?? e.name).text, local: e.name.text })) : [],
}));
const resolveTo = (fromAbs, spec) => (spec.startsWith(".") ? rel(path.resolve(path.dirname(fromAbs), spec)).replace(/\.(ts|js)$/, "") : null);
const norm = (s) => s.replace(/\s+/g, " ").trim();
const SQLISH = /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/i;
function sqlLiterals(sf) {
  const out = new Set();
  (function w(n) {
    let text = null;
    if (ts.isNoSubstitutionTemplateLiteral(n)) text = n.text;
    else if (ts.isTemplateExpression(n)) text = n.head.text + n.templateSpans.map((s) => "${}" + s.literal.text).join("");
    if (text !== null) { const t = norm(text); if (SQLISH.test(t)) out.add(t); }
    ts.forEachChild(n, w);
  })(sf);
  return out;
}
const KYC_TBL = "(kyc_entries|kyc_data_entities)";
// String/template literals that mention a KYC table in SQL position, plus bare "kyc_entries"/"kyc_data_entities" name literals.
function kycTableAccess(sf) {
  const sqlAccess = [], nameLiterals = [];
  (function w(n) {
    let text = null;
    if (ts.isNoSubstitutionTemplateLiteral(n) || ts.isStringLiteral(n)) text = n.text;
    else if (ts.isTemplateExpression(n)) text = n.head.text + n.templateSpans.map((s) => "${}" + s.literal.text).join("");
    if (text !== null && new RegExp(KYC_TBL).test(text)) {
      const t = norm(text);
      if (new RegExp(`\\b(FROM|JOIN|INTO|UPDATE|(CREATE|ALTER|DROP)\\s+TABLE(\\s+IF\\s+(NOT\\s+)?EXISTS)?|TRUNCATE)\\s+${KYC_TBL}\\b`, "i").test(t)) sqlAccess.push(t.slice(0, 90));
      else if (t === "kyc_entries" || t === "kyc_data_entities") nameLiterals.push({ line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, parent: n.parent && ts.isCallExpression(n.parent) ? n.parent.expression.getText(sf) : n.parent?.getText(sf).slice(0, 40) });
    }
    if (ts.isIdentifier(n) && (n.text === "kycEntriesTable" || n.text === "kycDataEntitiesTable")) sqlAccess.push(n.text);
    ts.forEachChild(n, w);
  })(sf);
  return { sqlAccess, nameLiterals };
}
function handlerShape(text, name = "route.ts") {
  const sf = parse(name, text); const out = [];
  for (const s of sf.statements) {
    if (!(ts.isExpressionStatement(s) && ts.isCallExpression(s.expression))) continue;
    const c = s.expression.expression;
    if (!(ts.isPropertyAccessExpression(c) && c.expression.getText(sf) === "router" && ["get", "post", "put", "patch", "delete"].includes(c.name.text))) continue;
    const args = s.expression.arguments; const handler = args[args.length - 1];
    let db = 0, control = 0; const calls = new Set();
    (function w(n) {
      if (ts.isIdentifier(n) && (n.text === "db" || n.text === "sql")) db++;
      if (ts.isIfStatement(n) || ts.isConditionalExpression(n) || ts.isTryStatement(n) || ts.isForStatement(n) || ts.isSwitchStatement(n)) control++;
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) calls.add(n.expression.text);
      ts.forEachChild(n, w);
    })(handler);
    out.push({ method: c.name.text.toUpperCase(), path: args[0].text, middleware: [...args].slice(1, -1).map((a) => norm(a.getText(sf))), db_refs: db, control_flow_nodes: control, called: [...calls].sort() });
  }
  return out;
}
const countIdent = (sf, name) => { let n = 0; (function w(x) { if (ts.isIdentifier(x) && x.text === name) n++; ts.forEachChild(x, w); })(sf); return n; };
const declaresName = (sf, name) => sf.statements.some((s) => (ts.isFunctionDeclaration(s) && s.name?.text === name) || (ts.isVariableStatement(s) && s.declarationList.declarations.some((d) => d.name.getText(sf) === name)));
const exportedNames = (sf) => { const o = new Set(); for (const s of sf.statements) { const ex = s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword); if (ex && ts.isFunctionDeclaration(s) && s.name) o.add(s.name.text); if (ex && ts.isVariableStatement(s)) s.declarationList.declarations.forEach((d) => o.add(d.name.getText(sf))); } return o; };
const declText = (sf, name) => { for (const s of sf.statements) { if (ts.isFunctionDeclaration(s) && s.name?.text === name) return norm(s.getText(sf).replace(/^export\s+/, "")); if (ts.isVariableStatement(s)) { const d = s.declarationList.declarations.find((x) => x.name.getText(sf) === name); if (d) return norm(d.initializer?.getText(sf) ?? ""); } } return null; };
const stringArrayOf = (sf, name) => { for (const s of sf.statements) if (ts.isVariableStatement(s)) { const d = s.declarationList.declarations.find((x) => x.name.getText(sf) === name); if (d) { let init = d.initializer; while (init && (ts.isAsExpression(init) || ts.isParenthesizedExpression(init))) init = init.expression; if (init && ts.isArrayLiteralExpression(init)) return init.elements.map((e) => e.text); } } return null; };
const collapse = (s) => s.replace(/\$\{[^}]*\}/g, "${}");
const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

// ── 3. Static proof: seal, consumer graph, table-access census, duplicates ──
function staticProof() {
  const checks = []; const chk = (name, passed, details = "") => checks.push({ name, passed: Boolean(passed), details });
  const read = (f) => fs.readFileSync(path.join(SRC, f), "utf8");

  // 3.0 seal integrity + anchoring to what 03-B certified
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf8"));
  chk("seal:tree-manifest-hash-matches-seal", sha256(fs.readFileSync(MANIFEST_FILE, "utf8")) === SEAL.tree_manifest_sha256, "");
  chk("seal:matches-03B-certified-state", SEAL.matches_03B_certified_state === true && SEAL.certified_by?.sub_phase === "VLT-GAP-03-B" && Boolean(SEAL.certified_by?.source_tree_sha256), "");
  const frozenBad = Object.entries(SEAL.frozen_consumers ?? {}).filter(([n, v]) => !fs.existsSync(path.join(FROZEN_DIR, n)) || sha256File(path.join(FROZEN_DIR, n)) !== v.sha256 || manifest.files[v.source] !== v.sha256);
  chk("seal:frozen-consumers-intact-and-equal-to-manifest", frozenBad.length === 0 && Object.keys(SEAL.frozen_consumers ?? {}).length >= 8, frozenBad.map(([n]) => n).join(", "));
  const ev03b = JSON.parse(fs.readFileSync(path.join(EVIDENCE_DIR, "extraction-proof.json"), "utf8"));
  const certDrift = Object.entries(ev03b.source_hashes ?? {}).filter(([f, h]) => (f.startsWith(GAP_DIR) ? SEAL.gap_scripts_at_freeze?.[f] : manifest.files[f]) !== h).map(([f]) => f);
  chk("seal:03B-certified-hashes-equal-sealed-tree", ev03b.status === "PASS" && ev03b.sub_phase === "VLT-GAP-03-B" && certDrift.length === 0, certDrift.join(", "));
  const gapTamper = Object.entries(SEAL.gap_scripts_at_freeze ?? {}).filter(([f, h]) => !fs.existsSync(path.join(ROOT, f)) || sha256File(path.join(ROOT, f)) !== h).map(([f]) => f);
  chk("seal:earlier-validators-and-harness-unmodified (no weakened gate)", gapTamper.length === 0 && Object.keys(SEAL.gap_scripts_at_freeze ?? {}).length >= 15, gapTamper.join(", "));
  const frozenExchange = parse("fx", frozenText("exchange-api.ts")), frozenProjects = parse("fp", frozenText("projects.ts"));
  chk("seal:frozen-baseline-shows-the-bypass (frozen exchange-api/projects still touch kyc_entries)", kycTableAccess(frozenExchange).sqlAccess.length >= 2 && kycTableAccess(frozenProjects).sqlAccess.length >= 2, `${kycTableAccess(frozenExchange).sqlAccess.length}/${kycTableAccess(frozenProjects).sqlAccess.length}`);

  // 3.1 destination + owner symbols exist, parse, and are executable business code (not scaffolds)
  const dest = {};
  for (const f of [...NEW_FILES, OWNER.security, OWNER.entries]) {
    const abs = path.join(SRC, f);
    if (!fs.existsSync(abs)) { chk(`destination-exists:${f}`, false, "missing"); continue; }
    const text = fs.readFileSync(abs, "utf8"); const sf = parse(f, text); dest[f] = { text, sf, abs };
    chk(`destination-exists:${f}`, true); chk(`destination-parses:${f}`, (sf.parseDiagnostics ?? []).length === 0);
  }
  if (Object.keys(dest).length !== NEW_FILES.length + 2) return { checks, consumers: [], census: [], duplicates: [], usage: [], repoSql: [], importers: [] };
  for (const [name, file] of OWNER_SYMBOLS) chk(`owner-exports-symbol:${name}`, exportedNames(dest[file].sf).has(name), file);
  for (const name of REPO_SYMBOLS) chk(`repository-exports-symbol:${name}`, exportedNames(dest[OWNER.repo].sf).has(name), "");
  chk("repository-has-executable-sql", [...sqlLiterals(dest[OWNER.repo].sf)].length >= 3 && countIdent(dest[OWNER.repo].sf, "db") >= 3, "");
  chk("application-files-embed-no-sql-or-db (owner application modules go through the repository)", [OWNER.exchange, OWNER.enrollment].every((f) => !/\bsql\b|@workspace\/db|\bdb\./.test(stripComments(dest[f].text))), "");
  chk("application-exchange-owns-encryption-and-decryption", /encryptField\(/.test(dest[OWNER.exchange].text) && /decryptField\(/.test(dest[OWNER.exchange].text), "");
  chk("application-enrollment-decrypts-with-domain-field-list", /decryptRow\(kycRow, KYC_SENSITIVE_FIELDS\)/.test(dest[OWNER.enrollment].text) && /from "\.\.\/\.\.\/domain\/kyc"/.test(dest[OWNER.enrollment].text), "");
  chk("03B-owner-passthrough-KYC_OWNERSHIP_RESOURCES-removed (dead re-export)", !declaresName(dest[OWNER.entries].sf, "KYC_OWNERSHIP_RESOURCES") && !/KYC_OWNERSHIP_RESOURCES/.test(dest[OWNER.entries].text), "");

  // 3.2 moved SQL is VERBATIM: every SQL literal in the consumer repository existed (collapsed) in the frozen consumers
  const frozenSql = new Set(); for (const s of [...sqlLiterals(frozenExchange), ...sqlLiterals(frozenProjects)]) frozenSql.add(collapse(s));
  const repoSql = [...sqlLiterals(dest[OWNER.repo].sf)].map((s) => ({ sql: s, verbatim_in_frozen: frozenSql.has(collapse(s)) }));
  chk("moved-sql-is-verbatim-from-frozen-consumers", repoSql.length >= 3 && repoSql.every((r) => r.verbatim_in_frozen), repoSql.filter((r) => !r.verbatim_in_frozen).map((r) => r.sql.slice(0, 80)).join(" | "));
  chk("moved-escaper-`safe`-is-verbatim", declText(parse("r", dest[OWNER.repo].text), "safe") !== null && declText(parse("r", dest[OWNER.repo].text), "safe") === declText(frozenExchange, "safe"), "");
  // the owner-lookup SQL in the security module is the frozen projects/kyc-ownership statement, once
  const secSql = [...sqlLiterals(dest[OWNER.security].sf)].map(collapse);
  const frozenOwnerSql = new Set([...sqlLiterals(parse("fk", frozenText("kyc-ownership.ts")))].map(collapse));
  chk("security-owner-sql-unchanged-vs-frozen-and-not-duplicated", secSql.every((s) => frozenOwnerSql.has(s)) && new Set(secSql).size === secSql.length && frozenSql.has("SELECT user_id FROM kyc_entries WHERE id = ${} LIMIT 1"), secSql.join(" | "));
  const sentinelFrozen = /const PROJECTS_OWNER_SENTINEL_NONE = (-?\d+);/.exec(frozenText("projects.ts"))?.[1];
  const sentinelDomain = /KYC_ENTRY_OWNER_SENTINEL_NONE = (-?\d+);/.exec(read("vault/domain/kyc.ts"))?.[1];
  chk("owner-sentinel-equivalence (projects' private sentinel === KYC domain sentinel)", sentinelFrozen !== undefined && sentinelFrozen === sentinelDomain, `${sentinelFrozen} vs ${sentinelDomain}`);
  const frozenFields = stringArrayOf(frozenProjects, "KYC_ENTRY_SENSITIVE_FIELDS"), domainFields = stringArrayOf(parse("d", read("vault/domain/kyc.ts")), "KYC_SENSITIVE_FIELDS");
  chk("decrypted-field-list-equivalence (projects' private copy === KYC domain list, same order)", Boolean(frozenFields) && Boolean(domainFields) && JSON.stringify(frozenFields) === JSON.stringify(domainFields), `${frozenFields?.length} vs ${domainFields?.length}`);

  // 3.3 every consumer is rewired, thin, and no longer touches the KYC tables
  const consumers = [];
  for (const c of CONSUMERS) {
    const text = read(c.file); const sf = parse(c.file, text); const abs = path.join(SRC, c.file);
    const imps = importsOfFile(sf).map((i) => ({ ...i, resolved: resolveTo(abs, i.spec) }));
    const okName = (mod, n) => imps.some((i) => i.resolved === R(mod) && i.names.some((x) => x.imported === n)) && countIdent(sf, n) >= 2;
    const usesOk = c.uses.every(([mod, names]) => names.every((n) => okName(mod, n)));
    chk(`consumer-imports-and-uses-owner:${c.file}`, usesOk, c.uses.flatMap(([mod, names]) => names.filter((n) => !okName(mod, n)).map((n) => `${n}←${mod}`)).join(", "));
    const acc = kycTableAccess(sf);
    chk(`consumer-has-no-kyc-table-sql:${c.file}`, acc.sqlAccess.length === 0, acc.sqlAccess.join(" | "));
    chk(`consumer-has-no-kyc-table-name-literal:${c.file}`, acc.nameLiterals.length === 0, JSON.stringify(acc.nameLiterals));
    const before = handlerShape(frozenText(c.frozen), c.frozen); const after = handlerShape(text, c.file);
    const same = JSON.stringify(before.map((h) => [h.method, h.path, h.middleware])) === JSON.stringify(after.map((h) => [h.method, h.path, h.middleware]));
    chk(`consumer-route-table-unchanged:${c.file}`, same && after.length > 0, "method/path/middleware chain changed");
    consumers.push({ file: c.file, imports_owner: usesOk, kyc_table_sql_before: kycTableAccess(parse(c.frozen, frozenText(c.frozen))).sqlAccess.length, kyc_table_sql_after: acc.sqlAccess.length, route_table_unchanged: same, routes: after.length });
  }
  const exSf = parse("exchange-api.ts", read("routes/exchange-api.ts")); const exH = handlerShape(read("routes/exchange-api.ts"), "exchange-api.ts");
  const patch = exH.filter((h) => h.method === "PATCH" && h.path === "/kyc-entries/:id/exchange-keys"), bal = exH.filter((h) => h.method === "GET" && h.path === "/exchange-balance/:id");
  chk("exchange-api:PATCH-exchange-keys-is-thin-adapter", patch.length === 1 && patch[0].db_refs === 0 && patch[0].control_flow_nodes <= 1 && patch[0].called.includes("setKycEntryExchangeKeys"), JSON.stringify(patch.map((h) => [h.db_refs, h.control_flow_nodes, h.called])));
  chk("exchange-api:GET-exchange-balance-has-no-db-and-uses-owner-loader", bal.length === 1 && bal[0].db_refs === 0 && bal[0].called.includes("loadKycExchangeCredentials"), JSON.stringify(bal.map((h) => [h.db_refs, h.called])));
  chk("exchange-api:no-db-drizzle-or-crypto-imports-left", !importsOfFile(exSf).some((i) => i.spec === "@workspace/db" || i.spec === "drizzle-orm" || /vault-crypto/.test(i.spec)) && !declaresName(exSf, "safe"), "");
  chk("exchange-api:provider-proxy-still-here-and-recorded-as-deferral (GAP-12)", /api\.binance\.com/.test(read("routes/exchange-api.ts")) && importsOfFile(exSf).some((i) => i.spec === "axios"), "");
  const prSf = parse("projects.ts", read("routes/projects.ts"));
  chk("projects:kyc-private-copies-removed (owner resource, field list, account_data mapper)", ["kycEntryOwnerResource", "KYC_ENTRY_SENSITIVE_FIELDS", "accountDataFromKycEntry"].every((n) => !declaresName(prSf, n)) && countIdent(prSf, "KYC_ENTRY_SENSITIVE_FIELDS") === 0 && countIdent(prSf, "accountDataFromKycEntry") === 0, "");
  chk("projects:no-vault-crypto-decryptRow-import-left", !importsOfFile(prSf).some((i) => /vault-crypto/.test(i.spec)), "");
  chk("projects:enroll-calls-owner-in-original-order (load → audit owner → mapping)", (() => { const t = read("routes/projects.ts"); const a = t.indexOf("loadKycEntryForEnrollment(userId, kycEntryId)"), b = t.indexOf("kycEntryOwnerResource(kycEntryId)"), c2 = t.indexOf("buildEnrollmentAccountData(kycRow)"); return a > 0 && b > a && c2 > b; })(), "");
  const kSf = parse("kyc.ts", read("routes/kyc.ts"));
  chk("kyc-route:compat-reexport-removed", !kSf.statements.some((s) => ts.isExportDeclaration(s)) && !/export\s*\{[^}]*(kycEntryResource|requireKycEntryOwnership)/.test(read("routes/kyc.ts")), "");
  const kh = handlerShape(read("routes/kyc.ts"), "kyc.ts").concat(handlerShape(read("routes/kyc-data-entities.ts"), "kyc-data-entities.ts"));
  chk("kyc-routes:still-thin-adapters (03-B state preserved)", kh.length >= 13 && kh.every((h) => h.db_refs === 0 && h.control_flow_nodes <= 1), JSON.stringify(kh.filter((h) => h.db_refs || h.control_flow_nodes > 1).map((h) => [h.method, h.path])));

  // 3.4 nothing imports the KYC route modules for symbols; nothing imports a KYC repository except the KYC application layer
  const importers = [];
  const allTs = [...walkFiles(SRC, [], (p) => /\.(ts|tsx|mjs)$/.test(p)), ...walkFiles(path.join(ROOT, "scripts/src"), [], (p) => /\.ts$/.test(p))];
  const allParsed = allTs.map((f) => ({ f, k: rel(f), sf: parse(f, fs.readFileSync(f, "utf8")) }));
  for (const { f, k, sf } of allParsed) for (const i of importsOfFile(sf)) {
    const r = resolveTo(f, i.spec);
    if ((r === R("routes/kyc") || r === R("routes/kyc-data-entities")) && i.names.length) importers.push({ file: k, from: r, names: i.names.map((n) => n.imported) });
  }
  chk("no-file-imports-symbols-from-routes/kyc-or-routes/kyc-data-entities", importers.length === 0, JSON.stringify(importers));
  const regSf = parse("t", fs.readFileSync(path.join(ROOT, "scripts/src/test-route-ownership-regression.ts"), "utf8"));
  const regImp = importsOfFile(regSf).find((i) => i.names.some((n) => n.imported === "requireKycEntryOwnership"));
  chk("ownership-regression-suite-imports-owner-not-route", regImp && resolveTo(path.join(ROOT, "scripts/src/test-route-ownership-regression.ts"), regImp.spec) === R("vault/security/kyc-ownership"), regImp?.spec ?? "import missing");
  chk("ownership-regression-suite-kyc-specs-preserved (5 kycEntrySpec cases)", (fs.readFileSync(path.join(ROOT, "scripts/src/test-route-ownership-regression.ts"), "utf8").match(/kycEntrySpec\("/g) ?? []).length === (frozenText("test-route-ownership-regression.ts").match(/kycEntrySpec\("/g) ?? []).length && (frozenText("test-route-ownership-regression.ts").match(/kycEntrySpec\("/g) ?? []).length === 5, "");
  const repoImporters = [];
  for (const { f, k, sf } of allParsed) for (const i of importsOfFile(sf)) { const r = resolveTo(f, i.spec); if (r && KYC_REPOS.some((p) => R(p.replace(/\.ts$/, "")) === r)) repoImporters.push({ file: k, repo: r.replace(/^artifacts\/api-server\/src\//, "") }); }
  const illegalRepoImporters = repoImporters.filter((x) => !x.file.startsWith("artifacts/api-server/src/vault/application/kyc/"));
  chk("kyc-repositories-imported-only-by-the-kyc-application-layer (no route/lib bypass)", illegalRepoImporters.length === 0, JSON.stringify(illegalRepoImporters));
  chk("consumer-repository-imported-only-by-exchange-and-enrollment", repoImporters.filter((x) => x.repo.endsWith("kyc-consumer-repository")).map((x) => x.file.split("/").pop()).sort().join(",") === "enrollment.ts,exchange.ts", JSON.stringify(repoImporters.filter((x) => x.repo.endsWith("kyc-consumer-repository"))));

  // 3.5 consumer graph: who imports each owner symbol (each symbol must be used by a route/adapter or the regression suite)
  const usage = OWNER_SYMBOLS.map(([name, file]) => {
    const users = [];
    for (const { f, k, sf } of allParsed) for (const i of importsOfFile(sf)) if (resolveTo(f, i.spec) === R(file.replace(/\.ts$/, "")) && i.names.some((n) => n.imported === name)) users.push(k.replace(/^artifacts\/api-server\/src\//, ""));
    return { symbol: name, owner: file, consumers: users };
  });
  for (const u of usage) chk(`symbol-is-used:${u.symbol}`, u.consumers.some((c) => c.startsWith("routes/") || c.startsWith("vault/") || c.startsWith("scripts/")), JSON.stringify(u.consumers));

  // 3.6 duplicate scan: no moved SQL statement / private field-list copy is implemented outside its owner
  const ownerSqlFiles = new Set([R(OWNER.repo), R(OWNER.security)]);
  const collapsedRepo = new Set(repoSql.map((r) => collapse(r.sql)));
  const duplicates = [];
  for (const { k, sf } of allParsed) { if (ownerSqlFiles.has(k) || k.endsWith(".mjs")) continue; for (const s of sqlLiterals(sf)) if (collapsedRepo.has(collapse(s)) || collapse(s) === "SELECT user_id FROM kyc_entries WHERE id = ${} LIMIT 1") duplicates.push({ file: k, sql: s.slice(0, 100) }); }
  chk("duplicate-scan:no-moved-sql-outside-owner", duplicates.length === 0, JSON.stringify(duplicates));
  // A second copy of the KYC decrypted-field list = an array literal containing EVERY field of the domain list (nid_number included).
  // Other registries (vault_entries secret-fields, re-encryption column sets) are different owners' lists and do not contain all of them.
  const kycListHits = (sf) => { const hits = []; (function w(n) { if (ts.isArrayLiteralExpression(n) && n.elements.every((e) => ts.isStringLiteral(e)) && domainFields.every((f) => n.elements.some((e) => e.text === f))) hits.push(n.getStart(sf)); ts.forEachChild(n, w); })(sf); return hits; };
  chk("duplicate-scan:detector-catches-the-frozen-private-copy (self-test)", kycListHits(frozenProjects).length === 1, `${kycListHits(frozenProjects).length} hit(s) in the sealed projects.ts`);
  const dupFieldLists = [];
  for (const { k, sf } of allParsed) { if (k === R("vault/domain/kyc.ts") || !k.endsWith(".ts")) continue; if (kycListHits(sf).length) dupFieldLists.push(k); }
  chk("duplicate-scan:no-second-copy-of-KYC-sensitive-field-list", dupFieldLists.length === 0, dupFieldLists.join(", "));
  const dupSafe = allParsed.filter(({ k, sf }) => k.startsWith("artifacts/api-server/src/routes/") && declaresName(sf, "safe") && /KYC|kyc/.test(fs.readFileSync(path.join(ROOT, k), "utf8")) && /exchange_api/.test(fs.readFileSync(path.join(ROOT, k), "utf8"))).map((x) => x.k);
  chk("duplicate-scan:no-route-keeps-an-exchange-key-SQL-escaper", dupSafe.length === 0, dupSafe.join(", "));

  // 3.7 table-access census with explicit deferrals
  const census = [];
  for (const { k, sf } of allParsed) {
    if (k.endsWith(".mjs")) continue;
    const acc = kycTableAccess(sf);
    if (!acc.sqlAccess.length && !acc.nameLiterals.length) continue;
    let classification;
    if (OWNER_TABLE_FILES.has(k)) classification = { kind: "owner" };
    else if (DEFERRALS[k]) classification = { kind: "deferred", ...DEFERRALS[k] };
    else classification = { kind: "UNCLASSIFIED" };
    census.push({ file: k, sql_access: acc.sqlAccess.length, name_literals: acc.nameLiterals.length, ...classification });
  }
  const unclassified = census.filter((c) => c.kind === "UNCLASSIFIED");
  chk("census:no-unclassified-kyc-table-access", unclassified.length === 0, unclassified.map((c) => c.file).join(", "));
  const stale = Object.keys(DEFERRALS).filter((k) => !census.some((c) => c.file === k));
  chk("census:no-stale-deferral (every deferral still accesses a KYC table)", stale.length === 0, stale.join(", "));
  const rewiredStillAccessing = ["routes/exchange-api.ts", "routes/projects.ts", "routes/kyc.ts", "routes/kyc-data-entities.ts"].filter((f) => census.some((c) => c.file === R(f)));
  chk("census:rewired-consumers-absent-from-census", rewiredStillAccessing.length === 0, rewiredStillAccessing.join(", "));
  chk("census:every-deferral-names-a-later-gap", [...new Set(Object.values(DEFERRALS).map((d) => d.gap))].every((g) => /^VLT-GAP-(0[4-9]|1\d)$/.test(g)), "");
  return { checks, consumers, census, duplicates, usage, repoSql, importers: repoImporters };
}

// ── 4. Differential: frozen 03-B consumers (OLD) vs current tree (NEW) under identical stubs ──
const FIXED_NOW = Date.parse("2026-01-01T00:00:00Z");
function withFrozenDate(fn) {
  const RealDate = Date;
  class FixedDate extends RealDate { constructor(...a) { if (a.length) super(...a); else super(FIXED_NOW); } static now() { return FIXED_NOW; } }
  globalThis.Date = FixedDate;
  const restore = () => { globalThis.Date = RealDate; };
  return Promise.resolve().then(fn).then((v) => { restore(); return v; }, (e) => { restore(); throw e; });
}
const ok = (rows = []) => ({ value: { rows } });
const boom = (msg = "db boom") => ({ throw: msg });
const tableStub = (name) => new Proxy({ __table: name }, { get: (t, p) => (p === "__table" ? name : typeof p === "symbol" || p === "then" ? undefined : { __col: `${name}.${String(p)}` }) });
const nzq = (q) => (q?.__raw !== undefined ? String(q.__raw) : q?.__sql ? q.__sql.join("?") : "").replace(/\s+/g, " ").trim();
function makeEnv(rules = [], script = {}, extra = {}) {
  const env = createEnv(script);
  env.rules = rules.map(([re, ...results]) => ({ re: new RegExp(re, "i"), results: [...results] }));
  env.db.execute = (q) => {
    env.log.push(["db.execute", summ(q)]);
    const text = nzq(q); const rule = env.rules.find((r) => r.re.test(text));
    if (!rule || !rule.results.length) return Promise.resolve({ rows: [] });
    const item = rule.results.length > 1 ? rule.results.shift() : rule.results[0];
    env.log.push(["result", item.throw ? { throw: item.throw } : { rows: summ(item.value.rows) }]);
    return item.throw ? Promise.reject(new Error(item.throw)) : Promise.resolve(item.value);
  };
  env.stubs["lib/vault-crypto"] = {
    encryptField: (v) => { env.log.push(["encryptField", summ(v)]); return v === null || v === undefined ? v : `enc(${v})`; },
    decryptField: (v) => { env.log.push(["decryptField", summ(v)]); if (v === "BAD") throw new Error("bad ciphertext"); return v === null || v === undefined ? v : `dec(${v})`; },
    decryptRow: (row, f) => { env.log.push(["decryptRow", summ(f)]); return row ? { ...row, __decrypted: true } : row; },
    decryptRows: (rows, f) => { env.log.push(["decryptRows", summ(f)]); return rows.map((r) => ({ ...r, __decrypted: true })); },
  };
  const base = env.stubs["@workspace/db"];
  env.stubs["@workspace/db"] = new Proxy(base, { get: (t, p) => (p in t ? t[p] : typeof p === "symbol" || p === "then" ? undefined : tableStub(String(p))) });
  const baseDrizzle = env.stubs["drizzle-orm"];
  env.stubs["drizzle-orm"] = new Proxy(baseDrizzle, { get: (t, p) => (p in t ? t[p] : typeof p === "symbol" || p === "then" ? undefined : (...args) => ({ __sql: [String(p)], values: args })) });
  const baseAuth = env.stubs["middlewares/auth"];
  env.stubs["middlewares/auth"] = new Proxy(baseAuth, { get: (t, p) => (p in t ? t[p] : typeof p === "symbol" || p === "then" ? undefined : (...a) => { const m = () => {}; Object.defineProperty(m, "name", { value: `${String(p)}(${a.map((x) => JSON.stringify(x)).join(",")})` }); return m; }) });
  env.stubs["lib/policy/pep"] = { authorize: async ({ action, resource, engine }) => { env.log.push(["authorize", summ({ action, resource, engine: engine?.__engine })]); return {}; } };
  env.stubs.crypto = { createHmac: (alg, key) => { env.log.push(["createHmac", [alg, key]]); return { update: (s) => { env.log.push(["hmac.update", s]); return { digest: (enc) => `sig(${enc ?? "buf"})` }; } }; } };
  env.stubs.axios = { default: { get: async (url, cfg) => {
    env.log.push(["axios.get", summ([url, cfg])]);
    if (extra.axios === "401") throw Object.assign(new Error("Request failed with status code 401"), { response: { status: 401 } });
    if (extra.axios === "err") throw new Error("net down");
    return { data: extra.axiosData ?? {} };
  } } };
  return env;
}
const makeRes = () => { const r = fakeRes(); r.headers = {}; r.setHeader = (k, v) => { r.headers[k] = v; r.calls.push(["setHeader", k, v]); return r; }; return r; };
function loadRoute(which, c, env, overrides) {
  const ld = createLoader({ ts, root: ROOT, srcDir: SRC, env });
  if (overrides) for (const [k, v] of overrides) env.overrides.set(k, v);
  // OLD exchange-api imported the ownership wrapper through routes/kyc's compat re-export: give it the REAL owner module, same as NEW loads
  env.stubs["routes/kyc"] = ld.loadFile(path.join(SRC, OWNER.security));
  const abs = path.join(SRC, c.file);
  return which === "old" ? ld.loadText(frozenText(c.frozen), c.file, ROUTES) : ld.loadFile(abs);
}
const routeOf = (routes, method, p) => routes.find((r) => r.method === method && r.path === p);
async function invokeRoute(which, c, overrides) {
  const env = makeEnv(c.db ?? [], c.script ?? {}, { axios: c.axios, axiosData: c.axiosData });
  loadRoute(which, CONSUMER_BY_FILE[c.file], env, overrides);
  const r = routeOf(env.routes, c.method, c.path); if (!r) return { error: `route not registered: ${c.method} ${c.path}` };
  const res = makeRes(); const req = { user: { userId: c.user ?? 7 }, params: c.params ?? {}, query: c.query ?? {}, body: c.body ?? {}, headers: {} };
  let thrown = null;
  try { await r.stack[r.stack.length - 1](req, res); } catch (e) { thrown = String(e?.message ?? e); }
  await new Promise((rs) => setImmediate(rs));
  return { status: res.statusCode ?? (res.body !== undefined ? 200 : null), body: summ(res.body), headers: res.headers, thrown, log: env.log };
}
// function-level: ownership resource builders (OLD frozen vs NEW)
async function invokeResource(which, c, overrides) {
  const env = makeEnv(c.db ?? []);
  const ld = createLoader({ ts, root: ROOT, srcDir: SRC, env });
  if (overrides) for (const [k, v] of overrides) env.overrides.set(k, v);
  let value, thrown = null;
  try {
    if (c.fn === "kycEntryResource" || c.fn === "kycDataEntityResource") {
      const mod = which === "old" ? ld.loadText(frozenText("kyc-ownership.ts"), "vault/security/kyc-ownership.ts", path.join(SRC, "vault/security")) : ld.loadFile(path.join(SRC, OWNER.security));
      value = await mod[c.fn]({ params: c.params ?? {} });
    } else { // kycEntryOwnerResource(number): OLD lived privately in routes/projects.ts
      let fn;
      if (which === "old") { const sl = sliceSymbols(ts, frozenText("projects.ts"), ["PROJECTS_OWNER_SENTINEL_NONE", "kycEntryOwnerResource"], { fileName: "projects-owner-slice.ts" }); if (sl.missing.length) return { error: `frozen symbols missing: ${sl.missing.join(",")}` }; fn = ld.loadText(sl.text, "routes/projects.ts", ROUTES).kycEntryOwnerResource; }
      else fn = ld.loadFile(path.join(SRC, OWNER.security)).kycEntryOwnerResource;
      value = await fn(c.arg);
    }
  } catch (e) { thrown = String(e?.message ?? e); }
  return { status: null, body: summ(value), thrown, log: env.log };
}
// function-level: KYC row → account_data mapping (OLD sliced from frozen projects.ts vs NEW owner)
async function invokeMapping(which, c, overrides) {
  const env = makeEnv([]);
  const ld = createLoader({ ts, root: ROOT, srcDir: SRC, env });
  if (overrides) for (const [k, v] of overrides) env.overrides.set(k, v);
  let value, thrown = null;
  try {
    if (which === "old") {
      const sl = sliceSymbols(ts, frozenText("projects.ts"), ["KYC_ENTRY_SENSITIVE_FIELDS", "accountDataFromKycEntry"], { fileName: "projects-map-slice.ts" });
      if (sl.missing.length) return { error: `frozen symbols missing: ${sl.missing.join(",")}` };
      const mod = ld.loadText(`${sl.text}\nexport const legacyMap = (row: any) => accountDataFromKycEntry(decryptRow(row, KYC_ENTRY_SENSITIVE_FIELDS));`, "routes/projects.ts", ROUTES);
      value = mod.legacyMap(c.row);
    } else value = ld.loadFile(path.join(SRC, OWNER.enrollment)).buildEnrollmentAccountData(c.row);
  } catch (e) { thrown = String(e?.message ?? e); }
  return { status: null, body: summ(value), thrown, log: env.log };
}
const CASES = [];
const C = (name, category, kind, method, p, o = {}) => CASES.push({ name, category, kind, method, path: p, ...o });
const Q = { EX_SEL: "SELECT platform, username, name, exchange_api_key", EX_UPD: "UPDATE kyc_entries SET", KYC_ROW: "FROM kyc_entries WHERE id = \\? AND user_id", KYC_OWNER: "SELECT user_id FROM kyc_entries" };
const EX = "routes/exchange-api.ts", PR = "routes/projects.ts";
const KEYROW = { platform: "Binance", username: "u", name: "n", exchange_api_key: "K1", exchange_api_secret: "S1" };
// exchange-api — GET /exchange-balance/:id
const BAL = (name, category, o) => C(name, category, "route", "GET", "/exchange-balance/:id", { file: EX, params: { id: "5" }, ...o });
BAL("balance: no such (owned) entry → 404", "failure", { db: [[Q.EX_SEL, ok([])]] });
BAL("balance: entry without keys → hasKeys false (platform lower-cased)", "success", { db: [[Q.EX_SEL, ok([{ ...KEYROW, platform: "BINANCE", exchange_api_key: null, exchange_api_secret: null }])]] });
BAL("balance: key but no secret → hasKeys false", "success", { db: [[Q.EX_SEL, ok([{ ...KEYROW, exchange_api_secret: null }])]] });
BAL("balance: binance with keys → proxied balances", "success", { db: [[Q.EX_SEL, ok([KEYROW])]], axiosData: { canTrade: true, accountType: "SPOT", balances: [{ asset: "BTC", free: "1", locked: "0" }, { asset: "ETH", free: "0", locked: "0" }] } });
BAL("balance: bybit with keys", "success", { db: [[Q.EX_SEL, ok([{ ...KEYROW, platform: "Bybit" }])]], axiosData: { result: { list: [{ coin: [{ coin: "USDT", walletBalance: "10", availableToWithdraw: "4" }] }] } } });
BAL("balance: kucoin with keys", "success", { db: [[Q.EX_SEL, ok([{ ...KEYROW, platform: "KuCoin" }])]], axiosData: { data: [{ currency: "BTC", balance: "2", available: "1", holds: "1", type: "trade" }] } });
BAL("balance: bitget with keys", "success", { db: [[Q.EX_SEL, ok([{ ...KEYROW, platform: "Bitget" }])]], axiosData: { data: [{ coin: "BTC", available: "1", frozen: "0" }] } });
BAL("balance: unsupported exchange → note", "success", { db: [[Q.EX_SEL, ok([{ ...KEYROW, platform: "Kraken" }])]] });
BAL("balance: null platform → empty exchange", "success", { db: [[Q.EX_SEL, ok([{ ...KEYROW, platform: null }])]] });
BAL("balance: exchange 401 → invalid key body", "failure", { db: [[Q.EX_SEL, ok([KEYROW])]], axios: "401" });
BAL("balance: exchange network error → error body", "failure", { db: [[Q.EX_SEL, ok([KEYROW])]], axios: "err" });
BAL("balance: db throws → error body (inside route try/catch)", "failure", { db: [[Q.EX_SEL, boom("bal boom")]] });
BAL("balance: undecryptable secret → error body", "failure", { db: [[Q.EX_SEL, ok([{ ...KEYROW, exchange_api_secret: "BAD" }])]] });
BAL("balance: non-numeric id → 400 (handler guard)", "failure", { params: { id: "abc" } });
BAL("balance: query is scoped to the caller (other user)", "security", { user: 99, db: [[Q.EX_SEL, ok([])]] });
// exchange-api — PATCH /kyc-entries/:id/exchange-keys
const PAT = (name, category, o) => C(name, category, "route", "PATCH", "/kyc-entries/:id/exchange-keys", { file: EX, params: { id: "5" }, ...o });
PAT("keys: both key and secret saved encrypted", "success", { body: { apiKey: "ak", apiSecret: "as" } });
PAT("keys: only apiKey", "success", { body: { apiKey: "ak" } });
PAT("keys: only apiSecret", "success", { body: { apiSecret: "as" } });
PAT("keys: empty apiKey → NULL (clear)", "success", { body: { apiKey: "", apiSecret: "as" } });
PAT("keys: null secret → NULL (clear)", "success", { body: { apiKey: "ak", apiSecret: null } });
PAT("keys: non-string key coerced as before", "success", { body: { apiKey: 12345 } });
PAT("keys: quote in secret stays escaped in SQL", "security", { body: { apiKey: "a'b", apiSecret: "x'; DROP TABLE kyc_entries;--" } });
PAT("keys: nothing to update → 400", "failure", { body: {} });
PAT("keys: non-numeric id → 400", "failure", { params: { id: "abc" }, body: { apiKey: "ak" } });
PAT("keys: update throws → 500 DB error", "failure", { body: { apiKey: "ak" }, db: [[Q.EX_UPD, boom("upd boom")]] });
PAT("keys: update is scoped to the caller (other user)", "security", { user: 99, body: { apiKey: "ak" } });
// projects — POST /projects/:id/enroll (enroll-by-KYC-entity shortcut)
const KYC_ROW = { id: 5, user_id: 7, username: "u", account_password: "epw", email: "e@x", email_password: "mpw", email_2fa: "e2", email_backup_code: "ebc", notes: "n", last_login_at: null, account_buy_date: "2026-01-01", account_buy_price: 0, account_worth: 12.5, followers: "1k", email_recovery: "r@x", email_recovery_password: "rp", recovery_2fa: "r2", recovery_backup_code: "rbc", nid_number: "nid" };
const VAULT_OK = { "db.select:vaultEntriesTable": [{ value: [{ id: 11, userId: 7 }] }] };
const ENR = (name, category, o) => C(name, category, "route", "POST", "/projects/:id/enroll", { file: PR, params: { id: "3" }, ...o });
const KYC_OK = [Q.KYC_ROW, ok([KYC_ROW])], OWNER_OK = [Q.KYC_OWNER, ok([{ user_id: 7 }])];
const ENROLLED = { id: 50, userId: 7, projectId: 3, vaultEntryId: 11, status: "active", accountData: null, enrolledAt: new Date(FIXED_NOW) };
ENR("enroll: vault entity missing → 404 (KYC never reached)", "failure", { body: { vaultEntryId: 11, kycEntryId: 5 } });
ENR("enroll: KYC entity not found / not owned → 404", "failure", { body: { vaultEntryId: 11, kycEntryId: 5 }, script: VAULT_OK });
ENR("enroll: KYC entity already enrolled elsewhere → 409", "failure", { body: { vaultEntryId: 11, kycEntryId: 5 }, script: { ...VAULT_OK, "db.select:projectEnrollmentsTable": [{ value: [{ id: 2, vaultEntryId: 99 }] }] }, db: [KYC_OK, OWNER_OK] });
ENR("enroll: KYC-backed re-enroll of a banned pair → 403", "failure", { body: { vaultEntryId: 11, kycEntryId: 5 }, script: { ...VAULT_OK, "db.select:projectEnrollmentsTable": [{ value: [] }, { value: [{ id: 1, status: "banned" }] }] }, db: [KYC_OK, OWNER_OK] });
ENR("enroll: KYC-backed enroll already active → 409", "failure", { body: { vaultEntryId: 11, kycEntryId: 5 }, script: { ...VAULT_OK, "db.select:projectEnrollmentsTable": [{ value: [] }, { value: [{ id: 1, status: "active" }] }] }, db: [KYC_OK, OWNER_OK] });
ENR("enroll: KYC-backed fresh enrollment → 201 (account_data built from the KYC row)", "success", { body: { vaultEntryId: 11, kycEntryId: 5 }, script: { ...VAULT_OK, "db.select:projectEnrollmentsTable": [{ value: [] }, { value: [] }], "db.insert:projectEnrollmentsTable": [{ value: [ENROLLED] }] }, db: [KYC_OK, OWNER_OK] });
ENR("enroll: KYC-backed reactivation of a cancelled enrollment → 201", "success", { body: { vaultEntryId: 11, kycEntryId: 5, dataEntityId: 8 }, script: { ...VAULT_OK, "db.select:projectEnrollmentsTable": [{ value: [] }, { value: [{ id: 1, status: "cancelled", vaultEntryId: 11, kycEntryId: null, dataEntityId: null, accountData: "{}" }] }], "db.update:projectEnrollmentsTable": [{ value: [{ ...ENROLLED, id: 1 }] }] }, db: [KYC_OK, OWNER_OK] });
ENR("enroll: audit owner re-fetch finds no row → sentinel owner", "security", { body: { vaultEntryId: 11, kycEntryId: 5 }, script: { ...VAULT_OK, "db.select:projectEnrollmentsTable": [{ value: [] }, { value: [{ id: 1, status: "banned" }] }] }, db: [KYC_OK] });
ENR("enroll: string kycEntryId (JSON) → Number.isFinite guard → sentinel owner", "security", { body: { vaultEntryId: 11, kycEntryId: "5" }, script: { ...VAULT_OK, "db.select:projectEnrollmentsTable": [{ value: [] }, { value: [{ id: 1, status: "banned" }] }] }, db: [KYC_OK, OWNER_OK] });
ENR("enroll: fractional kycEntryId is bound as a parameter", "security", { body: { vaultEntryId: 11, kycEntryId: 1.5 }, script: { ...VAULT_OK, "db.select:projectEnrollmentsTable": [{ value: [] }, { value: [{ id: 1, status: "banned" }] }] }, db: [KYC_OK, OWNER_OK] });
ENR("enroll: KYC lookup is scoped to the caller (other user)", "security", { user: 99, body: { vaultEntryId: 11, kycEntryId: 5 }, script: { "db.select:vaultEntriesTable": [{ value: [{ id: 11, userId: 99 }] }] } });
ENR("enroll: KYC lookup throws → propagates", "failure", { body: { vaultEntryId: 11, kycEntryId: 5 }, script: VAULT_OK, db: [[Q.KYC_ROW, boom("kyc boom")]] });
ENR("enroll: audit owner re-fetch throws → propagates", "failure", { body: { vaultEntryId: 11, kycEntryId: 5 }, script: VAULT_OK, db: [KYC_OK, [Q.KYC_OWNER, boom("owner boom")]] });
ENR("enroll: no kycEntryId → KYC code never runs (manual account_data path)", "success", { body: { vaultEntryId: 11, accountData: { username: "m" } }, script: { ...VAULT_OK, "db.select:projectEnrollmentsTable": [{ value: [] }], "db.insert:projectEnrollmentsTable": [{ value: [ENROLLED] }] } });
// ownership resource builders
const RES = (name, category, fn, o) => C(name, category, "resource", "CALL", fn, { fn, ...o });
RES("kycEntryResource: owned id", "success", "kycEntryResource", { params: { id: "5" }, db: [[Q.KYC_OWNER, ok([{ user_id: 7 }])]] });
RES("kycEntryResource: unknown id → sentinel owner", "failure", "kycEntryResource", { params: { id: "5" } });
RES("kycEntryResource: non-numeric id → sentinel, no db call", "failure", "kycEntryResource", { params: { id: "abc" } });
RES("kycEntryResource: db throws → propagates", "failure", "kycEntryResource", { params: { id: "5" }, db: [[Q.KYC_OWNER, boom("res boom")]] });
RES("kycEntryResource: other user's id resolves the real owner (PEP decides)", "security", "kycEntryResource", { params: { id: "5" }, db: [[Q.KYC_OWNER, ok([{ user_id: 8 }])]] });
RES("kycDataEntityResource: owned id", "success", "kycDataEntityResource", { params: { id: "9" }, db: [["SELECT user_id FROM kyc_data_entities", ok([{ user_id: 7 }])]] });
RES("kycDataEntityResource: non-numeric id → sentinel", "failure", "kycDataEntityResource", { params: { id: "x" } });
const NUMRES = (name, category, arg, o = {}) => C(name, category, "resource", "CALL", "kycEntryOwnerResource", { fn: "kycEntryOwnerResource", arg, ...o });
NUMRES("kycEntryOwnerResource(5) owned", "success", 5, { db: [[Q.KYC_OWNER, ok([{ user_id: 7 }])]] });
NUMRES("kycEntryOwnerResource(5) no row → sentinel", "failure", 5);
NUMRES("kycEntryOwnerResource(NaN) → sentinel, no db call", "failure", NaN);
NUMRES("kycEntryOwnerResource(Infinity) → sentinel, no db call", "failure", Infinity);
NUMRES("kycEntryOwnerResource('5') string → sentinel (isFinite quirk preserved)", "security", "5");
NUMRES("kycEntryOwnerResource(1.5) → queried as given", "success", 1.5, { db: [[Q.KYC_OWNER, ok([{ user_id: 7 }])]] });
NUMRES("kycEntryOwnerResource: db throws → propagates", "failure", 5, { db: [[Q.KYC_OWNER, boom("num boom")]] });
NUMRES("kycEntryOwnerResource: other owner returned as-is", "security", 5, { db: [[Q.KYC_OWNER, ok([{ user_id: 8 }])]] });
// account_data mapping
const MAP = (name, category, row) => C(name, category, "mapping", "CALL", "buildEnrollmentAccountData", { row });
MAP("mapping: full row", "success", KYC_ROW);
MAP("mapping: sparse row → empty strings, zero preserved", "success", { id: 1, account_buy_price: 0, account_worth: 0 });
MAP("mapping: nulls fall back to empty strings", "failure", { username: null, email: null, notes: null, followers: null, last_login_at: null });
MAP("mapping: sensitive fields are exactly the decrypt list (decryptRow argument logged)", "security", { account_password: "x", email_2fa: "y", nid_number: "z" });

const cmp = (a, b) => JSON.stringify(a) === JSON.stringify(b);
async function differentialSuite(overrides) {
  const out = [];
  for (const c of CASES) {
    const run = (w) => { const ov = w === "new" ? overrides : undefined; return c.kind === "resource" ? invokeResource(w, c, ov) : c.kind === "mapping" ? invokeMapping(w, c, ov) : invokeRoute(w, c, ov); };
    let o, n;
    try { [o, n] = await withFrozenDate(async () => [await run("old"), await run("new")]); } catch (e) { o = { error: `suite threw: ${e?.message ?? e}` }; n = o; }
    const diffs = [];
    if (o.error || n.error) diffs.push(o.error ?? n.error);
    else {
      if (o.status !== n.status) diffs.push(`status ${o.status} → ${n.status}`);
      if (!cmp(o.body, n.body)) diffs.push(`body ${canon(o.body).slice(0, 120)} → ${canon(n.body).slice(0, 120)}`);
      if (!cmp(o.headers, n.headers)) diffs.push("headers differ");
      if (o.thrown !== n.thrown) diffs.push(`thrown ${o.thrown} → ${n.thrown}`);
      if (!cmp(o.log, n.log)) { const i = o.log.findIndex((x, k) => !cmp(x, n.log[k])); diffs.push(`call log differs at #${i < 0 ? Math.min(o.log.length, n.log.length) : i}: ${canon(o.log[i] ?? null).slice(0, 170)} ≠ ${canon(n.log[i] ?? null).slice(0, 170)}`); }
    }
    out.push({ name: `${c.method} ${c.path}${c.file ? ` [${c.file}]` : ""} — ${c.name}`, category: c.category, kind: c.kind, passed: diffs.length === 0, diffs, log_entries: o.log?.length ?? 0, old_status: o.status });
  }
  return out;
}
// Security regression: middleware chains (auth, ownership action, builder identity, deny bodies) old vs new for every consumer route file.
function describeMw(mw) {
  if (mw.__ownership) {
    const deny = [{ params: { id: "5" } }, { params: { id: "abc" } }].map((rq) => { const res = fakeRes(); mw.__ownership.opts.onDeny({ ...rq, body: {}, query: {} }, res); return { status: res.statusCode ?? 200, body: summ(res.body) }; });
    return { kind: "ownership", action: mw.__ownership.action, builder: sha256(String(mw.__ownership.builder)), onDecision: mw.__ownership.opts.onDecision?.name ?? null, deny };
  }
  return { kind: "named", name: mw.name };
}
async function securitySuite(overrides) {
  const out = []; const t = (name, passed, details = "") => out.push({ name, passed, details, category: "security" });
  for (const c of CONSUMERS) {
    const tables = {};
    for (const which of ["old", "new"]) {
      try { const env = makeEnv([]); loadRoute(which, c, env, which === "new" ? overrides : undefined); tables[which] = env.routes.map((r) => ({ method: r.method, path: r.path, mw: r.stack.slice(0, -1).map(describeMw) })); }
      catch (e) { tables[which] = [`load failed: ${e?.message ?? e}`]; }
    }
    t(`security:route-middleware-chains-identical:${c.file}`, cmp(tables.old, tables.new) && tables.old.length > 0 && typeof tables.old[0] === "object", "auth / ownership action / builder / deny body / credit-gate chain changed");
  }
  { const env = makeEnv([]); const ld = createLoader({ ts, root: ROOT, srcDir: SRC, env }); const sec = ld.loadFile(path.join(SRC, OWNER.security));
    const m = sec.requireKycEntryOwnership("x.action", (_q, res) => res.status(418).json({ e: 1 })); t("security:vault-security-owner-gate-is-callable", Boolean(m?.__ownership), "");
    t("security:owner-gate-binds-the-KYC-entry-resource-builder", m?.__ownership?.builder === sec.kycEntryResource, ""); }
  // the exchange-keys route must be gated by the SAME builder as the KYC routes (no hand-rolled copy)
  { const env = makeEnv([]); loadRoute("new", CONSUMER_BY_FILE[EX], env, overrides); const kyc = makeEnv([]); loadRoute("new", CONSUMER_BY_FILE["routes/kyc.ts"], kyc, overrides);
    const eb = env.routes.filter((r) => r.stack.some((m) => m.__ownership)).map((r) => sha256(String(r.stack.find((m) => m.__ownership).__ownership.builder)));
    const kb = kyc.routes.filter((r) => r.stack.some((m) => m.__ownership)).map((r) => sha256(String(r.stack.find((m) => m.__ownership).__ownership.builder)));
    t("security:exchange-api-and-kyc-routes-share-one-ownership-builder", eb.length === 2 && kb.length === 4 && new Set([...eb, ...kb]).size === 1, `${eb.length}+${kb.length} gated routes, ${new Set([...eb, ...kb]).size} distinct builders`); }
  return out;
}
async function mutationTests() {
  const res = []; const P = (f) => path.join(SRC, f);
  const muts = [
    { name: "exchange SELECT drops owner filter", file: P(OWNER.repo), from: /FROM kyc_entries WHERE id = \$\{id\} AND user_id = \$\{userId\} LIMIT 1`\)\n  \);\n\}\n\nexport type/, to: "FROM kyc_entries WHERE id = ${id} LIMIT 1`)\n  );\n}\n\nexport type" },
    { name: "exchange UPDATE drops owner filter", file: P(OWNER.repo), from: /updated_at = NOW\(\) WHERE id = \$\{id\} AND user_id = \$\{userId\}`\)/, to: "updated_at = NOW() WHERE id = ${id}`)" },
    { name: "enrollment lookup drops owner filter", file: P(OWNER.repo), from: /FROM kyc_entries WHERE id = \$\{kycEntryId\} AND user_id = \$\{userId\} LIMIT 1/, to: "FROM kyc_entries WHERE id = ${kycEntryId} LIMIT 1" },
    { name: "SQL escaper removed (injection)", file: P(OWNER.repo), from: /String\(v\)\.replace\(\/'\/g, "''"\)/, to: "String(v)" },
    { name: "apiKey stored in plaintext", file: P(OWNER.exchange), from: /apiKey \? encryptField\(apiKey\) : null/, to: "apiKey || null" },
    { name: "apiSecret stored in plaintext", file: P(OWNER.exchange), from: /apiSecret \? encryptField\(apiSecret\) : null/, to: "apiSecret || null" },
    { name: "exchange secret no longer decrypted", file: P(OWNER.exchange), from: /row\.exchange_api_secret \? decryptField\(row\.exchange_api_secret\) : null/, to: "row.exchange_api_secret ? row.exchange_api_secret : null" },
    { name: "platform no longer lower-cased", file: P(OWNER.exchange), from: /\(row\.platform \|\| ""\)\.toLowerCase\(\)/, to: '(row.platform || "")' },
    { name: "'Nothing to update' becomes 404", file: P(OWNER.exchange), from: /status: 400, body: \{ error: "Nothing to update" \}/, to: 'status: 404, body: { error: "Nothing to update" }' },
    { name: "invalid id guard removed from key save", file: P(OWNER.exchange), from: /  if \(isNaN\(id\)\) return \{ status: 400, body: \{ error: "Invalid ID" \} \};\n\n  const \{ apiKey/, to: "  const { apiKey" },
    { name: "DB error swallowed as success", file: P(OWNER.exchange), from: /  \} catch \(err: any\) \{\n    return dbError\(err\);\n  \}\n\}\s*$/, to: "  } catch (err: any) {\n    return { status: 200, body: { success: true } };\n  }\n}\n" },
    { name: "enrollment mapping drops a field", file: P(OWNER.enrollment), from: /    notes: k\.notes \?\? "",\n/, to: "" },
    { name: "enrollment mapping stops decrypting", file: P(OWNER.enrollment), from: /const decrypted = decryptRow\(kycRow, KYC_SENSITIVE_FIELDS\);/, to: "const decrypted = kycRow;" },
    { name: "enrollment decrypts with a shorter field list", file: P(OWNER.enrollment), from: /decryptRow\(kycRow, KYC_SENSITIVE_FIELDS\)/, to: "decryptRow(kycRow, [\"account_password\"] as any)" },
    { name: "numeric owner resource loses the isFinite guard", file: P(OWNER.security), from: /if \(!Number\.isFinite\(kycEntryId\)\) return \{ type: "kyc_entry", id: kycEntryId, ownerId: KYC_ENTRY_OWNER_SENTINEL_NONE \};\n/, to: "" },
    { name: "numeric owner resource returns caller-agnostic owner", file: P(OWNER.security), from: /const ownerId = row\?\.user_id \?\? KYC_ENTRY_OWNER_SENTINEL_NONE;/, to: "const ownerId = 7;" },
    { name: "kycEntryResource sentinel changed", file: P(OWNER.security), from: /ownerId: row\?\.user_id \?\? KYC_ENTRY_OWNER_SENTINEL_NONE \};\n\};/, to: "ownerId: row?.user_id ?? 0 };\n};" },
    { name: "exchange-keys route ownership gate removed", file: P(EX), from: /requireKycEntryOwnership\("kyc_entry\.exchange_keys\.update", \(_req, res\) => \{ res\.json\(\{ success: true \}\); \}\)/, to: "((_req: any, _res: any, next: any) => next())" },
    { name: "exchange-balance route ownership action renamed", file: P(EX), from: /requireExchangeBalanceKycOwnership\("kyc_entry\.exchange_balance\.read"\)/, to: 'requireExchangeBalanceKycOwnership("kyc_entry.exchange_balance.readx")' },
    { name: "projects enroll skips the KYC ownership audit", file: P(PR), from: /    await auditProjectsOwnership\(req, kycEntryAuditEngine, "project\.enroll\.kyc_entry", await kycEntryOwnerResource\(kycEntryId\)\);\n/, to: "" },
    { name: "projects enroll ignores the KYC-entity-in-use guard", file: P(PR), from: /if \(inUse && inUse\.vaultEntryId !== vaultEntryId\) \{/, to: "if (false) {" },
    { name: "projects enroll 404 body changed", file: P(PR), from: /res\.status\(404\)\.json\(\{ error: "KYC entity not found" \}\)/, to: 'res.status(404).json({ error: "Not found" })' },
  ];
  for (const m of muts) {
    const orig = fs.readFileSync(m.file, "utf8");
    if (!m.from.test(orig)) { res.push({ name: `mutation:${m.name}`, passed: false, details: "mutation anchor not found (fail closed)" }); continue; }
    const overrides = new Map([[m.file, orig.replace(m.from, m.to)]]);
    let suite;
    try { suite = [...(await differentialSuite(overrides)), ...(await securitySuite(overrides))]; } catch (e) { suite = [{ passed: false, name: `suite threw: ${e?.message ?? e}` }]; }
    const detected = suite.some((s) => !s.passed);
    res.push({ name: `mutation-detected:${m.name}`, passed: detected, details: detected ? "" : "seeded regression was NOT detected" });
  }
  return res;
}

// ── 5. Diff audit against the sealed 03-B tree ──
function diffAudit() {
  const man = JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf8")).files;
  const now = {}; for (const f of walkFiles(ROOT)) { const k = rel(f); if (!k.startsWith(GAP_DIR)) now[k] = sha256File(f); }
  const changed = [], added = [], removed = [];
  for (const [k, v] of Object.entries(now)) { if (!(k in man)) added.push(k); else if (man[k] !== v) changed.push(k); }
  for (const k of Object.keys(man)) if (!(k in now)) removed.push(k);
  const gapNow = walkFiles(path.join(ROOT, GAP_DIR)).map(rel);
  const gapAdded = gapNow.filter((k) => !(k in (SEAL.gap_scripts_at_freeze ?? {})));
  const unexpected = [...changed.filter((k) => !CHANGED_ALLOWED.has(k)), ...added.filter((k) => !isAllowedAdd(k)), ...gapAdded.filter((k) => !isAllowedAdd(k)), ...removed];
  return { changed, added, removed, gap_added: gapAdded, unexpected, allowed_changed: [...CHANGED_ALLOWED], allowed_added: [...ADDED_ALLOWED, `${GAP_DIR}validate-vlt-gap-03-C.mjs`, `${GAP_DIR}freeze-vlt-gap-03-C-baseline.mjs`] };
}

// ── 6. CI lint: executed for real (a temporary node_modules symlink provides the compiler when the upload has none) ──
function ciLint() {
  const script = path.join(ROOT, "scripts/src/check-ownership-gate-coverage.ts");
  const text = fs.readFileSync(script, "utf8");
  const staticOk = /VAULT_SECURITY_DIR/.test(text) && /wrapperSources/.test(text) && /vault\/security/.test(text);
  const baseline = path.join(ROOT, "scripts/src/ownership-gate-baseline.json");
  const baselineUnchanged = JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf8")).files["scripts/src/ownership-gate-baseline.json"] === sha256File(baseline);
  const nm = path.join(ROOT, "node_modules"); let linked = false, tmp = null;
  try {
    if (!fs.existsSync(nm)) {
      const g = spawnSync("npm", ["root", "-g"], { encoding: "utf8" }).stdout.trim();
      if (g && fs.existsSync(path.join(g, "typescript"))) { tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "vlt-nm-")); fs.mkdirSync(path.join(tmp, "node_modules")); fs.symlinkSync(path.join(g, "typescript"), path.join(tmp, "node_modules", "typescript")); fs.symlinkSync(path.join(tmp, "node_modules"), nm); linked = true; }
    }
    const r = spawnSync("tsx", [script], { cwd: path.join(ROOT, "scripts"), encoding: "utf8", timeout: 240000 });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    const executed = r.status !== null && !r.error && !/ERR_MODULE_NOT_FOUND|Cannot find (module|package)/.test(out);
    return { staticOk, baselineUnchanged, executed, exit: r.status, used_temp_typescript_link: linked, tail: out.trim().split("\n").slice(-3).join(" | ") };
  } finally { if (linked) { try { fs.unlinkSync(nm); } catch { /* ignore */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } } }
}

// ── 7. Degraded differential typecheck (project dependencies are not installed in the upload) ──
function typecheckDifferential() {
  const cfgRaw = ts.readConfigFile(path.join(ROOT, "tsconfig.base.json"), ts.sys.readFile).config?.compilerOptions ?? {};
  const opts = ts.convertCompilerOptionsFromJson({ ...cfgRaw, noEmit: true, skipLibCheck: true, types: [], incremental: false, composite: false, baseUrl: ROOT }, ROOT).options;
  const frozenMap = new Map(Object.entries(SEAL.frozen_consumers).filter(([, v]) => v.source.startsWith("artifacts/api-server/src/")).map(([n, v]) => [path.join(ROOT, v.source), path.join(FROZEN_DIR, n)]));
  const newAbs = NEW_FILES.map((f) => path.join(SRC, f));
  const scopeAbs = [...frozenMap.keys(), ...newAbs];
  const run = (useBaseline) => {
    const host = ts.createCompilerHost(opts); const rf = host.readFile.bind(host), gs = host.getSourceFile.bind(host);
    const ov = (f) => (useBaseline ? frozenMap.get(f) : undefined);
    host.readFile = (f) => rf(ov(f) ?? f);
    host.getSourceFile = (f, lv, ...r) => { const o = ov(f); return o ? ts.createSourceFile(f, fs.readFileSync(o, "utf8"), lv, true) : gs(f, lv, ...r); };
    const roots = useBaseline ? [...frozenMap.keys()] : scopeAbs;
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
  return { before_total: Object.values(before.tally).reduce((a, b) => a + b, 0), after_total: Object.values(after.tally).reduce((a, b) => a + b, 0), syntactic_errors: after.syntactic, new_diagnostics: regress, before_by_class: before.tally, after_by_class: after.tally };
}

// ── 8. Main ──
const sourceHashes = () => Object.fromEntries([...FROZEN_SOURCES, ...NEW_FILES.map(R), R("routes/kyc-data-entities.ts"), `${GAP_DIR}harness.mjs`, `${GAP_DIR}gap-common.mjs`, `${GAP_DIR}freeze-vlt-gap-03-C-baseline.mjs`, rel(SEAL_FILE), rel(MANIFEST_FILE)].map((f) => [f, sha256File(path.join(ROOT, f))]));
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
  const diff = await differentialSuite(); const sec = await securitySuite();
  const mut = await mutationTests(); const audit = diffAudit(); const lint = ciLint(); const tc = typecheckDifferential();

  const checks = [...st.checks];
  for (const r of diff) checks.push({ name: `differential:${r.name}`, passed: r.passed, details: r.diffs.join("; ") });
  for (const r of [...sec, ...mut]) checks.push({ name: r.name, passed: r.passed, details: r.details ?? "" });
  const cats = new Set(diff.map((d) => d.category));
  for (const c of ["success", "failure", "security"]) checks.push({ name: `coverage:category:${c}`, passed: cats.has(c), details: "" });
  const targets = [["GET", "/exchange-balance/:id"], ["PATCH", "/kyc-entries/:id/exchange-keys"], ["POST", "/projects/:id/enroll"], ["CALL", "kycEntryResource"], ["CALL", "kycEntryOwnerResource"], ["CALL", "buildEnrollmentAccountData"]];
  for (const [m, p] of targets) for (const k of ["success", "failure"]) checks.push({ name: `coverage:${m} ${p}:${k}`, passed: CASES.some((c) => c.method === m && c.path === p && c.category === k), details: "" });
  checks.push({ name: "coverage:security-cases-on-every-rewired-consumer", passed: ["GET /exchange-balance/:id", "PATCH /kyc-entries/:id/exchange-keys", "POST /projects/:id/enroll"].every((k) => CASES.some((c) => `${c.method} ${c.path}` === k && c.category === "security")), details: "" });
  checks.push({ name: "no-skipped-tests", passed: CASES.length > 0 && diff.length === CASES.length, details: `${diff.length}/${CASES.length}` });
  checks.push({ name: "differential-cases-executed-db-calls", passed: diff.filter((d) => d.log_entries > 0).length >= 35, details: `${diff.filter((d) => d.log_entries > 0).length} cases recorded interactions` });
  checks.push({ name: "differential-cases-exercise-the-rewired-code (some case ran past the old KYC code path to a 200/201)", passed: diff.some((d) => d.old_status === 201) && diff.some((d) => d.old_status === 200), details: "" });
  checks.push({ name: "diff-audit:no-unrelated-changes", passed: audit.unexpected.length === 0, details: audit.unexpected.join(", ") });
  checks.push({ name: "ci-lint:check-ownership-gate-coverage-scans-vault-security", passed: lint.staticOk, details: "" });
  checks.push({ name: "ci-lint:baseline-not-widened", passed: lint.baselineUnchanged, details: "ownership-gate-baseline.json must be unchanged (the rewire must not grandfather new gaps)" });
  checks.push({ name: "ci-lint:executed-green", passed: lint.executed && lint.exit === 0, details: lint.executed ? lint.tail : `NOT EXECUTED (fail closed): ${lint.tail}` });
  checks.push({ name: "typecheck:no-syntax-errors", passed: tc.syntactic_errors.length === 0, details: tc.syntactic_errors.join("; ") });
  checks.push({ name: "typecheck:no-new-diagnostics-vs-baseline", passed: tc.new_diagnostics.length === 0, details: tc.new_diagnostics.join("; ") });
  const failed = checks.filter((c) => !c.passed);
  const hashes = sourceHashes(); const b = binding(hashes);
  const deferred = st.census.filter((c) => c.kind === "deferred");
  const evidence = {
    phase: PHASE, sub_phase: SUB_PHASE,
    commit_sha: b.commit_sha, commit_binding: b.commit_binding, source_tree_sha256: b.source_tree_sha256,
    validator_version: VALIDATOR_VERSION, validator_sha256: sha256File(HERE),
    baseline: { mode: "write-once seal (verified, never written by this validator)", seal_file: rel(SEAL_FILE), sealed_at: SEAL.sealed_at, tree_manifest_sha256: SEAL.tree_manifest_sha256, certified_by: SEAL.certified_by, frozen_consumers: SEAL.frozen_consumers },
    source_hashes: hashes,
    commands: ["node scripts/antas/vault/gap/validate-vlt-gap-03-C.mjs", "in-process differential suite (sealed 03-B consumers vs new source)", "in-process seeded-mutation suite", "tsx scripts/src/check-ownership-gate-coverage.ts (executed)", "in-process differential typecheck"],
    exit_codes: { differential_suite: diff.every((d) => d.passed) ? 0 : 1, security_suite: sec.every((d) => d.passed) ? 0 : 1, mutation_suite: mut.every((d) => d.passed) ? 0 : 1, ci_lint: lint.executed ? lint.exit : null, typecheck_differential: tc.new_diagnostics.length === 0 && tc.syntactic_errors.length === 0 ? 0 : 1 },
    consumer_graph: { owner_modules: NEW_FILES, owner_symbols: st.usage, rewired_consumers: st.consumers, kyc_repository_importers: st.importers, moved_sql: st.repoSql },
    table_access_census: st.census,
    deferred_consumers: deferred.map((d) => ({ file: d.file, deferred_to: d.gap, reason: d.reason })),
    deferred_behavior: [{ file: R("routes/exchange-api.ts"), behavior: "exchange provider proxy (Binance/Bybit/KuCoin/Bitget balance calls, HMAC signing)", deferred_to: "VLT-GAP-12", reason: "provider access is infrastructure/providers; 03-C moves only the KYC credential read/write" }],
    duplicate_implementations: st.duplicates,
    ci_lint: lint,
    diff_audit: audit,
    typecheck: { mode: "degraded-differential (project dependencies are not installed in the upload; full tsc/build is NOT executed)", before_total: tc.before_total, after_total: tc.after_total, syntactic_errors: tc.syntactic_errors, new_diagnostics: tc.new_diagnostics },
    tests: { differential_cases: diff.length, differential_passed: diff.filter((d) => d.passed).length, security_checks: sec.length, security_passed: sec.filter((d) => d.passed).length, mutation_tests: mut.length, mutation_detected: mut.filter((d) => d.passed).length },
    notes: [
      "03-C rewires the KYC consumers that bypassed the Vault owner: exchange-api (credential read + key-pair write), projects (enroll-by-KYC lookup, owner re-fetch, private field-list copy, account_data mapping), the compat re-export in routes/kyc.ts, and the ownership regression suite import.",
      "New owner modules: vault/application/kyc/exchange.ts, vault/application/kyc/enrollment.ts, vault/infrastructure/repositories/kyc-consumer-repository.ts; vault/security/kyc-ownership.ts gains kycEntryOwnerResource (moved from projects) and now shares one owner-lookup statement with kycEntryResource.",
      "Every remaining KYC table access outside the owner is an explicit deferral to the gap that owns that behavior; the census FAILS on any unlisted access and on any stale deferral.",
      "routes/exchange-api.ts still performs the exchange provider proxy; it holds no KYC table access after this phase and is recorded under deferred_behavior (VLT-GAP-12).",
      "routes/kyc.ts and routes/kyc-data-entities.ts route tables are byte-identical in method/path/middleware to the sealed tree; only routes/kyc.ts lost its compat re-export (and a comment).",
      "The frontend sources (components/kyc-entries.tsx, pages/user/vault-kyc-*.tsx) call the unchanged public API and are not API consumers of the owner modules; they are handled in the later GAP-03 phases.",
      "The CI ownership-coverage lint is EXECUTED (a temporary node_modules link to the global TypeScript is created only when the upload has no node_modules, and removed afterwards). The ownership regression suite itself and the full tsc/build cannot run here (no @workspace packages / no DB); the differential suite and a degraded differential typecheck against the sealed baseline stand in and are recorded as such.",
      "The exchange-balance handler's thrown/caught error semantics are preserved: credential load happens inside the route's existing try/catch and throws exactly what the inline code threw.",
    ],
    checks, status: failed.length === 0 ? "PASS" : "FAIL",
  };
  evidence.evidence_body_sha256 = sha256(JSON.stringify(evidence));
  evidence.generated_at = new Date().toISOString();
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(EVIDENCE_FILE, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`${SUB_PHASE} ${evidence.status} — consumers=${st.consumers.length} census=${st.census.length} deferred=${deferred.length} diff-cases=${diff.length} security=${sec.length} mutations=${mut.filter((m) => m.passed).length}/${mut.length} (${Date.now() - started}ms)`);
  if (failed.length) { console.error(failed.map((c) => `- ${c.name}: ${String(c.details).slice(0, 300) || "not satisfied"}`).join("\n")); process.exit(1); }
}
main().catch((e) => fail(`validator crashed: ${e.stack || e}`));
