import { pgTable, serial, text, integer, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/**
 * W1-P1: one row per (AYZEN user, module). `moduleUid` is the display/lookup id
 * (SYL-000001, ADR A1); internal foreign keys stay integers. Rows are created through the
 * ayzen_provision_module_account() SQL function (migrations/125_module_accounts.sql), which
 * allocates from the per-module sequence — do not insert here directly.
 */
export const moduleAccountsTable = pgTable(
  "module_accounts",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
    module: text("module").notNull(), // sylo|ryft|fyra|verve|skarn|warde|wisp|zynth (CHECK in SQL)
    moduleUid: text("module_uid").notNull(),
    seq: integer("seq").notNull(),
    status: text("status").notNull().default("active"), // active|suspended|closed
    source: text("source").notNull().default("signup"), // backfill|signup|lazy|admin
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("module_accounts_user_module_idx").on(table.userId, table.module),
    uniqueIndex("module_accounts_module_uid_idx").on(table.moduleUid),
    uniqueIndex("module_accounts_module_seq_idx").on(table.module, table.seq),
    index("module_accounts_user_id_idx").on(table.userId),
  ],
);

export type ModuleAccount = typeof moduleAccountsTable.$inferSelect;
