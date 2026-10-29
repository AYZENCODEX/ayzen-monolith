/**
 * Snapshot-restore identity keys and column plans. Extracted verbatim from application/snapshot/restore.ts (VLT-GAP-12-B)
 * so the persistence helpers in infrastructure/repositories/snapshot-restore-repository.ts can use them without
 * infrastructure depending on application.
 */

export type RestoreTableKey =
  | "vault" | "wallets" | "localAccounts" | "kycEntries" | "gameEntries"
  | "mailboxFolders" | "mailboxLabels" | "mailboxRules" | "mailboxTemplates" | "mailboxContacts" | "mailboxMessages"
  // projectEnrollments deliberately excluded — see the comment above its
  // (removed) RAW_PLANS entry: vault_entry_id is NOT NULL and unremappable,
  // so it's reference-only, never auto-merge-restored.
  | "taskSubmissions" | "userProjects" | "projectRatings"
  | "builtinWalletTokens" | "chainDeposits" | "kycDataEntities" | "emailAccounts";

// ─── Raw-SQL tables (localAccounts / kycEntries / gameEntries) ────────────
export interface RawTablePlan {
  table: RestoreTableKey;
  sqlTable: string;
  label: string;
  keyColumns: string[];       // snake_case columns making up the identity key
  displayColumns: string[];   // snake_case columns to build the preview label from, in priority order
  excludeOnInsert: string[];  // snake_case columns never copied over
}

export const norm = (v: unknown): string => (v === null || v === undefined ? "" : String(v).trim().toLowerCase());

// ─── Vault entities ──────────────────────────────────────────────────────
export function vaultKey(row: any): string {
  return norm(row.projectName);
}

// ─── Wallets ─────────────────────────────────────────────────────────────
export function walletKey(row: any): string {
  const chain = norm(row.chain), address = norm(row.address);
  return address ? `${chain}|${address}` : "";
}

export function rawRowKey(row: Record<string, any>, keyColumns: string[]): string {
  const parts = keyColumns.map(c => norm(row[c]));
  return parts.some(Boolean) ? parts.join("|") : "";
}

// ─── KYC Data Entities (needs nid_number re-encrypted on insert) ─────────
// Feature 15h. Identity key deliberately avoids nid_number (encrypted at
// rest — existingDataEntityKeys() below reads straight from the DB without
// decrypting) and uses the other identity fields instead, same approach as
// the RAW_PLANS keys above never using an encrypted column.
export function dataEntityKey(row: any): string {
  const parts = [norm(row.name), norm(row.father_name), norm(row.birth_date)];
  return parts.some(Boolean) ? parts.join("|") : "";
}

// ─── Email Accounts (needs password/auth_key re-encrypted on insert) ──────
// Feature 15v. Identity key is email_address + protocol per user —
// deliberately never password/auth_key (encrypted at rest), same
// never-key-off-an-encrypted-column rule dataEntityKey/templateKey follow
// above. team_id is deliberately dropped on insert (see
// EMAIL_ACCOUNT_INSERT_COLS — it's not in the list, so every restored row
// lands as a personal account, teamId null): re-attaching a restored row to
// a team automatically would grant that team's *current* active members
// visibility into a decrypted credential the backup owner captured for
// their own disaster recovery, not for redistribution, and would do so
// without anyone at the team explicitly choosing it — same "a Settings
// decision, not something a restore should do for you" reasoning
// gatherBackupSystemSnapshot's doc comment gives elsewhere in this file.
// is_default is dropped for the same reason mailboxRules drops its
// label/folder id references: a raw insert bypasses the app's own
// "only one default at a time" logic (routes/email-accounts.ts), so a
// restored row always comes back as non-default rather than risking two
// rows both flagged default, or silently displacing whichever one the
// account is actually configured to use today.
export function emailAccountKey(row: any): string {
  const email = norm(row.email_address), protocol = norm(row.protocol);
  return email ? `${email}|${protocol}` : "";
}

export const MESSAGE_INSERT_COLS = [
  "direction", "folder", "is_draft", "resend_email_id", "message_id", "in_reply_to",
  "references_header", "thread_id", "from_addr", "to_addr", "cc_addr", "bcc_addr",
  "subject", "text_body", "html_body", "has_attachments", "is_read", "is_starred",
  "forwarded_to", "received_at",
];

export const DATA_ENTITY_INSERT_COLS = ["nid_number", "name", "father_name", "birth_date", "photo1_url", "photo2_url", "notes"];

export const EMAIL_ACCOUNT_INSERT_COLS = [
  "label", "email_address", "protocol", "provider", "imap_host", "imap_port",
  "smtp_host", "smtp_port", "username", "password", "auth_key", "session_pooler",
  "use_ssl", "notes", "tags",
];
