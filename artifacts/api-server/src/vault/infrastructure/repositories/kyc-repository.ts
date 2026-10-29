import { db } from "@workspace/db";
import { sql, type SQL } from "drizzle-orm";
import { val, numVal } from "../../domain/kyc-values";

/**
 * kyc_entries / project_enrollments persistence. Extracted verbatim from
 * routes/kyc.ts (VLT-GAP-03-B): identical SQL text, identical parameterized
 * `sql` tagged-template style, identical value binding. Secret columns arrive
 * here already encrypted by the application layer.
 */

export interface KycEntryWrite {
  category: any; username: any; accountPassword: any; notes: any;
  email: any; emailPassword: any; account2fa: any; accountBackupCode: any;
  email2fa: any; emailBackupCode: any;
  lastLoginAt: any; accountBuyDate: any; accountCreateDate: any;
  accountBuyPrice: any; accountWorth: any; kycFollowers: any;
  emailRecovery: any; emailRecoveryPassword: any; recovery2fa: any; recoveryBackupCode: any;
  /** undefined on update = keep the stored link. */
  dataEntityId: any;
  platform: any; buyPrice: any; location: any; connection: any;
  contactNumber: any; buyDate: any;
  /** undefined on update = keep the stored flag. */
  paid: any;
  sellerName: any; socialAccount: any;
}

export interface KycEntryFilter {
  category: string | null;
  platform: string | null;
  unused: boolean;
}

// Columns pulled from the linked kyc_data_entities row (see
// vault/infrastructure/repositories/kyc-data-entity-repository.ts) — a KYC
// entity no longer stores its own nid/name/father_name/birth_date/photos, it
// links to a Data Entity for those. Aliased so existing frontend code reading
// e.g. `.name` keeps working unchanged. These are fixed, hardcoded SQL
// fragments — no request data is ever interpolated into them, so sql.raw() on
// them is safe.
const DATA_ENTITY_JOIN = sql.raw(`
  LEFT JOIN kyc_data_entities d ON d.id = k.data_entity_id
`);
const DATA_ENTITY_SELECT = sql.raw(`
  d.nid_number AS nid_number, d.name AS name, d.father_name AS father_name,
  d.birth_date AS birth_date, d.photo1_url AS photo1_url, d.photo2_url AS photo2_url
`);

// Fetch a single KYC entity (with its linked Data Entity columns) by id —
// used to re-select a row right after an INSERT/UPDATE.
export async function fetchKycEntryWithData(id: number): Promise<any> {
  const result = await db.execute(sql`
    SELECT k.*, ${DATA_ENTITY_SELECT}
    FROM kyc_entries k
    ${DATA_ENTITY_JOIN}
    WHERE k.id = ${id}
  `);
  return result.rows[0];
}

export function selectKycEntries(userId: number, f: KycEntryFilter) {
  const conditions: SQL[] = [sql`k.user_id = ${userId}`];
  if (f.category) conditions.push(sql`k.category = ${f.category}`);
  if (f.platform) conditions.push(sql`k.platform = ${f.platform}`);
  if (f.unused) conditions.push(sql`NOT EXISTS (SELECT 1 FROM project_enrollments pe WHERE pe.kyc_entry_id = k.id AND pe.status = 'active')`);
  const whereSql = sql.join(conditions, sql` AND `);
  const q = sql`
      SELECT k.*, ${DATA_ENTITY_SELECT}
      FROM kyc_entries k
      ${DATA_ENTITY_JOIN}
      WHERE ${whereSql}
      ORDER BY k.created_at DESC
    `;
  return db.execute(q);
}

export function insertKycEntry(userId: number, w: KycEntryWrite) {
  return db.execute(sql`
      INSERT INTO kyc_entries
        (user_id, category, username, account_password, notes,
         email, email_password, email_2fa, email_backup_code,
         account_2fa, account_backup_code,
         last_login_at, account_buy_date, account_create_date,
         account_buy_price, account_worth, followers,
         email_recovery, email_recovery_password, recovery_2fa, recovery_backup_code,
         data_entity_id,
         platform, buy_price, location, connection, contact_number, buy_date, paid, seller_name, social_account)
      VALUES
        (${userId}, ${val(w.category)}, ${val(w.username)}, ${val(w.accountPassword)}, ${val(w.notes)},
         ${val(w.email)}, ${val(w.emailPassword)}, ${val(w.email2fa)}, ${val(w.emailBackupCode)},
         ${val(w.account2fa)}, ${val(w.accountBackupCode)},
         ${val(w.lastLoginAt)}, ${val(w.accountBuyDate)}, ${val(w.accountCreateDate)},
         ${numVal(w.accountBuyPrice)}, ${numVal(w.accountWorth)}, ${val(w.kycFollowers)},
         ${val(w.emailRecovery)}, ${val(w.emailRecoveryPassword)}, ${val(w.recovery2fa)}, ${val(w.recoveryBackupCode)},
         ${w.dataEntityId ? numVal(w.dataEntityId) : null},
         ${val(w.platform)}, ${numVal(w.buyPrice)}, ${val(w.location)}, ${val(w.connection)},
         ${val(w.contactNumber)}, ${val(w.buyDate)}, ${!!w.paid}, ${val(w.sellerName)}, ${val(w.socialAccount)})
      RETURNING *
    `);
}

