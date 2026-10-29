/**
 * marketplace/catalog/application/discovery.ts
 * MKT-05: use cases behind the four public discovery routes. Behavior is unchanged: a missing base listing is a 404 result,
 * every other failure is thrown and the route adapter answers 500 with the error message, as the route did itself before.
 */
import type { DiscoveryRepo } from "../infrastructure/discovery-repo";

export type SimilarResult = { ok: true; rows: any[] } | { ok: false; status: 404; error: string };

export function createDiscoveryService(repo: DiscoveryRepo) {
  return {
    async similar(id: number): Promise<SimilarResult> {
      const base = await repo.findBase(id);
      if (base.length === 0) return { ok: false, status: 404, error: "Listing not found" };
      const rows = await repo.listSimilar(id, base[0].listing_type, base[0].price_azn);
      return { ok: true, rows };
    },
    trending: (limit: number): Promise<any[]> => repo.listTrending(limit),
    categories: (): Promise<any[]> => repo.listCategories(),
    featured: (limit: number): Promise<any[]> => repo.listFeatured(limit),
  };
}
