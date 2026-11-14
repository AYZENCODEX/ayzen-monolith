import assert from "node:assert/strict";
import test from "node:test";
import { createHmac, createSign, generateKeyPairSync, type JsonWebKey } from "node:crypto";
import { clerkEnvName, clerkTopologyProblems, isClerkConfigured, normalizeIssuer, readClerkConfig, type ClerkModuleConfig } from "./clerk-config";
import { __resetClerkJwksCacheForTests, verifyClerkSessionToken, type FetchJwks } from "./clerk-verify";
import { verifySvixSignature } from "./svix-verify";

// ─── helpers ─────────────────────────────────────────────────────────────────
const b64u = (o: unknown) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
function makeKey(kid: string) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...(publicKey.export({ format: "jwk" }) as JsonWebKey), kid, use: "sig", alg: "RS256" };
  return { privateKey, jwk };
}
const K1 = makeKey("ins_k1"), K2 = makeKey("ins_k2"), OTHER = makeKey("ins_k1" /* same kid, different module's key */);
const NOW = 1_800_000_000_000;
const sec = Math.floor(NOW / 1000);

const SYLO: ClerkModuleConfig = { module: "sylo", issuer: "https://clerk.sylo.test", jwksUrl: "https://clerk.sylo.test/.well-known/jwks.json", webhookSecret: null, authorizedParties: ["https://sylo.ayzen.tech"] };

function sign(key: typeof K1, claims: Record<string, unknown>, header: Record<string, unknown> = {}): string {
  const h = b64u({ alg: "RS256", typ: "JWT", kid: key.jwk.kid, ...header });
  const p = b64u(claims);
  const sig = createSign("RSA-SHA256").update(`${h}.${p}`).sign(key.privateKey).toString("base64url");
  return `${h}.${p}.${sig}`;
}
const good = (over: Record<string, unknown> = {}) => ({ iss: SYLO.issuer, sub: "user_2abcdEFGH1234", azp: "https://sylo.ayzen.tech", exp: sec + 60, nbf: sec - 5, iat: sec - 5, sid: "sess_1", ...over });
const jwks = (...keys: any[]): FetchJwks => async () => ({ keys: keys.map((k) => ({ ...k.jwk })) });
const reset = () => __resetClerkJwksCacheForTests();

// ─── session token verification ──────────────────────────────────────────────
test("a valid token verifies and exposes only the claims we use", async () => {
  reset();
  const r = await verifyClerkSessionToken(sign(K1, good({ email: "a@b.test", email_verified: true })), SYLO, { fetchJwks: jwks(K1), nowMs: NOW });
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.claims, { sub: "user_2abcdEFGH1234", azp: "https://sylo.ayzen.tech", exp: sec + 60, iat: sec - 5, sid: "sess_1", email: "a@b.test", emailVerified: true });
});

test("email_verified must be literally true; absent email is fine", async () => {
  reset();
  const r = await verifyClerkSessionToken(sign(K1, good({ email: "a@b.test", email_verified: "true" })), SYLO, { fetchJwks: jwks(K1), nowMs: NOW });
  assert.equal(r.ok && r.claims.emailVerified, false);
});

test("every claim is enforced: issuer, expiry (30s leeway), nbf, azp, subject", async () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["wrong issuer", good({ iss: "https://clerk.ryft.test" }), "bad_issuer"],
    ["expired", good({ exp: sec - 31 }), "expired"],
    ["not yet valid", good({ nbf: sec + 31 }), "not_yet_valid"],
    ["foreign azp", good({ azp: "https://evil.example" }), "bad_azp"],
    ["another module's origin as azp", good({ azp: "https://ryft.ayzen.tech" }), "bad_azp"],
    ["missing azp", good({ azp: undefined }), "bad_azp"],
    ["not a clerk user id", good({ sub: "42" }), "bad_subject"],
    ["no exp", good({ exp: undefined }), "expired"],
  ];
  for (const [name, claims, reason] of cases) {
    reset();
    assert.deepEqual(await verifyClerkSessionToken(sign(K1, claims), SYLO, { fetchJwks: jwks(K1), nowMs: NOW }), { ok: false, reason }, name);
  }
  reset();
  assert.equal((await verifyClerkSessionToken(sign(K1, good({ exp: sec - 29 })), SYLO, { fetchJwks: jwks(K1), nowMs: NOW })).ok, true, "inside leeway");
});

