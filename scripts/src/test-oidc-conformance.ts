/**
 * scripts/src/test-oidc-conformance.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * W1-P3 (roadmap req 6): OIDC provider routing conformance — the discovery document against the routes the
 * server really serves.
 *
 * Install-free by design: it imports only pure modules (lib/oidc-discovery, lib/oidc-scope-validation,
 * lib/role-hosts, the gateway's routing.mjs, the module registry, the seed data) and READS app.ts / the
 * route files / role-host middleware / the endpoint registry as text. No express, no database, no network —
 * so it runs in CI before anything is built and here. What it deliberately does NOT do is boot the server
 * and curl it; the manual smoke test in CHANGES_W1_P3_OIDC_ROUTING.md covers that.
 *
 * Contract (each numbered block below):
 *   1. every endpoint the discovery document advertises is a real `router.<method>(path)` in routes/*.ts with the
 *      advertised HTTP method, and that router is imported and mounted bare (`app.use(router)`) in app.ts;
 *   2. every public `/oidc/*` and `/.well-known/*` route in routes/ is mounted (no orphan router file);
 *   3. all of them are mounted BEFORE `app.use("/api", ... roleHostApiGate ...)` and `app.use(roleHostPageGate)`,
 *      and the page gate skips `/oidc` and `/.well-known`, so a role/module host can never intercept an OIDC call;
 *   4. the gateway route table sends `/oidc/*` and `/.well-known/*` (and nothing it should not) to the identity service;
 *   5. the discovery capability lists agree with enforcement (scopes, PKCE, grants, client auth);
 *   6. the issuer resolves to a valid origin, every advertised URL lives on it, and an api./id. issuer works unchanged;
 *   7. seeded first-party clients match the module registry 1:1 (host, client id, per-module scopes, PKCE-only), and the
 *      seed script inserts them as 'approved' without ever overwriting an admin's later status.
 *
 * Run: npx tsx scripts/src/test-oidc-conformance.ts   (also part of `pnpm oidc:test-suite`)
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildOidcDiscoveryMetadata, issuerProblem, resolveIssuer } from "../../artifacts/api-server/src/lib/oidc-discovery";
import { ROLE_HOST_EXEMPT_PREFIXES } from "../../artifacts/api-server/src/lib/role-hosts";
import { routeFor } from "../../apps/api-gateway/src/routing.mjs";
import { MODULES } from "../../packages/module-registry/src/index.mjs";
import { BASE_FIRST_PARTY_SCOPES, MODULE_CLIENT_SCOPES, SEED_CLIENTS } from "./oidc-seed-clients-data";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
const API = "artifacts/api-server/src";

// ── source facts ────────────────────────────────────────────────────────────────────────────────────────────────────
// One left-to-right pass: string literals are kept verbatim, so a `/*` inside a `//` comment (e.g. "`/oidc/*` routers")
// or "https://" inside a string cannot be mistaken for a comment start. Template literals are kept whole.
const stripComments = (src: string): string =>
  src.replace(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => (m[0] === "/" ? " " : m));

const appSrc = stripComments(read(`${API}/app.ts`));

/** routes/<file>.ts -> default-import identifier used in app.ts */
const importedAs = new Map<string, string>();
for (const m of appSrc.matchAll(/import\s+(\w+)\s+from\s+"\.\/routes\/([\w-]+)"/g)) importedAs.set(m[2], m[1]);

/** statement offsets of each bare `app.use(<ident>)` mount, by identifier */
const mountOffset = new Map<string, number>();
for (const m of appSrc.matchAll(/app\.use\((\w+)\)/g)) if (!mountOffset.has(m[1])) mountOffset.set(m[1], m.index ?? -1);

