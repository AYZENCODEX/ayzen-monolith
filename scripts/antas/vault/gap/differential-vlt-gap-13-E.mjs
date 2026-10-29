#!/usr/bin/env node
// VLT-GAP-13-E differential: the pre-extraction routes/marketplace-vault.ts (frozen fixture) and the extracted
// route + vault/shared/marketplace + repository + security modules are executed against the SAME scripted fake DB.
// Every scenario must yield the identical HTTP status, body, SQL/param sequence (incl. BEGIN/ROLLBACK/COMMIT) and
// authorization call. Writes reports/antas/vault/gap/VLT-GAP-13/differential-marketplace-vault.json.
import fs from "node:fs";
import path from "node:path";
import Module, { createRequire } from "node:module";
const module = { id: "diff" };
import { ROOT, rel, rejectBypass, sha256File } from "./gap-common.mjs";

const bad = rejectBypass([]);
if (bad.length) { console.error(`VLT-GAP-13-E FAIL — bypass rejected: ${bad.join(", ")}`); process.exit(1); }
const SRC = path.join(ROOT, "artifacts/api-server/src");
const OLD_FIXTURE = path.join(ROOT, "reports/antas/vault/gap/VLT-GAP-13/baseline/marketplace-vault.pre-extraction.ts");
const ts = createRequire(path.join(ROOT, "package.json"))("typescript");

// ── stubs ───────────────────────────────────────────────────────────────────────────────────────────────────
let LOG = [], DB = () => ({ rows: [], rowCount: 0 }), CFG = { enabled: true, feePct: 5 }, AUTH = "ALLOW";
const call = (who, text, params) => { LOG.push([who, text.replace(/\s+/g, " ").trim(), params ?? null]); const r = DB(text, params, who); if (r instanceof Error) throw r; return Promise.resolve(r); };
const pool = { query: (t, p) => call("pool", t, p), connect: async () => { LOG.push(["connect"]); return { query: (t, p) => (/^(BEGIN|COMMIT|ROLLBACK)$/.test(t) ? (LOG.push(["client", t, null]), Promise.resolve({ rows: [], rowCount: 0 })) : call("client", t, p)), release: () => LOG.push(["release"]) }; } };
const handlers = new Map();
const makeRouter = () => { const r = {}; for (const m of ["get", "post", "put", "patch", "delete"]) r[m] = (p, ...fns) => handlers.set(`${m.toUpperCase()} ${p}`, fns[fns.length - 1]); return r; };
const STUBS = [
  [/^express$/, { Router: makeRouter }],
  [/^@workspace\/db$/, { pool, db: {} }],
  [/^drizzle-orm$/, { sql: (s, ...v) => ({ s, v }) }],
  [/middlewares\/auth$/, { requireAuth: () => {}, pepDecisionObserver: () => {} }],
  [/lib\/market-config$/, { getMarketConfig: async () => ({ ...CFG }) }],
  [/lib\/policy\/policy-engine$/, { PolicyEngine: class { constructor() {} registerRule() {} } }],
  [/lib\/policy\/resource$/, { createResourceOwnershipRule: () => ({}), createRoleOverrideRule: () => ({}) }],
  [/lib\/policy\/pep$/, { authorize: async (a) => { LOG.push(["authorize", a.action, a.resource, !!a.req]); return { decision: { effect: AUTH } }; } }],
];
const origLoad = Module._load;
Module._load = function (request, parent, ...rest) { const s = STUBS.find(([re]) => re.test(request)); return s ? s[1] : origLoad.call(this, request, parent, ...rest); };
Module._extensions[".ts"] = (mod, filename) => mod._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);

