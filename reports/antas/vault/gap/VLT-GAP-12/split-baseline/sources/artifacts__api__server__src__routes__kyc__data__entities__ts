import { Router } from "express";
import { requireAuth } from "../middlewares/auth";
import { requireKycDataEntityOwnership, denyKycNotFound, denyKycNotFoundOrForbidden, denyKycSilentSuccess } from "../vault/security/kyc-ownership";
import {
  listKycDataEntities, getKycDataEntityOverview, createKycDataEntity, getKycDataEntity, editKycDataEntity, removeKycDataEntity,
} from "../vault/application/kyc/data-entities";

/**
 * KYC data entities — HTTP adapter (VLT-GAP-03-B). Every handler only maps the
 * request onto a Vault use-case and sends its `{ status, body }`; persistence,
 * NID encryption, the used/unused computation and the delete link-guard live
 * in vault/application/kyc, vault/infrastructure and vault/security. Route
 * table (paths, order, middleware chains) is unchanged. A 200 is sent with a
 * bare `res.json` and every other status with `res.status(n).json`, exactly as
 * the inline handlers did.
 */
const router = Router();

// ─── GET /kyc-data-entities — list, optionally filtered by used/unused ───────
router.get("/kyc-data-entities", requireAuth, async (req, res): Promise<void> => {
  const out = await listKycDataEntities(req.user!.userId, { status: req.query.status });
  (out.status === 200 ? res : res.status(out.status)).json(out.body);
});

// ─── GET /kyc-data-entities/overview — roll-up stats for the Overview page ───
router.get("/kyc-data-entities/overview", requireAuth, async (req, res): Promise<void> => {
  const out = await getKycDataEntityOverview(req.user!.userId);
  (out.status === 200 ? res : res.status(out.status)).json(out.body);
});

// ─── POST /kyc-data-entities — create a data entity ───────────────────────────
router.post("/kyc-data-entities", requireAuth, async (req, res): Promise<void> => {
  const out = await createKycDataEntity(req.user!.userId, req.body);
  (out.status === 200 ? res : res.status(out.status)).json(out.body);
});

// ─── GET /kyc-data-entities/:id — fetch single data entity ───────────────────
router.get("/kyc-data-entities/:id", requireAuth, requireKycDataEntityOwnership("kyc_data_entity.read", denyKycNotFound), async (req, res): Promise<void> => {
  const out = await getKycDataEntity(req.user!.userId, req.params.id);
  (out.status === 200 ? res : res.status(out.status)).json(out.body);
});

// ─── PUT /kyc-data-entities/:id — update a data entity ────────────────────────
router.put("/kyc-data-entities/:id", requireAuth, requireKycDataEntityOwnership("kyc_data_entity.update", denyKycNotFoundOrForbidden), async (req, res): Promise<void> => {
  const out = await editKycDataEntity(req.user!.userId, req.params.id, req.body);
  (out.status === 200 ? res : res.status(out.status)).json(out.body);
});

// ─── DELETE /kyc-data-entities/:id — delete a data entity ─────────────────────
// Blocked while a KYC entity OR a Vault entity is still linked.
router.delete("/kyc-data-entities/:id", requireAuth, requireKycDataEntityOwnership("kyc_data_entity.delete", denyKycSilentSuccess), async (req, res): Promise<void> => {
  const out = await removeKycDataEntity(req.user!.userId, req.params.id);
  (out.status === 200 ? res : res.status(out.status)).json(out.body);
});

export default router;
