import { norm, vaultKey, walletKey, rawRowKey, dataEntityKey, emailAccountKey, type RestoreTableKey, type RawTablePlan } from "../../domain/snapshot-restore-keys";
import { existingVaultKeys, insertVaultRow, existingWalletKeys, insertWalletRow, existingRawKeys, insertRawRow, existingTemplateKeys, insertTemplateRow, existingMessageKeys, insertMessageRow, existingDataEntityKeys, insertDataEntityRow, existingEmailAccountKeys, insertEmailAccountRow, type DbHandle } from "../../infrastructure/repositories/snapshot-restore-repository";
import { defaultDb } from "../../infrastructure/db-handle";

export interface RestoreTableDiff {
  table: RestoreTableKey;
  label: string;
  totalInSnapshot: number;
  toAdd: number;
  alreadyPresent: number;
  /** Up to 5 non-sensitive display labels of rows that would be added. Never contains credentials. */
  sample: string[];
}

export interface RestorePreview {
  exportedAt: string | null;
  tables: RestoreTableDiff[];
  totalToAdd: number;
}

export interface RestoreApplyResult {
  restored: number;
  skipped: number;
  errors: { table: RestoreTableKey; index: number; reason: string }[];
  byTable: Record<RestoreTableKey, { restored: number }>;
}

const RAW_PLANS: RawTablePlan[] = [
  {
    table: "localAccounts", sqlTable: "local_accounts", label: "Local Accounts",
    keyColumns: ["category", "username", "email"],
    displayColumns: ["username", "email", "label", "category"],
    excludeOnInsert: ["id", "user_id", "vault_entry_id", "receipt_token", "created_at", "updated_at"],
  },
  {
    table: "kycEntries", sqlTable: "kyc_entries", label: "KYC Entities",
    keyColumns: ["category", "platform", "username", "email"],
    displayColumns: ["platform", "username", "email", "category"],
    excludeOnInsert: ["id", "user_id", "data_entity_id", "created_at", "updated_at"],
  },
  {
    table: "gameEntries", sqlTable: "game_entries", label: "Game Entities",
    keyColumns: ["category", "username", "email"],
    displayColumns: ["username", "email", "category"],
    excludeOnInsert: ["id", "user_id", "created_at", "updated_at"],
  },
  // ─── Feature 15d additions ────────────────────────────────────────────
  {
    table: "mailboxFolders", sqlTable: "ayzen_mailbox_folders", label: "Mail Folders",
    keyColumns: ["name"], displayColumns: ["name"],
    excludeOnInsert: ["id", "user_id", "created_at"],
  },
  {
    table: "mailboxLabels", sqlTable: "ayzen_mailbox_labels", label: "Mail Labels",
    keyColumns: ["name"], displayColumns: ["name"],
    excludeOnInsert: ["id", "user_id", "created_at"],
  },
  {
    table: "mailboxRules", sqlTable: "ayzen_mailbox_rules", label: "Mail Rules",
    keyColumns: ["name"], displayColumns: ["name"],
    // action_label_id/action_folder_id point at label/folder rows whose ids
    // may not match after a folder/label was itself just re-created above —
    // dropped on insert rather than risk pointing at the wrong (or no)
    // target; the rule still restores with its match condition intact.
    excludeOnInsert: ["id", "user_id", "created_at", "action_label_id", "action_folder_id"],
  },
  {
    table: "mailboxContacts", sqlTable: "ayzen_contacts", label: "Mail Contacts",
    keyColumns: ["email"], displayColumns: ["name", "email"],
    excludeOnInsert: ["id", "user_id", "created_at"],
  },
  {
    table: "taskSubmissions", sqlTable: "task_submissions", label: "Task Submissions",
    // entity_id kept in the identity key (still useful to distinguish two
    // submissions of the same task against different entities pre-restore)
    // but NEVER copied on insert (see excludeOnInsert) — see the comment
    // below for why.
    keyColumns: ["task_id", "entity_id", "submitted_at"],
    displayColumns: ["notes", "task_id"],
    // entity_id / entity_ids / cost_entries all point at vault_entries rows
    // by id. A merge-restored Vault Entity always gets a brand-new id
    // (insertVaultRow() never preserves the original), so copying these
    // verbatim from an old snapshot would silently reattach the restored
    // submission to whatever entity now happens to hold that old id (or to
    // nothing, if it's been deleted) — the same "no safe remap yet"
    // situation valueHistory/entityLinks/sharesOwned are already excluded
    // for elsewhere in this file. All three are nullable, so dropping them
    // just restores the submission itself (status/proof/notes/cost/profit)
    // without a stale entity link, rather than failing the whole row.
    excludeOnInsert: ["id", "user_id", "receipt_token", "entity_id", "entity_ids", "cost_entries"],
  },
  {
    table: "userProjects", sqlTable: "user_projects", label: "Joined Protocols",
    keyColumns: ["project_id"], displayColumns: ["project_id"],
    excludeOnInsert: ["id", "user_id", "joined_at"],
  },
  // projectEnrollments (project_enrollments) is intentionally NOT a RAW_PLAN
  // here, unlike userProjects above — see the "NOT auto-restored" comment on
  // `projectEnrollments` in routes/vault-snapshot.ts's buildVaultSnapshotPayload.
  // Its vault_entry_id is NOT NULL and, like task_submissions.entity_id
  // above, points at a vault_entries row whose id changes on merge-restore;
  // unlike entity_id there's no nullable fallback here — excluding
  // vault_entry_id on insert would fail the NOT NULL constraint on every
  // single row, and copying it verbatim would silently attach the
  // restored enrollment to the wrong entity. kyc_entry_id/data_entity_id
  // have the exact same unremappable-id problem. So this table stays
  // backed up for reference (still exported, still shown in the JSON) but
  // is never auto-merge-restored — same treatment as entityCoverage.
  {
    table: "projectRatings", sqlTable: "project_ratings", label: "Protocol Ratings",
    keyColumns: ["project_id"], displayColumns: ["project_id"],
    excludeOnInsert: ["id", "user_id", "created_at", "updated_at"],
  },
  {
    table: "builtinWalletTokens", sqlTable: "builtin_wallet_tokens", label: "Built-in Wallet Tokens",
    keyColumns: ["symbol"], displayColumns: ["symbol"],
    excludeOnInsert: ["id", "user_id", "created_at", "updated_at"],
  },
  {
    // chain + tx_hash + log_index is the table's own real DB uniqueness
    // constraint (see schema/chain-deposits.ts), so this identity key can't
    // false-collide the way the heuristic keys above can.
    table: "chainDeposits", sqlTable: "chain_deposits", label: "Chain Deposits",
    keyColumns: ["chain", "tx_hash", "log_index"], displayColumns: ["token_symbol", "amount", "chain"],
    excludeOnInsert: ["id", "user_id", "created_at", "confirmed_at"],
  },
];

