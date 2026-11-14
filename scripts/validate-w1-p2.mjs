#!/usr/bin/env node
/**
 * W1-P2 validator (per-module credentials + per-module sessions). Static: needs no database and no installed deps.
 * The behavioral proof lives in:
 *   artifacts/api-server/src/lib/module-auth-service.db.test.ts   (real Postgres)
 *   artifacts/api-server/src/lib/module-session-policy.test.ts, module-request-context.test.ts, module-password.test.ts
 *
 *   node scripts/validate-w1-p2.mjs
 *
 * Two jobs:
 *  1. The places that must agree about the module list / event & method vocabularies actually agree
 *     (registry <-> migration 126 <-> boot mirror <-> drizzle <-> service).
 *  2. The WIRING that keeps modules isolated is still in place. These are the edits a refactor could silently drop:
 *     each one, if removed, lets a session or token cross a module boundary.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MODULES } from "../packages/module-registry/src/index.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");
const has = (rel) => existsSync(join(root, rel));
const errors = [];
const check = (cond, msg) => { if (!cond) errors.push(msg); };
const norm = (s) => s.replace(/\s+/g, " ").replace(/\s*([(),;])\s*/g, "$1").trim();
const idx = (src, needle) => src.indexOf(needle);

const MIGRATION = "migrations/126_module_credentials_sessions.sql";
const API = "artifacts/api-server/src";
check(has(MIGRATION), `${MIGRATION} is missing`);
const sql = has(MIGRATION) ? read(MIGRATION) : "";
const ids = MODULES.map((m) => m.id);
// Parsed from source (not imported): the registry package needs an installed workspace dependency, and this validator
// must run with zero installs. Rows look like  ["identity", "POST", "/api/auth/login", "public", "identity:write", ...].
const ENDPOINT_ROWS = [...read("packages/endpoint-registry/src/index.mjs").matchAll(/\["(\w+)", "([A-Z]+)", "([^"]+)", "(\w+)"/g)]
  .map((m) => ({ owner: m[1], method: m[2], path: m[3], auth: m[4] }));
check(ENDPOINT_ROWS.length > 1000, `parsed only ${ENDPOINT_ROWS.length} endpoint-registry rows`);

// ── 1. agreement ─────────────────────────────────────────────────────────────
// 1a. every module CHECK list in the migration equals the registry
const lists = [...sql.matchAll(/module IN \(([^)]*)\)/g)].map((m) => [...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]).sort());
check(lists.length >= 2, "expected module CHECK lists in the migration (user_sessions + module_auth_events)");
for (const l of lists) check(JSON.stringify(l) === JSON.stringify([...ids].sort()), `migration module CHECK list [${l}] != registry [${ids}]`);

// 1b. boot mirror: every statement of the SQL file appears (whitespace-normalised) in schema-migrations.ts
const boot = norm(read(`${API}/lib/schema-migrations.ts`));
const statements = [];
{
  let cur = []; let inDollar = false;
  for (const line of sql.split("\n")) {
    if (!inDollar && /^\s*--/.test(line)) continue;
    if (!inDollar && cur.length === 0 && line.trim() === "") continue;
    cur.push(line);
    if ((line.match(/\$\$/g) || []).length % 2 === 1) inDollar = !inDollar;
    if (!inDollar && /;\s*$/.test(line)) { statements.push(cur.join("\n").trim().replace(/;$/, "")); cur = []; }
  }
}
check(statements.length >= 15, `parsed only ${statements.length} statements from ${MIGRATION}`);
for (const s of statements) check(boot.includes(norm(s)), `schema-migrations.ts (boot mirror) is missing/different from: ${s.slice(0, 70).replace(/\s+/g, " ")}…`);

