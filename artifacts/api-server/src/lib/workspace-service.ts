import { db, organizationMembersTable, organizationsTable, usersTable, workspaceMembersTable, workspacesTable } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { assertTableOwnedBy } from "./service-boundaries";

assertTableOwnedBy("workspace", "workspaces");
assertTableOwnedBy("workspace", "workspace_members");

export type WorkspaceKind = "personal" | "organization";
export type WorkspaceRole = "owner" | "admin" | "member";

export interface WorkspaceAccess {
  id: number;
  slug: string;
  name: string;
  kind: WorkspaceKind;
  organizationId: number | null;
  role: WorkspaceRole;
  status: string;
}

function isWorkspaceKind(value: unknown): value is WorkspaceKind {
  return value === "personal" || value === "organization";
}

function slugify(value: string): string {
  const base = value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return base || "workspace";
}

export async function listWorkspacesForUser(userId: number): Promise<WorkspaceAccess[]> {
  const rows = await db
    .select({
      id: workspacesTable.id,
      slug: workspacesTable.slug,
      name: workspacesTable.name,
      kind: workspacesTable.kind,
      organizationId: workspacesTable.organizationId,
      role: workspaceMembersTable.role,
      status: workspaceMembersTable.status,
    })
    .from(workspaceMembersTable)
    .innerJoin(workspacesTable, eq(workspaceMembersTable.workspaceId, workspacesTable.id))
    .where(eq(workspaceMembersTable.userId, userId))
    .orderBy(desc(workspacesTable.updatedAt));
  return rows.filter((row): row is WorkspaceAccess => isWorkspaceKind(row.kind));
}

export async function getWorkspaceAccess(workspaceId: number, userId: number): Promise<WorkspaceAccess | null> {
  const [row] = await db
    .select({
      id: workspacesTable.id,
      slug: workspacesTable.slug,
      name: workspacesTable.name,
      kind: workspacesTable.kind,
      organizationId: workspacesTable.organizationId,
      role: workspaceMembersTable.role,
      status: workspaceMembersTable.status,
    })
    .from(workspaceMembersTable)
    .innerJoin(workspacesTable, eq(workspaceMembersTable.workspaceId, workspacesTable.id))
    .where(and(eq(workspaceMembersTable.workspaceId, workspaceId), eq(workspaceMembersTable.userId, userId)));
  if (!row || !isWorkspaceKind(row.kind)) return null;
  return {
    ...row,
    kind: row.kind,
    role: row.role as WorkspaceRole,
  };
}

export async function createWorkspace(input: {
  userId: number;
  name: string;
  kind: WorkspaceKind;
}): Promise<WorkspaceAccess> {
  const name = input.name.trim();
  if (!name) throw new Error("Workspace name is required");
  if (!isWorkspaceKind(input.kind)) throw new Error("Workspace kind must be personal or organization");

  const [user] = await db.select({ username: usersTable.username }).from(usersTable).where(eq(usersTable.id, input.userId));
  if (!user) throw new Error("User not found");

  return db.transaction(async (tx) => {
    let organizationId: number | null = null;
    if (input.kind === "organization") {
      const [organization] = await tx
        .insert(organizationsTable)
        .values({ name, ownerId: input.userId })
        .returning({ id: organizationsTable.id });
      organizationId = organization.id;
    }

    const slug = `${slugify(name)}-${randomUUID().slice(0, 8)}`;
    const [workspace] = await tx
      .insert(workspacesTable)
      .values({
        slug,
        name,
        kind: input.kind,
        organizationId,
        ownerUserId: input.userId,
      })
      .returning();
    await tx.insert(workspaceMembersTable).values({
      workspaceId: workspace.id,
      userId: input.userId,
      role: "owner",
      status: "active",
    });

    if (organizationId !== null) {
      await tx.insert(organizationMembersTable).values({
        organizationId,
        userId: input.userId,
        role: "owner",
        status: "active",
      });
    }

    return {
      id: workspace.id,
      slug: workspace.slug,
      name: workspace.name,
      kind: input.kind,
      organizationId,
      role: "owner",
      status: "active",
    };
  });
}