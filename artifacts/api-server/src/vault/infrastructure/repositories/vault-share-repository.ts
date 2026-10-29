import { ENTITY_TABLES, type FieldPermissionMap, isValidType, notTrashedClause, safe } from "./share-entity-types";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

/**
 * DB access for the Vault share route handlers, extracted verbatim from
 * routes/vault-shares.ts (VLT-GAP-10). Every statement (raw SQL text, column
 * lists, ordering, ON CONFLICT upsert) is unchanged; callers keep the
 * validation, notifications, domain events and response mapping.
 */
type EntityCfg = (typeof ENTITY_TABLES)[string];

/** `SELECT id FROM <table> WHERE id AND user_id [AND not trashed]` — rows (empty = not owned / trashed). */
export async function findOwnedEntityIdRows(cfg: EntityCfg, id: number, userId: number) {
  const ownedCheck = await db.execute(sql.raw(
    `SELECT id FROM ${cfg.table} WHERE id = ${id} AND user_id = ${userId}${notTrashedClause(cfg)}`
  ));
  return ownedCheck.rows;
}

/** Recipient lookup by username OR email. */
export async function findShareTarget(identifier: string): Promise<any> {
  const targetResult = await db.execute(sql.raw(
    `SELECT id, username FROM users WHERE username = ${safe(identifier)} OR email = ${safe(identifier)}`
  ));
  return targetResult.rows[0] as any;
}

/** Upserts a share grant (re-activates a revoked one). */
export async function upsertShareRow(input: {
  entityType: string; entityId: number; ownerId: number; sharedWithUserId: number;
  permission: string; fieldPermissions: FieldPermissionMap | null;
}): Promise<any> {
  const { entityType, entityId: id, ownerId: userId, sharedWithUserId, permission, fieldPermissions: parsedFieldPermissions } = input;
  const fieldPermsSql = safe(parsedFieldPermissions ? JSON.stringify(parsedFieldPermissions) : null);
  const result = await db.execute(sql.raw(`
      INSERT INTO vault_shares (entity_type, entity_id, owner_id, shared_with_user_id, permission, field_permissions, is_active, revoked_at)
      VALUES (${safe(entityType)}, ${id}, ${userId}, ${sharedWithUserId}, ${safe(permission)}, ${fieldPermsSql}, TRUE, NULL)
      ON CONFLICT (entity_type, entity_id, shared_with_user_id)
      DO UPDATE SET permission = ${safe(permission)}, field_permissions = ${fieldPermsSql}, is_active = TRUE, revoked_at = NULL, updated_at = NOW()
      RETURNING *
    `));
  return result.rows[0] as any;
}

/** Shares the caller granted, newest first (optionally for one entity type). */
export async function listSentShareRows(userId: number, entityType: string | undefined): Promise<any[]> {
  const q = entityType && isValidType(entityType)
    ? sql.raw(`SELECT vs.*, u.username as recipient_username FROM vault_shares vs
                 JOIN users u ON u.id = vs.shared_with_user_id
                 WHERE vs.owner_id = ${userId} AND vs.entity_type = ${safe(entityType)}
                 ORDER BY vs.created_at DESC`)
    : sql.raw(`SELECT vs.*, u.username as recipient_username FROM vault_shares vs
                 JOIN users u ON u.id = vs.shared_with_user_id
                 WHERE vs.owner_id = ${userId}
                 ORDER BY vs.created_at DESC`);
  const result = await db.execute(q);
  return result.rows as any[];
}

/** Shares granted to the caller, newest first. */
export async function listReceivedShareRows(userId: number, entityType: string | undefined, activeOnly: boolean): Promise<any[]> {
  const conditions = [`vs.shared_with_user_id = ${userId}`];
  if (activeOnly) conditions.push(`vs.is_active = TRUE`);
  if (entityType && isValidType(entityType)) conditions.push(`vs.entity_type = ${safe(entityType)}`);

  const result = await db.execute(sql.raw(
    `SELECT vs.*, u.username as owner_username FROM vault_shares vs
       JOIN users u ON u.id = vs.owner_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY vs.created_at DESC`
  ));
  return result.rows as any[];
}

/** Whole entity rows by id (used to build display labels). */
export async function listEntityRowsByIds(cfg: EntityCfg, ids: number[]): Promise<any[]> {
  const entRes = await db.execute(sql.raw(`SELECT * FROM ${cfg.table} WHERE id IN (${ids.join(",")})`));
  return entRes.rows as any[];
}

