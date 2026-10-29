import crypto from "node:crypto";
import { getCapability, listTelegramCommands, resolveTelegramCommand } from "@ayzen/capabilities";

export { resolveCommandTreePath, renderCommandTreeHelp, renderSubcommandHelp } from "./command-parser.mjs";

export const BOT_REGISTRY = Object.freeze({
  ayzenx: { displayName: "AYZENX", workspaceType: "PERSONAL", secretEnv: "TELEGRAM_WEBHOOK_SECRET", role: "general" },
  warde: { displayName: "WARDE", workspaceType: "ORGANIZATION", secretEnv: "TELEGRAM_WARDE_WEBHOOK_SECRET", role: "organization" },
  verve: { displayName: "VERVE", workspaceType: "PERSONAL", secretEnv: "TELEGRAM_VERVE_WEBHOOK_SECRET", role: "marketplace" },
  ryft: { displayName: "RYFT", workspaceType: "PERSONAL", secretEnv: "TELEGRAM_RYFT_WEBHOOK_SECRET", role: "finance" },
  sylo: { displayName: "SYLO", workspaceType: "PERSONAL", secretEnv: "TELEGRAM_SYLO_WEBHOOK_SECRET", role: "vault" },
  skarn: { displayName: "SKARN", workspaceType: "PERSONAL", secretEnv: "TELEGRAM_SKARN_WEBHOOK_SECRET", role: "workflow" },
  zynth: { displayName: "ZYNTH", workspaceType: "PERSONAL", secretEnv: "TELEGRAM_ZYNTH_WEBHOOK_SECRET", role: "ai" },
  wisp: { displayName: "WISP", workspaceType: "PERSONAL", secretEnv: "TELEGRAM_WISP_WEBHOOK_SECRET", role: "mail" },
  admin: {
    displayName: "AYZEN Admin",
    workspaceType: "ADMIN",
    secretEnv: "TELEGRAM_ADMIN_WEBHOOK_SECRET",
    role: "control-plane",
    privileged: true,
    ownerIdentity: "verifiedTelegramNumericUserId",
  },
});

export function getBotDescriptor(botKey) {
  return BOT_REGISTRY[botKey];
}

export function normalizeTelegramUpdate(botKey, payload) {
  const descriptor = getBotDescriptor(botKey);
  const updateId = payload?.update_id;
  if (!descriptor || !Number.isSafeInteger(updateId) || updateId < 0) return null;
  return { botKey, updateId, payload };
}

export function verifyWebhookSecret(expected, actual) {
  if (typeof expected !== "string" || expected.length < 16 || typeof actual !== "string") return false;
  const wanted = Buffer.from(expected);
  const received = Buffer.from(actual);
  return wanted.length === received.length && crypto.timingSafeEqual(wanted, received);
}

export function updateReceiptKey(botKey, updateId) {
  const normalized = normalizeTelegramUpdate(botKey, { update_id: updateId });
  if (!normalized) throw new Error("Invalid Telegram update receipt key");
  return `${botKey}:${updateId}`;
}

export function assertAuthorizedTelegramContext(context) {
  if (!context || !Number.isSafeInteger(context.userId) || context.userId < 1) throw new Error("Telegram user is required");
  if (!getBotDescriptor(context.botKey)) throw new Error("Telegram bot is not registered");
  if (typeof context.workspaceId !== "string" || !context.workspaceId.trim()) throw new Error("Workspace is required");
  if (typeof context.command !== "string" || context.command.length === 0) throw new Error("Command is required");
  if (context.permission !== true) throw new Error("Telegram command is not authorized");
  if (context.botKey === "admin" && context.adminOwner !== true) throw new Error("Verified Admin Telegram owner is required");
  return context;
}

export function normalizeTelegramMessage(envelope) {
  const message = envelope?.payload?.message ?? envelope?.payload?.edited_message ?? envelope?.payload?.callback_query?.message;
  const from = envelope?.payload?.message?.from ?? envelope?.payload?.edited_message?.from ?? envelope?.payload?.callback_query?.from;
  if (!message || !from || !Number.isSafeInteger(from.id)) return null;
  const text = message.text ?? message.caption ?? "";
  const command = typeof text === "string" && text.startsWith("/") ? text.trim().split(/\s+/)[0].toLowerCase() : undefined;
  const callbackData = envelope?.payload?.callback_query?.data;
  return {
    botKey: envelope.botKey,
    updateId: envelope.updateId,
    telegramUserId: from.id,
    username: typeof from.username === "string" ? from.username : undefined,
    chatId: message.chat?.id,
    text,
    ...(command ? { command, capability: resolveTelegramCommand(command, { botKey: envelope.botKey }) } : {}),
    ...(typeof callbackData === "string" ? { callbackData } : {}),
  };
}

