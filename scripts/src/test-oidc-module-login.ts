/**
 * scripts/src/test-oidc-module-login.ts — W1-P4 browser-side pieces of "Login with AYZEN" on every module:
 * flow hints, the module session exchange client, and the callback's identity cross-check for explicitly linked accounts.
 * Pure: fake fetch, fake storage, no browser, no network. Run: npx tsx scripts/src/test-oidc-module-login.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { OidcTokenResponse } from "../../artifacts/ayzen/src/lib/oidc-client";
import {
  completeSyloOidcLogin, SyloOidcCallbackError, type CompleteSyloOidcLoginDeps, type SessionExchangeResult,
} from "../../artifacts/ayzen/src/lib/sylo-oidc-callback";
import type { PendingSyloOidcTransaction } from "../../artifacts/ayzen/src/lib/sylo-oidc-login";
import { ModuleAuthError, exchangeModuleOidcSession, getModuleAuthOptions, moduleLogin } from "../../artifacts/ayzen/src/lib/module-auth-api";
import { withFlowHint } from "../../artifacts/ayzen/src/lib/module-oidc-login";

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const idToken = (claims: Record<string, unknown>) => `${b64({ alg: "RS256" })}.${b64(claims)}.sig`;

interface Call { url: string; method: string; body: any; auth: string | null; credentials: string | undefined }
function fakeFetch(routes: Record<string, { status?: number; body?: unknown } | ((c: Call) => { status?: number; body?: unknown })>) {
  const calls: Call[] = [];
  const impl = (async (input: string, init: RequestInit = {}) => {
    const url = String(input);
    const headers = (init.headers ?? {}) as Record<string, string>;
    const call: Call = { url, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : undefined, auth: headers.Authorization ?? null, credentials: init.credentials };
    calls.push(call);
    const key = Object.keys(routes).find((k) => url.endsWith(k));
    const r0 = key ? routes[key] : { status: 404, body: {} };
    const r = typeof r0 === "function" ? r0(call) : r0;
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

// ── flow hints ──────────────────────────────────────────────────────────────────────────────────────────────────────
test("withFlowHint: only signup adds screen_hint, and the rest of the authorize URL is untouched", () => {
  const base = "https://ayzen.tech/oidc/authorize?response_type=code&client_id=ryft&state=s&code_challenge_method=S256";
  assert.equal(withFlowHint(base, "login"), base);
  assert.equal(withFlowHint(base, "link"), base);
  const u = new URL(withFlowHint(base, "signup"));
  assert.equal(u.searchParams.get("screen_hint"), "signup");
  assert.equal(u.searchParams.get("client_id"), "ryft");
  assert.equal(u.searchParams.get("state"), "s");
});

// ── options ─────────────────────────────────────────────────────────────────────────────────────────────────────────
test("getModuleAuthOptions: null when module sessions are off (404) or the body is wrong; parsed when on", async () => {
  assert.equal(await getModuleAuthOptions(fakeFetch({}).impl), null);
  assert.equal(await getModuleAuthOptions(fakeFetch({ "/auth/module/options": { body: { nope: 1 } } }).impl), null);
  const boom = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
  assert.equal(await getModuleAuthOptions(boom), null);
  const ok = await getModuleAuthOptions(fakeFetch({ "/auth/module/options": { body: { module: "ryft", label: "Ryft", password: true, signup: true, oidc: false } } }).impl);
  assert.deepEqual(ok, { module: "ryft", label: "Ryft", password: true, signup: true, oidc: false, social: false });
});

// ── exchange ────────────────────────────────────────────────────────────────────────────────────────────────────────
const ME = { id: 7, username: "u7" };

test("exchangeModuleOidcSession sends the access token (credentials included), then loads the user with the module token", async () => {
  const f = fakeFetch({ "/auth/module/oidc": { body: { token: "MODTOK", created: true, ayzenUserId: 7 } }, "/auth/me": { body: ME } });
  const r = await exchangeModuleOidcSession("AT123", undefined, f.impl);
  assert.deepEqual(r, { token: "MODTOK", user: ME, ayzenUserId: 7 });
  assert.equal(f.calls[0].method, "POST");
  assert.deepEqual(f.calls[0].body, { access_token: "AT123" });
  assert.equal(f.calls[0].credentials, "include");
  assert.equal(f.calls[1].auth, "Bearer MODTOK");
});

test("exchangeModuleOidcSession with link sends the module credentials in the same request", async () => {
  const f = fakeFetch({ "/auth/module/oidc": { body: { token: "T", linked: true, ayzenUserId: 9 } }, "/auth/me": { body: { id: 3 } } });
  await exchangeModuleOidcSession("AT", { identifier: "a@b.test", password: "pw" }, f.impl);
  assert.deepEqual(f.calls[0].body, { access_token: "AT", link: { identifier: "a@b.test", password: "pw" } });
});

test("server refusals surface as ModuleAuthError with the server's code (so the UI can show the right message)", async () => {
  for (const [status, code] of [[409, "ALREADY_HAS_MODULE_ACCOUNT"], [409, "ACCOUNT_ALREADY_LINKED"], [403, "CLIENT_MISMATCH"], [403, "OIDC_NOT_ENABLED"], [401, "TOKEN_TOO_OLD"], [401, "INVALID_CREDENTIALS"]] as const) {
    const f = fakeFetch({ "/auth/module/oidc": { status, body: { error: "x", code, solution: "do y" } } });
    await assert.rejects(() => exchangeModuleOidcSession("AT", undefined, f.impl), (e: any) => e instanceof ModuleAuthError && e.code === code && e.solution === "do y");
  }
});

test("a token without a loadable profile is an error, never a half signed-in state", async () => {
  const f = fakeFetch({ "/auth/module/login": { body: { token: "T" } }, "/auth/me": { status: 401, body: {} } });
  await assert.rejects(() => moduleLogin("a@b.test", "pw", f.impl), (e: any) => e.code === "USER_LOOKUP_FAILED");
});

test("non-JSON server failure still yields a ModuleAuthError with an HTTP code", async () => {
  const impl = (async () => new Response("<html>bad gateway</html>", { status: 502 })) as unknown as typeof fetch;
  await assert.rejects(() => moduleLogin("a", "b", impl), (e: any) => e instanceof ModuleAuthError && e.code === "HTTP_502");
});

// ── callback integration ────────────────────────────────────────────────────────────────────────────────────────────
const PENDING: PendingSyloOidcTransaction = { state: "st", codeVerifier: "v".repeat(43), nonce: "n1", clientId: "ryft", returnToPath: "/wallet", createdAt: Date.now(), flow: "login" };
const tokens = (sub: string): OidcTokenResponse => ({ access_token: "AT", token_type: "Bearer", expires_in: 3600, id_token: idToken({ sub, nonce: "n1" }) } as OidcTokenResponse);
const deps = (exchange: CompleteSyloOidcLoginDeps["sessionExchange"], sub: string): CompleteSyloOidcLoginDeps => ({
  config: { issuer: "https://ayzen.tech", clientId: "ryft", redirectUri: "https://ryft.ayzen.tech/oidc/callback", scopes: ["openid"] },
  metadata: { token_endpoint: "https://ayzen.tech/oidc/token" },
  exchangeCode: async () => tokens(sub),
  sessionExchange: exchange,
});
const params = { code: "c", state: "st", error: null, errorDescription: null } as any;

test("callback hands the redeemed tokens and the pending transaction (incl. flow) to the session exchange", async () => {
  let seen: { t: OidcTokenResponse; p: PendingSyloOidcTransaction } | null = null;
  const r = await completeSyloOidcLogin(params, PENDING, deps(async (t, p) => { seen = { t, p }; return { token: "M", user: { id: 42 } }; }, "42"));
  assert.equal(seen!.t.access_token, "AT");
  assert.equal(seen!.p.flow, "login");
  assert.equal(r.returnToPath, "/wallet");
});

test("explicitly linked account: session user differs from the AYZEN identity, and the reported ayzenUserId makes the cross-check pass", async () => {
  const ex = async (): Promise<SessionExchangeResult> => ({ token: "M", user: { id: 900 /* owning backing user */ }, ayzenUserId: 42 });
  const r = await completeSyloOidcLogin(params, { ...PENDING, flow: "link" }, deps(ex, "42"));
  assert.equal(r.user.id, 900);
});

