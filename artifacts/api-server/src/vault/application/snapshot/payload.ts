import { SENSITIVE_VAULT_FIELDS } from "../../domain/secret-fields";
import { decryptField } from "../../crypto/field-encryption";
import { decryptPhrase } from "../../../lib/wallet-crypto";
import { gatherAccountExtrasSnapshot, gatherActivitySnapshot, gatherBackupSystemSnapshot, gatherEarningSnapshot, gatherEmailAccountsSnapshot, gatherEmergencyAccessSnapshot, gatherEntityCoverageSnapshot, gatherExternalMailSnapshot, gatherFinanceSnapshot, gatherMailboxReputationSnapshot, gatherMailboxSnapshot, gatherProjectsSnapshot, gatherTasksSnapshot, gatherTeamSnapshot, gatherUserProfileSnapshot, gatherWalletHubSnapshot } from "../../infrastructure/repositories/snapshot-sections-repository";
import { executeGameEntriesForBuildVaultSnapshotPayload, executeKycEntriesForBuildVaultSnapshotPayload, executeLocalAccountsForBuildVaultSnapshotPayload, selectVaultAttachmentsForBuildVaultSnapshotPayload, selectWalletsForBuildVaultSnapshotPayload } from "../../infrastructure/repositories/vault-snapshot-payload-repository";
import { selectVaultEntriesForModule } from "../../infrastructure/repositories/vault-migration-repository";

/** Extracted verbatim from routes/vault-snapshot.ts (VLT-GAP-09); bodies unchanged. */

export function safeDecryptPhrase(encrypted: string): string | null {
  try { return decryptPhrase(encrypted); } catch { return null; }
}
/**
 * Gathers and shapes every table this app stores secrets in, for a given
 * user, into the plaintext JSON that both the manual export button and
 * vault/application/backup/schedule-cron.ts's scheduled sweep encrypt (under a
 * password or the server envelope key, respectively) and store. Sensitive
 * Vault fields and wallet seed phrases are decrypted here so the resulting
 * backup is immediately usable on restore without a second decryption pass
 * against this app's own field-level keys.
 */
