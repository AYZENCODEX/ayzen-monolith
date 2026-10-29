/**
 * marketplace/engagement/infrastructure/alerts-repo.ts
 * MKT-05c: the SQL of routes/marketplace-alerts.ts except the dynamic UPDATE, whose text is assembled by the pure
 * buildAlertUpdate in domain/alerts.ts and only executed here. Statement text is pinned in moved-sql.pins.json. Never imports
 * the pool; the wired instance is alerts-repo.wired.ts.
 */
export interface Queryable { query(text: string, params?: any[]): Promise<{ rows: any[] }> }

export const ALERTS_SQL = {
  findOwner: "SELECT user_id FROM marketplace_alerts WHERE id=$1 LIMIT 1",
  insert: `INSERT INTO marketplace_alerts (user_id, keyword, listing_type, max_price_azn, platform, is_active, created_at)
       VALUES ($1,$2,$3,$4,$5,TRUE,NOW()) RETURNING *`,
  list: "SELECT * FROM marketplace_alerts WHERE user_id=$1 ORDER BY created_at DESC",
  remove: "DELETE FROM marketplace_alerts WHERE id=$1 AND user_id=$2 RETURNING id",
  insertSavedSearch: `INSERT INTO marketplace_saved_searches (user_id, name, filters, created_at)
       VALUES ($1,$2,$3,NOW()) RETURNING *`,
  listSavedSearches: "SELECT * FROM marketplace_saved_searches WHERE user_id=$1 ORDER BY created_at DESC",
} as const;

export function createAlertsRepo(db: Queryable) {
  return {
    async findAlertOwner(id: number): Promise<any[]> { return (await db.query(ALERTS_SQL.findOwner, [id])).rows; },
    async insertAlert(params: any[]): Promise<any[]> { return (await db.query(ALERTS_SQL.insert, params)).rows; },
    async listAlerts(userId: number): Promise<any[]> { return (await db.query(ALERTS_SQL.list, [userId])).rows; },
    async runAlertUpdate(sql: string, params: any[]): Promise<any[]> { return (await db.query(sql, params)).rows; },
    async deleteAlert(id: number, userId: number): Promise<any[]> { return (await db.query(ALERTS_SQL.remove, [id, userId])).rows; },
    async insertSavedSearch(params: any[]): Promise<any[]> { return (await db.query(ALERTS_SQL.insertSavedSearch, params)).rows; },
    async listSavedSearches(userId: number): Promise<any[]> { return (await db.query(ALERTS_SQL.listSavedSearches, [userId])).rows; },
  };
}
export type AlertsRepo = ReturnType<typeof createAlertsRepo>;
