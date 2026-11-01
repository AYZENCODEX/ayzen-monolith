import assert from "node:assert/strict";
import test from "node:test";
import { isApiOriginUrl, rewriteApiUrl } from "./api-routing-core";

const API = "https://api.ayzen.tech";
const PAGE = "https://sylo.ayzen.tech";

test("relative /api paths move to the API origin", () => {
  assert.equal(rewriteApiUrl("/api/vault/entries?x=1", API, "", PAGE), "https://api.ayzen.tech/api/vault/entries?x=1");
  assert.equal(rewriteApiUrl("/api", API, "", PAGE), "https://api.ayzen.tech/api");
});

test("base-path-prefixed /api paths are handled", () => {
  assert.equal(rewriteApiUrl("/app/api/me", API, "/app/", PAGE), "https://api.ayzen.tech/api/me");
});

test("absolute same-origin /api URLs are rewritten", () => {
  assert.equal(rewriteApiUrl("https://sylo.ayzen.tech/api/me", API, "", PAGE), "https://api.ayzen.tech/api/me");
});

test("non-API URLs are untouched", () => {
  for (const u of ["/vault", "/oidc/authorize", "/assets/app.js", "//cdn.example.com/api/x", "https://other.example/api/x", "/apiary", "https://api.ayzen.tech/api/me"])
    assert.equal(rewriteApiUrl(u, API, "", PAGE), u, u);
});

test("isApiOriginUrl matches only the API origin", () => {
  assert.equal(isApiOriginUrl("https://api.ayzen.tech/api/me", API), true);
  assert.equal(isApiOriginUrl("https://api.ayzen.tech.evil.com/api/me", API), false);
  assert.equal(isApiOriginUrl("/api/me", API), false);
});
