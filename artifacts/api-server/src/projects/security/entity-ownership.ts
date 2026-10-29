/**
 * projects/security/entity-ownership.ts
 * PEP wiring for vault-entry ownership inside Projects (Route Integration Season D, Phase D7 audit trail, promoted
 * to a blocking gate in Season E, Phase E3). Moved as-is from routes/projects.ts in PRJ-05; behavior is frozen.
 *
 * - `requireProjectsVaultEntryOwnership` is the blocking gate on `GET /projects/entity/:vaultEntryId/overview` and
 *   `POST /projects/:id/enroll`. `vaultEntryId` comes from `req.params.vaultEntryId` or `req.body.vaultEntryId`.
 * - `auditProjectsOwnership` with `kycEntryAuditEngine` is the audit-only decision for the OPTIONAL `kycEntryId`
 *   body field of the enroll flow. It must stay an inline, conditional call (a router-level gate runs for every
 *   request and cannot skip itself when the field is absent); the return value is discarded.
 * - The vault entry's real owner is re-fetched unfiltered by caller, so a genuine mismatch shows up as a DENY
 *   rather than a tautological ALLOW.
 */
import type { Request, Response } from "express";
import { pepDecisionObserver } from "../../middlewares/auth";
import { requireOwnership } from "../../lib/policy/pep/middleware";
import { authorize } from "../../lib/policy/pep";
import type { ResourceRefBuilder } from "../../lib/policy/pep/types";
import type { ResourceRef } from "../../lib/policy/types";
import { PolicyEngine } from "../../lib/policy/policy-engine";
import { createResourceOwnershipRule } from "../../lib/policy/resource";
import { emptyEntityOverview } from "../domain/entity-overview";
import { findVaultEntryOwnerId } from "../infrastructure/repositories/vault-entries-reader";

const PROJECTS_OWNER_SENTINEL_NONE = -1;

export const vaultEntryOwnerResource: ResourceRefBuilder = async (req: Request) => {
  const raw = req.params.vaultEntryId ?? (req.body as { vaultEntryId?: number | string })?.vaultEntryId;
  const id = parseInt(Array.isArray(raw) ? raw[0] : String(raw), 10);
  if (!Number.isFinite(id)) return { type: "vault_entry", id: raw as any, ownerId: PROJECTS_OWNER_SENTINEL_NONE };
  const ownerId = await findVaultEntryOwnerId(id);
  return { type: "vault_entry", id, ownerId: ownerId ?? PROJECTS_OWNER_SENTINEL_NONE };
};

export function requireProjectsVaultEntryOwnership(action: string, onDeny: (req: Request, res: Response) => void) {
  return requireOwnership(action, vaultEntryOwnerResource, { onDecision: pepDecisionObserver, onDeny });
}

/**
 * `GET /projects/entity/:vaultEntryId/overview` replied 200 with an empty/null-shaped body for a non-owned or
 * nonexistent id before it was gated (the queries were scoped by user id, so a mismatch returned no rows, never a 404);
 * the gate's `onDeny` reproduces that exact shape.
 */
export function projectEntityOverviewSilentDeny(req: Request, res: Response): void {
  const raw = Array.isArray(req.params.vaultEntryId) ? req.params.vaultEntryId[0] : req.params.vaultEntryId;
  const vaultEntryId = parseInt(raw as string, 10);
  res.json(emptyEntityOverview(vaultEntryId));
}

export const kycEntryAuditEngine = new PolicyEngine({ onDecision: pepDecisionObserver });
kycEntryAuditEngine.registerRule("resource-ownership", createResourceOwnershipRule());

/** Fire only for the audit side effect: every call site discards the return value. */
export async function auditProjectsOwnership(req: Request, engine: PolicyEngine, action: string, resource: ResourceRef): Promise<void> {
  await authorize({ req, engine, action, resource });
}
