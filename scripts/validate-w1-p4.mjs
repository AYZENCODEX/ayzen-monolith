#!/usr/bin/env node
/**
 * scripts/validate-w1-p4.mjs — W1-P4 static validator ("Login with AYZEN" on all modules). Install-free.
 * Pins the wiring that the behavior tests cannot see (route guard order, no cookie fallback, allow-list = registry, ...).
 *   node scripts/validate-w1-p4.mjs            # validate the tree
 *   node scripts/validate-w1-p4.mjs --self-test  # prove each rule fails on a deliberate breakage
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API = "artifacts/api-server/src";
const SPA = "artifacts/ayzen/src";

/** Each rule: [id, (files) => problem string | null]. `files` maps path -> text, so self-test can mutate. */
const FILES = [
  `${API}/routes/module-auth.ts`, `${API}/lib/module-auth-service.ts`, `${API}/lib/schema-migrations.ts`, "migrations/127_module_oidc_audit_events.sql",
  `${API}/lib/oidc-rollout-scope.ts`, `${API}/routes/admin-oidc-rollout.ts`, "scripts/src/set-oidc-rollout-flag.ts", `${API}/lib/oidc-cutover-gate.ts`,
  `${API}/routes/oidc-authorize.ts`, `${API}/lib/oidc-central-origin.ts`, `${SPA}/pages/login.tsx`, `${SPA}/pages/oidc-callback.tsx`, `${SPA}/pages/register.tsx`,
  `${SPA}/lib/module-oidc-login.ts`, `${SPA}/lib/sylo-oidc-callback.ts`, "packages/endpoint-registry/src/index.mjs", ".github/workflows/ci.yml",
];
const load = () => Object.fromEntries(FILES.map((f) => [f, readFileSync(join(ROOT, f), "utf8")]));

