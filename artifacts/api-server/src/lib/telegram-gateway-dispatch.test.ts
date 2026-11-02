import assert from "node:assert/strict";
import test from "node:test";
import { createGatewayDispatcher } from "./telegram-gateway-dispatch";
import { createTelegramLinkService } from "./telegram-bot-links";
import { createMemoryLinkStore } from "./telegram-link-memory-store";
import type { TelegramCommandAdapter } from "./telegram-command-adapter";

function setup(opts: { adminOwnerId?: string } = {}) {
  const store = createMemoryLinkStore();
  const links = createTelegramLinkService({ store });
  const sent: Array<{ botKey: string; chatId: string; text: string }> = [];
  const claimed = new Set<string>();
  const marks: Array<{ key: string; status: string; error?: string }> = [];
  const adapterCalls: string[] = [];

  // Same shape as the real per-bot adapter: resolves the chat through the link service first.
  const adapter = (botKey: string): TelegramCommandAdapter => ({
    botKey,
    async handle(ctx) {
      adapterCalls.push(`${botKey}:${ctx.command}`);
      const m = ctx.message!;
      if (String(m.chatId) !== String(m.telegramUserId)) return { status: 403, body: { accepted: false, code: "TELEGRAM_PRIVATE_CHAT_REQUIRED" } };
      const r = await links.resolveChat({ botKey, chatId: String(m.chatId), telegramUserId: String(m.telegramUserId) });
      if (r.kind === "unlinked") return { status: 403, body: { accepted: false, code: "TELEGRAM_ACCOUNT_NOT_LINKED" } };
      if (r.kind === "inactive") return { status: 403, body: { accepted: false, code: "TELEGRAM_BOT_INACTIVE" } };
      if (ctx.command === "/help") return { status: 200, body: { botKey, message: "help text" } };
      return { status: 200, body: { accepted: true, botKey, command: ctx.command, result: { items: [1, 2] } } };
    },
  });
  const dispatcher = createGatewayDispatcher({
    claim: async (e) => { const k = `${e.botKey}:${e.updateId}`; if (claimed.has(k)) return false; claimed.add(k); return true; },
    mark: async (e, status, error) => { marks.push({ key: `${e.botKey}:${e.updateId}`, status, error }); },
    links,
    adapters: { sylo: adapter("sylo"), fyra: adapter("fyra"), admin: adapter("admin") },
    sendReply: async (botKey, chatId, text) => { sent.push({ botKey, chatId, text }); return true; },
    getFailures: async () => [],
    adminOwnerId: () => opts.adminOwnerId,
  });
  let updateId = 1;
  const say = (botKey: string, text: string, from = 555, chat = from) =>
    dispatcher.dispatch({ botKey, payload: { update_id: updateId++, message: { text, from: { id: from, username: "akira" }, chat: { id: chat } } } });
  return { dispatcher, links, store, sent, marks, adapterCalls, say };
}

test("an unlinked chat gets a visible 'link your account' reply and the webhook is acknowledged", async () => {
  const t = setup();
  const result = await t.say("sylo", "/vault");
  assert.equal(result.status, 200);
  assert.equal(result.body.code, "TELEGRAM_ACCOUNT_NOT_LINKED");
  assert.equal(t.sent.length, 1);
  assert.match(t.sent[0].text, /not linked/);
  assert.match(t.sent[0].text, /SYLO/);
  assert.deepEqual(t.marks.at(-1), { key: "sylo:1", status: "failed", error: "TELEGRAM_ACCOUNT_NOT_LINKED" });
});

test("web -> bot: /start <code> in a private chat links the account, then commands work", async () => {
  const t = setup();
  const { code } = await t.links.startWebLink({ userId: 4, botKey: "sylo" });
  const start = await t.say("sylo", `/start ${code}`);
  assert.deepEqual([start.status, start.body.linked], [200, true]);
  assert.match(t.sent[0].text, /Linked/);
  assert.ok(!t.adapterCalls.includes("sylo:/start"), "link command is handled before the adapter");

  const next = await t.say("sylo", "/vault");
  assert.equal(next.body.accepted, true);
  assert.match(t.sent.at(-1)!.text, /✅ \/vault/);
});

test("an invalid or expired start code is rejected with a visible reply", async () => {
  const t = setup();
  const result = await t.say("sylo", "/start ZZZZZZZZ");
  assert.equal(result.body.code, "LINK_CODE_INVALID");
  assert.match(t.sent[0].text, /invalid or expired/);
  assert.equal(t.store.links.length, 0);
});