// 1c. vocabularies: service <-> SQL
const svc = read(`${API}/lib/module-auth-service.ts`);
// W1-P5 (migration 128) widened the event list again; the LAST definition wins, exactly as in the database.
const sql127 = read("migrations/128_module_external_identities.sql");
const sqlEvents = [...(/event IN \(([^)]*)\)/.exec(sql127)?.[1] ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
const tsEvents = [...(/type AuthEvent =([^;]*);/.exec(svc)?.[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();
check(JSON.stringify(sqlEvents) === JSON.stringify(tsEvents) && sqlEvents.length > 0, `audit events: SQL [${sqlEvents}] != service [${tsEvents}]`);
const sqlMethods = [...(/method IN \(([^)]*)\)/.exec(sql)?.[1] ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
for (const m of ["backing", "legacy_continue"]) check(sqlMethods.includes(m), `link method '${m}' missing from the SQL CHECK`);
check(/CHECK \(password_hash LIKE '\$argon2id\$%'\)/.test(sql), "module_credentials must CHECK password_hash LIKE '$argon2id$%'");
check(/FOREIGN KEY \(module_account_id, module\) REFERENCES module_accounts\(id, module\)/.test(sql), "composite (account, module) foreign keys are missing");
check((sql.match(/FOREIGN KEY \(module_account_id, module\)/g) || []).length >= 4, "credentials, links, resets and sessions must all use the composite FK");

// 1d. drizzle
check(has("lib/db/src/schema/module-credentials.ts"), "lib/db/src/schema/module-credentials.ts is missing");
check(/export \* from "\.\/module-credentials";/.test(read("lib/db/src/schema/index.ts")), "lib/db schema index does not export module-credentials");
for (const t of ["module_credentials", "module_account_links", "module_password_resets", "module_auth_events"]) {
  check(read("lib/db/src/schema/module-credentials.ts").includes(`"${t}"`), `drizzle schema has no table ${t}`);
  check(sql.includes(`'${t}'`), `${t} is not registered in service_table_ownership`);
}

// ── 2. isolation wiring ──────────────────────────────────────────────────────
const authUtils = read(`${API}/lib/auth-utils.ts`);
{
  const decide = idx(authUtils, "decideTokenModuleAccess({");
  const live = idx(authUtils, "checkModuleSession(");
  const oidcFallthrough = idx(authUtils, "verifyOidcAccessToken(token)");
  check(decide > 0 && live > 0 && oidcFallthrough > 0, "auth-utils.ts: module access decision / live-session check / OIDC step not found");
  check(decide < live && live < oidcFallthrough, "auth-utils.ts: the module decision and live-session check must run BEFORE the OIDC/Supabase/legacy fall-through");
  check(/if \(!access\.allow\)[\s\S]{0,400}return null;/.test(authUtils), "auth-utils.ts: a denied module decision must return null (not fall through)");
  check(/if \(verified\?\.mod\) throw new AuthError/.test(authUtils), "auth-utils.ts: getUserIdSync must refuse module tokens");
  check(/selectSessionToken\(/.test(authUtils) && /resolveRequestModule\(req\.hostname\)/.test(authUtils), "auth-utils.ts: getTokenFromReq must pick the cookie by the request's own Host");
}
const jwt = read(`${API}/lib/jwt.ts`);
check(/parseModuleClaims\(decoded\)/.test(jwt) && /if \(!moduleClaims\.ok\) return null;/.test(jwt), "jwt.ts: malformed module claims must invalidate the token");
check(/signAuthToken: mod and mac must be passed together/.test(jwt), "jwt.ts: signAuthToken must refuse a lone mod or mac");

const auth = read(`${API}/routes/auth.ts`);
{
  const refreshModule = idx(auth, "if (decoded?.mod) {");
  const refreshShared = idx(auth, "if (decoded?.sid && (await touchSession(decoded.sid))) {");
  check(refreshModule > 0 && refreshShared > refreshModule, "routes/auth.ts: /auth/refresh must handle module tokens BEFORE the branch that mints a shared session");
  check((auth.match(/refuseModuleSession\(res, result\)/g) || []).length === 3, "routes/auth.ts: sessions list/revoke/revoke-others must each refuse module sessions");
  check(/if \(originalClaims\?\.mod\) \{[\s\S]{0,300}status\(403\)[\s\S]{0,200}CENTRAL_SESSION_REQUIRED/.test(auth), "routes/auth.ts: /auth/session-exchange must refuse module sessions with a 403");
  check(/moduleDecoded\?\.mod/.test(auth) && /clearModuleSessionCookie\(res, moduleDecoded\.mod\)/.test(auth), "routes/auth.ts: /auth/logout must end only the module session for a module token");
}
check(/resolved && !resolved\.moduleId/.test(read(`${API}/routes/oidc-authorize.ts`)), "routes/oidc-authorize.ts: a module session must not count as a central login");
check(/user\.moduleId[\s\S]{0,200}CENTRAL_SESSION_REQUIRED/.test(read(`${API}/middlewares/auth.ts`)), "middlewares/auth.ts: requireSessionAuth must refuse module sessions");

const app = read(`${API}/app.ts`);
{
  const cp = idx(app, "app.use(cookieParser());");
  const ctx = idx(app, "app.use(moduleRequestContext);");
  const firstRouter = idx(app, "app.use(wellKnownJwksRouter);");
  check(cp > 0 && ctx > cp, "app.ts: moduleRequestContext must be mounted after cookieParser");
  check(ctx > 0 && firstRouter > ctx, "app.ts: moduleRequestContext must be mounted before the first router (well-known / oidc / api)");
}
check(/router\.use\(moduleAuthRouter\)/.test(read(`${API}/routes/index.ts`)), "routes/index.ts does not mount moduleAuthRouter");

const cookie = read(`${API}/lib/session-cookie.ts`);
{
  const body = /export function setModuleSessionCookie[\s\S]*?\n}\n/.exec(cookie)?.[0] ?? "";
  check(body.length > 0, "session-cookie.ts: setModuleSessionCookie not found");
  check(!/domain\s*:/.test(body), "session-cookie.ts: the module cookie must be host-only (no Domain attribute)");
  check(/path: "\/"/.test(body) && /httpOnly: true/.test(body) && /secure: isProd\(\)/.test(body), "session-cookie.ts: module cookie needs Path=/, HttpOnly and Secure in production (required by the __Host- prefix)");
  check(/moduleCookieName\(module\)/.test(body), "session-cookie.ts: module cookie must be named by moduleCookieName()");
}
const policy = read(`${API}/lib/module-session-policy.ts`);
check(/hostPrefix \? "__Host-" : ""/.test(policy), "module-session-policy.ts: production cookie must carry the __Host- prefix");
check(/let mode: ModuleSessionsMode = "off";/.test(policy), "module-session-policy.ts: the default mode must be 'off' (feature flag + kill switch)");

// every route the module router serves is registered in the endpoint registry, with the intended access level
const routesSrc = read(`${API}/routes/module-auth.ts`);
const served = [...routesSrc.matchAll(/router\.(get|post)\("(\/auth\/module\/[a-z/-]+)"/g)].map((m) => [m[1].toUpperCase(), `/api${m[2]}`]);
check(served.length === 10, `routes/module-auth.ts should serve 10 routes, found ${served.length}`);
for (const [method, path] of served) {
  const row = ENDPOINT_ROWS.find((e) => e.method === method && e.path === path);
  check(!!row, `endpoint-registry has no row for ${method} ${path}`);
  if (row && path.endsWith("/continue")) check(row.auth === "user", "/continue needs an authenticated (shared) session in the registry");
}
for (const path of served.map((s) => s[1]).filter((p) => /\/(signup|login|password-reset)/.test(p))) {
  const row = ENDPOINT_ROWS.find((e) => e.path === path);
  check(row?.auth === "public", `${path} must be public in the endpoint registry (it is how a visitor authenticates)`);
}
check((routesSrc.match(/moduleGate/g) || []).length >= 8, "routes/module-auth.ts: every route must be behind moduleGate");
check(/req\.body\?\.module/.test(routesSrc) === false, "routes/module-auth.ts: the module must never be read from the request body");
check(/jsonOnly/.test(routesSrc) && (routesSrc.match(/jsonOnly,/g) || []).length >= 5, "routes/module-auth.ts: state-changing routes must require application/json");

// ── 3. docs / ops ────────────────────────────────────────────────────────────
check(has("CHANGES_W1_P2_MODULE_CREDENTIALS.md"), "CHANGES_W1_P2_MODULE_CREDENTIALS.md is missing");
check(has("docs/operations/module-sessions-rollout.md"), "docs/operations/module-sessions-rollout.md (rollout + rollback runbook) is missing");
const env = has(".env.example") ? read(".env.example") : "";
for (const v of ["MODULE_SESSIONS_MODE", "MODULE_SESSIONS_LEGACY_UNTIL"]) check(env.includes(v), `.env.example does not document ${v}`);

if (errors.length) {
  console.error("W1_P2_VALIDATION: FAIL");
  for (const e of errors) console.error(` - ${e}`);
  process.exit(1);
}
console.log("W1_P2_VALIDATION: PASS");
console.log(JSON.stringify({ migration: 126, modules: ids.length, statementsMirrored: statements.length, routes: served.length }));