// DR Evidence Collector Phase 2 (dr-evidence-collector-design.md §2, the
// verification-suite record-count step): the physical (snake_case) table
// name behind every RestoreTableKey applyRestoreDiff() can write to, so
// lib/dr-test-runner.ts can SELECT COUNT(*) against the isolated schema
// without duplicating this table/key mapping itself. Built from the same
// RAW_PLANS config above plus the two non-RAW_PLANS tables (vault, wallets)
// that go through the drizzle-typed insertVaultRow()/insertWalletRow()
// paths instead.
export const RESTORE_TABLE_SQL_NAMES: Record<RestoreTableKey, string> = {
  vault: "vault_entries",
  wallets: "wallets",
  // mailboxTemplates/mailboxMessages/kycDataEntities aren't in RAW_PLANS —
  // they insert through their own dedicated helpers (insertTemplateRow /
  // insertMessageRow / insertDataEntityRow above, for their re-encryption
  // step) rather than the generic raw-row path, so their physical table
  // names are listed here by hand instead.
  mailboxTemplates: "ayzen_mailbox_templates",
  mailboxMessages: "ayzen_mailbox_messages",
  kycDataEntities: "kyc_data_entities",
  emailAccounts: "email_accounts",
  ...Object.fromEntries(RAW_PLANS.map(p => [p.table, p.sqlTable])),
} as Record<RestoreTableKey, string>;
function rawRowDisplay(row: Record<string, any>, displayColumns: string[]): string {
  for (const c of displayColumns) if (row[c]) return String(row[c]);
  return "(unnamed entry)";
}

// ─── Mail Templates (needs body_html re-encrypted on insert) ─────────────
function templateKey(row: any): string {
  return norm(row.name);
}

