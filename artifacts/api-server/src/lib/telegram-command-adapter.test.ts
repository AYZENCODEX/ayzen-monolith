import assert from "node:assert/strict";
import test from "node:test";
import { createDomainCommandAdapter, type TelegramAdapterContext, type TelegramLinkedIdentity } from "./telegram-command-adapter";

const USER = 4242;
const linked = new Map<number, TelegramLinkedIdentity>([[USER, { userId: 7, role: "user" }], [999, { userId: 1, role: "admin" }], [998, { userId: 2, role: "user" }]]);

function harness(botKey: string, options: { adminOwnerId?: string; configured?: boolean } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const adapter = createDomainCommandAdapter({
    botKey,
    apiBaseUrl: "http://gateway.test:5000",
    fetchImpl,
    adminOwnerId: options.adminOwnerId,
    ...(options.configured === false ? {} : {
      resolveIdentity: async ({ chatId }) => linked.get(Number(chatId)) ?? null,
      issueToken: async (identity) => `token-for-${identity.userId}`,
    }),
  });
  const send = (text: string, from = USER, chatId: number | undefined = from) => {
    const [command, ...args] = text.trim().split(/\s+/);
    return adapter.handle({
      envelope: {} as TelegramAdapterContext["envelope"],
      message: { botKey, updateId: 1, telegramUserId: from, chatId, text } as TelegramAdapterContext["message"],
      command: command.toLowerCase(),
      args,
      botKey,
      requestId: "req-1",
    });
  };
  return { calls, send };
}

test("linked user's command reaches the capability route with a bearer token", async () => {
  const { calls, send } = harness("ryft");
  const result = await send("/balance acc-1");
  assert.equal(result.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://gateway.test:5000/api/finance/accounts/acc-1/balance");
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, "Bearer token-for-7");
});

test("a command owned by another bot is rejected, not executed", async () => {
  const { calls, send } = harness("warde");
  const result = await send("/breakglass");
  assert.equal(result.status, 400);
  assert.equal(result.body.code, "TELEGRAM_COMMAND_NOT_REGISTERED");
  assert.equal(calls.length, 0);
  assert.equal((await harness("ryft").send("/gaps")).body.code, "TELEGRAM_COMMAND_NOT_REGISTERED");
});

test("admin bot fails closed when no owner is configured", async () => {
  const { calls, send } = harness("admin", { adminOwnerId: undefined });
  const result = await send("/health", 999);
  assert.equal(result.status, 403);
  assert.equal(result.body.code, "ADMIN_TELEGRAM_OWNER_REQUIRED");
  assert.equal(calls.length, 0);
});

test("admin bot requires both the owner's Telegram id and an admin role", async () => {
  const wrongOwner = harness("admin", { adminOwnerId: "999" });
  assert.equal((await wrongOwner.send("/health", 998)).body.code, "ADMIN_TELEGRAM_OWNER_REQUIRED");
  const notAdmin = harness("admin", { adminOwnerId: "998" });
  assert.equal((await notAdmin.send("/health", 998)).body.code, "ADMIN_ROLE_REQUIRED");
  assert.equal(notAdmin.calls.length, 0);
  const owner = harness("admin", { adminOwnerId: "999" });
  assert.equal((await owner.send("/health", 999)).status, 200);
  assert.equal(owner.calls.length, 1);
});

test("path arguments cannot escape the capability route", async () => {
  const { calls, send } = harness("ryft");
  for (const bad of ["..", ".", "a/b", "a%2Fb", "x?y=1"]) {
    const result = await send(`/balance ${bad}`);
    assert.equal(result.body.code, "TELEGRAM_ARGUMENT_INVALID", `argument ${bad} must be rejected`);
  }
  assert.equal((await send("/balance")).body.code, "TELEGRAM_ARGUMENT_REQUIRED");
  assert.equal(calls.length, 0);
});

