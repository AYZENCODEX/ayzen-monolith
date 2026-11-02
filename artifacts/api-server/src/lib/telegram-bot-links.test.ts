import assert from "node:assert/strict";
import test from "node:test";
import { LINK_CODE_TTL_MS, createTelegramLinkService, formatLinkCode, generateLinkCode, hashLinkCode, normalizeLinkCode } from "./telegram-bot-links";
import { createMemoryLinkStore } from "./telegram-link-memory-store";

function setup(start = new Date("2026-01-01T00:00:00Z")) {
  const clock = { now: start };
  const store = createMemoryLinkStore();
  const service = createTelegramLinkService({ store, now: () => clock.now });
  const advance = (ms: number) => { clock.now = new Date(clock.now.getTime() + ms); };
  return { store, service, advance };
}
const tg = { chatId: "555", telegramUserId: "555", username: "akira" };

test("codes are 8 chars from an unambiguous alphabet and are stored hashed", async () => {
  const code = generateLinkCode();
  assert.match(code, /^[A-HJ-NP-Z2-9]{8}$/);
  assert.equal(normalizeLinkCode(formatLinkCode(code).toLowerCase()), code);
  const { store, service } = setup();
  const issued = await service.startWebLink({ userId: 1, botKey: "sylo" });
  assert.ok(!JSON.stringify(store.codes).includes(issued.code), "plain code must not be stored");
  assert.equal(store.codes[0].codeHash, hashLinkCode("sylo", issued.code));
  assert.notEqual(hashLinkCode("sylo", issued.code), hashLinkCode("wisp", issued.code), "hash is bound to the bot");
});

test("web -> bot: bot claims the code and the link is created, active", async () => {
  const { service } = setup();
  const { code } = await service.startWebLink({ userId: 7, botKey: "sylo" });
  const result = await service.claimWebCodeFromBot({ botKey: "sylo", code, ...tg });
  assert.equal(result.ok, true);
  if (result.ok) { assert.equal(result.link.userId, 7); assert.equal(result.link.active, true); }
  assert.deepEqual((await service.resolveChat({ botKey: "sylo", chatId: "555", telegramUserId: "555" })).kind, "linked");
});

test("bot -> web: /connect code is verified by the logged-in user", async () => {
  const { service } = setup();
  const { code } = await service.startBotLink({ botKey: "ryft", ...tg });
  const result = await service.verifyBotCodeFromWeb({ userId: 9, botKey: "ryft", code: formatLinkCode(code).toLowerCase() });
  assert.equal(result.ok, true);
  if (result.ok) { assert.equal(result.link.chatId, "555"); assert.equal(result.link.username, "akira"); }
});

test("codes are single use", async () => {
  const { service } = setup();
  const { code } = await service.startWebLink({ userId: 1, botKey: "sylo" });
  assert.equal((await service.claimWebCodeFromBot({ botKey: "sylo", code, ...tg })).ok, true);
  const again = await service.claimWebCodeFromBot({ botKey: "sylo", code, chatId: "999", telegramUserId: "999", username: null });
  assert.deepEqual(again, { ok: false, code: "LINK_CODE_INVALID" });
});

test("codes expire after 10 minutes", async () => {
  const { service, advance } = setup();
  const { code } = await service.startWebLink({ userId: 1, botKey: "sylo" });
  advance(LINK_CODE_TTL_MS + 1000);
  assert.deepEqual(await service.claimWebCodeFromBot({ botKey: "sylo", code, ...tg }), { ok: false, code: "LINK_CODE_INVALID" });
});

test("a code for one bot cannot be used on another, nor in the other direction", async () => {
  const { service } = setup();
  const web = await service.startWebLink({ userId: 1, botKey: "sylo" });
  assert.equal((await service.claimWebCodeFromBot({ botKey: "wisp", code: web.code, ...tg })).ok, false);
  assert.equal((await service.verifyBotCodeFromWeb({ userId: 1, botKey: "sylo", code: web.code })).ok, false);
});

test("a new code replaces the previous open code for the same user", async () => {
  const { service } = setup();
  const first = await service.startWebLink({ userId: 1, botKey: "sylo" });
  const second = await service.startWebLink({ userId: 1, botKey: "sylo" });
  assert.equal((await service.claimWebCodeFromBot({ botKey: "sylo", code: first.code, ...tg })).ok, false);
  assert.equal((await service.claimWebCodeFromBot({ botKey: "sylo", code: second.code, ...tg })).ok, true);
});

