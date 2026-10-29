/** MKT-03: VaultOwnershipPort over vault/security (the seller-or-admin cancel decisions stay in Vault). */
import { canCancelGameListing } from "../../../vault/security/game-ownership";
import { canCancelVaultListing } from "../../../vault/security/market-listing-ownership";
import type { VaultOwnershipPort } from "../ports/vault-ownership-port";

export const vaultOwnershipAdapter: VaultOwnershipPort = {
  canCancelVaultListing: (req, listingId, sellerId) => canCancelVaultListing(req, listingId, sellerId),
  canCancelGameListing: (req, listingId, sellerId) => canCancelGameListing(req, listingId, sellerId),
};
