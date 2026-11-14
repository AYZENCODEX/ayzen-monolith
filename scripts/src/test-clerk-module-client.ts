/**
 * scripts/src/test-clerk-module-client.ts — W1-P5 browser-side pieces of social login: publishable-key handling, the Frontend
 * API host decoded from it, the return-path guard, and the module exchange client. Pure: fake fetch/storage, no browser.
 * Run: npx tsx scripts/src/test-clerk-module-client.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ModuleAuthError, exchangeModuleClerkSession, getModuleAuthOptions, moduleLogin } from "../../artifacts/ayzen/src/lib/module-auth-api";
import { MODULES } from "@ayzen/module-registry";
import { clerkScriptUrl, frontendApiHost, publishableKeyEnvName, readPublishableKey, rememberClerkReturn, safePath, takeClerkReturn } from "../../artifacts/ayzen/src/lib/module-clerk";

const pk = (host: string, kind = "test") => `pk_${kind}_${Buffer.from(`${host}$`).toString("base64").replace(/=+$/, "")}`;

test("publishable key -> Frontend API host, only for well-formed keys", () => {
  assert.equal(frontendApiHost(pk("clerk.sylo.ayzen.tech", "live")), "clerk.sylo.ayzen.tech");
  assert.equal(frontendApiHost(pk("Quiet-Owl-12.clerk.accounts.dev")), "quiet-owl-12.clerk.accounts.dev");
  assert.equal(frontendApiHost("pk_test_" + Buffer.from("evil.example/x$").toString("base64")), null);
  assert.equal(frontendApiHost("pk_test_" + Buffer.from("no-dollar.example.com").toString("base64")), null);
  assert.equal(frontendApiHost("pk_test_!!!!!!!!"), null);
  assert.equal(clerkScriptUrl("a.example.com"), "https://a.example.com/npm/@clerk/clerk-js@5/dist/clerk.browser.js");
});

test("each module reads only its own env var", () => {
  assert.equal(publishableKeyEnvName("sylo"), "VITE_CLERK_SYLO_PUBLISHABLE_KEY");
  const env = { VITE_CLERK_SYLO_PUBLISHABLE_KEY: pk("a.example.com"), VITE_CLERK_RYFT_PUBLISHABLE_KEY: "sk_live_secret" };
  assert.equal(readPublishableKey("sylo", env), env.VITE_CLERK_SYLO_PUBLISHABLE_KEY);
  assert.equal(readPublishableKey("ryft", env), null, "a secret-looking key is never accepted");
  assert.equal(readPublishableKey("fyra", env), null);
  assert.equal(readPublishableKey("sylo", undefined), null);
  for (const m of (MODULES as readonly { id: string }[]).map((x) => x.id)) assert.match(publishableKeyEnvName(m), /^VITE_CLERK_[A-Z]+_PUBLISHABLE_KEY$/);
});

test("return path is same-origin path only", () => {
  for (const ok of ["/", "/dashboard", "/a/b?x=1#h"]) assert.equal(safePath(ok), ok);
  for (const bad of ["//evil.example", "https://evil.example", "/\\evil.example", "javascript:alert(1)", "dash", "/a b", ""]) assert.equal(safePath(bad), "/", bad);
  const store = new Map<string, string>();
  const s = { setItem: (k: string, v: string) => void store.set(k, v), getItem: (k: string) => store.get(k) ?? null, removeItem: (k: string) => void store.delete(k) };
  rememberClerkReturn("//evil.example", s);
  assert.equal(takeClerkReturn(s), "/");
  rememberClerkReturn("/vault", s);
  assert.equal(takeClerkReturn(s), "/vault");
  assert.equal(takeClerkReturn(s), "/", "consumed once");
});

function fakeFetch(routes: Record<string, { status?: number; body?: unknown }>) {
  const calls: { url: string; body: any; auth: string | null }[] = [];
  const impl = (async (input: string, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined, auth: ((init.headers ?? {}) as any).Authorization ?? null });
    const key = Object.keys(routes).find((k) => url.endsWith(k));
    const r = key ? routes[key] : { status: 404 };
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test("options carry `social`, default false", async () => {
  const on = fakeFetch({ "/options": { body: { module: "sylo", label: "Sylo", password: true, signup: true, oidc: false, social: true } } });
  assert.equal((await getModuleAuthOptions(on.impl))?.social, true);
  const old = fakeFetch({ "/options": { body: { module: "sylo", label: "Sylo", password: true, signup: true, oidc: false } } });
  assert.equal((await getModuleAuthOptions(old.impl))?.social, false);
});

test("module password login sends `email` (the field the server reads)", async () => {
  const f = fakeFetch({ "/login": { body: { token: "t" } }, "/api/auth/me": { body: { id: 1 } } });
  await moduleLogin("a@b.test", "pw", f.impl);
  assert.deepEqual(f.calls[0].body, { email: "a@b.test", password: "pw" });
});

test("clerk exchange posts session_token, then loads the profile with the module token", async () => {
  const f = fakeFetch({ "/clerk": { body: { token: "mod-token", created: true } }, "/api/auth/me": { body: { id: 7 } } });
  const r = await exchangeModuleClerkSession("clerk-jwt", f.impl);
  assert.deepEqual(f.calls[0].body, { session_token: "clerk-jwt" });
  assert.equal(f.calls[1].auth, "Bearer mod-token");
  assert.equal(r.created, true); assert.equal(r.token, "mod-token");
});

test("clerk exchange surfaces the server code, e.g. EMAIL_ACCOUNT_EXISTS", async () => {
  const f = fakeFetch({ "/clerk": { status: 409, body: { error: "Request rejected", code: "EMAIL_ACCOUNT_EXISTS" } } });
  await assert.rejects(exchangeModuleClerkSession("x", f.impl), (e: any) => e instanceof ModuleAuthError && e.code === "EMAIL_ACCOUNT_EXISTS");
});
