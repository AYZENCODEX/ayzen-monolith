import { decryptRows } from "../../crypto/field-encryption";
import { decryptSeedPhrase } from "../../crypto/seed-phrase";
import { selectVault } from "../../infrastructure/repositories/entity-repository";
import { formatVaultEntry as formatRow } from "./representation";
import type { EntityResult } from "./lifecycle";
import { executeLocalAccountsForAdminGetUserVault, executeLocalAccountsForAdminListLocalAccounts, executeUsersForAdminListVaultUsers, selectUsersForAdminGetUserVault, selectVaultActivityLogForAdminVaultActivityFeed, selectVaultEntriesForAdminListEntities, selectVaultEntriesForAdminGetUserVault } from "../../infrastructure/repositories/vault-admin-repository";

/** Admin vault read models. Extracted verbatim from routes/vault.ts (VLT-GAP-01-D); admin gating stays a route middleware. */

// ─── GET /admin/vault — admin view of all entries ────────────────────────────
export async function adminListEntities(): Promise<EntityResult> {
  try {
    const entries = await selectVaultEntriesForAdminListEntities();
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
    const entries = await selectVaultEntriesForAdminListEntities();

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
    const result = await executeLocalAccountsForAdminListLocalAccounts();
    return { status: 200, body: decryptRows(result.rows as any[], ["password", "recovery_email_password", "backup_codes", "twofa", "recovery_email_twofa"]) };
  } catch (err: any) {
    return { status: 500, body: { error: "Failed to fetch local accounts", detail: err?.message } };
  }
}

// ─── GET /admin/vault/users — list of users with vault data counts ────────────
export async function adminListVaultUsers(): Promise<EntityResult> {
  try {
    const result = await executeUsersForAdminListVaultUsers();
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
      selectVaultEntriesForAdminGetUserVault(targetId),
      executeLocalAccountsForAdminGetUserVault(targetId),
      selectUsersForAdminGetUserVault(targetId),
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
    const rows = await selectVaultActivityLogForAdminVaultActivityFeed(limitNum, offset);
    return { status: 200, body: {
      entries: rows.map(({ log, username }) => ({ ...log, createdAt: log.createdAt.toISOString(), username: username ?? "Unknown" })),
      page: pageNum,
      limit: limitNum,
    } };
  } catch (err: any) {
    return { status: 500, body: { error: "Failed to fetch activity feed", detail: err?.message } };
  }
}
