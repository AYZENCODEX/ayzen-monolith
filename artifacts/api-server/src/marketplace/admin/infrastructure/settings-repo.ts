/**
 * marketplace/admin/infrastructure/settings-repo.ts
 * MKT-05f: the two statements of GET and PATCH /marketplace/settings, moved verbatim (text pinned in moved-sql.pins.json).
 * Never imports the pool; the wired instance is settings-repo.wired.ts.
 */
export interface Queryable { query(text: string, params?: any[]): Promise<{ rows: any[] }> }

export const SETTINGS_SQL = {
  get: "SELECT * FROM marketplace_settings LIMIT 1",
  upsert: `
      INSERT INTO marketplace_settings (id, fee_pct, enabled, updated_at)
      VALUES (1, $1, $2, NOW())
      ON CONFLICT (id) DO UPDATE SET fee_pct = $1, enabled = $2, updated_at = NOW()
    `,
} as const;

export function createSettingsRepo(db: Queryable) {
  return {
    // the original called pool.query(sql) with no parameter array for the read
    async get(): Promise<any[]> { return (await db.query(SETTINGS_SQL.get)).rows; },
    async upsert(params: any[]): Promise<void> { await db.query(SETTINGS_SQL.upsert, params); },
  };
}
export type SettingsRepo = ReturnType<typeof createSettingsRepo>;
