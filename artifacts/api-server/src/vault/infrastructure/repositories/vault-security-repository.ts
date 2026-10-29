import { db, vaultSecurityTable, AUTH_STEP_POLICIES, type AuthStepPolicy } from "@workspace/db";
import { eq } from "drizzle-orm";
import { usersTable } from "@workspace/db";

/** Auth step-up policy values + type, re-exposed so application code needs no @workspace/db import (VLT-GAP-14-B). */
export { AUTH_STEP_POLICIES };
export type { AuthStepPolicy };

export async function getRow(userId: number) {
  const rows = await db.select().from(vaultSecurityTable).where(eq(vaultSecurityTable.userId, userId)).limit(1);
  return rows[0] ?? null;
}

// ─── The upsert* helpers below are extracted verbatim (VLT-GAP-06-B) from the
// inline `if (existing) { update } else { insert }` branches that used to
// live directly in routes/vault-security.ts's handlers. Each only ever
// touches the columns named in routes/vault-security.ts's file header
// ("Changing one PIN never reads or writes the other column") — callers
// pass `rowExists` (from a prior getRow()) so this module never re-queries.

export async function upsertAuthStepPolicy(userId: number, policy: AuthStepPolicy, rowExists: boolean): Promise<void> {
  if (rowExists) {
    await db.update(vaultSecurityTable)
      .set({ authStepPolicy: policy, updatedAt: new Date() })
      .where(eq(vaultSecurityTable.userId, userId));
  } else {
    await db.insert(vaultSecurityTable).values({ userId, authStepPolicy: policy });
  }
}

export async function upsertPinHash(userId: number, column: "vaultPinHash" | "entityPinHash", hash: string, rowExists: boolean): Promise<void> {
  if (rowExists) {
    await db.update(vaultSecurityTable)
      .set({ [column]: hash, updatedAt: new Date() } as any)
      .where(eq(vaultSecurityTable.userId, userId));
  } else {
    await db.insert(vaultSecurityTable).values({ userId, [column]: hash } as any);
  }
}

export async function upsertVaultPasswordHash(userId: number, hash: string, rowExists: boolean): Promise<void> {
  if (rowExists) {
    await db.update(vaultSecurityTable)
      .set({ vaultPasswordHash: hash, updatedAt: new Date() })
      .where(eq(vaultSecurityTable.userId, userId));
  } else {
    await db.insert(vaultSecurityTable).values({ userId, vaultPasswordHash: hash });
  }
}

export async function clearVaultPasswordHash(userId: number): Promise<void> {
  await db.update(vaultSecurityTable)
    .set({ vaultPasswordHash: null, updatedAt: new Date() })
    .where(eq(vaultSecurityTable.userId, userId));
}

export async function upsertVaultTwoFaSecret(userId: number, secret: string, rowExists: boolean): Promise<void> {
  if (rowExists) {
    await db.update(vaultSecurityTable)
      .set({ vaultTwoFaSecret: secret, vaultTwoFaEnabled: false, updatedAt: new Date() })
      .where(eq(vaultSecurityTable.userId, userId));
  } else {
    await db.insert(vaultSecurityTable).values({ userId, vaultTwoFaSecret: secret, vaultTwoFaEnabled: false });
  }
}

export async function setVaultTwoFaEnabled(userId: number): Promise<void> {
  await db.update(vaultSecurityTable)
    .set({ vaultTwoFaEnabled: true, updatedAt: new Date() })
    .where(eq(vaultSecurityTable.userId, userId));
}

export async function disableVaultTwoFa(userId: number): Promise<void> {
  await db.update(vaultSecurityTable)
    .set({ vaultTwoFaEnabled: false, vaultTwoFaSecret: null, updatedAt: new Date() })
    .where(eq(vaultSecurityTable.userId, userId));
}

export async function hasVaultPin(userId: number): Promise<boolean> {
  const [row] = await db.select({ vaultPinHash: vaultSecurityTable.vaultPinHash })
    .from(vaultSecurityTable).where(eq(vaultSecurityTable.userId, userId)).limit(1);
  return !!row?.vaultPinHash;
}

export function selectUsersForSendVaultPinSetupCode(userId: number) {
  return db.select({ email: usersTable.email }).from(usersTable).where(eq(usersTable.id, userId)).limit(1);
}

export function refSqlForHashColumn() {
  return vaultSecurityTable.vaultPinHash;
}

export function refSqlForHashColumn2() {
  return vaultSecurityTable.entityPinHash;
}

export function selectUsersForSetPin(userId: number) {
  return db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
}

export function selectVaultSecurityForRequireVaultPin(userId: number) {
  return db.select({ vaultPinHash: vaultSecurityTable.vaultPinHash })
    .from(vaultSecurityTable).where(eq(vaultSecurityTable.userId, userId)).limit(1);
}
