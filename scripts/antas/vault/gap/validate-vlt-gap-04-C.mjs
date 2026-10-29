#!/usr/bin/env node
// VLT-GAP-04-C — Consumer Rewire (Game). Fail-closed validator.
// Evidence: reports/antas/vault/gap/VLT-GAP-04/consumer-graph.json
//
// Proves, from source and by execution, that the Game behavior still living outside the Vault owner — the game branches of
// routes/marketplace-vault.ts (seller-ownership check + preview on listing, ownership transfer inside the purchase
// transaction) — now goes through vault/{application,infrastructure}; that the moved SQL is verbatim; that behavior is
// unchanged (sealed 04-B tree vs a differential suite); that the public routes/contracts are stable; that every remaining
// game-table access outside the owner is an explicit, owned deferral; and that nothing unrelated changed.
//
// This validator NEVER writes a baseline. It only VERIFIES the write-once seal produced by freeze-vlt-gap-04-C-baseline.mjs.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, sha256, sha256File, rel, rejectBypass, binding, walkFiles } from "./gap-common.mjs";
import { loadTs, summ, createEnv, createLoader, fakeRes, sqlKeyOf } from "./harness.mjs";

const VALIDATOR_VERSION = "1.0.0";
const PHASE = "VLT-GAP-04";
const SUB_PHASE = "VLT-GAP-04-C";
const HERE = fileURLToPath(import.meta.url);
const GAP_DIR = "scripts/antas/vault/gap/";
const SRC = path.join(ROOT, "artifacts/api-server/src");
const ROUTES = path.join(SRC, "routes");
const EVIDENCE_DIR = path.join(ROOT, "reports/antas/vault/gap/VLT-GAP-04");
const EVIDENCE_FILE = path.join(EVIDENCE_DIR, "consumer-graph.json");
const BASE = path.join(EVIDENCE_DIR, "baseline-04c");
const SEAL_FILE = path.join(BASE, "SEAL.json");
const MANIFEST_FILE = path.join(BASE, "tree-manifest.json");
const FROZEN_DIR = path.join(BASE, "consumers");
const R = (f) => `artifacts/api-server/src/${f}`;
const canon = (r) => JSON.stringify(r) ?? "undefined";

const fail = (m) => { console.error(`${SUB_PHASE} FAIL — ${m}`); process.exit(1); };
const bypass = rejectBypass(["--verify"]);
if (bypass.length) fail(`bypass mechanism rejected: ${bypass.join(", ")}`);
if (process.env.VALIDATION_DISABLED && !/^(0|false|no)$/i.test(process.env.VALIDATION_DISABLED)) fail("bypass mechanism rejected: env VALIDATION_DISABLED");
const ts = loadTs(ROOT);
if (!ts) fail("TypeScript compiler API unavailable (fail closed)");
const parse = (name, text) => ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

// ── 0. The write-once seal must exist and be internally consistent (this validator never creates it) ──
if (!fs.existsSync(SEAL_FILE)) fail("baseline-04c/SEAL.json missing — run freeze-vlt-gap-04-C-baseline.mjs ONCE, before any 04-C change");
if (!fs.existsSync(MANIFEST_FILE)) fail("baseline-04c/tree-manifest.json missing");
const SEAL = JSON.parse(fs.readFileSync(SEAL_FILE, "utf8"));
const frozenText = (name) => fs.readFileSync(path.join(FROZEN_DIR, name), "utf8");

// ── 1. Declared 04-C surface (intent). Every entry is VERIFIED against source below. ──
const OWNER = {
  listing: "vault/application/game/listing.ts",
  repo: "vault/infrastructure/repositories/game-repository.ts",
  entries: "vault/application/game/entries.ts",
  market: "vault/application/game/marketplace.ts",
  security: "vault/security/game-ownership.ts",
};
const NEW_FILES = [OWNER.listing];
const REPO_SYMBOLS = ["selectGameEntryForListing", "transferGameEntryOwnership"];
const LISTING_SYMBOLS = ["loadGameEntryListingPreview", "transferGameEntryToBuyer"];
const CONSUMERS = [
  { file: "routes/marketplace-vault.ts", frozen: "marketplace-vault.ts", uses: [[OWNER.listing.replace(/\.ts$/, ""), LISTING_SYMBOLS]] },
];
// Frozen files that 04-C MUST NOT change (everything frozen except the two files it legitimately edits).
const FROZEN_SOURCES = Object.values(SEAL.frozen_consumers ?? {}).map((v) => v.source);
const CHANGED_ALLOWED = new Set([R("routes/marketplace-vault.ts"), R(OWNER.repo)]);
const ADDED_ALLOWED = new Set(NEW_FILES.map(R));
// Table-access census: every file touching a game table must be a Game owner or an EXPLICIT deferral to the later gap that owns it.
const GAME_TBL = "(game_entries|game_market_listings)";
const OWNER_TABLE_FILES = new Set([R(OWNER.repo)]);
const DEFERRALS = {
  [R("lib/schema-migrations.ts")]: { gap: "VLT-GAP-12", reason: "schema migrations (DDL for game_entries / game_market_listings)" },
  [R("lib/mail-sync.ts")]: { gap: "VLT-GAP-12", reason: "mail-sync source registry: resolves a mailbox address to a game entry id" },
  [R("routes/search.ts")]: { gap: "VLT-GAP-12", reason: "global search read over game_entries" },
  [R("routes/vault-shares.ts")]: { gap: "VLT-GAP-10", reason: "share table registry (share lifecycle belongs to GAP-10)" },
  [R("routes/vault-snapshot.ts")]: { gap: "VLT-GAP-09", reason: "snapshot export reads game_entries" },
  [R("lib/vault-snapshot-restore.ts")]: { gap: "VLT-GAP-09", reason: "snapshot restore writes game_entries back" },
  "scripts/src/reencrypt-vault.ts": { gap: "VLT-GAP-07", reason: "re-encryption script rewrites game_entries ciphertext columns" },
};
// Referenced-by-name only (no query, no write): recorded, not counted as access.
const NAME_ONLY = [
  { file: "artifacts/api-server/src/lib/vault-snapshot-extra.ts", pattern: /game_entries/, why: "comment-only mention in the entity-coverage notes (no game table query; the game rows are read by routes/vault-snapshot.ts, deferred to GAP-09)" },
  { file: "artifacts/api-server/src/services/credit-meter.ts", pattern: /game_entries/, why: "comment-only mention in the metered-action catalog (no table access)" },
  { file: "packages/domain-boundaries/src/index.mjs", pattern: /"game_entries"/, why: "ownedResources registry entry of the catch-all platform domain contract (data, not access)" },
];