// ─── Mail Messages (needs text_body/html_body re-encrypted on insert) ────
// Identity key prefers the RFC message_id (stable, provider-assigned); a
// draft with no message_id yet can never collide, so it's always restored
// as "new" rather than silently dropped.
function messageKey(row: any): string {
  return norm(row.message_id);
}

// ─── Diff (preview) ──────────────────────────────────────────────────────
export async function buildRestoreDiff(userId: number, snapshot: any): Promise<RestorePreview> {
  const tables: RestoreTableDiff[] = [];


  {
    const entries: any[] = Array.isArray(snapshot.vault) ? snapshot.vault : [];
    const existing = await existingVaultKeys(userId);
    const toAdd = entries.filter(e => { const k = vaultKey(e); return !k || !existing.has(k); });
    tables.push({
      table: "vault", label: "Vault Entities",
      totalInSnapshot: entries.length, toAdd: toAdd.length, alreadyPresent: entries.length - toAdd.length,
      sample: toAdd.slice(0, 5).map(e => e.projectName || "(unnamed entry)"),
    });
  }

  {
    const entries: any[] = Array.isArray(snapshot.wallets) ? snapshot.wallets : [];
    const existing = await existingWalletKeys(userId);
    const toAdd = entries.filter(e => { const k = walletKey(e); return !k || !existing.has(k); });
    tables.push({
      table: "wallets", label: "Wallets",
      totalInSnapshot: entries.length, toAdd: toAdd.length, alreadyPresent: entries.length - toAdd.length,
      sample: toAdd.slice(0, 5).map(e => `${e.label || e.chain || "Wallet"} · ${String(e.address ?? "").slice(0, 10)}…`),
    });
  }

  for (const plan of RAW_PLANS) {
    const entries: any[] = Array.isArray(snapshot[plan.table]) ? snapshot[plan.table] : [];
    const existing = await existingRawKeys(plan.sqlTable, plan.keyColumns, userId);
    const toAdd = entries.filter(e => { const k = rawRowKey(e, plan.keyColumns); return !k || !existing.has(k); });
    tables.push({
      table: plan.table, label: plan.label,
      totalInSnapshot: entries.length, toAdd: toAdd.length, alreadyPresent: entries.length - toAdd.length,
      sample: toAdd.slice(0, 5).map(e => rawRowDisplay(e, plan.displayColumns)),
    });
  }

  {
    const entries: any[] = Array.isArray(snapshot.mailboxTemplates) ? snapshot.mailboxTemplates : [];
    const existing = await existingTemplateKeys(userId);
    const toAdd = entries.filter(e => { const k = templateKey(e); return !k || !existing.has(k); });
    tables.push({
      table: "mailboxTemplates", label: "Mail Templates",
      totalInSnapshot: entries.length, toAdd: toAdd.length, alreadyPresent: entries.length - toAdd.length,
      sample: toAdd.slice(0, 5).map(e => e.name || "(unnamed template)"),
    });
  }

  {
    const entries: any[] = Array.isArray(snapshot.mailboxMessages) ? snapshot.mailboxMessages : [];
    const existing = await existingMessageKeys(userId);
    const toAdd = entries.filter(e => { const k = messageKey(e); return !k || !existing.has(k); });
    tables.push({
      table: "mailboxMessages", label: "Mail Messages",
      totalInSnapshot: entries.length, toAdd: toAdd.length, alreadyPresent: entries.length - toAdd.length,
      sample: toAdd.slice(0, 5).map(e => e.subject || "(no subject)"),
    });
  }

  {
    const entries: any[] = Array.isArray(snapshot.kycDataEntities) ? snapshot.kycDataEntities : [];
    const existing = await existingDataEntityKeys(userId);
    const toAdd = entries.filter(e => { const k = dataEntityKey(e); return !k || !existing.has(k); });
    tables.push({
      table: "kycDataEntities", label: "KYC Data Entities",
      totalInSnapshot: entries.length, toAdd: toAdd.length, alreadyPresent: entries.length - toAdd.length,
      sample: toAdd.slice(0, 5).map(e => e.name || "(unnamed identity record)"),
    });
  }

  {
    const entries: any[] = Array.isArray(snapshot.emailAccounts) ? snapshot.emailAccounts : [];
    const existing = await existingEmailAccountKeys(userId);
    const toAdd = entries.filter(e => { const k = emailAccountKey(e); return !k || !existing.has(k); });
    tables.push({
      table: "emailAccounts", label: "Connected Mail Accounts",
      totalInSnapshot: entries.length, toAdd: toAdd.length, alreadyPresent: entries.length - toAdd.length,
      sample: toAdd.slice(0, 5).map(e => e.label || e.email_address || "(unnamed mail account)"),
    });
  }

  return {
    exportedAt: typeof snapshot.exportedAt === "string" ? snapshot.exportedAt : null,
    tables,
    totalToAdd: tables.reduce((s, t) => s + t.toAdd, 0),
  };
}