test("cross-module isolation: a token signed by another module's Clerk application never verifies here", async () => {
  reset();
  // Same kid, different key pair (that module's application): signature fails.
  assert.deepEqual(await verifyClerkSessionToken(sign(OTHER, good()), SYLO, { fetchJwks: jwks(K1), nowMs: NOW }), { ok: false, reason: "bad_signature" });
  reset();
  // Even with a perfectly valid signature from a key this module does NOT trust (unknown kid) it is refused.
  assert.deepEqual(await verifyClerkSessionToken(sign(K2, good()), SYLO, { fetchJwks: jwks(K1), nowMs: NOW }), { ok: false, reason: "unknown_kid" });
  reset();
  // And a token whose issuer is the other module's, even if (hypothetically) signed with our key, is refused.
  assert.deepEqual(await verifyClerkSessionToken(sign(K1, good({ iss: "https://clerk.ryft.test" })), SYLO, { fetchJwks: jwks(K1), nowMs: NOW }), { ok: false, reason: "bad_issuer" });
});

test("algorithm confusion: alg none, HS256 (signed with the public key as secret) and missing kid are refused", async () => {
  reset();
  const none = `${b64u({ alg: "none", kid: "ins_k1" })}.${b64u(good())}.`;
  assert.equal((await verifyClerkSessionToken(none, SYLO, { fetchJwks: jwks(K1), nowMs: NOW })).ok, false);
  const h = b64u({ alg: "HS256", kid: "ins_k1" }), p = b64u(good());
  const hs = `${h}.${p}.${createHmac("sha256", JSON.stringify(K1.jwk)).update(`${h}.${p}`).digest("base64url")}`;
  assert.deepEqual(await verifyClerkSessionToken(hs, SYLO, { fetchJwks: jwks(K1), nowMs: NOW }), { ok: false, reason: "bad_alg" });
  const nokid = sign(K1, good(), { kid: undefined });
  assert.deepEqual(await verifyClerkSessionToken(nokid, SYLO, { fetchJwks: jwks(K1), nowMs: NOW }), { ok: false, reason: "unknown_kid" });
});

test("tampered payload and garbage never throw", async () => {
  reset();
  const t = sign(K1, good()).split(".");
  const forged = `${t[0]}.${b64u(good({ sub: "user_2attackerAAAA" }))}.${t[2]}`;
  assert.deepEqual(await verifyClerkSessionToken(forged, SYLO, { fetchJwks: jwks(K1), nowMs: NOW }), { ok: false, reason: "bad_signature" });
  for (const junk of [undefined, null, 5, "", "a.b", "a.b.c.d", "x".repeat(9000), "!!.@@.##", { a: 1 }]) {
    assert.equal((await verifyClerkSessionToken(junk, SYLO, { fetchJwks: jwks(K1), nowMs: NOW })).ok, false);
  }
});

