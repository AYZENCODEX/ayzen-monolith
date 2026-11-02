import { and, eq, gt, isNull, lt } from "drizzle-orm";
import { db, telegramBotLinksTable, telegramLinkCodesTable } from "@workspace/db";
import { assertTableOwnedBy } from "./service-boundaries";
import type { TelegramBotLink, TelegramLinkCodeRow, TelegramLinkStore } from "./telegram-bot-links";

assertTableOwnedBy("telegram-gateway", "telegram_bot_links");
assertTableOwnedBy("telegram-gateway", "telegram_link_codes");

const toLink = (row: typeof telegramBotLinksTable.$inferSelect): TelegramBotLink => ({
  id: row.id,
  userId: row.userId,
  botKey: row.botKey,
  chatId: row.chatId,
  telegramUserId: row.telegramUserId,
  username: row.username,
  verifiedAt: row.verifiedAt,
  active: row.active,
  lastActivityAt: row.lastActivityAt,
  createdAt: row.createdAt,
});

const isUniqueViolation = (err: unknown) => (err as { code?: string; cause?: { code?: string } })?.code === "23505" || (err as { cause?: { code?: string } })?.cause?.code === "23505";

export const drizzleTelegramLinkStore: TelegramLinkStore = {
  async insertCode(row: TelegramLinkCodeRow) {
    try {
      await db.transaction(async (tx) => {
        // Housekeeping + "one open code per owner": a new code replaces the previous one.
        await tx.delete(telegramLinkCodesTable).where(lt(telegramLinkCodesTable.expiresAt, new Date()));
        const owner = row.direction === "web" && row.userId !== null
          ? eq(telegramLinkCodesTable.userId, row.userId)
          : row.chatId !== null ? eq(telegramLinkCodesTable.chatId, row.chatId) : undefined;
        if (owner) {
          await tx.delete(telegramLinkCodesTable).where(and(
            eq(telegramLinkCodesTable.botKey, row.botKey),
            eq(telegramLinkCodesTable.direction, row.direction),
            isNull(telegramLinkCodesTable.consumedAt),
            owner,
          ));
        }
        await tx.insert(telegramLinkCodesTable).values(row);
      });
      return true;
    } catch (err) {
      if (isUniqueViolation(err)) return false;
      throw err;
    }
  },

  async consumeCode({ botKey, codeHash, direction, now }) {
    const [row] = await db
      .update(telegramLinkCodesTable)
      .set({ consumedAt: now })
      .where(and(
        eq(telegramLinkCodesTable.botKey, botKey),
        eq(telegramLinkCodesTable.codeHash, codeHash),
        eq(telegramLinkCodesTable.direction, direction),
        isNull(telegramLinkCodesTable.consumedAt),
        gt(telegramLinkCodesTable.expiresAt, now),
      ))
      .returning();
    if (!row) return null;
    return {
      botKey: row.botKey,
      codeHash: row.codeHash,
      direction: row.direction as "web" | "bot",
      userId: row.userId,
      chatId: row.chatId,
      telegramUserId: row.telegramUserId,
      username: row.username,
      expiresAt: row.expiresAt,
    };
  },

  async upsertLink(input) {
    // A chat can only ever belong to one user per bot; moving it requires /disconnect first.
    const [existing] = await db
      .select({ userId: telegramBotLinksTable.userId })
      .from(telegramBotLinksTable)
      .where(and(eq(telegramBotLinksTable.botKey, input.botKey), eq(telegramBotLinksTable.chatId, input.chatId)))
      .limit(1);
    if (existing && existing.userId !== input.userId) return { ok: false, reason: "CHAT_ALREADY_LINKED" };
    try {
      const [row] = await db
        .insert(telegramBotLinksTable)
        .values({
          userId: input.userId,
          botKey: input.botKey,
          chatId: input.chatId,
          telegramUserId: input.telegramUserId,
          username: input.username,
          verifiedAt: input.now,
          active: true,
          updatedAt: input.now,
        })
        .onConflictDoUpdate({
          target: [telegramBotLinksTable.userId, telegramBotLinksTable.botKey],
          set: { chatId: input.chatId, telegramUserId: input.telegramUserId, username: input.username, verifiedAt: input.now, active: true, updatedAt: input.now },
        })
        .returning();
      return { ok: true, link: toLink(row) };
    } catch (err) {
      if (isUniqueViolation(err)) return { ok: false, reason: "CHAT_ALREADY_LINKED" };
      throw err;
    }
  },

  async getLinkByChat(botKey, chatId) {
    const [row] = await db.select().from(telegramBotLinksTable)
      .where(and(eq(telegramBotLinksTable.botKey, botKey), eq(telegramBotLinksTable.chatId, chatId))).limit(1);
    return row ? toLink(row) : null;
  },

  async getLinkByUser(userId, botKey) {
    const [row] = await db.select().from(telegramBotLinksTable)
      .where(and(eq(telegramBotLinksTable.userId, userId), eq(telegramBotLinksTable.botKey, botKey))).limit(1);
    return row ? toLink(row) : null;
  },

  async listLinksForUser(userId) {
    const rows = await db.select().from(telegramBotLinksTable).where(eq(telegramBotLinksTable.userId, userId));
    return rows.map(toLink);
  },

  async setActive(userId, botKey, active, now) {
    const [row] = await db.update(telegramBotLinksTable)
      .set({ active, updatedAt: now })
      .where(and(eq(telegramBotLinksTable.userId, userId), eq(telegramBotLinksTable.botKey, botKey)))
      .returning();
    return row ? toLink(row) : null;
  },

  async deleteLink(userId, botKey) {
    const rows = await db.delete(telegramBotLinksTable)
      .where(and(eq(telegramBotLinksTable.userId, userId), eq(telegramBotLinksTable.botKey, botKey)))
      .returning({ id: telegramBotLinksTable.id });
    return rows.length > 0;
  },

  async deleteLinkByChat(botKey, chatId) {
    const rows = await db.delete(telegramBotLinksTable)
      .where(and(eq(telegramBotLinksTable.botKey, botKey), eq(telegramBotLinksTable.chatId, chatId)))
      .returning({ id: telegramBotLinksTable.id });
    return rows.length > 0;
  },

  async touchActivity(linkId, now) {
    await db.update(telegramBotLinksTable).set({ lastActivityAt: now }).where(eq(telegramBotLinksTable.id, linkId));
  },
};
