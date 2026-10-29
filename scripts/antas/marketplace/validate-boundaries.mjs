#!/usr/bin/env node
// MKT-02: Marketplace boundary gate. Static only (no database, no build).
//   node validate-boundaries.mjs              validate the tree against boundaries.manifest.json (exit 1 on any finding)
//   node validate-boundaries.mjs --baseline   rewrite the manifest 'baseline' from the tree (do this in the same change as a migration)
//   node validate-boundaries.mjs --self-test  run the detectors against planted violations
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const src = path.join(root, "artifacts/api-server/src");
const manifestPath = path.join(here, "boundaries.manifest.json");
const rel = (f) => path.relative(root, f).split(path.sep).join("/");
const read = (f) => fs.readFileSync(f, "utf8");
const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.name === "node_modules" ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])) : []);
const sortObj = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

// ---------------- pure detectors (also used by --self-test) ----------------
export const sqlCalls = (t) => ({
  pool: (t.match(/\bpool\.query\b/g) || []).length,
  client: (t.match(/\b(?:client|c)\.query\b/g) || []).length,
  drizzle: (t.match(/\bdb\.(?:select|insert|update|delete|execute|transaction)\b/g) || []).length,
});
export const tableWrites = (t, tables) =>
  tables.filter((x) => new RegExp(`(INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+(?:public\\.)?${x}\\b`, "i").test(t)).sort();
