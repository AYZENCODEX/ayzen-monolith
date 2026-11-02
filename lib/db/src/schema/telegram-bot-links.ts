import { pgTable, serial, text, integer, boolean, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/**
 * Per-user, per-bot Telegram binding (Phase 4). AYZENX keeps its legacy link in
 * users.telegram_chat_id; the module bots (warde, verve, ryft, fyra, sylo,
 * skarn, zynth, wisp, admin) use this table. Tokens never live here.
 */
export const telegramBotLinksTable = pgTable(
  "telegram_bot_links",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
    botKey: text("bot_key").notNull(),
    chatId: text("chat_id").notNull(),
    telegramUserId: text("telegram_user_id").notNull(),
    username: text("username"),
    verifiedAt: timestamp("verified_at").notNull().defaultNow(),
    active: boolean("active").notNull().default(true),
    lastActivityAt: timestamp("last_activity_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("telegram_bot_links_user_bot_idx").on(table.userId, table.botKey),
    uniqueIndex("telegram_bot_links_bot_chat_idx").on(table.botKey, table.chatId),
    index("telegram_bot_links_user_id_idx").on(table.userId),
  ],
);

/** Single-use link codes. Only a SHA-256 hash of the code is stored. */
export const telegramLinkCodesTable = pgTable(
  "telegram_link_codes",
  {
    id: serial("id").primaryKey(),
    botKey: text("bot_key").notNull(),
    codeHash: text("code_hash").notNull(),
    direction: text("direction").notNull(), // web (user started) | bot (bot /connect)
    userId: integer("user_id").references(() => usersTable.id, { onDelete: "cascade" }),
    chatId: text("chat_id"),
    telegramUserId: text("telegram_user_id"),
    username: text("username"),
    expiresAt: timestamp("expires_at").notNull(),
    consumedAt: timestamp("consumed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("telegram_link_codes_bot_hash_idx").on(table.botKey, table.codeHash),
    index("telegram_link_codes_expires_idx").on(table.expiresAt),
  ],
);

export type TelegramBotLinkRow = typeof telegramBotLinksTable.$inferSelect;
export type TelegramLinkCodeRecord = typeof telegramLinkCodesTable.$inferSelect;
