import type { Request, Response } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { pepDecisionObserver } from "../../middlewares/auth";
import { requireOwnership } from "../../lib/policy/pep/middleware";
import type { ResourceRefBuilder } from "../../lib/policy/pep/types";

/**
 * Local account ownership / resource builders and PEP wiring. Extracted
 * verbatim from routes/local-accounts.ts (VLT-GAP-02-B), including the
 * Season C (C15/C16/C22) behavior notes below.
 *
 * Response bodies vary because they were never following one convention:
 * "Not found or forbidden" (PUT, PATCH .../status), "Not found" (link-vault,
 * unlink-vault), "Account not found" (GET /:id, receipt routes) — each `onDeny`
 * is parameterized to keep its own route's exact pre-existing body.
 *
 * Two routes don't error at all on a non-owned id — `DELETE /:id` replies
 * `{ success: true }` whether or not a row matched (same for `GET /:id/points`,
 * which returns an empty list). The deny path replies with that same "quiet
 * no-op" body, NOT a 404 — a 404 would newly reveal "that id exists, just not
 * yours".
 */
const LOCAL_ACCOUNT_OWNER_SENTINEL_NONE = -1;

const localAccountResource: ResourceRefBuilder = async (req: Request) => {
  const id = parseInt(req.params.id as string, 10);
  if (!Number.isFinite(id)) return { type: "local_account", id: req.params.id, ownerId: LOCAL_ACCOUNT_OWNER_SENTINEL_NONE };
  const rows = (await db.execute(sql`SELECT user_id FROM local_accounts WHERE id = ${id} LIMIT 1`)).rows as any[];
  return { type: "local_account", id, ownerId: rows[0]?.user_id ?? LOCAL_ACCOUNT_OWNER_SENTINEL_NONE };
};

// Exported (C22) — value-history.ts's own two `/local-accounts/:id/...` routes
// need this exact table/owner shape. Already parameterized by `onDeny`.
export function requireLocalAccountOwnership(action: string, onDeny: (req: Request, res: Response) => void) {
  return requireOwnership(action, localAccountResource, { onDecision: pepDecisionObserver, onDeny });
}

export const denyNotFoundOrForbidden = (_req: Request, res: Response) => { res.status(404).json({ error: "Not found or forbidden" }); };
export const denyNotFound = (_req: Request, res: Response) => { res.status(404).json({ error: "Not found" }); };
export const denyAccountNotFound = (_req: Request, res: Response) => { res.status(404).json({ error: "Account not found" }); };
export const denySilentSuccess = (_req: Request, res: Response) => { res.json({ success: true }); };
export const denyEmptyPoints = (_req: Request, res: Response) => { res.json({ entries: [], total: 0 }); };

// `local_account_category` and `local_account_point` each have their own
// id-space and their own `user_id` owner column, distinct from `local_accounts`
// itself — same silent-success shape as `DELETE /:id`, so the same quiet no-op deny.
const LOCAL_ACCOUNT_CATEGORY_OWNER_SENTINEL_NONE = -1;
const localAccountCategoryResource: ResourceRefBuilder = async (req: Request) => {
  const id = parseInt(req.params.id as string, 10);
  if (!Number.isFinite(id)) return { type: "local_account_category", id: req.params.id, ownerId: LOCAL_ACCOUNT_CATEGORY_OWNER_SENTINEL_NONE };
  const rows = (await db.execute(sql`SELECT user_id FROM local_account_categories WHERE id = ${id} LIMIT 1`)).rows as any[];
  return { type: "local_account_category", id, ownerId: rows[0]?.user_id ?? LOCAL_ACCOUNT_CATEGORY_OWNER_SENTINEL_NONE };
};
export function requireLocalAccountCategoryOwnership(action: string) {
  return requireOwnership(action, localAccountCategoryResource, { onDecision: pepDecisionObserver, onDeny: denySilentSuccess });
}

const LOCAL_ACCOUNT_POINT_OWNER_SENTINEL_NONE = -1;
const localAccountPointResource: ResourceRefBuilder = async (req: Request) => {
  const id = parseInt(req.params.pointId as string, 10);
  if (!Number.isFinite(id)) return { type: "local_account_point", id: req.params.pointId, ownerId: LOCAL_ACCOUNT_POINT_OWNER_SENTINEL_NONE };
  const rows = (await db.execute(sql`SELECT user_id FROM local_account_points WHERE id = ${id} LIMIT 1`)).rows as any[];
  return { type: "local_account_point", id, ownerId: rows[0]?.user_id ?? LOCAL_ACCOUNT_POINT_OWNER_SENTINEL_NONE };
};
export function requireLocalAccountPointOwnership(action: string) {
  return requireOwnership(action, localAccountPointResource, { onDecision: pepDecisionObserver, onDeny: denySilentSuccess });
}
