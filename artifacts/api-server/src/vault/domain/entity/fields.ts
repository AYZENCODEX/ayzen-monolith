/**
 * Entity field allow-lists and labels. Extracted verbatim from routes/vault.ts
 * (VLT-GAP-01-B); pure domain rules with no I/O.
 */

export const NEW_VAULT_FIELDS = [
  "username", "accountPassword", "email2fa", "emailBackupCode",
  "recovery2fa", "recoveryBackupCode",
  "lastLoginAt", "buyDate", "createDate",
  "emailRecovery", "emailRecoveryPassword",
  "twitterEmail", "twitterEmailPassword", "twitterFollowers", "twitter2fa",
  "twitterEmailRecovery", "twitterEmailRecoveryPassword", "twitterAge", "twitterWorth", "twitterBuyValue",
  "twitterLastLoginAt", "twitterBuyDate", "twitterCreateDate", "twitterNotes",
  "discordEmail", "discordEmailPassword", "discord2fa",
  "discordEmailRecovery", "discordEmailRecoveryPassword", "discordFollowers", "discordAge", "discordWorth", "discordBuyValue",
  "discordLastLoginAt", "discordBuyDate", "discordCreateDate", "discordNotes",
  "telegramPhone", "telegram2fa", "telegramLinkedEmail", "telegramLinkedEmailPassword", "telegramAge", "telegramWorth", "telegramBuyValue",
  "telegramFollowers", "telegramLastLoginAt", "telegramBuyDate", "telegramCreateDate", "telegramNotes",
  "twitterBanned", "discordBanned", "telegramBanned",
  "account2fa", "accountBackupCode",
  "twitterAccountBackupCode", "twitterEmail2fa", "twitterEmailBackupCode", "twitterRecovery2fa", "twitterRecoveryBackupCode",
  "discordAccountBackupCode", "discordEmail2fa", "discordEmailBackupCode", "discordRecovery2fa", "discordRecoveryBackupCode",
  "telegramAccountBackupCode", "telegramEmail2fa", "telegramEmailBackupCode", "telegramRecovery2fa", "telegramRecoveryBackupCode",
  "dataEntityId",
] as const;

// Base scalar fields updatable via PATCH /vault/:id (the full multi-tab form)
// — hoisted to module scope so PATCH /vault/:id/field (single-field Change
// button) can reuse the exact same allow-list instead of duplicating it.
export const BASE_VAULT_FIELDS = [
  "projectName", "email", "emailPassword",
  "twitterUsername", "twitterPassword",
  "discordUsername", "discordPassword",
  "telegramUsername", "telegramPassword",
  "notes",
  "currentValue", "currentBuyValue",
];

export const DATE_FIELDS = new Set([
  "lastLoginAt", "buyDate", "createDate",
  "twitterLastLoginAt", "twitterBuyDate", "twitterCreateDate",
  "discordLastLoginAt", "discordBuyDate", "discordCreateDate",
  "telegramLastLoginAt", "telegramBuyDate", "telegramCreateDate",
]);

// Every plain scalar field eligible for the per-field "Change" button —
// everything PATCH /vault/:id can already touch, minus the JSON/array
// fields (walletAddresses, backupCodes, tags, otherAccounts) and fields
// with their own dedicated flow (seedPhrase, status, score, drive wallet),
// which keep their existing endpoints/UI instead.
export const SINGLE_FIELD_EDITABLE = new Set<string>([...BASE_VAULT_FIELDS, ...NEW_VAULT_FIELDS, "followers"]);

// Human-readable label for the commit-history feed — camelCase -> Title Case
// (e.g. "twitterEmailRecoveryPassword" -> "Twitter Email Recovery Password").
export function fieldLabel(field: string): string {
  return field.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()).trim();
}

export const BULK_ALLOWED_STATUSES = new Set(["active", "warning", "banned", "suspended"]);