const APP_NAMES = Object.freeze({
  ayzenx: "AYZENX", warde: "WARDE", verve: "VERVE", ryft: "RYFT",
  sylo: "SYLO", skarn: "SKARN", zynth: "ZYNTH", wisp: "WISP", admin: "Admin",
});
const SENSITIVE_COMMANDS = new Set(["/connect", "/invite", "/listing", "/transaction", "/secret", "/reveal", "/run", "/cancel", "/ask", "/mutate", "/breakglass", "/incident", "/ack", "/resolve", "/deploy"]);

export const TELEGRAM_COMMAND_REGISTRY = Object.freeze(Object.fromEntries(
  listTelegramCommands().map(({ bot, command, capability }) => [
    `${bot}:${command}`,
    Object.freeze({
      bot,
      command,
      capability,
      path: [APP_NAMES[bot], "Features", command.slice(1)],
      confirmation: SENSITIVE_COMMANDS.has(command) ? "required" : "none",
    }),
  ]),
));

export function resolveRegisteredTelegramCommand(command, { botKey } = {}) {
  const token = String(command ?? "").trim().split(/\s+/)[0].toLowerCase();
  if (botKey) return TELEGRAM_COMMAND_REGISTRY[`${botKey}:${token}`];
  return Object.values(TELEGRAM_COMMAND_REGISTRY).find((entry) => entry.command === token);
}

export function createTelegramCommandDispatcher({ apiBaseUrl = "", fetchImpl = fetch, requestTimeoutMs = 15_000 } = {}) {
  const baseUrl = String(apiBaseUrl).replace(/\/+$/, "");
  return Object.freeze({
    async dispatch({ botKey, command, telegramUserId, workspaceId, args = [], pathParams = {}, authToken, requestId = crypto.randomUUID() } = {}) {
      const registered = resolveRegisteredTelegramCommand(command, { botKey });
      if (!registered) {
        const error = new Error("Telegram command is not registered for this bot");
        error.code = "TELEGRAM_COMMAND_NOT_REGISTERED";
        throw error;
      }
      const capability = getCapability(registered.capability);
      if (!capability) throw new Error(`Telegram capability is not registered: ${registered.capability}`);
      let route = capability.route;
      for (const [key, value] of Object.entries(pathParams)) route = route.replace(`:${key}`, encodeURIComponent(String(value)));
      if (route.includes(":")) {
        const error = new Error("Telegram command path parameters are incomplete");
        error.code = "TELEGRAM_PATH_PARAMS_REQUIRED";
        throw error;
      }
      const url = new URL(`${route}${route.includes("?") ? "&" : "?"}source=telegram`, `${baseUrl || "http://127.0.0.1"}/`);
      if (args.length) url.searchParams.set("args", args.join(" "));
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
      try {
        const response = await fetchImpl(url, {
          method: capability.method,
          headers: {
            accept: "application/json",
            "x-request-id": requestId,
            "x-correlation-id": requestId,
            "x-telegram-bot-key": botKey,
            "x-telegram-user-id": String(telegramUserId),
            "x-workspace-id": workspaceId,
            ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
            ...(capability.method === "GET" ? {} : { "content-type": "application/json" }),
          },
          ...(capability.method === "GET" ? {} : { body: JSON.stringify({ args, source: "telegram", botKey, telegramUserId, workspaceId }) }),
          signal: controller.signal,
        });
        const body = await response.json().catch(() => ({}));
        return { status: response.status, ok: response.ok, body, requestId, capability: registered.capability };
      } finally {
        clearTimeout(timeout);
      }
    },
  });
}

