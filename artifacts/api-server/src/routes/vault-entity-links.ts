import { Router } from "express";
import { requireAuth } from "../middlewares/auth";
import {
  requireVaultEntryOwnershipOr404,
  requireVaultEntityLinkOwnership,
} from "../vault/security/entity-ownership";
import {
  listEntityLinks,
  createEntityLink,
  updateEntityLink,
  deleteEntityLink,
  listAllEntityLinks,
} from "../vault/application/entity/links";

const router = Router();

// VLT-GAP-01-B: business logic (ownership resource builders, PEP wiring,
// link queries/mutations and their decision trees) now lives in
// vault/security/entity-ownership.ts and vault/application/entity/links.ts.
// This file keeps route registration, request parsing and response mapping.
router.get("/vault/:id/links", requireAuth, requireVaultEntryOwnershipOr404("vault_entry.links.read"), async (req, res): Promise<void> => {
  const r = await listEntityLinks(req.user!.userId, req.params.id);
  res.status(r.status).json(r.body);
});

router.post("/vault-entity-links", requireAuth, async (req, res): Promise<void> => {
  const r = await createEntityLink(req.user!.userId, req.body);
  res.status(r.status).json(r.body);
});

router.patch("/vault-entity-links/:id", requireAuth, requireVaultEntityLinkOwnership("vault_entity_link.update"), async (req, res): Promise<void> => {
  const r = await updateEntityLink(req.user!.userId, req.params.id as string, req.body);
  res.status(r.status).json(r.body);
});

router.delete("/vault-entity-links/:id", requireAuth, requireVaultEntityLinkOwnership("vault_entity_link.delete"), async (req, res): Promise<void> => {
  const r = await deleteEntityLink(req.user!.userId, req.params.id as string);
  res.status(r.status).json(r.body);
});

router.get("/vault/links/all", requireAuth, async (req, res): Promise<void> => {
  const r = await listAllEntityLinks(req.user!.userId);
  res.status(r.status).json(r.body);
});

export default router;
