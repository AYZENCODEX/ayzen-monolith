/**
 * marketplace/admin/domain/activity.ts
 * MKT-05f: the dynamic SQL of GET /admin/marketplace/activity, assembled exactly as the route did (pure, no database).
 * The text pieces are pinned in moved-sql.pins.json and the assembled result is compared with a verbatim copy of the original
 * logic in domain/activity.test.ts.
 */
export interface ActivityQuery { event_type?: any; limit?: any; offset?: any }

export function buildActivityList(input: ActivityQuery): { sql: string; params: any[] } {
  const { event_type, limit = 50, offset = 0 } = input;
  let q = `SELECT * FROM marketplace_activity_log`;
  const params: any[] = [];
  if (event_type) { q += ` WHERE event_type = $${params.length + 1}`; params.push(event_type); }
  q += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  params.push(Number(limit), Number(offset));
  return { sql: q, params };
}

export function buildActivityCount(input: ActivityQuery): { sql: string; params: any[] } {
  const { event_type } = input;
  const countQ = `SELECT COUNT(*) FROM marketplace_activity_log${event_type ? " WHERE event_type=$1" : ""}`;
  return { sql: countQ, params: event_type ? [event_type] : [] };
}