test("bare /start is the normal adapter greeting, not a link attempt", async () => {
  const t = setup();
  await t.say("sylo", "/start");
  assert.ok(t.adapterCalls.includes("sylo:/start"));
});

test("bot -> web: /connect issues a code that the web side can verify", async () => {
  const t = setup();
  const result = await t.say("fyra", "/connect");
  assert.equal(result.body.codeIssued, true);
  const shown = /([A-Z2-9]{4}-[A-Z2-9]{4})/.exec(t.sent[0].text)?.[1];
  assert.ok(shown, "code is shown to the user");
  const verified = await t.links.verifyBotCodeFromWeb({ userId: 8, botKey: "fyra", code: shown! });
  assert.equal(verified.ok, true);
});

test("link commands are refused in group chats", async () => {
  const t = setup();
  const { code } = await t.links.startWebLink({ userId: 4, botKey: "sylo" });
  const result = await t.say("sylo", `/start ${code}`, 555, -1001);
  assert.equal(t.store.links.length, 0);
  assert.equal(result.body.code, "TELEGRAM_PRIVATE_CHAT_REQUIRED");
  assert.match(t.sent.at(-1)!.text, /private chat/);
});

test("a switched-off bot tells the user how to turn it on", async () => {
  const t = setup();
  const { code } = await t.links.startWebLink({ userId: 4, botKey: "sylo" });
  await t.say("sylo", `/start ${code}`);
  await t.links.setActive(4, "sylo", false);
  const result = await t.say("sylo", "/vault");
  assert.equal(result.body.code, "TELEGRAM_BOT_INACTIVE");
  assert.match(t.sent.at(-1)!.text, /switched off/);
});

test("/disconnect removes only this bot's link", async () => {
  const t = setup();
  for (const botKey of ["sylo", "fyra"]) {
    const { code } = await t.links.startWebLink({ userId: 4, botKey });
    await t.say(botKey, `/start ${code}`);
  }
  await t.say("sylo", "/disconnect");
  assert.equal((await t.links.getLink(4, "sylo")), null);
  assert.ok(await t.links.getLink(4, "fyra"));
});

test("duplicate updates are acknowledged without a second reply", async () => {
  const t = setup();
  const payload = { update_id: 900, message: { text: "/vault", from: { id: 555 }, chat: { id: 555 } } };
  await t.dispatcher.dispatch({ botKey: "sylo", payload });
  const again = await t.dispatcher.dispatch({ botKey: "sylo", payload });
  assert.deepEqual(again, { status: 200, body: { accepted: true, duplicate: true } });
  assert.equal(t.sent.length, 1);
});

test("admin bot: only the verified owner can link; everyone else gets no reply at all", async () => {
  const t = setup({ adminOwnerId: "555" });
  const stranger = await t.say("admin", "/connect", 999);
  assert.equal(stranger.body.code, "ADMIN_TELEGRAM_OWNER_REQUIRED");
  assert.equal(t.sent.length, 0, "does not confirm the admin bot exists");
  const owner = await t.say("admin", "/connect", 555);
  assert.equal(owner.body.codeIssued, true);

  const unset = setup({ adminOwnerId: undefined });
  assert.equal((await unset.say("admin", "/connect", 555)).body.code, "ADMIN_TELEGRAM_OWNER_REQUIRED");
});

test("unknown bot and malformed updates are rejected before anything is stored", async () => {
  const t = setup();
  assert.equal((await t.dispatcher.dispatch({ botKey: "nope", payload: { update_id: 1 } })).status, 400);
  assert.equal((await t.dispatcher.dispatch({ botKey: "sylo", payload: { update_id: "x" } })).status, 400);
  assert.equal((await t.dispatcher.dispatch({ botKey: "sylo", payload: null })).status, 400);
  assert.equal(t.marks.length, 0);
});

test("a bot without an adapter fails closed", async () => {
  const t = setup();
  const result = await t.dispatcher.dispatch({ botKey: "wisp", payload: { update_id: 5, message: { text: "/inbox", from: { id: 1 }, chat: { id: 1 } } } });
  assert.equal(result.status, 503);
  assert.equal(result.body.code, "TELEGRAM_DOMAIN_ADAPTER_NOT_AVAILABLE");
});

test("/start@BotName (group syntax) is normalised", async () => {
  const t = setup();
  await t.say("sylo", "/start@sylo_bot");
  assert.ok(t.adapterCalls.includes("sylo:/start"));
});
