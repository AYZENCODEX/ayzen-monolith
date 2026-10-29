import { ENTITY_TABLES, ENTITY_TYPE_TO_RESOURCE_TYPE, isValidType } from "../infrastructure/repositories/share-entity-types";
import { PolicyEngine } from "../../lib/policy/policy-engine";
import { type Request, type Response } from "express";
import { type ResourceRef } from "../../lib/policy/types";
import { type ResourceRefBuilder } from "../../lib/policy/pep/types";
import { authorizeMany } from "../../lib/policy/pep";
import { createResourceOwnershipRule } from "../../lib/policy/resource";
import { pepDecisionObserver } from "../../middlewares/auth";
import { requireOwnership } from "../../lib/policy/pep/middleware";
import { executeSqlForAuditVaultShareCreateOwnership, executeVaultSharesForAuditVaultShareBulkOwnership, executeVaultSharesForVaultShareResource } from "../infrastructure/repositories/vault-share-repository";

/** Extracted verbatim from the pre-extraction route (VLT-GAP-10); bodies unchanged. */

// ─── Route Integration Roadmap — Season C, Phase C23 (mechanical sweep) ────
// `vault_shares` has its own plain `owner_id` column — simple single-owner
// shape, same "second, PDP-routed, audited decision on top of an unchanged
// existing query" treatment as everywhere else in this series. Only
// `PATCH`/`DELETE /vault-shares/:id` are in scope — both already share the
// same deny body (`404 "Not found or not yours to manage"`), so one
// resource builder + wrapper covers both. This file's own queries are
// written with `sql.raw`, but — same as every other new resource lookup
// this series has added (see kyc.ts/local-accounts.ts) — the builder below
// uses parameterized `sql` instead, since it's new code with no reason to
// take on the string-interpolated style.
//
// `PATCH`/`DELETE /vault-shares/bulk` were NOT touched here — their
// ownership pre-filter was already baked directly into each query
// (`... AND owner_id = ${userId}`), the same C13 `authorizeMany()`-shaped
// bulk pattern flagged in the roadmap as a decision for a future bulk-
// family sweep. That sweep is Phase C27 — see the block below.
export const VAULT_SHARE_OWNER_SENTINEL_NONE = -1;
export const vaultShareResource: ResourceRefBuilder = async (req: Request) => {
  const id = parseInt(req.params.id as string, 10);
  if (!Number.isFinite(id)) return { type: "vault_share", id: req.params.id, ownerId: VAULT_SHARE_OWNER_SENTINEL_NONE };
  const rows = (await executeVaultSharesForVaultShareResource(id)).rows as any[];
  return { type: "vault_share", id, ownerId: rows[0]?.owner_id ?? VAULT_SHARE_OWNER_SENTINEL_NONE };
};
export function requireVaultShareOwnership(action: string, onDeny: (req: Request, res: Response) => void) {
  return requireOwnership(action, vaultShareResource, { onDecision: pepDecisionObserver, onDeny });
}
export const denyVaultShareNotFound = (_req: Request, res: Response) => { res.status(404).json({ error: "Not found or not yours to manage" }); };
// ─── Route Integration Roadmap — Season C, Phase C27 (bulk-family
// policy-engine consistency sweep) ────────────────────────────────────────
// All three `/vault-shares/bulk` routes were already correctly scoped (raw
// SQL/query-builder ownership filters, per-item, exactly like every other
// route in this file) — this phase does NOT change any of that filtering.
// What it adds is the same `authorizeMany()`/`pepDecisionObserver` audit
// trail `bulk.ts` just got, so each bulk request's per-item allow/deny is a
// real, centrally observable `AuthorizationDecision` instead of only a
// WHERE clause no PDP ever saw — same posture as `ayzen-mailbox.ts`'s
// `PATCH /mailbox/bulk` (Phase C13).
//
// `PATCH`/`DELETE /vault-shares/bulk` both operate on `vault_shares` rows
// themselves (single resource shape, `vault_share`/`owner_id`) — one
// dedicated engine, reused by both.
export const vaultShareBulkOwnershipEngine = new PolicyEngine({ onDecision: pepDecisionObserver });
vaultShareBulkOwnershipEngine.registerRule("resource-ownership", createResourceOwnershipRule());
/**
 * Fetches each candidate vault_shares row's REAL owner_id — NOT filtered by
 * the caller's own userId — and runs one `authorizeMany()` batch over them
 * purely to produce an audited `AuthorizationDecision` per id. The route's
 * own pre-existing query (still filtered by owner_id, unchanged by this
 * phase) is what actually decides which rows get touched; this only makes
 * that same decision visible to the PDP/audit trail. Call for its audit
 * side-effect only — its return value is intentionally discarded.
 */
