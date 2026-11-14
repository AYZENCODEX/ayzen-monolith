/**
 * scripts/src/test-oidc-discovery-metadata.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 1, Phase 1E-d: unit tests for
 * buildOidcDiscoveryMetadata()/resolveIssuer() in
 * artifacts/api-server/src/lib/oidc-discovery.ts.
 *
 * Pure, DB-free, env-free (resolveIssuer() is exercised separately from
 * buildOidcDiscoveryMetadata(), which takes issuer as a plain parameter) —
 * same discipline as 1E-a/1E-b's tests.
 *
 * Run: npx tsx scripts/src/test-oidc-discovery-metadata.ts
 */
import assert from "node:assert/strict";
import { buildOidcDiscoveryMetadata, issuerProblem, resolveIssuer } from "../../artifacts/api-server/src/lib/oidc-discovery";
import { test } from "node:test";

console.log("buildOidcDiscoveryMetadata()");

test("issuer is carried through as given (already clean)", () => {
  const meta = buildOidcDiscoveryMetadata("https://account.ayzen.tech");
  assert.equal(meta.issuer, "https://account.ayzen.tech");
});

test("trailing slash(es) on issuer are stripped", () => {
  const meta = buildOidcDiscoveryMetadata("https://account.ayzen.tech/");
  assert.equal(meta.issuer, "https://account.ayzen.tech");
  const meta2 = buildOidcDiscoveryMetadata("https://account.ayzen.tech///");
  assert.equal(meta2.issuer, "https://account.ayzen.tech");
});

test("jwks_uri is derived from issuer, not independently settable", () => {
  const meta = buildOidcDiscoveryMetadata("https://account.ayzen.tech");
  assert.equal(meta.jwks_uri, "https://account.ayzen.tech/.well-known/jwks.json");
});

test("jwks_uri stays correctly joined even when issuer had a trailing slash", () => {
  const meta = buildOidcDiscoveryMetadata("https://account.ayzen.tech/");
  assert.equal(meta.jwks_uri, "https://account.ayzen.tech/.well-known/jwks.json");
  assert.ok(!meta.jwks_uri.includes("//.well-known")); // no doubled slash
});

test("issuer and jwks_uri always share the same origin, for any issuer input", () => {
  for (const issuer of ["https://ayzen.tech", "http://localhost:8080", "https://staging.ayzen.tech/"]) {
    const meta = buildOidcDiscoveryMetadata(issuer);
    assert.ok(meta.jwks_uri.startsWith(meta.issuer + "/"));
  }
});

test("response_types_supported is exactly [\"code\"] — no implicit/hybrid", () => {
  const meta = buildOidcDiscoveryMetadata("https://ayzen.tech");
  assert.deepEqual(meta.response_types_supported, ["code"]);
});

test("scopes_supported is exactly openid+profile+email (W1-P3: matches KNOWN_OIDC_SCOPES and every seeded client)", () => {
  const meta = buildOidcDiscoveryMetadata("https://ayzen.tech");
  assert.deepEqual(meta.scopes_supported, ["openid", "profile", "email"]);
});

test("id_token_signing_alg_values_supported is exactly [\"RS256\"] — HS256 never advertised", () => {
  const meta = buildOidcDiscoveryMetadata("https://ayzen.tech");
  assert.deepEqual(meta.id_token_signing_alg_values_supported, ["RS256"]);
  assert.equal(meta.id_token_signing_alg_values_supported.includes("HS256" as any), false);
});

test("registration_endpoint is derived from issuer (W1-P3: routes/oidc-register.ts has been mounted since Phase 8a)", () => {
  assert.equal(buildOidcDiscoveryMetadata("https://ayzen.tech").registration_endpoint, "https://ayzen.tech/oidc/register");
  assert.equal(buildOidcDiscoveryMetadata("https://ayzen.tech///").registration_endpoint, "https://ayzen.tech/oidc/register");
});

