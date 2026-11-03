import assert from "node:assert/strict";
import test from "node:test";
import { handleRpcMessage, negotiateProtocolVersion, LATEST_PROTOCOL_VERSION, type McpContext } from "./protocol";
import { MCP_TOOLS, checkToolAccess, redactSecrets, validateToolArgs, canRevealSecrets, REDACTED, type McpPrincipal } from "./tools";
import { FixedWindowLimiter } from "./rate-limit";
import { isAllowedMcpOrigin } from "./origin";
import { makeLoopbackCaller } from "./loopback";

const full: McpPrincipal = { userId: 1, keyType: "full", scopes: [] };
const scoped = (...scopes: string[]): McpPrincipal => ({ userId: 2, keyType: "scoped", scopes });

type Call = { method: string; path: string; body?: unknown };
function ctxFor(principal: McpPrincipal, responses: Record<string, unknown> = {}, calls: Call[] = []): McpContext & { calls: Call[]; audits: unknown[] } {
  const audits: unknown[] = [];
  return {
    principal, calls, audits,
    audit: (a) => audits.push(a),
    callApi: async (method, path, body) => {
      calls.push({ method, path, body });
      const key = `${method} ${path}`;
      if (!(key in responses)) throw new Error(`no fake for ${key}`);
      const r = responses[key];
      if (r instanceof Error) throw r;
      return r;
    },
  };
}
const rpc = (method: string, params?: unknown, id: number | string = 1) => ({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
const text = (r: any) => r.result.content[0].text as string;

test("initialize negotiates version and advertises only tools", async () => {
  const r: any = await handleRpcMessage(rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } }), ctxFor(full));
  assert.equal(r.result.protocolVersion, "2025-03-26");
  assert.deepEqual(Object.keys(r.result.capabilities), ["tools"]);
  assert.equal(r.result.serverInfo.name, "ayzen");
  assert.equal(negotiateProtocolVersion("1999-01-01"), LATEST_PROTOCOL_VERSION);
  assert.equal(negotiateProtocolVersion(undefined), LATEST_PROTOCOL_VERSION);
});

test("notifications and client responses get no reply; ping answers {}", async () => {
  assert.equal(await handleRpcMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, ctxFor(full)), null);
  assert.equal(await handleRpcMessage({ jsonrpc: "2.0", method: "nonsense/unknown" }, ctxFor(full)), null);
  assert.equal(await handleRpcMessage({ jsonrpc: "2.0", id: 5, result: {} }, ctxFor(full)), null);
  const r: any = await handleRpcMessage(rpc("ping"), ctxFor(full));
  assert.deepEqual(r.result, {});
});

test("protocol errors: invalid request, unknown method, unknown tool, bad params", async () => {
  const c = ctxFor(full);
  assert.equal(((await handleRpcMessage({ foo: 1 }, c)) as any).error.code, -32600);
  assert.equal(((await handleRpcMessage({ jsonrpc: "2.0", id: {}, method: "ping" }, c)) as any).error.code, -32600);
  assert.equal(((await handleRpcMessage(rpc("resources/list"), c)) as any).error.code, -32601);
  assert.equal(((await handleRpcMessage(rpc("tools/call", { name: "nope" }), c)) as any).error.code, -32602);
  assert.equal(((await handleRpcMessage(rpc("tools/call", {}), c)) as any).error.code, -32602);
});

test("tools/list: full key sees everything; scoped key only what its scopes allow", async () => {
  const all: any = await handleRpcMessage(rpc("tools/list"), ctxFor(full));
  assert.equal(all.result.tools.length, MCP_TOOLS.length);
  for (const t of all.result.tools) assert.ok(t.name && t.description && t.inputSchema && t.annotations, t.name);

  const some: any = await handleRpcMessage(rpc("tools/list"), ctxFor(scoped("mcp", "vault")));
  const names = some.result.tools.map((t: any) => t.name);
  assert.ok(names.includes("ayzen_list_vault_entries"));
  assert.ok(!names.includes("ayzen_create_vault_entry"), "write tool hidden without mcp-write");
  assert.ok(!names.includes("ayzen_list_wallets"));

  const writer: any = await handleRpcMessage(rpc("tools/list"), ctxFor(scoped("mcp", "vault", "mcp-write")));
  assert.ok(writer.result.tools.some((t: any) => t.name === "ayzen_create_vault_entry"));
});

