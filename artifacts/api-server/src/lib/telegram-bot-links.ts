/**
 * Per-bot Telegram account binding (Phase 4).
 *
 * One AYZEN user can link each module bot separately. A link ties
 * (user, bot) <-> (Telegram chat, Telegram user) and can be switched off
 * without unlinking. Two code directions exist, both single-use and 10 min:
 *
 *   web -> bot : Settings calls link/start, user opens t.me/<bot>?start=<code>
 *                and the bot claims the code for that chat.
 *   bot -> web : user sends /connect to the bot, then enters the code in
 *                Settings (link/verify).
 *
 * This file is pure logic over a LinkStore so it is unit-testable without a
 * database. The Drizzle implementation is lib/telegram-bot-links-store.ts.
 * AYZENX keeps its legacy single link in users.telegram_chat_id.
 */
import crypto from "node:crypto";

export const LINK_CODE_TTL_MS = 10 * 60 * 1000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 symbols, no 0/O/1/I
const CODE_LENGTH = 8; // 40 bits

export interface TelegramBotLink {
  id: number;
  userId: number;
  botKey: string;
  chatId: string;
  telegramUserId: string;
  username: string | null;
  verifiedAt: Date;
  active: boolean;
  lastActivityAt: Date | null;
  createdAt: Date;
}

export interface TelegramLinkCodeRow {
  botKey: string;
  codeHash: string;
  direction: "web" | "bot";
  userId: number | null;
  chatId: string | null;
  telegramUserId: string | null;
  username: string | null;
  expiresAt: Date;
}

export interface UpsertLinkInput {
  userId: number;
  botKey: string;
  chatId: string;
  telegramUserId: string;
  username: string | null;
  now: Date;
}

export interface TelegramLinkStore {
  /** Inserts a code, replacing any still-open code for the same owner. Returns false on a code-hash collision. */
  insertCode(row: TelegramLinkCodeRow): Promise<boolean>;
  /** Atomically consumes an unexpired, unconsumed code. */
  consumeCode(input: { botKey: string; codeHash: string; direction: "web" | "bot"; now: Date }): Promise<TelegramLinkCodeRow | null>;
  /** Creates/updates the (user, bot) link. Fails when the chat already belongs to another user. */
  upsertLink(input: UpsertLinkInput): Promise<{ ok: true; link: TelegramBotLink } | { ok: false; reason: "CHAT_ALREADY_LINKED" }>;
  getLinkByChat(botKey: string, chatId: string): Promise<TelegramBotLink | null>;
  getLinkByUser(userId: number, botKey: string): Promise<TelegramBotLink | null>;
  listLinksForUser(userId: number): Promise<TelegramBotLink[]>;
  setActive(userId: number, botKey: string, active: boolean, now: Date): Promise<TelegramBotLink | null>;
  deleteLink(userId: number, botKey: string): Promise<boolean>;
  deleteLinkByChat(botKey: string, chatId: string): Promise<boolean>;
  touchActivity(linkId: number, now: Date): Promise<void>;
}

export type LinkFailureCode = "LINK_CODE_INVALID" | "CHAT_ALREADY_LINKED" | "TOO_MANY_ATTEMPTS";
export type LinkResult = { ok: true; link: TelegramBotLink } | { ok: false; code: LinkFailureCode };
export type ChatResolution =
  | { kind: "linked"; link: TelegramBotLink }
  | { kind: "inactive"; link: TelegramBotLink }
  | { kind: "unlinked" };

