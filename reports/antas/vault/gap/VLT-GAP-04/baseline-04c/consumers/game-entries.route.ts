import { Router } from "express";
import { requireAuth } from "../middlewares/auth";
import { requireCreditBalance } from "../services/credit-meter";
import {
  requireGameEntryOwnership, denyGameEntryNotFound, denyGameEntryNotFoundOrForbidden, denyGameEntrySilentSuccess,
} from "../vault/security/game-ownership";
import {
  listGameEntries, createGameEntry, getGameEntry, editGameEntry, removeGameEntry,
} from "../vault/application/game/entries";

/**
 * Game entries — HTTP adapter (VLT-GAP-04-B). Every handler only maps the
 * request onto a Vault use-case and sends its `{ status, body }`; SQL,
 * encryption, credit charging and ownership resolution live in
 * vault/application/game, vault/infrastructure and vault/security.
 * Route table (paths, order, middleware chains) is unchanged.
 */
const router = Router();

// ─── GET /game-entries — list user's game entities ─────────────────────────
router.get("/game-entries", requireAuth, async (req, res): Promise<void> => {
  const out = await listGameEntries(req.user!.userId, { category: req.query.category });
  res.status(out.status).json(out.body);
});

// ─── POST /game-entries — create game entity ────────────────────────────────
router.post("/game-entries", requireAuth, async (req, res): Promise<void> => {
  const out = await createGameEntry(req.user!.userId, req.body);
  res.status(out.status).json(out.body);
});

// ─── GET /game-entries/:id — fetch single game entity ───────────────────────
// Must stay registered AFTER the literal "/game-entries" list route above,
// same ordering rule as local-accounts.ts/kyc.ts, so Express doesn't try to
// parse a literal path segment as :id.
router.get("/game-entries/:id", requireAuth, requireGameEntryOwnership("game_entry.read", denyGameEntryNotFound), requireCreditBalance("sylo.game_entry_view"), async (req, res): Promise<void> => {
  const out = await getGameEntry(req.user!.userId, req.params.id);
  res.status(out.status).json(out.body);
});

// ─── PUT /game-entries/:id — update game entity ─────────────────────────────
router.put("/game-entries/:id", requireAuth, requireGameEntryOwnership("game_entry.update", denyGameEntryNotFoundOrForbidden), async (req, res): Promise<void> => {
  const out = await editGameEntry(req.user!.userId, req.params.id, req.body);
  res.status(out.status).json(out.body);
});

// ─── DELETE /game-entries/:id — delete game entity ──────────────────────────
router.delete("/game-entries/:id", requireAuth, requireGameEntryOwnership("game_entry.delete", denyGameEntrySilentSuccess), async (req, res): Promise<void> => {
  const out = await removeGameEntry(req.user!.userId, req.params.id);
  res.status(out.status).json(out.body);
});

export default router;
