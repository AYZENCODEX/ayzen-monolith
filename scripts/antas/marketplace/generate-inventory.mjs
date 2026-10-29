#!/usr/bin/env node
// MKT-00: static inventory of the Marketplace (routes/marketplace*.ts + routes/polymarket.ts).
// Writes docs/antas/marketplace/marketplace-inventory.md and reports/antas/marketplace/marketplace-migration-map.json.
//   --freeze   also (re)writes reports/antas/marketplace/marketplace-frozen-routes.json (the frozen route surface)
//   --check    compares the current scan with the frozen file; exit 1 on any drift (added, removed, moved, auth changed)
// No database, no network, no build. Re-run after any Marketplace change.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const src = path.join(root, "artifacts/api-server/src");
const rel = (f) => path.relative(root, f).split(path.sep).join("/");
const read = (f) => fs.readFileSync(f, "utf8");
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.name === "node_modules" ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const args = new Set(process.argv.slice(2));

// ---- scope -----------------------------------------------------------------
const routeDir = path.join(src, "routes");
const routeFiles = fs.readdirSync(routeDir).filter((f) => /^marketplace.*\.ts$/.test(f) || f === "polymarket.ts").sort().map((f) => path.join(routeDir, f));
const scopeTablePattern = /^(marketplace_[a-z_]+|spot_orders|spot_trades|staking_pools|staking_positions|azn_listings|usdt_listings|nft_market_[a-z_]+|polymarket_trades)$/;