/** The caller's own (non-trashed) entity row, if any. */
export async function getOwnedEntityRows(cfg: EntityCfg, entityId: number, userId: number) {
  const ownRes = await db.execute(sql.raw(`SELECT * FROM ${cfg.table} WHERE id = ${entityId} AND user_id = ${userId}${notTrashedClause(cfg)}`));
  return ownRes.rows;
}

/** An active grant of this entity to the caller. */
export async function getActiveShareFor(entityType: string, entityId: number, userId: number): Promise<any> {
  const shareRes = await db.execute(sql.raw(
    `SELECT * FROM vault_shares WHERE entity_type = ${safe(entityType)} AND entity_id = ${entityId}
       AND shared_with_user_id = ${userId} AND is_active = TRUE`
  ));
  return shareRes.rows[0] as any;
}

/** The entity row regardless of owner (non-trashed). */
export async function getEntityRows(cfg: EntityCfg, entityId: number) {
  const entRes = await db.execute(sql.raw(`SELECT * FROM ${cfg.table} WHERE id = ${entityId}${notTrashedClause(cfg)}`));
  return entRes.rows;
}

/** Bulk update of owned shares; `sets` is the prebuilt SET fragment list. */
export async function bulkUpdateShareRows(sets: string[], cleanIds: number[], userId: number): Promise<any[]> {
  const result = await db.execute(sql.raw(
    `UPDATE vault_shares SET ${sets.join(", ")} WHERE id IN (${cleanIds.join(",")}) AND owner_id = ${userId} RETURNING *`
  ));
  return result.rows as any[];
}

/** Bulk delete of owned shares — returns the deleted id rows. */
export async function bulkDeleteShareRows(cleanIds: number[], userId: number): Promise<any[]> {
  const result = await db.execute(sql.raw(
    `DELETE FROM vault_shares WHERE id IN (${cleanIds.join(",")}) AND owner_id = ${userId} RETURNING id`
  ));
  return result.rows;
}

/** One owned share row. */
export async function getOwnedShareRow(id: number, userId: number): Promise<any> {
  const existingRes = await db.execute(sql.raw(`SELECT * FROM vault_shares WHERE id = ${id} AND owner_id = ${userId}`));
  return existingRes.rows[0] as any;
}

/** Single-share update; returns the updated rows. */
export async function updateShareRows(sets: string[], id: number, userId: number): Promise<any[]> {
  const result = await db.execute(sql.raw(
    `UPDATE vault_shares SET ${sets.join(", ")} WHERE id = ${id} AND owner_id = ${userId} RETURNING *`
  ));
  return result.rows as any[];
}

/** Single-share delete; returns the deleted id rows. */
export async function deleteShareRows(id: number, userId: number): Promise<any[]> {
  const result = await db.execute(sql.raw(
    `DELETE FROM vault_shares WHERE id = ${id} AND owner_id = ${userId} RETURNING id`
  ));
  return result.rows;
}

export function executeSqlForModule(cfg: any, id: number, userId: number) {
  return db.execute(sql.raw(
      `SELECT id FROM ${cfg.table} WHERE id = ${id} AND user_id = ${userId}${notTrashedClause(cfg)}`
    ));
}

export function executeUsersForModule(username: string) {
  return db.execute(sql.raw(
      `SELECT id, username FROM users WHERE username = ${safe(username.trim())} OR email = ${safe(username.trim())}`
    ));
}

export function executeVaultSharesForModule(entityType: string, id: number, userId: number, target: any, permission: any, fieldPermsSql: string) {
  return db.execute(sql.raw(`
      INSERT INTO vault_shares (entity_type, entity_id, owner_id, shared_with_user_id, permission, field_permissions, is_active, revoked_at)
      VALUES (${safe(entityType)}, ${id}, ${userId}, ${Number(target.id)}, ${safe(permission)}, ${fieldPermsSql}, TRUE, NULL)
      ON CONFLICT (entity_type, entity_id, shared_with_user_id)
      DO UPDATE SET permission = ${safe(permission)}, field_permissions = ${fieldPermsSql}, is_active = TRUE, revoked_at = NULL, updated_at = NOW()
      RETURNING *
    `));
}

export function executeVaultSharesForModule2(entityType: string, entityId: number, userId: number, target: any, permission: any, fieldPermsSql: string) {
  return db.execute(sql.raw(`
          INSERT INTO vault_shares (entity_type, entity_id, owner_id, shared_with_user_id, permission, field_permissions, is_active, revoked_at)
          VALUES (${safe(entityType)}, ${entityId}, ${userId}, ${Number(target.id)}, ${safe(permission)}, ${fieldPermsSql}, TRUE, NULL)
          ON CONFLICT (entity_type, entity_id, shared_with_user_id)
          DO UPDATE SET permission = ${safe(permission)}, field_permissions = ${fieldPermsSql}, is_active = TRUE, revoked_at = NULL, updated_at = NOW()
          RETURNING *
        `));
}