test("JWKS: cached across calls; a rotated-in kid is fetched once after the cooldown, never more often", async () => {
  reset();
  let fetches = 0;
  let current = [K1];
  const f: FetchJwks = async () => { fetches++; return { keys: current.map((k) => ({ ...k.jwk })) }; };
  await verifyClerkSessionToken(sign(K1, good()), SYLO, { fetchJwks: f, nowMs: NOW });
  await verifyClerkSessionToken(sign(K1, good()), SYLO, { fetchJwks: f, nowMs: NOW + 1000 });
  assert.equal(fetches, 1, "second verification served from cache");
  current = [K1, K2];
  // Unknown kid inside the cooldown: no refetch (junk kids cannot hammer the endpoint)…
  assert.equal((await verifyClerkSessionToken(sign(K2, good()), SYLO, { fetchJwks: f, nowMs: NOW + 5000 })).ok, false);
  assert.equal(fetches, 1);
  // …after it, the rotated key is picked up.
  assert.equal((await verifyClerkSessionToken(sign(K2, good({ exp: sec + 120 })), SYLO, { fetchJwks: f, nowMs: NOW + 31_000 })).ok, true);
  assert.equal(fetches, 2);
});

test("JWKS endpoint down: cached keys keep working; with no cache it is a clean jwks_unavailable", async () => {
  reset();
  const down: FetchJwks = async () => { throw new Error("offline"); };
  assert.deepEqual(await verifyClerkSessionToken(sign(K1, good()), SYLO, { fetchJwks: down, nowMs: NOW }), { ok: false, reason: "jwks_unavailable" });
  await verifyClerkSessionToken(sign(K1, good()), SYLO, { fetchJwks: jwks(K1), nowMs: NOW });
  assert.equal((await verifyClerkSessionToken(sign(K1, good({ exp: sec + 7200 })), SYLO, { fetchJwks: down, nowMs: NOW + 3_700_000 })).ok, true, "stale-but-present key still verifies when refresh fails");
});

test("JWKS caches are per module (keyed by the module's own JWKS url)", async () => {
  reset();
  const RYFT: ClerkModuleConfig = { ...SYLO, module: "ryft", issuer: "https://clerk.ryft.test", jwksUrl: "https://clerk.ryft.test/.well-known/jwks.json", authorizedParties: ["https://ryft.ayzen.tech"] };
  await verifyClerkSessionToken(sign(K1, good()), SYLO, { fetchJwks: jwks(K1), nowMs: NOW });
  // RYFT has no cached keys and its (different) JWKS does not contain K1: not served from SYLO's cache.
  const r = await verifyClerkSessionToken(sign(K1, good({ iss: RYFT.issuer, azp: "https://ryft.ayzen.tech" })), RYFT, { fetchJwks: jwks(K2), nowMs: NOW });
  assert.deepEqual(r, { ok: false, reason: "unknown_kid" });
});

// ─── svix ────────────────────────────────────────────────────────────────────
const SECRET = "whsec_" + Buffer.from("super-secret-signing-key-0123456789").toString("base64");
const svixSig = (id: string, ts: string, body: string, secret = SECRET) => "v1," + createHmac("sha256", Buffer.from(secret.slice(6), "base64")).update(`${id}.${ts}.${body}`).digest("base64");

test("svix: valid signature, rotation (several signatures), and every failure mode", () => {
  const body = '{"type":"user.created"}', id = "msg_1", ts = String(sec);
  const base = { secret: SECRET, id, timestamp: ts, body, nowMs: NOW };
  assert.deepEqual(verifySvixSignature({ ...base, signature: svixSig(id, ts, body) }), { ok: true });
  assert.deepEqual(verifySvixSignature({ ...base, signature: `v1,AAAA ${svixSig(id, ts, body)}` }), { ok: true }, "any of several signatures");
  assert.equal((verifySvixSignature({ ...base, signature: svixSig(id, ts, body + " ") }) as any).reason, "bad_signature", "body tampered");
  assert.equal((verifySvixSignature({ ...base, signature: svixSig("msg_2", ts, body) }) as any).reason, "bad_signature", "id bound into the signature");
  assert.equal((verifySvixSignature({ ...base, signature: svixSig(id, ts, body, "whsec_" + Buffer.from("other").toString("base64")) }) as any).reason, "bad_signature", "other secret");
  assert.equal((verifySvixSignature({ ...base, signature: "v2," + svixSig(id, ts, body).slice(3) }) as any).reason, "bad_signature", "only v1 accepted");
  assert.equal((verifySvixSignature({ ...base, timestamp: String(sec - 301), signature: svixSig(id, String(sec - 301), body) }) as any).reason, "stale");
  assert.equal((verifySvixSignature({ ...base, timestamp: String(sec + 301), signature: svixSig(id, String(sec + 301), body) }) as any).reason, "stale", "future-dated too");
  assert.equal((verifySvixSignature({ ...base, timestamp: "abc", signature: "v1,x" }) as any).reason, "bad_timestamp");
  assert.equal((verifySvixSignature({ ...base, id: undefined, signature: "v1,x" }) as any).reason, "missing_header");
  assert.equal((verifySvixSignature({ ...base, secret: "whsec_", signature: "v1,x" }) as any).reason, "bad_secret");
});

