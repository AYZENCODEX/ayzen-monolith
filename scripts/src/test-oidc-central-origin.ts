/** W1-P4: lib/oidc-central-origin.ts — where /oidc/authorize sends a visitor for login / signup / consent. Pure, env-driven. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { centralAuthPath, centralUiOrigin } from "../../artifacts/api-server/src/lib/oidc-central-origin";

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const keys = Object.keys(env);
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  try { return fn(); } finally { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

test("issuer == app host (today): the request origin is used, exactly as before W1-P4", () => {
  withEnv({ AYZEN_OIDC_ISSUER: undefined, APP_URL: "https://ayzen.tech" }, () => {
    assert.equal(centralUiOrigin("https://ayzen.tech"), "https://ayzen.tech");
    assert.equal(centralUiOrigin("https://workspace.ayzen.tech"), "https://workspace.ayzen.tech");
  });
});

test("dedicated issuer host (id.ayzen.tech): requests arriving there get the UI from APP_URL", () => {
  withEnv({ AYZEN_OIDC_ISSUER: "https://id.ayzen.tech", APP_URL: "https://ayzen.tech" }, () => {
    assert.equal(centralUiOrigin("https://id.ayzen.tech"), "https://ayzen.tech");
  });
});

test("dedicated issuer configured but the request came in on another host: unchanged (no surprise cross-host redirect)", () => {
  withEnv({ AYZEN_OIDC_ISSUER: "https://id.ayzen.tech", APP_URL: "https://ayzen.tech" }, () => {
    assert.equal(centralUiOrigin("https://ayzen.tech"), "https://ayzen.tech");
    assert.equal(centralUiOrigin("https://workspace.ayzen.tech"), "https://workspace.ayzen.tech");
  });
});

test("local development (localhost issuer == app) keeps the request origin", () => {
  withEnv({ AYZEN_OIDC_ISSUER: undefined, APP_URL: "http://localhost:5173" }, () => {
    assert.equal(centralUiOrigin("http://localhost:5173"), "http://localhost:5173");
    assert.equal(centralUiOrigin("http://localhost:8080"), "http://localhost:8080");
  });
});

test("malformed issuer never throws and never redirects elsewhere", () => {
  withEnv({ AYZEN_OIDC_ISSUER: "not a url", APP_URL: "https://ayzen.tech" }, () => {
    assert.equal(centralUiOrigin("https://ayzen.tech"), "https://ayzen.tech");
  });
});

test("screen_hint: only the exact value 'signup' selects /register", () => {
  assert.equal(centralAuthPath("signup"), "/register");
  for (const v of [undefined, "", "login", "SIGNUP", ["signup"], { a: 1 }, "signup "]) assert.equal(centralAuthPath(v), "/login", String(v));
});
