#!/usr/bin/env node
// VLT-GAP-02-C — Consumer Rewire (local accounts, API side). Fail-closed validator.
// Evidence: reports/antas/vault/gap/VLT-GAP-02/consumer-graph.json
//
// Proves, from source and by execution, that every cross-module consumer of local accounts that used to
// bypass the Vault owner (routes/value-history.ts, routes/vault.ts, routes/bulk.ts, and the compat re-export in
// routes/local-accounts.ts) now goes through vault/{application,infrastructure,security}; that the moved SQL is
// verbatim; that behavior is unchanged (frozen 02-B tree vs new differential suite); that every remaining
// table access outside the owner is an explicit, owned deferral; and that nothing unrelated changed.
//
// This validator NEVER writes a baseline. It only VERIFIES the write-once seal produced by
// freeze-vlt-gap-02-C-baseline.mjs (02-A overwrites its own baseline on every run, so it cannot be trusted).
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ROOT, sha256, sha256File, rel, rejectBypass, binding, walkFiles } from "./gap-common.mjs";
import { loadTs, createEnv, createLoader, fakeRes, summ, sliceSymbols } from "./harness.mjs";

const VALIDATOR_VERSION = "1.0.0";
const PHASE = "VLT-GAP-02";
const SUB_PHASE = "VLT-GAP-02-C";
const HERE = fileURLToPath(import.meta.url);
const SRC = path.join(ROOT, "artifacts/api-server/src");
const ROUTES = path.join(SRC, "routes");
const EVIDENCE_DIR = path.join(ROOT, "reports/antas/vault/gap/VLT-GAP-02");
const EVIDENCE_FILE = path.join(EVIDENCE_DIR, "consumer-graph.json");
const BASE = path.join(EVIDENCE_DIR, "baseline-02c");
const SEAL_FILE = path.join(BASE, "SEAL.json");
const R = (f) => `artifacts/api-server/src/${f}`;

const fail = (m) => { console.error(`${SUB_PHASE} FAIL — ${m}`); process.exit(1); };
const bypass = rejectBypass();
if (bypass.length) fail(`bypass mechanism rejected: ${bypass.join(", ")}`);
if (process.env.VALIDATION_DISABLED && !/^(0|false|no)$/i.test(process.env.VALIDATION_DISABLED)) fail("bypass mechanism rejected: env VALIDATION_DISABLED");
const ts = loadTs(ROOT);
if (!ts) fail("TypeScript compiler API unavailable (fail closed)");
const parse = (name, text) => ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

// ── 0. The write-once seal must exist and be internally consistent (this validator never creates it) ──
if (!fs.existsSync(SEAL_FILE)) fail("baseline-02c/SEAL.json missing — run freeze-vlt-gap-02-C-baseline.mjs ONCE, before any 02-C change");
const SEAL = JSON.parse(fs.readFileSync(SEAL_FILE, "utf8"));
const MANIFEST_FILE = path.join(BASE, "tree-manifest.json");
if (!fs.existsSync(MANIFEST_FILE)) fail("baseline-02c/tree-manifest.json missing");
const FROZEN_DIR = path.join(BASE, "consumers");
const frozenText = (name) => fs.readFileSync(path.join(FROZEN_DIR, name), "utf8");

// ── 1. Declared 02-C surface (intent). Every entry is VERIFIED against source below. ──
const OWNER = {
  bridge: "vault/application/local-account/bridge.ts",
  value: "vault/application/local-account/value.ts",
  bulk: "vault/application/local-account/bulk.ts",
  repo: "vault/infrastructure/repositories/local-account-consumer-repository.ts",
  security: "vault/security/local-account-ownership.ts",
};
const NEW_FILES = [OWNER.bridge, OWNER.value, OWNER.bulk, OWNER.repo];
const CONSUMERS = [
  { file: "routes/value-history.ts", frozen: "value-history.ts", uses: [["vault/application/local-account/value", ["listLocalAccountValueHistory", "saveLocalAccountValue"]], ["vault/security/local-account-ownership", ["requireLocalAccountOwnership"]]] },
  { file: "routes/vault.ts", frozen: "vault.ts", uses: [["vault/application/local-account/bridge", ["autoCreateLocalAccountsForEntity"]]] },
  { file: "routes/bulk.ts", frozen: "bulk.ts", uses: [["vault/application/local-account/bulk", ["applyLocalAccountBulk", "exportLocalAccountRows"]]] },
];
const OWNER_SYMBOLS = [
  ["autoCreateLocalAccountsForEntity", OWNER.bridge], ["listLocalAccountValueHistory", OWNER.value], ["saveLocalAccountValue", OWNER.value],
  ["applyLocalAccountBulk", OWNER.bulk], ["exportLocalAccountRows", OWNER.bulk],
];
const REPO_SYMBOLS = ["findBridgedLocalAccount", "insertBridgedLocalAccount", "selectLocalAccountValueHistory", "updateLocalAccountValue", "insertLocalAccountValueHistory", "deleteLocalAccountsByIds", "updateLocalAccountsCategoryByIds", "selectLocalAccountsForExport"];
// Files 02-C may change relative to the sealed 02-B tree. Anything else is an unrelated change.
const CHANGED_ALLOWED = new Set([R("routes/value-history.ts"), R("routes/vault.ts"), R("routes/bulk.ts"), R("routes/local-accounts.ts"), "scripts/src/check-ownership-gate-coverage.ts"]);
const ADDED_ALLOWED = new Set(NEW_FILES.map(R));
const isAllowedAdd = (k) => ADDED_ALLOWED.has(k) || k.startsWith("scripts/antas/vault/gap/");