test("W1-P3 capability lists tell the truth: S256 only, authorization_code only, public subjects, query responses", () => {
  const m = buildOidcDiscoveryMetadata("https://ayzen.tech");
  assert.deepEqual(m.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(m.grant_types_supported, ["authorization_code"]);
  assert.deepEqual(m.token_endpoint_auth_methods_supported, ["none", "client_secret_post"]);
  assert.deepEqual(m.subject_types_supported, ["public"]);
  assert.deepEqual(m.response_modes_supported, ["query"]);
  assert.equal(m.backchannel_logout_supported, true);
  assert.equal(m.backchannel_logout_session_supported, false);
  assert.ok(m.claims_supported.includes("module_uid") && m.claims_supported.includes("sub"));
  assert.equal(m.code_challenge_methods_supported.includes("plain"), false, "plain PKCE must never be advertised");
});

test("introspection_endpoint is derived from issuer (Phase 10e)", () => {
  const meta = buildOidcDiscoveryMetadata("https://account.ayzen.tech");
  assert.equal(meta.introspection_endpoint, "https://account.ayzen.tech/oidc/introspect");
});

test("revocation_endpoint is derived from issuer (Phase 10e)", () => {
  const meta = buildOidcDiscoveryMetadata("https://account.ayzen.tech");
  assert.equal(meta.revocation_endpoint, "https://account.ayzen.tech/oidc/revoke");
});

test("introspection_endpoint and revocation_endpoint stay correctly joined even when issuer had a trailing slash", () => {
  const meta = buildOidcDiscoveryMetadata("https://account.ayzen.tech/");
  assert.equal(meta.introspection_endpoint, "https://account.ayzen.tech/oidc/introspect");
  assert.equal(meta.revocation_endpoint, "https://account.ayzen.tech/oidc/revoke");
  assert.ok(!meta.introspection_endpoint.includes("//oidc"));
  assert.ok(!meta.revocation_endpoint.includes("//oidc"));
});

test("issuer, introspection_endpoint, and revocation_endpoint always share the same origin, for any issuer input", () => {
  for (const issuer of ["https://ayzen.tech", "http://localhost:8080", "https://staging.ayzen.tech/"]) {
    const meta = buildOidcDiscoveryMetadata(issuer);
    assert.ok(meta.introspection_endpoint.startsWith(meta.issuer + "/"));
    assert.ok(meta.revocation_endpoint.startsWith(meta.issuer + "/"));
  }
});

test("returned arrays are fresh copies, not shared mutable state across calls", () => {
  const a = buildOidcDiscoveryMetadata("https://ayzen.tech");
  const b = buildOidcDiscoveryMetadata("https://ayzen.tech");
  a.scopes_supported.push("mutated");
  assert.deepEqual(b.scopes_supported, ["openid", "profile", "email"]); // b unaffected by a's mutation
  a.grant_types_supported.push("implicit");
  assert.deepEqual(b.grant_types_supported, ["authorization_code"]);
});

console.log("resolveIssuer()");

test("AYZEN_OIDC_ISSUER, when set, wins over APP_URL", () => {
  const prevIssuer = process.env.AYZEN_OIDC_ISSUER;
  const prevAppUrl = process.env.APP_URL;
  process.env.AYZEN_OIDC_ISSUER = "https://explicit-issuer.ayzen.tech/";
  process.env.APP_URL = "https://should-be-ignored.example";
  try {
    assert.equal(resolveIssuer(), "https://explicit-issuer.ayzen.tech");
  } finally {
    if (prevIssuer === undefined) delete process.env.AYZEN_OIDC_ISSUER;
    else process.env.AYZEN_OIDC_ISSUER = prevIssuer;
    if (prevAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = prevAppUrl;
  }
});

test("falls back to APP_URL when AYZEN_OIDC_ISSUER is unset", () => {
  const prevIssuer = process.env.AYZEN_OIDC_ISSUER;
  const prevAppUrl = process.env.APP_URL;
  delete process.env.AYZEN_OIDC_ISSUER;
  process.env.APP_URL = "https://app-url-fallback.example/";
  try {
    assert.equal(resolveIssuer(), "https://app-url-fallback.example");
  } finally {
    if (prevIssuer === undefined) delete process.env.AYZEN_OIDC_ISSUER;
    else process.env.AYZEN_OIDC_ISSUER = prevIssuer;
    if (prevAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = prevAppUrl;
  }
});

test("falls back to the canonical app URL when neither env var is set", () => {
  const prevIssuer = process.env.AYZEN_OIDC_ISSUER;
  const prevAppUrl = process.env.APP_URL;
  delete process.env.AYZEN_OIDC_ISSUER;
  delete process.env.APP_URL;
  try {
    assert.equal(resolveIssuer(), "https://ayzen.tech");
  } finally {
    if (prevIssuer === undefined) delete process.env.AYZEN_OIDC_ISSUER;
    else process.env.AYZEN_OIDC_ISSUER = prevIssuer;
    if (prevAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = prevAppUrl;
  }
});

test("blank/whitespace-only AYZEN_OIDC_ISSUER is treated as unset", () => {
  const prevIssuer = process.env.AYZEN_OIDC_ISSUER;
  const prevAppUrl = process.env.APP_URL;
  process.env.AYZEN_OIDC_ISSUER = "   ";
  process.env.APP_URL = "https://app-url-fallback-2.example";
  try {
    assert.equal(resolveIssuer(), "https://app-url-fallback-2.example");
  } finally {
    if (prevIssuer === undefined) delete process.env.AYZEN_OIDC_ISSUER;
    else process.env.AYZEN_OIDC_ISSUER = prevIssuer;
    if (prevAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = prevAppUrl;
  }
});

console.log("All oidc-discovery.ts tests passed.");

console.log("issuerProblem() (W1-P3)");

test("issuerProblem accepts https origins and http localhost, rejects the rest", () => {
  for (const ok of ["https://ayzen.tech", "https://id.ayzen.tech", "https://api.ayzen.tech", "http://localhost:8080", "https://ayzen.tech/idp"]) {
    assert.equal(issuerProblem(ok), null, ok);
  }
  for (const bad of ["ayzen.tech", "", "http://ayzen.tech", "https://ayzen.tech/?x=1", "https://ayzen.tech/#f", "https://u:p@ayzen.tech", "ftp://ayzen.tech"]) {
    assert.notEqual(issuerProblem(bad), null, bad || "(empty)");
  }
});
