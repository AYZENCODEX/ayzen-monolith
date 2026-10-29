#!/usr/bin/env node
// VLT-GAP-04-B — Game Actual Move / Extract (source-derived, differential, fail-closed).
// Evidence: reports/antas/vault/gap/VLT-GAP-04/extraction-proof.json
// Baseline: reports/antas/vault/gap/VLT-GAP-04/baseline/ (04-A frozen pre-extraction sources)
//           reports/antas/vault/gap/VLT-GAP-04/baseline-04b/ (write-once tree seal, see freeze-vlt-gap-04-B-baseline.mjs)
//
// 04-B proves that the Game business implementation MOVED out of routes/game-entries.ts and routes/marketplace-game.ts into
// vault/{domain,security,infrastructure,application}, that the moved symbols are used, that no second implementation exists,
// and — by executing the frozen OLD routes and the NEW tree side by side under identical stubs — that behavior is unchanged.
// Wider consumer rewire (vault-shares, marketplace-vault, snapshot/restore, search, mail-sync, ... which touch game_entries
// directly) is 04-C; consumers_migrated stays empty here.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, sha256, sha256File, rel, rejectBypass, binding, walkFiles } from "./gap-common.mjs";
import { loadTs, summ, createEnv, createLoader, fakeRes, sqlKeyOf } from "./harness.mjs";

const VALIDATOR_VERSION = "1.0.0";
const PHASE = "VLT-GAP-04";
const SUB_PHASE = "VLT-GAP-04-B";
const HERE = fileURLToPath(import.meta.url);
const SRC = path.join(ROOT, "artifacts/api-server/src");
const ROUTES = path.join(SRC, "routes");
const EVIDENCE_DIR = path.join(ROOT, "reports/antas/vault/gap/VLT-GAP-04");
const EVIDENCE_FILE = path.join(EVIDENCE_DIR, "extraction-proof.json");
const BASE = path.join(EVIDENCE_DIR, "baseline");
const BASE04B = path.join(EVIDENCE_DIR, "baseline-04b");
const R = (p) => `artifacts/api-server/src/${p}`;

const fail = (m) => { console.error(`${SUB_PHASE} FAIL — ${m}`); process.exit(1); };
const bypass = rejectBypass(["--verify"]);
if (bypass.length) fail(`bypass mechanism rejected: ${bypass.join(", ")}`);
if (process.env.VALIDATION_DISABLED && !/^(0|false|no)$/i.test(process.env.VALIDATION_DISABLED)) fail("bypass mechanism rejected: env VALIDATION_DISABLED");
const ts = loadTs(ROOT);
if (!ts) fail("TypeScript compiler API unavailable (fail closed)");

// ── Layout under proof ────────────────────────────────────────────────────
const bsrc = (f) => path.join(BASE, "sources", `artifacts__api-server__src__${f.replace(/\//g, "__")}`);
const OLD = {
  entries: { file: "routes/game-entries.ts", baseline: bsrc("routes/game-entries.ts") },
  market: { file: "routes/marketplace-game.ts", baseline: bsrc("routes/marketplace-game.ts") },
};
const OLD_DOMAIN_BASELINE = bsrc("vault/domain/game.ts");
const NEW = {
  domain: "vault/domain/game.ts", security: "vault/security/game-ownership.ts",
  repo: "vault/infrastructure/repositories/game-repository.ts",
  entries: "vault/application/game/entries.ts", market: "vault/application/game/marketplace.ts",
};
const NEW_FILES = Object.values(NEW);
const ROUTE_FILES = [OLD.entries.file, OLD.market.file];
const CHANGED_ALLOWED = new Set([R(OLD.entries.file), R(OLD.market.file), R(NEW.domain)]);
const ADDED_ALLOWED = new Set([NEW.security, NEW.repo, NEW.entries, NEW.market].map(R));
const readNew = (f) => fs.readFileSync(path.join(SRC, f), "utf8");
const OLD_TEXT = {};
for (const k of Object.keys(OLD)) { if (!fs.existsSync(OLD[k].baseline)) fail(`frozen 04-A baseline source missing: ${rel(OLD[k].baseline)}`); OLD_TEXT[k] = fs.readFileSync(OLD[k].baseline, "utf8"); }
if (!fs.existsSync(path.join(BASE04B, "SEAL.json"))) fail("baseline-04b/SEAL.json missing; run freeze-vlt-gap-04-B-baseline.mjs on the 04-A tree before extraction");

// ── AST helpers ───────────────────────────────────────────────────────────
const parse = (name, text) => ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function walk(node, fn) { fn(node); ts.forEachChild(node, (c) => walk(c, fn)); }
function tokens(node, sf) { const t = []; (function w(n) { if (n.getChildCount(sf) === 0 && n.kind !== ts.SyntaxKind.EndOfFileToken) t.push(n.getText(sf)); else n.getChildren(sf).forEach(w); })(node); const out = []; t.forEach((x, i) => { if (x === "," && [")", "]", "}"].includes(t[i + 1])) return; out.push(x); }); return out; }
const fp = (node, sf) => sha256(tokens(node, sf).join(" "));
function topDecls(text, name) {
  const sf = parse(name, text); const out = [];
  for (const s of sf.statements) {
    const exported = !!s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (ts.isFunctionDeclaration(s) && s.name) out.push({ name: s.name.text, kind: "function", exported, body: s.body ? fp(s.body, sf) : null, lines: s.getText(sf).split("\n").length });
    else if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) { const fn = d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)); out.push({ name: d.name.getText(sf), kind: fn ? "function" : "const", exported, body: d.initializer ? fp(d.initializer, sf) : null, lines: s.getText(sf).split("\n").length }); }
    else if (ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s)) out.push({ name: s.name.text, kind: "type", exported, body: null, lines: 1 });
  }
  return out;
}
const importsOf = (text, name) => { const sf = parse(name, text); return sf.statements.filter(ts.isImportDeclaration).map((s) => s.moduleSpecifier.text); };
const SQLISH = /(?:SELECT |INSERT |UPDATE |DELETE |AND |ORDER BY|BEGIN|COMMIT|ROLLBACK|WHERE )/;
function sqlLiterals(text, name) {
  const sf = parse(name, text); const out = [];
  walk(sf, (n) => {
    let t = null;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) t = n.text;
    else if (ts.isTemplateExpression(n)) t = n.head.text + n.templateSpans.map((s) => "${}" + s.literal.text).join("");
    if (t && t.length >= 5 && SQLISH.test(t) && !/^[A-Za-z ,.!']+$/.test(t.trim().slice(0, 3) + "") ) out.push(t.replace(/\s+/g, " ").trim());
    else if (t && t.length >= 5 && SQLISH.test(t)) out.push(t.replace(/\s+/g, " ").trim());
  });
  return out;
}
function routeTable(text, name) {
  const sf = parse(name, text); const out = [];
  const norm = (a) => ts.isIdentifier(a) ? a.text : ts.isCallExpression(a) ? `${a.expression.getText(sf)}(${a.arguments[0] && ts.isStringLiteral(a.arguments[0]) ? a.arguments[0].text : ""})` : "<expr>";
  walk(sf, (n) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression) && n.expression.expression.text === "router" && ["get", "post", "put", "patch", "delete"].includes(n.expression.name.text)) {
      const a = n.arguments; const h = a[a.length - 1];
      out.push({ method: n.expression.name.text.toUpperCase(), path: a[0].text, middleware: [...a].slice(1, -1).map(norm), handler_lines: h.getText(sf).split("\n").length, handler_text: h.getText(sf) });
    }
  });
  return out;
}
const FORBIDDEN_IMPORTS_IN_ROUTE = [/@workspace\/db$/, /^drizzle-orm$/, /lib\/vault-crypto$/, /lib\/market-config$/, /lib\/policy\/policy-engine$/, /lib\/policy\/resource$/, /lib\/policy\/pep$/];
const INLINE_REFS = /\b(db|pool|sql|encryptField|decryptRows?|chargeCredits|getMarketConfig|safe|safeTags|PolicyEngine|authorize)\b|JSON\.parse|SELECT |INSERT |UPDATE |DELETE FROM/g;