// ── 2. AST helpers ──
const importsOfFile = (sf) => sf.statements.filter((s) => ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier)).map((s) => ({
  spec: s.moduleSpecifier.text,
  names: s.importClause?.namedBindings && ts.isNamedImports(s.importClause.namedBindings) ? s.importClause.namedBindings.elements.map((e) => ({ imported: (e.propertyName ?? e.name).text, local: e.name.text })) : [],
}));
const resolveTo = (fromAbs, spec) => (spec.startsWith(".") ? rel(path.resolve(path.dirname(fromAbs), spec)).replace(/\.(ts|js)$/, "") : null);
const norm = (s) => s.replace(/\s+/g, " ").trim();
const collapse = (s) => norm(s).replace(/\$\{[^}]*\}/g, "${}");
const SQLISH = /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/i;
function sqlLiterals(sf) {
  const out = new Set();
  (function w(n) {
    let text = null;
    if (ts.isNoSubstitutionTemplateLiteral(n) || ts.isStringLiteral(n)) text = n.text;
    else if (ts.isTemplateExpression(n)) text = n.head.text + n.templateSpans.map((s) => "${}" + s.literal.text).join("");
    if (text !== null) { const t = norm(text); if (SQLISH.test(t) && /\b(FROM|INTO|SET|WHERE)\b/i.test(t)) out.add(t); }
    ts.forEachChild(n, w);
  })(sf);
  return out;
}
function gameTableAccess(sf) {
  const sqlAccess = [], nameLiterals = [];
  (function w(n) {
    let text = null;
    if (ts.isNoSubstitutionTemplateLiteral(n) || ts.isStringLiteral(n)) text = n.text;
    else if (ts.isTemplateExpression(n)) text = n.head.text + n.templateSpans.map((s) => "${}" + s.literal.text).join("");
    if (text !== null && new RegExp(GAME_TBL).test(text)) {
      const t = norm(text);
      if (new RegExp(`\\b(FROM|JOIN|INTO|UPDATE|(CREATE|ALTER|DROP)\\s+TABLE(\\s+IF\\s+(NOT\\s+)?EXISTS)?|TRUNCATE)\\s+${GAME_TBL}\\b`, "i").test(t)) sqlAccess.push(t.slice(0, 90));
      else if (t === "game_entries" || t === "game_market_listings") nameLiterals.push({ line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1 });
    }
    ts.forEachChild(n, w);
  })(sf);
  return { sqlAccess, nameLiterals };
}
function routeTable(text, name = "route.ts") {
  const sf = parse(name, text); const out = [];
  (function w(n) {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression) && n.expression.expression.text === "router" && ["get", "post", "put", "patch", "delete"].includes(n.expression.name.text)) {
      const a = n.arguments; const h = a[a.length - 1];
      out.push({ method: n.expression.name.text.toUpperCase(), path: a[0].text, middleware: [...a].slice(1, -1).map((x) => norm(x.getText(sf))), handler_lines: h.getText(sf).split("\n").length, handler_text: h.getText(sf) });
    }
    ts.forEachChild(n, w);
  })(sf);
  return out;
}
function exportedFns(text, name) {
  const sf = parse(name, text); const out = [];
  for (const s of sf.statements) { const ex = s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword); if (ex && ts.isFunctionDeclaration(s) && s.name) out.push(s.name.text); }
  return out;
}
const importers = (allParsed, owner) => allParsed.flatMap(({ k, sf }) => importsOfFile(sf).filter((i) => resolveTo(path.join(ROOT, k), i.spec) === R(owner.replace(/\.ts$/, ""))).map((i) => ({ file: k, names: i.names.map((n) => n.imported) })));

