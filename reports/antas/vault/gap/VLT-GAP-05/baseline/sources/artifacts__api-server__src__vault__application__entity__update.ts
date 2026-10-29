import { db, vaultEntriesTable, vaultFieldHistoryTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { syncOnVaultUpdate, syncOnVaultStatusChange } from "../../../services/sync";
import { encryptField, decryptField } from "../../crypto/field-encryption";
import { encryptSeedPhrase } from "../../crypto/seed-phrase";
import { SENSITIVE_VAULT_FIELDS } from "../../domain/secret-fields";
import { NEW_VAULT_FIELDS, BASE_VAULT_FIELDS, DATE_FIELDS, SINGLE_FIELD_EDITABLE, fieldLabel } from "../../domain/entity/fields";
import { logVaultActivity } from "./activity";
import { formatVaultEntry as formatRow } from "./representation";
import type { EntityResult } from "./lifecycle";

/**
 * Entity update use-cases (whole-entry PATCH, single-field PATCH with commit
 * history, and the field-history read). Extracted verbatim from routes/vault.ts
 * (VLT-GAP-01-D). Broadcaster, local-account bridge (GAP-02) and health runner
 * (GAP-11) are injected as ports so their owners can move independently.
 */
export interface EntityUpdateDeps {
  broadcastEvent: (event: string, data?: Record<string, unknown>) => void;
  autoCreateLocalAccounts: (userId: number, vaultEntryId: number, body: Record<string, unknown>) => Promise<void>;
  runHealthCheck: (id: number, userId: number, recalcScore: boolean) => Promise<void>;
}

// ─── PATCH /vault/:id — update vault entry ───────────────────────────────────
export async function updateEntity(userId: number, idParam: string | string[], body: any, deps: EntityUpdateDeps): Promise<EntityResult> {
  const id = parseInt(Array.isArray(idParam) ? idParam[0] : idParam, 10);

  const baseFields = BASE_VAULT_FIELDS;
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  for (const f of baseFields) {
    if (body[f] !== undefined) updates[f] = SENSITIVE_VAULT_FIELDS.has(f) ? encryptField(body[f]) : body[f];
  }
  for (const f of NEW_VAULT_FIELDS) {
    if (body[f] === undefined) continue;
    if (DATE_FIELDS.has(f)) { updates[f] = body[f] ? new Date(body[f]) : null; continue; }
    updates[f] = SENSITIVE_VAULT_FIELDS.has(f) ? encryptField(body[f]) : body[f];
  }
  if (body.followers !== undefined) {
    const n = Number(body.followers);
    if (Number.isFinite(n)) updates.followers = Math.max(0, Math.round(n));
  }
  if (body.dataEntityId !== undefined) {
    updates.dataEntityId = body.dataEntityId ? Number(body.dataEntityId) : null;
  }
  if (body.walletAddresses !== undefined) updates.walletAddresses = JSON.stringify(body.walletAddresses);
  if (body.backupCodes !== undefined) updates.backupCodes = encryptField(JSON.stringify(body.backupCodes));
  if (body.tags !== undefined) updates.tags = JSON.stringify(Array.isArray(body.tags) ? body.tags : []);
  if (body.otherAccounts !== undefined) updates.otherAccounts = encryptField(body.otherAccounts);
  if (body.seedPhrase !== undefined) {
    updates.encryptedSeedPhrase = body.seedPhrase ? encryptSeedPhrase(body.seedPhrase) : null;
  }
  if (body.status !== undefined) {
    const allowed = ["active", "warning", "banned", "suspended"];
    if (allowed.includes(body.status)) {
      updates.status = body.status;
      updates.lastActivityAt = new Date();
    }
  }
  if (body.score !== undefined) {
    const n = Number(body.score);
    if (Number.isFinite(n)) updates.score = Math.max(0, Math.min(10, Math.round(n)));
  }
  if (body.currentValue !== undefined) {
    const n = Number(body.currentValue);
    if (Number.isFinite(n)) updates.currentValue = n;
  }
  if (body.currentBuyValue !== undefined) {
    const n = Number(body.currentBuyValue);
    if (Number.isFinite(n)) updates.currentBuyValue = n;
  }

  let entry: Record<string, unknown>;
  try {
    const [row] = await db.update(vaultEntriesTable)
      .set(updates as Partial<typeof vaultEntriesTable.$inferInsert>)
      .where(and(eq(vaultEntriesTable.id, id), eq(vaultEntriesTable.userId, userId)))
      .returning();
    if (!row) { return { status: 404, body: { error: "Vault entry not found" } }; }
    entry = row as unknown as Record<string, unknown>;
  } catch {
    // Strip new fields and retry with base fields only
    for (const f of NEW_VAULT_FIELDS) delete updates[f];
    delete updates.encryptedSeedPhrase;
    delete updates.status;
    delete updates.lastActivityAt;
    delete updates.followers;
    delete updates.tags;
    delete updates.lastHealthAlertAt;
    delete updates.lastHealthFlags;
    const [row] = await db.update(vaultEntriesTable)
      .set(updates as Partial<typeof vaultEntriesTable.$inferInsert>)
      .where(and(eq(vaultEntriesTable.id, id), eq(vaultEntriesTable.userId, userId)))
      .returning();
    if (!row) { return { status: 404, body: { error: "Vault entry not found" } }; }
    entry = row as unknown as Record<string, unknown>;
  }

  deps.broadcastEvent("vault_updated", { action: "updated", entryId: id });
  deps.autoCreateLocalAccounts(userId, id, body).catch(() => {});
  // Health Monitor: auto-recalculate score (unless the client sent one explicitly)
  // and check health rules, firing a notification only for newly-triggered issues.
  deps.runHealthCheck(id, userId, body.score === undefined).catch(() => {});
  if (body.status !== undefined) {
    logVaultActivity(id, userId, "status_changed", `→ ${body.status}`);
    // Sync: propagate status change to marketplace (auto-delist if banned/suspended)
    syncOnVaultStatusChange(id, body.status).catch(() => {});
  } else {
    logVaultActivity(id, userId, "updated");
    // Sync: refresh stale marketplace listing previews for this entry
    syncOnVaultUpdate(id).catch(() => {});
  }
  return { status: 200, body: formatRow(entry) };
}

// ─── PATCH /vault/:id/field — update exactly one field, with commit history ──
// Powers the per-field "Change" button on the entity detail page (per
// platform tab, per field): edit one credential/value in place instead of
// the whole multi-tab form. Body: { field: string, value: unknown }. The
// old → new value is recorded in vault_field_history — see
// GET /vault/:id/field-history for the commit log this powers.
export async function updateEntityField(userId: number, idParam: string | string[], body: any, deps: EntityUpdateDeps): Promise<EntityResult> {
  const id = parseInt(Array.isArray(idParam) ? idParam[0] : idParam, 10);

  const { field, value } = body as { field?: string; value?: unknown };
  if (!field || !SINGLE_FIELD_EDITABLE.has(field)) {
    return { status: 400, body: { error: "Unknown or non-editable field" } }; 
  }

  const [existing] = await db.select().from(vaultEntriesTable)
    .where(and(eq(vaultEntriesTable.id, id), eq(vaultEntriesTable.userId, userId)));
  if (!existing) { return { status: 404, body: { error: "Vault entry not found" } }; }

  const isSensitive = SENSITIVE_VAULT_FIELDS.has(field);
  const isDate = DATE_FIELDS.has(field);
  const isFollowers = field === "followers";

  let columnValue: unknown;
  let newDisplay: string | null;
  if (isDate) {
    columnValue = value ? new Date(value as string) : null;
    newDisplay = columnValue ? (columnValue as Date).toISOString() : null;
  } else if (isFollowers) {
    const n = Number(value);
    if (!Number.isFinite(n)) { return { status: 400, body: { error: "followers must be a number" } }; }
    columnValue = Math.max(0, Math.round(n));
    newDisplay = String(columnValue);
  } else {
    const plain = value === "" || value == null ? null : String(value);
    columnValue = isSensitive ? encryptField(plain) : plain;
    newDisplay = plain;
  }

  // Old value, decrypted/formatted the same way the entity's own read path
  // (formatRow) would show it, so the commit-history entry is readable.
  const oldRaw = (existing as unknown as Record<string, unknown>)[field];
  let oldDisplay: string | null;
  if (isSensitive) oldDisplay = decryptField((oldRaw ?? null) as string | null);
  else if (isDate) oldDisplay = oldRaw ? new Date(oldRaw as string).toISOString() : null;
  else oldDisplay = oldRaw != null ? String(oldRaw) : null;

  try {
    const [row] = await db.update(vaultEntriesTable)
      .set({ [field]: columnValue, updatedAt: new Date() } as Partial<typeof vaultEntriesTable.$inferInsert>)
      .where(and(eq(vaultEntriesTable.id, id), eq(vaultEntriesTable.userId, userId)))
      .returning();
    if (!row) { return { status: 404, body: { error: "Vault entry not found" } }; }

    // Commit history — old/new values encrypted at rest (same helper as the
    // live column), decrypted only for the owner on GET /vault/:id/field-history.
    db.insert(vaultFieldHistoryTable).values({
      vaultEntryId: id, userId, field,
      oldValue: encryptField(oldDisplay),
      newValue: encryptField(newDisplay),
    }).catch((err) => console.error("vault field history log failed:", err));

    deps.broadcastEvent("vault_updated", { action: "field_updated", entryId: id, field });
    logVaultActivity(id, userId, "field_updated", `${fieldLabel(field)} changed`);
    deps.autoCreateLocalAccounts(userId, id, { [field]: value }).catch(() => {});
    deps.runHealthCheck(id, userId, true).catch(() => {});
    syncOnVaultUpdate(id).catch(() => {});

    return { status: 200, body: formatRow(row as unknown as Record<string, unknown>) };
  } catch (err: any) {
    return { status: 500, body: { error: "Unable to update field", detail: err?.message } };
  }
}

// ─── GET /vault/:id/field-history — per-field commit history (owner only) ───
// Query: ?field=twitterPassword to filter to one field's history, omit for
// the full per-field change feed on this entity. Newest first.
export async function listEntityFieldHistory(userId: number, idParam: string | string[], query: Record<string, unknown>): Promise<EntityResult> {
  const id = parseInt(Array.isArray(idParam) ? idParam[0] : idParam, 10);
  const fieldFilter = (query.field as string) || undefined;

  const [existing] = await db.select({ id: vaultEntriesTable.id }).from(vaultEntriesTable)
    .where(and(eq(vaultEntriesTable.id, id), eq(vaultEntriesTable.userId, userId)));
  if (!existing) { return { status: 404, body: { error: "Vault entry not found" } }; }

  try {
    const rows = await db.select().from(vaultFieldHistoryTable)
      .where(fieldFilter
        ? and(eq(vaultFieldHistoryTable.vaultEntryId, id), eq(vaultFieldHistoryTable.field, fieldFilter))
        : eq(vaultFieldHistoryTable.vaultEntryId, id))
      .orderBy(desc(vaultFieldHistoryTable.changedAt))
      .limit(200);
    return { status: 200, body: rows.map((r) => ({
      id: r.id,
      field: r.field,
      fieldLabel: fieldLabel(r.field),
      oldValue: decryptField(r.oldValue),
      newValue: decryptField(r.newValue),
      changedAt: r.changedAt.toISOString(),
    })) };
  } catch (err: any) {
    return { status: 500, body: { error: "Unable to load field history", detail: err?.message } };
  }
}
