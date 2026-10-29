import { db, vaultEntriesTable, usersTable, vaultActivityLogTable } from "@workspace/db";
import { eq, sql, desc } from "drizzle-orm";
import { decryptRows } from "../../crypto/field-encryption";
import { decryptSeedPhrase } from "../../crypto/seed-phrase";
import { selectVault } from "../../infrastructure/repositories/entity-repository";
import { formatVaultEntry as formatRow } from "./representation";
import type { EntityResult } from "./lifecycle";

/** Admin vault read models. Extracted verbatim from routes/vault.ts (VLT-GAP-01-D); admin gating stays a route middleware. */

// ─── GET /admin/vault — admin view of all entries ────────────────────────────
export async function adminListEntities(): Promise<EntityResult> {
  try {
    const entries = await db
      .select({ entry: vaultEntriesTable, username: usersTable.username, userEmail: usersTable.email })
      .from(vaultEntriesTable)
      .leftJoin(usersTable, eq(vaultEntriesTable.userId, usersTable.id));
    return { status: 200, body: entries.map(({ entry, username, userEmail }) => ({
      ...formatRow(entry as unknown as Record<string, unknown>),
      username,
      userEmail,
    })) };
  } catch {
    const rows = await selectVault(0);
    return { status: 200, body: rows.map(e => formatRow(e)) };
  }
}

// ─── GET /admin/vault/full — full unencrypted vault for admin ─────────────────
export async function adminFullVault(): Promise<EntityResult> {
  try {
    const entries = await db
      .select({ entry: vaultEntriesTable, username: usersTable.username, userEmail: usersTable.email })
      .from(vaultEntriesTable)
      .leftJoin(usersTable, eq(vaultEntriesTable.userId, usersTable.id));

    const result = entries.map(({ entry, username, userEmail }) => {
      const row = formatRow(entry as unknown as Record<string, unknown>);
      // Decrypt seed phrase for admin
      const encSeed = (entry as any).encrypted_seed_phrase ?? (entry as any).encryptedSeedPhrase ?? null;
      const seedPhrase = encSeed ? (decryptSeedPhrase(encSeed as string) ?? null) : null;
      return { ...row, seedPhrase, username, userEmail };
    });

    return { status: 200, body: result };
  } catch (err: any) {
    return { status: 500, body: { error: "Failed to fetch full vault", detail: err?.message } };
  }
}

// ─── GET /admin/vault/local-accounts — all users' local accounts ──────────────
export async function adminListLocalAccounts(): Promise<EntityResult> {
  try {
    const result = await db.execute(sql`
      SELECT la.*, u.username, u.email as user_email
      FROM local_accounts la
      LEFT JOIN users u ON la.user_id = u.id
      ORDER BY la.created_at DESC
    `);
    return { status: 200, body: decryptRows(result.rows as any[], ["password", "recovery_email_password", "backup_codes", "twofa", "recovery_email_twofa"]) };
  } catch (err: any) {
    return { status: 500, body: { error: "Failed to fetch local accounts", detail: err?.message } };
  }
}

// ─── GET /admin/vault/users — list of users with vault data counts ────────────
export async function adminListVaultUsers(): Promise<EntityResult> {
  try {
    const result = await db.execute(sql`
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
    return { status: 200, body: result.rows };
  } catch (err: any) {
    return { status: 500, body: { error: "Failed to fetch vault users", detail: err?.message } };
  }
}

// ─── GET /admin/vault/users/:userId — specific user's full vault data ──────────
export async function adminGetUserVault(userIdParam: string | string[]): Promise<EntityResult> {
  const targetId = parseInt(Array.isArray(userIdParam) ? userIdParam[0] : userIdParam, 10);
  if (isNaN(targetId)) { return { status: 400, body: { error: "Invalid userId" } }; }

  try {
    const [entities, localAccounts, userInfo] = await Promise.all([
      db.select().from(vaultEntriesTable).where(eq(vaultEntriesTable.userId, targetId)),
      db.execute(sql`SELECT * FROM local_accounts WHERE user_id = ${targetId} ORDER BY created_at DESC`),
      db.select().from(usersTable).where(eq(usersTable.id, targetId)),
    ]);

    const formattedEntities = entities.map(entry => {
      const row = formatRow(entry as unknown as Record<string, unknown>);
      const encSeed = (entry as any).encryptedSeedPhrase ?? null;
      const seedPhrase = encSeed ? (decryptSeedPhrase(encSeed as string) ?? null) : null;
      return { ...row, seedPhrase };
    });

    return { status: 200, body: {
      user: userInfo[0] ? { id: userInfo[0].id, username: userInfo[0].username, email: userInfo[0].email } : null,
      entities: formattedEntities,
      localAccounts: localAccounts.rows,
    } };
  } catch (err: any) {
    return { status: 500, body: { error: "Failed to fetch user vault", detail: err?.message } };
  }
}

// ─── GET /admin/vault/activity — vault-wide audit feed (admin, paginated) ───
export async function adminVaultActivityFeed(query: Record<string, unknown>): Promise<EntityResult> {
  const { page = "1", limit = "50" } = query as Record<string, string>;
  const pageNum = Math.max(parseInt(page, 10) || 1, 1);
  const limitNum = Math.min(parseInt(limit, 10) || 50, 200);
  const offset = (pageNum - 1) * limitNum;
  try {
    const rows = await db
      .select({ log: vaultActivityLogTable, username: usersTable.username })
      .from(vaultActivityLogTable)
      .leftJoin(usersTable, eq(vaultActivityLogTable.userId, usersTable.id))
      .orderBy(desc(vaultActivityLogTable.createdAt))
      .limit(limitNum)
      .offset(offset);
    return { status: 200, body: {
      entries: rows.map(({ log, username }) => ({ ...log, createdAt: log.createdAt.toISOString(), username: username ?? "Unknown" })),
      page: pageNum,
      limit: limitNum,
    } };
  } catch (err: any) {
    return { status: 500, body: { error: "Failed to fetch activity feed", detail: err?.message } };
  }
}
