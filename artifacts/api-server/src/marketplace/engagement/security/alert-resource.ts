/**
 * marketplace/engagement/security/alert-resource.ts
 * MKT-05c: the PEP resource builder of routes/marketplace-alerts.ts, moved verbatim. `marketplace_alerts` has one owner
 * column (`user_id`); an id that is not a number, or no row, maps to the sentinel owner -1 (nobody), which the route turns
 * into the same 404 body it always answered.
 */
import type { Request } from "express";
import type { ResourceRefBuilder } from "../../../lib/policy/pep/types";

export const ALERT_OWNER_SENTINEL_NONE = -1;

export function createAlertResourceBuilder(repo: { findAlertOwner(id: number): Promise<any[]> }): ResourceRefBuilder {
  return async (req: Request) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return { type: "marketplace_alert", id: req.params.id, ownerId: ALERT_OWNER_SENTINEL_NONE };
    const rows = await repo.findAlertOwner(id);
    return { type: "marketplace_alert", id, ownerId: rows[0]?.user_id ?? ALERT_OWNER_SENTINEL_NONE };
  };
}