// ─── config ──────────────────────────────────────────────────────────────────
const env = (o: Record<string, string>) => ({ MODULE_CLERK_ENABLED: "1", ...o }) as NodeJS.ProcessEnv;

test("config: feature flag and issuer gate everything; module origins are always authorized parties", () => {
  assert.equal(readClerkConfig("sylo", { CLERK_SYLO_ISSUER: "https://clerk.sylo.test" } as any), null, "flag off");
  assert.equal(readClerkConfig("sylo", env({})), null, "no issuer");
  assert.equal(readClerkConfig("exchange", env({ CLERK_EXCHANGE_ISSUER: "https://x.test" })), null, "unknown module");
  const c = readClerkConfig("sylo", env({ CLERK_SYLO_ISSUER: "https://clerk.sylo.test/", CLERK_SYLO_WEBHOOK_SECRET: "whsec_x", SYLO_HOSTS: "sylo.ayzen.tech, sylo.example.test", CLERK_SYLO_AUTHORIZED_PARTIES: "https://staging.sylo.test" }))!;
  assert.equal(c.issuer, "https://clerk.sylo.test");
  assert.equal(c.jwksUrl, "https://clerk.sylo.test/.well-known/jwks.json");
  assert.deepEqual(c.authorizedParties.sort(), ["https://staging.sylo.test", "https://sylo.ayzen.tech", "https://sylo.example.test"]);
  assert.equal(isClerkConfigured("sylo", env({ CLERK_SYLO_ISSUER: "https://clerk.sylo.test" })), true);
});

test("config: issuers must be https origins", () => {
  for (const bad of ["http://clerk.test", "clerk.test", "https://u:p@clerk.test", "https://clerk.test/path", "https://clerk.test/?a=1", ""]) assert.equal(normalizeIssuer(bad), null, bad);
  assert.equal(normalizeIssuer("https://clerk.test/"), "https://clerk.test");
});

test("topology: two modules may not share a Clerk issuer or a webhook secret", () => {
  assert.deepEqual(clerkTopologyProblems(env({ CLERK_SYLO_ISSUER: "https://a.test", CLERK_RYFT_ISSUER: "https://b.test" })), []);
  const dup = clerkTopologyProblems(env({ CLERK_SYLO_ISSUER: "https://a.test", CLERK_RYFT_ISSUER: "https://a.test" }));
  assert.equal(dup.length, 1);
  assert.match(dup[0], /share the Clerk issuer/);
  assert.match(clerkTopologyProblems(env({ CLERK_SYLO_ISSUER: "https://a.test", CLERK_RYFT_ISSUER: "https://b.test", CLERK_SYLO_WEBHOOK_SECRET: "s", CLERK_RYFT_WEBHOOK_SECRET: "s" }))[0], /share a Clerk webhook secret/);
  assert.match(clerkTopologyProblems(env({ CLERK_SYLO_ISSUER: "http://a.test" }))[0], /https origin/);
  assert.equal(clerkEnvName("sylo", "ISSUER"), "CLERK_SYLO_ISSUER");
});