test("tool table is well-formed: unique names, write tools are not read-only, scopes are real scope ids", async () => {
  const { ALL_SCOPE_IDS } = await import("../lib/api-scopes");
  const names = new Set<string>();
  for (const t of MCP_TOOLS) {
    assert.ok(!names.has(t.name), `duplicate ${t.name}`); names.add(t.name);
    assert.match(t.name, /^ayzen_[a-z_]+$/);
    assert.equal(t.annotations.readOnlyHint, !t.write, t.name);
    for (const s of t.scopes) assert.ok(ALL_SCOPE_IDS.includes(s), `${t.name}: unknown scope ${s}`);
    for (const req of t.inputSchema.required ?? []) assert.ok(req in t.inputSchema.properties, `${t.name}: required ${req} not in properties`);
  }
  for (const s of ["mcp", "mcp-write", "vault-secrets", "finance"]) assert.ok(ALL_SCOPE_IDS.includes(s), s);
});

test("a scoped key missing a scope gets an actionable tool error, and is audited", async () => {
  const c = ctxFor(scoped("mcp", "vault"));
  const r = await handleRpcMessage(rpc("tools/call", { name: "ayzen_create_vault_entry", arguments: { projectName: "x" } }), c);
  assert.equal((r as any).result.isError, true);
  assert.match(text(r), /Missing scope\(s\): mcp-write/);
  assert.equal(c.calls.length, 0, "must not reach the API");
  assert.deepEqual((c.audits[0] as any).reason, "scope_missing");
});

test("argument validation: required, types, enum, unknown keys (no mass-assignment)", () => {
  const create = MCP_TOOLS.find((t) => t.name === "ayzen_create_vault_entry")!;
  assert.match(validateToolArgs(create.inputSchema, {})!, /projectName/);
  assert.match(validateToolArgs(create.inputSchema, { projectName: 3 })!, /string/);
  assert.match(validateToolArgs(create.inputSchema, { projectName: "x", userId: 99 })!, /unknown argument "userId"/);
  assert.equal(validateToolArgs(create.inputSchema, { projectName: "x", tags: ["a"] }), null);
  assert.match(validateToolArgs(create.inputSchema, { projectName: "x", tags: [1] })!, /array of string/);
  const projects = MCP_TOOLS.find((t) => t.name === "ayzen_list_projects")!;
  assert.match(validateToolArgs(projects.inputSchema, { which: "mine" })!, /one of/);
  const get = MCP_TOOLS.find((t) => t.name === "ayzen_get_vault_entry")!;
  assert.match(validateToolArgs(get.inputSchema, { id: 1.5 })!, /integer/);
});

test("vault entry secrets are redacted unless reveal is allowed AND requested", async () => {
  const entry = { id: 7, projectName: "P", username: "u", accountPassword: "hunter2", seedPhrase: "a b c", twoFactorSecret: "JBSW", accessToken: "tok", shipping: "ok", isPrivate: true, notes: "", apiKey: null };
  const call = (p: McpPrincipal, args: object) => handleRpcMessage(rpc("tools/call", { name: "ayzen_get_vault_entry", arguments: args }), ctxFor(p, { "GET /vault/7": entry }));

  const dflt: any = JSON.parse(text(await call(full, { id: 7 })));
  assert.equal(dflt.accountPassword, REDACTED);
  assert.equal(dflt.seedPhrase, REDACTED);
  assert.equal(dflt.twoFactorSecret, REDACTED);
  assert.equal(dflt.accessToken, REDACTED);
  assert.equal(dflt.projectName, "P");
  assert.equal(dflt.shipping, "ok", "camelCase suffix match must not hit 'shipping'");
  assert.equal(dflt.isPrivate, true, "booleans are not secrets");
  assert.equal(dflt.apiKey, null);

  const revealed: any = JSON.parse(text(await call(full, { id: 7, reveal: true })));
  assert.equal(revealed.accountPassword, "hunter2");

  const noScope = await call(scoped("mcp", "vault"), { id: 7, reveal: true });
  assert.equal((noScope as any).result.isError, true);
  assert.match(text(noScope), /vault-secrets/);

  const withScope: any = JSON.parse(text(await call(scoped("mcp", "vault", "vault-secrets"), { id: 7, reveal: true })));
  assert.equal(withScope.seedPhrase, "a b c");
  assert.equal(canRevealSecrets(scoped("vault")), false);
});

