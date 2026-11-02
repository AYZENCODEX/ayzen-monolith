import { Router, type Request, type Response } from "express";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth, getRequestUser } from "../middlewares/auth";
import { TELEGRAM_BOT_REGISTRY, getTelegramBotDescriptor, type TelegramBotDescriptor } from "../lib/telegram-bot-registry";
import { telegramLinks } from "../lib/telegram-link-service";
import { sendBotMessage } from "../lib/telegram-gateway-runtime";
import { getKnownBotUsername } from "../lib/telegram-launcher";
import { getMe } from "../lib/telegram-api";
import { formatLinkCode } from "../lib/telegram-bot-links";

/**
 * Per-bot Telegram binding endpoints (Phase 4). All require a logged-in user.
 *   GET    /telegram/links
 *   POST   /telegram/bots/:botKey/link/start
 *   POST   /telegram/bots/:botKey/link/verify   { code }
 *   GET    /telegram/bots/:botKey/me
 *   PATCH  /telegram/bots/:botKey/active        { active }
 *   DELETE /telegram/bots/:botKey/link
 * AYZENX is excluded on purpose: it keeps /telegram/connect/verify, /telegram/me
 * and /telegram/disconnect (users.telegram_chat_id).
 */
const router = Router();

const FAILURE_STATUS = { LINK_CODE_INVALID: 400, CHAT_ALREADY_LINKED: 409, TOO_MANY_ATTEMPTS: 429 } as const;
const FAILURE_MESSAGE = {
  LINK_CODE_INVALID: "Invalid or expired code",
  CHAT_ALREADY_LINKED: "That Telegram chat is already linked to another AYZEN account. Send /disconnect in the bot first.",
  TOO_MANY_ATTEMPTS: "Too many invalid codes — wait a few minutes and request a new one",
} as const;

type Ctx = { userId: number; role: string; bot: TelegramBotDescriptor };

/** Validates the session user and :botKey. Sends the error response itself and returns null on failure. */
async function context(req: Request, res: Response): Promise<Ctx | null> {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return null; }
  const bot = getTelegramBotDescriptor(String(req.params.botKey));
  if (!bot) { res.status(404).json({ error: "Unknown bot", code: "TELEGRAM_BOT_NOT_FOUND" }); return null; }
  if (bot.key === "ayzenx") {
    res.status(409).json({ error: "AYZENX uses the original Telegram endpoints", code: "USE_LEGACY_TELEGRAM_ENDPOINTS" });
    return null;
  }
  if (bot.key === "admin" && authUser.role !== "admin") {
    res.status(403).json({ error: "Admin role required", code: "ADMIN_ROLE_REQUIRED" });
    return null;
  }
  return { userId: authUser.userId, role: authUser.role, bot };
}

async function botUsername(bot: TelegramBotDescriptor): Promise<string | null> {
  const known = getKnownBotUsername(bot.key);
  if (known) return known;
  const token = process.env[bot.tokenEnvVar];
  if (!token) return null;
  try { return (await getMe(token)).username ?? null; } catch { return null; }
}

const publicLink = (link: Awaited<ReturnType<typeof telegramLinks.getLink>>) => link && ({
  linked: true,
  active: link.active,
  username: link.username,
  verifiedAt: link.verifiedAt,
  lastActivityAt: link.lastActivityAt,
});

router.get("/telegram/links", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }

  const links = new Map((await telegramLinks.listLinks(authUser.userId)).map((l) => [l.botKey, l]));
  const [legacy] = await db
    .select({ telegramChatId: usersTable.telegramChatId, telegramUsername: usersTable.telegramUsername })
    .from(usersTable).where(eq(usersTable.id, authUser.userId)).limit(1);

  res.json(
    TELEGRAM_BOT_REGISTRY
      .filter((bot) => bot.key !== "admin" || authUser.role === "admin")
      .map((bot) => {
        const base = {
          botKey: bot.key,
          displayName: bot.displayName,
          responsibility: bot.responsibility,
          botConfigured: Boolean(process.env[bot.tokenEnvVar]),
          botUsername: getKnownBotUsername(bot.key),
        };
        if (bot.key === "ayzenx") {
          return { ...base, linked: Boolean(legacy?.telegramChatId), active: Boolean(legacy?.telegramChatId), username: legacy?.telegramUsername ?? null, verifiedAt: null, lastActivityAt: null, legacy: true };
        }
        const link = links.get(bot.key);
        return { ...base, linked: Boolean(link), active: link?.active ?? false, username: link?.username ?? null, verifiedAt: link?.verifiedAt ?? null, lastActivityAt: link?.lastActivityAt ?? null };
      }),
  );
});

router.post("/telegram/bots/:botKey/link/start", requireAuth, async (req, res): Promise<void> => {
  const ctx = await context(req, res);
  if (!ctx) return;
  if (!process.env[ctx.bot.tokenEnvVar]) {
    res.status(503).json({ error: `${ctx.bot.displayName} bot is not configured`, code: "TELEGRAM_BOT_NOT_CONFIGURED" });
    return;
  }
  const { code, expiresAt } = await telegramLinks.startWebLink({ userId: ctx.userId, botKey: ctx.bot.key });
  const username = await botUsername(ctx.bot);
  res.json({
    code,
    displayCode: formatLinkCode(code),
    expiresAt,
    botUsername: username,
    deepLink: username ? `https://t.me/${username}?start=${code}` : null,
  });
});

router.post("/telegram/bots/:botKey/link/verify", requireAuth, async (req, res): Promise<void> => {
  const ctx = await context(req, res);
  if (!ctx) return;
  const { code } = (req.body ?? {}) as { code?: unknown };
  if (typeof code !== "string" || !code.trim()) { res.status(400).json({ error: "code is required" }); return; }

  const result = await telegramLinks.verifyBotCodeFromWeb({ userId: ctx.userId, botKey: ctx.bot.key, code });
  if (!result.ok) {
    res.status(FAILURE_STATUS[result.code]).json({ error: FAILURE_MESSAGE[result.code], code: result.code });
    return;
  }
  void sendBotMessage(ctx.bot.key, result.link.chatId, `✅ Linked! This chat is now connected to your AYZEN account for ${ctx.bot.displayName}.`);
  res.json({ success: true, ...publicLink(result.link) });
});

router.get("/telegram/bots/:botKey/me", requireAuth, async (req, res): Promise<void> => {
  const ctx = await context(req, res);
  if (!ctx) return;
  const link = await telegramLinks.getLink(ctx.userId, ctx.bot.key);
  res.json({ botKey: ctx.bot.key, botUsername: getKnownBotUsername(ctx.bot.key), ...(publicLink(link) ?? { linked: false, active: false, username: null, verifiedAt: null, lastActivityAt: null }) });
});

router.patch("/telegram/bots/:botKey/active", requireAuth, async (req, res): Promise<void> => {
  const ctx = await context(req, res);
  if (!ctx) return;
  const { active } = (req.body ?? {}) as { active?: unknown };
  if (typeof active !== "boolean") { res.status(400).json({ error: "active (boolean) is required" }); return; }
  const link = await telegramLinks.setActive(ctx.userId, ctx.bot.key, active);
  if (!link) { res.status(404).json({ error: "This bot is not linked", code: "TELEGRAM_NOT_LINKED" }); return; }
  res.json({ success: true, ...publicLink(link) });
});

router.delete("/telegram/bots/:botKey/link", requireAuth, async (req, res): Promise<void> => {
  const ctx = await context(req, res);
  if (!ctx) return;
  const removed = await telegramLinks.unlink(ctx.userId, ctx.bot.key);
  res.json({ success: true, removed });
});

export default router;