// ── 1. Static extraction proof ────────────────────────────────────────────
const MAP = [
  ["entries", "safe", "repo", "safe", false], ["entries", "safeTags", "repo", "safeTags", false],
  ["entries", "gameEntryResource", "security", "gameEntryResource", false], ["entries", "requireGameEntryOwnership", "security", "requireGameEntryOwnership", false],
  ["market", "gameListingOwnerOrAdminEngine", "security", "gameListingOwnerOrAdminEngine", false],
  ["market", "ensureWallet", "repo", "ensureGameWallet", true], ["market", "parseListing", "market", "parseListing", true],
];
const HANDLER_MAP = [
  ["entries", "GET", "/game-entries", "entries", "listGameEntries"], ["entries", "POST", "/game-entries", "entries", "createGameEntry"],
  ["entries", "GET", "/game-entries/:id", "entries", "getGameEntry"], ["entries", "PUT", "/game-entries/:id", "entries", "editGameEntry"],
  ["entries", "DELETE", "/game-entries/:id", "entries", "removeGameEntry"],
  ["market", "GET", "/marketplace/game/listings", "market", "listGameMarketListings"], ["market", "POST", "/marketplace/game/listings", "market", "createGameMarketListing"],
  ["market", "POST", "/marketplace/game/buy", "market", "buyGameMarketListing"], ["market", "DELETE", "/marketplace/game/listings/:id", "market", "cancelGameMarketListing"],
  ["market", "GET", "/marketplace/game/stats", "market", "getGameMarketStats"],
];
const HANDLERS = HANDLER_MAP.map(([, m, p]) => [m, p]);
function staticProof() {
  const checks = []; const add = (name, passed, details = "") => checks.push({ name, passed: !!passed, details });
  const oldTxt = OLD_TEXT, newTxt = Object.fromEntries(Object.entries(NEW).map(([k, f]) => [k, readNew(f)]));
  const routeNew = { entries: readNew(OLD.entries.file), market: readNew(OLD.market.file) };
  const units = Object.fromEntries(Object.entries(NEW).map(([k, f]) => [f, topDecls(newTxt[k], f)]));
  const oldDecl = { entries: topDecls(oldTxt.entries, "old-entries"), market: topDecls(oldTxt.market, "old-market") };
  const newRouteDecl = { entries: topDecls(routeNew.entries, OLD.entries.file), market: topDecls(routeNew.market, OLD.market.file) };

  for (const f of NEW_FILES) add(`destination-exists:${f}`, fs.existsSync(path.join(SRC, f)));
  const fnCount = (k) => units[NEW[k]].filter((d) => d.kind === "function").length;
  add("destination:repository-has-executable-implementation", fnCount("repo") >= 14, `${fnCount("repo")} functions`);
  add("destination:application-entries-has-executable-implementation", fnCount("entries") >= 5, `${fnCount("entries")} functions`);
  add("destination:application-marketplace-has-executable-implementation", fnCount("market") >= 5, `${fnCount("market")} functions`);
  add("destination:security-has-executable-implementation", fnCount("security") >= 4, `${fnCount("security")} functions`);
  add("destination:domain-not-the-only-destination (not constants-only extraction)", fnCount("repo") + fnCount("entries") + fnCount("market") + fnCount("security") >= 28);

  // moved symbols
  const moved = [];
  for (const [ok, osym, nk, nsym, verbatim] of MAP) {
    const od = oldDecl[ok].find((d) => d.name === osym); const nd = units[NEW[nk]].find((d) => d.name === nsym);
    const remaining = newRouteDecl[ok].some((d) => d.name === osym);
    const row = { old_file: R(OLD[ok].file), old_symbol: osym, new_file: R(NEW[nk]), new_symbol: nsym, existed_in_old: !!od, remaining_in_old_file: remaining, defined_in_new: !!nd, verbatim_body: od && nd ? od.body === nd.body : false, verbatim_required: verbatim };
    moved.push(row);
    add(`moved:${osym}→${nsym}`, od && nd && !remaining && (!verbatim || row.verbatim_body), JSON.stringify({ existed: !!od, defined_new: !!nd, remaining, verbatim: row.verbatim_body }));
  }
  // engine registration statements moved
  const engineReg = (t) => (t.match(/gameListingOwnerOrAdminEngine\.registerRule\([^;]*;/g) ?? []).map((s) => s.replace(/\s+/g, " "));
  add("moved:engine-registrations-identical", JSON.stringify(engineReg(oldTxt.market)) === JSON.stringify(engineReg(newTxt.security)) && engineReg(oldTxt.market).length === 2, `${engineReg(oldTxt.market).length} rules`);

  // routes: table parity + thinness
  const before = { entries: routeTable(oldTxt.entries, "old-e"), market: routeTable(oldTxt.market, "old-m") };
  const after = { entries: routeTable(routeNew.entries, "new-e"), market: routeTable(routeNew.market, "new-m") };
  const tbl = (x) => x.map((r) => `${r.method} ${r.path} [${r.middleware.join(" > ")}]`);
  for (const k of ["entries", "market"]) add(`routes:table-unchanged:${k}`, JSON.stringify(tbl(before[k])) === JSON.stringify(tbl(after[k])), `${tbl(before[k]).length} routes`);
  const handlerRows = [];
  for (const [ok, m, p, nk, fn] of HANDLER_MAP) {
    const b = before[ok].find((r) => r.method === m && r.path === p), a = after[ok].find((r) => r.method === m && r.path === p);
    const refsB = (b?.handler_text.match(INLINE_REFS) ?? []).length, refsA = (a?.handler_text.match(INLINE_REFS) ?? []).length;
    const delegates = !!a && new RegExp(`\\b${fn}\\(`).test(a.handler_text);
    const defined = units[NEW[nk]].some((d) => d.name === fn && d.exported);
    handlerRows.push({ method: m, path: p, old_handler_lines: b?.handler_lines, new_handler_lines: a?.handler_lines, old_inline_refs: refsB, new_inline_refs: refsA, delegates_to: `${R(NEW[nk])}#${fn}` });
    add(`handler-extracted:${m} ${p}`, !!b && !!a && refsB > 0 && refsA === 0 && delegates && defined, JSON.stringify({ refsB, refsA, delegates, defined }));
  }
  for (const k of ["entries", "market"]) {
    const sf = parse(OLD[k].file, routeNew[k]); const extra = sf.statements.filter((s) => !(ts.isImportDeclaration(s) || ts.isExportAssignment(s) || (ts.isVariableStatement(s) && s.declarationList.declarations.every((d) => d.name.getText(sf) === "router")) || (ts.isExpressionStatement(s) && /^router\./.test(s.expression.getText(sf)))));
    add(`route-file-is-adapter-only:${k}`, extra.length === 0, extra.map((s) => s.getText(sf).slice(0, 60)).join(" | "));
    const bad = importsOf(routeNew[k], OLD[k].file).filter((i) => FORBIDDEN_IMPORTS_IN_ROUTE.some((rx) => rx.test(i)));
    add(`route-has-no-persistence-crypto-policy-imports:${k}`, bad.length === 0, bad.join(", "));
    add(`route-old-file-did-own-logic-before:${k}`, (oldTxt[k].match(INLINE_REFS) ?? []).length > 20, `${(oldTxt[k].match(INLINE_REFS) ?? []).length} refs in baseline`);
  }
  // SQL parity + duplicates
  const oldSql = [...sqlLiterals(oldTxt.entries, "oe"), ...sqlLiterals(oldTxt.market, "om")].sort();
  const newPer = Object.fromEntries(Object.entries(NEW).map(([k, f]) => [f, sqlLiterals(newTxt[k], f)]));
  const newSql = Object.values(newPer).flat().sort();
  const routeSql = [...sqlLiterals(routeNew.entries, "ne"), ...sqlLiterals(routeNew.market, "nm")];
  const uniq = (a) => [...new Set(a)].sort();
  add("sql:distinct-statement-set-identical-old-vs-new", JSON.stringify(uniq(oldSql)) === JSON.stringify(uniq(newSql)), `old=${oldSql.length} (${uniq(oldSql).length} distinct) new=${newSql.length} (${uniq(newSql).length} distinct)`);
  add("sql:no-sql-left-in-routes", routeSql.length === 0, routeSql.join(" | "));
  add("sql:persistence-only-in-repository", [NEW.domain, NEW.security, NEW.entries, NEW.market].every((f) => newPer[f].length === 0), Object.entries(newPer).filter(([f, v]) => f !== NEW.repo && v.length).map(([f]) => f).join(", "));
  const seen = new Map(); for (const s of newSql) seen.set(s, (seen.get(s) ?? 0) + 1);
  const oldSeen = new Map(); for (const s of oldSql) oldSeen.set(s, (oldSeen.get(s) ?? 0) + 1);
  const dupSql = [...seen].filter(([s, n]) => n > (oldSeen.get(s) ?? 0)).map(([s]) => s.slice(0, 80));
  add("duplicates:no-sql-statement-implemented-twice", dupSql.length === 0, dupSql.join(" | "));
  const byBody = new Map(); for (const [f, ds] of Object.entries(units)) for (const d of ds) if (d.body && d.kind === "function" && d.lines > 2) byBody.set(d.body, [...(byBody.get(d.body) ?? []), `${f}#${d.name}`]);
  const dupFn = [...byBody.values()].filter((v) => v.length > 1);
  add("duplicates:no-function-body-duplicated-across-destination", dupFn.length === 0, JSON.stringify(dupFn));
  const oldNames = [...oldDecl.entries, ...oldDecl.market].filter((d) => d.kind !== "type").map((d) => d.name).filter((n) => n !== "router");
  const reDecl = oldNames.filter((n) => [...newRouteDecl.entries, ...newRouteDecl.market].some((d) => d.name === n));
  add("duplicates:old-business-symbols-not-redeclared-in-routes", reDecl.length === 0, reDecl.join(", "));

  // every exported destination function is used somewhere (no copied-but-unused code)
  const allSrc = { ...Object.fromEntries(NEW_FILES.map((f) => [f, readNew(f)])), ...Object.fromEntries(ROUTE_FILES.map((f) => [f, readNew(f)])) };
  const unused = [];
  for (const [f, ds] of Object.entries(units)) for (const d of ds) {
    if (d.kind === "type" || !d.exported) continue;
    const uses = Object.entries(allSrc).reduce((n, [g, t]) => n + (t.match(new RegExp(`\\b${d.name}\\b`, "g")) ?? []).length - (g === f ? 1 : 0), 0);
    if (uses < 1) unused.push(`${f}#${d.name}`);
  }
  add("usage:every-exported-destination-symbol-is-used", unused.length === 0, unused.join(", "));

  // layering
  const imp = Object.fromEntries(Object.entries(NEW).map(([k, f]) => [k, importsOf(newTxt[k], f)]));
  add("layering:domain-imports-nothing", imp.domain.length === 0, imp.domain.join(", "));
  add("layering:repository-only-db-and-drizzle", imp.repo.every((i) => ["@workspace/db", "drizzle-orm"].includes(i)), imp.repo.join(", "));
  add("layering:application-does-not-touch-http-or-db-directly", [...imp.entries, ...imp.market].every((i) => !/^express$|@workspace\/db|drizzle-orm|\/routes\//.test(i)) && !/\b(Request|Response)\b/.test(newTxt.entries + newTxt.market), "");
  add("layering:application-reaches-persistence-only-via-repository", [imp.entries, imp.market].every((l) => l.some((i) => /repositories\/game-repository$/.test(i))), "");
  add("layering:no-vault-module-imports-a-route", Object.values(imp).flat().every((i) => !/\/routes\//.test(i)), "");
  add("layering:security-uses-repository-not-inline-db", !/@workspace\/db|drizzle-orm/.test(newTxt.security) && imp.security.some((i) => /game-repository$/.test(i)), "");
  // security scoping in SQL
  const repoText = newTxt.repo;
  const ownerScoped = ["findGameEntryById", "updateGameEntry", "deleteGameEntry", "selectGameEntries"].every((fnName) => { const m = repoText.match(new RegExp(`function ${fnName}[\\s\\S]*?\\n}\\n`)); return m && /user_id = \$\{userId\}/.test(m[0]); });
  add("security:repository-scopes-every-game_entries-read-write-by-user_id", ownerScoped);
  add("security:wallet-debit-is-balance-guarded-and-listing-flip-is-status-guarded", /balance >= \$1/.test(repoText) && /status='sold'[^"]*WHERE id=\$2 AND status='active'/.test(repoText));
  add("security:purchase-transaction-rolls-back-on-each-failure-path", (repoText.match(/ROLLBACK/g) ?? []).length >= 3 && /COMMIT/.test(repoText) && /finally\s*{\s*client\.release\(\)/.test(repoText));
  add("security:sensitive-fields-decrypted-and-encrypted-in-application", /decryptRows?\(/.test(newTxt.entries) && (newTxt.entries.match(/encryptField\(/g) ?? []).length >= 8 && /GAME_SENSITIVE_FIELDS/.test(newTxt.entries));
  add("domain:constants-preserved", /GAME_SENSITIVE_FIELDS/.test(newTxt.domain) && /GAME_ENTRY_OWNER_SENTINEL_NONE = -1/.test(newTxt.domain) && fs.readFileSync(OLD_DOMAIN_BASELINE, "utf8").includes("account_password"));
  // consumer census (04-C scope) — recorded, not asserted migrated
  const srcFiles = walkFiles(SRC, [], (p) => /\.(ts|tsx)$/.test(p));
  const routeImporters = [], symbolUsers = [];
  for (const f of srcFiles) { const t = fs.readFileSync(f, "utf8"); const k = rel(f);
    if (/from\s+["'](?:\.{1,2}\/)+(?:routes\/)?(game-entries|marketplace-game)["']/.test(t)) routeImporters.push(k);
    if (!k.includes("/vault/") && !ROUTE_FILES.some((rf) => k.endsWith(rf)) && /\b(gameEntryResource|requireGameEntryOwnership|gameListingOwnerOrAdminEngine)\b/.test(t)) symbolUsers.push(k); }
  const named = routeImporters.filter((f) => /import\s*{[^}]*}\s*from\s+["'](?:\.{1,2}\/)+(?:routes\/)?(game-entries|marketplace-game)["']/.test(fs.readFileSync(path.join(ROOT, f), "utf8")));
  add("consumers:no-importer-depends-on-a-named-export-of-the-two-routes", named.length === 0, named.join(", "));
  add("consumers:no-outside-file-uses-the-moved-ownership-symbols", symbolUsers.length === 0, symbolUsers.join(", "));
  return { checks, moved, handlerRows, units, routeBefore: before, routeAfter: after, oldSqlCount: oldSql.length, newSqlCount: newSql.length, duplicates: { sql: dupSql, functions: dupFn, redeclared: reDecl }, routeImporters };
}

// ── 2. Differential harness (frozen OLD routes vs NEW tree, identical stubs) ─
const K = sqlKeyOf;
const rows = (...r) => ({ value: { rows: r, rowCount: r.length } });
const cnt = (n) => ({ value: { rows: [], rowCount: n } });
const boom = (m = "boom") => ({ throw: m });
function makeEnv(c) {
  const env = createEnv(Object.fromEntries(Object.entries(c.db ?? {}).map(([k, v]) => [`db.execute:${k}`, v]))); const log = env.log;
  const pq = new Map(Object.entries(c.pool ?? {}).map(([k, v]) => [k, [...v]]));
  const nextPool = (key) => { const q = pq.get(key); if (!q || !q.length) { log.push(["pool.await", key, "default"]); return { rows: [], rowCount: 0 }; } const it = q.shift(); log.push(["pool.await", key, it.throw ? { throw: String(it.throw) } : "ok"]); if (it.throw) throw new Error(it.throw); return it.value; };
  const norm = (t) => String(t).replace(/\s+/g, " ").trim();
  const client = { query: async (t, p) => { log.push(["client.query", summ([norm(t), p])]); if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(norm(t))) return { rows: [], rowCount: 0 }; return nextPool("TX:" + K(t)); }, release: () => log.push(["client.release"]) };
  const pool = { query: async (t, p) => { log.push(["pool.query", summ([norm(t), p])]); return nextPool(K(t)); }, connect: async () => { log.push(["pool.connect"]); return client; } };
  env.stubs["@workspace/db"] = { ...env.stubs["@workspace/db"], pool };
  const isNil = (v) => v === null || v === undefined;
  env.stubs["lib/vault-crypto"] = {
    encryptField: (v) => { log.push(["encryptField", summ(v)]); return isNil(v) ? v : `enc(${v})`; },
    decryptRow: (r, f) => { log.push(["decryptRow", summ([r, f])]); return { ...r, __dec: [...f] }; },
    decryptRows: (r, f) => { log.push(["decryptRows", summ([r, f])]); return r.map((x) => ({ ...x, __dec: [...f] })); },
  };
  env.stubs["lib/market-config"] = { getMarketConfig: async (t) => { log.push(["getMarketConfig", t]); return { marketType: t, feePct: c.feePct ?? 5, enabled: c.enabled !== false }; } };
  env.stubs["lib/policy/pep"] = { authorize: async (a) => { log.push(["authorize", summ({ action: a.action, resource: a.resource, engine: a.engine?.__engine })]); return { decision: { effect: c.auth ?? "ALLOW" } }; } };
  env.stubs["lib/policy/resource"] = { createResourceOwnershipRule: () => ({ __rule: "resource-ownership" }), createRoleOverrideRule: (roles) => ({ __rule: "role-override", roles }) };
  env.stubs["lib/policy/policy-engine"] = { PolicyEngine: class { constructor(o) { this.__engine = { rules: [], onDecision: summ(o?.onDecision) }; } registerRule(n, r) { this.__engine.rules.push([n, summ(r)]); log.push(["registerRule", n, summ(r)]); } } };
  return env;
}
const loadOld = (which, env) => createLoader({ ts, root: ROOT, srcDir: SRC, env }).loadText(OLD_TEXT[which], OLD[which].file, ROUTES);
const loadNew = (which, env) => createLoader({ ts, root: ROOT, srcDir: SRC, env }).loadFile(path.join(SRC, OLD[which].file));
const U = 7;
const E = { l: (...a) => K(a[0]) };
const ENT = { which: "entries" }, MKT = { which: "market" };
const body11 = { category: "MOBA", username: "o'brien", accountPassword: "pw'1", notes: "n", email: "e@x", emailPassword: "ep", email2fa: "2fa", emailBackupCode: "bc", rank: "Gold", level: "9", accountAge: "3y", tags: ["a", " b ", "", 3, "it's"] };
const lst = { id: 5, seller_id: 9, price: "100", title: "Acct", photos: "[\"p\"]", details: "{\"k\":1}", status: "active" };
const buyPool = (over = {}) => ({
  [K("SELECT * FROM game_market_listings")]: [rows(lst)], [K("SELECT balance FROM marketplace_wallets")]: [rows({ balance: "500" })],
  ...over,
});
const CASES = [
  // ── game-entries ──
  { ...ENT, name: "GET /game-entries list", cat: "success", method: "GET", path: "/game-entries", req: { query: {} }, db: { [K("SELECT * FROM game_entries")]: [rows({ id: 1, account_password: "x" })] } },
  { ...ENT, name: "GET /game-entries category with quote", cat: "security", method: "GET", path: "/game-entries", req: { query: { category: "O'Neil'; DROP TABLE game_entries;--" } } },
  { ...ENT, name: "GET /game-entries db error", cat: "failure", method: "GET", path: "/game-entries", req: { query: {} }, db: { [K("SELECT * FROM game_entries")]: [boom("pg down")] } },
  { ...ENT, name: "POST /game-entries create full", cat: "success", method: "POST", path: "/game-entries", req: { body: body11 }, db: { [K("INSERT INTO game_entries (user_id,")]: [rows({ id: 2, account_password: "enc(pw'1)" })] } },
  { ...ENT, name: "POST /game-entries create defaults", cat: "success", method: "POST", path: "/game-entries", req: { body: {} }, db: { [K("INSERT INTO game_entries (user_id,")]: [rows({ id: 3 })] } },
  { ...ENT, name: "POST /game-entries empty category 400", cat: "failure", method: "POST", path: "/game-entries", req: { body: { category: "" } } },
  { ...ENT, name: "POST /game-entries injection in fields", cat: "security", method: "POST", path: "/game-entries", req: { body: { category: "x", username: "'; DELETE FROM users;--", tags: ["'); DROP"] } }, db: { [K("INSERT INTO game_entries (user_id,")]: [rows({ id: 4 })] } },
  { ...ENT, name: "POST /game-entries db error", cat: "failure", method: "POST", path: "/game-entries", req: { body: body11 }, db: { [K("INSERT INTO game_entries (user_id,")]: [boom()] } },
  { ...ENT, name: "POST /game-entries missing body throws", cat: "failure", method: "POST", path: "/game-entries", req: { body: undefined }, thrownOnly: true },
  { ...ENT, name: "GET /game-entries/:id found + charged", cat: "success", method: "GET", path: "/game-entries/:id", req: { params: { id: "12" } }, db: { [K("SELECT * FROM game_entries WHERE")]: [rows({ id: 12, account_password: "x" })] } },
  { ...ENT, name: "GET /game-entries/:id not found (no charge)", cat: "failure", method: "GET", path: "/game-entries/:id", req: { params: { id: "12" } } },
  { ...ENT, name: "GET /game-entries/:id NaN 400", cat: "failure", method: "GET", path: "/game-entries/:id", req: { params: { id: "abc" } } },
  { ...ENT, name: "GET /game-entries/:id db error", cat: "failure", method: "GET", path: "/game-entries/:id", req: { params: { id: "12" } }, db: { [K("SELECT * FROM game_entries WHERE")]: [boom()] } },
  { ...ENT, name: "PUT /game-entries/:id update", cat: "success", method: "PUT", path: "/game-entries/:id", req: { params: { id: "3" }, body: body11 }, db: { [K("UPDATE game_entries SET category")]: [rows({ id: 3 })] } },
  { ...ENT, name: "PUT /game-entries/:id tags undefined keeps column", cat: "success", method: "PUT", path: "/game-entries/:id", req: { params: { id: "3" }, body: { category: "x" } }, db: { [K("UPDATE game_entries SET category")]: [rows({ id: 3 })] } },
  { ...ENT, name: "PUT /game-entries/:id no row 404", cat: "failure", method: "PUT", path: "/game-entries/:id", req: { params: { id: "3" }, body: body11 } },
  { ...ENT, name: "PUT /game-entries/:id NaN 400", cat: "failure", method: "PUT", path: "/game-entries/:id", req: { params: { id: "x" }, body: body11 } },
  { ...ENT, name: "PUT /game-entries/:id other user's row not updated", cat: "security", method: "PUT", path: "/game-entries/:id", req: { params: { id: "3" }, body: { category: "x" }, userId: 99 } },
  { ...ENT, name: "DELETE /game-entries/:id", cat: "success", method: "DELETE", path: "/game-entries/:id", req: { params: { id: "3" } } },
  { ...ENT, name: "DELETE /game-entries/:id NaN 400", cat: "failure", method: "DELETE", path: "/game-entries/:id", req: { params: { id: "zz" } } },
  { ...ENT, name: "DELETE /game-entries/:id db error", cat: "failure", method: "DELETE", path: "/game-entries/:id", req: { params: { id: "3" } }, db: { [K("DELETE FROM game_entries WHERE")]: [boom()] } },
  // ownership builders + deny handlers (one per protected route)
  ...[["GET", 0, "Not found"], ["PUT", 0, "Not found or forbidden"], ["DELETE", 0, "silent success"]].map(([m]) => ({ ...ENT, name: `${m} /game-entries/:id ownership builder owned`, cat: "security", method: m, path: "/game-entries/:id", kind: "builder", req: { params: { id: "8" } }, db: { [K("SELECT user_id FROM game_entries")]: [rows({ user_id: U })] } })),
  { ...ENT, name: "ownership builder missing row → sentinel", cat: "security", method: "GET", path: "/game-entries/:id", kind: "builder", req: { params: { id: "8" } } },
  { ...ENT, name: "ownership builder non-numeric id → sentinel, no query", cat: "security", method: "GET", path: "/game-entries/:id", kind: "builder", req: { params: { id: "nope" } } },
  { ...ENT, name: "GET deny → 404 Not found", cat: "security", method: "GET", path: "/game-entries/:id", kind: "deny" },
  { ...ENT, name: "PUT deny → 404 Not found or forbidden", cat: "security", method: "PUT", path: "/game-entries/:id", kind: "deny" },
  { ...ENT, name: "DELETE deny → silent success", cat: "security", method: "DELETE", path: "/game-entries/:id", kind: "deny" },
  // ── marketplace-game ──
  { ...MKT, name: "GET listings filtered", cat: "success", method: "GET", path: "/marketplace/game/listings", req: { query: { limit: "10", offset: "5", platform: "pc", game_name: "Val", min_price: "5", max_price: "50" } }, pool: { [K("SELECT gl.*, u.username AS")]: [rows(lst)], [K("SELECT COUNT(*) FROM game_market_listings")]: [rows({ count: "1" })] } },
  { ...MKT, name: "GET listings defaults", cat: "success", method: "GET", path: "/marketplace/game/listings", req: { query: {} }, pool: { [K("SELECT gl.*, u.username AS")]: [rows({ ...lst, photos: null, details: null })], [K("SELECT COUNT(*) FROM game_market_listings")]: [rows({ count: "4" })] } },
  { ...MKT, name: "GET listings db error", cat: "failure", method: "GET", path: "/marketplace/game/listings", req: { query: {} }, pool: { [K("SELECT gl.*, u.username AS")]: [boom("pg")] } },
  { ...MKT, name: "GET listings bad JSON in row → 500", cat: "failure", method: "GET", path: "/marketplace/game/listings", req: { query: {} }, pool: { [K("SELECT gl.*, u.username AS")]: [rows({ ...lst, photos: "{bad" })], [K("SELECT COUNT(*) FROM game_market_listings")]: [rows({ count: "1" })] } },
  { ...MKT, name: "GET listings filter injection stays parameterised", cat: "security", method: "GET", path: "/marketplace/game/listings", req: { query: { platform: "pc' OR 1=1 --", game_name: "%'; DROP" } }, pool: { [K("SELECT COUNT(*) FROM game_market_listings")]: [rows({ count: "0" })] } },
  { ...MKT, name: "POST listings create", cat: "success", method: "POST", path: "/marketplace/game/listings", req: { body: { game_name: " Val ", title: " T ", price: "10", description: " d ", photos: ["a"], details: { x: 1 } } }, pool: { [K("INSERT INTO game_market_listings (seller_id,")]: [rows(lst)] } },
  { ...MKT, name: "POST listings defaults", cat: "success", method: "POST", path: "/marketplace/game/listings", req: { body: { game_name: "G", title: "T", price: 3 } }, pool: { [K("INSERT INTO game_market_listings (seller_id,")]: [rows(lst)] } },
  { ...MKT, name: "POST listings game_name missing", cat: "failure", method: "POST", path: "/marketplace/game/listings", req: { body: { title: "T", price: 3 } } },
  { ...MKT, name: "POST listings title blank", cat: "failure", method: "POST", path: "/marketplace/game/listings", req: { body: { game_name: "G", title: "  ", price: 3 } } },
  { ...MKT, name: "POST listings price invalid", cat: "failure", method: "POST", path: "/marketplace/game/listings", req: { body: { game_name: "G", title: "T", price: -1 } } },
  { ...MKT, name: "POST listings photos not array", cat: "failure", method: "POST", path: "/marketplace/game/listings", req: { body: { game_name: "G", title: "T", price: 1, photos: "x" } } },
  { ...MKT, name: "POST listings market disabled 403", cat: "security", method: "POST", path: "/marketplace/game/listings", req: { body: { game_name: "G", title: "T", price: 1 } }, enabled: false },
  { ...MKT, name: "POST listings db error", cat: "failure", method: "POST", path: "/marketplace/game/listings", req: { body: { game_name: "G", title: "T", price: 1 } }, pool: { [K("INSERT INTO game_market_listings (seller_id,")]: [boom()] } },
  { ...MKT, name: "POST buy ok", cat: "success", method: "POST", path: "/marketplace/game/buy", req: { body: { listing_id: 5 } }, pool: buyPool(), feePct: 7.5 },
  { ...MKT, name: "POST buy listing_id missing", cat: "failure", method: "POST", path: "/marketplace/game/buy", req: { body: {} } },
  { ...MKT, name: "POST buy listing not found 404", cat: "failure", method: "POST", path: "/marketplace/game/buy", req: { body: { listing_id: 5 } } },
  { ...MKT, name: "POST buy own listing 400", cat: "security", method: "POST", path: "/marketplace/game/buy", req: { body: { listing_id: 5 }, userId: 9 }, pool: buyPool() },
  { ...MKT, name: "POST buy insufficient pre-check 400", cat: "failure", method: "POST", path: "/marketplace/game/buy", req: { body: { listing_id: 5 } }, pool: buyPool({ [K("SELECT balance FROM marketplace_wallets")]: [rows({ balance: "1" })] }) },
  { ...MKT, name: "POST buy insufficient inside tx (concurrent) → rollback 400", cat: "security", method: "POST", path: "/marketplace/game/buy", req: { body: { listing_id: 5 } }, pool: buyPool({ ["TX:" + K("UPDATE marketplace_wallets SET balance=balance-$1,")]: [cnt(0)] }) },
  { ...MKT, name: "POST buy listing already sold inside tx (concurrent) → rollback 409", cat: "security", method: "POST", path: "/marketplace/game/buy", req: { body: { listing_id: 5 } }, pool: buyPool({ ["TX:" + K("UPDATE marketplace_wallets SET balance=balance-$1,")]: [cnt(1)], ["TX:" + K("UPDATE game_market_listings SET status='sold',")]: [cnt(0)] }) },
  { ...MKT, name: "POST buy tx step throws → rollback 500", cat: "failure", method: "POST", path: "/marketplace/game/buy", req: { body: { listing_id: 5 } }, pool: buyPool({ ["TX:" + K("UPDATE marketplace_wallets SET balance=balance-$1,")]: [cnt(1)], ["TX:" + K("UPDATE game_market_listings SET status='sold',")]: [rows({ id: 5 })], ["TX:" + K("INSERT INTO marketplace_transactions (market_type,listing_id,buyer_id,seller_id,amount,fee,net_amount)")]: [boom("ledger")] }) },
  { ...MKT, name: "POST buy full tx success records ledger", cat: "success", method: "POST", path: "/marketplace/game/buy", req: { body: { listing_id: 5 } }, pool: buyPool({ ["TX:" + K("UPDATE marketplace_wallets SET balance=balance-$1,")]: [cnt(1)], ["TX:" + K("UPDATE game_market_listings SET status='sold',")]: [rows({ id: 5 })] }) },
  { ...MKT, name: "DELETE listing not found 404", cat: "failure", method: "DELETE", path: "/marketplace/game/listings/:id", req: { params: { id: "5" } } },
  { ...MKT, name: "DELETE listing owner/admin ok", cat: "success", method: "DELETE", path: "/marketplace/game/listings/:id", req: { params: { id: "5" } }, pool: { [K("SELECT * FROM game_market_listings")]: [rows(lst)] } },
  { ...MKT, name: "DELETE listing array id ok", cat: "success", method: "DELETE", path: "/marketplace/game/listings/:id", req: { params: { id: ["5", "6"] } }, pool: { [K("SELECT * FROM game_market_listings")]: [rows(lst)] } },
  { ...MKT, name: "DELETE listing not owner/admin → 403, no cancel write", cat: "security", method: "DELETE", path: "/marketplace/game/listings/:id", req: { params: { id: "5" } }, pool: { [K("SELECT * FROM game_market_listings")]: [rows(lst)] }, auth: "DENY" },
  { ...MKT, name: "DELETE listing db error", cat: "failure", method: "DELETE", path: "/marketplace/game/listings/:id", req: { params: { id: "5" } }, pool: { [K("SELECT * FROM game_market_listings")]: [boom()] } },
  { ...MKT, name: "GET stats", cat: "success", method: "GET", path: "/marketplace/game/stats", req: {}, pool: { [K("SELECT COUNT(*) as cnt,")]: [rows({ cnt: "2", floor: "3", avg_price: "4.5" })], [K("SELECT SUM(amount) as vol,")]: [rows({ vol: "90", sales: "6" })] } },
  { ...MKT, name: "GET stats empty (null floor/vol)", cat: "success", method: "GET", path: "/marketplace/game/stats", req: {}, pool: { [K("SELECT COUNT(*) as cnt,")]: [rows({ cnt: "0", floor: null, avg_price: null })], [K("SELECT SUM(amount) as vol,")]: [rows({ vol: null, sales: "0" })] } },
  { ...MKT, name: "GET stats db error", cat: "failure", method: "GET", path: "/marketplace/game/stats", req: {}, pool: { [K("SELECT COUNT(*) as cnt,")]: [boom()] } },
];
async function runCase(loader, c, overrides) {
  const env = makeEnv(c); if (overrides) env.overrides = overrides;
  try { loader(c.which, env); } catch (e) { return { loadError: String(e.message ?? e), log: env.log }; }
  const loadLog = env.log.splice(0); // module-load side effects (engine construction/rule registration) are compared separately
  const route = env.routes.find((r) => r.method === c.method && r.path === c.path);
  if (!route) return { missing: `${c.method} ${c.path}` };
  const chain = route.stack.slice(0, -1).map((f) => (f.__ownership ? `own(${f.__ownership.action})` : f.__stub ?? f.name));
  const own = route.stack.find((f) => f.__ownership);
  const req = { user: { userId: c.req?.userId ?? U }, params: c.req?.params ?? {}, query: c.req?.query ?? {}, body: "body" in (c.req ?? {}) ? c.req.body : {} };
  const res = fakeRes(); let thrown = null, extra;
  try {
    if (c.kind === "builder") extra = await own.__ownership.builder(req);
    else if (c.kind === "deny") { own.__ownership.opts.onDeny(req, res); }
    else await route.stack[route.stack.length - 1](req, res);
  } catch (e) { thrown = e?.name ?? "Error"; }
  const statusCode = res.statusCode ?? 200; // Express default when a handler calls res.json() without res.status()
  if (c.thrownOnly) return { thrown, chain, log: env.log.length ? "interactions" : "none", statusCode: res.statusCode };
  return { statusCode, loadLog: c.which === "market" ? loadLog : undefined, body: res.body, thrown, chain, extra: summ(extra), log: env.log, own: own ? summ({ action: own.__ownership.action, opts: Object.keys(own.__ownership.opts).sort() }) : null };
}
const canon = (r) => JSON.stringify(r) ?? "undefined";
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
// Explicit security/behavior assertions on the NEW tree (not merely "same as old")
async function securitySuite() {
  const res = []; const add = (name, passed, details = "") => res.push({ name: `security:${name}`, passed: !!passed, details });
  const get = async (n) => { const i = CASES.findIndex((c) => c.name === n); if (i < 0) throw new Error(`case ${n}`); return runCase(loadNew, CASES[i]); };
  const L = (r) => r.log.map((e) => JSON.stringify(e));
  const has = (r, s) => L(r).some((x) => x.includes(s));
  let r = await get("POST /game-entries create full");
  add("all-four-sensitive-fields-encrypted-on-create", ["pw'1", "ep", "2fa", "bc"].every((v) => has(r, `["encryptField","${v.replace(/'/g, "'")}"]`)) , "");
  add("create-response-is-decrypted-with-sensitive-field-list", r.body?.__dec?.length === 4 && r.statusCode === 201);
  r = await get("GET /game-entries/:id found + charged"); add("view-charges-credits-only-after-row-found", has(r, "chargeCredits") && r.body?._credits?.charged === 5);
  r = await get("GET /game-entries/:id not found (no charge)"); add("view-404-never-touches-ledger", !has(r, "chargeCredits") && r.statusCode === 404);
  r = await get("PUT /game-entries/:id other user's row not updated"); add("update-sql-scoped-by-requesting-user", has(r, "AND user_id = 99") && r.statusCode === 404);
  r = await get("GET /game-entries list"); add("list-sql-scoped-by-user", has(r, "WHERE user_id = 7"));
  r = await get("GET /game-entries category with quote"); add("category-quote-escaped", has(r, "O''Neil''; DROP TABLE game_entries;--"));
  r = await get("ownership builder missing row → sentinel"); add("missing-row-resolves-to-no-owner-sentinel", r.extra?.ownerId === -1);
  r = await get("ownership builder non-numeric id → sentinel, no query"); add("non-numeric-id-does-no-db-lookup", r.extra?.ownerId === -1 && !L(r).some((x) => x.includes("db.execute")));
  r = await get("GET /game-entries/:id ownership builder owned"); add("owner-resolved-from-game_entries.user_id", r.extra?.ownerId === U && r.extra?.type === "game_entry");
  r = await get("DELETE deny → silent success"); add("delete-deny-is-quiet-no-op-not-404", r.statusCode === undefined ? true : r.body?.success === true);
  r = await get("POST buy own listing 400"); add("cannot-buy-own-listing-and-no-writes", r.statusCode === 400 && !has(r, "pool.connect"));
  r = await get("POST buy insufficient inside tx (concurrent) → rollback 400"); add("concurrent-insufficient-balance-rolls-back-and-releases", has(r, "ROLLBACK") && !has(r, "COMMIT") && has(r, "client.release") && r.statusCode === 400);
  r = await get("POST buy listing already sold inside tx (concurrent) → rollback 409"); add("concurrent-double-sale-rolls-back-and-releases", has(r, "ROLLBACK") && !has(r, "COMMIT") && has(r, "client.release") && r.statusCode === 409);
  r = await get("POST buy tx step throws → rollback 500"); add("tx-failure-rolls-back-and-releases-connection", has(r, "ROLLBACK") && has(r, "client.release") && r.statusCode === 500);
  r = await get("POST buy full tx success records ledger"); add("successful-purchase-commits-once-with-fee-and-net", L(r).filter((x) => x.includes("COMMIT")).length === 1 && r.body?.fee === 7 * 0 + 5 && r.body?.net === 95);
  r = await get("DELETE listing not owner/admin → 403, no cancel write"); add("non-owner-cannot-cancel-listing", r.statusCode === 403 && !has(r, "status='cancelled'"));
  r = await get("DELETE listing owner/admin ok"); add("cancel-decision-routed-through-pdp-with-owner-or-admin-engine", has(r, "marketplace.game_listing.cancel") && has(r, "role-override") && has(r, "resource-ownership") && has(r, "\"ownerId\":9"));
  r = await get("POST listings market disabled 403"); add("disabled-market-blocks-listing-creation", r.statusCode === 403 && !has(r, "INSERT INTO game_market_listings"));
  r = await get("GET listings filter injection stays parameterised"); add("listing-filters-are-bound-parameters-not-interpolated", has(r, "gl.platform = $1") && has(r, "gl.game_name ILIKE $2") && !L(r).some((x) => x.includes("OR 1=1") && x.includes("SELECT gl.*") && !x.includes("[\"pc' OR 1=1 --\"")));
  return res;
}
// Pure-function parity (old private helpers vs their new owners)
async function unitParity() {
  const res = []; const add = (name, passed, details = "") => res.push({ name: `unit:${name}`, passed: !!passed, details });
  const env = makeEnv({});
  const priv = (which, names) => createLoader({ ts, root: ROOT, srcDir: SRC, env }).loadText(`${OLD_TEXT[which]}\nexport const __private = { ${names.join(", ")} };\n`, OLD[which].file, ROUTES).__private;
  const po = priv("entries", ["safe", "safeTags"]);
  const newRepoText = readNew(NEW.repo);
  const pn = createLoader({ ts, root: ROOT, srcDir: SRC, env }).loadText(`${newRepoText}\nexport const __private = { safe, safeTags };\n`, NEW.repo, path.join(SRC, "vault/infrastructure/repositories")).__private;
  const vals = [null, undefined, "", "abc", "O'Brien", "a''b", 0, 5, true, false, { a: 1 }, "'; DROP TABLE x;--", "back\\slash", "\n", "  "];
  add("safe() identical over 15 inputs", vals.every((v) => po.safe(v) === pn.safe(v)));
  const tagIn = [undefined, null, "x", [], ["a", " b ", "", 3, "it's"], [" "], ["a'b", "c"], [null, undefined], "['a']"];
  add("safeTags() identical over 9 inputs", tagIn.every((v) => po.safeTags(v) === pn.safeTags(v)));
  const pm = priv("market", ["parseListing"]).parseListing; const pl = createLoader({ ts, root: ROOT, srcDir: SRC, env }).loadFile(path.join(SRC, NEW.market)).parseListing;
  const rowsIn = [{ photos: "[1]", details: "{\"a\":1}", id: 1 }, { photos: null, details: null }, { photos: "", details: "" }, { photos: "{bad" }, { details: "x" }];
  const tryP = (f, r) => { try { return JSON.stringify(f(r)); } catch { return "THROW"; } };
  add("parseListing() identical over 5 rows (incl. throwing)", rowsIn.every((r) => tryP(pm, r) === tryP(pl, r)));
  return res;
}
// ── 3. Mutation tests: seeded regressions in the NEW tree must be caught ──
const MUTATIONS = [
  [NEW.repo, "findGameEntryById user scope removed", `WHERE id = \${id} AND user_id = \${userId} LIMIT 1\`));\n}\n\nexport async function updateGameEntry`, `WHERE id = \${id} LIMIT 1\`));\n}\n\nexport async function updateGameEntry`],
  [NEW.repo, "delete no longer user scoped", "DELETE FROM game_entries WHERE id = ${id} AND user_id = ${userId}", "DELETE FROM game_entries WHERE id = ${id}"],
  [NEW.repo, "active-listing filter dropped", `"SELECT * FROM game_market_listings WHERE id=$1 AND status='active'"`, `"SELECT * FROM game_market_listings WHERE id=$1"`],
  [NEW.repo, "wallet balance guard dropped", "AND balance >= $1", ""],
  [NEW.repo, "insufficient/not-active reasons swapped", `reason: "insufficient-balance" as const`, `reason: "listing-not-active" as const`],
  [NEW.repo, "rollback dropped on double sale", `await client.query("ROLLBACK");\n      return { ok: false as const, reason: "listing-not-active" as const };`, `return { ok: false as const, reason: "listing-not-active" as const };`],
  [NEW.repo, "listing order flipped", "ORDER BY gl.created_at DESC", "ORDER BY gl.created_at ASC"],
  [NEW.repo, "connection release dropped", "client.release();", ""],
  [NEW.entries, "create stops encrypting account password", "accountPassword: encryptField(accountPassword),", "accountPassword,"],
  [NEW.entries, "view no longer charges credits", `await chargeCredits(userId, "sylo.game_entry_view")`, `({ ok: false } as any)`],
  [NEW.entries, "get 404 becomes 403", `status: 404, body: { error: "Not found" } };\n    // Charge`, `status: 403, body: { error: "Not found" } };\n    // Charge`],
  [NEW.entries, "list ignores category", "selectGameEntries(userId, category)", "selectGameEntries(userId, null)"],
  [NEW.entries, "update tags default changed", "      tags,\n    });\n    if (!result.rows.length) return { status: 404", "      tags: tags ?? [],\n    });\n    if (!result.rows.length) return { status: 404"],
  [NEW.entries, "delete reports failure", "body: { success: true }", "body: { success: false }"],
  [NEW.market, "fee maths changed", "feePct / 100", "feePct / 10"],
  [NEW.market, "self-buy check removed", "listing.seller_id === buyerId", "false"],
  [NEW.market, "double-sale status code changed", "{ status: 409, body:", "{ status: 400, body:"],
  [NEW.market, "market kill switch ignored", `if (!enabled) return`, `if (false) return`],
  [NEW.market, "cancel skips authorization", "!(await authorizeCancel(id, listing))", "false"],
  [NEW.security, "unknown owner defaults to user 1", "rows[0]?.user_id ?? GAME_ENTRY_OWNER_SENTINEL_NONE", "rows[0]?.user_id ?? 1"],
  [NEW.security, "moderators may cancel listings", `createRoleOverrideRule(["admin"])`, `createRoleOverrideRule(["admin", "moderator"])`],
  [NEW.domain, "sensitive field list shortened", `  "email_backup_code",\n`, ""],
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
// ── 4. Diff audit ─────────────────────────────────────────────────────────
function diffAudit() {
  const man = JSON.parse(fs.readFileSync(path.join(BASE04B, "tree-manifest.json"), "utf8")).files;
  const seal = JSON.parse(fs.readFileSync(path.join(BASE04B, "SEAL.json"), "utf8"));
  const now = {}; for (const f of walkFiles(ROOT)) { const k = rel(f); if (!k.startsWith("scripts/antas/vault/gap/")) now[k] = sha256File(f); }
  const changed = [], added = [], removed = [];
  for (const [k, v] of Object.entries(now)) { if (!(k in man)) added.push(k); else if (man[k] !== v) changed.push(k); }
  for (const k of Object.keys(man)) if (!(k in now)) removed.push(k);
  const gapNow = {}; for (const f of walkFiles(path.join(ROOT, "scripts/antas/vault/gap"))) gapNow[rel(f)] = sha256File(f);
  const gapEdited = Object.entries(seal.gap_scripts_at_freeze).filter(([k, v]) => gapNow[k] !== v).map(([k]) => k);
  const unexpected = [...changed.filter((k) => !CHANGED_ALLOWED.has(k)), ...added.filter((k) => !ADDED_ALLOWED.has(k)), ...removed];
  return { changed, added, removed, unexpected, earlier_validators_edited: gapEdited, tree_manifest_sha256_matches_seal: sha256(fs.readFileSync(path.join(BASE04B, "tree-manifest.json"), "utf8")) === seal.tree_manifest_sha256 };
}
// ── 5. Degraded differential typecheck (project deps are not installed in the upload) ─
function typecheckDifferential() {
  const cfgRaw = ts.readConfigFile(path.join(ROOT, "tsconfig.base.json"), ts.sys.readFile).config?.compilerOptions ?? {};
  const opts = ts.convertCompilerOptionsFromJson({ ...cfgRaw, noEmit: true, skipLibCheck: true, types: [], incremental: false, composite: false, baseUrl: ROOT }, ROOT).options;
  const routeAbs = ROUTE_FILES.map((f) => path.join(SRC, f)); const newAbs = NEW_FILES.map((f) => path.join(SRC, f)); const scopeAbs = [...routeAbs, ...newAbs];
  const baselineFor = new Map([[routeAbs[0], OLD.entries.baseline], [routeAbs[1], OLD.market.baseline], [path.join(SRC, NEW.domain), OLD_DOMAIN_BASELINE]]);
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
// ── 6. Main ───────────────────────────────────────────────────────────────
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
  checks.push({ name: "coverage:every-route-has-success-and-failure-or-security-case", passed: HANDLERS.every(([m, p]) => has(m, p, "success") || has(m, p, "security")) && HANDLERS.every(([m, p]) => has(m, p, "failure") || has(m, p, "security")), details: "" });
  checks.push({ name: "coverage:every-ownership-middleware-builder-and-deny-path-exercised", passed: ["GET", "PUT", "DELETE"].every((m) => CASES.some((c) => c.kind === "deny" && c.method === m && c.path === "/game-entries/:id") && CASES.some((c) => c.kind === "builder" && c.method === m)), details: "" });
  checks.push({ name: "no-skipped-tests", passed: CASES.length > 0 && diff.length === CASES.length, details: `${diff.length}/${CASES.length}` });
  checks.push({ name: "differential-cases-executed-interactions", passed: diff.filter((d) => d.log_entries > 0).length >= 40, details: `${diff.filter((d) => d.log_entries > 0).length} cases recorded interactions` });
  checks.push({ name: "mutation-suite-size", passed: mut.length >= 20, details: `${mut.length} seeded regressions` });
  checks.push({ name: "diff-audit:no-unrelated-changes", passed: audit.unexpected.length === 0, details: audit.unexpected.join(", ") });
  checks.push({ name: "diff-audit:no-earlier-validator-edited", passed: audit.earlier_validators_edited.length === 0, details: audit.earlier_validators_edited.join(", ") });
  checks.push({ name: "diff-audit:baseline-seal-intact", passed: audit.tree_manifest_sha256_matches_seal, details: "" });
  checks.push({ name: "diff-audit:every-declared-destination-file-was-added", passed: [...ADDED_ALLOWED].every((f) => audit.added.includes(f)), details: [...ADDED_ALLOWED].filter((f) => !audit.added.includes(f)).join(", ") });
  checks.push({ name: "typecheck:no-syntax-errors", passed: tc.syntactic_errors.length === 0, details: tc.syntactic_errors.join("; ") });
  checks.push({ name: "typecheck:no-new-diagnostics-vs-baseline", passed: tc.new_diagnostics.length === 0, details: tc.new_diagnostics.join("; ") });
  const exit_codes = { differential_suite: diff.every((d) => d.passed) ? 0 : 1, security_suite: sec.every((d) => d.passed) ? 0 : 1, unit_parity: unit.every((d) => d.passed) ? 0 : 1, mutation_suite: mut.every((d) => d.passed) ? 0 : 1, typecheck_differential: tc.new_diagnostics.length === 0 && tc.syntactic_errors.length === 0 ? 0 : 1 };
  const failed = checks.filter((c) => !c.passed);
  const hashes = sourceHashes(); const b = binding(hashes);
  const thin = (t) => ({ routes: t.length, with_inline_refs: t.filter((r) => (r.handler_text.match(INLINE_REFS) ?? []).length > 0).length, handler_lines: t.reduce((a, r) => a + r.handler_lines, 0) });
  const evidence = {
    phase: PHASE, sub_phase: SUB_PHASE, commit_sha: b.commit_sha, commit_binding: b.commit_binding, source_tree_sha256: b.source_tree_sha256,
    validator_version: VALIDATOR_VERSION, validator_sha256: sha256File(HERE), source_hashes: hashes,
    commands: ["node scripts/antas/vault/gap/validate-vlt-gap-04-B.mjs", "in-process differential suite (frozen baseline routes vs new source)", "in-process differential typecheck"],
    exit_codes,
    symbols_moved: st.moved.filter((m) => m.existed_in_old && !m.remaining_in_old_file && m.defined_in_new).map((m) => `${m.old_file}#${m.old_symbol} → ${m.new_file}#${m.new_symbol}`),
    handlers_extracted: st.handlerRows,
    consumers_migrated: [],
    old_business_symbols_remaining: { route_declares_business_symbols: [], route_handlers_with_inline_db_crypto_policy_refs: [...st.routeAfter.entries, ...st.routeAfter.market].filter((r) => (r.handler_text.match(INLINE_REFS) ?? []).length > 0).map((r) => `${r.method} ${r.path}`) },
    duplicate_implementations: st.duplicates,
    route_thinness: { before: { entries: thin(st.routeBefore.entries), market: thin(st.routeBefore.market) }, after: { entries: thin(st.routeAfter.entries), market: thin(st.routeAfter.market) } },
    sql: { old_statements: st.oldSqlCount, new_statements: st.newSqlCount },
    destination_functions: Object.fromEntries(Object.entries(st.units).map(([f, u]) => [f, u.filter((x) => x.kind !== "type").map((x) => x.name)])),
    consumer_census_for_04_C: { route_importers: st.routeImporters, note: "Files that read/write game_entries or game_market_listings directly (mail-sync, vault-snapshot*, vault-shares, marketplace-vault, search, credit-meter, reencrypt-vault, domain-boundaries) are listed in 04-A table_consumers and are NOT rewired here." },
    diff_audit: audit,
    typecheck: { mode: "degraded-differential (project dependencies are not installed in the upload; full tsc/build is NOT executed)", before_total: tc.before_total, after_total: tc.after_total, syntactic_errors: tc.syntactic_errors, new_diagnostics: tc.new_diagnostics, before_by_class: tc.before_by_class, after_by_class: tc.after_by_class },
    tests: { differential_cases: diff.length, differential_passed: diff.filter((d) => d.passed).length, security_checks: sec.length, security_passed: sec.filter((d) => d.passed).length, unit_parity: unit.length, unit_passed: unit.filter((d) => d.passed).length, mutations_seeded: mut.length, mutations_detected: mut.filter((d) => d.passed).length },
    notes: [
      "consumers_migrated is empty by design: 04-B extracts the two route files' logic and leaves them as thin adapters; direct game_entries/game_market_listings consumers elsewhere are 04-C.",
      "Behavior is preserved exactly, including pre-existing quirks: persistence still builds SQL with sql.raw + quote-escaping (safe/safeTags) for game_entries rather than bound parameters; parseListing still JSON.parse()s photos/details; GET /marketplace/game/stats and GET /marketplace/game/listings remain unmetered. None of these is changed here.",
      "Ownership owner lookup now goes through game-repository.selectGameEntryOwner (the original raw-SQL statement) instead of a second inline query, so the SQL exists exactly once.",
      "The project's own test suites and full tsc/build cannot run in this environment (dependencies are not installed); the differential suite executes the frozen OLD routes and the NEW tree under identical stubbed dependencies and compares every DB call, crypto call, credit charge, PDP call, status code and body. Run the repo's build and tests in CI before certifying.",
      "components/game-entries.tsx (and the other Game-named frontend files) are API clients only and are not part of this backend extraction.",
    ],
    status: failed.length === 0 ? "PASS" : "FAIL", checks,
  };
  const body = { ...evidence }; delete body.generated_at;
  evidence.generated_at = new Date().toISOString(); evidence.evidence_body_sha256 = sha256(JSON.stringify(body));
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(EVIDENCE_FILE, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`${SUB_PHASE} ${evidence.status} — ${diff.length} differential cases, ${sec.length} security checks, ${unit.length} unit parity, ${mut.filter((m) => m.passed).length}/${mut.length} mutations detected, ${st.checks.length} static checks (${Date.now() - started}ms)`);
  if (failed.length) { console.error(failed.map((c) => `- ${c.name}: ${c.details || "not satisfied"}`).join("\n")); process.exit(1); }
}
main().catch((e) => fail(`unhandled: ${e.stack ?? e}`));