test("duplicate: a chat already linked to another user is rejected", async () => {
  const { service } = setup();
  const a = await service.startWebLink({ userId: 1, botKey: "sylo" });
  assert.equal((await service.claimWebCodeFromBot({ botKey: "sylo", code: a.code, ...tg })).ok, true);
  const b = await service.startWebLink({ userId: 2, botKey: "sylo" });
  assert.deepEqual(await service.claimWebCodeFromBot({ botKey: "sylo", code: b.code, ...tg }), { ok: false, code: "CHAT_ALREADY_LINKED" });
  // after the chat disconnects, the second user can link it
  assert.equal(await service.unlinkChat("sylo", "555"), true);
  const c = await service.startWebLink({ userId: 2, botKey: "sylo" });
  assert.equal((await service.claimWebCodeFromBot({ botKey: "sylo", code: c.code, ...tg })).ok, true);
});

test("duplicate: re-linking the same user from a new chat moves the link (one link per user and bot)", async () => {
  const { service, store } = setup();
  const a = await service.startWebLink({ userId: 1, botKey: "sylo" });
  await service.claimWebCodeFromBot({ botKey: "sylo", code: a.code, ...tg });
  const b = await service.startWebLink({ userId: 1, botKey: "sylo" });
  await service.claimWebCodeFromBot({ botKey: "sylo", code: b.code, chatId: "777", telegramUserId: "777", username: null });
  assert.equal(store.links.filter((l) => l.userId === 1 && l.botKey === "sylo").length, 1);
  assert.equal((await service.resolveChat({ botKey: "sylo", chatId: "555", telegramUserId: "555" })).kind, "unlinked");
  assert.equal((await service.resolveChat({ botKey: "sylo", chatId: "777", telegramUserId: "777" })).kind, "linked");
});

test("a user can hold one link per bot", async () => {
  const { service } = setup();
  for (const botKey of ["sylo", "wisp", "fyra"]) {
    const { code } = await service.startWebLink({ userId: 1, botKey });
    assert.equal((await service.claimWebCodeFromBot({ botKey, code, ...tg })).ok, true);
  }
  assert.deepEqual((await service.listLinks(1)).map((l) => l.botKey).sort(), ["fyra", "sylo", "wisp"]);
});

test("resolveChat: only the Telegram user who linked can use the chat; inactive and unlink are honoured", async () => {
  const { service } = setup();
  const { code } = await service.startWebLink({ userId: 1, botKey: "sylo" });
  await service.claimWebCodeFromBot({ botKey: "sylo", code, ...tg });
  assert.equal((await service.resolveChat({ botKey: "sylo", chatId: "555", telegramUserId: "666" })).kind, "unlinked");
  assert.equal((await service.resolveChat({ botKey: "wisp", chatId: "555", telegramUserId: "555" })).kind, "unlinked", "links are per bot");
  await service.setActive(1, "sylo", false);
  assert.equal((await service.resolveChat({ botKey: "sylo", chatId: "555", telegramUserId: "555" })).kind, "inactive");
  await service.setActive(1, "sylo", true);
  assert.equal((await service.resolveChat({ botKey: "sylo", chatId: "555", telegramUserId: "555" })).kind, "linked");
  assert.equal(await service.unlink(1, "sylo"), true);
  assert.equal((await service.resolveChat({ botKey: "sylo", chatId: "555", telegramUserId: "555" })).kind, "unlinked");
  assert.equal(await service.setActive(1, "sylo", true), null);
});

test("resolveChat records last activity", async () => {
  const { service, advance } = setup();
  const { code } = await service.startWebLink({ userId: 1, botKey: "sylo" });
  await service.claimWebCodeFromBot({ botKey: "sylo", code, ...tg });
  advance(5000);
  await service.resolveChat({ botKey: "sylo", chatId: "555", telegramUserId: "555" });
  assert.equal((await service.getLink(1, "sylo"))?.lastActivityAt?.toISOString(), "2026-01-01T00:00:05.000Z");
});

test("guessing is rate limited and then blocked even for a valid code", async () => {
  const { service } = setup();
  const { code } = await service.startWebLink({ userId: 1, botKey: "sylo" });
  for (let i = 0; i < 8; i += 1) assert.deepEqual(await service.claimWebCodeFromBot({ botKey: "sylo", code: "ZZZZZZZZ", ...tg }), { ok: false, code: "LINK_CODE_INVALID" });
  assert.deepEqual(await service.claimWebCodeFromBot({ botKey: "sylo", code, ...tg }), { ok: false, code: "TOO_MANY_ATTEMPTS" });
  for (let i = 0; i < 8; i += 1) await service.verifyBotCodeFromWeb({ userId: 3, botKey: "sylo", code: "ZZZZZZZZ" });
  assert.deepEqual(await service.verifyBotCodeFromWeb({ userId: 3, botKey: "sylo", code: "ZZZZZZZZ" }), { ok: false, code: "TOO_MANY_ATTEMPTS" });
});
