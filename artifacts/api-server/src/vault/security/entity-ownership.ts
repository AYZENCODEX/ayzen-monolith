import type { Request, Response } from "express";
import { pepDecisionObserver } from "../../middlewares/auth";
import { requireOwnership } from "../../lib/policy/pep/middleware";
import { authorizeMany } from "../../lib/policy/pep";
import type { ResourceRef } from "../../lib/policy/types";
import { PolicyEngine } from "../../lib/policy/policy-engine";
import { createResourceOwnershipRule } from "../../lib/policy/resource";
import type { ResourceRefBuilder } from "../../lib/policy/pep/types";
import { VAULT_ENTRY_OWNER_SENTINEL_NONE, VAULT_ENTITY_LINK_OWNER_SENTINEL_NONE } from "../domain/entity-links";
import { selectVaultEntityLinksForVaultEntityLinkResource, selectVaultEntriesForAuditVaultBulkOwnership, selectVaultEntriesForVaultEntryResource } from "../infrastructure/repositories/entity-repository";

/**
 * Entity ownership / resource builders and PEP wiring. Extracted verbatim from
 * routes/vault-entity-links.ts and routes/vault.ts (VLT-GAP-01-B).
 */

export const vaultEntryResource: ResourceRefBuilder = async (req: Request) => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  if (!Number.isFinite(id)) return { type: "vault_entry", id: req.params.id, ownerId: VAULT_ENTRY_OWNER_SENTINEL_NONE };
  const [row] = await selectVaultEntriesForVaultEntryResource(id);
  return { type: "vault_entry", id, ownerId: row?.userId ?? VAULT_ENTRY_OWNER_SENTINEL_NONE };
};

export const vaultEntityLinkResource: ResourceRefBuilder = async (req: Request) => {
  const id = parseInt(req.params.id as string, 10);
  if (!Number.isFinite(id)) return { type: "vault_entity_link", id: req.params.id, ownerId: VAULT_ENTITY_LINK_OWNER_SENTINEL_NONE };
  const [row] = await selectVaultEntityLinksForVaultEntityLinkResource(id);
  return { type: "vault_entity_link", id, ownerId: row?.userId ?? VAULT_ENTITY_LINK_OWNER_SENTINEL_NONE };
};

/** Generic ownership gate; each caller keeps its own deny body. (from routes/vault.ts) */
export function requireVaultEntryOwnership(action: string, onDeny: (req: Request, res: Response) => void) {
  return requireOwnership(action, vaultEntryResource, { onDecision: pepDecisionObserver, onDeny });
}

/** Fixed-404 variant. (from routes/vault-entity-links.ts) */
export function requireVaultEntryOwnershipOr404(action: string) {
  return requireOwnership(action, vaultEntryResource, {
    onDecision: pepDecisionObserver,
    onDeny: (_req: Request, res: Response) => {
      res.status(404).json({ error: "Vault entry not found" });
    },
  });
}

export function requireVaultEntityLinkOwnership(action: string) {
  return requireOwnership(action, vaultEntityLinkResource, {
    onDecision: pepDecisionObserver,
    onDeny: (_req: Request, res: Response) => {
      res.status(404).json({ error: "Link not found" });
    },
  });
}

export const vaultBulkOwnershipEngine = new PolicyEngine({ onDecision: pepDecisionObserver });
vaultBulkOwnershipEngine.registerRule("resource-ownership", createResourceOwnershipRule());

/**
 * Fetches each candidate vault_entries row's REAL owner — NOT filtered by
 * the caller's own userId — and runs one `authorizeMany()` batch over them
 * purely to produce an audited `AuthorizationDecision` per id. The route's
 * own pre-existing per-id loop (still filtered by userId, unchanged by
 * this phase) is what actually decides which rows get touched; this only
 * makes that same decision visible to the PDP/audit trail. Call for its
 * audit side-effect only — its return value is intentionally discarded.
 */
export async function auditVaultBulkOwnership(req: Request, ids: number[], action: string): Promise<void> {
  if (!ids.length) return;
  const rows = await selectVaultEntriesForAuditVaultBulkOwnership(ids);
  if (!rows.length) return;
  await authorizeMany<number>({
    req,
    engine: vaultBulkOwnershipEngine,
    action,
    items: rows.map((row): { key: number; resource: ResourceRef } => ({
      key: Number(row.id),
      resource: { type: "vault_entry", id: Number(row.id), ownerId: row.userId != null ? Number(row.userId) : undefined },
    })),
  });
}
