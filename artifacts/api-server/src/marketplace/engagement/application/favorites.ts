/**
 * marketplace/engagement/application/favorites.ts
 * MKT-05g: use cases behind the three favorites routes. Adding checks that the listing exists (404 result), then inserts with
 * ON CONFLICT DO NOTHING; an already favorited listing comes back as { message: "Already favorited" } (still answered 201, as
 * before). Removing never checks anything and always succeeds.
 */
import type { FavoritesRepo } from "../infrastructure/favorites-repo";

export type AddResult = { ok: true; body: any } | { ok: false; status: 404; error: string };

export function createFavoritesService(repo: FavoritesRepo) {
  return {
    list: (userId: number): Promise<any[]> => repo.list(userId),
    async add(userId: number, listingId: number): Promise<AddResult> {
      if ((await repo.listingExists(listingId)).length === 0) return { ok: false, status: 404, error: "Listing not found" };
      const rows = await repo.insert(userId, listingId);
      return { ok: true, body: rows[0] ?? { message: "Already favorited" } };
    },
    async remove(userId: number, listingId: number): Promise<void> { await repo.remove(userId, listingId); },
  };
}
