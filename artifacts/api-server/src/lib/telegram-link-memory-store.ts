import type { TelegramBotLink, TelegramLinkCodeRow, TelegramLinkStore } from "./telegram-bot-links";

/** In-memory TelegramLinkStore with the same semantics as the Drizzle one. For tests only. */
export function createMemoryLinkStore(): TelegramLinkStore & { links: TelegramBotLink[]; codes: Array<TelegramLinkCodeRow & { consumedAt: Date | null }> } {
  const links: TelegramBotLink[] = [];
  const codes: Array<TelegramLinkCodeRow & { consumedAt: Date | null }> = [];
  let nextId = 1;
  return {
    links,
    codes,
    async insertCode(row) {
      if (codes.some((c) => c.botKey === row.botKey && c.codeHash === row.codeHash)) return false;
      for (let i = codes.length - 1; i >= 0; i -= 1) {
        const c = codes[i];
        const sameOwner = row.direction === "web" ? c.userId === row.userId : c.chatId === row.chatId;
        if (c.botKey === row.botKey && c.direction === row.direction && c.consumedAt === null && sameOwner) codes.splice(i, 1);
      }
      codes.push({ ...row, consumedAt: null });
      return true;
    },
    async consumeCode({ botKey, codeHash, direction, now }) {
      const c = codes.find((x) => x.botKey === botKey && x.codeHash === codeHash && x.direction === direction && x.consumedAt === null && x.expiresAt > now);
      if (!c) return null;
      c.consumedAt = now;
      return { ...c };
    },
    async upsertLink(input) {
      const owner = links.find((l) => l.botKey === input.botKey && l.chatId === input.chatId);
      if (owner && owner.userId !== input.userId) return { ok: false, reason: "CHAT_ALREADY_LINKED" };
      const existing = links.find((l) => l.botKey === input.botKey && l.userId === input.userId);
      if (existing) {
        Object.assign(existing, { chatId: input.chatId, telegramUserId: input.telegramUserId, username: input.username, verifiedAt: input.now, active: true });
        return { ok: true, link: { ...existing } };
      }
      const link: TelegramBotLink = { id: nextId++, userId: input.userId, botKey: input.botKey, chatId: input.chatId, telegramUserId: input.telegramUserId, username: input.username, verifiedAt: input.now, active: true, lastActivityAt: null, createdAt: input.now };
      links.push(link);
      return { ok: true, link: { ...link } };
    },
    async getLinkByChat(botKey, chatId) { const l = links.find((x) => x.botKey === botKey && x.chatId === chatId); return l ? { ...l } : null; },
    async getLinkByUser(userId, botKey) { const l = links.find((x) => x.userId === userId && x.botKey === botKey); return l ? { ...l } : null; },
    async listLinksForUser(userId) { return links.filter((l) => l.userId === userId).map((l) => ({ ...l })); },
    async setActive(userId, botKey, active) { const l = links.find((x) => x.userId === userId && x.botKey === botKey); if (!l) return null; l.active = active; return { ...l }; },
    async deleteLink(userId, botKey) { const i = links.findIndex((x) => x.userId === userId && x.botKey === botKey); if (i < 0) return false; links.splice(i, 1); return true; },
    async deleteLinkByChat(botKey, chatId) { const i = links.findIndex((x) => x.botKey === botKey && x.chatId === chatId); if (i < 0) return false; links.splice(i, 1); return true; },
    async touchActivity(linkId, now) { const l = links.find((x) => x.id === linkId); if (l) l.lastActivityAt = now; },
  };
}
