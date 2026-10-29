import { Router } from "express";
import { requireAuth } from "../middlewares/auth";
import { denyVaultShareNotFound, requireVaultShareOwnership } from "../vault/security/share-ownership";
import { bulkCreateShares, bulkDeleteShares, bulkUpdateShares, createShare, deleteShare, getEntityAccess, listReceivedShares, listSentShares, listShareableFields, updateShare } from "../vault/application/share/use-cases";

const router = Router();

// VLT-GAP-13: every handler is a thin delegating adapter. Auth middleware, the ownership gate,
// id/param parsing and response mapping stay here; validation, SQL (via the share repository),
// notifications, domain events and the bulk-ownership audits live in
// vault/application/share/use-cases with bodies unchanged from the pre-extraction route
// (see VLT-GAP-10). "Access moves, ownership never does" is preserved there.

// ─── POST /vault-shares — share an owned entity with another user ─────────
// body: { entityType, entityId, username, permission? ('view'|'edit') }
router.post("/vault-shares", requireAuth, async (req, res): Promise<void> => {
  const r = await createShare(req.user!.userId, req.body);
  res.status(r.status).json(r.body);
});

// ─── GET /vault-shares/fields/:entityType — shareable field list for the UI ──
// Lets the frontend build a per-field permission picker without hardcoding
// each entity type's column list (which does vary — local/entity/kyc/game
// each have a different shape).
router.get("/vault-shares/fields/:entityType", requireAuth, async (req, res): Promise<void> => {
  const r = await listShareableFields(req.params.entityType as string);
  res.status(r.status).json(r.body);
});

// ─── POST /vault-shares/bulk — share multiple entities (same or mixed
// types) with one user in a single call. Each item is checked for
// ownership independently — one bad item doesn't fail the whole batch.
// body: { items: [{ entityType, entityId }, ...], username, permission? }
router.post("/vault-shares/bulk", requireAuth, async (req, res): Promise<void> => {
  const r = await bulkCreateShares(req.user!.userId, req, req.body);
  res.status(r.status).json(r.body);
});

// ─── GET /vault-shares/sent — entities I own that I've shared out ─────────
router.get("/vault-shares/sent", requireAuth, async (req, res): Promise<void> => {
  const r = await listSentShares(req.user!.userId, req.query.entityType as string | undefined);
  res.status(r.status).json(r.body);
});

// ─── GET /vault-shares/received — entities shared with me ─────────────────
router.get("/vault-shares/received", requireAuth, async (req, res): Promise<void> => {
  const activeOnly = req.query.activeOnly !== "false"; // default true
  const r = await listReceivedShares(req.user!.userId, req.query.entityType as string | undefined, activeOnly);
  res.status(r.status).json(r.body);
});

// ─── GET /vault-shares/entity/:entityType/:entityId — fetch the actual data
// for a shared entity. Allowed if the requester owns it, OR has an active
// share on it. This is the read path a recipient uses; it never changes
// user_id on the underlying row.
router.get("/vault-shares/entity/:entityType/:entityId", requireAuth, async (req, res): Promise<void> => {
  const r = await getEntityAccess(req.user!.userId, req.params.entityType as string, parseInt(req.params.entityId as string, 10));
  res.status(r.status).json(r.body);
});

// ─── PATCH /vault-shares/bulk — toggle isActive/permission on many shares
// at once. Must be registered before "/vault-shares/:id" so "bulk" isn't
// matched as an :id.
// body: { ids: number[], isActive?: boolean, permission?: 'view'|'edit' }
router.patch("/vault-shares/bulk", requireAuth, async (req, res): Promise<void> => {
  const r = await bulkUpdateShares(req.user!.userId, req, req.body);
  res.status(r.status).json(r.body);
});

// ─── DELETE /vault-shares/bulk — remove many share records at once ────────
// Registered before "/vault-shares/:id" for the same reason as above.
// body: { ids: number[] }
router.delete("/vault-shares/bulk", requireAuth, async (req, res): Promise<void> => {
  const r = await bulkDeleteShares(req.user!.userId, req, req.body);
  res.status(r.status).json(r.body);
});

// ─── PATCH /vault-shares/:id — owner toggles access on/off, or changes permission
// Setting isActive to false is the "turn permission off" action — the item
// immediately stops showing up under the recipient's "shared with me" list.
router.patch("/vault-shares/:id", requireAuth, requireVaultShareOwnership("vault_share.update", denyVaultShareNotFound), async (req, res): Promise<void> => {
  const r = await updateShare(req.user!.userId, parseInt(req.params.id as string, 10), req.body);
  res.status(r.status).json(r.body);
});

// ─── DELETE /vault-shares/:id — owner removes the share record entirely ───
router.delete("/vault-shares/:id", requireAuth, requireVaultShareOwnership("vault_share.delete", denyVaultShareNotFound), async (req, res): Promise<void> => {
  const r = await deleteShare(req.user!.userId, parseInt(req.params.id as string, 10));
  res.status(r.status).json(r.body);
});

export default router;