const handler = (src, route) => {
  const i = src.indexOf(route);
  if (i < 0) return "";
  const rest = src.slice(i + route.length);
  const j = rest.search(/\nrouter\.(get|post)\(|\nconst RESET_ACK/);
  return rest.slice(0, j < 0 ? undefined : j);
};
const order = (text, needles) => {
  let at = -1;
  for (const n of needles) { const i = text.indexOf(n, at + 1); if (i < 0) return `missing '${n}'`; at = i; }
  return null;
};

const RULES = [
  ["oidc route: gates then guards in order (flag, verify, client match, openid, freshness, then service)", (f) => {
    const h = handler(f[`${API}/routes/module-auth.ts`], 'router.post("/auth/module/oidc", moduleGate, authLimiter, jsonOnly');
    if (!h) return 'POST /auth/module/oidc with moduleGate, authLimiter, jsonOnly not found';
    return order(h, ["getOidcRolloutFlag(def.oidcClientId)", "verifyOidcAccessToken(", "v.token.clientId !== def.oidcClientId", '"openid"', "OIDC_SIGNIN_MAX_TOKEN_AGE_SECONDS", "linkAyzenToModuleAccount(", "oidcSignIn("]);
  }],
  ["oidc route: identity comes from the verified token only (no cookie / Authorization fallback, no body user id)", (f) => {
    const h = handler(f[`${API}/routes/module-auth.ts`], 'router.post("/auth/module/oidc", moduleGate');
    if (/getSessionCookie|req\.cookies|authorization|body\.(user_?id|ayzen_?user_?id)/i.test(h)) return "route reads a cookie/header/body user id instead of the OIDC token";
    const ids = [...h.matchAll(/ayzenUserId: ([^,}\s]+)/g)].map((m) => m[1]);
    if (ids.length < 4 || ids.some((x) => x !== "v.token.userId")) return `every ayzenUserId must be v.token.userId, found [${ids}]`;
    return /Math\.floor\(Date\.now\(\) \/ 1000\) - v\.token\.iat > OIDC_SIGNIN_MAX_TOKEN_AGE_SECONDS/.test(h) ? null : "token freshness comparison missing";
  }],
  ["options route is public-safe: only module, label and four booleans", (f) => {
    const h = handler(f[`${API}/routes/module-auth.ts`], 'router.get("/auth/module/options", moduleGate');
    return /res\.json\(\{ module, label: def\.label, password: true, signup: true, oidc: await getOidcRolloutFlag\(def\.oidcClientId\), social: readClerkConfig\(module\) !== null \}\)/.test(h) ? null : "options response shape changed";
  }],
  ["both routes are in the endpoint registry", (f) => {
    const r = f["packages/endpoint-registry/src/index.mjs"];
    return ['"GET", "/api/auth/module/options"', '"POST", "/api/auth/module/oidc"'].every((x) => r.includes(x)) ? null : "registry rows missing";
  }],
  ["service: link verifies credentials via loginWithPassword, locks NO KEY UPDATE, and refuses AFTER the transaction", (f) => {
    const s = f[`${API}/lib/module-auth-service.ts`];
    const i = s.indexOf("export async function linkAyzenToModuleAccount");
    const body = s.slice(i, s.indexOf("// ─── Logout ──"));
    if (!/await loginWithPassword\(db,/.test(body)) return "link no longer verifies the module password through loginWithPassword";
    if (/FOR UPDATE/.test(body.replace(/FOR NO KEY UPDATE/g, ""))) return "plain FOR UPDATE inside link (self-deadlocks with the audit insert)";
    if (!/FOR NO KEY UPDATE/.test(body)) return "account row is not locked while linking";
    const tx = body.slice(body.indexOf("db.transaction"), body.indexOf("} catch (e)"));
    if (/db\.query\(/.test(tx)) return "db.query inside the link transaction (second connection waits on our own lock)";
    return ["ALREADY_HAS_MODULE_ACCOUNT", "ACCOUNT_ALREADY_LINKED", "23505", "revoked_at = NOW()"].every((x) => body.includes(x)) ? null : "a refusal path (conflict codes / unique-race / session revoke) is missing";
  }],
  ["service: oidcSignIn checks both the AYZEN identity and the account owner are in good standing, and resolves links first", (f) => {
    const s = f[`${API}/lib/module-auth-service.ts`];
    const b = s.slice(s.indexOf("export async function oidcSignIn"), s.indexOf("export async function linkAyzenToModuleAccount"));
    if ((b.match(/\[input\.ayzenUserId, acct\.user_id\]/g) ?? []).length < 2 || !/banned/.test(b) || !/suspended/.test(b)) return "status check must cover both users (query AND check)";
    return order(b, ["FROM module_account_links l", "ayzen_provision_module_account", "'oidc'"]);
  }],
  ["migration 127 is mirrored at boot and lists the new events", (f) => {
    const sql = f["migrations/127_module_oidc_audit_events.sql"];
    if (!/'oidc_login','link'\)\)/.test(sql)) return "migration lacks oidc_login/link";
    const boot = f[`${API}/lib/schema-migrations.ts`].replace(/\s+/g, " ");
    return boot.includes("DROP CONSTRAINT IF EXISTS module_auth_events_event_chk") && boot.includes("'oidc_login','link'") ? null : "schema-migrations.ts boot mirror missing";
  }],
  ["rollout allow-list is the registry's client ids, used by the admin route and the CLI; legacy cutover stays Sylo-only", (f) => {
    if (!/new Set\(MODULES\.map\(\(m\) => m\.oidcClientId\)\)/.test(f[`${API}/lib/oidc-rollout-scope.ts`])) return "allow-list no longer derived from the registry";
    for (const p of [`${API}/routes/admin-oidc-rollout.ts`, "scripts/src/set-oidc-rollout-flag.ts"]) if (!f[p].includes("ROLLOUT_ALLOWED_WITHOUT_OVERRIDE")) return `${p} does not use the shared allow-list`;
    return /CUTOVER_SCOPED_APP_IDS = new Set\(\["sylo"\]\)/.test(f[`${API}/lib/oidc-cutover-gate.ts`]) ? null : "the legacy login cutover gate must stay Sylo-only in W1-P4";
  }],
  ["authorize: signup hint and dedicated-issuer UI origin go through the helper; helper only deviates for a dedicated issuer host", (f) => {
    const a = f[`${API}/routes/oidc-authorize.ts`];
    if (!a.includes("centralAuthPath(req.query.screen_hint)") || (a.match(/centralUiOrigin\(/g) ?? []).length < 2) return "authorize does not use centralAuthPath/centralUiOrigin for login AND consent";
    return /issuer !== app && issuer === requestOrigin/.test(f[`${API}/lib/oidc-central-origin.ts`]) ? null : "centralUiOrigin condition changed";
  }],
  ["login page: module options are asked first and replace both the legacy form and the auto-redirect", (f) => {
    const l = f[`${SPA}/pages/login.tsx`];
    return order(l, ["getModuleAuthOptions().then", "setModuleOptions(opts)", "getSyloOidcRolloutFlag(subdomainApp.id)", "if (moduleOptions) return <ModuleAuthScreen"]);
  }],
  ["callback page: module exchange only when options say oidc is on; link flow keeps the token in memory (never storage)", (f) => {
    const c = f[`${SPA}/pages/oidc-callback.tsx`];
    if (!/moduleOpts\?\.oidc/.test(c) || !c.includes("exchangeModuleOidcSession(tokens.access_token)") || !c.includes("exchangeSyloSessionCookie")) return "module/legacy exchange selection changed";
    return /(sessionStorage|localStorage)\.setItem\([^)]*(access|token|password)/i.test(c) ? "token/password written to browser storage" : null;
  }],
  ["startModuleOidcLogin runs only on the module's own host and never stores credentials", (f) => {
    const m = f[`${SPA}/lib/module-oidc-login.ts`];
    if (!m.includes("getCurrentSubdomainApp()?.id !== def.id") || !m.includes("config.clientId !== def.oidcClientId")) return "host/client guard missing";
    return /password|access_token/.test(m.replace(/\/\*[\s\S]*?\*\//g, "")) ? "login starter must not touch passwords or tokens" : null;
  }],
  ["register page resumes an in-flight authorize through login (flow 2)", (f) => f[`${SPA}/pages/register.tsx`].includes('"/oidc/authorize", "/oidc/consent"') && f[`${SPA}/pages/register.tsx`].includes("/login?return_to=") ? null : "register ignores return_to"],
  ["callback identity cross-check honors the reported AYZEN identity (explicit link), not blindly the session user", (f) => f[`${SPA}/lib/sylo-oidc-callback.ts`].includes("sessionResult.ayzenUserId ?? sessionResult.user.id") ? null : "cross-check changed"],
  ["CI runs this validator and the W1-P4 tests", (f) => { const c = f[".github/workflows/ci.yml"]; return c.includes("validate-w1-p4.mjs") && c.includes("oidc:test-module-login") ? null : "ci.yml does not run validate-w1-p4.mjs and the module-login tests"; }],
];

function run(files) { return RULES.flatMap(([id, fn]) => { let p; try { p = fn(files); } catch (e) { p = `threw: ${e.message}`; } return p ? [`${id}: ${p}`] : []; }); }

if (process.argv.includes("--self-test")) {
  const base = load();
  const clean = run(base);
  if (clean.length) { console.error("self-test needs a clean tree first:\n - " + clean.join("\n - ")); process.exit(1); }
  const R = `${API}/routes/module-auth.ts`, S = `${API}/lib/module-auth-service.ts`;
  const mutants = [
    ["drop the rollout flag check", R, "if (!(await getOidcRolloutFlag(def.oidcClientId))) {", "if (false) {"],
    ["drop the client match", R, "v.token.clientId !== def.oidcClientId", "false"],
    ["drop openid scope check", R, 'if (!v.token.scopes.includes("openid"))', "if (false)"],
    ["drop token freshness", R, "> OIDC_SIGNIN_MAX_TOKEN_AGE_SECONDS", "> 0 * OIDC_SIGNIN_MAX_TOKEN_AGE_SECONDS && false"],
    ["fall back to the shared cookie", R, "const accessToken = str(body.access_token);", "const accessToken = str(body.access_token) ?? getSessionCookie(req);"],
    ["trust a body user id", R, "ayzenUserId: v.token.userId, client", "ayzenUserId: Number((body as any).ayzenUserId), client"],
    ["plain FOR UPDATE in link", S, "FOR NO KEY UPDATE", "FOR UPDATE"],
    ["audit inside link transaction", S, "      await q(`SELECT id FROM module_accounts WHERE id = $1 FOR NO KEY UPDATE`", "      await db.query(`SELECT 1`);\n      await q(`SELECT id FROM module_accounts WHERE id = $1 FOR NO KEY UPDATE`"],
    ["link skips password check", S, "const login = await loginWithPassword(db,", "const login = await (async (_d: unknown, _i: unknown) => ({ ok: true } as any))(db,"],
    ["oidcSignIn checks only the owner", S, "[input.ayzenUserId, acct.user_id]])).rows as", "[acct.user_id]])).rows as"],
    ["allow-list hardcoded", `${API}/lib/oidc-rollout-scope.ts`, "new Set(MODULES.map((m) => m.oidcClientId))", 'new Set(["sylo"])'],
    ["cutover gate widened", `${API}/lib/oidc-cutover-gate.ts`, 'CUTOVER_SCOPED_APP_IDS = new Set(["sylo"])', 'CUTOVER_SCOPED_APP_IDS = new Set(["sylo", "ryft"])'],
    ["authorize ignores signup hint", `${API}/routes/oidc-authorize.ts`, "centralAuthPath(req.query.screen_hint)", '"/login"'],
    ["login ignores module options", `${SPA}/pages/login.tsx`, "if (moduleOptions) return <ModuleAuthScreen", "if (false) return <ModuleAuthScreen"],
    ["callback always module-exchanges", `${SPA}/pages/oidc-callback.tsx`, "moduleOpts?.oidc", "true"],
    ["token stored in storage", `${SPA}/pages/oidc-callback.tsx`, "const [linkError,", "window.sessionStorage.setItem('access_token', 'x'); const [linkError,"],
    ["login starter loses host guard", `${SPA}/lib/module-oidc-login.ts`, "getCurrentSubdomainApp()?.id !== def.id", "false"],
    ["callback cross-check blind", `${SPA}/lib/sylo-oidc-callback.ts`, "sessionResult.ayzenUserId ?? sessionResult.user.id", "sessionResult.user.id"],
    ["registry row removed", "packages/endpoint-registry/src/index.mjs", '"/api/auth/module/oidc"', '"/api/auth/module/oidc-x"'],
    ["migration 127 loses events", "migrations/127_module_oidc_audit_events.sql", "'oidc_login','link'))", "'oidc_login'))"],
  ];
  let survived = 0;
  for (const [name, file, from, to] of mutants) {
    if (!base[file].includes(from)) { console.error(`MUTANT NOT APPLICABLE (fix the self-test): ${name}`); survived++; continue; }
    const mutated = { ...base, [file]: base[file].replace(from, to) };
    if (run(mutated).length === 0) { console.error(`SURVIVED: ${name}`); survived++; }
  }
  console.log(survived ? `SELF-TEST FAILED: ${survived} mutant(s) not caught` : `SELF-TEST OK: ${mutants.length}/${mutants.length} mutants caught`);
  process.exit(survived ? 1 : 0);
}

const problems = run(load());
if (problems.length) { console.error("W1_P4_VALIDATION: FAIL\n - " + problems.join("\n - ")); process.exit(1); }
console.log("W1_P4_VALIDATION: PASS");
console.log(JSON.stringify({ rules: RULES.length }));
