/**
 * lib/module-accounts.ts — W1-P1 (req 1): per-module accounts + module user IDs (SYL-000001).
 *
 * Thin typed layer over migrations/125_module_accounts.sql. Ids are minted by the database
 * (ayzen_provision_module_account, per-module sequence), never here, so concurrent callers and
 * multiple API instances cannot collide. Provisioning is idempotent: asking twice returns the
 * same account.
 */
import { db, moduleAccountsTable, usersTable, type ModuleAccount } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { getModule, MODULES, type ModuleId } from "@ayzen/module-registry";
import { parseModuleUid } from "@ayzen/identity-context";

export type ModuleAccountSource = "backfill" | "signup" | "lazy" | "admin";

export interface ModuleAccountView {
  module: ModuleId;
  label: string;
  uidPrefix: string;
  /** null = the user has no account in this module yet (not provisioned). */
  moduleUid: string | null;
  status: ModuleAccount["status"] | null;
  createdAt: Date | null;
}

export const isModuleId = (value: unknown): value is ModuleId =>
  typeof value === "string" && getModule(value) !== null;

/** All eight modules for a user, in registry UI order, provisioned or not. */
export async function listModuleAccounts(userId: number): Promise<ModuleAccountView[]> {
  const rows = await db.select().from(moduleAccountsTable).where(eq(moduleAccountsTable.userId, userId));
  const byModule = new Map(rows.map((r) => [r.module, r]));
  return [...MODULES]
    .sort((a, b) => a.order - b.order)
    .map((m) => {
      const row = byModule.get(m.id);
      return {
        module: m.id as ModuleId,
        label: m.label,
        uidPrefix: m.uidPrefix,
        moduleUid: row?.moduleUid ?? null,
        status: (row?.status as ModuleAccount["status"] | undefined) ?? null,
        createdAt: row?.createdAt ?? null,
      };
    });
}

export async function getModuleAccount(userId: number, module: ModuleId): Promise<ModuleAccount | null> {
  const [row] = await db
    .select()
    .from(moduleAccountsTable)
    .where(and(eq(moduleAccountsTable.userId, userId), eq(moduleAccountsTable.module, module)));
  return row ?? null;
}

/** Idempotent + race-safe: returns the existing account or creates it. */
export async function provisionModuleAccount(
  userId: number,
  module: ModuleId,
  source: ModuleAccountSource = "signup",
): Promise<ModuleAccount> {
  if (!isModuleId(module)) throw new Error(`unknown module: ${String(module)}`);
  const result = await db.execute(
    sql`SELECT id, user_id AS "userId", module, module_uid AS "moduleUid", seq, status, source,
               created_at AS "createdAt", updated_at AS "updatedAt"
        FROM ayzen_provision_module_account(${userId}::int, ${module}, ${source})`,
  );
  return (result.rows as unknown as ModuleAccount[])[0];
}

export interface ModuleAccountLookup {
  account: ModuleAccount;
  user: { id: number; username: string; email: string };
}

/** Admin lookup by module uid (case-insensitive input, canonical spelling only). */
export async function findByModuleUid(rawUid: string): Promise<ModuleAccountLookup | null> {
  const uid = rawUid.trim().toUpperCase();
  if (!parseModuleUid(uid)) return null;
  const [row] = await db
    .select({ account: moduleAccountsTable, user: { id: usersTable.id, username: usersTable.username, email: usersTable.email } })
    .from(moduleAccountsTable)
    .innerJoin(usersTable, eq(usersTable.id, moduleAccountsTable.userId))
    .where(eq(moduleAccountsTable.moduleUid, uid));
  return row ?? null;
}

/** module_uid for the module whose OIDC client is `clientId`, or null (not a module client / no account). */
export async function moduleUidForOidcClient(userId: number, clientId: string): Promise<string | null> {
  const mod = MODULES.find((m) => m.oidcClientId === clientId);
  if (!mod) return null;
  return (await getModuleAccount(userId, mod.id as ModuleId))?.moduleUid ?? null;
}
