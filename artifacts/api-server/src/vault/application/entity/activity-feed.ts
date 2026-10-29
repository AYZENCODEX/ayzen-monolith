import { selectVaultOne } from "../../infrastructure/repositories/entity-repository";
import type { EntityResult } from "./lifecycle";
import { executeVaultActivityLogForListMyVaultActivity, selectVaultActivityLogForListEntityActivity, selectVaultActivityLogForListMyVaultActivity } from "../../infrastructure/repositories/vault-activity-repository";

/** Entity activity read models (owner feed + per-entity trail). Extracted verbatim from routes/vault.ts (VLT-GAP-01-D). */

// ─── GET /vault/activity — my Vault activity feed (owner, paginated) ────────
// Powers the "Activity Log" item in the Vault sidebar (Other group) — every
// row is scoped to the current user's own vault_activity_log entries only
// (entity views + creates/updates/deletes/seed-reveals/status changes),
// distinct from GET /admin/vault/activity which is the admin-wide feed across
// every user. Joined with vault_entries so each row can show which entity
// ("page") was touched, not just an id.
// NOTE: must be registered before GET /vault/:id below — otherwise Express
// would match "activity" as the :id param and this route would never fire
// (same reason /vault/analytics/value-history above is also a static path
// registered ahead of the :id catch-all).
export async function listMyVaultActivity(userId: number, query: Record<string, unknown>): Promise<EntityResult> {
  const { page = "1", limit = "50" } = query as Record<string, string>;
  const pageNum = Math.max(parseInt(page, 10) || 1, 1);
  const limitNum = Math.min(parseInt(limit, 10) || 50, 200);
  const offset = (pageNum - 1) * limitNum;
  try {
    const rows = await selectVaultActivityLogForListMyVaultActivity(userId, limitNum, offset);

    const [{ count }] = await executeVaultActivityLogForListMyVaultActivity(userId).then(r => r.rows as { count: number }[]);

    return { status: 200, body: {
      entries: rows.map(({ log, entitySerial, entityId }) => ({
        ...log,
        createdAt: log.createdAt.toISOString(),
        entitySerial: entitySerial ?? null,
        entityId: entityId ?? null,
      })),
      total: count ?? rows.length,
      page: pageNum,
      limit: limitNum,
    } };
  } catch (err: any) {
    return { status: 500, body: { error: "Failed to fetch Vault activity", detail: err?.message } };
  }
}

// ─── GET /vault/:id/activity — audit trail for one vault entry (owner only) ──
export async function listEntityActivity(userId: number, idParam: string | string[]): Promise<EntityResult> {
  const id = parseInt(Array.isArray(idParam) ? idParam[0] : idParam, 10);
  const entry = await selectVaultOne(id, userId);
  if (!entry) { return { status: 404, body: { error: "Vault entry not found" } }; }
  try {
    const rows = await selectVaultActivityLogForListEntityActivity(id);
    return { status: 200, body: rows.map(r => ({ ...r, createdAt: r.createdAt.toISOString() })) };
  } catch (err: any) {
    return { status: 500, body: { error: "Failed to fetch activity log", detail: err?.message } };
  }
}
