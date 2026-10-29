import { Router } from "express";
import { requireAuth } from "../middlewares/auth";
import { requireCreditBalance } from "../services/credit-meter";
import { requireKycEntryOwnership, denyKycNotFound, denyKycNotFoundOrForbidden, denyKycSilentSuccess } from "../vault/security/kyc-ownership";
import {
  listKycEntries, createKycEntry, getKycEntry, editKycEntry, setKycEntryStatus, removeKycEntry, listKycEnrollments,
} from "../vault/application/kyc/entries";

// Compatibility exports (C19B): exchange-api.ts and the ownership regression
// test still import these from here until they are rewired in 03-C.
export { kycEntryResource, requireKycEntryOwnership } from "../vault/security/kyc-ownership";

/**
 * KYC entries — HTTP adapter (VLT-GAP-03-B). Every handler only maps the
 * request onto a Vault use-case and sends its `{ status, body }`; persistence,
 * encryption, credit charging and ownership resolution live in
 * vault/application/kyc, vault/infrastructure and vault/security. Route table
 * (paths, order, middleware chains) is unchanged. A 200 is sent with a bare
 * `res.json` and every other status with `res.status(n).json`, exactly as the
 * inline handlers did.
 */
const router = Router();

// ─── GET /kyc-entries — list user's KYC entities ──────────────────────────────
router.get("/kyc-entries", requireAuth, async (req, res): Promise<void> => {
  const out = await listKycEntries(req.user!.userId, { category: req.query.category, platform: req.query.platform, unused: req.query.unused });
  (out.status === 200 ? res : res.status(out.status)).json(out.body);
});

// ─── POST /kyc-entries — create KYC entity ─────────────────────────────────────
router.post("/kyc-entries", requireAuth, async (req, res): Promise<void> => {
  const out = await createKycEntry(req.user!.userId, req.body);
  (out.status === 200 ? res : res.status(out.status)).json(out.body);
});

// ─── GET /kyc-entries/:id — fetch single KYC entity ───────────────────────────
router.get("/kyc-entries/:id", requireAuth, requireKycEntryOwnership("kyc_entry.read", denyKycNotFound), requireCreditBalance("sylo.kyc_entry_view"), async (req, res): Promise<void> => {
  const out = await getKycEntry(req.user!.userId, req.params.id);
  (out.status === 200 ? res : res.status(out.status)).json(out.body);
});

// ─── PUT /kyc-entries/:id — update KYC entity ─────────────────────────────────
router.put("/kyc-entries/:id", requireAuth, requireKycEntryOwnership("kyc_entry.update", denyKycNotFoundOrForbidden), async (req, res): Promise<void> => {
  const out = await editKycEntry(req.user!.userId, req.params.id, req.body);
  (out.status === 200 ? res : res.status(out.status)).json(out.body);
});

// ─── PATCH /kyc-entries/:id/status — ban / unban KYC entity ──────────────────
router.patch("/kyc-entries/:id/status", requireAuth, requireKycEntryOwnership("kyc_entry.status.update", denyKycNotFoundOrForbidden), async (req, res): Promise<void> => {
  const out = await setKycEntryStatus(req.user!.userId, req.params.id, req.body);
  (out.status === 200 ? res : res.status(out.status)).json(out.body);
});

// ─── DELETE /kyc-entries/:id — delete KYC entity ──────────────────────────────
router.delete("/kyc-entries/:id", requireAuth, requireKycEntryOwnership("kyc_entry.delete", denyKycSilentSuccess), async (req, res): Promise<void> => {
  const out = await removeKycEntry(req.user!.userId, req.params.id);
  (out.status === 200 ? res : res.status(out.status)).json(out.body);
});

// ─── GET /kyc-entries/enrollments — Exchange projects enrolled via a KYC
// Entity pick (Binance/Bitget/Kucoin/Bybit shortcut, no manual form) ────────
// Registered after GET /kyc-entries/:id, so the :id route shadows it — a
// pre-existing quirk, preserved here and not fixed.
router.get("/kyc-entries/enrollments", requireAuth, async (req, res): Promise<void> => {
  const out = await listKycEnrollments(req.user!.userId);
  (out.status === 200 ? res : res.status(out.status)).json(out.body);
});

export default router;
