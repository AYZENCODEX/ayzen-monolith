import { decryptField } from "../../crypto/field-encryption";
import { decryptSeedPhrase } from "../../crypto/seed-phrase";

/**
 * The canonical raw vault_entries -> API entity projection.
 *
 * This was extracted from routes/vault.ts without changing the wire shape.
 * The route keeps only a compatibility export while all consumers import this
 * application-owned projection directly.
 */
export function formatVaultEntry(
  e: Record<string, unknown>,
  revealSeed = false,
) {
  const walStr = e.wallet_addresses ?? e.walletAddresses;
  const bkStrRaw = e.backup_codes ?? e.backupCodes;
  const bkStr = bkStrRaw ? decryptField(bkStrRaw as string) : bkStrRaw;
  const otherAccountsRaw = e.other_accounts ?? e.otherAccounts;
  const encSeed = e.encrypted_seed_phrase ?? e.encryptedSeedPhrase ?? null;
  return {
    id: e.id,
    userId: e.user_id ?? e.userId,
    entitySerial: e.entity_serial ?? e.entitySerial,
    category: e.category,
    projectName: e.project_name ?? e.projectName,
    username: e.username ?? null,
    accountPassword: decryptField((e.account_password ?? e.accountPassword ?? null) as string | null),
    email: e.email,
    emailPassword: decryptField((e.email_password ?? e.emailPassword) as string | null),
    email2fa: decryptField((e.email_2fa ?? e.email2fa ?? null) as string | null),
    emailBackupCode: decryptField((e.email_backup_code ?? e.emailBackupCode ?? null) as string | null),
    emailRecovery: e.email_recovery ?? e.emailRecovery ?? null,
    emailRecoveryPassword: decryptField((e.email_recovery_password ?? e.emailRecoveryPassword ?? null) as string | null),
    recovery2fa: decryptField((e.recovery_2fa ?? e.recovery2fa ?? null) as string | null),
    recoveryBackupCode: decryptField((e.recovery_backup_code ?? e.recoveryBackupCode ?? null) as string | null),
    lastLoginAt: e.last_login_at ?? e.lastLoginAt ?? null,
    buyDate: e.buy_date ?? e.buyDate ?? null,
    createDate: e.create_date ?? e.createDate ?? null,
    followers: Number(e.followers ?? 0),
    driveWalletLabel: e.drive_wallet_label ?? e.driveWalletLabel ?? null,
    driveWalletAddress: e.drive_wallet_address ?? e.driveWalletAddress ?? null,
    driveWalletNote: e.drive_wallet_note ?? e.driveWalletNote ?? null,
    driveWalletSetAt: e.drive_wallet_set_at ?? e.driveWalletSetAt ?? null,
    twitterUsername: e.twitter_username ?? e.twitterUsername,
    twitterPassword: decryptField((e.twitter_password ?? e.twitterPassword) as string | null),
    twitterEmail: e.twitter_email ?? e.twitterEmail ?? null,
    twitterEmailPassword: decryptField((e.twitter_email_password ?? e.twitterEmailPassword ?? null) as string | null),
    twitterFollowers: e.twitter_followers ?? e.twitterFollowers ?? null,
    twitter2fa: decryptField((e.twitter_2fa ?? e.twitter2fa ?? null) as string | null),
    twitterEmailRecovery: e.twitter_email_recovery ?? e.twitterEmailRecovery ?? null,
    twitterEmailRecoveryPassword: decryptField((e.twitter_email_recovery_password ?? e.twitterEmailRecoveryPassword ?? null) as string | null),
    twitterAge: e.twitter_age ?? e.twitterAge ?? null,
    twitterWorth: e.twitter_worth ?? e.twitterWorth ?? null,
    twitterBuyValue: e.twitter_buy_value ?? e.twitterBuyValue ?? null,
    twitterLastLoginAt: e.twitter_last_login_at ?? e.twitterLastLoginAt ?? null,
    twitterBuyDate: e.twitter_buy_date ?? e.twitterBuyDate ?? null,
    twitterCreateDate: e.twitter_create_date ?? e.twitterCreateDate ?? null,
    twitterNotes: e.twitter_notes ?? e.twitterNotes ?? null,
    discordUsername: e.discord_username ?? e.discordUsername,
    discordPassword: decryptField((e.discord_password ?? e.discordPassword) as string | null),
    discordEmail: e.discord_email ?? e.discordEmail ?? null,
    discordEmailPassword: decryptField((e.discord_email_password ?? e.discordEmailPassword ?? null) as string | null),
    discord2fa: decryptField((e.discord_2fa ?? e.discord2fa ?? null) as string | null),
    discordEmailRecovery: e.discord_email_recovery ?? e.discordEmailRecovery ?? null,
    discordEmailRecoveryPassword: decryptField((e.discord_email_recovery_password ?? e.discordEmailRecoveryPassword ?? null) as string | null),
    discordFollowers: e.discord_followers ?? e.discordFollowers ?? null,
    discordAge: e.discord_age ?? e.discordAge ?? null,
    discordWorth: e.discord_worth ?? e.discordWorth ?? null,
    discordBuyValue: e.discord_buy_value ?? e.discordBuyValue ?? null,
    discordLastLoginAt: e.discord_last_login_at ?? e.discordLastLoginAt ?? null,
    discordBuyDate: e.discord_buy_date ?? e.discordBuyDate ?? null,
    discordCreateDate: e.discord_create_date ?? e.discordCreateDate ?? null,
    discordNotes: e.discord_notes ?? e.discordNotes ?? null,
    telegramUsername: e.telegram_username ?? e.telegramUsername,
    telegramPassword: decryptField((e.telegram_password ?? e.telegramPassword) as string | null),
    telegramPhone: e.telegram_phone ?? e.telegramPhone ?? null,
    telegram2fa: decryptField((e.telegram_2fa ?? e.telegram2fa ?? null) as string | null),
    telegramLinkedEmail: e.telegram_linked_email ?? e.telegramLinkedEmail ?? null,
    telegramLinkedEmailPassword: decryptField((e.telegram_linked_email_password ?? e.telegramLinkedEmailPassword ?? null) as string | null),
    telegramAge: e.telegram_age ?? e.telegramAge ?? null,
    telegramWorth: e.telegram_worth ?? e.telegramWorth ?? null,
    telegramBuyValue: e.telegram_buy_value ?? e.telegramBuyValue ?? null,
    telegramFollowers: e.telegram_followers ?? e.telegramFollowers ?? null,
    telegramLastLoginAt: e.telegram_last_login_at ?? e.telegramLastLoginAt ?? null,
    telegramBuyDate: e.telegram_buy_date ?? e.telegramBuyDate ?? null,
    telegramCreateDate: e.telegram_create_date ?? e.telegramCreateDate ?? null,
    telegramNotes: e.telegram_notes ?? e.telegramNotes ?? null,
    account2fa: decryptField((e.account_2fa ?? (e as any).account2fa ?? null) as string | null),
    accountBackupCode: decryptField((e.account_backup_code ?? (e as any).accountBackupCode ?? null) as string | null),
    twitterAccountBackupCode: decryptField((e.twitter_account_backup_code ?? (e as any).twitterAccountBackupCode ?? null) as string | null),
    twitterEmail2fa: decryptField((e.twitter_email_2fa ?? (e as any).twitterEmail2fa ?? null) as string | null),
    twitterEmailBackupCode: decryptField((e.twitter_email_backup_code ?? (e as any).twitterEmailBackupCode ?? null) as string | null),
    twitterRecovery2fa: decryptField((e.twitter_recovery_2fa ?? (e as any).twitterRecovery2fa ?? null) as string | null),
    twitterRecoveryBackupCode: decryptField((e.twitter_recovery_backup_code ?? (e as any).twitterRecoveryBackupCode ?? null) as string | null),
    discordAccountBackupCode: decryptField((e.discord_account_backup_code ?? (e as any).discordAccountBackupCode ?? null) as string | null),
    discordEmail2fa: decryptField((e.discord_email_2fa ?? (e as any).discordEmail2fa ?? null) as string | null),
    discordEmailBackupCode: decryptField((e.discord_email_backup_code ?? (e as any).discordEmailBackupCode ?? null) as string | null),
    discordRecovery2fa: decryptField((e.discord_recovery_2fa ?? (e as any).discordRecovery2fa ?? null) as string | null),
    discordRecoveryBackupCode: decryptField((e.discord_recovery_backup_code ?? (e as any).discordRecoveryBackupCode ?? null) as string | null),
    telegramAccountBackupCode: decryptField((e.telegram_account_backup_code ?? (e as any).telegramAccountBackupCode ?? null) as string | null),
    telegramEmail2fa: decryptField((e.telegram_email_2fa ?? (e as any).telegramEmail2fa ?? null) as string | null),
    telegramEmailBackupCode: decryptField((e.telegram_email_backup_code ?? (e as any).telegramEmailBackupCode ?? null) as string | null),
    telegramRecovery2fa: decryptField((e.telegram_recovery_2fa ?? (e as any).telegramRecovery2fa ?? null) as string | null),
    telegramRecoveryBackupCode: decryptField((e.telegram_recovery_backup_code ?? (e as any).telegramRecoveryBackupCode ?? null) as string | null),
    walletAddresses: walStr ? (() => { try { return JSON.parse(walStr as string); } catch { return []; } })() : [],
    backupCodes: bkStr ? (() => { try { return JSON.parse(bkStr as string); } catch { return []; } })() : [],
    tags: (() => {
      const t = e.tags ?? (e as any).tags;
      if (!t) return [];
      try { return JSON.parse(t as string); } catch { return []; }
    })(),
    notes: e.notes,
    otherAccounts: otherAccountsRaw ? decryptField(otherAccountsRaw as string) : null,
    currentValue: Number(e.current_value ?? e.currentValue ?? 0),
    currentBuyValue: Number(e.current_buy_value ?? e.currentBuyValue ?? 0),
    walletWorthUsd: Number(e.wallet_worth_usd ?? e.walletWorthUsd ?? 0),
    walletWorthSyncedAt: e.wallet_worth_synced_at ?? e.walletWorthSyncedAt ?? null,
    status: e.status ?? "active",
    twitterBanned: !!(e.twitter_banned ?? e.twitterBanned ?? false),
    discordBanned: !!(e.discord_banned ?? e.discordBanned ?? false),
    telegramBanned: !!(e.telegram_banned ?? e.telegramBanned ?? false),
    lastActivityAt: e.last_activity_at ?? e.lastActivityAt ?? null,
    lastHealthAlertAt: e.last_health_alert_at ?? (e as any).lastHealthAlertAt ?? null,
    lastHealthFlags: (() => {
      const f = e.last_health_flags ?? (e as any).lastHealthFlags;
      if (!f) return [];
      try { return JSON.parse(f as string); } catch { return []; }
    })(),
    dataEntityId: (e.data_entity_id ?? (e as any).dataEntityId ?? null) != null
      ? Number(e.data_entity_id ?? (e as any).dataEntityId) : null,
    hasSeedPhrase: !!encSeed,
    seedPhrase: revealSeed && encSeed ? decryptSeedPhrase(encSeed as string) : undefined,
    createdAt: e.created_at ? new Date(e.created_at as string).toISOString() : e.createdAt,
    updatedAt: e.updated_at ? new Date(e.updated_at as string).toISOString() : e.updatedAt,
    deletedAt: (e.deleted_at ?? (e as any).deletedAt)
      ? new Date((e.deleted_at ?? (e as any).deletedAt) as string).toISOString() : null,
  };
}