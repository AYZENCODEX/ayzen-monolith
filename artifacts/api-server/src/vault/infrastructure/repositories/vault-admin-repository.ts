// Extracted from the Vault application layer by VLT-GAP-12 (extract-method): each function is one database call chain, verbatim.
// Do not add business logic here — repositories only run queries.
import { db, usersTable, vaultActivityLogTable, vaultEntriesTable } from "@workspace/db";
import { desc, eq, sql } from "drizzle-orm";

export function selectVaultEntriesForAdminListEntities() {
  return db
      .select({ entry: vaultEntriesTable, username: usersTable.username, userEmail: usersTable.email })
      .from(vaultEntriesTable)
      .leftJoin(usersTable, eq(vaultEntriesTable.userId, usersTable.id));
}

export function executeLocalAccountsForAdminListLocalAccounts() {
  return db.execute(sql`
      SELECT la.*, u.username, u.email as user_email
      FROM local_accounts la
      LEFT JOIN users u ON la.user_id = u.id
      ORDER BY la.created_at DESC
    `);
}

export function executeUsersForAdminListVaultUsers() {
  return db.execute(sql`
      SELECT
        u.id, u.username, u.email,
        COUNT(DISTINCT ve.id)::int as entity_count,
        COUNT(DISTINCT la.id)::int as local_account_count
      FROM users u
      LEFT JOIN vault_entries ve ON ve.user_id = u.id
      LEFT JOIN local_accounts la ON la.user_id = u.id
      GROUP BY u.id, u.username, u.email
      HAVING COUNT(DISTINCT ve.id) > 0 OR COUNT(DISTINCT la.id) > 0
      ORDER BY entity_count DESC, u.username
    `);
}

export function selectVaultEntriesForAdminGetUserVault(targetId: number) {
  return db.select().from(vaultEntriesTable).where(eq(vaultEntriesTable.userId, targetId));
}

export function executeLocalAccountsForAdminGetUserVault(targetId: number) {
  return db.execute(sql`SELECT * FROM local_accounts WHERE user_id = ${targetId} ORDER BY created_at DESC`);
}

export function selectUsersForAdminGetUserVault(targetId: number) {
  return db.select().from(usersTable).where(eq(usersTable.id, targetId));
}

export function selectVaultActivityLogForAdminVaultActivityFeed(limitNum: number, offset: number) {
  return db
      .select({ log: vaultActivityLogTable, username: usersTable.username })
      .from(vaultActivityLogTable)
      .leftJoin(usersTable, eq(vaultActivityLogTable.userId, usersTable.id))
      .orderBy(desc(vaultActivityLogTable.createdAt))
      .limit(limitNum)
      .offset(offset);
}
