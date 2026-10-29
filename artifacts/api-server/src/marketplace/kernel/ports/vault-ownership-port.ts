/**
 * marketplace/kernel/ports/vault-ownership-port.ts
 * MKT-03: the seller-or-admin cancel decisions for Vault-market and Game-market listings stay in vault/security.
 * Marketplace code calls them through this port (adapter: infrastructure/vault-ownership-adapter.ts).
 */
import type { Request } from "express";

export interface VaultOwnershipPort {
  canCancelVaultListing(req: Request, listingId: string | number, sellerId: unknown): Promise<boolean>;
  canCancelGameListing(req: Request, listingId: string | number, sellerId: unknown): Promise<boolean>;
}