// ── 3. Static proof ──
function staticProof() {
  const checks = []; const chk = (name, passed, details = "") => checks.push({ name, passed: !!passed, details });
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf8"));
  chk("seal:manifest-hash-matches-seal", sha256(fs.readFileSync(MANIFEST_FILE, "utf8")) === SEAL.tree_manifest_sha256);
  chk("seal:certified-by-04B", SEAL.certified_by?.sub_phase === "VLT-GAP-04-B" && SEAL.sub_phase === SUB_PHASE);
  const frozenBad = Object.entries(SEAL.frozen_consumers ?? {}).filter(([n, v]) => !fs.existsSync(path.join(FROZEN_DIR, n)) || sha256File(path.join(FROZEN_DIR, n)) !== v.sha256 || manifest.files[v.source] !== v.sha256);
  chk("seal:frozen-consumers-intact-and-equal-to-manifest", frozenBad.length === 0 && Object.keys(SEAL.frozen_consumers ?? {}).length >= 7, frozenBad.map(([n]) => n).join(", "));

  const dest = Object.fromEntries([...NEW_FILES, OWNER.repo].map((f) => [f, fs.existsSync(path.join(SRC, f)) ? fs.readFileSync(path.join(SRC, f), "utf8") : null]));
  for (const f of NEW_FILES) chk(`destination-exists:${f}`, dest[f] !== null);
  if (Object.values(dest).some((v) => v === null)) return { checks, consumers: [], census: [], duplicates: [], usage: [], repoSql: [], importers: [], nameOnly: [] };

  const parsedFiles = [];
  for (const f of walkFiles(ROOT)) { const k = rel(f); if (/\.(ts|tsx)$/.test(k) && !k.startsWith("node_modules/") && !k.includes("/node_modules/")) { try { parsedFiles.push({ k, sf: parse(k, fs.readFileSync(f, "utf8")) }); } catch { /* unreadable */ } } }
  const routeNew = fs.readFileSync(path.join(SRC, "routes/marketplace-vault.ts"), "utf8");
  const routeOld = frozenText("marketplace-vault.ts");
  const frozenRepo = frozenText("game-repository.ts");

  // 3.1 owner implementation is executable and the two moved symbols exist
  const listingFns = exportedFns(dest[OWNER.listing], OWNER.listing); const repoFns = exportedFns(dest[OWNER.repo], OWNER.repo); const frozenRepoFns = exportedFns(frozenRepo, "frozen-repo");
  chk("destination:listing-has-executable-use-cases", LISTING_SYMBOLS.every((n) => listingFns.includes(n)), listingFns.join(", "));
  chk("destination:repository-gained-exactly-the-two-moved-statements", REPO_SYMBOLS.every((n) => repoFns.includes(n) && !frozenRepoFns.includes(n)) && repoFns.length === frozenRepoFns.length + REPO_SYMBOLS.length, `${frozenRepoFns.length} → ${repoFns.length}`);
  chk("destination:no-existing-repository-function-removed", frozenRepoFns.every((n) => repoFns.includes(n)));

  // 3.2 moved SQL is VERBATIM: the two new repository statements existed (collapsed) in the frozen route
  const sqlOfText = (t, n) => [...sqlLiterals(parse(n, t))];
  const repoNewSql = sqlOfText(dest[OWNER.repo], "repo").map(collapse).filter((s) => !sqlOfText(frozenRepo, "frozen-repo").map(collapse).includes(s));
  const frozenRouteSql = sqlOfText(routeOld, "frozen-route").map(collapse);
  const repoSql = repoNewSql.map((s) => ({ sql: s, verbatim_in_frozen: frozenRouteSql.includes(s) }));
  chk("moved-sql-is-verbatim-from-frozen-route", repoSql.length === 2 && repoSql.every((r) => r.verbatim_in_frozen), JSON.stringify(repoSql));
  chk("repository-existing-sql-unchanged", [...sqlOfText(frozenRepo, "a").map(collapse)].every((s) => sqlOfText(dest[OWNER.repo], "b").map(collapse).includes(s)));

  // 3.3 the consumer route is rewired, thin for the game branches, and keeps every other branch
  const consumers = []; const newRouteSf = parse("routes/marketplace-vault.ts", routeNew); const oldRouteSf = parse("frozen-marketplace-vault.ts", routeOld);
  for (const c of CONSUMERS) {
    const imps = importsOfFile(newRouteSf).filter((i) => resolveTo(path.join(SRC, c.file), i.spec) === R(c.uses[0][0]));
    const usesOk = c.uses.every(([mod, names]) => names.every((n) => importsOfFile(newRouteSf).some((i) => resolveTo(path.join(SRC, c.file), i.spec) === R(mod) && i.names.some((x) => x.imported === n)) && (routeNew.match(new RegExp(`\\b${n}\\(`, "g")) ?? []).length >= 1));
    chk(`consumer-imports-and-uses-owner:${c.file}`, usesOk, imps.map((i) => i.spec).join(","));
    const before = gameTableAccess(oldRouteSf), after = gameTableAccess(newRouteSf);
    chk(`consumer-had-game-table-sql-before:${c.file}`, before.sqlAccess.length === 2, JSON.stringify(before.sqlAccess));
    chk(`consumer-has-no-game-table-sql:${c.file}`, after.sqlAccess.length === 0, after.sqlAccess.join(" | "));
    chk(`consumer-has-no-game-table-name-literal:${c.file}`, after.nameLiterals.length === 0, JSON.stringify(after.nameLiterals));
    const tb = routeTable(routeOld, "old"), ta = routeTable(routeNew, "new"); const sig = (t) => t.map((r) => `${r.method} ${r.path} [${r.middleware.join(" > ")}]`);
    const same = JSON.stringify(sig(tb)) === JSON.stringify(sig(ta)) && ta.length === 5;
    chk(`consumer-route-table-unchanged:${c.file}`, same, "method/path/middleware chain changed");
    // every non-game SQL statement is byte-identical; exactly the two game ones disappeared
    const oldS = [...sqlLiterals(oldRouteSf)].map(collapse).sort(), newS = [...sqlLiterals(newRouteSf)].map(collapse).sort();
    const gone = oldS.filter((s) => !newS.includes(s)), added = newS.filter((s) => !oldS.includes(s));
    chk(`consumer-only-the-two-game-statements-left-the-route:${c.file}`, gone.length === 2 && gone.every((s) => new RegExp(GAME_TBL).test(s)) && added.length === 0, JSON.stringify({ gone: gone.map((g) => g.slice(0, 60)), added }));
    const keep = ["vault_entries", "local_accounts", "kyc_entries"].every((t) => new RegExp(`UPDATE ${t} SET user_id`).test(routeNew) || t === "vault_entries");
    chk(`consumer-other-vault-types-still-handled-here (deferred, not dropped):${c.file}`, /UPDATE vault_entries SET user_id/.test(routeNew) && /UPDATE local_accounts SET user_id/.test(routeNew) && /UPDATE kyc_entries SET user_id/.test(routeNew) && keep);
    chk(`consumer-keeps-its-transaction-control:${c.file}`, /pool\.connect\(\)/.test(routeNew) && (routeNew.match(/ROLLBACK/g) ?? []).length >= (routeOld.match(/ROLLBACK/g) ?? []).length && (routeNew.match(/COMMIT/g) ?? []).length === (routeOld.match(/COMMIT/g) ?? []).length);
    consumers.push({ file: c.file, imports_owner: usesOk, game_table_sql_before: before.sqlAccess.length, game_table_sql_after: after.sqlAccess.length, route_table_unchanged: same, routes: ta.length });
  }
  const gameHandlerRefs = (t) => (t.match(/\b(game_entries|game_entry_id)\b/g) ?? []).length;
  chk("consumer-game-branches-are-delegations", /loadGameEntryListingPreview\(game_entry_id, sellerId\)/.test(routeNew) && /transferGameEntryToBuyer\(client, listing\.vault_entry_id, buyerId, listing\.seller_id\)/.test(routeNew), `refs old=${gameHandlerRefs(routeOld)} new=${gameHandlerRefs(routeNew)}`);

  // 3.4 layering of the new owner module
  const impL = importsOfFile(parse("l", dest[OWNER.listing])).map((i) => i.spec);
  chk("layering:listing-imports-only-the-game-repository", impL.length === 1 && /repositories\/game-repository$/.test(impL[0]), impL.join(", "));
  chk("layering:listing-has-no-sql-http-or-db", sqlLiterals(parse("l", dest[OWNER.listing])).size === 0 && !/\b(Request|Response|express|pool|db)\b/.test(dest[OWNER.listing].replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")));
  const impR = importsOfFile(parse("r", dest[OWNER.repo])).map((i) => i.spec);
  chk("layering:repository-still-only-db-and-drizzle", impR.every((i) => ["@workspace/db", "drizzle-orm"].includes(i)), impR.join(", "));
  chk("layering:no-vault-module-imports-a-route", parsedFiles.filter(({ k }) => k.startsWith(R("vault/"))).every(({ k, sf }) => importsOfFile(sf).every((i) => !/\/routes\//.test(i.spec))));

  // 3.5 consumer graph: who imports each owner symbol; every one must be used
  const usage = [...LISTING_SYMBOLS.map((n) => [n, OWNER.listing]), ...REPO_SYMBOLS.map((n) => [n, OWNER.repo])].map(([name, file]) => {
    const users = parsedFiles.filter(({ k, sf }) => k !== R(file) && importsOfFile(sf).some((i) => i.names.some((x) => x.imported === name))).map((x) => x.k.replace("artifacts/api-server/src/", ""));
    const inOwner = (fs.readFileSync(path.join(ROOT, R(file)), "utf8").match(new RegExp(`\\b${name}\\(`, "g")) ?? []).length;
    return { symbol: name, owner: file, consumers: users, ...(inOwner > 1 ? { internal_calls: inOwner - 1 } : {}) };
  });
  for (const u of usage) chk(`symbol-is-used:${u.symbol}`, u.consumers.length > 0 || (u.internal_calls ?? 0) > 0, JSON.stringify(u));
  const listingImporters = importers(parsedFiles, OWNER.listing); const repoImporters = importers(parsedFiles, OWNER.repo);
  chk("consumer-listing-imported-only-by-marketplace-vault-route", listingImporters.length === 1 && listingImporters[0].file === R("routes/marketplace-vault.ts"), JSON.stringify(listingImporters));
  chk("repository-importers-are-vault-owner-modules-only", repoImporters.every((x) => x.file.startsWith(R("vault/"))) && repoImporters.length >= 4, JSON.stringify(repoImporters.map((x) => x.file)));
  chk("no-route-imports-the-game-repository-directly (no bypass of the application owner)", !parsedFiles.some(({ k, sf }) => k.startsWith(R("routes/")) && importsOfFile(sf).some((i) => /repositories\/game-repository$/.test(i.spec))));

  // 3.6 duplicate scan: no moved SQL statement implemented outside the owner
  const collapsedRepo = new Set(repoSql.map((r) => r.sql));
  const duplicates = [];
  for (const { k, sf } of parsedFiles) { if (k === R(OWNER.repo)) continue; for (const s of sqlLiterals(sf)) if (collapsedRepo.has(collapse(s))) duplicates.push({ file: k, sql: s.slice(0, 100) }); }
  chk("duplicate-scan:no-moved-sql-outside-owner", duplicates.length === 0, JSON.stringify(duplicates));
  chk("duplicate-scan:detector-catches-the-frozen-copy (self-test)", [...sqlLiterals(oldRouteSf)].map(collapse).filter((s) => collapsedRepo.has(s)).length === 2);
  const dupPreview = parsedFiles.filter(({ k, sf }) => k !== R(OWNER.listing) && /has_2fa:\s*!!g\.email_2fa/.test(fs.readFileSync(path.join(ROOT, k), "utf8"))).map((x) => x.k);
  chk("duplicate-scan:game-preview-builder-exists-only-in-owner", dupPreview.length === 0, dupPreview.join(", "));

  // 3.7 table-access census with explicit deferrals
  const census = [];
  for (const { k, sf } of parsedFiles) {
    if (k.startsWith(GAP_DIR) || k.startsWith("reports/")) continue;
    const acc = gameTableAccess(sf);
    if (!acc.sqlAccess.length && !acc.nameLiterals.length) continue;
    let classification;
    if (OWNER_TABLE_FILES.has(k)) classification = { kind: "owner" };
    else if (DEFERRALS[k]) classification = { kind: "deferred", ...DEFERRALS[k] };
    else classification = { kind: "UNCLASSIFIED" };
    census.push({ file: k, sql_access: acc.sqlAccess.length, name_literals: acc.nameLiterals.length, ...classification });
  }
  const unclassified = census.filter((c) => c.kind === "UNCLASSIFIED");
  chk("census:no-unclassified-game-table-access", unclassified.length === 0, unclassified.map((c) => c.file).join(", "));
  const stale = Object.keys(DEFERRALS).filter((k) => !census.some((c) => c.file === k));
  chk("census:no-stale-deferral (every deferral still accesses a game table)", stale.length === 0, stale.join(", "));
  chk("census:rewired-consumer-absent-from-census", !census.some((c) => c.file === R("routes/marketplace-vault.ts")));
  chk("census:the-two-game-routes-and-owner-modules-hold-no-direct-table-access", ["routes/game-entries.ts", "routes/marketplace-game.ts", OWNER.entries, OWNER.market, OWNER.listing, OWNER.security].every((f) => !census.some((c) => c.file === R(f))));
  chk("census:every-deferral-names-a-later-gap", [...new Set(Object.values(DEFERRALS).map((d) => d.gap))].every((g) => /^VLT-GAP-(0[5-9]|1\d)$/.test(g)), "");
  const nameOnly = NAME_ONLY.map((n) => ({ file: n.file, why: n.why, present: fs.existsSync(path.join(ROOT, n.file)) && n.pattern.test(fs.readFileSync(path.join(ROOT, n.file), "utf8")), table_access: parsedFiles.some(({ k, sf }) => k === n.file && (gameTableAccess(sf).sqlAccess.length > 0)) }));
  chk("census:name-only-references-perform-no-table-access", nameOnly.every((n) => n.present && !n.table_access), JSON.stringify(nameOnly.filter((n) => !n.present || n.table_access)));

  // 3.8 contract stability: every public path from the 04-A inventory is still registered; no frontend file changed
  const inv = JSON.parse(fs.readFileSync(path.join(EVIDENCE_DIR, "symbol-inventory.json"), "utf8"));
  const regPaths = new Set(["routes/game-entries.ts", "routes/marketplace-game.ts", "routes/marketplace-vault.ts"].flatMap((f) => routeTable(fs.readFileSync(path.join(SRC, f), "utf8"), f).map((r) => r.path)));
  const missing = (inv.endpoint_callers?.route_paths ?? []).filter((p) => !regPaths.has(p));
  chk("contract:every-04A-public-route-path-still-registered", (inv.endpoint_callers?.route_paths ?? []).length >= 6 && missing.length === 0, missing.join(", "));
  const callers = (inv.endpoint_callers?.callers ?? []).map((c) => c.file).filter((f) => f.startsWith("artifacts/ayzen/"));
  const callerChanged = callers.filter((f) => fs.existsSync(path.join(ROOT, f)) && manifest.files[f] !== sha256File(path.join(ROOT, f)));
  chk("contract:frontend-callers-unchanged-and-need-no-change", callers.length >= 5 && callerChanged.length === 0, callerChanged.join(", "));
  const unchangedFrozen = FROZEN_SOURCES.filter((s) => !CHANGED_ALLOWED.has(s) && sha256File(path.join(ROOT, s)) !== SEAL.frozen_consumers && manifest.files[s] !== sha256File(path.join(ROOT, s)));
  chk("scope:frozen-files-04C-does-not-own-are-byte-identical", unchangedFrozen.length === 0, unchangedFrozen.join(", "));
  return { checks, consumers, census, duplicates, usage, repoSql, importers: { listing: listingImporters, repository: repoImporters }, nameOnly };
}

// ── 4. Differential: sealed 04-B marketplace-vault route (OLD) vs current tree (NEW), identical stubs ──
const K = sqlKeyOf;
const rows = (...r) => ({ value: { rows: r, rowCount: r.length } });
const cnt = (n) => ({ value: { rows: [], rowCount: n } });
const boom = (m = "boom") => ({ throw: m });
function makeEnv(c) {
  const env = createEnv({}); const log = env.log;
  const pq = new Map(Object.entries(c.pool ?? {}).map(([k, v]) => [k, [...v]]));
  const nextPool = (key) => { const q = pq.get(key); if (!q || !q.length) { log.push(["pool.await", key, "default"]); return { rows: [], rowCount: 0 }; } const it = q.shift(); log.push(["pool.await", key, it.throw ? { throw: String(it.throw) } : "ok"]); if (it.throw) throw new Error(it.throw); return it.value; };
  const n = (t) => String(t).replace(/\s+/g, " ").trim();
  const client = { query: async (t, p) => { log.push(["client.query", summ([n(t), p])]); if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(n(t))) return { rows: [], rowCount: 0 }; return nextPool("TX:" + K(t)); }, release: () => log.push(["client.release"]) };
  const pool = { query: async (t, p) => { log.push(["pool.query", summ([n(t), p])]); return nextPool(K(t)); }, connect: async () => { log.push(["pool.connect"]); return client; } };
  env.stubs["@workspace/db"] = { ...env.stubs["@workspace/db"], pool };
  env.stubs["lib/market-config"] = { getMarketConfig: async (t) => { log.push(["getMarketConfig", t]); return { marketType: t, feePct: c.feePct ?? 5, enabled: c.enabled !== false }; } };
  env.stubs["lib/policy/pep"] = { authorize: async (a) => { log.push(["authorize", summ({ action: a.action, resource: a.resource, engine: a.engine?.__engine })]); return { decision: { effect: c.auth ?? "ALLOW" } }; } };
  env.stubs["lib/policy/resource"] = { createResourceOwnershipRule: () => ({ __rule: "resource-ownership" }), createRoleOverrideRule: (roles) => ({ __rule: "role-override", roles }) };
  env.stubs["lib/policy/policy-engine"] = { PolicyEngine: class { constructor(o) { this.__engine = { rules: [], onDecision: summ(o?.onDecision) }; } registerRule(nm, r) { this.__engine.rules.push([nm, summ(r)]); log.push(["registerRule", nm, summ(r)]); } } };
  return env;
}
const loadOld = (env) => createLoader({ ts, root: ROOT, srcDir: SRC, env }).loadText(frozenText("marketplace-vault.ts"), "routes/marketplace-vault.ts", ROUTES);
const loadNew = (env) => createLoader({ ts, root: ROOT, srcDir: SRC, env }).loadFile(path.join(SRC, "routes/marketplace-vault.ts"));
const U = 7;
const gameRow = { id: 4, category: "MOBA", platform: "pc", email_2fa: "enc(x)", user_id: U };
const ge = (n) => `SELECT * FROM ${n} WHERE id=$1`;
const create = (body, extra = {}) => ({ method: "POST", path: "/marketplace/vault/listings", req: { body: { title: "T", price: 10, ...body } }, ...extra });
const LISTING_INSERT = K("INSERT INTO vault_market_listings (seller_id,");
const listingRow = (vt, over = {}) => ({ id: 5, seller_id: 9, price: "100", title: "Acct", vault_type: vt, vault_entry_id: 4, status: "active", order_type: "sell", ...over });
const TBL = { entity: "vault_entries", local: "local_accounts", kyc: "kyc_entries", game: "game_entries" };
const buy = (vt, over = {}, extra = {}) => ({
  method: "POST", path: "/marketplace/vault/buy", req: { body: { listing_id: 5 } },
  pool: {
    [K("SELECT * FROM vault_market_listings WHERE id=$1")]: [rows(listingRow(vt))],
    [K("SELECT balance FROM marketplace_wallets")]: [rows({ balance: "500" })],
    ["TX:" + K("UPDATE marketplace_wallets SET balance=balance-$1,")]: [cnt(1)],
    ["TX:" + K("UPDATE vault_market_listings SET status='sold',")]: [cnt(1)],
    ["TX:" + K(`UPDATE ${TBL[vt]} SET user_id=$1`)]: [cnt(1)],
    ...over,
  }, ...extra,
});
const gameLookup = (v) => ({ [K(ge("game_entries"))]: [v] });
const CASES = [
  // ── create: game branch (the rewired code) ──
  { name: "create game listing owned", cat: "success", ...create({ game_entry_id: 4, vault_type: "game" }, { pool: { ...gameLookup(rows(gameRow)), [LISTING_INSERT]: [rows({ id: 1 })] } }) },
  { name: "create game listing with all optional fields", cat: "success", ...create({ game_entry_id: 4, vault_type: "game", description: "d", category: "c", tier: "pro", account_details: { a: 1 }, price_min: 1, price_max: 9 }, { pool: { ...gameLookup(rows({ id: 4, category: null, email_2fa: null })), [LISTING_INSERT]: [rows({ id: 1 })] } }) },
  { name: "create game listing not owned → 403", cat: "security", ...create({ game_entry_id: 4, vault_type: "game" }, { pool: gameLookup(rows()) }) },
  { name: "create game listing seller scope passed to SQL", cat: "security", ...create({ game_entry_id: 4, vault_type: "game" }, { req: { userId: 55, body: { title: "T", price: 10, game_entry_id: 4, vault_type: "game" } }, pool: gameLookup(rows()) }) },
  { name: "create game listing injection-shaped id stays a bound parameter", cat: "security", ...create({ game_entry_id: "4 OR 1=1", vault_type: "game" }, { pool: gameLookup(rows()) }) },
  { name: "create game listing db error → 500", cat: "failure", ...create({ game_entry_id: 4, vault_type: "game" }, { pool: gameLookup(boom("pg down")) }) },
  { name: "create game listing insert error → 500", cat: "failure", ...create({ game_entry_id: 4, vault_type: "game" }, { pool: { ...gameLookup(rows(gameRow)), [LISTING_INSERT]: [boom("ins")] } }) },
  { name: "create game listing market disabled → 403, no lookup", cat: "security", ...create({ game_entry_id: 4, vault_type: "game" }, { enabled: false }) },
  { name: "create game listing missing price → 400", cat: "failure", ...create({ game_entry_id: 4, vault_type: "game", price: 0 }) },
  { name: "create game id supplied but vault_type entity → game lookup NOT run", cat: "security", ...create({ game_entry_id: 4, vault_type: "entity" }, { pool: { [LISTING_INSERT]: [rows({ id: 1 })] } }) },
  { name: "create vault_type game without game_entry_id → no lookup", cat: "success", ...create({ vault_type: "game" }, { pool: { [LISTING_INSERT]: [rows({ id: 1 })] } }) },
  // other types unchanged by the rewire
  { name: "create entity listing owned", cat: "success", ...create({ vault_entry_id: 3, vault_type: "entity" }, { pool: { [K("SELECT * FROM vault_entries WHERE id=$1")]: [rows({ id: 3, project_name: "p", entity_serial: "S" })], [LISTING_INSERT]: [rows({ id: 1 })] } }) },
  { name: "create entity listing not owned → 403", cat: "security", ...create({ vault_entry_id: 3, vault_type: "entity" }) },
  { name: "create local listing owned", cat: "success", ...create({ local_account_id: 2, vault_type: "local" }, { pool: { [K("SELECT * FROM local_accounts WHERE id=$1")]: [rows({ id: 2, category: "c", twofa: "x", followers: 3 })], [LISTING_INSERT]: [rows({ id: 1 })] } }) },
  { name: "create kyc listing not owned → 403", cat: "security", ...create({ kyc_entry_id: 2, vault_type: "kyc" }) },
  { name: "create buy order (no asset lookup)", cat: "success", ...create({ order_type: "buy", account_type: "gmail", price: undefined, price_min: 2 }, { pool: { [LISTING_INSERT]: [rows({ id: 1 })] } }) },
  // ── buy: transfer branch (the rewired code) ──
  { name: "buy game transfers entry and commits", cat: "success", ...buy("game") },
  { name: "buy game transfer conflict (seller no longer owns) → rollback 409", cat: "security", ...buy("game", { ["TX:" + K("UPDATE game_entries SET user_id=$1")]: [cnt(0)] }) },
  { name: "buy game transfer throws → rollback 500, connection released", cat: "failure", ...buy("game", { ["TX:" + K("UPDATE game_entries SET user_id=$1")]: [boom("xfer")] }) },
  { name: "buy game transfer uses buyer/seller/listing ids from the listing row", cat: "security", ...buy("game", {}, { req: { userId: 21, body: { listing_id: 5 } } }) },
  { name: "buy game own listing → 400, no connection", cat: "security", ...buy("game", {}, { req: { userId: 9, body: { listing_id: 5 } } }) },
  { name: "buy game insufficient inside tx → rollback 400", cat: "security", ...buy("game", { ["TX:" + K("UPDATE marketplace_wallets SET balance=balance-$1,")]: [cnt(0)] }) },
  { name: "buy game already sold inside tx → rollback 409", cat: "security", ...buy("game", { ["TX:" + K("UPDATE vault_market_listings SET status='sold',")]: [cnt(0)] }) },
  { name: "buy game listing without vault_entry_id → no transfer", cat: "success", ...buy("game", { [K("SELECT * FROM vault_market_listings WHERE id=$1")]: [rows(listingRow("game", { vault_entry_id: null }))] }) },
  { name: "buy game listing not found → 404", cat: "failure", method: "POST", path: "/marketplace/vault/buy", req: { body: { listing_id: 5 } } },
  { name: "buy missing listing_id → 400", cat: "failure", method: "POST", path: "/marketplace/vault/buy", req: { body: {} } },
  // other types unchanged by the rewire
  { name: "buy entity transfers", cat: "success", ...buy("entity") },
  { name: "buy entity conflict → rollback 409", cat: "security", ...buy("entity", { ["TX:" + K("UPDATE vault_entries SET user_id=$1")]: [cnt(0)] }) },
  { name: "buy local transfers", cat: "success", ...buy("local") },
  { name: "buy local conflict → rollback 409", cat: "security", ...buy("local", { ["TX:" + K("UPDATE local_accounts SET user_id=$1")]: [cnt(0)] }) },
  { name: "buy kyc transfers", cat: "success", ...buy("kyc") },
  { name: "buy kyc conflict → rollback 409", cat: "security", ...buy("kyc", { ["TX:" + K("UPDATE kyc_entries SET user_id=$1")]: [cnt(0)] }) },
  // untouched routes of the same file (regression guard on the file as a whole)
  { name: "GET listings", cat: "success", method: "GET", path: "/marketplace/vault/listings", req: { query: { vault_type: "game", official: "false" } }, pool: { [K("SELECT vl.*, u.username AS")]: [rows({ id: 1, preview_data: "{\"a\":1}", account_details: null })], [K("SELECT COUNT(*) FROM vault_market_listings")]: [rows({ count: "1" })] } },
  { name: "DELETE listing owner/admin", cat: "success", method: "DELETE", path: "/marketplace/vault/listings/:id", req: { params: { id: "5" } }, pool: { [K("SELECT * FROM vault_market_listings WHERE id=$1")]: [rows(listingRow("game"))] } },
  { name: "DELETE listing not owner → 403", cat: "security", method: "DELETE", path: "/marketplace/vault/listings/:id", req: { params: { id: "5" } }, pool: { [K("SELECT * FROM vault_market_listings WHERE id=$1")]: [rows(listingRow("game"))] }, auth: "DENY" },
  { name: "GET stats", cat: "success", method: "GET", path: "/marketplace/vault/stats", req: {}, pool: { [K("SELECT COUNT(*) as cnt,")]: [rows({ cnt: "2", floor: "3", avg_price: "4" })], [K("SELECT SUM(amount) as vol,")]: [rows({ vol: "9", sales: "1" })] } },
];
async function runCase(loader, c, overrides) {
  const env = makeEnv(c); if (overrides) env.overrides = overrides;
  try { loader(env); } catch (e) { return { loadError: String(e.message ?? e), log: env.log }; }
  const loadLog = env.log.splice(0);
  const route = env.routes.find((r) => r.method === c.method && r.path === c.path);
  if (!route) return { missing: `${c.method} ${c.path}` };
  const chain = route.stack.slice(0, -1).map((f) => f.__ownership ? `own(${f.__ownership.action})` : f.__stub ?? f.name);
  const req = { user: { userId: c.req?.userId ?? U, role: "user" }, params: c.req?.params ?? {}, query: c.req?.query ?? {}, body: "body" in (c.req ?? {}) ? c.req.body : {} };
  const res = fakeRes(); let thrown = null;
  try { await route.stack[route.stack.length - 1](req, res); } catch (e) { thrown = e?.name ?? "Error"; }
  return { statusCode: res.statusCode ?? 200, body: res.body, thrown, chain, loadLog, log: env.log };
}
let OLD_CACHE = null;
async function oldResults() { if (!OLD_CACHE) { OLD_CACHE = []; for (const c of CASES) OLD_CACHE.push(await runCase(loadOld, c)); } return OLD_CACHE; }
async function differentialSuite(overrides) {
  const olds = await oldResults(); const out = [];
  for (let i = 0; i < CASES.length; i++) {
    const c = CASES[i]; const a = olds[i]; const b = await runCase(loadNew, c, overrides); const diffs = [];
    if (b.loadError || b.missing || a.loadError || a.missing) diffs.push(`load/route problem: old=${a.loadError ?? a.missing ?? "ok"} new=${b.loadError ?? b.missing ?? "ok"}`);
    else for (const f of Object.keys({ ...a, ...b })) if (canon(a[f]) !== canon(b[f])) diffs.push(`${f}: old=${canon(a[f])?.slice(0, 140)} new=${canon(b[f])?.slice(0, 140)}`);
    out.push({ name: c.name, category: c.cat, method: c.method, path: c.path, passed: diffs.length === 0, diffs, log_entries: Array.isArray(b.log) ? b.log.length : 0 });
  }
  return out;
}
// Explicit behavior/security assertions on the NEW tree (not merely "same as old")
async function securitySuite() {
  const res = []; const add = (name, passed, details = "") => res.push({ name: `security:${name}`, passed: !!passed, details });
  const get = async (n) => { const i = CASES.findIndex((c) => c.name === n); if (i < 0) throw new Error(`case ${n}`); return runCase(loadNew, CASES[i]); };
  const L = (r) => r.log.map((e) => JSON.stringify(e)); const has = (r, s) => L(r).some((x) => x.includes(s));
  let r = await get("create game listing owned");
  add("game-listing-requires-seller-ownership-lookup-with-seller-id", has(r, "SELECT * FROM game_entries WHERE id=$1 AND user_id=$2") && has(r, "[4,7]") && r.statusCode === 200);
  add("game-listing-preview-exposes-only-category-platform-has2fa", r.body?.preview_data && Object.keys(r.body.preview_data).sort().join() === "category,has_2fa,platform" && r.body.preview_data.has_2fa === true && !has(r, "enc(x)\"}"));
  r = await get("create game listing not owned → 403"); add("not-owned-game-entry-cannot-be-listed-and-nothing-inserted", r.statusCode === 403 && r.body?.error === "Game entry not found or not yours" && !has(r, "INSERT INTO vault_market_listings"));
  r = await get("create game listing seller scope passed to SQL"); add("lookup-is-scoped-to-the-authenticated-seller", has(r, "[4,55]"));
  r = await get("create game listing injection-shaped id stays a bound parameter"); add("asset-id-is-a-bound-parameter-not-interpolated", has(r, "game_entries WHERE id=$1 AND user_id=$2") && !L(r).some((x) => /game_entries WHERE id=4 OR/.test(x)));
  r = await get("create game listing market disabled → 403, no lookup"); add("disabled-market-blocks-before-any-asset-lookup", r.statusCode === 403 && !has(r, "game_entries"));
  r = await get("buy game transfers entry and commits"); add("game-transfer-moves-entry-to-buyer-guarded-by-current-owner", has(r, "UPDATE game_entries SET user_id=$1 WHERE id=$2 AND user_id=$3 RETURNING id") && has(r, "[7,4,9]") && L(r).filter((x) => x.includes("COMMIT")).length === 1 && r.statusCode === 200);
  r = await get("buy game transfer conflict (seller no longer owns) → rollback 409"); add("transfer-conflict-rolls-back-answers-409-never-commits", has(r, "ROLLBACK") && !has(r, "COMMIT") && r.statusCode === 409 && r.body?.error === "Asset ownership conflict — seller may no longer own this game entry" && !has(r, "INSERT INTO marketplace_transactions") && has(r, "client.release"));
  r = await get("buy game transfer throws → rollback 500, connection released"); add("transfer-failure-rolls-back-and-releases-the-connection", has(r, "ROLLBACK") && has(r, "client.release") && !has(r, "COMMIT") && r.statusCode === 500);
  r = await get("buy game transfer uses buyer/seller/listing ids from the listing row"); add("buyer-id-comes-from-the-session-seller-id-from-the-listing", has(r, "[21,4,9]"));
  r = await get("buy game own listing → 400, no connection"); add("self-purchase-never-opens-a-transaction", r.statusCode === 400 && !has(r, "pool.connect"));
  r = await get("buy game listing without vault_entry_id → no transfer"); add("listing-without-asset-id-performs-no-transfer-but-still-commits", !has(r, "UPDATE game_entries") && has(r, "COMMIT"));
  r = await get("buy entity conflict → rollback 409"); add("other-vault-types-keep-their-own-transfer-guard", has(r, "UPDATE vault_entries SET user_id") && r.statusCode === 409 && has(r, "ROLLBACK"));
  return res;
}
// ── 5. Mutation tests: seeded regressions in the NEW tree must be caught ──
const MUTATIONS = [
  [OWNER.repo, "listing lookup loses seller scope", `"SELECT * FROM game_entries WHERE id=$1 AND user_id=$2"`, `"SELECT * FROM game_entries WHERE id=$1"`],
  [OWNER.repo, "listing lookup binds wrong params", `[entryId, sellerId],\n  );\n}\n\nexport async function transferGameEntryOwnership`, `[entryId, entryId],\n  );\n}\n\nexport async function transferGameEntryOwnership`],
  [OWNER.repo, "transfer no longer guarded by current owner", `WHERE id=$2 AND user_id=$3 RETURNING id", \n    [buyerId, entryId, sellerId]`.replace(" \n", "\n"), `WHERE id=$2 RETURNING id",\n    [buyerId, entryId, sellerId]`],
  [OWNER.repo, "transfer params reordered (seller receives asset)", `[buyerId, entryId, sellerId],\n  );\n}\n`, `[sellerId, entryId, buyerId],\n  );\n}\n`],
  [OWNER.repo, "transfer targets a different table", `"UPDATE game_entries SET user_id=$1 WHERE id=$2 AND user_id=$3 RETURNING id"`, `"UPDATE local_accounts SET user_id=$1 WHERE id=$2 AND user_id=$3 RETURNING id"`],
  [OWNER.listing, "ownership miss becomes 404", `status: 403, body: { error: "Game entry not found or not yours" }`, `status: 404, body: { error: "Game entry not found or not yours" }`],
  [OWNER.listing, "ownership miss message changed", `"Game entry not found or not yours"`, `"Not found"`],
  [OWNER.listing, "preview leaks the 2FA value", `has_2fa: !!g.email_2fa,`, `has_2fa: g.email_2fa,`],
  [OWNER.listing, "preview drops platform", `      platform: g.platform,\n`, ``],
  [OWNER.listing, "conflict becomes 400", `status: 409, body: { error: "Asset ownership conflict`, `status: 400, body: { error: "Asset ownership conflict`],
  [OWNER.listing, "conflict check inverted", `transferResult.rowCount === 0`, `transferResult.rowCount !== 0`],
  [OWNER.listing, "conflict never detected", `transferResult.rowCount === 0`, `false`],
  [OWNER.listing, "conflict message changed", `seller may no longer own this game entry`, `conflict`],
  ["routes/marketplace-vault.ts", "route ignores the ownership verdict", `if (!game.ok) { res.status(game.status).json(game.body); return; }`, ``],
  ["routes/marketplace-vault.ts", "route commits after a conflict (no rollback)", `            await client.query("ROLLBACK");\n            res.status(transfer.status).json(transfer.body); return;`, `            res.status(transfer.status).json(transfer.body); return;`],
  ["routes/marketplace-vault.ts", "route passes buyer as seller", `transferGameEntryToBuyer(client, listing.vault_entry_id, buyerId, listing.seller_id)`, `transferGameEntryToBuyer(client, listing.vault_entry_id, listing.seller_id, buyerId)`],
  ["routes/marketplace-vault.ts", "route looks the entry up by the wrong id", `loadGameEntryListingPreview(game_entry_id, sellerId)`, `loadGameEntryListingPreview(vault_entry_id, sellerId)`],
  ["routes/marketplace-vault.ts", "route skips the lookup scope (passes buyer-controlled id as seller)", `loadGameEntryListingPreview(game_entry_id, sellerId)`, `loadGameEntryListingPreview(game_entry_id, game_entry_id)`],
  ["routes/marketplace-vault.ts", "route stops using the preview", `previewData = game.previewData;`, `previewData = null;`],
  ["routes/marketplace-vault.ts", "game transfer skipped entirely", `const transfer = await transferGameEntryToBuyer(client, listing.vault_entry_id, buyerId, listing.seller_id);`, `const transfer = { ok: true } as any;`],
  ["routes/marketplace-vault.ts", "kyc branch accidentally altered", `"Asset ownership conflict — seller may no longer own this KYC entry"`, `"conflict"`],
];
async function mutationTests() {
  const out = [];
  for (const [file, name, from, to] of MUTATIONS) {
    const abs = path.join(SRC, file); const text = fs.readFileSync(abs, "utf8");
    if (!text.includes(from)) { out.push({ name: `mutation:${name}`, passed: false, details: "mutation not applicable (pattern absent) — seeded regression was NOT exercised" }); continue; }
    let detected = false, how = "";
    try { const r = await differentialSuite(new Map([[abs, text.replace(from, to)]])); const bad = r.filter((x) => !x.passed); detected = bad.length > 0; how = bad.slice(0, 2).map((x) => x.name).join("; "); }
    catch (e) { detected = true; how = `load/runtime error: ${String(e.message).slice(0, 80)}`; }
    out.push({ name: `mutation:${name}`, passed: detected, details: detected ? `detected by ${how}` : "NOT detected by any differential case" });
  }
  return out;
}
// ── 6. Diff audit ──
function diffAudit() {
  const man = JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf8")).files;
  const now = {}; for (const f of walkFiles(ROOT)) { const k = rel(f); if (!k.startsWith(GAP_DIR)) now[k] = sha256File(f); }
  const changed = [], added = [], removed = [];
  for (const [k, v] of Object.entries(now)) { if (!(k in man)) added.push(k); else if (man[k] !== v) changed.push(k); }
  for (const k of Object.keys(man)) if (!(k in now)) removed.push(k);
  const gapNow = {}; for (const f of walkFiles(path.join(ROOT, GAP_DIR))) gapNow[rel(f)] = sha256File(f);
  const gapEdited = Object.entries(SEAL.gap_scripts_at_freeze).filter(([k, v]) => gapNow[k] !== v).map(([k]) => k);
  const unexpected = [...changed.filter((k) => !CHANGED_ALLOWED.has(k)), ...added.filter((k) => !ADDED_ALLOWED.has(k)), ...removed];
  return { changed, added, removed, unexpected, earlier_validators_edited: gapEdited, tree_manifest_sha256_matches_seal: sha256(fs.readFileSync(MANIFEST_FILE, "utf8")) === SEAL.tree_manifest_sha256 };
}
// ── 7. Degraded differential typecheck (project deps are not installed in the upload) ──
function typecheckDifferential() {
  const cfgRaw = ts.readConfigFile(path.join(ROOT, "tsconfig.base.json"), ts.sys.readFile).config?.compilerOptions ?? {};
  const opts = ts.convertCompilerOptionsFromJson({ ...cfgRaw, noEmit: true, skipLibCheck: true, types: [], incremental: false, composite: false, baseUrl: ROOT }, ROOT).options;
  const routeAbs = path.join(SRC, "routes/marketplace-vault.ts"), repoAbs = path.join(SRC, OWNER.repo), listAbs = path.join(SRC, OWNER.listing);
  const scopeAbs = [routeAbs, repoAbs, listAbs];
  const baselineFor = new Map([[routeAbs, path.join(FROZEN_DIR, "marketplace-vault.ts")], [repoAbs, path.join(FROZEN_DIR, "game-repository.ts")]]);
  const run = (useBaseline) => {
    const host = ts.createCompilerHost(opts); const rf = host.readFile.bind(host), gs = host.getSourceFile.bind(host);
    const ov = (f) => (useBaseline ? baselineFor.get(f) : undefined);
    host.readFile = (f) => rf(ov(f) ?? f);
    host.getSourceFile = (f, lv, ...r) => { const o = ov(f); return o ? ts.createSourceFile(f, fs.readFileSync(o, "utf8"), lv, true) : gs(f, lv, ...r); };
    const roots = useBaseline ? [routeAbs, repoAbs] : scopeAbs;
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
// ── 8. Main ──
const sourceHashes = () => Object.fromEntries([R("routes/marketplace-vault.ts"), R(OWNER.repo), R(OWNER.listing), "scripts/antas/vault/gap/harness.mjs", "scripts/antas/vault/gap/gap-common.mjs"].map((f) => [f, sha256File(path.join(ROOT, f))]));
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
  const st = staticProof(); const diff = await differentialSuite(); const sec = await securitySuite(); const mut = await mutationTests(); const audit = diffAudit(); const tc = typecheckDifferential();
  const checks = [...st.checks];
  for (const r of diff) checks.push({ name: `differential:${r.name}`, passed: r.passed, details: r.diffs.join("; ") });
  for (const r of [...sec, ...mut]) checks.push({ name: r.name, passed: r.passed, details: r.details ?? "" });
  const cats = new Set(diff.map((d) => d.category));
  for (const c of ["success", "failure", "security"]) checks.push({ name: `coverage:category:${c}`, passed: cats.has(c), details: "" });
  const has = (m, p, k) => CASES.some((c) => c.method === m && c.path === p && (k ? c.cat === k : true));
  checks.push({ name: "coverage:every-route-of-the-rewired-file-has-a-case", passed: [["GET", "/marketplace/vault/listings"], ["POST", "/marketplace/vault/listings"], ["POST", "/marketplace/vault/buy"], ["DELETE", "/marketplace/vault/listings/:id"], ["GET", "/marketplace/vault/stats"]].every(([m, p]) => has(m, p)), details: "" });
  checks.push({ name: "coverage:both-rewired-branches-have-success-failure-and-security-cases", passed: ["create game", "buy game"].every((pre) => ["success", "failure", "security"].every((k) => CASES.some((c) => c.name.startsWith(pre) && c.cat === k))), details: "" });
  checks.push({ name: "coverage:every-vault-type-exercised-on-buy", passed: ["entity", "local", "kyc", "game"].every((t) => CASES.some((c) => c.name.startsWith(`buy ${t} `))), details: "" });
  checks.push({ name: "no-skipped-tests", passed: CASES.length > 0 && diff.length === CASES.length, details: `${diff.length}/${CASES.length}` });
  checks.push({ name: "differential-cases-executed-interactions", passed: diff.filter((d) => d.log_entries > 0).length >= 30, details: `${diff.filter((d) => d.log_entries > 0).length} cases recorded interactions` });
  checks.push({ name: "mutation-suite-size", passed: mut.length >= 18, details: `${mut.length} seeded regressions` });
  checks.push({ name: "diff-audit:no-unrelated-changes", passed: audit.unexpected.length === 0, details: audit.unexpected.join(", ") });
  checks.push({ name: "diff-audit:no-earlier-validator-edited", passed: audit.earlier_validators_edited.length === 0, details: audit.earlier_validators_edited.join(", ") });
  checks.push({ name: "diff-audit:baseline-seal-intact", passed: audit.tree_manifest_sha256_matches_seal, details: "" });
  checks.push({ name: "diff-audit:declared-changes-actually-happened", passed: [...CHANGED_ALLOWED].every((f) => audit.changed.includes(f)) && [...ADDED_ALLOWED].every((f) => audit.added.includes(f)), details: JSON.stringify({ changed: audit.changed, added: audit.added }) });
  checks.push({ name: "typecheck:no-syntax-errors", passed: tc.syntactic_errors.length === 0, details: tc.syntactic_errors.join("; ") });
  checks.push({ name: "typecheck:no-new-diagnostics-vs-baseline", passed: tc.new_diagnostics.length === 0, details: tc.new_diagnostics.join("; ") });
  const exit_codes = { differential_suite: diff.every((d) => d.passed) ? 0 : 1, security_suite: sec.every((d) => d.passed) ? 0 : 1, mutation_suite: mut.every((d) => d.passed) ? 0 : 1, typecheck_differential: tc.new_diagnostics.length === 0 && tc.syntactic_errors.length === 0 ? 0 : 1 };
  const failed = checks.filter((c) => !c.passed);
  const hashes = sourceHashes(); const b = binding(hashes);
  const deferred = Object.entries(DEFERRALS).map(([file, d]) => ({ file, deferred_to: d.gap, reason: d.reason }));
  const evidence = {
    phase: PHASE, sub_phase: SUB_PHASE, commit_sha: b.commit_sha, commit_binding: b.commit_binding, source_tree_sha256: b.source_tree_sha256,
    validator_version: VALIDATOR_VERSION, validator_sha256: sha256File(HERE), source_hashes: hashes,
    baseline: { mode: "write-once seal (verified, never written by this validator)", seal_file: rel(SEAL_FILE), sealed_at: SEAL.sealed_at, tree_manifest_sha256: SEAL.tree_manifest_sha256, certified_by: SEAL.certified_by, frozen_consumers: SEAL.frozen_consumers },
    commands: ["node scripts/antas/vault/gap/validate-vlt-gap-04-C.mjs", "in-process differential suite (sealed 04-B marketplace-vault route vs new source)", "in-process seeded-mutation suite", "in-process differential typecheck"],
    exit_codes,
    consumer_graph: { owner_modules: [...NEW_FILES, OWNER.repo], owner_symbols: st.usage, rewired_consumers: st.consumers, owner_importers: st.importers, moved_sql: st.repoSql },
    consumers_migrated: st.consumers.map((c) => c.file),
    deferred_consumers: deferred,
    name_only_references: st.nameOnly,
    table_access_census: st.census,
    duplicate_implementations: st.duplicates,
    diff_audit: audit,
    typecheck: { mode: "degraded-differential (project dependencies are not installed in the upload; full tsc/build is NOT executed)", before_total: tc.before_total, after_total: tc.after_total, syntactic_errors: tc.syntactic_errors, new_diagnostics: tc.new_diagnostics, before_by_class: tc.before_by_class, after_by_class: tc.after_by_class },
    tests: { differential_cases: diff.length, differential_passed: diff.filter((d) => d.passed).length, security_checks: sec.length, security_passed: sec.filter((d) => d.passed).length, mutations_seeded: mut.length, mutations_detected: mut.filter((d) => d.passed).length },
    notes: [
      "04-C rewires the one consumer that still performed Game persistence outside the Vault owner: the game branches of routes/marketplace-vault.ts (seller-ownership lookup + preview payload on POST /marketplace/vault/listings, ownership transfer inside the purchase transaction of POST /marketplace/vault/buy). The route keeps the transaction (BEGIN/COMMIT/ROLLBACK, wallet debit/credit, listing flip, ledger insert) and the HTTP response; only the game-specific decision moved.",
      "New owner module: vault/application/game/listing.ts; vault/infrastructure/repositories/game-repository.ts gains selectGameEntryForListing and transferGameEntryOwnership (the two SQL statements moved verbatim from the route).",
      "The entity/local/KYC branches of routes/marketplace-vault.ts are NOT game behavior and are intentionally unchanged. VLT-GAP-03-C deferred the KYC marketplace transfer to 'VLT-GAP-04', but GAP-04's declared sources are the Game files only; the remaining vault_entries/local_accounts/kyc_entries branches and the vault_market_listings persistence are therefore a carry-over that needs an owner (see deferred_carry_over).",
      "Remaining game-table accesses (schema DDL, mail-sync registry, global search, share registry, snapshot export/restore, re-encryption script) are explicit deferrals to the gap that owns each behavior; each is verified to still exist (no stale deferral) and any new unlisted access fails the census.",
      "credit-meter.ts and packages/domain-boundaries mention game_entries only as a comment / registry string and perform no table access (name_only_references).",
      "Public contract unchanged: every public route path from the 04-A inventory is still registered, the three route tables are byte-identical in method/path/middleware, and no frontend caller changed (components/game-entries.tsx and the pages are API clients of the unchanged endpoints).",
      "Behavior is preserved exactly, including pre-existing quirks: g.platform is read from a game_entries row that may not have that column (undefined is omitted by JSON.stringify, as before); the listing lookup uses SELECT * and the preview is built from the raw row.",
      "The project's own test suites and full tsc/build cannot run in this environment (dependencies are not installed); the differential suite executes the sealed 04-B route and the new tree under identical stubbed dependencies and compares every pool/client call, PDP call, status code and body. Run the repo's build and tests in CI before certifying.",
    ],
    deferred_carry_over: [{ file: "artifacts/api-server/src/routes/marketplace-vault.ts", what: "entity/local/KYC listing-ownership lookups and ownership transfers, plus vault_market_listings persistence", note: "03-C pointed the KYC part at VLT-GAP-04; GAP-04 covers Game only. Needs an owning gap (Vault marketplace boundary) so it is not lost." }],
    status: failed.length === 0 ? "PASS" : "FAIL", checks,
  };
  const body = { ...evidence }; delete body.generated_at;
  evidence.generated_at = new Date().toISOString(); evidence.evidence_body_sha256 = sha256(JSON.stringify(body));
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(EVIDENCE_FILE, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`${SUB_PHASE} ${evidence.status} — consumers=${st.consumers.length} census=${st.census.length} deferred=${deferred.length} diff-cases=${diff.length} security=${sec.length} mutations=${mut.filter((m) => m.passed).length}/${mut.length} static=${st.checks.length} (${Date.now() - started}ms)`);
  if (failed.length) { console.error(failed.map((c) => `- ${c.name}: ${c.details || "not satisfied"}`).join("\n")); process.exit(1); }
}
main().catch((e) => fail(`unhandled: ${e.stack ?? e}`));