test("redactSecrets is deep and does not mutate its input", () => {
  const input = { a: [{ privateKey: "k", ok: 1 }], nested: { password: "p" } };
  const out: any = redactSecrets(input);
  assert.equal(out.a[0].privateKey, REDACTED);
  assert.equal(out.nested.password, REDACTED);
  assert.equal(out.a[0].ok, 1);
  assert.equal(input.nested.password, "p");
});

test("write tools forward only declared fields and redact the echoed entry", async () => {
  const c = ctxFor(full, { "PATCH /vault/3": { id: 3, accountPassword: "new", projectName: "Q" } });
  const r = await handleRpcMessage(rpc("tools/call", { name: "ayzen_update_vault_entry", arguments: { id: 3, projectName: "Q", accountPassword: "new" } }), c);
  assert.deepEqual(c.calls[0], { method: "PATCH", path: "/vault/3", body: { projectName: "Q", accountPassword: "new" } });
  assert.equal(JSON.parse(text(r)).accountPassword, REDACTED);
});

test("module tools hit the right REST paths", async () => {
  const c = ctxFor(full, {
    "GET /projects/enrolled": [], "GET /projects": [], "GET /projects/4": { id: 4 },
    "GET /tasks?projectId=4": [], "GET /tasks": [],
    "GET /finance/entries?kind=loan&bookId=2": [], "GET /finance/books": [], "GET /finance/invoices": [],
    "GET /teams": [], "GET /teams/9": {}, "GET /teams/9/stats": {},
    "GET /ayzen-mail/unread-count": { count: 2 }, "GET /wallets": [],
  });
  const call = (name: string, args: object = {}) => handleRpcMessage(rpc("tools/call", { name, arguments: args }), c);
  await call("ayzen_list_projects"); await call("ayzen_list_projects", { which: "all" }); await call("ayzen_get_project", { id: 4 });
  await call("ayzen_list_tasks", { projectId: 4 }); await call("ayzen_list_tasks");
  await call("ayzen_list_finance_entries", { kind: "loan", bookId: 2 }); await call("ayzen_list_finance_books"); await call("ayzen_list_finance_invoices");
  await call("ayzen_list_teams"); await call("ayzen_get_team", { id: 9 }); await call("ayzen_get_team", { id: 9, stats: true });
  await call("ayzen_mail_unread_count"); await call("ayzen_list_wallets");
  assert.deepEqual(c.calls.map((x) => x.path), [
    "/projects/enrolled", "/projects", "/projects/4", "/tasks?projectId=4", "/tasks",
    "/finance/entries?kind=loan&bookId=2", "/finance/books", "/finance/invoices",
    "/teams", "/teams/9", "/teams/9/stats", "/ayzen-mail/unread-count", "/wallets",
  ]);
});

test("mail list returns plain-text previews, never full bodies, and honors unreadOnly", async () => {
  const long = "<p>" + "word ".repeat(100) + "</p>";
  const rows = [
    { id: 1, from_username: "a", from_email: "a@x", subject: "s1", body: long, is_read: false, created_at: "t" },
    { id: 2, from_username: "b", from_email: "b@x", subject: "s2", body: "hi", is_read: true, created_at: "t" },
  ];
  const r = await handleRpcMessage(rpc("tools/call", { name: "ayzen_list_mail", arguments: { unreadOnly: true } }), ctxFor(full, { "GET /ayzen-mail": rows }));
  const out = JSON.parse(text(r));
  assert.equal(out.length, 1);
  assert.ok(out[0].preview.length <= 201 && !out[0].preview.includes("<p>"));
  assert.equal("body" in out[0], false);
});