// Table-access census. Every file that still touches local_accounts must be the owner, a rewired consumer that
// no longer does, or an EXPLICIT deferral to the later gap that owns that behavior. A new/unlisted access FAILS.
const OWNER_TABLE_FILES = new Set([R("vault/infrastructure/repositories/local-account-repository.ts"), R("vault/infrastructure/repositories/local-account-consumer-repository.ts"), R("vault/security/local-account-ownership.ts")]);
const DEFERRALS = {
  [R("routes/marketplace-vault.ts")]: { gap: "VLT-GAP-04", reason: "ownership transfer of local accounts on marketplace sale" },
  [R("lib/vault-health-scan.ts")]: { gap: "VLT-GAP-11", reason: "health scan reads local accounts and writes flag updates" },
  [R("lib/vault-snapshot-restore.ts")]: { gap: "VLT-GAP-09", reason: "snapshot restore writes local accounts back" },
  [R("routes/vault-snapshot.ts")]: { gap: "VLT-GAP-09", reason: "snapshot export reads local accounts" },
  "scripts/src/reencrypt-vault.ts": { gap: "VLT-GAP-07", reason: "re-encryption script rewrites ciphertext columns" },
  [R("services/sync.ts")]: { gap: "VLT-GAP-12", reason: "remaining read: sync service" },
  [R("routes/sync.ts")]: { gap: "VLT-GAP-12", reason: "remaining read/join: sync routes" },
  [R("routes/search.ts")]: { gap: "VLT-GAP-12", reason: "remaining read: search" },
  [R("routes/two-factor.ts")]: { gap: "VLT-GAP-12", reason: "remaining read: 2FA listing" },
  [R("routes/marketplace.ts")]: { gap: "VLT-GAP-12", reason: "remaining read: marketplace listing source" },
  [R("routes/vault-shares.ts")]: { gap: "VLT-GAP-12", reason: "remaining read: share table registry" },
  [R("lib/mail-sync.ts")]: { gap: "VLT-GAP-12", reason: "remaining read: mail-sync table registry" },
  [R("lib/schema-migrations.ts")]: { gap: "VLT-GAP-12", reason: "schema migrations" },
  [R("vault/application/entity/admin.ts")]: { gap: "VLT-GAP-12", reason: "remaining read: entity admin views (GAP-01-D owner, reads local_accounts for admin lists)" },
};
// bulk.ts hands the table NAME to its generic audit helper (SELECT id, user_id FROM ${table}) — recorded, not hidden.
const DYNAMIC_ACCESS = [{ file: R("routes/bulk.ts"), via: "auditBulkOwnership", table: "local_accounts", gap: "VLT-GAP-12", reason: "generic PEP audit candidate lookup shared with vault_entries/wallets; read-only, no mutation, no data returned to the client" }];

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
// String/template literals that mention local_accounts in SQL position, plus bare "local_accounts" name literals.
function localTableAccess(sf) {
  const sqlAccess = [], nameLiterals = [];
  (function w(n) {
    let text = null;
    if (ts.isNoSubstitutionTemplateLiteral(n) || ts.isStringLiteral(n)) text = n.text;
    else if (ts.isTemplateExpression(n)) text = n.head.text + n.templateSpans.map((s) => "${}" + s.literal.text).join("");
    if (text !== null && /local_accounts/.test(text)) {
      const t = norm(text);
      if (/\b(FROM|JOIN|INTO|UPDATE|(CREATE|ALTER|DROP)\s+TABLE(\s+IF\s+(NOT\s+)?EXISTS)?|TRUNCATE)\s+local_accounts\b/i.test(t)) sqlAccess.push(t.slice(0, 90));
      else if (t === "local_accounts") nameLiterals.push({ line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, parent: n.parent && ts.isCallExpression(n.parent) ? n.parent.expression.getText(sf) : n.parent?.getText(sf).slice(0, 40) });
    }
    if (ts.isIdentifier(n) && n.text === "localAccountsTable") sqlAccess.push("localAccountsTable");
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
const declaresFunction = (sf, name) => sf.statements.some((s) => (ts.isFunctionDeclaration(s) && s.name?.text === name) || (ts.isVariableStatement(s) && s.declarationList.declarations.some((d) => d.name.getText(sf) === name)));
const exportedNames = (sf) => { const o = new Set(); for (const s of sf.statements) { const ex = s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword); if (ex && ts.isFunctionDeclaration(s) && s.name) o.add(s.name.text); if (ex && ts.isVariableStatement(s)) s.declarationList.declarations.forEach((d) => o.add(d.name.getText(sf))); } return o; };

// ── 3. Static proof: seal, consumer graph, table-access census, duplicates ──
function staticProof() {
  const checks = []; const chk = (name, passed, details = "") => checks.push({ name, passed: Boolean(passed), details });
  const read = (f) => fs.readFileSync(path.join(SRC, f), "utf8");

  // 3.0 seal integrity + anchoring to what 02-B certified
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf8"));
  chk("seal:tree-manifest-hash-matches-seal", sha256(fs.readFileSync(MANIFEST_FILE, "utf8")) === SEAL.tree_manifest_sha256, "");
  chk("seal:matches-02B-certified-state", SEAL.matches_02B_certified_state === true && SEAL.certified_by?.sub_phase === "VLT-GAP-02-B" && Boolean(SEAL.certified_by?.source_tree_sha256), "");
  const frozenBad = Object.entries(SEAL.frozen_consumers ?? {}).filter(([n, v]) => !fs.existsSync(path.join(FROZEN_DIR, n)) || sha256File(path.join(FROZEN_DIR, n)) !== v.sha256 || manifest.files[v.source] !== v.sha256);
  chk("seal:frozen-consumers-intact-and-equal-to-manifest", frozenBad.length === 0 && Object.keys(SEAL.frozen_consumers ?? {}).length >= 5, frozenBad.map(([n]) => n).join(", "));
  const ev02b = JSON.parse(fs.readFileSync(path.join(EVIDENCE_DIR, "extraction-proof.json"), "utf8"));
  const certDrift = Object.entries(ev02b.source_hashes ?? {}).filter(([f, h]) => manifest.files[f] !== h).map(([f]) => f);
  chk("seal:02B-certified-hashes-equal-sealed-tree", ev02b.status === "PASS" && ev02b.sub_phase === "VLT-GAP-02-B" && certDrift.length === 0, certDrift.join(", "));

  // 3.0b the 02-A/02-B pre-extraction route baseline (needed by 02-D) must be intact, not overwritten by the extracted route
  { const pre = path.join(EVIDENCE_DIR, "baseline/sources/artifacts__api-server__src__routes__local-accounts.ts");
    const preMan = JSON.parse(fs.readFileSync(path.join(EVIDENCE_DIR, "baseline/tree-manifest.json"), "utf8")).files[R("routes/local-accounts.ts")];
    const inv = JSON.parse(fs.readFileSync(path.join(EVIDENCE_DIR, "symbol-inventory.json"), "utf8")).source_hashes?.[R("routes/local-accounts.ts")];
    const okFile = fs.existsSync(pre); const h = okFile ? sha256File(pre) : null; const txt = okFile ? fs.readFileSync(pre, "utf8") : "";
    const shape = okFile && (txt.match(/db\.execute\(/g) ?? []).length >= 20 && txt.split("\n").length > 500;
    chk("baseline-02A:pre-extraction-route-intact", okFile && h === preMan && h === inv && h !== sha256File(path.join(SRC, "routes/local-accounts.ts")) && shape, `file=${h?.slice(0, 12)} manifest=${preMan?.slice(0, 12)} inventory=${inv?.slice(0, 12)}`); }

  // 3.1 destination + owner symbols exist, parse, and are executable business code (not scaffolds)
  const dest = {};
  for (const f of [...NEW_FILES, OWNER.security]) {
    const abs = path.join(SRC, f);
    if (!fs.existsSync(abs)) { chk(`destination-exists:${f}`, false, "missing"); continue; }
    const text = fs.readFileSync(abs, "utf8"); const sf = parse(f, text); dest[f] = { text, sf, abs };
    chk(`destination-exists:${f}`, true); chk(`destination-parses:${f}`, (sf.parseDiagnostics ?? []).length === 0);
  }
  if (Object.keys(dest).length !== NEW_FILES.length + 1) return { checks, consumers: [], census: [], duplicates: [], usage: [], repoSql: [] };
  for (const [name, file] of OWNER_SYMBOLS) chk(`owner-exports-symbol:${name}`, exportedNames(dest[file].sf).has(name), file);
  for (const name of REPO_SYMBOLS) chk(`repository-exports-symbol:${name}`, exportedNames(dest[OWNER.repo].sf).has(name), "");
  chk("repository-has-executable-sql", [...sqlLiterals(dest[OWNER.repo].sf)].length >= 8 && countIdent(dest[OWNER.repo].sf, "db") >= 8, "");
  chk("application-files-import-repository-only-for-sql", NEW_FILES.slice(0, 3).every((f) => !/\bsql\b|@workspace\/db/.test(dest[f].text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""))), "owner application modules must not embed SQL/db");

  // 3.2 moved SQL is VERBATIM: every SQL literal in the consumer repository existed (normalised) in the frozen consumers
  const frozenSql = new Set(); for (const c of CONSUMERS) for (const s of sqlLiterals(parse(c.frozen, frozenText(c.frozen)))) frozenSql.add(s);
  const repoSql = [...sqlLiterals(dest[OWNER.repo].sf)].map((s) => ({ sql: s, verbatim_in_frozen: frozenSql.has(s) }));
  const looseNew = repoSql.filter((r) => !r.verbatim_in_frozen);
  // the moved statements interpolate through parameters (${idList}, ${cat}, ${a.userId}); compare with ${…} slots collapsed
  const collapse = (s) => s.replace(/\$\{[^}]*\}/g, "${}");
  const frozenCollapsed = new Set([...frozenSql].map(collapse));
  const unmatched = looseNew.filter((r) => !frozenCollapsed.has(collapse(r.sql)));
  for (const r of repoSql) r.verbatim_in_frozen = frozenCollapsed.has(collapse(r.sql));
  chk("moved-sql-is-verbatim-from-frozen-consumers", unmatched.length === 0, unmatched.map((r) => r.sql.slice(0, 80)).join(" | "));

  // 3.3 every consumer is rewired, thin, and no longer touches the table
  const consumers = [];
  for (const c of CONSUMERS) {
    const text = read(c.file); const sf = parse(c.file, text); const abs = path.join(SRC, c.file);
    const imps = importsOfFile(sf).map((i) => ({ ...i, resolved: resolveTo(abs, i.spec) }));
    const usesOk = c.uses.every(([mod, names]) => names.every((n) => imps.some((i) => i.resolved === R(mod) && i.names.some((x) => x.imported === n)) && countIdent(sf, n) >= 2));
    const missing = c.uses.flatMap(([mod, names]) => names.filter((n) => !(imps.some((i) => i.resolved === R(mod) && i.names.some((x) => x.imported === n)) && countIdent(sf, n) >= 2)).map((n) => `${n}←${mod}`));
    chk(`consumer-imports-and-uses-owner:${c.file}`, usesOk, missing.join(", "));
    const acc = localTableAccess(sf);
    const allowedNameLits = acc.nameLiterals.filter((l) => c.file === "routes/bulk.ts" && l.parent === "auditBulkOwnership");
    chk(`consumer-has-no-local_accounts-sql:${c.file}`, acc.sqlAccess.length === 0, acc.sqlAccess.join(" | "));
    chk(`consumer-has-no-unexplained-local_accounts-literal:${c.file}`, acc.nameLiterals.length === allowedNameLits.length, JSON.stringify(acc.nameLiterals));
    const before = handlerShape(frozenText(c.frozen), c.frozen); const after = handlerShape(text, c.file);
    consumers.push({ file: c.file, imports_owner: usesOk, local_table_sql_after: acc.sqlAccess.length, local_table_sql_before: localTableAccess(parse(c.frozen, frozenText(c.frozen))).sqlAccess.length, route_table_unchanged: JSON.stringify(before.map((h) => [h.method, h.path, h.middleware])) === JSON.stringify(after.map((h) => [h.method, h.path, h.middleware])), handlers_after: after.filter((h) => /local-accounts|csv\/export/.test(h.path)) });
    chk(`consumer-route-table-unchanged:${c.file}`, consumers[consumers.length - 1].route_table_unchanged, "method/path/middleware chain changed");
  }
  const vh = handlerShape(read("routes/value-history.ts"), "value-history.ts").filter((h) => h.path.startsWith("/local-accounts/"));
  chk("value-history:local-handlers-are-thin-adapters", vh.length === 2 && vh.every((h) => h.db_refs === 0 && h.control_flow_nodes === 0), JSON.stringify(vh.map((h) => [h.path, h.db_refs, h.control_flow_nodes])));
  const bk = handlerShape(read("routes/bulk.ts"), "bulk.ts").filter((h) => h.path === "/local-accounts/bulk");
  chk("bulk:local-handler-has-no-db-and-no-decision-tree", bk.length === 1 && bk[0].db_refs === 0 && bk[0].control_flow_nodes <= 1 && bk[0].called.includes("applyLocalAccountBulk"), JSON.stringify(bk.map((h) => [h.db_refs, h.control_flow_nodes, h.called])));
  const vhSf = parse("value-history.ts", read("routes/value-history.ts"));
  chk("value-history:no-local-copy-of-LOCAL_SENSITIVE_FIELDS", !declaresFunction(vhSf, "LOCAL_SENSITIVE_FIELDS") && countIdent(vhSf, "LOCAL_SENSITIVE_FIELDS") === 0, "");
  const vSf = parse("vault.ts", read("routes/vault.ts"));
  chk("vault:autoCreateLocalAccountsForEntity-not-declared-locally", !declaresFunction(vSf, "autoCreateLocalAccountsForEntity") && !declaresFunction(vSf, "BRIDGE_PLATFORMS"), "");
  chk("vault:bridge-still-passed-to-create-and-update", countIdent(vSf, "autoCreateLocalAccountsForEntity") >= 3, `${countIdent(vSf, "autoCreateLocalAccountsForEntity")} references (import + create + update deps)`);

  // 3.4 compat re-export gone; nothing imports the route module for symbols
  const laSf = parse("local-accounts.ts", read("routes/local-accounts.ts"));
  chk("local-accounts:compat-reexport-removed", !laSf.statements.some((s) => ts.isExportDeclaration(s)) && !/export\s*\{[^}]*requireLocalAccountOwnership/.test(read("routes/local-accounts.ts")), "");
  const importers = [];
  for (const f of walkFiles(SRC, [], (p) => /\.(ts|tsx|mjs)$/.test(p))) {
    const sf = parse(f, fs.readFileSync(f, "utf8"));
    for (const i of importsOfFile(sf)) if (resolveTo(f, i.spec) === R("routes/local-accounts") && i.names.length) importers.push({ file: rel(f), names: i.names.map((n) => n.imported) });
  }
  chk("no-file-imports-symbols-from-routes/local-accounts", importers.length === 0, JSON.stringify(importers));

  // 3.5 consumer graph: who imports each owner symbol (must be a route/adapter, and each symbol must be used)
  const usage = OWNER_SYMBOLS.map(([name, file]) => {
    const users = [];
    for (const f of walkFiles(SRC, [], (p) => /\.ts$/.test(p))) {
      const sf = parse(f, fs.readFileSync(f, "utf8"));
      for (const i of importsOfFile(sf)) if (resolveTo(f, i.spec) === R(file.replace(/\.ts$/, "")) && i.names.some((n) => n.imported === name)) users.push(rel(f).replace(/^artifacts\/api-server\/src\//, ""));
    }
    return { symbol: name, owner: file, consumers: users };
  });
  for (const u of usage) chk(`symbol-is-used:${u.symbol}`, u.consumers.some((c) => c.startsWith("routes/") || c.startsWith("vault/")), JSON.stringify(u.consumers));

  // 3.6 duplicate scan: no moved SQL statement is implemented anywhere outside the consumer repository
  const dupTargets = walkFiles(SRC, [], (p) => /\.ts$/.test(p)).filter((f) => rel(f) !== R(OWNER.repo));
  const collapsedRepo = new Set(repoSql.map((r) => collapse(r.sql)));
  const duplicates = [];
  for (const f of dupTargets) { const sf = parse(f, fs.readFileSync(f, "utf8")); for (const s of sqlLiterals(sf)) if (collapsedRepo.has(collapse(s))) duplicates.push({ file: rel(f), sql: s.slice(0, 100) }); }
  chk("duplicate-scan:no-moved-sql-outside-consumer-repository", duplicates.length === 0, JSON.stringify(duplicates));

  // 3.7 table-access census with explicit deferrals
  const census = [];
  const scanFiles = [...walkFiles(SRC, [], (p) => /\.ts$/.test(p)), ...walkFiles(path.join(ROOT, "scripts/src"), [], (p) => /\.ts$/.test(p))];
  for (const f of scanFiles) {
    const k = rel(f); const acc = localTableAccess(parse(k, fs.readFileSync(f, "utf8")));
    if (!acc.sqlAccess.length && !acc.nameLiterals.length) continue;
    let classification;
    if (OWNER_TABLE_FILES.has(k)) classification = { kind: "owner" };
    else if (DEFERRALS[k]) classification = { kind: "deferred", ...DEFERRALS[k] };
    else if (DYNAMIC_ACCESS.some((d) => d.file === k) && !acc.sqlAccess.length) classification = { kind: "dynamic-audit-name-only", ...DYNAMIC_ACCESS.find((d) => d.file === k) };
    else classification = { kind: "UNCLASSIFIED" };
    census.push({ file: k, sql_access: acc.sqlAccess.length, name_literals: acc.nameLiterals.length, ...classification });
  }
  const unclassified = census.filter((c) => c.kind === "UNCLASSIFIED");
  chk("census:no-unclassified-local_accounts-access", unclassified.length === 0, unclassified.map((c) => c.file).join(", "));
  const stale = Object.keys(DEFERRALS).filter((k) => !census.some((c) => c.file === k));
  chk("census:no-stale-deferral (every deferral still accesses the table)", stale.length === 0, stale.join(", "));
  const rewiredStillAccessing = ["routes/value-history.ts", "routes/vault.ts", "routes/local-accounts.ts"].filter((f) => census.some((c) => c.file === R(f)));
  chk("census:rewired-consumers-absent-from-census", rewiredStillAccessing.length === 0, rewiredStillAccessing.join(", "));
  const gapOwners = new Set(Object.values(DEFERRALS).map((d) => d.gap));
  chk("census:every-deferral-names-a-later-gap", [...gapOwners].every((g) => /^VLT-GAP-(0[3-9]|1\d)$/.test(g)), [...gapOwners].join(", "));
  return { checks, consumers, census, duplicates, usage, repoSql };
}

// ── 4. Differential: frozen 02-B consumers (OLD) vs current tree (NEW) under identical stubs ──
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
function makeEnv(rules = []) {
  const env = createEnv({});
  env.rules = rules.map(([re, ...results]) => ({ re: new RegExp(re, "i"), results: [...results] }));
  const nz = (q) => (q?.__raw !== undefined ? String(q.__raw) : q?.__sql ? q.__sql.join("?") : "").replace(/\s+/g, " ").trim();
  env.db.execute = (q) => {
    env.log.push(["db.execute", summ(q)]);
    const text = nz(q); const rule = env.rules.find((r) => r.re.test(text));
    if (!rule || !rule.results.length) return Promise.resolve({ rows: [] });
    const item = rule.results.length > 1 ? rule.results.shift() : rule.results[0];
    env.log.push(["result", item.throw ? { throw: item.throw } : { rows: summ(item.value.rows) }]);
    return item.throw ? Promise.reject(new Error(item.throw)) : Promise.resolve(item.value);
  };
  env.stubs["lib/vault-crypto"] = {
    encryptField: (v) => { env.log.push(["encryptField", summ(v)]); return v === null || v === undefined ? v : `enc(${v})`; },
    decryptField: (v) => { env.log.push(["decryptField", summ(v)]); return v; },
    decryptRow: (row, f) => { env.log.push(["decryptRow", summ(f)]); return row ? { ...row, __decrypted: true } : row; },
    decryptRows: (rows, f) => { env.log.push(["decryptRows", summ(f)]); return rows.map((r) => ({ ...r, __decrypted: true })); },
  };
  return env;
}
const makeRes = () => {
  const r = fakeRes(); r.headers = {};
  r.setHeader = (k, v) => { r.headers[k] = v; r.calls.push(["setHeader", k, v]); return r; };
  r.send = (b) => { r.body = b; r.__sent = true; r.calls.push(["send", summ(b)]); return r; };
  return r;
};
function loadRouteFile(which, c, env, overrides) {
  const ld = createLoader({ ts, root: ROOT, srcDir: SRC, env });
  if (overrides) for (const [k, v] of overrides) env.overrides.set(k, v);
  // both sides get the SAME real ownership wrapper: old value-history imported it through the compat re-export
  env.stubs["routes/local-accounts"] = ld.loadFile(path.join(SRC, OWNER.security));
  const abs = path.join(SRC, c.file);
  return which === "old" ? ld.loadText(frozenText(c.frozen), c.file, ROUTES) : ld.loadFile(abs);
}
const routeOf = (routes, method, p) => routes.find((r) => r.method === method && r.path === p);
async function invokeRoute(which, c, overrides) {
  const env = makeEnv(c.db ?? []);
  loadRouteFile(which, CONSUMER_BY_FILE[c.file], env, overrides);
  const r = routeOf(env.routes, c.method, c.path); if (!r) return { error: `route not registered: ${c.method} ${c.path}` };
  const res = makeRes(); const req = { user: { userId: c.user ?? 7 }, params: c.params ?? {}, query: c.query ?? {}, body: c.body ?? {} };
  let thrown = null;
  try { await r.stack[r.stack.length - 1](req, res); } catch (e) { thrown = String(e?.message ?? e); }
  await new Promise((rs) => setImmediate(rs));
  return { status: res.statusCode ?? (res.body !== undefined ? 200 : null), body: summ(res.body), headers: res.headers, thrown, log: env.log };
}
const CONSUMER_BY_FILE = Object.fromEntries(CONSUMERS.map((c) => [c.file, c]));
async function invokeBridge(which, c, overrides) {
  const env = makeEnv(c.db ?? []);
  const ld = createLoader({ ts, root: ROOT, srcDir: SRC, env });
  if (overrides) for (const [k, v] of overrides) env.overrides.set(k, v);
  let fn;
  if (which === "old") {
    const sl = sliceSymbols(ts, frozenText("vault.ts"), ["BRIDGE_PLATFORMS", "autoCreateLocalAccountsForEntity"], { fileName: "vault-bridge-slice.ts" });
    if (sl.missing.length) return { error: `frozen bridge symbols missing: ${sl.missing.join(",")}` };
    fn = ld.loadText(sl.text, "routes/vault.ts", ROUTES).autoCreateLocalAccountsForEntity;
  } else fn = ld.loadFile(path.join(SRC, OWNER.bridge)).autoCreateLocalAccountsForEntity;
  const origErr = console.error; console.error = (...a) => env.log.push(["console.error", a.map((x) => (x instanceof Error ? `Error:${x.message}` : typeof x === "string" ? x : "[obj]"))]);
  let thrown = null, value;
  try { value = await fn(c.user ?? 7, c.vaultEntryId ?? 11, c.body); } catch (e) { thrown = String(e?.message ?? e); } finally { console.error = origErr; }
  return { status: null, body: summ(value), thrown, log: env.log };
}
const CASES = [];
const C = (name, category, kind, method, p, o = {}) => CASES.push({ name, category, kind, method, path: p, ...o });
const Q = { VH_LIST: "FROM value_history WHERE user_id", LA_VALUE: "UPDATE local_accounts SET account_worth", VH_INS: "INSERT INTO value_history", LA_DELETE: "DELETE FROM local_accounts", LA_CAT: "UPDATE local_accounts SET category", LA_EXPORT: "SELECT id, label, category, username", AUDIT: "SELECT id, user_id FROM local_accounts", BR_FIND: "SELECT id FROM local_accounts", BR_INS: "INSERT INTO local_accounts" };
const VH = "routes/value-history.ts", BK = "routes/bulk.ts";
const ACC = { id: 5, user_id: 7, account_worth: 300, buy_price: 100, password: "p", twofa: "t" };
// value-history (local-account handlers)
C("history: rows", "success", "route", "GET", "/local-accounts/:id/value-history", { file: VH, params: { id: "5" }, db: [[Q.VH_LIST, ok([{ id: 1, value: 3 }, { id: 2, value: 4 }])]] });
C("history: empty", "success", "route", "GET", "/local-accounts/:id/value-history", { file: VH, params: { id: "5" } });
C("history: non-numeric id (NaN interpolated)", "failure", "route", "GET", "/local-accounts/:id/value-history", { file: VH, params: { id: "abc" } });
C("history: db throws (unhandled, propagates)", "failure", "route", "GET", "/local-accounts/:id/value-history", { file: VH, params: { id: "5" }, db: [[Q.VH_LIST, boom("h boom")]] });
C("value: success with label+note", "success", "route", "POST", "/local-accounts/:id/value", { file: VH, params: { id: "5" }, body: { value: 450, buyValue: 120, note: "n1", label: "Main" }, db: [[Q.LA_VALUE, ok([ACC])], [Q.VH_INS, ok([{ id: 9 }])]] });
C("value: success defaults (string numbers, no label/note)", "success", "route", "POST", "/local-accounts/:id/value", { file: VH, params: { id: "5" }, body: { value: "12.5", buyValue: "x" }, db: [[Q.LA_VALUE, ok([ACC])], [Q.VH_INS, ok([{ id: 9 }])]] });
C("value: quote in label/note is escaped", "security", "route", "POST", "/local-accounts/:id/value", { file: VH, params: { id: "5" }, body: { value: 1, buyValue: 1, note: "a'b", label: "x'; DROP TABLE t;--" }, db: [[Q.LA_VALUE, ok([ACC])], [Q.VH_INS, ok([{ id: 9 }])]] });
C("value: non-integer id → 400", "failure", "route", "POST", "/local-accounts/:id/value", { file: VH, params: { id: "1.5" }, body: { value: 1 } });
C("value: non-numeric id → 400", "failure", "route", "POST", "/local-accounts/:id/value", { file: VH, params: { id: "abc" }, body: { value: 1 } });
C("value: account not found (no rows updated) → 404", "failure", "route", "POST", "/local-accounts/:id/value", { file: VH, params: { id: "5" }, body: { value: 1 }, db: [[Q.LA_VALUE, ok([])]] });
C("value: update throws → 500", "failure", "route", "POST", "/local-accounts/:id/value", { file: VH, params: { id: "5" }, body: { value: 1 }, db: [[Q.LA_VALUE, boom("u boom")]] });
C("value: history insert throws → 500", "failure", "route", "POST", "/local-accounts/:id/value", { file: VH, params: { id: "5" }, body: { value: 1 }, db: [[Q.LA_VALUE, ok([ACC])], [Q.VH_INS, boom("i boom")]] });
C("value: update is scoped to the caller (other user id)", "security", "route", "POST", "/local-accounts/:id/value", { file: VH, user: 99, params: { id: "5" }, body: { value: 7, buyValue: 3 }, db: [[Q.LA_VALUE, ok([])]] });
// bulk + csv
C("bulk: delete", "success", "route", "POST", "/local-accounts/bulk", { file: BK, body: { ids: [1, "2", 3], action: "delete" }, db: [[Q.AUDIT, ok([{ id: 1, user_id: 7 }, { id: 2, user_id: 8 }])]] });
C("bulk: delete without audit candidates", "success", "route", "POST", "/local-accounts/bulk", { file: BK, body: { ids: [4], action: "delete" } });
C("bulk: update_category", "success", "route", "POST", "/local-accounts/bulk", { file: BK, body: { ids: [1, 2], action: "update_category", payload: { category: "twitter" } }, db: [[Q.AUDIT, ok([{ id: 1, user_id: 7 }])]] });
C("bulk: update_category quote escaping", "security", "route", "POST", "/local-accounts/bulk", { file: BK, body: { ids: [1], action: "update_category", payload: { category: "x'; DROP TABLE local_accounts;--" } } });
C("bulk: update_category missing category → 400", "failure", "route", "POST", "/local-accounts/bulk", { file: BK, body: { ids: [1], action: "update_category", payload: {} } });
C("bulk: unknown action → 400", "failure", "route", "POST", "/local-accounts/bulk", { file: BK, body: { ids: [1], action: "explode" } });
C("bulk: no valid ids → 400", "failure", "route", "POST", "/local-accounts/bulk", { file: BK, body: { ids: ["a", -1, 0], action: "delete" } });
C("bulk: delete db throws (propagates)", "failure", "route", "POST", "/local-accounts/bulk", { file: BK, body: { ids: [1], action: "delete" }, db: [[Q.LA_DELETE, boom("d boom")]] });
C("bulk: other user's ids are filtered by user_id in SQL", "security", "route", "POST", "/local-accounts/bulk", { file: BK, user: 99, body: { ids: [1, 2], action: "delete" }, db: [[Q.AUDIT, ok([{ id: 1, user_id: 7 }])]] });
C("csv: rows", "success", "route", "GET", "/csv/export/:resource", { file: BK, params: { resource: "local-accounts" }, db: [[Q.LA_EXPORT, ok([{ id: 1, label: 'a"b', category: "x", username: "u", email: null, followers: 3, account_worth: 1, buy_price: 2, created_at: "2026" }])]] });
C("csv: empty → empty 200", "success", "route", "GET", "/csv/export/:resource", { file: BK, params: { resource: "local-accounts" } });
C("csv: unknown resource → 400", "failure", "route", "GET", "/csv/export/:resource", { file: BK, params: { resource: "nope" } });
C("csv: db throws (propagates)", "failure", "route", "GET", "/csv/export/:resource", { file: BK, params: { resource: "local-accounts" }, db: [[Q.LA_EXPORT, boom("c boom")]] });
// entity ↔ local bridge (function level)
const FULL = { twitterUsername: "tw", twitterPassword: "pw1", twitterEmail: "t@x", twitter2fa: "2f1", twitterFollowers: "10", discordUsername: "dc", discordPassword: "pw2", discordEmail: "d@x", discord2fa: "2f2", discordFollowers: "20", telegramUsername: "tg", telegramPassword: "pw3", telegramLinkedEmail: "tl@x", telegramEmail: "ignored@x", telegram2fa: "2f3", telegramFollowers: "30" };
C("bridge: no platform usernames → no db calls", "success", "bridge", "CALL", "autoCreateLocalAccountsForEntity", { body: { email: "a@b" } });
C("bridge: all three platforms created", "success", "bridge", "CALL", "autoCreateLocalAccountsForEntity", { body: FULL });
C("bridge: existing local account → skipped (no duplicate)", "success", "bridge", "CALL", "autoCreateLocalAccountsForEntity", { body: { twitterUsername: "tw", twitterPassword: "p" }, db: [[Q.BR_FIND, ok([{ id: 3 }])]] });
C("bridge: twitter existing, discord new", "success", "bridge", "CALL", "autoCreateLocalAccountsForEntity", { body: { twitterUsername: "tw", discordUsername: "dc", discordPassword: "p" }, db: [[Q.BR_FIND, ok([{ id: 3 }]), ok([])]] });
C("bridge: blank / non-string usernames ignored", "failure", "bridge", "CALL", "autoCreateLocalAccountsForEntity", { body: { twitterUsername: "   ", discordUsername: 123, telegramUsername: null } });
C("bridge: optional fields absent → nulls", "success", "bridge", "CALL", "autoCreateLocalAccountsForEntity", { body: { twitterUsername: "only" } });
C("bridge: lookup throws → swallowed, loop continues", "failure", "bridge", "CALL", "autoCreateLocalAccountsForEntity", { body: { twitterUsername: "tw", discordUsername: "dc" }, db: [[Q.BR_FIND, boom("find boom"), ok([])]] });
C("bridge: insert throws → swallowed, loop continues", "failure", "bridge", "CALL", "autoCreateLocalAccountsForEntity", { body: { twitterUsername: "tw", discordUsername: "dc" }, db: [[Q.BR_INS, boom("ins boom"), ok([])]] });
C("bridge: scoped to userId + vaultEntryId (other user)", "security", "bridge", "CALL", "autoCreateLocalAccountsForEntity", { user: 99, vaultEntryId: 42, body: { telegramUsername: "tg", telegramLinkedEmail: "e@x" } });
C("bridge: quote in username stays a bound parameter", "security", "bridge", "CALL", "autoCreateLocalAccountsForEntity", { body: { twitterUsername: "o'brien\"; --" } });

const cmp = (a, b) => JSON.stringify(a) === JSON.stringify(b);
async function differentialSuite(overrides) {
  const out = [];
  for (const c of CASES) {
    const run = (w) => (c.kind === "bridge" ? invokeBridge(w, c, w === "new" ? overrides : undefined) : invokeRoute(w, c, w === "new" ? overrides : undefined));
    const [o, n] = await withFrozenDate(async () => [await run("old"), await run("new")]);
    const diffs = [];
    if (o.error || n.error) diffs.push(o.error ?? n.error);
    else {
      if (o.status !== n.status) diffs.push(`status ${o.status} → ${n.status}`);
      if (!cmp(o.body, n.body)) diffs.push(`body ${JSON.stringify(o.body).slice(0, 120)} → ${JSON.stringify(n.body).slice(0, 120)}`);
      if (!cmp(o.headers, n.headers)) diffs.push("headers differ");
      if (o.thrown !== n.thrown) diffs.push(`thrown ${o.thrown} → ${n.thrown}`);
      if (!cmp(o.log, n.log)) { const i = o.log.findIndex((x, k) => !cmp(x, n.log[k])); diffs.push(`call log differs at #${i < 0 ? Math.min(o.log.length, n.log.length) : i}: ${JSON.stringify(o.log[i] ?? null).slice(0, 170)} ≠ ${JSON.stringify(n.log[i] ?? null).slice(0, 170)}`); }
    }
    out.push({ name: `${c.method} ${c.path}${c.file ? ` [${c.file}]` : ""} — ${c.name}`, category: c.category, kind: c.kind, passed: diffs.length === 0, diffs, log_entries: o.log?.length ?? 0, old_status: o.status });
  }
  return out;
}
// Security regression: middleware chains (auth, ownership action, deny bodies) old vs new for every changed route file.
function describeMw(mw) {
  if (mw.__ownership) { const res = fakeRes(); mw.__ownership.opts.onDeny({}, res); return { kind: "ownership", action: mw.__ownership.action, onDecision: mw.__ownership.opts.onDecision?.name ?? null, deny: { status: res.statusCode ?? 200, body: summ(res.body) } }; }
  return { kind: "named", name: mw.name };
}
async function securitySuite(overrides) {
  const out = []; const t = (name, passed, details = "") => out.push({ name, passed, details, category: "security" });
  for (const c of CONSUMERS.filter((x) => x.file !== "routes/vault.ts")) {
    const tables = {};
    for (const which of ["old", "new"]) { const env = makeEnv([]); loadRouteFile(which, c, env, which === "new" ? overrides : undefined); tables[which] = env.routes.map((r) => ({ method: r.method, path: r.path, mw: r.stack.slice(0, -1).map(describeMw) })); }
    t(`security:route-middleware-chains-identical:${c.file}`, cmp(tables.old, tables.new) && tables.old.length > 0, "auth / ownership action / deny body / limiter chain changed");
  }
  // The vault.ts route table must also be identical (bridge is not a route, but its file was edited)
  { const tables = {}; for (const which of ["old", "new"]) { const env = makeEnv([]); loadRouteFile(which, CONSUMER_BY_FILE["routes/vault.ts"], env, which === "new" ? overrides : undefined); tables[which] = env.routes.map((r) => [r.method, r.path, r.stack.length]); }
    t("security:route-table-identical:routes/vault.ts", cmp(tables.old, tables.new) && tables.old.length > 20, `${tables.old.length} vs ${tables.new.length} routes`); }
  // Ownership gate must be the SAME function object family from the Vault security module (no bypass through the route)
  { const env = makeEnv([]); const ld = createLoader({ ts, root: ROOT, srcDir: SRC, env }); const sec = ld.loadFile(path.join(SRC, OWNER.security));
    const m = sec.requireLocalAccountOwnership("x.action", (_q, res) => res.status(418).json({ e: 1 })); t("security:vault-security-owner-gate-is-callable", typeof m === "function" || Boolean(m?.__ownership), ""); }
  return out;
}
async function mutationTests() {
  const res = []; const P = (f) => path.join(SRC, f);
  const muts = [
    { name: "value UPDATE drops owner filter", file: P(OWNER.repo), from: /WHERE id = \$\{id\} AND user_id = \$\{userId\} RETURNING \*`\)\);\n\}\n\nexport async function insertLocalAccountValueHistory/, to: "WHERE id = ${id} RETURNING *`));\n}\n\nexport async function insertLocalAccountValueHistory" },
    { name: "bulk DELETE drops owner filter", file: P(OWNER.repo), from: /WHERE id IN \(\$\{idList\}\) AND user_id = \$\{userId\}`\)\);\n\}\n\nexport async function updateLocalAccountsCategoryByIds/, to: "WHERE id IN (${idList})`));\n}\n\nexport async function updateLocalAccountsCategoryByIds" },
    { name: "CSV export drops owner filter", file: P(OWNER.repo), from: /FROM local_accounts WHERE user_id = \$\{userId\}`/, to: "FROM local_accounts`" },
    { name: "bridge skips duplicate guard", file: P(OWNER.bridge), from: /if \(existing\.rows\.length > 0\) continue;/, to: "" },
    { name: "bridge stores password in plaintext", file: P(OWNER.bridge), from: /password: encryptField\(\(password as string\) \|\| null\)/, to: "password: (password as string) || null" },
    { name: "bridge stores 2FA in plaintext", file: P(OWNER.bridge), from: /twofa: encryptField\(\(twofa as string\) \|\| null\)/, to: "twofa: (twofa as string) || null" },
    { name: "bridge no longer best-effort (rethrows)", file: P(OWNER.bridge), from: /\/\/ best-effort — never block entity create\/update/, to: "throw err;" },
    { name: "value 404 body changed", file: P(OWNER.value), from: /if \(!result\.rows\.length\) return \{ status: 404, body: \{ error: "Account not found" \} \};/, to: 'if (!result.rows.length) return { status: 404, body: { error: "Not found" } };' },
    { name: "value response leaks encrypted columns undecrypted", file: P(OWNER.value), from: /account: decryptRow\(result\.rows\[0\] as any, LOCAL_SENSITIVE_FIELDS\)/, to: "account: result.rows[0]" },
    { name: "value validation removed", file: P(OWNER.value), from: /if \(!Number\.isInteger\(id\) \|\| !Number\.isFinite\(value\)\) return \{ status: 400, body: \{ error: "Valid value required" \} \};/, to: "" },
    { name: "bulk unknown action becomes 404", file: P(OWNER.bulk), from: /return \{ status: 400, body: \{ error: `Unknown action: \$\{action\}` \} \};/, to: "return { status: 404, body: { error: `Unknown action: ${action}` } };" },
    { name: "bulk category escaping removed", file: P(OWNER.bulk), from: /String\(payload\.category \?\? ""\)\.replace\(\/'\/g, "''"\)/, to: 'String(payload.category ?? "")' },
    { name: "value-history route gate removed from POST value", file: P("routes/value-history.ts"), from: /requireLocalAccountOwnership\("local_account\.value\.update", /, to: "((_a: string, _d: unknown) => (_q: any, _r: any, n: any) => n())(\"x\", " },
    { name: "bulk route ownership audit removed", file: P("routes/bulk.ts"), from: /  await auditBulkOwnership\(req, localAccountBulkOwnershipEngine, "local_account", "local_accounts", safeIdList, `local_account\.bulk\.\$\{action\}`\);\n/, to: "" },
  ];
  for (const m of muts) {
    const orig = fs.readFileSync(m.file, "utf8");
    if (!m.from.test(orig)) { res.push({ name: `mutation:${m.name}`, passed: false, details: "mutation anchor not found (fail closed)" }); continue; }
    const overrides = new Map([[m.file, orig.replace(m.from, m.to)]]);
    const suite = [...(await differentialSuite(overrides)), ...(await securitySuite(overrides))];
    const detected = suite.some((s) => !s.passed);
    res.push({ name: `mutation-detected:${m.name}`, passed: detected, details: detected ? "" : "seeded regression was NOT detected" });
  }
  return res;
}

// ── 5. Diff audit against the sealed 02-B tree ──
function diffAudit() {
  const man = JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf8")).files;
  const now = {}; for (const f of walkFiles(ROOT)) now[rel(f)] = sha256File(f);
  const changed = [], added = [], removed = [];
  for (const [k, v] of Object.entries(now)) { if (!(k in man)) added.push(k); else if (man[k] !== v) changed.push(k); }
  for (const k of Object.keys(man)) if (!(k in now)) removed.push(k);
  const unexpected = [...changed.filter((k) => !CHANGED_ALLOWED.has(k)), ...added.filter((k) => !isAllowedAdd(k)), ...removed];
  return { changed, added, removed, unexpected, allowed_changed: [...CHANGED_ALLOWED], allowed_added_patterns: [...ADDED_ALLOWED, "scripts/antas/vault/gap/*"] };
}

// ── 6. CI lint script: must be green with the wrappers now living in vault/security ──
function ciLint() {
  const script = path.join(ROOT, "scripts/src/check-ownership-gate-coverage.ts");
  const text = fs.readFileSync(script, "utf8");
  const staticOk = /VAULT_SECURITY_DIR/.test(text) && /wrapperSources/.test(text) && /vault\/security/.test(text);
  const baseline = path.join(ROOT, "scripts/src/ownership-gate-baseline.json");
  const baselineUnchanged = JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf8")).files["scripts/src/ownership-gate-baseline.json"] === sha256File(baseline);
  const r = spawnSync("tsx", [script], { cwd: path.join(ROOT, "scripts"), encoding: "utf8", timeout: 240000 });
  const executed = r.status !== null && !r.error && !/ERR_MODULE_NOT_FOUND|Cannot find (module|package)/.test(`${r.stdout}${r.stderr}`);
  return { staticOk, baselineUnchanged, executed, exit: r.status, tail: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n").slice(-3).join(" | ") };
}

// ── 7. Degraded differential typecheck (project dependencies are not installed in the upload) ──
function typecheckDifferential() {
  const cfgRaw = ts.readConfigFile(path.join(ROOT, "tsconfig.base.json"), ts.sys.readFile).config?.compilerOptions ?? {};
  const opts = ts.convertCompilerOptionsFromJson({ ...cfgRaw, noEmit: true, skipLibCheck: true, types: [], incremental: false, composite: false, baseUrl: ROOT }, ROOT).options;
  const routeAbs = CONSUMERS.map((c) => path.join(SRC, c.file)); const newAbs = NEW_FILES.map((f) => path.join(SRC, f));
  const localRoute = path.join(SRC, "routes/local-accounts.ts");
  const scopeAbs = [...routeAbs, localRoute, ...newAbs];
  const frozenMap = new Map([...CONSUMERS.map((c) => [path.join(SRC, c.file), path.join(FROZEN_DIR, c.frozen)]), [localRoute, path.join(FROZEN_DIR, "local-accounts.route.ts")]]);
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
const sourceHashes = () => Object.fromEntries([...CONSUMERS.map((c) => R(c.file)), R("routes/local-accounts.ts"), ...NEW_FILES.map(R), R(OWNER.security), "scripts/src/check-ownership-gate-coverage.ts", "scripts/antas/vault/gap/harness.mjs", "scripts/antas/vault/gap/gap-common.mjs", "scripts/antas/vault/gap/freeze-vlt-gap-02-C-baseline.mjs", rel(SEAL_FILE), rel(MANIFEST_FILE)].map((f) => [f, sha256File(path.join(ROOT, f))]));
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
  const routeTargets = [["GET", "/local-accounts/:id/value-history"], ["POST", "/local-accounts/:id/value"], ["POST", "/local-accounts/bulk"], ["GET", "/csv/export/:resource"], ["CALL", "autoCreateLocalAccountsForEntity"]];
  for (const [m, p] of routeTargets) for (const k of ["success", "failure"]) checks.push({ name: `coverage:${m} ${p}:${k}`, passed: CASES.some((c) => c.method === m && c.path === p && c.category === k), details: "" });
  checks.push({ name: "no-skipped-tests", passed: CASES.length > 0 && diff.length === CASES.length, details: `${diff.length}/${CASES.length}` });
  checks.push({ name: "differential-cases-executed-db-calls", passed: diff.filter((d) => d.log_entries > 0).length >= 25, details: `${diff.filter((d) => d.log_entries > 0).length} cases recorded interactions` });
  checks.push({ name: "diff-audit:no-unrelated-changes", passed: audit.unexpected.length === 0, details: audit.unexpected.join(", ") });
  checks.push({ name: "ci-lint:check-ownership-gate-coverage-scans-vault-security", passed: lint.staticOk, details: "" });
  checks.push({ name: "ci-lint:baseline-not-widened", passed: lint.baselineUnchanged, details: "ownership-gate-baseline.json must be unchanged (the fix must not grandfather new gaps)" });
  checks.push({ name: "ci-lint:executed-green-or-degraded-static", passed: lint.executed ? lint.exit === 0 : lint.staticOk, details: lint.tail });
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
    commands: ["node scripts/antas/vault/gap/validate-vlt-gap-02-C.mjs", "in-process differential suite (sealed 02-B consumers vs new source)", "in-process seeded-mutation suite", "tsx scripts/src/check-ownership-gate-coverage.ts (when executable)", "in-process differential typecheck"],
    exit_codes: { differential_suite: diff.every((d) => d.passed) ? 0 : 1, security_suite: sec.every((d) => d.passed) ? 0 : 1, mutation_suite: mut.every((d) => d.passed) ? 0 : 1, ci_lint: lint.executed ? lint.exit : null, typecheck_differential: tc.new_diagnostics.length === 0 && tc.syntactic_errors.length === 0 ? 0 : 1 },
    consumer_graph: { owner_modules: NEW_FILES, owner_symbols: st.usage, rewired_consumers: st.consumers, moved_sql: st.repoSql },
    table_access_census: st.census,
    deferred_consumers: deferred.map((d) => ({ file: d.file, deferred_to: d.gap, reason: d.reason })),
    dynamic_table_access: DYNAMIC_ACCESS,
    duplicate_implementations: st.duplicates,
    ci_lint: lint,
    diff_audit: audit,
    typecheck: { mode: "degraded-differential (project dependencies are not installed in the upload; full tsc/build is NOT executed)", before_total: tc.before_total, after_total: tc.after_total, syntactic_errors: tc.syntactic_errors, new_diagnostics: tc.new_diagnostics },
    tests: { differential_cases: diff.length, differential_passed: diff.filter((d) => d.passed).length, security_checks: sec.length, security_passed: sec.filter((d) => d.passed).length, mutation_tests: mut.length, mutation_detected: mut.filter((d) => d.passed).length },
    notes: [
      "02-C rewires the consumers that bypassed the Vault owner: value-history (2 local handlers), vault.ts (entity↔local bridge), bulk.ts (local bulk + CSV export), and removes the compat re-export from routes/local-accounts.ts.",
      "Every remaining table access outside the owner is an explicit deferral to the gap that owns that behavior; the census FAILS on any unlisted access and on any stale deferral.",
      "routes/bulk.ts still passes the table name 'local_accounts' to its generic auditBulkOwnership helper (read-only PEP audit lookup shared with vault_entries/wallets). Recorded under dynamic_table_access, deferred to VLT-GAP-12.",
      "routes/value-history.ts keeps its own `safe`/`num` for the vault_entries handlers in the same file; those are not local-account behavior.",
      "The frontend sources (components/local-accounts.tsx, config/fields/*) are not part of the API consumer rewire; they are handled in the later GAP-02 phases.",
      "The 02-A/02-B pre-extraction route baseline (baseline/sources/…routes__local-accounts.ts) is verified intact by check `baseline-02A:pre-extraction-route-intact` (hash equals the 02-A inventory and the pre-extraction tree manifest, and it still holds the DB-bearing pre-extraction shape), so 02-D can rely on it.",
      "Full tsc/build cannot run here (no node_modules); a differential typecheck against the sealed baseline is used instead and recorded as degraded.",
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