test("identity cross-check still fails when the reported AYZEN identity is not the one in the ID token", async () => {
  const ex = async (): Promise<SessionExchangeResult> => ({ token: "M", user: { id: 900 }, ayzenUserId: 43 });
  await assert.rejects(() => completeSyloOidcLogin(params, PENDING, deps(ex, "42")), (e: any) => e instanceof SyloOidcCallbackError && e.code === "identity_mismatch");
});

test("legacy exchange (no ayzenUserId) keeps the original rule: sub must equal user.id", async () => {
  await assert.rejects(() => completeSyloOidcLogin(params, PENDING, deps(async () => ({ token: "M", user: { id: 1 } }), "2")), (e: any) => e.code === "identity_mismatch");
  const ok = await completeSyloOidcLogin(params, PENDING, deps(async () => ({ token: "M", user: { id: 2 } }), "2"));
  assert.equal(ok.user.id, 2);
});

test("a refused link/sign-in becomes session_exchange_failed, not an unhandled rejection", async () => {
  const f = fakeFetch({ "/auth/module/oidc": { status: 409, body: { error: "x", code: "ALREADY_HAS_MODULE_ACCOUNT" } } });
  await assert.rejects(
    () => completeSyloOidcLogin(params, PENDING, deps((t) => exchangeModuleOidcSession(t.access_token, undefined, f.impl), "42")),
    (e: any) => e instanceof SyloOidcCallbackError && e.code === "session_exchange_failed",
  );
});
