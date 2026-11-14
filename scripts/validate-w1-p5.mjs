#!/usr/bin/env node
/**
 * scripts/validate-w1-p5.mjs — W1-P5 static validator (Clerk social login, one Clerk application per module). Install-free.
 * Pins the wiring the behavior tests cannot see: per-module verification, raw-body webhook carve-out, no email auto-link,
 * no Clerk npm dependency / secret key in the browser, registry + docs + CI.
 *   node scripts/validate-w1-p5.mjs            # validate the tree
 *   node scripts/validate-w1-p5.mjs --self-test  # prove each rule fails on a deliberate breakage
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API = "artifacts/api-server/src";
const SPA = "artifacts/ayzen/src";
const FILES = [
  "migrations/128_module_external_identities.sql", `${API}/lib/schema-migrations.ts`, `${API}/routes/module-auth.ts`, `${API}/routes/clerk-webhook.ts`,
  `${API}/routes/index.ts`, `${API}/app.ts`, `${API}/index.ts`, `${API}/lib/clerk-verify.ts`, `${API}/lib/clerk-config.ts`, `${API}/lib/svix-verify.ts`,
  `${API}/lib/module-clerk-service.ts`, "packages/module-registry/src/index.mjs", "packages/endpoint-registry/src/index.mjs",
  `${SPA}/lib/module-clerk.ts`, `${SPA}/pages/clerk-callback.tsx`, `${SPA}/App.tsx`, `${SPA}/lib/subdomain-app.ts`, `${SPA}/components/module-auth-screen.tsx`,
  `${SPA}/lib/module-auth-api.ts`, "docs/identity-boundaries.md", ".env.example", ".github/workflows/ci.yml", "package.json", "artifacts/ayzen/package.json",
];
const load = () => Object.fromEntries(FILES.map((f) => [f, readFileSync(join(ROOT, f), "utf8")]));
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
const order = (text, needles) => { let at = -1; for (const n of needles) { const i = text.indexOf(n, at + 1); if (i < 0) return `missing '${n}'`; at = i; } return null; };
const handler = (src, route) => {
  const i = src.indexOf(route); if (i < 0) return "";
  const rest = src.slice(i + route.length); const j = rest.search(/\nrouter\.(get|post)\(|\nconst RESET_ACK/);
  return rest.slice(0, j < 0 ? undefined : j);
};
const MODS = ["sylo", "ryft", "fyra", "verve", "skarn", "warde", "wisp", "zynth"];

const RULES = [
  ["migration 128: own table (not module_credentials), composite FK, unique (module,provider,external_id), clerk-id CHECK, cascade", (f) => {
    const m = f["migrations/128_module_external_identities.sql"];
    for (const n of ["FOREIGN KEY (module_account_id, module) REFERENCES module_accounts(id, module) ON DELETE CASCADE", "ON module_external_identities(module, provider, external_id)",
      "external_id ~ '^user_[A-Za-z0-9]{8,64}$'", "ON module_external_identities(module_account_id, provider)", "'clerk_login','clerk_user_created','clerk_user_deleted'"]) if (!m.includes(n)) return `missing '${n}'`;
    return /ALTER TABLE module_credentials/.test(m) ? "must not touch module_credentials" : null;
  }],
  ["migration 128 is mirrored at boot (schema-migrations.ts)", (f) => {
    const s = f[`${API}/lib/schema-migrations.ts`];
    return ["CREATE TABLE IF NOT EXISTS module_external_identities", "module_external_identities_ext_idx", "module_external_identities_account_idx", "'clerk_login','clerk_user_created','clerk_user_deleted'", "service_table_ownership"].every((n) => s.includes(n)) ? null : "boot mirror incomplete";
  }],
  ["clerk route: 404 when off, per-module config, verify, then service; module only from moduleOf(res)", (f) => {
    const h = handler(f[`${API}/routes/module-auth.ts`], 'router.post("/auth/module/clerk", moduleGate, authLimiter, jsonOnly');
    if (!h) return "POST /auth/module/clerk with moduleGate, authLimiter, jsonOnly not found";
    const e = order(h, ["moduleOf(res)", "readClerkConfig(module)", "if (!cfg)", "verifyClerkSessionToken(sessionToken, cfg)", "clerkSignIn(", "issue("]);
    if (e) return e;
    return /req\.(body|headers|query)[^;]*module\b/.test(h.replace(/session_token/g, "")) ? "module must not come from the request" : null;
  }],
  ["clerk route: identity fields come from verified claims, never the body", (f) => {
    const h = handler(f[`${API}/routes/module-auth.ts`], 'router.post("/auth/module/clerk", moduleGate, authLimiter, jsonOnly');
    const ids = [...h.matchAll(/clerkUserId: ([^,}\s]+)/g)].map((m) => m[1]);
    return ids.length === 1 && ids[0] === "v.claims.sub" && h.includes("emailVerified: v.claims.emailVerified") ? null : `clerkUserId/emailVerified must come from v.claims (found [${ids}])`;
  }],
  ["email_account_exists is mapped (409) and options advertise `social` from the module's own config", (f) => {
    const r = f[`${API}/routes/module-auth.ts`];
    return /EMAIL_ACCOUNT_EXISTS: 409/.test(r) && /social: readClerkConfig\(module\) !== null/.test(r) ? null : "EMAIL_ACCOUNT_EXISTS status or options.social missing";
  }],
  ["token verification: RS256 only, issuer exact, exp+nbf, azp, per-module JWKS cache", (f) => {
    const v = stripComments(f[`${API}/lib/clerk-verify.ts`]);
    for (const n of ['header.alg !== "RS256"', "claims.iss !== cfg.issuer", "cfg.authorizedParties", "cache.get(cfg.jwksUrl)", "cache.set(cfg.jwksUrl", "not_yet_valid", "expired"]) if (!v.includes(n)) return `missing '${n}'`;
    return /"none"|HS256/.test(v) ? "must not mention weaker algs as accepted" : null;
  }],
  ["config: needs the global flag, a known module and https issuer; topology check covers issuer AND webhook secret", (f) => {
    const c = stripComments(f[`${API}/lib/clerk-config.ts`]);
    return c.includes("isClerkFeatureEnabled(env)") && /https:/.test(c) && /duplicate|Duplicate|shared/.test(f[`${API}/lib/clerk-config.ts`]) && c.includes("WEBHOOK_SECRET") ? null : "config guard changed";
  }],
  ["svix: constant-time compare, timestamp tolerance, HMAC-SHA256 over id.timestamp.body", (f) => {
    const s = stripComments(f[`${API}/lib/svix-verify.ts`]);
    return ["timingSafeEqual", 'createHmac("sha256"', "`${id}.${timestamp}.${input.body}`"].every((n) => s.includes(n)) && /toleranceSeconds/.test(s) ? null : "svix verification changed";
  }],
  ["webhook: per-module secret, raw body, signature before parsing, 404 when module unconfigured", (f) => {
    const w = f[`${API}/routes/clerk-webhook.ts`];
    const e = order(w, ["readClerkConfig(module)", "verifySvixSignature(", "JSON.parse(raw)", "clerkUserCreated(", "clerkUserDeleted("]);
    return e || (w.includes("cfg.webhookSecret") && w.includes("Buffer.isBuffer(req.body)") ? null : "webhook must verify the raw Buffer with cfg.webhookSecret");
  }],
  ["app.ts: raw-body carve-out for the clerk webhook comes before the JSON parser; router is mounted", (f) => {
    const a = f[`${API}/app.ts`];
    const e = order(a, ["app.use(CLERK_WEBHOOK_PREFIX, express.raw(", "hasRawBody(req.originalUrl) ? next() : express.json("]);
    return e || (f[`${API}/routes/index.ts`].includes("router.use(clerkWebhookRouter)") ? null : "clerk webhook router not mounted");
  }],
  ["service: never links by email, every identity lookup is module-scoped, deletion closes + revokes", (f) => {
    const s = stripComments(f[`${API}/lib/module-clerk-service.ts`]);
    if (!s.includes('code: "EMAIL_ACCOUNT_EXISTS"')) return "EMAIL_ACCOUNT_EXISTS refusal missing";
    if (/INSERT INTO module_credentials|UPDATE module_credentials|method\) VALUES \(\$1, \$2, \$3, '(oidc|link)/.test(s)) return "must not create credentials or non-backing links";
    const sql = [...s.matchAll(/FROM module_external_identities[^`]*`/g)].map((m) => m[0]).concat([...s.matchAll(/DELETE FROM module_external_identities[^`]*`/g)].map((m) => m[0]));
    if (sql.length < 2 || sql.some((x) => !/module = \$1/.test(x) || !/external_id = \$2/.test(x))) return "identity lookups must filter on module and external_id";
    return /status = 'closed'/.test(s) && /UPDATE user_sessions SET revoked_at/.test(s) ? null : "user.deleted must close the account and revoke sessions";
  }],
  ["registry: every module has its own distinct clerkApp; endpoint rows exist", (f) => {
    const r = f["packages/module-registry/src/index.mjs"];
    const apps = [...r.matchAll(/clerkApp: "([a-z]+)"/g)].map((m) => m[1]);
    if (apps.length !== 8 || new Set(apps).size !== 8 || MODS.some((m) => !apps.includes(m))) return `clerkApp must be 8 distinct module keys, got [${apps}]`;
    const e = f["packages/endpoint-registry/src/index.mjs"];
    return e.includes('"/api/auth/module/clerk"') && e.includes('"/api/webhooks/clerk/:module"') ? null : "endpoint-registry rows missing";
  }],
  ["SPA: no @clerk npm dependency, publishable keys only, Clerk script host comes from the module's own key", (f) => {
    const spa = [f[`${SPA}/lib/module-clerk.ts`], f[`${SPA}/pages/clerk-callback.tsx`], f[`${SPA}/components/module-auth-screen.tsx`]].map(stripComments).join("\n");
    if (/from "@clerk\//.test(spa) || /"@clerk\//.test(f["artifacts/ayzen/package.json"])) return "SPA must not import @clerk/* (script is loaded from the module's Frontend API host)";
    if (/sk_(test|live)_/.test(f[`${SPA}/lib/module-clerk.ts`].replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "")) && !/\^pk_/.test(f[`${SPA}/lib/module-clerk.ts`])) return "secret key pattern in browser code";
    return f[`${SPA}/lib/module-clerk.ts`].includes("/^pk_(test|live)_[A-Za-z0-9+/=_-]{8,}$/.test(v)") && f[`${SPA}/lib/module-clerk.ts`].includes("frontendApiHost(publishableKey)") ? null : "publishable key guard / host derivation missing";
  }],
  ["SPA: callback route registered and exempt from app scoping; session token goes only to the module exchange; Clerk signed out after", (f) => {
    if (!/path="\/clerk\/callback"\s+component=\{ClerkCallback\}/.test(f[`${SPA}/App.tsx`]) || !f[`${SPA}/lib/subdomain-app.ts`].includes('"/clerk/callback"')) return "callback route/exemption missing";
    const c = f[`${SPA}/pages/clerk-callback.tsx`];
    const e = order(c, ["finishSocialLogin(", "exchangeModuleClerkSession(token)", "await signOut()", "setAuthContext("]);
    return e || (/(sessionStorage|localStorage)\.setItem/.test(c) ? "callback must not persist tokens" : null);
  }],
  ["SPA: return path is sanitized and password login sends the `email` field the server reads", (f) => {
    const m = f[`${SPA}/lib/module-clerk.ts`], a = f[`${SPA}/lib/module-auth-api.ts`];
    return m.includes("safePath(returnToPath)") && m.includes("safePath(v ?? \"/\")") && (a.match(/\{ email: identifier, password \}/g) ?? []).length === 2 ? null : "return-path guard or login body field changed";
  }],
  ["docs + env: identity boundaries cover the hard rules; .env.example holds placeholders only", (f) => {
    const d = f["docs/identity-boundaries.md"];
    for (const n of ["Pools are separate", "Verification is per module", "No automatic linking by email", "module_external_identities", "Only AYZEN OIDC is shared"]) if (!d.includes(n)) return `docs miss '${n}'`;
    const env = f[".env.example"];
    return MODS.length && /CLERK_SYLO_WEBHOOK_SECRET=whsec_\.\.\./.test(env) && !/whsec_[A-Za-z0-9+/]{16,}|sk_(live|test)_[A-Za-z0-9]{10,}/.test(env) ? null : ".env.example must use placeholders only";
  }],
  ["CI + package run this validator and the Clerk tests", (f) => {
    const c = f[".github/workflows/ci.yml"], p = f["package.json"];
    return (c.match(/validate-w1-p5\.mjs/g) ?? []).length >= 2 && c.includes("validate-w1-p5.mjs --self-test") && c.includes("test:clerk") && c.includes("clerk:test-module-client") && p.includes("validate:w1-p5") ? null : "ci.yml/package.json wiring missing";
  }],
];

function run(files) { return RULES.flatMap(([id, fn]) => { let p; try { p = fn(files); } catch (e) { p = `threw: ${e.message}`; } return p ? [`${id}: ${p}`] : []; }); }

if (process.argv.includes("--self-test")) {
  const base = load();
  const clean = run(base);
  if (clean.length) { console.error("self-test needs a clean tree first:\n - " + clean.join("\n - ")); process.exit(1); }
  const R = `${API}/routes/module-auth.ts`, S = `${API}/lib/module-clerk-service.ts`, V = `${API}/lib/clerk-verify.ts`, W = `${API}/routes/clerk-webhook.ts`;
  const mutants = [
    ["route skips config (no 404 when off)", R, "if (!cfg) {", "if (false) {"],
    ["route takes user id from body", R, "clerkUserId: v.claims.sub", "clerkUserId: (req.body as any).sub"],
    ["route trusts body email verification", R, "emailVerified: v.claims.emailVerified", "emailVerified: true"],
    ["route verifies after sign-in", R, "const v = await verifyClerkSessionToken(sessionToken, cfg);", "const v: any = { ok: true, claims: { sub: sessionToken } };"],
    ["EMAIL_ACCOUNT_EXISTS loses its status", R, "EMAIL_ACCOUNT_EXISTS: 409,", ""],
    ["options stop advertising social", R, "social: readClerkConfig(module) !== null", "social: true"],
    ["verify accepts any alg", V, 'header.alg !== "RS256"', "false"],
    ["verify ignores issuer", V, "claims.iss !== cfg.issuer", "false"],
    ["verify uses one global JWKS cache key", V, "cache.get(cfg.jwksUrl)", 'cache.get("shared")'],
    ["verify ignores azp", V, "cfg.authorizedParties", "[]"],
    ["service auto-links by email (drops refusal)", S, 'code: "EMAIL_ACCOUNT_EXISTS"', 'code: "INVALID_TOKEN"'],
    ["service identity lookup loses module filter", S, "WHERE i.module = $1 AND i.provider = 'clerk' AND i.external_id = $2", "WHERE i.provider = 'clerk' AND i.external_id = $2"],
    ["service deletion no longer revokes", S, "UPDATE user_sessions SET revoked_at", "UPDATE user_sessions SET last_seen_at"],
    ["webhook verifies after parsing", W, "const v = verifySvixSignature({", "const v: any = { ok: true }; void ({"],
    ["webhook uses a shared secret", W, "secret: cfg.webhookSecret", 'secret: process.env.CLERK_WEBHOOK_SECRET ?? ""'],
    ["webhook not mounted", `${API}/routes/index.ts`, "router.use(clerkWebhookRouter);", ""],
    ["raw-body carve-out removed", `${API}/app.ts`, "app.use(CLERK_WEBHOOK_PREFIX, express.raw(", "app.use(CLERK_WEBHOOK_PREFIX + '/x', express.raw("],
    ["migration loses composite FK", "migrations/128_module_external_identities.sql", "FOREIGN KEY (module_account_id, module) REFERENCES module_accounts(id, module)", "FOREIGN KEY (module_account_id) REFERENCES module_accounts(id)"],
    ["migration loses module in unique index", "migrations/128_module_external_identities.sql", "ON module_external_identities(module, provider, external_id)", "ON module_external_identities(provider, external_id)"],
    ["two modules share a clerk app", "packages/module-registry/src/index.mjs", 'clerkApp: "ryft"', 'clerkApp: "sylo"'],
    ["endpoint row removed", "packages/endpoint-registry/src/index.mjs", '"/api/webhooks/clerk/:module"', '"/api/webhooks/clerk-x/:module"'],
    ["SPA imports @clerk", `${SPA}/lib/module-clerk.ts`, "export const SOCIAL_PROVIDERS", 'import { Clerk } from "@clerk/clerk-js";\nexport const SOCIAL_PROVIDERS'],
    ["SPA accepts any key", `${SPA}/lib/module-clerk.ts`, "/^pk_(test|live)_[A-Za-z0-9+/=_-]{8,}$/.test(v)", "/^(pk|sk)_(test|live)_[A-Za-z0-9+/=_-]{8,}$/.test(v)"],
    ["callback route unregistered", `${SPA}/App.tsx`, 'path="/clerk/callback"  component={ClerkCallback}', 'path="/clerk/callback-x"  component={ClerkCallback}'],
    ["callback keeps the Clerk session", `${SPA}/pages/clerk-callback.tsx`, "await signOut();", ""],
    ["callback stores token", `${SPA}/pages/clerk-callback.tsx`, "const r = await exchangeModuleClerkSession(token);", "const r = await exchangeModuleClerkSession(token); window.sessionStorage.setItem('t', token);"],
    ["return path unsanitized", `${SPA}/lib/module-clerk.ts`, "safePath(returnToPath)", "returnToPath"],
    ["login body field reverted", `${SPA}/lib/module-auth-api.ts`, '{ email: identifier, password }', '{ identifier, password }'],
    ["docs drop the no-auto-link rule", "docs/identity-boundaries.md", "No automatic linking by email", "Linking"],
    [".env.example holds a real-looking secret", ".env.example", "CLERK_SYLO_WEBHOOK_SECRET=whsec_...", "CLERK_SYLO_WEBHOOK_SECRET=whsec_AbCdEfGhIjKlMnOpQrStUvWx"],
    ["CI forgets the validator", ".github/workflows/ci.yml", "validate-w1-p5.mjs --self-test", "validate-w1-px.mjs --self-test"],
  ];
  let survived = 0;
  for (const [name, file, from, to] of mutants) {
    if (!base[file].includes(from)) { console.error(`MUTANT NOT APPLICABLE (fix the self-test): ${name}`); survived++; continue; }
    if (run({ ...base, [file]: base[file].replace(from, to) }).length === 0) { console.error(`SURVIVED: ${name}`); survived++; }
  }
  console.log(survived ? `SELF-TEST FAILED: ${survived} mutant(s) not caught` : `SELF-TEST OK: ${mutants.length}/${mutants.length} mutants caught`);
  process.exit(survived ? 1 : 0);
}

const problems = run(load());
if (problems.length) { console.error("W1_P5_VALIDATION: FAIL\n - " + problems.join("\n - ")); process.exit(1); }
console.log("W1_P5_VALIDATION: PASS");
console.log(JSON.stringify({ rules: RULES.length, modules: MODS.length }));
