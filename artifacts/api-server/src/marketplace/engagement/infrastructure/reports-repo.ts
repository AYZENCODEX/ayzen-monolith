/**
 * marketplace/engagement/infrastructure/reports-repo.ts
 * MKT-05e: the 8 statements of routes/marketplace-reports.ts, moved verbatim (text pinned in moved-sql.pins.json). The three
 * statements of the moderation transaction take the transaction's client as first argument; the rest run on the pool. Never
 * imports the pool; the wired instance is reports-repo.wired.ts.
 */
export interface Queryable { query(text: string, params?: any[]): Promise<{ rows: any[] }> }

export const REPORTS_SQL = {
  listingExists: "SELECT id FROM marketplace_listings WHERE id=$1",
  insertListingReport: `INSERT INTO marketplace_reports (listing_id, reporter_id, reason, details, status, created_at)
       VALUES ($1,$2,$3,$4,'pending',NOW()) RETURNING *`,
  queue: `SELECT mr.*, ml.title as listing_title, u.username as reporter_username
       FROM marketplace_reports mr
       LEFT JOIN marketplace_listings ml ON ml.id = mr.listing_id
       LEFT JOIN users u ON u.id = mr.reporter_id
       WHERE mr.status = $1
       ORDER BY mr.created_at ASC`,
  lockPending: "SELECT * FROM marketplace_reports WHERE id=$1 AND status='pending' FOR UPDATE",
  removeListing: "UPDATE marketplace_listings SET status='removed', updated_at=NOW() WHERE id=$1",
  markResolved: "UPDATE marketplace_reports SET status='resolved', admin_note=$1, resolved_at=NOW() WHERE id=$2",
  myReports: `SELECT mr.*, ml.title as listing_title FROM marketplace_reports mr
       LEFT JOIN marketplace_listings ml ON ml.id = mr.listing_id
       WHERE mr.reporter_id = $1 ORDER BY mr.created_at DESC`,
  insertSellerReport: `INSERT INTO marketplace_reports (reported_user_id, reporter_id, reason, details, status, created_at)
       VALUES ($1,$2,$3,$4,'pending',NOW()) RETURNING *`,
} as const;

const run = async (db: Queryable, text: string, params: any[]): Promise<any[]> => (await db.query(text, params)).rows;

/** Statements of the moderation transaction; `tx` is the connected client between BEGIN and COMMIT. */
export const reportTx = {
  lockPending: (tx: Queryable, id: number) => run(tx, REPORTS_SQL.lockPending, [id]),
  removeListing: (tx: Queryable, listingId: any) => run(tx, REPORTS_SQL.removeListing, [listingId]),
  markResolved: (tx: Queryable, note: string, id: number) => run(tx, REPORTS_SQL.markResolved, [note, id]),
};

export function createReportsRepo(db: Queryable) {
  return {
    listingExists: (id: number) => run(db, REPORTS_SQL.listingExists, [id]),
    insertListingReport: (params: any[]) => run(db, REPORTS_SQL.insertListingReport, params),
    queue: (status: any) => run(db, REPORTS_SQL.queue, [status]),
    myReports: (userId: number) => run(db, REPORTS_SQL.myReports, [userId]),
    insertSellerReport: (params: any[]) => run(db, REPORTS_SQL.insertSellerReport, params),
  };
}
export type ReportsRepo = ReturnType<typeof createReportsRepo>;