export function createLayeredMenu({ bot, module, resource, actions = [], back = true } = {}) {
  if (!getBotDescriptor(bot) || typeof module !== "string" || typeof resource !== "string") throw new Error("Bot, module, and resource are required");
  if (!Array.isArray(actions) || actions.some((action) => typeof action !== "object" || typeof action.label !== "string" || typeof action.callback !== "string")) {
    throw new Error("Layered menu actions are invalid");
  }
  return {
    breadcrumb: [getBotDescriptor(bot).displayName, module, resource],
    buttons: [
      ...actions.filter((action) => action.visible !== false && action.permission !== false).map((action) => ({ text: action.label, callbackData: `action:${bot}:${module}:${resource}:${action.callback}` })),
      ...(back ? [{ text: "Back", callbackData: `back:${bot}:${module}` }] : []),
    ],
  };
}

export function createBotStartMenu({ bot, sections = [] } = {}) {
  if (!getBotDescriptor(bot)) throw new Error("Telegram bot is not registered");
  if (!Array.isArray(sections) || sections.some((section) => !section || typeof section.label !== "string" || typeof section.module !== "string")) {
    throw new Error("Telegram menu sections are invalid");
  }
  return createInlineKeyboard([sections.filter((section) => section.visible !== false && section.permission !== false).map((section) => ({
    text: section.label,
    callbackData: `menu:${bot}:${section.module}`,
  }))]);
}

export function formatTelegramError(error, { requestId } = {}) {
  const code = error?.code ?? "TELEGRAM_REQUEST_FAILED";
  const message = code === "CAPABILITY_NOT_AVAILABLE"
    ? "That action is not available yet."
    : code === "STEP_UP_REQUIRED"
      ? "Please complete the security confirmation before continuing."
      : "The request could not be completed.";
  return { text: message, code, ...(requestId ? { requestId } : {}) };
}

export function createInlineKeyboard(rows = []) {
  if (!Array.isArray(rows) || rows.some((row) => !Array.isArray(row))) throw new Error("Inline keyboard rows must be arrays");
  return { inline_keyboard: rows.map((row) => row.map((button) => {
    if (!button || typeof button.text !== "string") throw new Error("Telegram button text is required");
    return Object.freeze({ text: button.text, ...(button.callbackData ? { callback_data: button.callbackData } : {}), ...(button.url ? { url: button.url } : {}) });
  })) };
}

export function createPagination({ page = 1, hasNext = false, callbackPrefix = "page" } = {}) {
  if (!Number.isSafeInteger(page) || page < 1) throw new Error("Page must be positive");
  const buttons = [];
  if (page > 1) buttons.push({ text: "Previous", callbackData: `${callbackPrefix}:${page - 1}` });
  if (hasNext) buttons.push({ text: "Next", callbackData: `${callbackPrefix}:${page + 1}` });
  return createInlineKeyboard(buttons.length ? [buttons] : []);
}

export function createConfirmation({ action, token = crypto.randomUUID() } = {}) {
  if (typeof action !== "string" || !action.trim()) throw new Error("Confirmation action is required");
  return {
    token,
    action: action.trim(),
    keyboard: createInlineKeyboard([[{ text: "Confirm", callbackData: `confirm:${token}` }, { text: "Cancel", callbackData: `cancel:${token}` }]]),
  };
}

