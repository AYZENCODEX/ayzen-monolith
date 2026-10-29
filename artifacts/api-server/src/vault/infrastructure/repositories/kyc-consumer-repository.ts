import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

/**
 * kyc_entries persistence for the consumers that used to reach into the table
 * from outside the KYC module (VLT-GAP-03-C): routes/exchange-api.ts (exchange
 * credentials read / write) and routes/projects.ts (enroll-by-KYC-entity
 * lookup). Every statement is moved verbatim from those routes — identical SQL
 * text, identical interpolation style (`sql.raw` with integer-only values for
 * the two exchange statements, parameterized `sql` for the enrollment lookup),
 * identical owner (`user_id`) scoping. Secret columns arrive here already
 * encrypted by the application layer.
 */

const safe = (v: unknown) =>
  v === null || v === undefined ? "NULL" : `'${String(v).replace(/'/g, "''")}'`;

// GET /exchange-balance/:id — the exchange credential columns of one owned KYC entry.
export async function selectKycEntryExchangeCredentials(id: number, userId: number): Promise<any> {
  return db.execute(
    sql.raw(`SELECT platform, username, name, exchange_api_key, exchange_api_secret FROM kyc_entries WHERE id = ${id} AND user_id = ${userId} LIMIT 1`)
  );
}

export type KycExchangeKeyColumn = "exchange_api_key" | "exchange_api_secret";

// PATCH /kyc-entries/:id/exchange-keys — write the (already encrypted) key pair.
export async function updateKycEntryExchangeKeys(id: number, userId: number, fields: ReadonlyArray<readonly [KycExchangeKeyColumn, unknown]>): Promise<any> {
  const setParts: string[] = fields.map(([column, value]) => `${column} = ${safe(value)}`);
  return db.execute(
    sql.raw(`UPDATE kyc_entries SET ${setParts.join(", ")}, updated_at = NOW() WHERE id = ${id} AND user_id = ${userId}`)
  );
}

// POST /projects/:id/enroll (enroll-by-KYC-entity shortcut) — the full owned row.
export async function selectKycEntryForEnrollment(kycEntryId: number, userId: number): Promise<any> {
  return db.execute(sql`SELECT * FROM kyc_entries WHERE id = ${kycEntryId} AND user_id = ${userId} LIMIT 1`);
}