const WRITE_SQL = /\b(INSERT\s+INTO|UPDATE\s+[a-z_]+\s+SET|DELETE\s+FROM)\b/i;
const OWNER_SQL = /\b(user_id|seller_id|buyer_id|owner_id|created_by|reporter_id|author_id)\s*=\s*\$\d|\b(seller_id|buyer_id|user_id|owner_id)\s*(?:!==|!=|===|==)\s*(?:userId|req\.user)/i;
export function classifyRoute(route, body) {
  if (route.access === "inline-auth") return /=>\s*\{\s*const \w+ = await requireUser\(\s*req\s*,\s*res\s*\)/.test(body) ? "inline-auth-verified" : "inline-auth-unverified";
  if (route.access === "public") return WRITE_SQL.test(body) ? "public-write" : "public-read";
  if (route.access === "admin") return "admin";
  if (route.ownerCheck) return "owner-gated";
  if (!(route.method !== "GET" && /:\w+/.test(route.path))) return "authenticated";
  return OWNER_SQL.test(body) ? "in-handler-owner-sql" : "needs-review";
}
/** MKT-05: a migrated route has no SQL in its body, so the heuristic classes that read SQL (public-write, in-handler-owner-sql) cannot be derived any more.
 * The manifest records the class explicitly; an override is only legal while the route body holds no SQL (otherwise it is stale). */
export function applyClassOverride(key, body, derived, overrides) {
  const o = overrides?.[key];
  if (!o) return { cls: derived };
  if (/\b(pool|client)\.query\b|\bINSERT\s+INTO\b|\bUPDATE\s+\w+\s+SET\b|\bDELETE\s+FROM\b/i.test(body)) return { cls: derived, finding: { check: "class-overrides", route: key, problem: "override recorded but the route body still contains SQL (stale entry): remove the override" } };
  return { cls: o.class };
}
export const decryptCalls = (t) => (t.match(/\bdecryptPhrase\(/g) || []).length;
const FORBIDDEN_DOMAIN = [/@workspace\/db/, /\bexpress\b/, /drizzle-orm/, /node:fs|from "fs"/, /\bpool\b/, /\bfetch\(/, /process\.env/, /\.\.\/(infrastructure|application|security)\b/];
export function layerViolations(file, text) {
  const out = [];
  const m = file.match(/marketplace\/(?:[\w-]+\/)*?(domain|application|infrastructure|security)\//);
  const layer = m?.[1];
  if (layer === "domain") for (const re of FORBIDDEN_DOMAIN) if (re.test(text)) out.push(`domain imports or uses ${re}`);
  if (layer === "application") {
    // transaction control through a client is allowed in the application layer (BEGIN, COMMIT, ROLLBACK); any other direct query is not
    const withoutTxControl = text.replace(/\b(?:client|tx)\.query\(\s*["'`](?:BEGIN|COMMIT|ROLLBACK)["'`]\s*\)/g, "");
    if (/from "express"|\bpool\.query\b|\b(?:client|tx)\.query\b/.test(withoutTxControl)) out.push("application uses express or raw SQL");
  }
  // import specifiers only: a comment that mentions a path is not an import
  if (/(^|\/)routes\//.test(file) && /\bfrom\s+["'][^"']*marketplace\/(?:[\w-]+\/)*infrastructure\//.test(text)) out.push("route imports marketplace infrastructure");
  return out;
}
export function diffSection(name, expected, actual) {
  const a = JSON.stringify(expected ?? null), b = JSON.stringify(actual);
  return a === b ? [] : [{ check: `baseline-${name}`, problem: "tree differs from the manifest baseline (new violation, or a migration that did not rewrite the baseline with --baseline)", expected, actual }];
}
export function reviewFindings(keys, reviews) {
  const out = [];
  for (const k of keys) if (!reviews[k] || !reviews[k].verdict) out.push({ check: "route-reviews", route: k, problem: "route needs a person to read the handler and record a verdict in routeReviews" });
  for (const k of Object.keys(reviews)) if (!keys.includes(k)) out.push({ check: "route-reviews", route: k, problem: "recorded review for a route that no longer needs review (stale entry)" });
  return out;
}
export function consumerFindings(consumers, declared) {
  const out = [];
  for (const f of consumers) if (!declared[f] || !declared[f].decision) out.push({ check: "external-consumers", file: f, problem: "touches Marketplace tables with no decision recorded in the manifest" });
  for (const f of Object.keys(declared)) if (!consumers.includes(f)) out.push({ check: "external-consumers", file: f, problem: "recorded consumer no longer touches Marketplace tables (stale entry)" });
  return out;
}

// ---------------- self-test ----------------
if (process.argv.includes("--self-test")) {
  const t = [];
  const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); t.push(ok); if (!ok) console.error(`FAIL ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); };
  eq("sql counts", sqlCalls("await pool.query(a); await client.query(b); db.select().from(x); db.insert(y)"), { pool: 1, client: 1, drizzle: 2 });
  eq("table write found", tableWrites("client.query(`INSERT INTO marketplace_wallets (a) VALUES ($1)`)", ["marketplace_wallets", "marketplace_orders"]), ["marketplace_wallets"]);
  eq("select is not a write", tableWrites("SELECT * FROM marketplace_wallets", ["marketplace_wallets"]), []);
  const r = (o) => ({ method: "POST", path: "/x/:id", access: "authenticated", ownerCheck: false, ...o });
  eq("needs-review", classifyRoute(r({}), "const id = 1; await pool.query('UPDATE t SET a=1 WHERE id=$1',[id])"), "needs-review");
  eq("owner sql", classifyRoute(r({}), "UPDATE t SET a=1 WHERE id=$1 AND seller_id=$2"), "in-handler-owner-sql");
  eq("owner compare", classifyRoute(r({}), "if (row.seller_id !== userId) return"), "in-handler-owner-sql");
  eq("owner gated", classifyRoute(r({ ownerCheck: true }), ""), "owner-gated");
  eq("plain authenticated GET", classifyRoute(r({ method: "GET" }), ""), "authenticated");
  eq("public write", classifyRoute(r({ access: "public" }), "UPDATE marketplace_listings SET view_count = view_count + 1"), "public-write");
  eq("public read", classifyRoute(r({ access: "public", method: "GET" }), "SELECT 1"), "public-read");
  eq("inline verified", classifyRoute(r({ access: "inline-auth" }), "async (req, res): Promise<void> => {\n  const user = await requireUser(req, res);"), "inline-auth-verified");
  eq("inline unverified", classifyRoute(r({ access: "inline-auth" }), "async (req, res) => { doStuff(); const user = await requireUser(req, res);"), "inline-auth-unverified");
  eq("override applies to a migrated route", applyClassOverride("POST /x x.ts", "const r = await svc.go(id);", "public-read", { "POST /x x.ts": { class: "public-write" } }), { cls: "public-write" });
  eq("override is stale while SQL is in the route", applyClassOverride("POST /x x.ts", "await pool.query('UPDATE t SET a=1')", "public-write", { "POST /x x.ts": { class: "public-write" } }).finding?.check, "class-overrides");
  eq("no override: derived class", applyClassOverride("POST /x x.ts", "", "authenticated", {}), { cls: "authenticated" });
  eq("decrypt calls", decryptCalls("decryptPhrase(a); x; decryptPhrase(b)"), 2);
  eq("domain uses db", layerViolations("artifacts/api-server/src/marketplace/orders/domain/x.ts", 'import { pool } from "@workspace/db";').length > 0, true);
  eq("domain clean", layerViolations("artifacts/api-server/src/marketplace/orders/domain/x.ts", "export const a = 1;"), []);
  eq("route imports infrastructure", layerViolations("artifacts/api-server/src/routes/marketplace.ts", 'import { r } from "../marketplace/orders/infrastructure/orders-repo";').length, 1);
  eq("application may run transaction control through a client", layerViolations("artifacts/api-server/src/marketplace/engagement/application/x.ts", 'await client.query("BEGIN"); await client.query("COMMIT");'), []);
  eq("application may not run other queries on a client", layerViolations("artifacts/api-server/src/marketplace/engagement/application/x.ts", 'await client.query("SELECT 1");').length, 1);
  eq("a comment that names an infrastructure path is not an import", layerViolations("artifacts/api-server/src/routes/marketplace.ts", "// SQL lives in marketplace/catalog/infrastructure/x.ts\nimport { a } from \"../marketplace/catalog/application/x\";"), []);
  eq("baseline drift detected", diffSection("x", { a: 1 }, { a: 2 }).length, 1);
  eq("baseline equal", diffSection("x", { a: 1 }, { a: 1 }), []);
  eq("undeclared consumer", consumerFindings(["a.ts"], {}).length, 1);
  eq("stale consumer", consumerFindings([], { "a.ts": { decision: "REWIRE" } }).length, 1);
  eq("unreviewed route", reviewFindings(["POST /a/:id x.ts"], {}).length, 1);
  eq("stale review", reviewFindings([], { "POST /a/:id x.ts": { verdict: "OK" } }).length, 1);
  eq("review recorded", reviewFindings(["POST /a/:id x.ts"], { "POST /a/:id x.ts": { verdict: "OK" } }), []);
  const ok = t.every(Boolean);
  console.log(`Marketplace boundary self-test ${ok ? "passed" : "FAILED"} (${t.length} detector checks).`);
  process.exit(ok ? 0 : 1);
}

// ---------------- tree scan ----------------
const manifest = JSON.parse(read(manifestPath));
const findings = [];
const node = process.execPath;
const gen = path.join(here, "generate-inventory.mjs");
const inv = spawnSync(node, [gen], { encoding: "utf8" });
if (inv.status !== 0) findings.push({ check: "inventory", problem: "generate-inventory failed", output: (inv.stdout + inv.stderr).trim().split("\n").slice(-6) });
const frozen = spawnSync(node, [gen, "--check"], { encoding: "utf8" });
if (frozen.status !== 0) findings.push({ check: "route-surface-frozen", problem: "route surface differs from the frozen list", output: frozen.stdout.trim().split("\n") });

const map = JSON.parse(read(path.join(root, "reports/antas/marketplace/marketplace-migration-map.json")));
if (map.mappingProblems?.length) findings.push({ check: "route-owner-map", problems: map.mappingProblems });
const scopeTables = map.tables.map((t) => t.table);
const ownerOf = new Map(Object.entries(manifest.tableOwners).flatMap(([o, ts]) => ts.map((t) => [t, o])));
for (const t of scopeTables) if (!ownerOf.has(t)) findings.push({ check: "table-owners", table: t, problem: "Marketplace table has no owner in the manifest" });
for (const t of ownerOf.keys()) if (!scopeTables.includes(t)) findings.push({ check: "table-owners", table: t, problem: "manifest owns a table that no longer exists in the DDL" });
const watched = [...scopeTables, ...manifest.sharedMoneyTables];

// per route file
const sqlInRoutes = {}, writesInRoutes = {};
for (const f of map.files) {
  const text = read(path.join(root, f.file));
  const c = sqlCalls(text);
  sqlInRoutes[f.file.replace("artifacts/api-server/src/", "")] = c;
  const w = tableWrites(text, watched);
  if (w.length) writesInRoutes[f.file.replace("artifacts/api-server/src/", "")] = w;
}
// route access classes (+ handler bodies)
const byFile = new Map();
for (const r of map.routes) (byFile.get(r.file) ?? byFile.set(r.file, []).get(r.file)).push(r);
const routeAccess = [];
for (const [file, rs] of byFile) {
  const lines = read(path.join(src, "routes", file)).split("\n");
  rs.sort((a, b) => a.line - b.line);
  rs.forEach((r, i) => {
    const body = lines.slice(r.line - 1, i + 1 < rs.length ? rs[i + 1].line - 1 : lines.length).join("\n");
    const ov = applyClassOverride(`${r.method} ${r.path} ${file}`, body, classifyRoute(r, body), manifest.classOverrides);
    if (ov.finding) findings.push(ov.finding);
    routeAccess.push({ method: r.method, path: r.path, file, owner: r.proposedOwner, phase: r.phase, class: ov.cls });
  });
}
for (const k of Object.keys(manifest.classOverrides ?? {})) if (!routeAccess.some((r) => `${r.method} ${r.path} ${r.file}` === k)) findings.push({ check: "class-overrides", route: k, problem: "override for a route that does not exist (stale entry)" });
const classCounts = sortObj(routeAccess.reduce((m, r) => ((m[r.class] = (m[r.class] || 0) + 1), m), {}));
const reviewKeys = routeAccess.filter((r) => ["needs-review", "public-write", "inline-auth-unverified"].includes(r.class)).map((r) => `${r.method} ${r.path} ${r.file}`).sort();
const reviewList = reviewKeys;

// writers of wallet tables anywhere in the api-server
// test support (src/marketplace/characterization) is not application code: its fixtures write wallet tables on purpose
const allSrc = walk(src).filter((f) => /\.(ts|mjs)$/.test(f) && !/\.test\./.test(f) && !f.includes(`${path.sep}marketplace${path.sep}characterization${path.sep}`));
const walletWriters = allSrc.filter((f) => tableWrites(read(f), ["marketplace_wallets", "marketplace_transactions"]).length).map((f) => rel(f).replace("artifacts/api-server/src/", "")).sort();
const moneyWriters = {};
for (const f of allSrc.filter((x) => /\/routes\/(marketplace|polymarket)/.test(x))) {
  const w = tableWrites(read(f), manifest.sharedMoneyTables);
  if (w.length) moneyWriters[rel(f).replace("artifacts/api-server/src/", "")] = w;
}
const externalFiles = map.externalAccess.map((e) => e.file).sort();
const decryptInScope = {};
for (const f of allSrc) {
  const n = decryptCalls(read(f));
  if (n && (/\/routes\/(marketplace|polymarket)/.test(f) || /\/src\/marketplace\//.test(f))) decryptInScope[rel(f).replace("artifacts/api-server/src/", "")] = n;
}

const actual = {
  sqlInRoutes: sortObj(sqlInRoutes),
  tableWritesInRoutes: sortObj(writesInRoutes),
  walletTableWriters: walletWriters,
  sharedMoneyWritersInScope: sortObj(moneyWriters),
  externalConsumers: externalFiles,
  decryptPhraseCallsInScope: sortObj(decryptInScope),
  routeAccessClasses: classCounts,
  needsHumanReview: reviewList,
  testsCoveringMarketplace: map.tests.length,
};

// layering of the future marketplace/ tree (no-op until MKT-03 creates it)
const mktDir = path.join(src, "marketplace");
const layerProblems = [];
for (const f of walk(mktDir).filter((x) => /\.(ts|mjs)$/.test(x) && !/\.test\./.test(x))) for (const p of layerViolations(rel(f), read(f))) layerProblems.push({ file: rel(f), problem: p });
for (const f of map.files) for (const p of layerViolations(f.file, read(path.join(root, f.file)))) layerProblems.push({ file: f.file, problem: p });
if (layerProblems.length) findings.push({ check: "layering", problems: layerProblems });

if (process.argv.includes("--baseline")) {
  manifest.baseline = actual;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log("Marketplace baseline rewritten from the tree. Review the diff: numbers must only go down.");
  process.exit(0);
}

for (const [k, v] of Object.entries(actual)) findings.push(...diffSection(k, manifest.baseline?.[k], v));
findings.push(...consumerFindings(externalFiles, manifest.externalConsumers));
findings.push(...reviewFindings(reviewKeys, manifest.routeReviews ?? {}));
for (const id of ["MKT-ISSUE-1", "MKT-ISSUE-2", "MKT-ISSUE-3", "MKT-ISSUE-4", "MKT-ISSUE-5", "MKT-ISSUE-6", "MKT-ISSUE-7", "MKT-ISSUE-8", "MKT-ISSUE-9", "MKT-ISSUE-10"]) if (!manifest.knownIssues.some((i) => i.id === id)) findings.push({ check: "known-issues", problem: `${id} missing from the manifest` });

fs.mkdirSync(path.join(root, "reports/antas/marketplace"), { recursive: true });
fs.writeFileSync(path.join(root, "reports/antas/marketplace/mkt-02-route-access.json"), JSON.stringify({ schemaVersion: 1, phase: "MKT-02", note: "Parsed from route declarations and handler text; heuristic classes in boundaries.manifest.json accessReviewStatuses. needs-review, public-write and inline-auth-unverified need a person to read the handler.", counts: classCounts, routes: routeAccess }, null, 2) + "\n");
fs.writeFileSync(path.join(root, "reports/antas/marketplace/mkt-02-evidence.json"), JSON.stringify({
  schemaVersion: 1, phase: "MKT-02", status: findings.length ? "FAIL" : "PASS", commitSha: "UNAVAILABLE", routesScanned: map.routes.length, findings: findings.length,
  actualBaselineSummary: { sqlCalls: Object.values(sqlInRoutes).reduce((n, c) => n + c.pool + c.client + c.drizzle, 0), routeAccessClasses: classCounts, walletTableWriters: walletWriters, externalConsumers: externalFiles.length, needsHumanReview: reviewList.length },
  note: "PASS means the tree equals the recorded baseline and the frozen route surface; it does not mean the violations are fixed. They are recorded violations with an owner and a phase.",
}, null, 2) + "\n");

console.log(`Marketplace boundary validation: ${findings.length ? "FAIL" : "PASS"}`);
console.log(`routes scanned: ${map.routes.length}; findings: ${findings.length}; classes: ${JSON.stringify(classCounts)}`);
console.log(`recorded violations: SQL in routes ${Object.values(sqlInRoutes).reduce((n, c) => n + c.pool + c.client + c.drizzle, 0)}, wallet-table writers ${walletWriters.length}, external consumers ${externalFiles.length}, routes needing human review ${reviewList.length} (all reviewed: ${reviewList.every((k) => manifest.routeReviews?.[k]?.verdict)})`);
for (const f of findings) console.log("FINDING " + JSON.stringify(f).slice(0, 600));
process.exit(findings.length ? 1 : 0);
