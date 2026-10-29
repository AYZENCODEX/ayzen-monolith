import { db, vaultEntriesTable } from "@workspace/db";
import { encryptField } from "../../crypto/field-encryption";
import { encryptSeedPhrase } from "../../crypto/seed-phrase";
import { generateSerial } from "../../domain/serial";
import { logVaultActivity } from "./activity";
import { formatVaultEntry as formatRow } from "./representation";
import type { EntityResult } from "./lifecycle";

/**
 * Entity creation use-case. Extracted verbatim from routes/vault.ts
 * (VLT-GAP-01-D): payload destructuring, encryption of sensitive columns, the
 * Drizzle-then-base-columns insert fallback, event, audit and the best-effort
 * local-account bridge call are unchanged. The SSE broadcaster and the
 * local-account bridge (owned by GAP-02) are injected as ports.
 */
export interface EntityCreateDeps {
  broadcastEvent: (event: string, data?: Record<string, unknown>) => void;
  autoCreateLocalAccounts: (userId: number, vaultEntryId: number, body: Record<string, unknown>) => Promise<void>;
}

// ─── POST /vault — create vault entry ────────────────────────────────────────
export async function createEntity(userId: number, body: any, deps: EntityCreateDeps): Promise<EntityResult> {
  const {
    projectName,
    username, accountPassword,
    email, emailPassword, email2fa, emailBackupCode,
    recovery2fa, recoveryBackupCode,
    lastLoginAt, buyDate, createDate,
    twitterUsername, twitterPassword,
    discordUsername, discordPassword,
    telegramUsername, telegramPassword,
    walletAddresses, backupCodes, notes, otherAccounts, tags,
    seedPhrase, // plaintext — will be encrypted before storage
    emailRecovery, emailRecoveryPassword,
    twitterEmail, twitterEmailPassword, twitterFollowers, twitter2fa,
    twitterEmailRecovery, twitterEmailRecoveryPassword, twitterAge, twitterWorth, twitterBuyValue,
    twitterLastLoginAt, twitterBuyDate, twitterCreateDate, twitterNotes,
    discordEmail, discordEmailPassword, discord2fa,
    discordEmailRecovery, discordEmailRecoveryPassword, discordFollowers, discordAge, discordWorth, discordBuyValue,
    discordLastLoginAt, discordBuyDate, discordCreateDate, discordNotes,
    telegramPhone, telegram2fa, telegramLinkedEmail, telegramLinkedEmailPassword, telegramAge, telegramWorth, telegramBuyValue,
    telegramFollowers, telegramLastLoginAt, telegramBuyDate, telegramCreateDate, telegramNotes,
    account2fa, accountBackupCode,
    twitterAccountBackupCode, twitterEmail2fa, twitterEmailBackupCode, twitterRecovery2fa, twitterRecoveryBackupCode,
    discordAccountBackupCode, discordEmail2fa, discordEmailBackupCode, discordRecovery2fa, discordRecoveryBackupCode,
    telegramAccountBackupCode, telegramEmail2fa, telegramEmailBackupCode, telegramRecovery2fa, telegramRecoveryBackupCode,
    score,
    dataEntityId,
  } = body;

  if (!projectName) {
    return { status: 400, body: { error: "projectName is required" } };
    
  }

  const serial = generateSerial(userId);
  const encryptedSeedPhrase = seedPhrase ? encryptSeedPhrase(seedPhrase) : null;

  const baseValues: Record<string, unknown> = {
    userId, entitySerial: serial, projectName,
    email: email || null, emailPassword: encryptField(emailPassword || null),
    twitterUsername: twitterUsername || null, twitterPassword: encryptField(twitterPassword || null),
    discordUsername: discordUsername || null, discordPassword: encryptField(discordPassword || null),
    telegramUsername: telegramUsername || null, telegramPassword: encryptField(telegramPassword || null),
    walletAddresses: walletAddresses ? JSON.stringify(walletAddresses) : null,
    backupCodes: encryptField(backupCodes ? JSON.stringify(backupCodes) : null),
    tags: Array.isArray(tags) ? JSON.stringify(tags) : null,
    notes: notes || null,
    otherAccounts: encryptField(otherAccounts || null),
    score: Math.max(0, Math.min(10, Number.isFinite(Number(score)) ? Number(score) : 5)),
  };

  let entry: Record<string, unknown>;
  try {
    const [row] = await db.insert(vaultEntriesTable).values({
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
    entry = row as unknown as Record<string, unknown>;
  } catch {
    // New columns not in Drizzle schema yet — insert without them
    const [row] = await db.insert(vaultEntriesTable).values(baseValues as typeof vaultEntriesTable.$inferInsert).returning();
    entry = row as unknown as Record<string, unknown>;
  }

  deps.broadcastEvent("vault_updated", { action: "created", entryId: entry.id });
  logVaultActivity(Number(entry.id), userId, "created", projectName);
  deps.autoCreateLocalAccounts(userId, Number(entry.id), body).catch(() => {});
  return { status: 201, body: formatRow(entry) };
}
