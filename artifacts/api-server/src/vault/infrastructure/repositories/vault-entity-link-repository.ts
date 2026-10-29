// Extracted from the Vault application layer by VLT-GAP-12 (extract-method): each function is one database call chain, verbatim.
// Do not add business logic here — repositories only run queries.
import { db, vaultEntityLinksTable, vaultEntriesTable } from "@workspace/db";
import { and, eq, inArray, or, sql } from "drizzle-orm";

/** Insert shape of vault_entity_links, exposed so application code needs no @workspace/db import (VLT-GAP-14-B). */
export type VaultEntityLinkInsert = typeof vaultEntityLinksTable.$inferInsert;

export function selectVaultEntriesForOwnsEntity(id: number, userId: number) {
  return db.select({
    id: vaultEntriesTable.id,
    projectName: vaultEntriesTable.projectName,
    username: vaultEntriesTable.username,
    category: vaultEntriesTable.category,
    entitySerial: vaultEntriesTable.entitySerial,
    status: vaultEntriesTable.status,
  }).from(vaultEntriesTable).where(and(
    eq(vaultEntriesTable.id, id),
    eq(vaultEntriesTable.userId, userId),
    sql`${vaultEntriesTable.deletedAt} IS NULL`,
  ));
}

export function selectVaultEntityLinksForListEntityLinks(userId: number, id: number) {
  return db.select().from(vaultEntityLinksTable).where(
      and(
        eq(vaultEntityLinksTable.userId, userId),
        or(eq(vaultEntityLinksTable.entityId, id), eq(vaultEntityLinksTable.linkedEntityId, id))
      )
    );
}

export function selectVaultEntriesForListEntityLinks(userId: number, counterpartIds: number[]) {
  return db.select({
          id: vaultEntriesTable.id,
          projectName: vaultEntriesTable.projectName,
          username: vaultEntriesTable.username,
          category: vaultEntriesTable.category,
          status: vaultEntriesTable.status,
        }).from(vaultEntriesTable).where(and(eq(vaultEntriesTable.userId, userId), inArray(vaultEntriesTable.id, counterpartIds)));
}

export function selectVaultEntityLinksForCreateEntityLink(userId: number, entityId: number, linkedEntityId: number) {
  return db.select().from(vaultEntityLinksTable).where(
      and(
        eq(vaultEntityLinksTable.userId, userId),
        or(
          and(eq(vaultEntityLinksTable.entityId, entityId), eq(vaultEntityLinksTable.linkedEntityId, linkedEntityId)),
          and(eq(vaultEntityLinksTable.entityId, linkedEntityId), eq(vaultEntityLinksTable.linkedEntityId, entityId))
        )
      )
    );
}

export function insertVaultEntityLinksForCreateEntityLink(userId: number, entityId: number, linkedEntityId: number, relationType: any, note: any) {
  return db.insert(vaultEntityLinksTable).values({
      userId, entityId, linkedEntityId, relationType, note: note ? String(note).trim() || null : null,
    }).returning();
}

export function updateVaultEntityLinksForUpdateEntityLink(updates: any, id: number, userId: number) {
  return db.update(vaultEntityLinksTable).set(updates)
      .where(and(eq(vaultEntityLinksTable.id, id), eq(vaultEntityLinksTable.userId, userId)))
      .returning();
}

export function deleteVaultEntityLinksForDeleteEntityLink(id: number, userId: number) {
  return db.delete(vaultEntityLinksTable)
      .where(and(eq(vaultEntityLinksTable.id, id), eq(vaultEntityLinksTable.userId, userId)))
      .returning({ id: vaultEntityLinksTable.id });
}

export function executeApiForListAllEntityLinks(userId: number) {
  return db.execute(
      // Raw SQL — the Drizzle ORM join API requires declared FKs which this
      // table intentionally omits (see schema comment). Aliases disambiguate
      // the two vault_entries joins.
      sql.raw(`
        SELECT vel.id, vel.entity_id, vel.linked_entity_id, vel.relation_type, vel.note, vel.created_at,
               e1.project_name   AS entity_name,       e1.category AS entity_category,       e1.entity_serial,
               e2.project_name   AS linked_entity_name, e2.category AS linked_entity_category, e2.entity_serial AS linked_entity_serial
        FROM vault_entity_links vel
        JOIN vault_entries e1 ON e1.id = vel.entity_id
        JOIN vault_entries e2 ON e2.id = vel.linked_entity_id
        WHERE vel.user_id = ${userId}
        ORDER BY vel.created_at DESC
      `)
    );
}