test("dashboard summary degrades for scoped keys that cannot read /auth/me", async () => {
  const c = ctxFor(scoped("mcp", "vault"), { "GET /vault": [{ id: 1, lastHealthFlags: ["x"] }, { id: 2, lastHealthFlags: [] }], "GET /auth/me": new Error("This endpoint isn't available to scoped API keys.") });
  const out = JSON.parse(text(await handleRpcMessage(rpc("tools/call", { name: "ayzen_dashboard_summary" }), c)));
  assert.deepEqual(out, { totalVaultEntries: 2, flaggedEntries: 1 });
});

test("REST failures become isError results (the model can read them), and are audited", async () => {
  const c = ctxFor(full, { "GET /teams": new Error("Forbidden") });
  const r: any = await handleRpcMessage(rpc("tools/call", { name: "ayzen_list_teams" }), c);
  assert.equal(r.result.isError, true);
  assert.match(text(r), /Forbidden/);
  assert.equal((c.audits[0] as any).ok, false);
  assert.ok(!JSON.stringify(c.audits).includes("arguments"), "audit carries no argument values");
});

test("oversized results are truncated with a notice", async () => {
  const big = [{ id: 1, projectName: "x".repeat(150_000), category: "c" }];
  const r = await handleRpcMessage(rpc("tools/call", { name: "ayzen_list_vault_entries" }), ctxFor(full, { "GET /vault": big }));
  assert.match(text(r), /truncated/);
  assert.ok(text(r).length < 101_000);
});

test("checkToolAccess: write tools need mcp-write on scoped keys only", () => {
  const w = MCP_TOOLS.find((t) => t.name === "ayzen_update_vault_entry")!;
  assert.equal(checkToolAccess(w, full).ok, true);
  assert.deepEqual(checkToolAccess(w, scoped("vault")), { ok: false, missing: ["mcp-write"] });
  assert.equal(checkToolAccess(w, scoped("vault", "mcp-write")).ok, true);
});

test("rate limiter: per-key window, resets, reports retry-after", () => {
  let now = 1_000;
  const l = new FixedWindowLimiter(2, 60_000, () => now);
  assert.equal(l.hit("a").allowed, true);
  assert.equal(l.hit("a").allowed, true);
  const third = l.hit("a");
  assert.equal(third.allowed, false);
  assert.equal(third.retryAfterSec, 60);
  assert.equal(l.hit("b").allowed, true, "other keys unaffected");
  now += 60_001;
  assert.equal(l.hit("a").allowed, true, "window reset");
});

test("origin validation: no origin and first-party pass; others need MCP_ALLOWED_ORIGINS", () => {
  assert.equal(isAllowedMcpOrigin(undefined, {}), true);
  assert.equal(isAllowedMcpOrigin("https://ayzen.tech", {}), true);
  assert.equal(isAllowedMcpOrigin("https://admin.ayzen.tech", {}), true);
  assert.equal(isAllowedMcpOrigin("https://evil.com", {}), false);
  assert.equal(isAllowedMcpOrigin("https://ayzen.tech.evil.com", {}), false);
  assert.equal(isAllowedMcpOrigin("http://localhost:6274", {}), false);
  assert.equal(isAllowedMcpOrigin("http://localhost:6274", { MCP_ALLOWED_ORIGINS: "http://localhost:6274, https://x.test" }), true);
});

test("loopback caller forwards the caller's key and IP, surfaces API errors, parses JSON", async () => {
  const seen: any[] = [];
  const fakeFetch = (async (url: string, init: any) => {
    seen.push({ url, init });
    if (url.endsWith("/boom")) return new Response(JSON.stringify({ error: "Nope" }), { status: 403 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;
  const call = makeLoopbackCaller("Bearer ayzn_live_x", "203.0.113.9", { fetchImpl: fakeFetch, env: { PORT: "9999" } });
  assert.deepEqual(await call("GET", "/vault"), { ok: true });
  assert.equal(seen[0].url, "http://127.0.0.1:9999/api/vault");
  assert.equal(seen[0].init.headers.Authorization, "Bearer ayzn_live_x");
  assert.equal(seen[0].init.headers["X-Forwarded-For"], "203.0.113.9");
  await assert.rejects(() => call("GET", "/boom"), /Nope/);
});