function loadRoute(file, asName) {
  handlers.clear();
  const filename = path.join(SRC, "routes", asName);
  const m = new Module(filename, module); m.filename = filename; m.paths = Module._nodeModulePaths(path.dirname(filename));
  m._compile(ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
  return new Map(handlers);
}
const OLD = loadRoute(OLD_FIXTURE, "__old-marketplace-vault.ts");
const NEW = loadRoute(path.join(SRC, "routes/marketplace-vault.ts"), "marketplace-vault.ts");

// ── scenarios ───────────────────────────────────────────────────────────────────────────────────────────────
const rule = (re, res) => [re, res];
const dbFrom = (rules, tx = {}) => (text, params, who) => {
  for (const [re, res] of rules) if (re.test(text)) return typeof res === "function" ? res(text, params, who) : res;
  if (who === "client") return { rows: [{ id: 1 }], rowCount: 1 };
  return { rows: [], rowCount: 0 };
};
const L_SELL = (o = {}) => ({ id: 5, seller_id: 20, price: "100", title: "T", vault_entry_id: 77, vault_type: "entity", order_type: "sell", ...o });
const FIND_SELL = /status='active' AND \(order_type='sell' OR order_type IS NULL\)$/;
const FIND_ACTIVE = /^SELECT \* FROM vault_market_listings WHERE id=\$1 AND status='active'$/;
const WALLET = (bal) => rule(/SELECT balance FROM marketplace_wallets/, { rows: [{ balance: bal }], rowCount: 1 });
const buyRules = (listing, bal = "1000", extra = []) => [...extra, rule(FIND_SELL, { rows: [listing], rowCount: 1 }), WALLET(bal)];
const U = (o = {}) => ({ userId: 10, role: "user", ...o });
const S = [];
const add = (name, route, req, db, cfg = {}, auth = "ALLOW") => S.push({ name, route, req, db, cfg, auth });
const LST = "GET /marketplace/vault/listings", CRE = "POST /marketplace/vault/listings", BUY = "POST /marketplace/vault/buy", DEL = "DELETE /marketplace/vault/listings/:id", STA = "GET /marketplace/vault/stats";
const listRows = [{ id: 1, preview_data: '{"a":1}', account_details: '{"b":2}', seller_username: "u" }, { id: 2, preview_data: null, account_details: null }];
const listDb = dbFrom([rule(/COUNT\(\*\) FROM vault_market_listings/, { rows: [{ count: "7" }] }), rule(/SELECT vl\.\*/, { rows: listRows })]);
add("list: no filters", LST, { query: {}, user: U() }, listDb);
add("list: all filters + official=true", LST, { query: { limit: "5", offset: "10", category: "c", account_type: "a", vault_type: "kyc", order_type: "sell", min_price: "1", max_price: "9", official: "true" }, user: U() }, listDb);
add("list: official=false", LST, { query: { official: "false" }, user: U() }, listDb);
add("list: official=other", LST, { query: { official: "maybe" }, user: U() }, listDb);
add("list: db error -> 500", LST, { query: {}, user: U() }, () => new Error("boom"));
const insDb = (extra = []) => dbFrom([...extra, rule(/INSERT INTO vault_market_listings/, { rows: [{ id: 9, title: "x" }], rowCount: 1 })]);
const ve = { project_name: "P", twitter_username: "t", discord_username: null, telegram_phone: "1", email: "e", wallet_addresses: "w", entity_serial: "S1" };
add("create: sell without price -> 400", CRE, { body: { order_type: "sell" }, user: U() }, insDb());
add("create: buy without account_type -> 400", CRE, { body: { order_type: "buy" }, user: U() }, insDb());
add("create: market disabled -> 403", CRE, { body: { price: 5 }, user: U() }, insDb(), { enabled: false });
add("create: entity ok", CRE, { body: { vault_entry_id: 3, price: "5", title: "t", description: "d", category: "c", tier: "pro", account_details: { x: 1 } }, user: U() }, insDb([rule(/FROM vault_entries/, { rows: [ve] })]));
add("create: entity not owned -> 403", CRE, { body: { vault_entry_id: 3, price: "5" }, user: U() }, insDb());
add("create: local ok", CRE, { body: { local_account_id: 4, vault_type: "local", price: 5 }, user: U() }, insDb([rule(/FROM local_accounts/, { rows: [{ category: "x", twofa: "1", account_create_date: "d", followers: 3 }] })]));
add("create: local not owned -> 403", CRE, { body: { local_account_id: 4, vault_type: "local", price: 5 }, user: U() }, insDb());
add("create: kyc ok", CRE, { body: { kyc_entry_id: 6, vault_type: "kyc", price: 5 }, user: U() }, insDb([rule(/FROM kyc_entries/, { rows: [{ category: "k", platform: "p", account_2fa: null, email_2fa: "y" }] })]));
add("create: kyc not owned -> 403", CRE, { body: { kyc_entry_id: 6, vault_type: "kyc", price: 5 }, user: U() }, insDb());
add("create: game ok", CRE, { body: { game_entry_id: 8, vault_type: "game", price: 5 }, user: U() }, insDb([rule(/FROM game_entries/, { rows: [{ category: "g", platform: "pc", email_2fa: "" }] })]));
add("create: game not owned -> 403", CRE, { body: { game_entry_id: 8, vault_type: "game", price: 5 }, user: U() }, insDb());
add("create: no asset ref", CRE, { body: { price: 5 }, user: U() }, insDb());
add("create: buy order defaults + price_min/max", CRE, { body: { order_type: "buy", account_type: "twitter", price_min: "3", price_max: "9" }, user: U() }, insDb());
add("create: official + admin", CRE, { body: { price: 5, official: true }, user: U({ role: "admin" }) }, insDb());
add("create: official + non-admin", CRE, { body: { price: 5, official: true }, user: U() }, insDb());
add("create: official 'true' string + admin", CRE, { body: { price: 5, official: "true" }, user: U({ role: "admin" }) }, insDb());
add("create: insert error -> 500", CRE, { body: { price: 5 }, user: U() }, () => new Error("ins fail"));
add("buy: no listing_id -> 400", BUY, { body: {}, user: U() }, dbFrom([]));
add("buy: listing missing -> 404", BUY, { body: { listing_id: 5 }, user: U() }, dbFrom([]));
add("buy: own listing -> 400", BUY, { body: { listing_id: 5 }, user: U() }, dbFrom(buyRules(L_SELL({ seller_id: 10 }))));
add("buy: precheck insufficient -> 400", BUY, { body: { listing_id: 5 }, user: U() }, dbFrom(buyRules(L_SELL(), "5")));
for (const vt of ["entity", "local", "kyc", "game"]) {
  add(`buy: success ${vt}`, BUY, { body: { listing_id: 5 }, user: U() }, dbFrom(buyRules(L_SELL({ vault_type: vt }))));
  add(`buy: ${vt} ownership conflict -> 409`, BUY, { body: { listing_id: 5 }, user: U() }, dbFrom(buyRules(L_SELL({ vault_type: vt }), "1000", [rule(new RegExp(vt === "entity" ? "UPDATE vault_entries" : vt === "local" ? "UPDATE local_accounts" : vt === "kyc" ? "UPDATE kyc_entries" : "UPDATE game_entries"), { rows: [], rowCount: 0 })])));
}
add("buy: success no asset", BUY, { body: { listing_id: 5 }, user: U() }, dbFrom(buyRules(L_SELL({ vault_entry_id: null }))));
add("buy: success unknown vault_type", BUY, { body: { listing_id: 5 }, user: U() }, dbFrom(buyRules(L_SELL({ vault_type: "weird" }))));
add("buy: success fee maths (price 33.33)", BUY, { body: { listing_id: 5 }, user: U() }, dbFrom(buyRules(L_SELL({ price: "33.33" }))));
add("buy: atomic debit fails -> 400", BUY, { body: { listing_id: 5 }, user: U() }, dbFrom(buyRules(L_SELL(), "1000", [rule(/UPDATE marketplace_wallets SET balance=balance-/, { rows: [], rowCount: 0 })])));
add("buy: already sold race -> 409", BUY, { body: { listing_id: 5 }, user: U() }, dbFrom(buyRules(L_SELL(), "1000", [rule(/SET status='sold'/, { rows: [], rowCount: 0 })])));
add("buy: error mid-transaction -> rollback + 500", BUY, { body: { listing_id: 5 }, user: U() }, dbFrom(buyRules(L_SELL(), "1000", [rule(/INSERT INTO marketplace_transactions/, new Error("txn fail"))])));
add("buy: db error before tx -> 500", BUY, { body: { listing_id: 5 }, user: U() }, () => new Error("early fail"));
const act = dbFrom([rule(FIND_ACTIVE, { rows: [{ id: 5, seller_id: 20 }], rowCount: 1 })]);
add("cancel: missing -> 404", DEL, { params: { id: "5" }, user: U() }, dbFrom([]));
add("cancel: forbidden -> 403", DEL, { params: { id: "5" }, user: U() }, act, {}, "DENY");
add("cancel: ok", DEL, { params: { id: "5" }, user: U() }, act);
add("cancel: array id param", DEL, { params: { id: ["5", "6"] }, user: U() }, act);
add("cancel: db error -> 500", DEL, { params: { id: "5" }, user: U() }, () => new Error("cancel fail"));
const stDb = dbFrom([rule(/MIN\(price\)/, { rows: [{ cnt: "3", floor: "2", avg_price: "4.5" }] }), rule(/order_type='buy'/, { rows: [{ cnt: "2" }] }), rule(/SUM\(amount\)/, { rows: [{ vol: "90", sales: "4" }] })]);
add("stats: ok", STA, { user: U() }, stDb);
add("stats: nulls", STA, { user: U() }, dbFrom([rule(/MIN\(price\)/, { rows: [{ cnt: "0", floor: null, avg_price: null }] }), rule(/order_type='buy'/, { rows: [{ cnt: "0" }] }), rule(/SUM\(amount\)/, { rows: [{ vol: null, sales: "0" }] })]));
add("stats: db error -> 500", STA, { user: U() }, () => new Error("stat fail"));

async function exec(routes, sc) {
  LOG = []; DB = sc.db; CFG = { enabled: true, feePct: 5, ...sc.cfg }; AUTH = sc.auth;
  const h = routes.get(sc.route); if (!h) throw new Error(`route not registered: ${sc.route}`);
  const out = { status: 200, body: undefined };
  const res = { status(n) { out.status = n; return res; }, json(b) { out.body = b; return res; } };
  let threw = null;
  try { await h({ query: {}, params: {}, body: {}, ...sc.req }, res); } catch (e) { threw = String(e.message ?? e); }
  return JSON.stringify({ status: out.status, body: out.body ?? null, threw, log: LOG });
}
const results = []; let failed = 0;
for (const sc of S) {
  const a = await exec(OLD, sc), b = await exec(NEW, sc);
  const ok = a === b; if (!ok) failed++;
  results.push({ scenario: sc.name, equal: ok, old_status: JSON.parse(a).status, new_status: JSON.parse(b).status, queries: JSON.parse(a).log.length });
  if (!ok) console.error(`  DIFF ${sc.name}\n    old: ${a.slice(0, 400)}\n    new: ${b.slice(0, 400)}`);
}
const routesOld = [...OLD.keys()].sort().join("|"), routesNew = [...NEW.keys()].sort().join("|");
const sameRoutes = routesOld === routesNew;
const report = { gap: "VLT-GAP-13", sub_phase: "VLT-GAP-13-E", kind: "differential (old route fixture vs extracted modules, identical fake DB)", checked_at: new Date().toISOString(), old_fixture_sha256: sha256File(OLD_FIXTURE), route_table_equal: sameRoutes, routes: [...NEW.keys()], scenarios: results.length, statuses_exercised: [...new Set(results.map((r) => r.new_status))].sort(), failed, results, status: failed === 0 && sameRoutes && results.length > 0 ? "PASS" : "FAIL" };
fs.writeFileSync(path.join(ROOT, "reports/antas/vault/gap/VLT-GAP-13/differential-marketplace-vault.json"), JSON.stringify(report, null, 2) + "\n");
if (report.status !== "PASS") { console.error(`VLT-GAP-13-E FAIL — ${failed} differing scenario(s), route table equal: ${sameRoutes}`); process.exit(1); }
console.log(`VLT-GAP-13-E differential PASS — ${results.length} scenarios identical (status/body/SQL/auth), route table equal (${NEW.size} routes), statuses ${report.statuses_exercised.join(",")}`);
