import { pgTable, serial, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";

/**
 * Operational metadata for the modular-monolith → service extraction path.
 * These rows describe ownership; they are not a substitute for a network
 * boundary and never grant database access.
 */
export const serviceRegistryTable = pgTable(
  "service_registry",
  {
    id: serial("id").primaryKey(),
    serviceKey: text("service_key").notNull(),
    displayName: text("display_name").notNull(),
    basePath: text("base_path").notNull(),
    ownerSchema: text("owner_schema").notNull().default("public"),
    status: text("status").notNull().default("modular_monolith"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [uniqueIndex("service_registry_service_key_idx").on(table.serviceKey)],
);

export const serviceTableOwnershipTable = pgTable(
  "service_table_ownership",
  {
    id: serial("id").primaryKey(),
    serviceKey: text("service_key").notNull(),
    tableName: text("table_name").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("service_table_ownership_service_table_idx").on(table.serviceKey, table.tableName),
    index("service_table_ownership_table_name_idx").on(table.tableName),
  ],
);

export type ServiceRegistryRow = typeof serviceRegistryTable.$inferSelect;
export type ServiceTableOwnershipRow = typeof serviceTableOwnershipTable.$inferSelect;