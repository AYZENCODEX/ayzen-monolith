import { syncOnVaultStatusChange, delistVaultMarketplaceListings } from "../../../services/sync";
import { selectVaultOne } from "../../infrastructure/repositories/entity-repository";
import { BULK_ALLOWED_STATUSES } from "../../domain/entity/fields";
import { VAULT_TRASH_RETENTION_DAYS } from "../../infrastructure/trash/entry-trash-purge";
import { logVaultActivity } from "./activity";
import { formatVaultEntry as formatRow } from "./representation";
import type { EntityResult } from "./lifecycle";
import { updateVaultEntriesForBulkTagEntities, updateVaultEntriesForBulkActionEntities2, updateVaultEntriesForBulkActionEntities3 } from "../../infrastructure/repositories/entity-bulk-repository";

/**
 * Bulk entity operations (tag / status / soft-delete). Extracted verbatim from
 * routes/vault.ts (VLT-GAP-01-D). The PEP audit step needs the Express request,
 * so it is injected as a port (the route binds `req`); the broadcaster likewise.
 */
export interface EntityBulkDeps {
  broadcastEvent: (event: string, data?: Record<string, unknown>) => void;
  auditBulkOwnership: (ids: number[], action: string) => Promise<void>;
}

// ─── Route Integration Roadmap — Season C, Phase C27 (bulk-family
// policy-engine consistency sweep) ────────────────────────────────────────
// `PATCH /vault/bulk-tag` and `PATCH /vault/bulk-action` were already
// correctly scoped — every per-id write below already goes through
// Drizzle's `and(eq(vaultEntriesTable.id, id), eq(vaultEntriesTable.userId,
// userId))`, same posture as the raw-SQL `WHERE ... AND user_id = ...`
// routes in `bulk.ts`/`vault-shares.ts`. This phase does not change that —
// it adds the same `authorizeMany()`/`pepDecisionObserver` audit trail
// those files' bulk routes just got, using the vault_entries table's own
// `vault_entry` resource type (`vault-entity-links.ts`, C21) so decisions
// here correlate with every other vault_entry PEP check in the codebase.
// Both routes loop per-id already (never one batched UPDATE), so the audit
// step runs once up front over the full id list, then the existing per-id
// loop proceeds completely unchanged.
// ─── PATCH /vault/bulk-tag — add or remove a tag across multiple entries ─────
export async function bulkTagEntities(userId: number, body: any, deps: EntityBulkDeps): Promise<EntityResult> {
  const { ids, tag, action } = body as { ids?: number[]; tag?: string; action?: "add" | "remove" };

  if (!Array.isArray(ids) || ids.length === 0) { return { status: 400, body: { error: "ids (non-empty array) is required" } }; }
  if (!tag || !String(tag).trim()) { return { status: 400, body: { error: "tag is required" } }; }
  const op = action === "remove" ? "remove" : "add";
  const cleanTag = String(tag).trim();

  const cleanIdsForAudit = ids.map(Number).filter(Number.isFinite);
  await deps.auditBulkOwnership(cleanIdsForAudit, `vault_entry.bulk.tag.${op}`);

  const results: { id: number; ok: boolean }[] = [];
  for (const rawId of ids) {
    const id = Number(rawId);
    if (!Number.isFinite(id)) { results.push({ id: rawId as number, ok: false }); continue; }
    try {
      const raw = await selectVaultOne(id, userId);
      if (!raw) { results.push({ id, ok: false }); continue; }
      const formatted = formatRow(raw);
      const current: string[] = Array.isArray((formatted as any).tags) ? (formatted as any).tags : [];
      const next = op === "add"
        ? Array.from(new Set([...current, cleanTag]))
        : current.filter(t => t !== cleanTag);
      await updateVaultEntriesForBulkTagEntities(next, id, userId);
      results.push({ id, ok: true });
    } catch {
      results.push({ id, ok: false });
    }
  }

  deps.broadcastEvent("vault_updated", { action: "bulk_tagged", entryIds: ids });
  return { status: 200, body: { tag: cleanTag, action: op, results } };
}

