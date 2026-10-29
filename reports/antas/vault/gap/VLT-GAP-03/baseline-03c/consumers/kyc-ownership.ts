import type { Request, Response } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { pepDecisionObserver } from "../../middlewares/auth";
import { requireOwnership } from "../../lib/policy/pep/middleware";
import type { ResourceRefBuilder } from "../../lib/policy/pep/types";
import { KYC_ENTRY_OWNER_SENTINEL_NONE, KYC_DATA_ENTITY_OWNER_SENTINEL_NONE } from "../domain/kyc";

/**
 * KYC entry / KYC data-entity ownership resource builders and PEP wiring.
 * Extracted verbatim from routes/kyc.ts and routes/kyc-data-entities.ts
 * (VLT-GAP-03-B). Each route keeps its own deny body, so `onDeny` stays
 * parameterized: 404 "Not found" (GET), 404 "Not found or forbidden"
 * (PUT / PATCH status), and a quiet `{ success: true }` no-op on DELETE — a
 * 404 there would newly reveal "that id exists, just not yours".
 */

// `kyc_entries` has one owner column (`user_id`) — plain single-owner
// shape, matching this file's own parameterized `sql` tagged-template
// style (not `sql.raw`).
// Exported (C19B) so exchange-api.ts's `PATCH /kyc-entries/:id/exchange-keys`
// — same `kyc_entries` table, same `user_id` owner column, previously left
// unwired when the rest of the KYC routes were gated in C19A — can
// reuse this instead of hand-rolling a second copy.
export const kycEntryResource: ResourceRefBuilder = async (req: Request) => {
  const id = parseInt(req.params.id as string);
  if (Number.isNaN(id)) return { type: "kyc_entry", id: req.params.id, ownerId: KYC_ENTRY_OWNER_SENTINEL_NONE };
  const result = await db.execute(sql`SELECT user_id FROM kyc_entries WHERE id = ${id} LIMIT 1`);
  const row = result.rows[0] as any;
  return { type: "kyc_entry", id, ownerId: row?.user_id ?? KYC_ENTRY_OWNER_SENTINEL_NONE };
};
export function requireKycEntryOwnership(action: string, onDeny: (req: Request, res: Response) => void) {
  return requireOwnership(action, kycEntryResource, { onDecision: pepDecisionObserver, onDeny });
}

// `kyc_data_entities` has one owner column (`user_id`) — plain
// single-owner shape, distinct from the `vault_entries` table the data-entity
// repository only reads (for the used/unused computation), so this is outside
// `vault.ts`'s Season B reservation, not part of it.
export const kycDataEntityResource: ResourceRefBuilder = async (req: Request) => {
  const id = parseInt(req.params.id as string);
  if (Number.isNaN(id)) return { type: "kyc_data_entity", id: req.params.id, ownerId: KYC_DATA_ENTITY_OWNER_SENTINEL_NONE };
  const result = await db.execute(sql.raw(`SELECT user_id FROM kyc_data_entities WHERE id = ${id} LIMIT 1`));
  const row = result.rows[0] as any;
  return { type: "kyc_data_entity", id, ownerId: row?.user_id ?? KYC_DATA_ENTITY_OWNER_SENTINEL_NONE };
};
export function requireKycDataEntityOwnership(action: string, onDeny: (req: Request, res: Response) => void) {
  return requireOwnership(action, kycDataEntityResource, { onDecision: pepDecisionObserver, onDeny });
}

export const denyKycNotFound = (_req: Request, res: Response) => { res.status(404).json({ error: "Not found" }); };
export const denyKycNotFoundOrForbidden = (_req: Request, res: Response) => { res.status(404).json({ error: "Not found or forbidden" }); };
export const denyKycSilentSuccess = (_req: Request, res: Response) => { res.json({ success: true }); };
