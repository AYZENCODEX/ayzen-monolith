/**
 * Shared Vault field policy.
 *
 * This is the single source of truth for field-level encryption across the
 * Vault route, migration, snapshot, share, emergency-access, and restore
 * adapters. It contains names only; it never decrypts or exposes values.
 */
export const VAULT_ENTITY_ENCRYPTED_FIELDS = [
  "account_password", "email_password", "email_2fa", "email_backup_code", "email_recovery_password",
  "account_2fa", "account_backup_code",
  "recovery_2fa", "recovery_backup_code",
  "twitter_password", "twitter_email_password", "twitter_2fa", "twitter_email_recovery_password",
  "twitter_account_backup_code", "twitter_email_2fa", "twitter_email_backup_code",
  "twitter_recovery_2fa", "twitter_recovery_backup_code",
  "discord_password", "discord_email_password", "discord_2fa", "discord_email_recovery_password",
  "discord_account_backup_code", "discord_email_2fa", "discord_email_backup_code",
  "discord_recovery_2fa", "discord_recovery_backup_code",
  "telegram_password", "telegram_linked_email_password", "telegram_2fa",
  "telegram_account_backup_code", "telegram_email_2fa", "telegram_email_backup_code",
  "telegram_recovery_2fa", "telegram_recovery_backup_code",
  "backup_codes", "other_accounts",
] as const;

export const SENSITIVE_VAULT_FIELDS = new Set([
  "accountPassword", "emailPassword", "email2fa", "emailBackupCode", "emailRecoveryPassword",
  "recovery2fa", "recoveryBackupCode",
  "account2fa", "accountBackupCode",
  "twitterPassword", "twitterEmailPassword", "twitter2fa", "twitterEmailRecoveryPassword",
  "twitterAccountBackupCode", "twitterEmail2fa", "twitterEmailBackupCode",
  "twitterRecovery2fa", "twitterRecoveryBackupCode",
  "discordPassword", "discordEmailPassword", "discord2fa", "discordEmailRecoveryPassword",
  "discordAccountBackupCode", "discordEmail2fa", "discordEmailBackupCode",
  "discordRecovery2fa", "discordRecoveryBackupCode",
  "telegramPassword", "telegramLinkedEmailPassword", "telegram2fa",
  "telegramAccountBackupCode", "telegramEmail2fa", "telegramEmailBackupCode",
  "telegramRecovery2fa", "telegramRecoveryBackupCode",
  "backupCodes", "otherAccounts",
]);
