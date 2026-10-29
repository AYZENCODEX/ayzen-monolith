/**
 * marketplace/engagement/domain/alerts.ts
 * MKT-05c: the pure rules of routes/marketplace-alerts.ts, moved verbatim: what makes a request invalid, which parameters an
 * INSERT gets, and how the dynamic UPDATE is assembled (field order keyword, max_price_azn, platform, is_active; `undefined`
 * means "leave alone", `null` clears max_price_azn). No database, no HTTP.
 */

export interface CreateAlertInput { keyword?: any; listing_type?: any; max_price_azn?: any; platform?: any }
export interface UpdateAlertFields { keyword?: any; max_price_azn?: any; platform?: any; is_active?: any }
export interface SavedSearchInput { name?: any; filters?: any }

export function validateCreateAlert(input: CreateAlertInput): string | null {
  const { keyword, listing_type } = input;
  return !keyword && !listing_type ? "At least a keyword or listing_type is required" : null;
}

export function createAlertParams(userId: number, input: CreateAlertInput): any[] {
  const { keyword, listing_type, max_price_azn, platform } = input;
  return [userId, keyword || null, listing_type || null, max_price_azn ? Number(max_price_azn) : null, platform || null];
}

/** Returns null when no field was given (the route answers 400 "No fields to update" before touching the database). */
export function buildAlertUpdate(fields: UpdateAlertFields, id: number, userId: number): { sql: string; params: any[] } | null {
  const { keyword, max_price_azn, platform, is_active } = fields;
  const sets: string[] = []; const params: any[] = [];
  const push = (col: string, val: any) => { params.push(val); sets.push(`${col}=$${params.length}`); };
  if (keyword !== undefined) push("keyword", keyword);
  if (max_price_azn !== undefined) push("max_price_azn", max_price_azn === null ? null : Number(max_price_azn));
  if (platform !== undefined) push("platform", platform);
  if (is_active !== undefined) push("is_active", !!is_active);
  if (sets.length === 0) return null;
  params.push(id, userId);
  return {
    sql: `UPDATE marketplace_alerts SET ${sets.join(", ")} WHERE id=$${params.length - 1} AND user_id=$${params.length} RETURNING *`,
    params,
  };
}

export function validateSavedSearch(input: SavedSearchInput): string | null {
  const { name, filters } = input;
  return !name || !filters ? "name and filters are required" : null;
}

export function savedSearchParams(userId: number, input: SavedSearchInput): any[] {
  return [userId, input.name, JSON.stringify(input.filters)];
}
