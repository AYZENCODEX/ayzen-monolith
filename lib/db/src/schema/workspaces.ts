import { pgTable, serial, text, integer, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";

/**
 * Shared workspace boundary for the modular-monolith migration.
 *
 * `organizations` remains the existing business object. `workspaces` is the
 * stable context carried by API/Telegram requests, so personal and
 * organization workspaces can share policy and service contracts without
 * forcing every existing organization route to migrate at once.
 */
export const workspacesTable = pgTable(
  "workspaces",
  {
    id: serial("id").primaryKey(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    kind: text("kind").notNull().default("personal"), // personal | organization
    organizationId: integer("organization_id"),
    ownerUserId: integer("owner_user_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("workspaces_organization_id_idx").on(table.organizationId),
    index("workspaces_owner_user_id_idx").on(table.ownerUserId),
  ],
);

export const workspaceMembersTable = pgTable(
  "workspace_members",
  {
    id: serial("id").primaryKey(),
    workspaceId: integer("workspace_id").notNull(),
    userId: integer("user_id").notNull(),
    role: text("role").notNull().default("member"), // owner | admin | member
    status: text("status").notNull().default("active"), // active | invited | suspended
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("workspace_members_workspace_user_idx").on(table.workspaceId, table.userId),
    index("workspace_members_user_id_idx").on(table.userId),
  ],
);

export type Workspace = typeof workspacesTable.$inferSelect;
export type WorkspaceMember = typeof workspaceMembersTable.$inferSelect;
export type NewWorkspace = typeof workspacesTable.$inferInsert;
export type NewWorkspaceMember = typeof workspaceMembersTable.$inferInsert;