export function normalizeLinkCode(raw: string): string {
  return String(raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function hashLinkCode(botKey: string, code: string): string {
  return crypto.createHash("sha256").update(`${botKey}:${normalizeLinkCode(code)}`).digest("hex");
}

export function generateLinkCode(randomInt: (max: number) => number = (max) => crypto.randomInt(max)): string {
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i += 1) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

export function formatLinkCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** Sliding-window failure counter: blocks guessing once `max` failures hit within `windowMs`. */
export function createAttemptLimiter({ max, windowMs, now = () => Date.now() }: { max: number; windowMs: number; now?: () => number }) {
  const failures = new Map<string, number[]>();
  const recent = (key: string) => {
    const cutoff = now() - windowMs;
    const list = (failures.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length) failures.set(key, list); else failures.delete(key);
    return list;
  };
  return {
    blocked: (key: string) => recent(key).length >= max,
    fail: (key: string) => { failures.set(key, [...recent(key), now()]); },
    reset: (key: string) => { failures.delete(key); },
  };
}

export interface TelegramLinkServiceDeps {
  store: TelegramLinkStore;
  now?: () => Date;
  randomInt?: (max: number) => number;
}

export function createTelegramLinkService({ store, now = () => new Date(), randomInt }: TelegramLinkServiceDeps) {
  const limiter = createAttemptLimiter({ max: 8, windowMs: LINK_CODE_TTL_MS, now: () => now().getTime() });

  async function issueCode(row: Omit<TelegramLinkCodeRow, "codeHash" | "expiresAt">): Promise<{ code: string; expiresAt: Date }> {
    const expiresAt = new Date(now().getTime() + LINK_CODE_TTL_MS);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = generateLinkCode(randomInt);
      if (await store.insertCode({ ...row, codeHash: hashLinkCode(row.botKey, code), expiresAt })) return { code, expiresAt };
    }
    throw new Error("Could not allocate a unique link code");
  }

  return {
    /** Web side, step 1: user asked to connect. Code is claimed by the bot via /start <code>. */
    startWebLink: (input: { userId: number; botKey: string }) =>
      issueCode({ botKey: input.botKey, direction: "web", userId: input.userId, chatId: null, telegramUserId: null, username: null }),

    /** Bot side: /start <code> from a private chat. */
    async claimWebCodeFromBot(input: { botKey: string; code: string; chatId: string; telegramUserId: string; username: string | null }): Promise<LinkResult> {
      const limitKey = `bot-claim:${input.botKey}:${input.telegramUserId}`;
      if (limiter.blocked(limitKey)) return { ok: false, code: "TOO_MANY_ATTEMPTS" };
      const row = await store.consumeCode({ botKey: input.botKey, codeHash: hashLinkCode(input.botKey, input.code), direction: "web", now: now() });
      if (!row || row.userId === null) { limiter.fail(limitKey); return { ok: false, code: "LINK_CODE_INVALID" }; }
      limiter.reset(limitKey);
      const result = await store.upsertLink({ userId: row.userId, botKey: input.botKey, chatId: input.chatId, telegramUserId: input.telegramUserId, username: input.username, now: now() });
      return result.ok ? { ok: true, link: result.link } : { ok: false, code: result.reason };
    },

    /** Bot side: /connect. The code is entered in Settings by the logged-in user. */
    startBotLink: (input: { botKey: string; chatId: string; telegramUserId: string; username: string | null }) =>
      issueCode({ botKey: input.botKey, direction: "bot", userId: null, chatId: input.chatId, telegramUserId: input.telegramUserId, username: input.username }),

    /** Web side: logged-in user submits the code the bot showed. */
    async verifyBotCodeFromWeb(input: { userId: number; botKey: string; code: string }): Promise<LinkResult> {
      const limitKey = `web-verify:${input.botKey}:${input.userId}`;
      if (limiter.blocked(limitKey)) return { ok: false, code: "TOO_MANY_ATTEMPTS" };
      const row = await store.consumeCode({ botKey: input.botKey, codeHash: hashLinkCode(input.botKey, input.code), direction: "bot", now: now() });
      if (!row || row.chatId === null || row.telegramUserId === null) { limiter.fail(limitKey); return { ok: false, code: "LINK_CODE_INVALID" }; }
      limiter.reset(limitKey);
      const result = await store.upsertLink({ userId: input.userId, botKey: input.botKey, chatId: row.chatId, telegramUserId: row.telegramUserId, username: row.username, now: now() });
      return result.ok ? { ok: true, link: result.link } : { ok: false, code: result.reason };
    },

    /**
     * chat -> user lookup used by every adapter call. The sender must be the
     * Telegram user who completed the link, so a forwarded or shared chat id
     * cannot borrow someone else's identity.
     */
    async resolveChat(input: { botKey: string; chatId: string; telegramUserId: string }): Promise<ChatResolution> {
      const link = await store.getLinkByChat(input.botKey, input.chatId);
      if (!link || link.telegramUserId !== input.telegramUserId) return { kind: "unlinked" };
      if (!link.active) return { kind: "inactive", link };
      await store.touchActivity(link.id, now());
      return { kind: "linked", link };
    },

    getLink: (userId: number, botKey: string) => store.getLinkByUser(userId, botKey),
    listLinks: (userId: number) => store.listLinksForUser(userId),
    setActive: (userId: number, botKey: string, active: boolean) => store.setActive(userId, botKey, active, now()),
    unlink: (userId: number, botKey: string) => store.deleteLink(userId, botKey),
    unlinkChat: (botKey: string, chatId: string) => store.deleteLinkByChat(botKey, chatId),
  };
}

export type TelegramLinkService = ReturnType<typeof createTelegramLinkService>;