export function sqlVaultSharesForModule(userId: number, entityType: string) {
  return sql.raw(`SELECT vs.*, u.username as recipient_username FROM vault_shares vs
                 JOIN users u ON u.id = vs.shared_with_user_id
                 WHERE vs.owner_id = ${userId} AND vs.entity_type = ${safe(entityType)}
                 ORDER BY vs.created_at DESC`);
}

export function sqlVaultSharesForModule2(userId: number) {
  return sql.raw(`SELECT vs.*, u.username as recipient_username FROM vault_shares vs
                 JOIN users u ON u.id = vs.shared_with_user_id
                 WHERE vs.owner_id = ${userId}
                 ORDER BY vs.created_at DESC`);
}

export function executeSqlForModule3(q: any) {
  return db.execute(q);
}

export function executeSqlForModule4(cfg: any, ids: number[]) {
  return db.execute(sql.raw(`SELECT * FROM ${cfg.table} WHERE id IN (${ids.join(",")})`));
}

export function executeVaultSharesForModule3(conditions: string[]) {
  return db.execute(sql.raw(
      `SELECT vs.*, u.username as owner_username FROM vault_shares vs
       JOIN users u ON u.id = vs.owner_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY vs.created_at DESC`
    ));
}

export function executeSqlForModule6(cfg: any, entityId: number, userId: number) {
  return db.execute(sql.raw(`SELECT * FROM ${cfg.table} WHERE id = ${entityId} AND user_id = ${userId}${notTrashedClause(cfg)}`));
}

export function executeVaultSharesForModule4(entityType: string, entityId: number, userId: number) {
  return db.execute(sql.raw(
      `SELECT * FROM vault_shares WHERE entity_type = ${safe(entityType)} AND entity_id = ${entityId}
       AND shared_with_user_id = ${userId} AND is_active = TRUE`
    ));
}

export function executeSqlForModule7(cfg: any, entityId: number) {
  return db.execute(sql.raw(`SELECT * FROM ${cfg.table} WHERE id = ${entityId}${notTrashedClause(cfg)}`));
}

export function executeVaultSharesForModule5(sets: string[], cleanIds: number[], userId: number) {
  return db.execute(sql.raw(
      `UPDATE vault_shares SET ${sets.join(", ")} WHERE id IN (${cleanIds.join(",")}) AND owner_id = ${userId} RETURNING *`
    ));
}

export function executeVaultSharesForModule6(cleanIds: number[], userId: number) {
  return db.execute(sql.raw(
      `DELETE FROM vault_shares WHERE id IN (${cleanIds.join(",")}) AND owner_id = ${userId} RETURNING id`
    ));
}

export function executeVaultSharesForModule7(id: number, userId: number) {
  return db.execute(sql.raw(`SELECT * FROM vault_shares WHERE id = ${id} AND owner_id = ${userId}`));
}

export function executeVaultSharesForModule8(sets: string[], id: number, userId: number) {
  return db.execute(sql.raw(
      `UPDATE vault_shares SET ${sets.join(", ")} WHERE id = ${id} AND owner_id = ${userId} RETURNING *`
    ));
}

export function executeVaultSharesForModule9(id: number, userId: number) {
  return db.execute(sql.raw(
      `DELETE FROM vault_shares WHERE id = ${id} AND owner_id = ${userId} RETURNING id`
    ));
}

export function executeInformationSchemaForShareableColumns(cfg: any) {
  return db.execute(sql.raw(
    `SELECT column_name FROM information_schema.columns WHERE table_name = ${safe(cfg.table)} ORDER BY ordinal_position`
  ));
}

export function executeVaultSharesForVaultShareResource(id: number) {
  return db.execute(sql`SELECT owner_id FROM vault_shares WHERE id = ${id} LIMIT 1`);
}

export function executeVaultSharesForAuditVaultShareBulkOwnership(ids: number[]) {
  return db.execute(sql.raw(
    `SELECT id, owner_id FROM vault_shares WHERE id IN (${ids.join(",")})`
  ));
}

export function executeSqlForAuditVaultShareCreateOwnership(cfg: any, ids: number[]) {
  return db.execute(sql.raw(
      `SELECT id, user_id FROM ${cfg.table} WHERE id IN (${ids.join(",")})`
    ));
}