export async function buildVaultSnapshotPayload(
  userId: number, includeAttachments: boolean,
): Promise<{
  json: string; vaultCount: number; walletsCount: number;
  mailboxCount: number; projectsCount: number; tasksCount: number; financeCount: number;
  walletHubCount: number; activityCount: number; entityCoverageCount: number; emergencyAccessCount: number;
  accountExtrasCount: number; teamCount: number; earningCount: number; backupSystemCount: number;
  emailAccountsCount: number; mailboxReputationCount: number; externalMailCount: number;
}> {
  const [vaultRows, localRows, kycRows, gameRows, walletRows, mailbox, projects, tasks, finance, profile, walletHub, activity, entityCoverage, emergencyAccess, accountExtras, team, earning, backupSystem, emailAccounts, mailboxReputation, externalMail] = await Promise.all([
    selectVaultEntriesForModule(userId),
    executeLocalAccountsForBuildVaultSnapshotPayload(userId).then(r => r.rows).catch(() => []),
    executeKycEntriesForBuildVaultSnapshotPayload(userId).then(r => r.rows).catch(() => []),
    executeGameEntriesForBuildVaultSnapshotPayload(userId).then(r => r.rows).catch(() => []),
    selectWalletsForBuildVaultSnapshotPayload(userId),
    gatherMailboxSnapshot(userId, includeAttachments),
    gatherProjectsSnapshot(userId),
    gatherTasksSnapshot(userId),
    gatherFinanceSnapshot(userId, includeAttachments),
    gatherUserProfileSnapshot(userId),
    gatherWalletHubSnapshot(userId),
    gatherActivitySnapshot(userId),
    gatherEntityCoverageSnapshot(userId),
    gatherEmergencyAccessSnapshot(userId),
    gatherAccountExtrasSnapshot(userId),
    gatherTeamSnapshot(userId),
    gatherEarningSnapshot(userId),
    gatherBackupSystemSnapshot(userId),
    gatherEmailAccountsSnapshot(userId),
    gatherMailboxReputationSnapshot(userId),
    gatherExternalMailSnapshot(userId),
  ]);

  const vault = vaultRows.map(r => {
    const out: Record<string, unknown> = { ...r };
    for (const f of SENSITIVE_VAULT_FIELDS) out[f] = decryptField(out[f] as any);
    return out;
  });

  const wallets = walletRows.map(w => ({
    ...w,
    encryptedPhrase: undefined,
    seedPhrase: w.encryptedPhrase ? safeDecryptPhrase(w.encryptedPhrase) : null,
  }));

  let attachments: Record<string, unknown>[] = [];
  if (includeAttachments) {
    const rows = await selectVaultAttachmentsForBuildVaultSnapshotPayload(userId);
    attachments = rows.map(a => ({ ...a, encryptedContent: undefined, dataBase64: decryptField(a.encryptedContent) }));
  }

  const snapshot = {
    exportedAt: new Date().toISOString(),
    userId,
    version: 9, // Connected Mail Accounts auto-restored (Feature 15v); mailboxReputation (15w) is reference-only, no bump needed
    vault, localAccounts: localRows, kycEntries: kycRows, gameEntries: gameRows, wallets, attachments,
    // KYC Data Entities (Feature 15h) — flattened to top-level like
    // localAccounts/kycEntries/gameEntries above, since this is the same
    // kind of "real entity data" (see gatherEntityCoverageSnapshot's doc
    // comment) and merge-restores the same additive way via RAW_PLANS.
    kycDataEntities: entityCoverage.dataEntities,
    // Native mailbox (Feature 15d) — flattened to top-level arrays (rather
    // than nested under `mailbox`) so the same RAW_PLANS merge-restore
    // mechanism lib/vault-snapshot-restore.ts already uses for
    // localAccounts/kycEntries/gameEntries can address these directly.
    mailboxFolders: mailbox.folders,
    mailboxMessages: mailbox.messages,
    mailboxLabels: mailbox.labels,
    mailboxMessageLabels: mailbox.messageLabels,
    mailboxRules: mailbox.rules,
    mailboxTemplates: mailbox.templates,
    mailboxContacts: mailbox.contacts,
    // Attachments (Feature 15d) — kept nested rather than flattened into
    // RAW_PLANS like the tables above: each row's message_id FK points at
    // a specific mailboxMessages row, and messages restore through their
    // own special-cased path (reencryptMailboxMessageForRestore, not
    // RAW_PLANS) rather than getting fresh sequential ids the same way
    // RAW_PLANS rows do — so there's no safe way yet to remap an
    // attachment onto its restored message. Backed up for reference/manual
    // recovery (same treatment as finance/profile/activity below); content
    // only present when includeAttachments was set at export time.
    mailboxAttachments: mailbox.attachments,
    // Protocol/project enrollments (Feature 15d). userProjects flattens into
    // RAW_PLANS same as the tables above (project_id points at the global
    // projects table, not a per-user entity, so it's always safely
    // restorable). projectEnrollments does NOT go through RAW_PLANS despite
    // being flattened here the same way — its vault_entry_id (NOT NULL) /
    // kyc_entry_id / data_entity_id all point at rows that get a brand-new
    // id on merge-restore, with no way to remap them yet (same reasoning as
    // entityCoverage below), so it's backed up for reference/manual
    // recovery only, never auto-merge-restored — see
    // lib/vault-snapshot-restore.ts's RAW_PLANS comment.
    userProjects: projects.userProjects,
    projectEnrollments: projects.enrollments,
    projectRoiLedger: projects.roiLedger,
    projectRatings: projects.ratings,
    projectPnlReceipts: projects.pnlReceipts,
    // Tasks (Feature 15d).
    taskSubmissions: tasks.submissions,
    // Wallet Hub (Feature 15e) — everything the Wallet Hub page shows beyond
    // the base `wallets` rows above. builtinWalletTokens and chainDeposits
    // are flattened to top-level (merge-restorable, same reasoning as the
    // mailbox/task tables); walletTransfers/credits/creditTransactions stay
    // nested under `walletHub` and are NOT auto-restored — see the comment
    // on `finance` below for why (these are live balances / two-party money
    // movements, not something a restore should silently rewrite).
    builtinWalletTokens: walletHub.builtinTokens,
    chainDeposits: walletHub.chainDeposits,
    walletHub: { transfers: walletHub.transfers, credits: walletHub.credits, creditTransactions: walletHub.creditTransactions },
    // Finance (Feature 15d) — kept nested and NOT wired into the RAW_PLANS
    // merge-restore mechanism: the ledger has cross-table balance integrity
    // (running totals, generated ROI columns, journal debit/credit
    // balancing) that a blind additive re-insert could silently break, and
    // "same row" identity is much harder to define safely for money
    // movements than for a mailbox rule or a KYC entry. It IS included in
    // every backup (so a full account rebuild — even by hand from the JSON
    // — is possible), same treatment vault attachments already get: backed
    // up, shown in the restore-preview counts, not auto-restored.
    finance,
    // Account configuration (Feature 15d) — handles, digest prefs, invoice
    // branding, etc. Never includes password_hash or two_fa_secret (see
    // gatherUserProfileSnapshot). Informational-only in restore, same
    // reasoning as finance: overwriting the *current* account's profile
    // row from an old backup is a decision a user should make explicitly
    // in Settings, not something a restore silently does.
    profile,
    // Activity trace (Feature 15f) — general event log + Vault-specific
    // audit trails (see gatherActivitySnapshot's doc comment). Included for
    // disaster-recovery/audit reference; capped to the most recent
    // ACTIVITY_TRACE_LIMIT rows per table and, like finance/profile, never
    // auto-restored — an audit trail records what already happened, so
    // replaying it isn't a "restore" in any meaningful sense.
    activity,
    // Entity coverage (Feature 15h) — receipts/history/shares tied to the
    // four entity tables above. Kept nested (not flattened into RAW_PLANS)
    // and NOT auto-restored — see gatherEntityCoverageSnapshot's doc
    // comment for why (sourceId/entity_id remapping, and shares being
    // two-party data). Backed up so a full manual/disaster recovery from
    // the raw JSON is always possible, same treatment as finance/profile/
    // activity above.
    entityCoverage: {
      categoryReceipts: entityCoverage.categoryReceipts,
      valueHistory: entityCoverage.valueHistory,
      sharesOwned: entityCoverage.sharesOwned,
      sharesReceived: entityCoverage.sharesReceived,
      // Feature 15i — Linked Entities graph (vault_entity_links). Same
      // nested/not-auto-restored treatment as the three above — see
      // gatherEntityCoverageSnapshot's doc comment for why.
      entityLinks: entityCoverage.entityLinks,
    },
    // Emergency Access (Feature 15j) — dead-man-switch nominations + grants,
    // both this user's own (contactsOwned, grantsOwned) and any grant where
    // this user is the nominated contact (grantsAsContact). Reference-only,
    // not auto-restored — see gatherEmergencyAccessSnapshot's doc comment.
    emergencyAccess: {
      contactsOwned: emergencyAccess.contactsOwned,
      grantsOwned: emergencyAccess.grantsOwned,
      grantsAsContact: emergencyAccess.grantsAsContact,
    },
    // Account & Platform Extras (Feature 15m) — the remaining account-scoped
    // surfaces: notifications, referrals (both directions), billing/
    // subscription state, support tickets + messages, developer API keys
    // (metadata only — key_hash stripped, see gatherAccountExtrasSnapshot's
    // doc comment), passkeys, and Polymarket trade history. Kept nested and
    // NOT auto-restored, same reasoning as finance/profile/activity/
    // entityCoverage/emergencyAccess above. Included in every backup so a
    // full manual/disaster recovery from the raw JSON is always possible.
    accountExtras: {
      notifications: accountExtras.notifications,
      referralsMade: accountExtras.referralsMade,
      referralsReceived: accountExtras.referralsReceived,
      subscription: accountExtras.subscription,
      supportTickets: accountExtras.supportTickets,
      supportMessages: accountExtras.supportMessages,
      apiKeys: accountExtras.apiKeys,
      passkeys: accountExtras.passkeys,
      polymarketTrades: accountExtras.polymarketTrades,
    },
    // Team (Feature 15n) — teams this user owns, their memberships across
    // every team they belong to, and everything they've personally posted/
    // requested/created inside a team (messages, announcements, missions,
    // join requests, favorites) plus their own slice of both team activity
    // logs (legacy + current). Kept nested and NOT auto-restored, same
    // reasoning as accountExtras/emergencyAccess above.
    team: {
      teamsOwned: team.teamsOwned,
      memberships: team.memberships,
      joinRequestsMade: team.joinRequestsMade,
      favorites: team.favorites,
      messagesSent: team.messagesSent,
      announcementsPosted: team.announcementsPosted,
      missionsCreated: team.missionsCreated,
      teamActivityLegacy: team.teamActivityLegacy,
      teamActivityShared: team.teamActivityShared,
    },
    // Earning (Feature 15n) — this user's own pay-per-click earn links
    // (title, target URL, code, rate, click/earned counters). The AZN
    // balance those links produce is already covered by walletHub.credits
    // above. Kept nested and NOT auto-restored — earn_links.code is
    // globally unique, so re-inserting an old code verbatim could collide
    // with a code re-issued to someone else since the backup was made.
    earning: {
      earnLinks: earning.earnLinks,
    },
    // Backup System self-coverage (Feature 15t) — this user's own automatic-
    // backup schedule, connected cloud-delivery accounts, delivery/audit
    // history, and a secrets-free Vault security posture summary. Secrets
    // (webhookSecret, cloud OAuth tokens, PIN/password hashes) are stripped
    // at the gather step — see gatherBackupSystemSnapshot's doc comment for
    // exactly why each one is excluded. Kept nested and NOT auto-restored,
    // same reasoning as accountExtras/team above.
    backupSystem: {
      schedule: backupSystem.schedule,
      cloudConnections: backupSystem.cloudConnections,
      deliveries: backupSystem.deliveries,
      auditLog: backupSystem.auditLog,
      vaultSecurityPosture: backupSystem.vaultSecurityPosture,
      projectTemplates: backupSystem.projectTemplates,
    },
    // Connected Mail Accounts (Feature 15u) — external IMAP/SMTP mailboxes
    // this user wired up (both personal and any team mailbox they
    // personally configured), password/authKey decrypted the same way
    // Vault entity fields and wallet seed phrases are above — see
    // gatherEmailAccountsSnapshot's doc comment for why this one IS
    // decrypted where backupSystem's cloud-connection tokens are not.
    // Flattened to a top-level array (rather than nested), same as
    // mailboxFolders/mailboxContacts above, so the merge-restore mechanism
    // in lib/vault-snapshot-restore.ts can address it directly — this is
    // auto-restored (unlike backupSystem/team above), keyed on
    // emailAddress + protocol per user.
    emailAccounts: emailAccounts.accounts,
    // Mailbox Deliverability & Reputation (Feature 15w) — this user's own
    // sender Block/Allow list, auto-flagged/blocked outbound recipients,
    // and their account's own sending-health status. Kept nested and NOT
    // auto-restored: sender/recipient reputation are live moderation
    // decisions gated on a (user, email) unique key, and blindly re-adding
    // a stale "blocked" row on restore could re-block an address the user
    // has since deliberately unblocked from Settings — the same
    // "don't silently overwrite a since-changed decision" reasoning
    // backupSystem/team above already use. sendingHealth is fully derived
    // from live sends and would just be immediately recomputed anyway.
    // Included in every backup so a full manual/disaster recovery from the
    // raw JSON is always possible.
    mailboxReputation: {
      senderReputation: mailboxReputation.senderReputation,
      recipientReputation: mailboxReputation.recipientReputation,
      sendingHealth: mailboxReputation.sendingHealth,
    },
    // External Mail Sync Cache (Feature 15x) — the synced header/body cache
    // for this user's connected external IMAP/SMTP mailboxes (mail_messages,
    // bodies decrypted like the native mailbox's above). Kept nested and
    // NOT auto-restored — this is a CACHE of a system of record that lives
    // outside AYZEN (the user's actual Gmail/Outlook/IMAP server); the
    // correct recovery path is re-syncing the account, not replaying a
    // stale cache that could resurrect content since deleted at the
    // source. Included in every backup so a full manual/disaster recovery
    // from the raw JSON is always possible, same treatment as
    // finance/profile/activity above.
    externalMail: {
      messages: externalMail.messages,
    },
  };

  const mailboxCount = mailbox.folders.length + mailbox.messages.length + mailbox.labels.length
    + mailbox.messageLabels.length + mailbox.rules.length + mailbox.templates.length
    + mailbox.contacts.length + mailbox.attachments.length;
  const projectsCount = projects.userProjects.length + projects.enrollments.length
    + projects.roiLedger.length + projects.ratings.length + projects.pnlReceipts.length;
  const tasksCount = tasks.submissions.length;
  const financeCount = Object.values(finance).reduce((n, t) => n + (Array.isArray(t) ? t.length : 0), 0);
  const walletHubCount = walletHub.transfers.length + walletHub.builtinTokens.length
    + walletHub.credits.length + walletHub.creditTransactions.length + walletHub.chainDeposits.length;
  const activityCount = activity.userActivity.length + activity.vaultActivityLog.length + activity.vaultFieldHistory.length;
  const entityCoverageCount = entityCoverage.dataEntities.length + entityCoverage.categoryReceipts.length
    + entityCoverage.valueHistory.length + entityCoverage.sharesOwned.length + entityCoverage.sharesReceived.length
    + entityCoverage.entityLinks.length;
  const emergencyAccessCount = emergencyAccess.contactsOwned.length + emergencyAccess.grantsOwned.length
    + emergencyAccess.grantsAsContact.length;
  const accountExtrasCount = accountExtras.notifications.length + accountExtras.referralsMade.length
    + accountExtras.referralsReceived.length + (accountExtras.subscription ? 1 : 0)
    + accountExtras.supportTickets.length + accountExtras.supportMessages.length
    + accountExtras.apiKeys.length + accountExtras.passkeys.length + accountExtras.polymarketTrades.length;
  const teamCount = team.teamsOwned.length + team.memberships.length + team.joinRequestsMade.length
    + team.favorites.length + team.messagesSent.length + team.announcementsPosted.length
    + team.missionsCreated.length + team.teamActivityLegacy.length + team.teamActivityShared.length;
  const earningCount = earning.earnLinks.length;
  const backupSystemCount = (backupSystem.schedule ? 1 : 0) + backupSystem.cloudConnections.length
    + backupSystem.deliveries.length + backupSystem.auditLog.length
    + (backupSystem.vaultSecurityPosture ? 1 : 0) + backupSystem.projectTemplates.length;
  const emailAccountsCount = emailAccounts.accounts.length;
  const mailboxReputationCount = mailboxReputation.senderReputation.length
    + mailboxReputation.recipientReputation.length + (mailboxReputation.sendingHealth ? 1 : 0);
  const externalMailCount = externalMail.messages.length;

  return {
    json: JSON.stringify(snapshot),
    vaultCount: vault.length,
    walletsCount: wallets.length,
    mailboxCount, projectsCount, tasksCount, financeCount, walletHubCount, activityCount, entityCoverageCount, emergencyAccessCount,
    accountExtrasCount, teamCount, earningCount, backupSystemCount, emailAccountsCount, mailboxReputationCount, externalMailCount,
  };
}