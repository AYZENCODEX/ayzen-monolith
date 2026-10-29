import { pgTable, serial, text, integer, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";

/**
 * Telegram Gateway registry. Tokens and webhook secrets never live in this
 * table; only the environment-variable names are stored as operational
 * metadata.
 */
export const telegramBotsTable = pgTable(
  "telegram_bots",
  {
    id: serial("id").primaryKey(),
    botKey: text("bot_key").notNull(),
    displayName: text("display_name").notNull(),
    responsibility: text("responsibility").notNull(),
    tokenEnvVar: text("token_env_var").notNull(),
    status: text("status").notNull().default("disabled"), // disabled | active | degraded
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [uniqueIndex("telegram_bots_bot_key_idx").on(table.botKey)],
);

export const telegramUpdateReceiptsTable = pgTable(
  "telegram_update_receipts",
  {
    id: serial("id").primaryKey(),
    botKey: text("bot_key").notNull(),
    updateId: integer("update_id").notNull(),
    receivedAt: timestamp("received_at").notNull().defaultNow(),
    processedAt: timestamp("processed_at"),
    status: text("status").notNull().default("received"), // received | processed | failed
  },
  (table) => [
    uniqueIndex("telegram_update_receipts_bot_update_idx").on(table.botKey, table.updateId),
    index("telegram_update_receipts_received_at_idx").on(table.receivedAt),
  ],
);

export type TelegramBot = typeof telegramBotsTable.$inferSelect;
export type TelegramUpdateReceipt = typeof telegramUpdateReceiptsTable.$inferSelect;