// ─── Apply (merge restore) ───────────────────────────────────────────────
export interface ApplyRestoreDiffOptions {
  // DR Evidence Collector Phase 2: pass an isolated-schema drizzle instance
  // (see lib/dr-test-db.ts) to restore into `dr_test_<run_id>` instead of
  // production. Omitted (or undefined) on every existing caller — the real
  // POST /vault/snapshot/restore route — which keeps using the production
  // `db` singleton exactly as before.
  dbOverride?: DbHandle;
}

/**
 * VLT-GAP-19: runs one row insert inside a SAVEPOINT. Each insert below is wrapped in try/catch so a bad row is skipped and recorded,
 * but without a savepoint the first failed statement aborts the whole Postgres transaction: every later insert fails, COMMIT silently
 * rolls everything back, and the response still reported the rows inserted before the failure as restored. With a savepoint only the
 * failing row is rolled back and the transaction stays usable, so `restored` always equals what is committed.
 * (A handle without nested-transaction support runs the insert directly, as before.)
 */
function rowSavepoint(tx: any, fn: (sp: any) => Promise<void>): Promise<void> {
  return typeof tx.transaction === "function" ? tx.transaction(fn) : fn(tx);
}

export async function applyRestoreDiff(userId: number, snapshot: any, opts: ApplyRestoreDiffOptions = {}): Promise<RestoreApplyResult> {
  const activeDb = opts.dbOverride ?? defaultDb;
  const errors: RestoreApplyResult["errors"] = [];
  const byTable: RestoreApplyResult["byTable"] = {
    vault: { restored: 0 }, wallets: { restored: 0 },
    localAccounts: { restored: 0 }, kycEntries: { restored: 0 }, gameEntries: { restored: 0 },
    mailboxFolders: { restored: 0 }, mailboxLabels: { restored: 0 }, mailboxRules: { restored: 0 },
    mailboxTemplates: { restored: 0 }, mailboxContacts: { restored: 0 }, mailboxMessages: { restored: 0 },
    taskSubmissions: { restored: 0 }, userProjects: { restored: 0 },
    projectRatings: { restored: 0 },
    builtinWalletTokens: { restored: 0 }, chainDeposits: { restored: 0 },
    kycDataEntities: { restored: 0 },
    emailAccounts: { restored: 0 },
  };

  // ASSUMPTION 2 — see file header — about db.transaction() support. Runs
  // against activeDb (production `db`, or the isolated-schema override) so
  // a DR test's restore is fully atomic within its own throwaway schema
  // too, not just in production.
  await activeDb.transaction(async (tx) => {
    const vaultEntries: any[] = Array.isArray(snapshot.vault) ? snapshot.vault : [];
    const existingVault = await existingVaultKeys(userId, activeDb);
    for (let i = 0; i < vaultEntries.length; i++) {
      const entry = vaultEntries[i];
      const k = vaultKey(entry);
      if (k && existingVault.has(k)) continue;
      if (!entry.projectName) { errors.push({ table: "vault", index: i, reason: "Missing projectName" }); continue; }
      try {
        await rowSavepoint(tx, (sp) => insertVaultRow(sp as any, userId, entry));
        byTable.vault.restored++;
        if (k) existingVault.add(k);
      } catch (err: any) {
        errors.push({ table: "vault", index: i, reason: err?.message ?? "Insert failed" });
      }
    }

    const wallets: any[] = Array.isArray(snapshot.wallets) ? snapshot.wallets : [];
    const existingWallets = await existingWalletKeys(userId, activeDb);
    for (let i = 0; i < wallets.length; i++) {
      const entry = wallets[i];
      const k = walletKey(entry);
      if (k && existingWallets.has(k)) continue;
      if (!entry.address) { errors.push({ table: "wallets", index: i, reason: "Missing address" }); continue; }
      try {
        await rowSavepoint(tx, (sp) => insertWalletRow(sp as any, userId, entry));
        byTable.wallets.restored++;
        if (k) existingWallets.add(k);
      } catch (err: any) {
        errors.push({ table: "wallets", index: i, reason: err?.message ?? "Insert failed" });
      }
    }

    for (const plan of RAW_PLANS) {
      const entries: any[] = Array.isArray(snapshot[plan.table]) ? snapshot[plan.table] : [];
      const existing = await existingRawKeys(plan.sqlTable, plan.keyColumns, userId, activeDb);
      for (let i = 0; i < entries.length; i++) {
        const row = entries[i];
        const k = rawRowKey(row, plan.keyColumns);
        if (k && existing.has(k)) continue;
        try {
          await rowSavepoint(tx, (sp) => insertRawRow(sp as any, plan, userId, row));
          byTable[plan.table].restored++;
          if (k) existing.add(k);
        } catch (err: any) {
          errors.push({ table: plan.table, index: i, reason: err?.message ?? "Insert failed" });
        }
      }
    }

    const templates: any[] = Array.isArray(snapshot.mailboxTemplates) ? snapshot.mailboxTemplates : [];
    const existingTemplates = await existingTemplateKeys(userId, activeDb);
    for (let i = 0; i < templates.length; i++) {
      const entry = templates[i];
      const k = templateKey(entry);
      if (k && existingTemplates.has(k)) continue;
      if (!entry.name) { errors.push({ table: "mailboxTemplates", index: i, reason: "Missing name" }); continue; }
      try {
        await rowSavepoint(tx, (sp) => insertTemplateRow(sp as any, userId, entry));
        byTable.mailboxTemplates.restored++;
        if (k) existingTemplates.add(k);
      } catch (err: any) {
        errors.push({ table: "mailboxTemplates", index: i, reason: err?.message ?? "Insert failed" });
      }
    }

    const messages: any[] = Array.isArray(snapshot.mailboxMessages) ? snapshot.mailboxMessages : [];
    const existingMessages = await existingMessageKeys(userId, activeDb);
    for (let i = 0; i < messages.length; i++) {
      const entry = messages[i];
      const k = messageKey(entry);
      if (k && existingMessages.has(k)) continue;
      try {
        await rowSavepoint(tx, (sp) => insertMessageRow(sp as any, userId, entry));
        byTable.mailboxMessages.restored++;
        if (k) existingMessages.add(k);
      } catch (err: any) {
        errors.push({ table: "mailboxMessages", index: i, reason: err?.message ?? "Insert failed" });
      }
    }

    const dataEntities: any[] = Array.isArray(snapshot.kycDataEntities) ? snapshot.kycDataEntities : [];
    const existingDataEntities = await existingDataEntityKeys(userId, activeDb);
    for (let i = 0; i < dataEntities.length; i++) {
      const entry = dataEntities[i];
      const k = dataEntityKey(entry);
      if (k && existingDataEntities.has(k)) continue;
      if (!entry.name) { errors.push({ table: "kycDataEntities", index: i, reason: "Missing name" }); continue; }
      try {
        await rowSavepoint(tx, (sp) => insertDataEntityRow(sp as any, userId, entry));
        byTable.kycDataEntities.restored++;
        if (k) existingDataEntities.add(k);
      } catch (err: any) {
        errors.push({ table: "kycDataEntities", index: i, reason: err?.message ?? "Insert failed" });
      }
    }

    const emailAccounts: any[] = Array.isArray(snapshot.emailAccounts) ? snapshot.emailAccounts : [];
    const existingEmailAccounts = await existingEmailAccountKeys(userId, activeDb);
    for (let i = 0; i < emailAccounts.length; i++) {
      const entry = emailAccounts[i];
      const k = emailAccountKey(entry);
      if (k && existingEmailAccounts.has(k)) continue;
      if (!entry.email_address) { errors.push({ table: "emailAccounts", index: i, reason: "Missing email_address" }); continue; }
      try {
        await rowSavepoint(tx, (sp) => insertEmailAccountRow(sp as any, userId, entry));
        byTable.emailAccounts.restored++;
        if (k) existingEmailAccounts.add(k);
      } catch (err: any) {
        errors.push({ table: "emailAccounts", index: i, reason: err?.message ?? "Insert failed" });
      }
    }
  });

  const restored = Object.values(byTable).reduce((s, t) => s + t.restored, 0);
  return { restored, skipped: errors.length, errors: errors.slice(0, 100), byTable };
}
