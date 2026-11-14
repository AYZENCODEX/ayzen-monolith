import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { smoke } from "./smoke-oidc-endpoints.mjs";

function stub(overrides = {}, issuerOverride) {
  const server = http.createServer((req, res) => {
    const origin = issuerOverride ?? `http://127.0.0.1:${server.address().port}`;
    if (req.url === "/.well-known/openid-configuration") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({
        issuer: origin, jwks_uri: `${origin}/.well-known/jwks.json`, authorization_endpoint: `${origin}/oidc/authorize`,
        token_endpoint: `${origin}/oidc/token`, userinfo_endpoint: `${origin}/oidc/userinfo`, end_session_endpoint: `${origin}/oidc/logout`,
        introspection_endpoint: `${origin}/oidc/introspect`, revocation_endpoint: `${origin}/oidc/revoke`, registration_endpoint: `${origin}/oidc/register`,
      }));
    }
    const key = `${req.method} ${req.url}`;
    res.statusCode = overrides[key] ?? ({ "GET /.well-known/jwks.json": 200, "GET /oidc/userinfo": 401 }[key] ?? 400);
    res.end("{}");
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

test("passes when every advertised endpoint answers (400/401/200 all mean 'the route exists')", async () => {
  const { server, base } = await stub();
  const r = await smoke(base);
  server.close();
  assert.deepEqual(r.problems, []);
  assert.equal(r.results.length, 8);
});

test("fails on a 404 (advertised but missing) and on a 405 (wrong method) and on a 500", async () => {
  const { server, base } = await stub({ "POST /oidc/revoke": 404, "POST /oidc/introspect": 405, "POST /oidc/token": 500 });
  const r = await smoke(base);
  server.close();
  assert.equal(r.ok, false);
  assert.equal(r.problems.length, 3);
  assert.match(r.problems.join("\n"), /revocation_endpoint.*404/);
  assert.match(r.problems.join("\n"), /introspection_endpoint.*405/);
  assert.match(r.problems.join("\n"), /token_endpoint.*500/);
});

test("--skip-register does not call /oidc/register", async () => {
  const seen = [];
  const { server, base } = await stub({});
  const r = await smoke(base, { skipRegister: true, fetchImpl: (u, o) => { seen.push(`${o?.method ?? "GET"} ${new URL(u).pathname}`); return fetch(u, o); } });
  server.close();
  assert.ok(r.ok);
  assert.ok(!seen.includes("POST /oidc/register"));
});

test("flags an issuer whose host is not the probed host unless --issuer-differs", async () => {
  const { server, base } = await stub({}, "https://id.ayzen.tech");
  const strict = await smoke(base);
  const lax = await smoke(base, { issuerDiffers: true });
  server.close();
  assert.match(strict.problems.join("\n"), /issuer host id\.ayzen\.tech != probed host/);
  assert.deepEqual(lax.problems, []);
});

test("a down server is a clear failure, not a throw", async () => {
  const r = await smoke("http://127.0.0.1:1");
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /failed/);
});