export function createTelegramCallback({ botKey, command, action, context = {}, secret, expiresAt = Date.now() + 300_000 } = {}) {
  const descriptor = getBotDescriptor(botKey);
  if (!descriptor || !resolveRegisteredTelegramCommand(command, { botKey }) || typeof action !== "string" || !action.trim()) {
    throw new Error("Telegram callback context is invalid");
  }
  if (!secret || typeof secret !== "string" || secret.length < 16) throw new Error("Telegram callback signing secret is required");
  const payload = Buffer.from(JSON.stringify({ botKey, command: String(command).trim().split(/\s+/)[0].toLowerCase(), action: action.trim(), context, expiresAt })).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyTelegramCallback(callbackData, { secret, now = Date.now() } = {}) {
  if (typeof callbackData !== "string" || !secret) return { valid: false, code: "INVALID_CALLBACK" };
  const [payload, signature] = callbackData.split(".");
  if (!payload || !signature) return { valid: false, code: "INVALID_CALLBACK" };
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  const actual = Buffer.from(signature);
  const wanted = Buffer.from(expected);
  if (actual.length !== wanted.length || !crypto.timingSafeEqual(actual, wanted)) return { valid: false, code: "INVALID_CALLBACK_SIGNATURE" };
  let parsed;
  try { parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return { valid: false, code: "INVALID_CALLBACK_PAYLOAD" }; }
  if (!Number.isSafeInteger(parsed.expiresAt) || parsed.expiresAt <= now) return { valid: false, code: "CALLBACK_EXPIRED" };
  if (!getBotDescriptor(parsed.botKey) || !resolveRegisteredTelegramCommand(parsed.command, { botKey: parsed.botKey })) return { valid: false, code: "CALLBACK_NOT_REGISTERED" };
  return { valid: true, ...parsed };
}

export function createTelegramCallbackGuard({ secret, now = () => Date.now() } = {}) {
  if (typeof secret !== "string" || secret.length < 16) throw new Error("Telegram callback signing secret is required");
  const consumed = new Map();
  function prune() {
    const timestamp = now();
    for (const [callback, expiresAt] of consumed) if (expiresAt <= timestamp) consumed.delete(callback);
  }
  return Object.freeze({
    consume(callbackData) {
      prune();
      const verified = verifyTelegramCallback(callbackData, { secret, now: now() });
      if (!verified.valid) return verified;
      if (consumed.has(callbackData)) return { valid: false, code: "CALLBACK_ALREADY_USED" };
      consumed.set(callbackData, verified.expiresAt);
      return { ...verified, singleUse: true };
    },
    size() {
      prune();
      return consumed.size;
    },
  });
}

export function createTelegramSession({ botKey, telegramUserId, workspaceId, ttlMs = 30 * 60 * 1000, now = Date.now() } = {}) {
  if (!getBotDescriptor(botKey) || !Number.isSafeInteger(telegramUserId) || telegramUserId < 1) throw new Error("Telegram session identity is invalid");
  if (typeof workspaceId !== "string" || !workspaceId.trim()) throw new Error("Telegram session workspace is required");
  return Object.freeze({ id: crypto.randomUUID(), botKey, telegramUserId, workspaceId, createdAt: now, expiresAt: now + ttlMs });
}

export function assertTelegramSession(session, { now = Date.now(), botKey, telegramUserId } = {}) {
  if (!session || typeof session.id !== "string" || typeof session.workspaceId !== "string" || session.expiresAt <= now || (botKey && session.botKey !== botKey) || (telegramUserId && session.telegramUserId !== telegramUserId)) {
    const error = new Error("Telegram session is expired or invalid");
    error.code = "TELEGRAM_SESSION_INVALID";
    throw error;
  }
  return session;
}

export function assertAdminTelegramOwner({ botKey, telegramUserId, verifiedTelegramNumericUserId } = {}) {
  if (botKey !== "admin" || !Number.isSafeInteger(telegramUserId) || telegramUserId < 1 || telegramUserId !== verifiedTelegramNumericUserId) {
    const error = new Error("Verified Admin Telegram owner is required");
    error.code = "ADMIN_TELEGRAM_OWNER_REQUIRED";
    throw error;
  }
  return true;
}

export function createTelegramDeepLink({ botUsername, start } = {}) {
  if (!botUsername || !start) throw new Error("Telegram bot username and start payload are required");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(start))) throw new Error("Telegram deep-link payload is invalid");
  return `https://t.me/${String(botUsername).replace(/^@/, "")}?start=${start}`;
}

export function createTelegramApiClient({ token, fetchImpl = fetch, maxAttempts = 3, baseUrl = "https://api.telegram.org" } = {}) {
  if (typeof token !== "string" || token.length < 16) throw new Error("Telegram bot token is required");
  return {
    async call(method, body = {}) {
      let lastError;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const response = await fetchImpl(`${baseUrl}/bot${token}/${method}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          const payload = await response.json().catch(() => ({}));
          if (response.ok && payload.ok) return payload.result;
          const error = new Error(payload.description ?? `Telegram API returned ${response.status}`);
          error.code = "TELEGRAM_API_ERROR";
          error.retryAfter = payload.parameters?.retry_after;
          if (response.status < 500 && response.status !== 429) throw Object.assign(error, { retryable: false });
          lastError = error;
        } catch (error) {
          lastError = error;
          if (error?.retryable === false) throw error;
          if (attempt === maxAttempts) throw error;
        }
        const retryAfterMs = Number.isSafeInteger(lastError?.retryAfter) ? lastError.retryAfter * 1_000 : 0;
        await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(250 * 2 ** (attempt - 1), retryAfterMs), 10_000)));
      }
      throw lastError;
    },
  };
}