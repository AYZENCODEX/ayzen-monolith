import assert from "node:assert/strict";
import test from "node:test";
import { getApiHosts, isApiHost, isFirstPartyOrigin, isFirstPartyProdOrigin } from "./api-hosts";

function withEnv(v: string | undefined, fn: () => void) {
  const saved = process.env.API_HOSTS;
  try { if (v === undefined) delete process.env.API_HOSTS; else process.env.API_HOSTS = v; fn(); }
  finally { if (saved === undefined) delete process.env.API_HOSTS; else process.env.API_HOSTS = saved; }
}

test("default API host is api.ayzen.tech", () => {
  withEnv(undefined, () => {
    assert.deepEqual(getApiHosts(), ["api.ayzen.tech"]);
    assert.equal(isApiHost("api.ayzen.tech"), true);
    assert.equal(isApiHost("API.AYZEN.TECH:443"), true);
    assert.equal(isApiHost("sylo.ayzen.tech"), false);
    assert.equal(isApiHost(undefined), false);
  });
});

test("API_HOSTS overrides and supports several hosts", () => {
  withEnv(" api.ayzen.tech , api2.ayzen.tech ", () => {
    assert.deepEqual(getApiHosts(), ["api.ayzen.tech", "api2.ayzen.tech"]);
    assert.equal(isApiHost("api2.ayzen.tech"), true);
  });
  withEnv("  ", () => assert.deepEqual(getApiHosts(), ["api.ayzen.tech"]));
});

test("first-party origins: apex + subdomains only, never lookalikes", () => {
  for (const ok of ["https://ayzen.tech", "https://sylo.ayzen.tech", "https://api.ayzen.tech", "https://admin.ayzen.tech"])
    assert.equal(isFirstPartyOrigin(ok), true, ok);
  for (const bad of ["http://ayzen.tech", "https://ayzen.tech.evil.com", "https://evilayzen.tech", "https://a.b.ayzen.tech", "https://ayzen.tech:8443", "https://evil.com", ""])
    assert.equal(isFirstPartyOrigin(bad), false, bad);
});

test("localhost origins are dev-only", () => {
  assert.equal(isFirstPartyOrigin("http://sylo.localhost"), true);
  assert.equal(isFirstPartyProdOrigin("http://sylo.localhost"), false);
});