interface RouteDef { file: string; method: string; path: string }
const routeDefs: RouteDef[] = [];
for (const f of readdirSync(join(ROOT, API, "routes")).filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts"))) {
  const src = stripComments(read(`${API}/routes/${f}`));
  for (const m of src.matchAll(/router\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g)) {
    routeDefs.push({ file: f.replace(/\.ts$/, ""), method: m[1].toUpperCase(), path: m[2] });
  }
  // multi-line router.post(\n  "/path", ...)
  for (const m of src.matchAll(/router\.(get|post|put|patch|delete)\(\s*\n\s*"([^"]+)"/g)) {
    if (!routeDefs.some((r) => r.file === f.replace(/\.ts$/, "") && r.method === m[1].toUpperCase() && r.path === m[2])) {
      routeDefs.push({ file: f.replace(/\.ts$/, ""), method: m[1].toUpperCase(), path: m[2] });
    }
  }
}
const isOidcPath = (p: string): boolean => p.startsWith("/oidc/") || p.startsWith("/.well-known/");
const oidcRoutes = routeDefs.filter((r) => isOidcPath(r.path));

// lib/oidc-scope-validation.ts pulls in the pino logger, so (to stay install-free) its scope list is read from source.
const KNOWN_OIDC_SCOPES: readonly string[] = (() => {
  const m = read(`${API}/lib/oidc-scope-validation.ts`).match(/export const KNOWN_OIDC_SCOPES = \[([^\]]*)\]/);
  assert.ok(m, "KNOWN_OIDC_SCOPES not found in lib/oidc-scope-validation.ts");
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
})();

const ISSUER = "https://issuer.test";
const meta = buildOidcDiscoveryMetadata(ISSUER);

/** What each advertised URL must be served as. Adding a discovery field without a row here fails block 1. */
const ADVERTISED: Record<string, { method: string }> = {
  jwks_uri: { method: "GET" },
  authorization_endpoint: { method: "GET" },
  token_endpoint: { method: "POST" },
  userinfo_endpoint: { method: "GET" },
  end_session_endpoint: { method: "GET" },
  introspection_endpoint: { method: "POST" },
  revocation_endpoint: { method: "POST" },
  registration_endpoint: { method: "POST" },
};

