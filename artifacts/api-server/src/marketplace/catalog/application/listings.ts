/**
 * marketplace/catalog/application/listings.ts
 * MKT-05g: use cases behind the public and admin listing reads, search and history. The route adapter destructures req.query
 * itself (before its try block, as before) and keeps the try/catch (500 with the message). The list runs the list statement
 * first and the count statement second.
 */
import { buildListingsCount, buildListingsList, buildSearch, type ListInput, type SearchInput } from "../domain/listing-queries";
import type { ListingsRepo } from "../infrastructure/listings-repo";

export type DetailResult = { ok: true; listing: any; platformPricing: any[] } | { ok: false; status: 404; error: string };

export function createListingsService(repo: ListingsRepo) {
  return {
    async list(input: ListInput): Promise<{ listings: any[]; total: number }> {
      const list = buildListingsList(input);
      const rows = await repo.run(list.sql, list.params);
      const count = buildListingsCount(input.type);
      const countRows = await repo.run(count.sql, count.params);
      return { listings: rows, total: Number(countRows[0].count) };
    },
    async detail(id: number): Promise<DetailResult> {
      const rows = await repo.detail(id);
      if (rows.length === 0) return { ok: false, status: 404, error: "Listing not found" };
      return { ok: true, listing: rows[0], platformPricing: await repo.pricing(id) };
    },
    mine: (userId: number): Promise<any[]> => repo.mine(userId),
    adminList: (): Promise<any[]> => repo.adminList(),
    async search(input: SearchInput): Promise<{ listings: any[]; count: number }> {
      const s = buildSearch(input);
      const rows = await repo.run(s.sql, s.params);
      return { listings: rows, count: rows.length };
    },
    history: (listingId: number): Promise<any[]> => repo.history(listingId),
  };
}