export async function auditVaultShareBulkOwnership(req: Request, ids: number[], action: string): Promise<void> {
  if (!ids.length) return;
  const candidates = (await executeVaultSharesForAuditVaultShareBulkOwnership(ids)).rows as any[];
  if (!candidates.length) return;
  await authorizeMany<number>({
    req,
    engine: vaultShareBulkOwnershipEngine,
    action,
    items: candidates.map((row): { key: number; resource: ResourceRef } => ({
      key: Number(row.id),
      resource: { type: "vault_share", id: Number(row.id), ownerId: row.owner_id != null ? Number(row.owner_id) : undefined },
    })),
  });
}
// `POST /vault-shares/bulk` creates NEW shares, so there's no `vault_share`
// row to check ownership of yet — what needs auditing is ownership of the
// underlying entity being shared (`local_account` / `vault_entry` /
// `kyc_entry` / `game_entry`, per `item.entityType`), which is exactly what
// this route's existing per-item `ownedCheck` query already establishes.
// One shared engine covers all four types — `createResourceOwnershipRule()`
// only ever compares `resource.ownerId` to the subject, so it's the same
// rule regardless of which table `ownerId` came from (see that rule's own
// header). Reuses the resource-type strings already established for these
// tables elsewhere (`local-accounts.ts`, `vault-entity-links.ts`, `kyc.ts`,
// `game-entries.ts`) so decisions correlate with those files' own audit
// trail rather than inventing a fifth naming scheme.
export const vaultShareCandidateOwnershipEngine = new PolicyEngine({ onDecision: pepDecisionObserver });
vaultShareCandidateOwnershipEngine.registerRule("resource-ownership", createResourceOwnershipRule());
/**
 * Batches ownership-audit lookups for a `POST /vault-shares/bulk` request:
 * one grouped `SELECT id, user_id FROM {table} WHERE id IN (...)` query per
 * distinct `entityType` present in `items` (never one query per item), then
 * a single `authorizeMany()` call across every item regardless of type.
 * Only items with a syntactically valid `entityType`/`entityId` are
 * included — the route's own loop already re-validates and re-checks
 * ownership per item afterward via `ownedCheck`; this is audit-only and
 * changes nothing about which items actually get shared.
 */
export async function auditVaultShareCreateOwnership(
  req: Request,
  items: { entityType: unknown; entityId: unknown }[],
): Promise<void> {
  const byType = new Map<keyof typeof ENTITY_TABLES, number[]>();
  for (const item of items) {
    const entityType = item?.entityType;
    const entityId = parseInt(item?.entityId as string, 10);
    if (!isValidType(entityType) || isNaN(entityId)) continue;
    const list = byType.get(entityType) ?? [];
    list.push(entityId);
    byType.set(entityType, list);
  }
  if (!byType.size) return;

  const authItems: { key: string; resource: ResourceRef; action: string }[] = [];
  for (const [entityType, ids] of byType) {
    const cfg = ENTITY_TABLES[entityType];
    const resourceType = ENTITY_TYPE_TO_RESOURCE_TYPE[entityType];
    const candidates = (await executeSqlForAuditVaultShareCreateOwnership(cfg, ids)).rows as any[];
    for (const row of candidates) {
      authItems.push({
        key: `${entityType}:${row.id}`,
        resource: { type: resourceType, id: Number(row.id), ownerId: row.user_id != null ? Number(row.user_id) : undefined },
        action: `${resourceType}.share.create`,
      });
    }
  }
  if (!authItems.length) return;
  await authorizeMany<string>({ req, engine: vaultShareCandidateOwnershipEngine, items: authItems });
}