// ── 1. advertised endpoint -> real, mounted route ───────────────────────────────────────────────────────────────────
test("1. every URL-valued discovery field is covered by the contract table (no silently unchecked endpoint)", () => {
  const urlFields = Object.entries(meta).filter(([, v]) => typeof v === "string" && /^https?:\/\//.test(v as string)).map(([k]) => k);
  const unchecked = urlFields.filter((k) => k !== "issuer" && !(k in ADVERTISED));
  assert.deepEqual(unchecked, [], `discovery advertises ${unchecked.join(", ")} but the conformance table has no row for it`);
});

for (const [field, { method }] of Object.entries(ADVERTISED)) {
  test(`1. ${field} resolves: ${method} route exists and its router is mounted bare in app.ts`, () => {
    const url = (meta as unknown as Record<string, string>)[field];
    assert.ok(url, `${field} missing from the discovery document`);
    assert.ok(url.startsWith(ISSUER + "/"), `${field} is not on the issuer origin: ${url}`);
    const path = url.slice(ISSUER.length);
    const def = routeDefs.find((r) => r.path === path && r.method === method);
    assert.ok(def, `${field} -> ${method} ${path}: no router.${method.toLowerCase()}("${path}") in routes/`);
    const ident = importedAs.get(def.file);
    assert.ok(ident, `routes/${def.file}.ts serves ${path} but app.ts never imports it`);
    assert.ok(mountOffset.has(ident), `routes/${def.file}.ts is imported as ${ident} but never mounted with app.use(${ident})`);
  });
}

// ── 2. no orphan public OIDC route ──────────────────────────────────────────────────────────────────────────────────
test("2. every /oidc/* and /.well-known/* route in routes/ belongs to a router that app.ts mounts", () => {
  assert.ok(oidcRoutes.length >= 20, `route scan found only ${oidcRoutes.length} OIDC routes — the scanner regex is broken`);
  const orphans = oidcRoutes.filter((r) => { const id = importedAs.get(r.file); return !id || !mountOffset.has(id); });
  assert.deepEqual(orphans.map((r) => `${r.method} ${r.path} (routes/${r.file}.ts)`), []);
});

test("2. the three routers the audit could not verify — register, introspect, revoke — are mounted", () => {
  for (const [file, path] of [["oidc-register", "/oidc/register"], ["oidc-introspect", "/oidc/introspect"], ["oidc-revoke", "/oidc/revoke"]] as const) {
    assert.ok(routeDefs.some((r) => r.file === file && r.path === path), `${file} no longer defines ${path}`);
    const id = importedAs.get(file);
    assert.ok(id && mountOffset.has(id), `${file} is not mounted in app.ts`);
  }
});

// ── 3. ordering vs host gates ───────────────────────────────────────────────────────────────────────────────────────
test("3. every OIDC router is mounted before the /api stack and the role-host page gate", () => {
  const apiMount = appSrc.indexOf('app.use("/api"');
  const pageGate = appSrc.search(/app\.use\(roleHostPageGate\)/);
  assert.ok(apiMount > 0, 'app.use("/api", ...) not found');
  assert.ok(pageGate > 0, "app.use(roleHostPageGate) not found");
  const late = [...new Set(oidcRoutes.map((r) => r.file))].filter((file) => {
    const id = importedAs.get(file);
    const at = id ? mountOffset.get(id) : undefined;
    return at === undefined || at > Math.min(apiMount, pageGate);
  });
  assert.deepEqual(late, [], "these OIDC routers are mounted after a host/role gate and could be intercepted by it");
});

test("3. role-host page gate skips /oidc and /.well-known, and /oidc/callback is an exempt SPA page", () => {
  const mw = stripComments(read(`${API}/middlewares/role-host.ts`));
  assert.match(mw, /req\.path\.startsWith\("\/oidc"\)/);
  assert.match(mw, /req\.path\.startsWith\("\/\.well-known"\)/);
  assert.ok(ROLE_HOST_EXEMPT_PREFIXES.includes("/oidc/callback"));
});

test("3. the API-host MCP shim cannot shadow discovery: well-known + oidc mounts precede it", () => {
  const mcp = appSrc.indexOf("isApiHost(req.hostname)");
  assert.ok(mcp > 0, "API-host MCP middleware not found");
  assert.ok(appSrc.indexOf("app.use(wellKnownOpenidConfigurationRouter)") < mcp);
  assert.ok(appSrc.indexOf("app.use(oidcRevokeRouter)") < mcp);
});

// ── 4. gateway ──────────────────────────────────────────────────────────────────────────────────────────────────────
const registrySrc = read("packages/endpoint-registry/src/index.mjs");
const serviceRoutes: Array<[string, string, string]> = [...registrySrc.matchAll(/\["(\/[^"]*)", "([A-Z_]+_URL)", "([a-z-]+)"\]/g)].map((m) => [m[1], m[2], m[3]]);

test("4. gateway SERVICE_ROUTE_TABLE sends every OIDC and well-known path to the identity service", () => {
  assert.ok(serviceRoutes.length > 5, "could not parse SERVICE_ROUTE_TABLE from the endpoint registry");
  for (const r of oidcRoutes) {
    const concrete = r.path.replace(/:[A-Za-z_]+/g, "x");
    const hit = routeFor(concrete, serviceRoutes);
    assert.ok(hit, `gateway has no route for ${concrete}`);
    assert.equal(hit[2], "identity", `${concrete} routes to '${hit[2]}', expected identity`);
    assert.equal(hit[1], "IDENTITY_SERVICE_URL");
  }
});

test("4. gateway prefix match is on a path boundary: /oidcx and /.well-knownx are not captured", () => {
  assert.equal(routeFor("/oidcx/token", serviceRoutes), undefined);
  assert.equal(routeFor("/.well-knownx", serviceRoutes), undefined);
  assert.equal(routeFor("/oidc", serviceRoutes)?.[2], "identity");
});

// ── 5. capability lists vs enforcement ──────────────────────────────────────────────────────────────────────────────
test("5. scopes_supported equals the scope validator's KNOWN_OIDC_SCOPES", () => {
  assert.deepEqual([...meta.scopes_supported].sort(), [...KNOWN_OIDC_SCOPES].sort());
});

test("5. PKCE: only S256 advertised, and the authorize request validator rejects a missing challenge", () => {
  assert.deepEqual(meta.code_challenge_methods_supported, ["S256"]);
  const authz = stripComments(read(`${API}/lib/oidc-authorize-request.ts`));
  assert.match(authz, /missing_code_challenge/);
  assert.match(authz, /unsupported_code_challenge_method/);
  const pkce = stripComments(read(`${API}/lib/oidc-pkce.ts`));
  assert.match(pkce, /codeChallengeMethod !== "S256"/);
});

test("5. grants: token endpoint accepts exactly the advertised grant types", () => {
  const tok = stripComments(read(`${API}/routes/oidc-token.ts`));
  const m = tok.match(/const SUPPORTED_GRANT_TYPE = "([a-z_]+)"/);
  assert.ok(m, "SUPPORTED_GRANT_TYPE not found in routes/oidc-token.ts");
  assert.deepEqual(meta.grant_types_supported, [m[1]], "discovery grant_types_supported drifted from the token route");
});

test("5. response_types / subject types / signing alg match what the provider issues", () => {
  assert.deepEqual(meta.response_types_supported, ["code"]);
  assert.deepEqual(meta.id_token_signing_alg_values_supported, ["RS256"]);
  assert.deepEqual(meta.subject_types_supported, ["public"]);
});

// ── 6. issuer ───────────────────────────────────────────────────────────────────────────────────────────────────────
const ENV_KEYS = ["AYZEN_OIDC_ISSUER", "APP_URL"] as const;
function withEnv<T>(env: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>, fn: () => T): T {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  try { return fn(); } finally { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

test("6. the default issuer (no env) is a valid origin", () => {
  const iss = withEnv({}, resolveIssuer);
  assert.equal(issuerProblem(iss), null, iss);
});

test("6. whichever host is chosen — central, api. or id. — every advertised URL is on it and well-formed", () => {
  for (const host of ["https://ayzen.tech", "https://api.ayzen.tech", "https://id.ayzen.tech"]) {
    const iss = withEnv({ AYZEN_OIDC_ISSUER: host + "/" }, resolveIssuer);
    assert.equal(iss, host);
    const m = buildOidcDiscoveryMetadata(iss);
    assert.equal(m.issuer, host);
    for (const field of Object.keys(ADVERTISED)) {
      const u = (m as unknown as Record<string, string>)[field];
      assert.ok(u.startsWith(host + "/") && !u.slice(host.length).startsWith("//"), `${field}=${u}`);
    }
  }
});

test("6. the issuer is never a module host or a role host (relying parties must not see a per-module issuer)", () => {
  const moduleHosts = MODULES.map((m) => m.defaultHost);
  for (const bad of moduleHosts) assert.notEqual(new URL(withEnv({ AYZEN_OIDC_ISSUER: undefined, APP_URL: undefined }, resolveIssuer)).host, bad);
});

// ── 7. seed vs registry ─────────────────────────────────────────────────────────────────────────────────────────────
test("7. every registry module has exactly one seeded client, keyed by its oidcClientId", () => {
  for (const m of MODULES) {
    const matches = SEED_CLIENTS.filter((c) => c.clientId === m.oidcClientId);
    assert.equal(matches.length, 1, `module ${m.id}: expected one seed client '${m.oidcClientId}', found ${matches.length}`);
  }
  const extra = SEED_CLIENTS.map((c) => c.clientId).filter((id) => !MODULES.some((m) => m.oidcClientId === id) && id !== "workspace");
  assert.deepEqual(extra, [], "seed has clients that are not modules (and not 'workspace')");
});

test("7. each module client's redirect, post-logout and back-channel URLs are on that module's own host, https", () => {
  for (const m of MODULES) {
    const c = SEED_CLIENTS.find((x) => x.clientId === m.oidcClientId)!;
    assert.deepEqual(c.redirectUris, [`https://${m.defaultHost}/oidc/callback`], m.id);
    assert.deepEqual(c.postLogoutRedirectUris, [`https://${m.defaultHost}/`], m.id);
    assert.equal(c.backchannelLogoutUri, `https://${m.defaultHost}/oidc/backchannel-logout`, m.id);
  }
});

test("7. no module client can redirect to another module's host (cross-module redirect_uri isolation)", () => {
  for (const c of SEED_CLIENTS.filter((x) => x.clientId !== "workspace")) {
    const own = MODULES.find((m) => m.oidcClientId === c.clientId)!.defaultHost;
    for (const u of [...c.redirectUris, ...c.postLogoutRedirectUris, c.backchannelLogoutUri ?? ""].filter(Boolean)) {
      assert.equal(new URL(u).host, own, `${c.clientId} registers ${u}`);
    }
  }
});

test("7. all clients are PKCE-only public clients; scopes are per-module, known, and include openid", () => {
  for (const c of SEED_CLIENTS) {
    assert.equal(c.clientSecretHash, null, `${c.clientId} must be public/PKCE-only`);
    assert.ok(c.allowedScopes.includes("openid"), c.clientId);
    for (const s of c.allowedScopes) assert.ok(KNOWN_OIDC_SCOPES.includes(s), `${c.clientId} scope '${s}' unknown to the scope validator`);
  }
  for (const m of MODULES) {
    assert.ok(m.id in MODULE_CLIENT_SCOPES, `MODULE_CLIENT_SCOPES has no entry for ${m.id}`);
    assert.deepEqual(SEED_CLIENTS.find((c) => c.clientId === m.oidcClientId)!.allowedScopes, [...MODULE_CLIENT_SCOPES[m.id]]);
  }
  assert.deepEqual([...BASE_FIRST_PARTY_SCOPES], ["openid", "profile", "email"]);
});

test("7. seed SQL inserts 'approved', repairs only 'pending' on conflict, and never un-suspends or touches a secret", () => {
  const raw = read("scripts/src/seed-oidc-clients.ts");
  const sql = stripComments(raw);
  const insert = sql.match(/INSERT INTO oidc_clients \(([^)]*)\)\s*VALUES \(([^)]*)\)/);
  assert.ok(insert, "seed INSERT not found");
  assert.match(insert[1], /registration_status/);
  assert.match(insert[2], /'approved'/);
  const start = raw.indexOf("ON CONFLICT (client_id) DO UPDATE SET"); // the SQL, not the prose in the file header
  assert.ok(start > 0, "seed ON CONFLICT clause not found");
  const onConflict = raw.slice(start, raw.indexOf("`,", start));
  const assign = onConflict.match(/registration_status\s*=\s*([^\n]*)/);
  assert.ok(assign, "ON CONFLICT should repair a 'pending' first-party client");
  assert.match(assign[1], /CASE WHEN oidc_clients\.registration_status = 'pending' THEN 'approved' ELSE oidc_clients\.registration_status END/,
    "the conflict update must only ever turn 'pending' into 'approved' — never overwrite 'suspended'");
  assert.doesNotMatch(onConflict.replace(assign[0], ""), /registration_status/);
  assert.doesNotMatch(onConflict, /client_secret_hash/, "re-seeding must not touch a secret");
});
