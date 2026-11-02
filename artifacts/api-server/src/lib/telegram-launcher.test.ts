import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { __resetTelegramLauncherForTests, collectTelegramBotStatus, resolveGatewayTransport, resolveGatewayWebhookUrl, startTelegramLauncher } from "./telegram-launcher";

const SECRET = "s".repeat(24);

type Call = { method: string; body: Record<string, unknown> };
function fakeTelegram(opts: { badTokens?: string[]; failSetWebhook?: boolean; pending?: number } = {}) {
  const calls: Array<Call & { token: string }> = [];
  const fetchImpl = (async (url: string, init: { body: string }) => {
    const [, token, method] = /bot([^/]+)\/(\w+)$/.exec(url)!;
    const body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push({ token, method, body });
    const respond = (status: number, json: unknown) => new Response(JSON.stringify(json), { status });
    if (opts.badTokens?.includes(token)) return respond(401, { ok: false, error_code: 401, description: "Unauthorized" });
    switch (method) {
      case "getMe": return respond(200, { ok: true, result: { id: 1, is_bot: true, first_name: "X", username: `${token}_bot` } });
      case "setWebhook": return opts.failSetWebhook ? respond(400, { ok: false, error_code: 400, description: "bad webhook url" }) : respond(200, { ok: true, result: true });
      case "deleteWebhook": return respond(200, { ok: true, result: true });
      case "getWebhookInfo": return respond(200, { ok: true, result: { url: `https://api.ayzen.tech/x`, pending_update_count: opts.pending ?? 0 } });
      case "getUpdates": return new Promise<Response>(() => { /* never resolves; the test stops the launcher */ });
      default: return respond(200, { ok: true, result: true });
    }
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const baseEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ NODE_ENV: "production", ...extra });
const noop = async () => {};

beforeEach(() => __resetTelegramLauncherForTests());

test("webhook URL and transport defaults", () => {
  assert.equal(resolveGatewayWebhookUrl("sylo", {}), "https://api.ayzen.tech/api/telegram/gateway/sylo/webhook");
  assert.equal(resolveGatewayWebhookUrl("sylo", { TELEGRAM_GATEWAY_PUBLIC_URL: "https://x.example/" }), "https://x.example/api/telegram/gateway/sylo/webhook");
  assert.equal(resolveGatewayTransport({ NODE_ENV: "production" }), "webhook");
  assert.equal(resolveGatewayTransport({ NODE_ENV: "development" }), "polling");
  assert.equal(resolveGatewayTransport({ NODE_ENV: "production", TELEGRAM_GATEWAY_TRANSPORT: "polling" }), "polling");
});

test("every module bot with a token gets getMe + setWebhook; bots without a token and AYZENX are skipped", async () => {
  const tg = fakeTelegram();
  const env = baseEnv({ SYLO_TELEGRAM_BOT_TOKEN: "sylo", FYRA_TELEGRAM_BOT_TOKEN: "fyra", TELEGRAM_SYLO_WEBHOOK_SECRET: SECRET, TELEGRAM_FYRA_WEBHOOK_SECRET: SECRET, TELEGRAM_BOT_TOKEN: "ayzenx-token" });
  await startTelegramLauncher({ env, api: { fetchImpl: tg.fetchImpl }, handleUpdate: noop });

  const hooks = tg.calls.filter((c) => c.method === "setWebhook");
  assert.deepEqual(hooks.map((c) => c.body.url).sort(), [
    "https://api.ayzen.tech/api/telegram/gateway/fyra/webhook",
    "https://api.ayzen.tech/api/telegram/gateway/sylo/webhook",
  ]);
  for (const hook of hooks) {
    assert.equal(hook.body.secret_token, SECRET);
    assert.equal(hook.body.drop_pending_updates, false);
  }
  assert.ok(!tg.calls.some((c) => c.token === "ayzenx-token"), "AYZENX is started by lib/telegram.ts, not the launcher");
  assert.equal(tg.calls.filter((c) => c.method === "getMe").length, 2);

  const status = await collectTelegramBotStatus({ env, ayzenx: { transport: "polling", getUsername: async () => "ayzenx_bot" } });
  const sylo = status.find((s) => s.botKey === "sylo")!;
  assert.deepEqual([sylo.transport, sylo.getMeOk, sylo.username, sylo.lastError], ["webhook", true, "sylo_bot", null]);
  assert.equal(status.find((s) => s.botKey === "wisp")!.transport, "none");
  assert.equal(status.find((s) => s.botKey === "wisp")!.tokenConfigured, false);
  assert.equal(status.find((s) => s.botKey === "ayzenx")!.transport, "polling");
  assert.ok(status.some((s) => s.botKey === "fyra"), "fyra is in the status list");
});

test("a rejected token is reported and does not block other bots", async () => {
  const tg = fakeTelegram({ badTokens: ["bad"] });
  const env = baseEnv({ SYLO_TELEGRAM_BOT_TOKEN: "bad", WISP_TELEGRAM_BOT_TOKEN: "wisp", TELEGRAM_WISP_WEBHOOK_SECRET: SECRET });
  await startTelegramLauncher({ env, api: { fetchImpl: tg.fetchImpl }, handleUpdate: noop });
  const status = await collectTelegramBotStatus({ env, ayzenx: { transport: null, getUsername: async () => null } });
  const sylo = status.find((s) => s.botKey === "sylo")!;
  assert.deepEqual([sylo.getMeOk, sylo.transport], [false, "none"]);
  assert.match(sylo.lastError ?? "", /getMe failed/);
  assert.ok(!JSON.stringify(status).includes("bad\""), "token never appears in status");
  assert.equal(status.find((s) => s.botKey === "wisp")!.transport, "webhook");
  assert.ok(!tg.calls.some((c) => c.token === "bad" && c.method === "setWebhook"));
});

test("setWebhook failure falls back to polling", async () => {
  const tg = fakeTelegram({ failSetWebhook: true });
  const env = baseEnv({ ZYNTH_TELEGRAM_BOT_TOKEN: "zynth", TELEGRAM_ZYNTH_WEBHOOK_SECRET: SECRET });
  await startTelegramLauncher({ env, api: { fetchImpl: tg.fetchImpl }, handleUpdate: noop });
  const z = (await collectTelegramBotStatus({ env, ayzenx: { transport: null, getUsername: async () => null } })).find((s) => s.botKey === "zynth")!;
  assert.equal(z.transport, "polling");
  assert.match(z.lastError ?? "", /setWebhook failed/);
  assert.ok(tg.calls.some((c) => c.method === "deleteWebhook"), "webhook cleared before polling");
});

test("missing or short webhook secret uses polling instead of an unauthenticated webhook", async () => {
  const tg = fakeTelegram();
  const env = baseEnv({ WARDE_TELEGRAM_BOT_TOKEN: "warde", TELEGRAM_WARDE_WEBHOOK_SECRET: "short" });
  await startTelegramLauncher({ env, api: { fetchImpl: tg.fetchImpl }, handleUpdate: noop });
  assert.ok(!tg.calls.some((c) => c.method === "setWebhook"));
  const w = (await collectTelegramBotStatus({ env, ayzenx: { transport: null, getUsername: async () => null } })).find((s) => s.botKey === "warde")!;
  assert.equal(w.transport, "polling");
  assert.match(w.lastError ?? "", /shorter than 16/);
});

test("development defaults to polling and delivers polled updates to the handler", async () => {
  const delivered: Array<[string, number]> = [];
  let served = false;
  const fetchImpl = (async (url: string) => {
    const method = /\/(\w+)$/.exec(url)![1];
    const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }));
    if (method === "getMe") return ok({ id: 1, is_bot: true, first_name: "X", username: "skarn_bot" });
    if (method === "getUpdates") {
      if (!served) { served = true; return ok([{ update_id: 41 }, { update_id: 42 }]); }
      return new Promise<Response>(() => {});
    }
    return ok(true);
  }) as unknown as typeof fetch;
  const env: NodeJS.ProcessEnv = { NODE_ENV: "development", SKARN_TELEGRAM_BOT_TOKEN: "skarn" };
  await startTelegramLauncher({ env, api: { fetchImpl }, handleUpdate: async (botKey, u) => { delivered.push([botKey, u.update_id]); } });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(delivered, [["skarn", 41], ["skarn", 42]]);
});

test("refresh reports webhook URL and pending update count from Telegram", async () => {
  const tg = fakeTelegram({ pending: 3 });
  const env = baseEnv({ VERVE_TELEGRAM_BOT_TOKEN: "verve", TELEGRAM_VERVE_WEBHOOK_SECRET: SECRET });
  const status = await collectTelegramBotStatus({ env, refresh: true, api: { fetchImpl: tg.fetchImpl }, ayzenx: { transport: null, getUsername: async () => null } });
  const v = status.find((s) => s.botKey === "verve")!;
  assert.deepEqual([v.getMeOk, v.pendingUpdateCount, v.webhookUrl], [true, 3, "https://api.ayzen.tech/x"]);
  assert.ok(v.lastCheckedAt);
});
