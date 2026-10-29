import { db, vaultEntriesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { chargeCredits } from "../../../services/credit-meter";
import { delistVaultMarketplaceListings } from "../../../services/sync";
import { VAULT_TRASH_RETENTION_DAYS } from "../../../lib/vault-trash-purge";
import { formatVaultEntry as formatRow } from "./representation";
import { logVaultActivity } from "./activity";
import {
  selectVault, selectVaultOne, selectVaultTrash, selectVaultTrashOne, hardDeleteVaultEntry,
} from "../../infrastructure/repositories/entity-repository";

/**
 * Entity lifecycle use-cases (list / view / trash / restore / purge / tags).
 *
 * Extracted from routes/vault.ts (VLT-GAP-01-B). Queries, decision trees,
 * status codes, response bodies, side-effect order and best-effort semantics
 * are moved unchanged. Each use-case returns the {status, body} the route used
 * to write to `res`. The SSE broadcaster is injected as a port because it is
 * owned by the API layer (routes/events), which the application layer must not
 * import.
 */

export interface EntityResult { status: number; body: unknown }
export interface EntityLifecycleDeps {
  broadcastEvent: (event: string, data?: Record<string, unknown>) => void;
}


// GET /vault — list user's vault entries
export async function listEntities(userId: number): Promise<EntityResult> {
  const entries = await selectVault(userId);
  return { status: 200, body: entries.map(e => formatRow(e)) };
}

// GET /vault/trash
export async function listTrashedEntities(userId: number): Promise<EntityResult> {
  const entries = await selectVaultTrash(userId);
  return {
    status: 200,
    body: entries.map(e => {
      const row = formatRow(e);
      const deletedAt = row.deletedAt ? new Date(row.deletedAt as string) : null;
      const purgeAt = deletedAt ? new Date(deletedAt.getTime() + VAULT_TRASH_RETENTION_DAYS * 86400000).toISOString() : null;
      return { ...row, purgeAt };
    }),
  };
}

// GET /vault/:id — get single entry (credit balance gate stays route middleware)
export async function getEntity(userId: number, idParam: string | string[]): Promise<EntityResult> {
  const id = parseInt(Array.isArray(idParam) ? idParam[0] : idParam, 10);
  const entry = await selectVaultOne(id, userId);
  if (!entry) return { status: 404, body: { error: "Vault entry not found" } };
  // Page-access tracking for the Vault Activity Log — records that this
  // entity's detail page was opened. Best-effort, never blocks the response.
  const serial = (entry as any).entity_serial ?? (entry as any).entitySerial ?? undefined;
  logVaultActivity(id, userId, "viewed", serial);
  // Charge-on-success: only now that the entry was actually found/returned.
  // A 404 above never touches the ledger.
  const charge = await chargeCredits(userId, "sylo.vault_entity_view");
  return { status: 200, body: { ...formatRow(entry), _credits: charge.ok ? { charged: charge.charged, newBalance: charge.newBalance } : null } };
}

// DELETE /vault/trash — empty the whole trash for this user
export async function emptyTrash(userId: number, deps: EntityLifecycleDeps): Promise<EntityResult> {
  const trashed = await selectVaultTrash(userId);
  for (const row of trashed) {
    await hardDeleteVaultEntry(Number(row.id), userId);
  }
  deps.broadcastEvent("vault_updated", { action: "trash_emptied" });
  return { status: 200, body: { message: "Trash emptied", count: trashed.length } };
}

// DELETE /vault/:id — soft-delete: moves the entry to the recycle bin
export async function trashEntity(userId: number, idParam: string | string[], deps: EntityLifecycleDeps): Promise<EntityResult> {
  const id = parseInt(Array.isArray(idParam) ? idParam[0] : idParam, 10);
  const existing = await selectVaultOne(id, userId);
  if (!existing) return { status: 404, body: { message: "Vault entry not found" } };
  await db.update(vaultEntriesTable)
    .set({ deletedAt: new Date() })
    .where(and(eq(vaultEntriesTable.id, id), eq(vaultEntriesTable.userId, userId)));
  deps.broadcastEvent("vault_updated", { action: "trashed", entryId: id });
  logVaultActivity(id, userId, "trashed");
  // Delist from the marketplace right away. Deliberately NOT calling
  // syncOnVaultDelete() here: it also prunes entity_project_roi rows, which is
  // a real (unrecoverable) delete; that full sync only runs on the actual purge.
  delistVaultMarketplaceListings(id, "vault_entry_trashed").catch(() => {});
  return { status: 200, body: { message: "Vault entry moved to trash", retentionDays: VAULT_TRASH_RETENTION_DAYS } };
}

// POST /vault/:id/restore — pull an entry back out of the trash
export async function restoreEntity(userId: number, idParam: string | string[], deps: EntityLifecycleDeps): Promise<EntityResult> {
  const id = parseInt(Array.isArray(idParam) ? idParam[0] : idParam, 10);
  const trashed = await selectVaultTrashOne(id, userId);
  if (!trashed) return { status: 404, body: { message: "Trashed vault entry not found" } };
  await db.update(vaultEntriesTable)
    .set({ deletedAt: null })
    .where(and(eq(vaultEntriesTable.id, id), eq(vaultEntriesTable.userId, userId)));
  deps.broadcastEvent("vault_updated", { action: "restored", entryId: id });
  logVaultActivity(id, userId, "restored");
  return { status: 200, body: { message: "Vault entry restored" } };
}

// DELETE /vault/trash/:id — permanently purge one trashed entry
export async function purgeTrashedEntity(userId: number, idParam: string | string[], deps: EntityLifecycleDeps): Promise<EntityResult> {
  const id = parseInt(Array.isArray(idParam) ? idParam[0] : idParam, 10);
  const trashed = await selectVaultTrashOne(id, userId);
  if (!trashed) return { status: 404, body: { message: "Trashed vault entry not found" } };
  await hardDeleteVaultEntry(id, userId);
  deps.broadcastEvent("vault_updated", { action: "purged", entryId: id });
  return { status: 200, body: { message: "Vault entry permanently deleted" } };
}

// GET /vault/tags — distinct tags used by this user, for filter UI
export async function listEntityTags(userId: number): Promise<EntityResult> {
  try {
    const entries = await selectVault(userId);
    const set = new Set<string>();
    for (const e of entries) {
      const raw = (e as any).tags ?? (e as any).tags;
      if (!raw) continue;
      try {
        const arr = JSON.parse(raw as string);
        if (Array.isArray(arr)) for (const t of arr) if (typeof t === "string" && t.trim()) set.add(t.trim());
      } catch { /* skip malformed */ }
    }
    return { status: 200, body: { tags: Array.from(set).sort((a, b) => a.localeCompare(b)) } };
  } catch (err: any) {
    return { status: 500, body: { error: "Failed to fetch tags", detail: err?.message } };
  }
}
