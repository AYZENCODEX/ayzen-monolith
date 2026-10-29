import {
  selectGameEntryForListing, transferGameEntryOwnership, type GameTxClient,
} from "../../infrastructure/repositories/game-repository";

/**
 * Game entry use-cases for the Vault-market boundary (VLT-GAP-04-C). Bodies
 * moved out of routes/marketplace-vault.ts: the seller-ownership check that
 * guards listing a game entry (and its preview payload), and the ownership
 * transfer that runs inside the purchase transaction. Same SQL, same
 * conditions, same status codes and bodies; the route keeps the transaction
 * (BEGIN/COMMIT/ROLLBACK) and the HTTP response, and only delegates the
 * game-specific decision.
 */

export type GameListingPreviewResult =
  | { ok: true; previewData: string }
  | { ok: false; status: 403; body: { error: string } };

export type GameTransferResult =
  | { ok: true }
  | { ok: false; status: 409; body: { error: string } };

// ── POST /marketplace/vault/listings — vault_type "game": verify the seller owns the entry, build the preview ──
export async function loadGameEntryListingPreview(entryId: unknown, sellerId: number): Promise<GameListingPreviewResult> {
  const ge = await selectGameEntryForListing(entryId, sellerId);
  if (!ge.rows[0]) return { ok: false, status: 403, body: { error: "Game entry not found or not yours" } };
  const g = ge.rows[0];
  return {
    ok: true,
    previewData: JSON.stringify({
      category: g.category,
      platform: g.platform,
      has_2fa: !!g.email_2fa,
    }),
  };
}

// ── POST /marketplace/vault/buy — vault_type "game": move the entry to the buyer inside the purchase transaction ──
export async function transferGameEntryToBuyer(client: GameTxClient, entryId: unknown, buyerId: number, sellerId: unknown): Promise<GameTransferResult> {
  const transferResult = await transferGameEntryOwnership(client, entryId, buyerId, sellerId);
  if (transferResult.rowCount === 0) {
    return { ok: false, status: 409, body: { error: "Asset ownership conflict — seller may no longer own this game entry" } };
  }
  return { ok: true };
}