// ---- DDL (tables owned by Marketplace, created in lib/schema-migrations.ts) -------------------
const ddlFile = path.join(src, "lib/schema-migrations.ts");
const ddlText = read(ddlFile).split("\n");
const tables = [];
ddlText.forEach((line, i) => {
  const m = line.match(/CREATE TABLE IF NOT EXISTS ([a-z_]+)/);
  if (m && scopeTablePattern.test(m[1])) tables.push({ table: m[1], ddl: `artifacts/api-server/src/lib/schema-migrations.ts:${i + 1}` });
});
const tableNames = tables.map((t) => t.table);
// float-typed columns (REAL) declared inside the Marketplace CREATE TABLE statements
const realColumns = [];
for (const t of tables) {
  const start = Number(t.ddl.split(":")[1]) - 1;
  for (let i = start; i < Math.min(ddlText.length, start + 40); i++) {
    if (i > start && /CREATE TABLE/.test(ddlText[i])) break;
    const m = ddlText[i].match(/^\s+([a-z_]+)\s+(REAL|DOUBLE PRECISION|FLOAT)\b/i);
    if (m) realColumns.push({ table: t.table, column: m[1], type: m[2].toUpperCase() });
    if (/^\s*\)`?,?\s*$/.test(ddlText[i])) break;
  }
}

// ---- registration order (routes/index.ts) -------------------------------------
const indexText = read(path.join(routeDir, "index.ts"));
const importName = new Map();
for (const m of indexText.matchAll(/^import (\w+) from "\.\/([\w-]+)";/gm)) importName.set(m[1], m[2]);
const registration = [];
for (const m of indexText.matchAll(/^router\.use\(\s*(?:"[^"]*"\s*,\s*)?(\w+)\s*\)/gm)) registration.push(importName.get(m[1]) ?? m[1]);
const regIndex = (file) => registration.indexOf(path.basename(file, ".ts"));

// ---- per-route parse ------------------------------------------------------------
const METHODS = "get|post|put|patch|delete";
function parseRoutes(file) {
  const text = read(file);
  // Ownership gates are usually small factories: `function gate(action) { return requireOwnership(...) }` or a const arrow.
  const ownerGates = new Set();
  for (const m of text.matchAll(/requireOwnership\(/g)) {
    const before = text.slice(Math.max(0, m.index - 400), m.index);
    const fn = [...before.matchAll(/(?:function\s+(\w+)|const\s+(\w+)\s*(?::[^=]+)?=)/g)].pop();
    if (fn) ownerGates.add(fn[1] ?? fn[2]);
  }
  const fileWideAuth = /router\.use\(\s*requireAuth/.test(text);
  const inlineAuth = /\brequireUser\(/.test(text) && !/\brequireAuth\b/.test(text);
  const out = [];
  for (const m of text.matchAll(new RegExp(`router\\.(${METHODS})\\(\\s*(["'\`])([^"'\`]+)\\2`, "g"))) {
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 600);
    const cut = after.search(/\basync\b|\(\s*_?req\b|=>|\bfunction\b/);
    const seg = cut === -1 ? after : after.slice(0, cut);
    const idents = [...seg.matchAll(/\b[A-Za-z_]\w*\b/g)].map((x) => x[0]);
    const admin = idents.some((i) => /^(requireAdmin|requireRoles|requireSuperAdmin)$/.test(i));
    const auth = idents.includes("requireAuth") || fileWideAuth || admin;
    const owner = idents.includes("requireOwnership") || idents.some((i) => ownerGates.has(i));
    const access = admin ? "admin" : inlineAuth ? "inline-auth" : auth ? "authenticated" : "public";
    out.push({ method: m[1].toUpperCase(), path: m[3], access, ownerCheck: owner, line: text.slice(0, m.index).split("\n").length });
  }
  return out;
}

const SQL_TABLE = new RegExp(`\\b(${tableNames.join("|")})\\b`, "g");
const WRITE = (t) => new RegExp(`(INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+(?:public\\.)?${t}\\b`, "i");
const count = (text, re) => (text.match(re) || []).length;

const files = routeFiles.map((f) => {
  const text = read(f);
  const referenced = [...new Set(text.match(SQL_TABLE) || [])].sort();
  return {
    file: rel(f), lines: text.split("\n").length - (text.endsWith("\n") ? 1 : 0),
    registrationIndex: regIndex(f),
    poolQuery: count(text, /\bpool\.query\b/g), clientQuery: count(text, /\b(?:client|c)\.query\b/g),
    transactions: count(text.replace(/\/\/[^\n]*/g, ""), /\.query\(\s*["'`]BEGIN["'`]/g), forUpdate: count(text, /FOR UPDATE/g),
    drizzle: /from "drizzle-orm"|\bdb\.(select|insert|update|delete)\b/.test(text),
    anyUsages: count(text, /\bas any\b|:\s*any\b/g), errMessage: count(text, /\b(?:e|err|error)\.message\b/g),
    ownershipGateDeclared: /requireOwnership\(/.test(text),
    tablesReferenced: referenced, tablesWritten: referenced.filter((t) => WRITE(t).test(text)),
    otherTouched: ["credits", "builtin_wallet_tokens", "users", "vault_entries", "wallets", "local_accounts"].filter((t) => new RegExp(`\\b(FROM|JOIN|INTO|UPDATE)\\s+${t}\\b`, "i").test(text)),
    otherWritten: ["credits", "builtin_wallet_tokens", "wallets"].filter((t) => WRITE(t).test(text)),
  };
});

const routes = [];
for (const f of routeFiles) for (const r of parseRoutes(f)) routes.push({ file: path.basename(f), ...r });
// order = router registration index, then the route's ordinal inside its file (stable when lines shift, e.g. a new import)
{
  const seenInFile = new Map();
  for (const r of [...routes].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
    const n = seenInFile.get(r.file) ?? 0; seenInFile.set(r.file, n + 1);
    r.order = `${String(regIndex(r.file)).padStart(3, "0")}.${String(n).padStart(3, "0")}`;
  }
}
routes.sort((a, b) => a.order.localeCompare(b.order));

// ---- owner map (docs/antas/marketplace/marketplace-route-owner-map.csv) --------------------
const ownerCsv = path.join(root, "docs/antas/marketplace/marketplace-route-owner-map.csv");
const owners = new Map();
if (fs.existsSync(ownerCsv)) for (const line of read(ownerCsv).trim().split("\n").slice(1)) {
  const [method, p, file, owner, phase] = line.split(",");
  owners.set(`${method} ${p} ${file}`, { owner, phase });
}
const problems = [];
for (const r of routes) {
  const o = owners.get(`${r.method} ${r.path} ${r.file}`);
  if (!o) problems.push(`no owner row: ${r.method} ${r.path} (${r.file})`); else { r.proposedOwner = o.owner; r.phase = o.phase; }
}
const seen = new Set(routes.map((r) => `${r.method} ${r.path} ${r.file}`));
for (const k of owners.keys()) if (!seen.has(k)) problems.push(`owner row without route: ${k}`);

// ---- code outside Marketplace that touches Marketplace tables ------------------------
const external = [];
const inScope = new Set(routeFiles);
for (const f of walk(src)) {
  if (!/\.(ts|tsx|mjs)$/.test(f) || /\.test\./.test(f) || inScope.has(f) || f === ddlFile || f.startsWith(path.join(src, "marketplace") + path.sep)) continue;
  const text = read(f);
  const hit = [...new Set(text.match(SQL_TABLE) || [])].sort();
  if (hit.length) external.push({ file: rel(f), tables: hit, writes: hit.filter((t) => WRITE(t).test(text)) });
}
const polymarketRefs = walk(src).filter((f) => /\.(ts|tsx|mjs)$/.test(f) && !inScope.has(f) && !f.startsWith(path.join(src, "marketplace") + path.sep) && /polymarket/i.test(read(f))).map(rel);
const tests = walk(src).filter((f) => /\.test\.(ts|mjs)$/.test(f) && /marketplace|polymarket|spot_|staking/i.test(read(f))).map(rel);

// ---- frozen surface ---------------------------------------------------------------
const surface = routes.map(({ order, file, method, path: p, access, ownerCheck }) => ({ order, file, method, path: p, access, ownerCheck }));
const hash = crypto.createHash("sha256").update(JSON.stringify(surface)).digest("hex");
const frozenFile = path.join(root, "reports/antas/marketplace/marketplace-frozen-routes.json");

if (args.has("--check")) {
  if (!fs.existsSync(frozenFile)) { console.error("MKT frozen route check: FAIL (no frozen file; run with --freeze first)"); process.exit(1); }
  const frozen = JSON.parse(read(frozenFile));
  const key = (r) => `${r.method} ${r.path} ${r.file}`;
  const fm = new Map(frozen.routes.map((r) => [key(r), r])); const cm = new Map(surface.map((r) => [key(r), r]));
  const drift = [];
  for (const [k, r] of fm) { const c = cm.get(k); if (!c) drift.push(`removed: ${k}`); else { if (c.order !== r.order) drift.push(`moved (registration order): ${k} ${r.order} -> ${c.order}`); if (c.access !== r.access || c.ownerCheck !== r.ownerCheck) drift.push(`access changed: ${k} ${r.access}/${r.ownerCheck} -> ${c.access}/${c.ownerCheck}`); } }
  for (const k of cm.keys()) if (!fm.has(k)) drift.push(`added: ${k}`);
  console.log(`Marketplace frozen route check: ${drift.length ? "FAIL" : "PASS"} (${surface.length} routes now, ${frozen.count} frozen)`);
  drift.forEach((d) => console.log("  " + d));
  process.exit(drift.length ? 1 : 0);
}

if (args.has("--freeze")) {
  fs.writeFileSync(frozenFile, JSON.stringify({ schemaVersion: 1, phase: "MKT-00", note: "Frozen Marketplace + Polymarket route surface. 'order' is router registration index then the route's ordinal inside its file; adding, removing, reordering or changing the access class of a route fails --check, moving lines does not.", count: surface.length, sha256: hash, routes: surface }, null, 2) + "\n");
}

// ---- outputs -----------------------------------------------------------------------------
const sum = (k) => files.reduce((n, f) => n + f[k], 0);
const totals = { routeFiles: files.length, routes: routes.length, lines: sum("lines"), poolQuery: sum("poolQuery"), clientQuery: sum("clientQuery"), transactions: sum("transactions"), forUpdate: sum("forUpdate"), anyUsages: sum("anyUsages"), errMessage: sum("errMessage"), tables: tables.length, realFloatColumns: realColumns.length, testsCoveringMarketplace: tests.length, externalFiles: external.length, publicRoutes: routes.filter((r) => r.access === "public").length, inlineAuthRoutes: routes.filter((r) => r.access === "inline-auth").length, adminRoutes: routes.filter((r) => r.access === "admin").length, ownerCheckedRoutes: routes.filter((r) => r.ownerCheck).length };

fs.mkdirSync(path.join(root, "reports/antas/marketplace"), { recursive: true });
fs.writeFileSync(path.join(root, "reports/antas/marketplace/marketplace-migration-map.json"), JSON.stringify({
  schemaVersion: 1, phase: "MKT-00", generatedBy: "scripts/antas/marketplace/generate-inventory.mjs",
  basis: "static scan of the tree; no database, no build, no commit SHA (no .git)", totals, surfaceSha256: hash,
  files, routes, tables, realFloatColumns: realColumns, externalAccess: external, polymarketReferencesOutside: polymarketRefs, tests, mappingProblems: problems,
}, null, 2) + "\n");

const md = [];
md.push("# Marketplace inventory (MKT-00)", "", "Generated by `node scripts/antas/marketplace/generate-inventory.mjs` from the tree. Static scan: no database, no build, no commit SHA (no `.git`). Machine-readable twin: `reports/antas/marketplace/marketplace-migration-map.json`. Frozen route surface: `reports/antas/marketplace/marketplace-frozen-routes.json` (check with `--check`).", "");
md.push("## Totals", "", "| Item | Count |", "|---|---|");
for (const [k, v] of Object.entries(totals)) md.push(`| ${k} | ${v} |`);
md.push("", `Route surface hash (sha256): \`${hash}\``, "", "## Route files", "", "| File | Reg # | Lines | Routes | pool.query | client.query | BEGIN | FOR UPDATE | any | e.message | Drizzle | PEP declared |", "|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const f of files) md.push(`| \`${f.file.replace("artifacts/api-server/src/", "")}\` | ${f.registrationIndex} | ${f.lines} | ${routes.filter((r) => `artifacts/api-server/src/routes/${r.file}` === f.file).length} | ${f.poolQuery} | ${f.clientQuery} | ${f.transactions} | ${f.forUpdate} | ${f.anyUsages} | ${f.errMessage} | ${f.drizzle ? "yes" : "no"} | ${f.ownershipGateDeclared ? "yes" : "no"} |`);
md.push("", "## Tables created by Marketplace DDL", "", "| Table | DDL |", "|---|---|");
for (const t of tables) md.push(`| \`${t.table}\` | \`${t.ddl.replace("artifacts/api-server/src/", "")}\` |`);
md.push("", `REAL (float32) columns, money and non-money: ${realColumns.length}. ${realColumns.map((c) => `\`${c.table}.${c.column}\``).join(", ")}`, "");
md.push("## Writes to tables Marketplace does not own", "", "| File | Reads/writes | Writes |", "|---|---|---|");
for (const f of files.filter((x) => x.otherTouched.length)) md.push(`| \`${f.file.replace("artifacts/api-server/src/", "")}\` | ${f.otherTouched.join(", ")} | ${f.otherWritten.join(", ") || "-"} |`);
md.push("", "## Code outside Marketplace that touches Marketplace tables", "", "| File | Tables | Writes |", "|---|---|---|");
for (const e of external) md.push(`| \`${e.file.replace("artifacts/api-server/src/", "")}\` | ${e.tables.join(", ")} | ${e.writes.join(", ") || "-"} |`);
md.push("", `Other files that mention Polymarket: ${polymarketRefs.map((f) => `\`${f.replace("artifacts/api-server/src/", "")}\``).join(", ")}.`, "", `Tests that cover Marketplace: ${tests.length ? tests.join(", ") : "none"}.`, "");
md.push("## Access classification (parsed from route declarations; verify in MKT-02)", "", "| Access | Routes |", "|---|---|");
for (const a of ["public", "authenticated", "admin", "inline-auth"]) md.push(`| ${a} | ${routes.filter((r) => r.access === a).length} |`);
md.push("", "Routes with an ownership gate (`requireOwnership` or a const built from it): " + routes.filter((r) => r.ownerCheck).length + ".", "", problems.length ? "## Mapping problems\n\n" + problems.map((p) => `- ${p}`).join("\n") + "\n" : "Route-owner map: every route has exactly one owner row and no owner row is orphaned.\n");
fs.writeFileSync(path.join(root, "docs/antas/marketplace/marketplace-inventory.md"), md.join("\n"));

console.log(`Marketplace inventory: ${totals.routes} routes in ${totals.routeFiles} files, ${totals.tables} tables, ${totals.externalFiles} outside files touch them, ${totals.testsCoveringMarketplace} tests, mapping problems: ${problems.length}`);
if (problems.length) { problems.forEach((p) => console.log("  " + p)); process.exit(1); }