// ─── PATCH /vault/bulk-action — generic multi-select action (tag/status/delete) ─
// Single entry point for the vault.tsx selection action-bar. `action: "tag"`
// mirrors /vault/bulk-tag above (kept separately for backward compat — nothing
// else calls it, so this just avoids duplicating that logic inline). Every
// path is per-id + best-effort, same pattern as bulk-tag: one bad/missing id
// doesn't abort the rest of the batch, and the response reports per-id results
// so the client can tell the user "8 of 10 succeeded" instead of a flat pass/fail.
export async function bulkActionEntities(userId: number, body: any, deps: EntityBulkDeps): Promise<EntityResult> {
  const { ids, action } = body as { ids?: number[]; action?: "tag" | "status" | "delete" };

  if (!Array.isArray(ids) || ids.length === 0) { return { status: 400, body: { error: "ids (non-empty array) is required" } }; }
  if (ids.length > 200) { return { status: 400, body: { error: "Max 200 ids per bulk action" } }; }
  const cleanIds = ids.map(Number).filter(Number.isFinite);
  if (cleanIds.length === 0) { return { status: 400, body: { error: "No valid ids" } }; }

  if (action === "tag") {
    const { tag, tagAction } = body as { tag?: string; tagAction?: "add" | "remove" };
    if (!tag || !String(tag).trim()) { return { status: 400, body: { error: "tag is required" } }; }
    const op = tagAction === "remove" ? "remove" : "add";
    const cleanTag = String(tag).trim();

    await deps.auditBulkOwnership(cleanIds, `vault_entry.bulk.tag.${op}`);

    const results: { id: number; ok: boolean }[] = [];
    for (const id of cleanIds) {
      try {
        const raw = await selectVaultOne(id, userId);
        if (!raw) { results.push({ id, ok: false }); continue; }
        const formatted = formatRow(raw);
        const current: string[] = Array.isArray((formatted as any).tags) ? (formatted as any).tags : [];
        const next = op === "add" ? Array.from(new Set([...current, cleanTag])) : current.filter(t => t !== cleanTag);
        await updateVaultEntriesForBulkTagEntities(next, id, userId);
        results.push({ id, ok: true });
      } catch {
        results.push({ id, ok: false });
      }
    }
    deps.broadcastEvent("vault_updated", { action: "bulk_tagged", entryIds: cleanIds });
    return { status: 200, body: { action: "tag", results } };
    
  }

  if (action === "status") {
    const { status } = body as { status?: string };
    if (!status || !BULK_ALLOWED_STATUSES.has(status)) {
      return { status: 400, body: { error: `status must be one of: ${Array.from(BULK_ALLOWED_STATUSES).join(", ")}` } };
      
    }

    await deps.auditBulkOwnership(cleanIds, "vault_entry.bulk.update_status");

    const results: { id: number; ok: boolean }[] = [];
    for (const id of cleanIds) {
      try {
        const [row] = await updateVaultEntriesForBulkActionEntities2(status, id, userId);
        if (!row) { results.push({ id, ok: false }); continue; }
        logVaultActivity(id, userId, "status_changed", `→ ${status}`);
        syncOnVaultStatusChange(id, status).catch(() => {});
        results.push({ id, ok: true });
      } catch {
        results.push({ id, ok: false });
      }
    }
    deps.broadcastEvent("vault_updated", { action: "bulk_status", entryIds: cleanIds, status });
    return { status: 200, body: { action: "status", status, results } };
    
  }

  if (action === "delete") {
    // Soft-delete, same as DELETE /vault/:id — bulk delete shouldn't skip the
    // recycle bin just because it's going through a different route.
    await deps.auditBulkOwnership(cleanIds, "vault_entry.bulk.delete");

    const results: { id: number; ok: boolean }[] = [];
    for (const id of cleanIds) {
      try {
        const [row] = await updateVaultEntriesForBulkActionEntities3(id, userId);
        if (!row) { results.push({ id, ok: false }); continue; }
        logVaultActivity(id, userId, "trashed");
        delistVaultMarketplaceListings(id, "vault_entry_trashed").catch(() => {});
        results.push({ id, ok: true });
      } catch {
        results.push({ id, ok: false });
      }
    }
    deps.broadcastEvent("vault_updated", { action: "bulk_trashed", entryIds: cleanIds });
    return { status: 200, body: { action: "delete", results, retentionDays: VAULT_TRASH_RETENTION_DAYS } };
    
  }

  return { status: 400, body: { error: "action must be one of: tag, status, delete" } };
}
