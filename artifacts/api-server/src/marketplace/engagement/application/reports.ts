/**
 * marketplace/engagement/application/reports.ts
 * MKT-05e: use cases behind the five report routes. The route adapter destructures req.body / req.query itself, before its try
 * block, as before. The moderation transaction mirrors the original structure on purpose (not kernel withTransaction): connect
 * outside the try, BEGIN, lock the pending report, optionally remove the listing, mark the report resolved, COMMIT; a missing
 * report rolls back and is a 404 result; any other failure rolls back and is returned as a 500 result carrying the message; a
 * failing ROLLBACK is NOT swallowed (it escapes, as it did from the route); the client is always released.
 */
import { isValidAction, listingReportParams, resolveNote, sellerReportParams, shouldRemoveListing, validateReason, validateSellerReport } from "../domain/reports";
import { reportTx, type ReportsRepo } from "../infrastructure/reports-repo";
import type { TxClient } from "../../kernel/infrastructure/tx";

export type Failure = { ok: false; status: 400 | 404 | 500; error: string };
export type Row = { ok: true; row: any };

export function createReportsService(repo: ReportsRepo, connect: () => Promise<TxClient>) {
  return {
    async reportListing(userId: number, listingId: number, input: { reason?: any; details?: any }): Promise<Row | Failure> {
      const bad = validateReason(input.reason);
      if (bad) return { ok: false, status: 400, error: bad };
      if ((await repo.listingExists(listingId)).length === 0) return { ok: false, status: 404, error: "Listing not found" };
      return { ok: true, row: (await repo.insertListingReport(listingReportParams(listingId, userId, input.reason, input.details)))[0] };
    },
    queue: (status: any): Promise<any[]> => repo.queue(status),
    async resolve(id: number, input: { action?: any; admin_note?: any }): Promise<{ ok: true; action: string } | Failure> {
      const { action, admin_note } = input;
      if (!isValidAction(action)) return { ok: false, status: 400, error: "action must be 'dismiss' or 'remove_listing'" };
      const client = await connect();
      try {
        await client.query("BEGIN");
        const reportRows = await reportTx.lockPending(client, id);
        if (reportRows.length === 0) { await client.query("ROLLBACK"); return { ok: false, status: 404, error: "Pending report not found" }; }
        const report = reportRows[0];
        if (shouldRemoveListing(action, report)) await reportTx.removeListing(client, report.listing_id);
        await reportTx.markResolved(client, resolveNote(admin_note, action), id);
        await client.query("COMMIT");
        return { ok: true, action };
      } catch (e: any) {
        await client.query("ROLLBACK");
        return { ok: false, status: 500, error: e.message };
      } finally {
        client.release();
      }
    },
    myReports: (userId: number): Promise<any[]> => repo.myReports(userId),
    async reportSeller(userId: number, sellerId: number, input: { reason?: any; details?: any }): Promise<Row | Failure> {
      const bad = validateSellerReport(userId, sellerId, input.reason);
      if (bad) return { ok: false, status: 400, error: bad };
      return { ok: true, row: (await repo.insertSellerReport(sellerReportParams(sellerId, userId, input.reason, input.details)))[0] };
    },
  };
}
