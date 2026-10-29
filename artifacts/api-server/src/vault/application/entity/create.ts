import { encryptField } from "../../crypto/field-encryption";
import { encryptSeedPhrase } from "../../crypto/seed-phrase";
import { generateSerial } from "../../domain/serial";
import { isMissingColumnError } from "../../domain/db-errors";
import { logVaultActivity } from "./activity";
import { formatVaultEntry as formatRow } from "./representation";
import type { EntityResult } from "./lifecycle";
import { claimCreateIdempotencyKey, selectVaultEntryByCreateSerial, insertVaultEntriesForCreateEntity, insertVaultEntriesForCreateEntity2 } from "../../infrastructure/repositories/entity-create-repository";

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
export async function createEntity(userId: number, body: any, deps: EntityCreateDeps, idempotencyKey?: string): Promise<EntityResult> {
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

  let serial = generateSerial(userId);
  // VLT-GAP-19: optional Idempotency-Key. A client retry after a lost response must not create a second entity: the serial is pinned to
  // (user, key) before the insert, so the retry returns the entity the first attempt created (or re-uses the pinned serial if that attempt
  // died before inserting). Without a key behaviour is unchanged.
  if (idempotencyKey) {
    if (idempotencyKey.length > 200) return { status: 400, body: { error: "Idempotency-Key must be at most 200 characters" } };
    serial = await claimCreateIdempotencyKey(userId, idempotencyKey, serial);
    const existing = await selectVaultEntryByCreateSerial(userId, serial);
    if (existing) return { status: 201, body: formatRow(existing as unknown as Record<string, unknown>) };
  }
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
    const [row] = await insertVaultEntriesForCreateEntity(baseValues, encryptedSeedPhrase, username, accountPassword, email2fa, emailBackupCode, recovery2fa, recoveryBackupCode, lastLoginAt, buyDate, createDate, emailRecovery, emailRecoveryPassword, twitterEmail, twitterEmailPassword, twitterFollowers, twitter2fa, twitterEmailRecovery, twitterEmailRecoveryPassword, twitterAge, twitterWorth, twitterBuyValue, twitterLastLoginAt, twitterBuyDate, twitterCreateDate, twitterNotes, discordEmail, discordEmailPassword, discord2fa, discordEmailRecovery, discordEmailRecoveryPassword, discordFollowers, discordAge, discordWorth, discordBuyValue, discordLastLoginAt, discordBuyDate, discordCreateDate, discordNotes, telegramPhone, telegram2fa, telegramLinkedEmail, telegramLinkedEmailPassword, telegramAge, telegramWorth, telegramBuyValue, telegramFollowers, telegramLastLoginAt, telegramBuyDate, telegramCreateDate, telegramNotes, account2fa, accountBackupCode, twitterAccountBackupCode, twitterEmail2fa, twitterEmailBackupCode, twitterRecovery2fa, twitterRecoveryBackupCode, discordAccountBackupCode, discordEmail2fa, discordEmailBackupCode, discordRecovery2fa, discordRecoveryBackupCode, telegramAccountBackupCode, telegramEmail2fa, telegramEmailBackupCode, telegramRecovery2fa, telegramRecoveryBackupCode, dataEntityId);
    entry = row as unknown as Record<string, unknown>;
  } catch (err) {
    // New columns not in Drizzle schema yet — insert without them. VLT-GAP-19: ONLY for that failure. Any other error (dropped
    // connection, timeout, deadlock) must surface: the fallback stores a reduced entity (no seed phrase / credentials) and, when the
    // first insert had in fact committed, a second row.
    if (!isMissingColumnError(err)) throw err;
    const [row] = await insertVaultEntriesForCreateEntity2(baseValues);
    entry = row as unknown as Record<string, unknown>;
  }

  // VLT-GAP-19: the event is a notification, not part of the write — the entity is already committed, so a failing hub must not turn
  // a successful create into an error response (the client would retry and create a duplicate).
  try { deps.broadcastEvent("vault_updated", { action: "created", entryId: entry.id }); } catch (err) { console.error("vault_updated broadcast failed (entity was created):", err); }
  logVaultActivity(Number(entry.id), userId, "created", projectName);
  deps.autoCreateLocalAccounts(userId, Number(entry.id), body).catch(() => {});
  return { status: 201, body: formatRow(entry) };
}
