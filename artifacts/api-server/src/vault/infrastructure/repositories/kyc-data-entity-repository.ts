import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { safe, safeDate } from "../../domain/kyc-values";

/**
 * kyc_data_entities persistence. Extracted verbatim from
 * routes/kyc-data-entities.ts (VLT-GAP-03-B): identical raw-SQL text and
 * escaping (`safe` / `safeDate` — this table is written through sql.raw(), not
 * parameter binding). The NID number arrives here already encrypted by the
 * application layer.
 */

export interface KycDataEntityWrite {
  nidNumber: any; name: any; fatherName: any; birthDate: any;
  photo1Url: any; photo2Url: any; notes: any;
}

// A data entity is "used" iff some kyc_entries row OR some vault_entries row
// points at it via data_entity_id — same free/used pattern as
// local_accounts.vault_entry_id against vault_entries. A Data Entity isn't
// exclusive to KYC entities: a Vault Entity (e.g. an Exchange account) can
// link the very same record directly via "Link Data Entity". We compute
// this with a correlated subquery rather than a stored flag so it's always
// accurate even if a link is cleared elsewhere.
const USED_BY_KYC = `EXISTS (SELECT 1 FROM kyc_entries k WHERE k.data_entity_id = d.id)`;
const USED_BY_VAULT = `EXISTS (SELECT 1 FROM vault_entries v WHERE v.data_entity_id = d.id)`;
const USED_EXPR = `(${USED_BY_KYC} OR ${USED_BY_VAULT})`;

export function selectKycDataEntities(userId: number, status: string | null) {
  let where = `d.user_id = ${userId}`;
  if (status === "used") where += ` AND ${USED_EXPR}`;
  if (status === "unused") where += ` AND NOT ${USED_EXPR}`;
  return db.execute(sql.raw(`
      SELECT d.*, ${USED_EXPR} AS used,
        (SELECT k.id FROM kyc_entries k WHERE k.data_entity_id = d.id LIMIT 1) AS linked_kyc_entry_id,
        (SELECT k.category FROM kyc_entries k WHERE k.data_entity_id = d.id LIMIT 1) AS linked_kyc_category,
        (SELECT v.id FROM vault_entries v WHERE v.data_entity_id = d.id LIMIT 1) AS linked_vault_entry_id,
        (SELECT v.project_name FROM vault_entries v WHERE v.data_entity_id = d.id LIMIT 1) AS linked_vault_project_name
      FROM kyc_data_entities d
      WHERE ${where}
      ORDER BY d.created_at DESC
    `));
}

export function selectKycDataEntityOverview(userId: number) {
  return db.execute(sql.raw(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE ${USED_EXPR})::int AS used,
        COUNT(*) FILTER (WHERE NOT ${USED_EXPR})::int AS unused
      FROM kyc_data_entities d
      WHERE d.user_id = ${userId}
    `));
}

export function insertKycDataEntity(userId: number, w: KycDataEntityWrite) {
  return db.execute(sql.raw(`
      INSERT INTO kyc_data_entities
        (user_id, nid_number, name, father_name, birth_date, photo1_url, photo2_url, notes)
      VALUES
        (${userId}, ${safe(w.nidNumber)}, ${safe(w.name)}, ${safe(w.fatherName)},
         ${safeDate(w.birthDate)}, ${safe(w.photo1Url)}, ${safe(w.photo2Url)}, ${safe(w.notes)})
      RETURNING *
    `));
}

export function selectKycDataEntityForUser(id: number, userId: number) {
  return db.execute(sql.raw(`
      SELECT d.*, ${USED_EXPR} AS used,
        (SELECT k.id FROM kyc_entries k WHERE k.data_entity_id = d.id LIMIT 1) AS linked_kyc_entry_id,
        (SELECT k.category FROM kyc_entries k WHERE k.data_entity_id = d.id LIMIT 1) AS linked_kyc_category,
        (SELECT v.id FROM vault_entries v WHERE v.data_entity_id = d.id LIMIT 1) AS linked_vault_entry_id,
        (SELECT v.project_name FROM vault_entries v WHERE v.data_entity_id = d.id LIMIT 1) AS linked_vault_project_name
      FROM kyc_data_entities d
      WHERE d.id = ${id} AND d.user_id = ${userId} LIMIT 1
    `));
}

export function updateKycDataEntity(id: number, userId: number, w: KycDataEntityWrite) {
  return db.execute(sql.raw(`
      UPDATE kyc_data_entities SET
        nid_number = ${safe(w.nidNumber)}, name = ${safe(w.name)},
        father_name = ${safe(w.fatherName)}, birth_date = ${safeDate(w.birthDate)},
        photo1_url = ${safe(w.photo1Url)}, photo2_url = ${safe(w.photo2Url)},
        notes = ${safe(w.notes)}, updated_at = NOW()
      WHERE id = ${id} AND user_id = ${userId}
      RETURNING *
    `));
}

export function findKycEntryLinkedToDataEntity(id: number) {
  return db.execute(sql.raw(`SELECT id FROM kyc_entries WHERE data_entity_id = ${id} LIMIT 1`));
}

export function findVaultEntryLinkedToDataEntity(id: number) {
  return db.execute(sql.raw(`SELECT id FROM vault_entries WHERE data_entity_id = ${id} LIMIT 1`));
}

export function deleteKycDataEntity(id: number, userId: number) {
  return db.execute(sql.raw(`DELETE FROM kyc_data_entities WHERE id = ${id} AND user_id = ${userId}`));
}
