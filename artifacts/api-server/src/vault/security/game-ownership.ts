import type { Request, Response } from "express";
import { pepDecisionObserver } from "../../middlewares/auth";
import { requireOwnership } from "../../lib/policy/pep/middleware";
import type { ResourceRefBuilder } from "../../lib/policy/pep/types";
import { PolicyEngine } from "../../lib/policy/policy-engine";
import { createResourceOwnershipRule, createRoleOverrideRule } from "../../lib/policy/resource";
import { authorize } from "../../lib/policy/pep";
import { GAME_ENTRY_OWNER_SENTINEL_NONE, GAME_MARKET_LISTING_OWNER_SENTINEL_NONE } from "../domain/game";
import { selectGameEntryOwner } from "../infrastructure/repositories/game-repository";

const gameEntryResource: ResourceRefBuilder = async (req: Request) => {
  const id = parseInt(req.params.id as string, 10);
  if (!Number.isFinite(id)) {
    return { type: "game_entry", id: req.params.id, ownerId: GAME_ENTRY_OWNER_SENTINEL_NONE };
  }
  const rows = (await selectGameEntryOwner(id)).rows as any[];
  return { type: "game_entry", id, ownerId: rows[0]?.user_id ?? GAME_ENTRY_OWNER_SENTINEL_NONE };
};

export function requireGameEntryOwnership(action: string, onDeny: (req: Request, res: Response) => void) {
  return requireOwnership(action, gameEntryResource, { onDecision: pepDecisionObserver, onDeny });
}

const gameListingOwnerOrAdminEngine = new PolicyEngine({ onDecision: pepDecisionObserver });
gameListingOwnerOrAdminEngine.registerRule("resource-ownership", createResourceOwnershipRule());
gameListingOwnerOrAdminEngine.registerRule("role-override", createRoleOverrideRule(["admin"]));

export async function authorizeGameListingOwnerOrAdmin(req: Request, listingId: string | number, sellerId: unknown) {
  return authorize({
    req,
    engine: gameListingOwnerOrAdminEngine,
    action: "marketplace.game_listing.cancel",
    resource: {
      type: "marketplace.game_listing",
      id: listingId,
      ownerId: typeof sellerId === "number" ? sellerId : Number(sellerId ?? GAME_MARKET_LISTING_OWNER_SENTINEL_NONE),
    },
  });
}

/**
 * Seller-OR-admin cancel decision for a game listing, as a boolean (VLT-GAP-04-D). Moved out of
 * routes/marketplace-game.ts, which used to compare `decision.effect` itself — authorization logic
 * must live in vault/security, not in the adapter.
 */
export async function canCancelGameListing(req: Request, listingId: string | number, sellerId: unknown): Promise<boolean> {
  const ownership = await authorizeGameListingOwnerOrAdmin(req, listingId, sellerId);
  return ownership.decision.effect === "ALLOW";
}