test("unlinked users, group chats and unconfigured auth never reach the API", async () => {
  const unlinked = harness("ryft");
  assert.equal((await unlinked.send("/accounts", 12345)).body.code, "TELEGRAM_ACCOUNT_NOT_LINKED");
  const group = harness("ryft");
  assert.equal((await group.send("/accounts", USER, -100123)).body.code, "TELEGRAM_PRIVATE_CHAT_REQUIRED");
  const unconfigured = harness("ryft", { configured: false });
  assert.equal((await unconfigured.send("/accounts")).body.code, "TELEGRAM_AUTH_NOT_CONFIGURED");
  assert.equal(unlinked.calls.length + group.calls.length + unconfigured.calls.length, 0);
});

test("/start and /help are answered locally without an API call", async () => {
  const { calls, send } = harness("sylo");
  assert.equal((await send("/start")).status, 200);
  const help = await send("/help");
  assert.equal(help.status, 200);
  assert.ok((help.body.commands as unknown[]).length > 0);
  assert.equal(calls.length, 0);
});

// --- Track E: hierarchical commands through the adapter ----------------------

const ADMIN = { adminOwnerId: "999" };

test("/data write reaches the write capability, not the parent's read capability", async () => {
  const { calls, send } = harness("admin", ADMIN);
  const result = await send("/data write foo", 999);
  assert.equal(result.status, 200);
  assert.equal(result.body.capability, "admin.data-write");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://gateway.test:5000/api/admin/data/mutate");
  assert.deepEqual(JSON.parse(calls[0].init.body as string).args, ["foo"], "subcommand token must not leak into args");
});

test("/vault reveal <id> resolves the reveal route and consumes the id as a path param", async () => {
  const { calls, send } = harness("sylo");
  const result = await send("/vault reveal sec-1");
  assert.equal(result.status, 200);
  assert.equal(result.body.capability, "vault.read-secret");
  assert.equal(calls[0].url, "http://gateway.test:5000/api/vault/sec-1/reveal");
});

test("a secret literally named 'help' is an argument, not a help request", async () => {
  const { calls, send } = harness("sylo");
  const result = await send("/vault reveal help");
  assert.equal(result.status, 200);
  assert.equal(calls[0].url, "http://gateway.test:5000/api/vault/help/reveal");
});

test("deprecated flat aliases still work and tell the user their replacement", async () => {
  const { calls, send } = harness("admin", ADMIN);
  const result = await send("/mutate foo", 999);
  assert.equal(result.status, 200);
  assert.equal(calls[0].url, "http://gateway.test:5000/api/admin/data/mutate");
  assert.equal(result.body.deprecated, true);
  assert.equal(result.body.replacement, "/data write");
  const fresh = await harness("admin", ADMIN).send("/data write foo", 999);
  assert.equal(fresh.body.deprecated, undefined, "the new form must not be flagged deprecated");
});

test("/<parent> help lists sub-features locally, without an API call", async () => {
  const { calls, send } = harness("sylo");
  const result = await send("/vault help");
  assert.equal(result.status, 200);
  assert.match(String(result.body.message), /\/vault reveal/);
  assert.equal(calls.length, 0);
});

test("/help output is generated from the tree and hides deprecated aliases", async () => {
  const { send } = harness("admin", ADMIN);
  const help = await send("/help", 999);
  assert.match(String(help.body.message), /\/data — read, write/);
  assert.doesNotMatch(String(help.body.message), /\/mutate/);
});

test("capabilities with no backing route fail closed with 501 and never reach the API", async () => {
  const { calls, send } = harness("admin", ADMIN);
  for (const text of ["/deploy", "/incident ack 123", "/ack 123", "/resolve 123"]) {
    const result = await send(text, 999);
    assert.equal(result.status, 501, text);
    assert.equal(result.body.code, "TELEGRAM_CAPABILITY_NOT_AVAILABLE", text);
  }
  assert.equal(calls.length, 0);
});

test("another bot's subcommands are not reachable", async () => {
  const { calls, send } = harness("warde");
  assert.equal((await send("/data write foo")).body.code, "TELEGRAM_COMMAND_NOT_REGISTERED");
  assert.equal(calls.length, 0);
});
