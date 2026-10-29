/**
 * marketplace/admin/infrastructure/activity-repo.ts
 * MKT-05f: executes the activity-log statements built by domain/activity.ts (the SQL text itself is assembled there).
 * Never imports the pool; the wired instance is activity-repo.wired.ts.
 */
export interface Queryable { query(text: string, params?: any[]): Promise<{ rows: any[] }> }

export function createActivityRepo(db: Queryable) {
  return {
    async list(sql: string, params: any[]): Promise<any[]> { return (await db.query(sql, params)).rows; },
    async count(sql: string, params: any[]): Promise<any[]> { return (await db.query(sql, params)).rows; },
  };
}
export type ActivityRepo = ReturnType<typeof createActivityRepo>;
