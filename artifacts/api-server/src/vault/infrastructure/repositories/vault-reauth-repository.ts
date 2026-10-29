import { db, usersTable, vaultSecurityTable, passkeyCredentialsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

/**
 * DB access for Vault re-auth, extracted verbatim from routes/vault-reauth.ts
 * (VLT-GAP-06-D). Queries and selected columns are unchanged.
 */

export async function getReauthStatusRow(userId: number) {
  const [row] = await db.select({
    vaultTwoFaEnabled: vaultSecurityTable.vaultTwoFaEnabled,
    vaultPasswordHash: vaultSecurityTable.vaultPasswordHash,
    vaultPinHash: vaultSecurityTable.vaultPinHash,
    authStepPolicy: vaultSecurityTable.authStepPolicy,
  }).from(vaultSecurityTable).where(eq(vaultSecurityTable.userId, userId)).limit(1);
  return row;
}

export async function listPasskeyIds(userId: number) {
  return db.select({ id: passkeyCredentialsTable.id })
    .from(passkeyCredentialsTable).where(eq(passkeyCredentialsTable.userId, userId));
}

export async function listPasskeyCredentials(userId: number) {
  return db.select().from(passkeyCredentialsTable).where(eq(passkeyCredentialsTable.userId, userId));
}

export async function getPasskeyByCredentialId(credentialId: string) {
  const [cred] = await db.select().from(passkeyCredentialsTable).where(eq(passkeyCredentialsTable.credentialId, credentialId));
  return cred;
}

export async function recordPasskeyUse(id: number, counter: number): Promise<void> {
  await db.update(passkeyCredentialsTable)
    .set({ counter, lastUsedAt: new Date() })
    .where(eq(passkeyCredentialsTable.id, id));
}

export async function getUserEmail(userId: number) {
  const [user] = await db.select({ email: usersTable.email }).from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  return user;
}

export async function getUserRow(userId: number) {
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  return user;
}

export async function getVaultPinHashRow(userId: number) {
  const [row] = await db.select({ vaultPinHash: vaultSecurityTable.vaultPinHash })
    .from(vaultSecurityTable).where(eq(vaultSecurityTable.userId, userId)).limit(1);
  return row;
}

export async function getVaultSecurityFullRow(userId: number) {
  const [row] = await db.select().from(vaultSecurityTable).where(eq(vaultSecurityTable.userId, userId)).limit(1);
  return row;
}
