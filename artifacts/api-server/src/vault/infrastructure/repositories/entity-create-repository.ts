// Extracted from the Vault application layer by VLT-GAP-12 (extract-method): each function is one database call chain, verbatim.
// Do not add business logic here — repositories only run queries.
import { db, vaultEntriesTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { encryptField } from "../../crypto/field-encryption";

export function insertVaultEntriesForCreateEntity(baseValues: Record<string, unknown>, encryptedSeedPhrase: string | null, username: any, accountPassword: any, email2fa: any, emailBackupCode: any, recovery2fa: any, recoveryBackupCode: any, lastLoginAt: any, buyDate: any, createDate: any, emailRecovery: any, emailRecoveryPassword: any, twitterEmail: any, twitterEmailPassword: any, twitterFollowers: any, twitter2fa: any, twitterEmailRecovery: any, twitterEmailRecoveryPassword: any, twitterAge: any, twitterWorth: any, twitterBuyValue: any, twitterLastLoginAt: any, twitterBuyDate: any, twitterCreateDate: any, twitterNotes: any, discordEmail: any, discordEmailPassword: any, discord2fa: any, discordEmailRecovery: any, discordEmailRecoveryPassword: any, discordFollowers: any, discordAge: any, discordWorth: any, discordBuyValue: any, discordLastLoginAt: any, discordBuyDate: any, discordCreateDate: any, discordNotes: any, telegramPhone: any, telegram2fa: any, telegramLinkedEmail: any, telegramLinkedEmailPassword: any, telegramAge: any, telegramWorth: any, telegramBuyValue: any, telegramFollowers: any, telegramLastLoginAt: any, telegramBuyDate: any, telegramCreateDate: any, telegramNotes: any, account2fa: any, accountBackupCode: any, twitterAccountBackupCode: any, twitterEmail2fa: any, twitterEmailBackupCode: any, twitterRecovery2fa: any, twitterRecoveryBackupCode: any, discordAccountBackupCode: any, discordEmail2fa: any, discordEmailBackupCode: any, discordRecovery2fa: any, discordRecoveryBackupCode: any, telegramAccountBackupCode: any, telegramEmail2fa: any, telegramEmailBackupCode: any, telegramRecovery2fa: any, telegramRecoveryBackupCode: any, dataEntityId: any) {
  return db.insert(vaultEntriesTable).values({
      ...baseValues,
      encryptedSeedPhrase,
      username: username || null,
      accountPassword: encryptField(accountPassword || null),
      email2fa: encryptField(email2fa || null),
      emailBackupCode: encryptField(emailBackupCode || null),
      recovery2fa: encryptField(recovery2fa || null),
      recoveryBackupCode: encryptField(recoveryBackupCode || null),
      lastLoginAt: lastLoginAt ? new Date(lastLoginAt) : null,
      buyDate: buyDate ? new Date(buyDate) : null,
      createDate: createDate ? new Date(createDate) : null,
      emailRecovery: emailRecovery || null,
      emailRecoveryPassword: encryptField(emailRecoveryPassword || null),
      twitterEmail: twitterEmail || null,
      twitterEmailPassword: encryptField(twitterEmailPassword || null),
      twitterFollowers: twitterFollowers || null,
      twitter2fa: encryptField(twitter2fa || null),
      twitterEmailRecovery: twitterEmailRecovery || null,
      twitterEmailRecoveryPassword: encryptField(twitterEmailRecoveryPassword || null),
      twitterAge: twitterAge || null,
      twitterWorth: twitterWorth || null,
      twitterBuyValue: twitterBuyValue || null,
      twitterLastLoginAt: twitterLastLoginAt ? new Date(twitterLastLoginAt) : null,
      twitterBuyDate: twitterBuyDate ? new Date(twitterBuyDate) : null,
      twitterCreateDate: twitterCreateDate ? new Date(twitterCreateDate) : null,
      twitterNotes: twitterNotes || null,
      discordEmail: discordEmail || null,
      discordEmailPassword: encryptField(discordEmailPassword || null),
      discord2fa: encryptField(discord2fa || null),
      discordEmailRecovery: discordEmailRecovery || null,
      discordEmailRecoveryPassword: encryptField(discordEmailRecoveryPassword || null),
      discordFollowers: discordFollowers || null,
      discordAge: discordAge || null,
      discordWorth: discordWorth || null,
      discordBuyValue: discordBuyValue || null,
      discordLastLoginAt: discordLastLoginAt ? new Date(discordLastLoginAt) : null,
      discordBuyDate: discordBuyDate ? new Date(discordBuyDate) : null,
      discordCreateDate: discordCreateDate ? new Date(discordCreateDate) : null,
      discordNotes: discordNotes || null,
      telegramPhone: telegramPhone || null,
      telegram2fa: encryptField(telegram2fa || null),
      telegramLinkedEmail: telegramLinkedEmail || null,
      telegramLinkedEmailPassword: encryptField(telegramLinkedEmailPassword || null),
      telegramAge: telegramAge || null,
      telegramWorth: telegramWorth || null,
      telegramBuyValue: telegramBuyValue || null,
      telegramFollowers: telegramFollowers || null,
      telegramLastLoginAt: telegramLastLoginAt ? new Date(telegramLastLoginAt) : null,
      telegramBuyDate: telegramBuyDate ? new Date(telegramBuyDate) : null,
      telegramCreateDate: telegramCreateDate ? new Date(telegramCreateDate) : null,
      telegramNotes: telegramNotes || null,
      account2fa: encryptField(account2fa || null),
      accountBackupCode: encryptField(accountBackupCode || null),
      twitterAccountBackupCode: encryptField(twitterAccountBackupCode || null),
      twitterEmail2fa: encryptField(twitterEmail2fa || null),
      twitterEmailBackupCode: encryptField(twitterEmailBackupCode || null),
      twitterRecovery2fa: encryptField(twitterRecovery2fa || null),
      twitterRecoveryBackupCode: encryptField(twitterRecoveryBackupCode || null),
      discordAccountBackupCode: encryptField(discordAccountBackupCode || null),
      discordEmail2fa: encryptField(discordEmail2fa || null),
      discordEmailBackupCode: encryptField(discordEmailBackupCode || null),
      discordRecovery2fa: encryptField(discordRecovery2fa || null),
      discordRecoveryBackupCode: encryptField(discordRecoveryBackupCode || null),
      telegramAccountBackupCode: encryptField(telegramAccountBackupCode || null),
      telegramEmail2fa: encryptField(telegramEmail2fa || null),
      telegramEmailBackupCode: encryptField(telegramEmailBackupCode || null),
      telegramRecovery2fa: encryptField(telegramRecovery2fa || null),
      telegramRecoveryBackupCode: encryptField(telegramRecoveryBackupCode || null),
      dataEntityId: dataEntityId ? Number(dataEntityId) : null,
    } as typeof vaultEntriesTable.$inferInsert).returning();
}

export function insertVaultEntriesForCreateEntity2(baseValues: Record<string, unknown>) {
  return db.insert(vaultEntriesTable).values(baseValues as typeof vaultEntriesTable.$inferInsert).returning();
}

/**
 * VLT-GAP-19: pins an entity serial to (userId, idempotency key). Returns the serial this key is bound to: the one passed in when the
 * key is new, or the earlier one when the client is retrying (migration 121).
 */
export async function claimCreateIdempotencyKey(userId: number, key: string, serial: string): Promise<string> {
  const inserted: any = await db.execute(sql`
    INSERT INTO vault_create_idempotency (user_id, idem_key, entity_serial) VALUES (${userId}, ${key}, ${serial})
    ON CONFLICT (user_id, idem_key) DO NOTHING RETURNING entity_serial`);
  if ((inserted.rows ?? inserted)[0]) return serial;
  const existing: any = await db.execute(sql`SELECT entity_serial FROM vault_create_idempotency WHERE user_id = ${userId} AND idem_key = ${key}`);
  return String((existing.rows ?? existing)[0].entity_serial);
}

/** VLT-GAP-19: the entity already created under this serial, if any (a retry whose first attempt committed). */
export async function selectVaultEntryByCreateSerial(userId: number, serial: string) {
  const rows = await db.select().from(vaultEntriesTable).where(and(eq(vaultEntriesTable.userId, userId), eq(vaultEntriesTable.entitySerial, serial)));
  return rows[0] ?? null;
}
