import { pgTable, serial, bigserial, text, integer, boolean, timestamp, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/**
 * W1-P2: per-module credentials, AYZEN links, reset tokens and the auth audit trail
 * (migrations/126_module_credentials_sessions.sql).
 *
 * The composite foreign keys (module_account_id, module) -> module_accounts(id, module) that make the
 * database reject a row whose `module` disagrees with its account live in the SQL migration only; they
 * are deliberately not repeated here. Rows are written by lib/module-auth-service.ts (raw SQL inside a
 * transaction) — do not insert into these tables directly.
 */

/** One login credential per module account. `identifier_norm` is lower(trim(email)) and unique per module. */
export const moduleCredentialsTable = pgTable(
  "module_credentials",
  {
    id: serial("id").primaryKey(),
    moduleAccountId: integer("module_account_id").notNull(),
    module: text("module").notNull(),
    identifier: text("identifier").notNull(),
    identifierNorm: text("identifier_norm").notNull(),
    passwordHash: text("password_hash").notNull(), // PHC string, $argon2id$... (CHECK in SQL)
    passwordUpdatedAt: timestamp("password_updated_at").notNull().defaultNow(),
    identifierVerifiedAt: timestamp("identifier_verified_at"),
    failedAttempts: integer("failed_attempts").notNull().default(0),
    lockedUntil: timestamp("locked_until"),
    lastLoginAt: timestamp("last_login_at"),
    mfaEnabled: boolean("mfa_enabled").notNull().default(false),
    mfaSecret: text("mfa_secret"),
    mfaEnrolledAt: timestamp("mfa_enrolled_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("module_credentials_account_idx").on(table.moduleAccountId),
    uniqueIndex("module_credentials_module_ident_idx").on(table.module, table.identifierNorm),
  ],
);

/** How an AYZEN identity reaches a module account: backing | legacy_continue | oidc | explicit (CHECK in SQL). */
export const moduleAccountLinksTable = pgTable(
  "module_account_links",
  {
    id: serial("id").primaryKey(),
    moduleAccountId: integer("module_account_id").notNull(),
    module: text("module").notNull(),
    ayzenUserId: integer("ayzen_user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
    method: text("method").notNull(),
    linkedAt: timestamp("linked_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("module_account_links_account_user_idx").on(table.moduleAccountId, table.ayzenUserId),
    uniqueIndex("module_account_links_user_module_idx").on(table.ayzenUserId, table.module),
    index("module_account_links_account_idx").on(table.moduleAccountId),
  ],
);

/** Single-use reset tokens; only the sha256 of the emailed token is stored. */
export const modulePasswordResetsTable = pgTable(
  "module_password_resets",
  {
    id: serial("id").primaryKey(),
    moduleAccountId: integer("module_account_id").notNull(),
    module: text("module").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    usedAt: timestamp("used_at"),
    requestedIp: text("requested_ip"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("module_password_resets_token_idx").on(table.tokenHash),
    index("module_password_resets_account_idx").on(table.moduleAccountId),
  ],
);

/** Append-only audit trail: signup | login | logout | continue | password_reset_requested | password_reset_completed. */
export const moduleAuthEventsTable = pgTable(
  "module_auth_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    module: text("module").notNull(),
    moduleAccountId: integer("module_account_id"),
    event: text("event").notNull(),
    outcome: text("outcome").notNull(), // success | failure
    ip: text("ip"),
    userAgent: text("user_agent"),
    detail: jsonb("detail").notNull().default({}),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("module_auth_events_account_idx").on(table.moduleAccountId, table.createdAt),
    index("module_auth_events_module_event_idx").on(table.module, table.event, table.createdAt),
  ],
);

export type ModuleCredential = typeof moduleCredentialsTable.$inferSelect;
export type ModuleAccountLink = typeof moduleAccountLinksTable.$inferSelect;
export type ModulePasswordReset = typeof modulePasswordResetsTable.$inferSelect;
export type ModuleAuthEvent = typeof moduleAuthEventsTable.$inferSelect;
