/**
 * HTTP-level tests for routes/mcp.ts: real Express + real fetch over a socket.
 * Only identity-service is mocked (it needs a database); everything else is the
 * production code path. Run with --experimental-test-module-mocks (see package.json).
 */
import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";

const KEYS: Record<string, any> = {
  ayzn_live_full_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx: { userId: 1, role: "user", authType: "apikey", keyType: "full", scopes: [] },
  ayzn_live_scoped_ok_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx: { userId: 2, role: "user", authType: "apikey", keyType: "scoped", scopes: ["mcp", "vault"] },
  ayzn_live_scoped_nomcp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx: { userId: 3, role: "user", authType: "apikey", keyType: "scoped", scopes: ["vault"] },
  ayzn_live_limited_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx: { userId: 9, role: "user", authType: "apikey", keyType: "full", scopes: [] },
  session_jwt: { userId: 4, role: "user", authType: "session" },
};
mock.module(new URL("../lib/identity-service.ts", import.meta.url).href, {
  namedExports: { authenticateAccessToken: async (t: string) => KEYS[t] ?? null },
});

let server: Server;
let base = "";

before(async () => {
  process.env.MCP_RATE_LIMIT_PER_MIN = "30";
  const { default: router } = await import("./mcp");
  const app = express();
  app.use(express.json());
  app.use(router);
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});
after(() => { server.close(); });

const post = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(base, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
const bearer = (k: string) => ({ Authorization: `Bearer ${k}` });
const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } };

test("auth: no token, session JWT and unknown key are all 401 with WWW-Authenticate", async () => {
  for (const headers of [{}, bearer("session_jwt"), bearer("ayzn_live_unknown_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx")]) {
    const r = await post(init, headers);
    assert.equal(r.status, 401);
    assert.match(r.headers.get("www-authenticate") ?? "", /Bearer/);
  }
});

test("a session cookie alone never authenticates", async () => {
  const r = await post(init, { Cookie: "ayzen_session=session_jwt" });
  assert.equal(r.status, 401);
});

test("origin: foreign Origin is 403; first-party and absent are fine", async () => {
  assert.equal((await post(init, { ...bearer("ayzn_live_full_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"), Origin: "https://evil.example" })).status, 403);
  assert.equal((await post(init, { ...bearer("ayzn_live_full_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"), Origin: "https://ayzen.tech" })).status, 200);
});

test("initialize over HTTP returns JSON-RPC result, no session id, no-store", async () => {
  const r = await post(init, bearer("ayzn_live_full_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"));
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") ?? "", /application\/json/);
  assert.equal(r.headers.get("mcp-session-id"), null);
  assert.equal(r.headers.get("cache-control"), "no-store");
  const j: any = await r.json();
  assert.equal(j.id, 1);
  assert.equal(j.result.protocolVersion, "2025-06-18");
});

test("notification -> 202 with empty body; notification-only batch -> 202", async () => {
  const n = await post({ jsonrpc: "2.0", method: "notifications/initialized" }, bearer("ayzn_live_full_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"));
  assert.equal(n.status, 202);
  assert.equal(await n.text(), "");
  const b = await post([{ jsonrpc: "2.0", method: "notifications/initialized" }], bearer("ayzn_live_full_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"));
  assert.equal(b.status, 202);
});

test("batch returns an array of responses, skipping notifications", async () => {
  const r = await post([{ jsonrpc: "2.0", id: "a", method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: "b", method: "ping" }], bearer("ayzn_live_full_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"));
  const j: any = await r.json();
  assert.deepEqual(j.map((x: any) => x.id), ["a", "b"]);
});

test("garbage bodies are 400 JSON-RPC errors", async () => {
  for (const body of [{}, []]) {
    const r = await post(body, bearer("ayzn_live_full_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"));
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(((await r.json()) as any).error.code, -32600);
  }
});

test("unsupported MCP-Protocol-Version header is 400; supported is fine", async () => {
  assert.equal((await post(init, { ...bearer("ayzn_live_full_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"), "MCP-Protocol-Version": "1999-01-01" })).status, 400);
  assert.equal((await post(init, { ...bearer("ayzn_live_full_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"), "MCP-Protocol-Version": "2025-03-26" })).status, 200);
});

test("scoped keys: need the mcp scope; with it they only see their tools", async () => {
  const no = await post(init, bearer("ayzn_live_scoped_nomcp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"));
  assert.equal(no.status, 403);
  assert.match(((await no.json()) as any).error.message, /"mcp" scope/);

  const list = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, bearer("ayzn_live_scoped_ok_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"));
  const names = ((await list.json()) as any).result.tools.map((t: any) => t.name);
  assert.ok(names.includes("ayzen_list_vault_entries"));
  assert.ok(!names.includes("ayzen_create_vault_entry") && !names.includes("ayzen_list_teams"));
});

test("GET and DELETE are 405 with Allow: POST", async () => {
  for (const method of ["GET", "DELETE"]) {
    const r = await fetch(base, { method });
    assert.equal(r.status, 405);
    assert.match(r.headers.get("allow") ?? "", /POST/);
  }
});

test("rate limit: per user, 429 + Retry-After once the window budget is spent", async () => {
  // dedicated user so other tests do not eat this budget.
  let tripped: Response | null = null;
  for (let i = 0; i < 40 && !tripped; i++) {
    const r = await post({ jsonrpc: "2.0", id: i, method: "ping" }, bearer("ayzn_live_limited_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"));
    if (r.status === 429) tripped = r;
  }
  assert.ok(tripped, "limit should trip");
  assert.ok(Number(tripped!.headers.get("retry-after")) >= 1);
  // a different user is unaffected
  assert.equal((await post({ jsonrpc: "2.0", id: 1, method: "ping" }, bearer("ayzn_live_scoped_ok_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"))).status, 200);
});