export function selectKycEntryForUser(id: number, userId: number) {
  return db.execute(sql`
      SELECT k.*, ${DATA_ENTITY_SELECT}
      FROM kyc_entries k
      ${DATA_ENTITY_JOIN}
      WHERE k.id = ${id} AND k.user_id = ${userId} LIMIT 1
    `);
}

export function updateKycEntry(id: number, userId: number, w: KycEntryWrite) {
  return db.execute(sql`
      UPDATE kyc_entries SET
        category = ${val(w.category)}, username = ${val(w.username)},
        account_password = ${val(w.accountPassword)}, notes = ${val(w.notes)},
        email = ${val(w.email)}, email_password = ${val(w.emailPassword)},
        email_2fa = ${val(w.email2fa)}, email_backup_code = ${val(w.emailBackupCode)},
        account_2fa = ${val(w.account2fa)}, account_backup_code = ${val(w.accountBackupCode)},
        last_login_at = ${val(w.lastLoginAt)}, account_buy_date = ${val(w.accountBuyDate)},
        account_create_date = ${val(w.accountCreateDate)},
        account_buy_price = ${numVal(w.accountBuyPrice)}, account_worth = ${numVal(w.accountWorth)},
        followers = ${val(w.kycFollowers)},
        email_recovery = ${val(w.emailRecovery)},
        email_recovery_password = ${val(w.emailRecoveryPassword)},
        recovery_2fa = ${val(w.recovery2fa)},
        recovery_backup_code = ${val(w.recoveryBackupCode)},
        data_entity_id = ${w.dataEntityId !== undefined ? sql`${w.dataEntityId ? numVal(w.dataEntityId) : null}` : sql`data_entity_id`},
        platform = ${val(w.platform)}, buy_price = ${numVal(w.buyPrice)},
        location = ${val(w.location)}, connection = ${val(w.connection)},
        contact_number = ${val(w.contactNumber)}, buy_date = ${val(w.buyDate)},
        paid = ${w.paid !== undefined ? sql`${!!w.paid}` : sql`paid`},
        seller_name = ${val(w.sellerName)}, social_account = ${val(w.socialAccount)},
        updated_at = NOW()
      WHERE id = ${id} AND user_id = ${userId}
      RETURNING *
    `);
}

export function updateKycEntryStatus(id: number, userId: number, status: string) {
  return db.execute(sql`
      UPDATE kyc_entries SET status = ${status}, updated_at = NOW()
      WHERE id = ${id} AND user_id = ${userId}
      RETURNING *
    `);
}

export function deleteKycEntry(id: number, userId: number) {
  return db.execute(sql`DELETE FROM kyc_entries WHERE id = ${id} AND user_id = ${userId}`);
}

// Exchange projects enrolled via a KYC Entity pick (Binance/Bitget/Kucoin/Bybit
// shortcut, no manual form) — only rows created through the KYC-entity picker
// (kyc_entry_id set); ordinary manual/"Other" enrollments (dataEntityId path)
// don't show up here, they stay on the regular Project ↔ Entity enrollment list.
export function selectKycEnrollments(userId: number) {
  return db.execute(sql`
      SELECT
        pe.id AS enrollment_id, pe.status, pe.enrolled_at,
        p.id AS project_id, p.name AS project_name, p.project_type, p.thumbnail_url,
        k.id AS kyc_entry_id, k.platform AS kyc_platform, k.username AS kyc_username,
        ve.id AS vault_entry_id, ve.project_name AS vault_entry_name
      FROM project_enrollments pe
      JOIN projects p ON p.id = pe.project_id
      JOIN kyc_entries k ON k.id = pe.kyc_entry_id
      JOIN vault_entries ve ON ve.id = pe.vault_entry_id
      WHERE pe.user_id = ${userId} AND pe.kyc_entry_id IS NOT NULL
      ORDER BY pe.enrolled_at DESC
    `);
}

// `kyc_entries` has one owner column (`user_id`) — plain single-owner
// shape, matching this file's own parameterized `sql` tagged-template
// style (not `sql.raw`).
// Exported (C19B) so exchange-api.ts's `PATCH /kyc-entries/:id/exchange-keys`
// — same `kyc_entries` table, same `user_id` owner column, previously left
// unwired when the rest of the KYC routes were gated in C19A — can
// reuse this instead of hand-rolling a second copy. Since VLT-GAP-03-C the
// consumers (exchange-api.ts, the ownership regression suite) import it from
// here directly; routes/kyc.ts no longer re-exports it.
export async function selectKycEntryOwnerRow(id: number): Promise<any> {
  const result = await db.execute(sql`SELECT user_id FROM kyc_entries WHERE id = ${id} LIMIT 1`);
  return result.rows[0] as any;
}

export function executeKycDataEntitiesForKycDataEntityResource(id: number) {
  return db.execute(sql.raw(`SELECT user_id FROM kyc_data_entities WHERE id = ${id} LIMIT 1`));
}
