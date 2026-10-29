import type { Request } from "express";
import { pepDecisionObserver } from "../../middlewares/auth";
import { PolicyEngine } from "../../lib/policy/policy-engine";
import { createResourceOwnershipRule, createRoleOverrideRule } from "../../lib/policy/resource";
import { authorize } from "../../lib/policy/pep";

/**
 * Seller-OR-admin cancel decision for a Vault-market listing. Moved verbatim out of routes/marketplace-vault.ts
 * (VLT-GAP-13-E; originally Season C / Phase C5): same engine, same rules, same action and resource shape.
 * Authorization lives in vault/security, not in the adapter.
 */
const vaultListingOwnerOrAdminEngine = new PolicyEngine({ onDecision: pepDecisionObserver });
vaultListingOwnerOrAdminEngine.registerRule("resource-ownership", createResourceOwnershipRule());
vaultListingOwnerOrAdminEngine.registerRule("role-override", createRoleOverrideRule(["admin"]));

export async function canCancelVaultListing(req: Request, listingId: string | number, sellerId: unknown): Promise<boolean> {
  const ownership = await authorize({
    req,
    engine: vaultListingOwnerOrAdminEngine,
    action: "marketplace.vault_listing.cancel",
    resource: { type: "marketplace.vault_listing", id: listingId, ownerId: sellerId as any },
  });
  return ownership.decision.effect === "ALLOW";
}
