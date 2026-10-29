/**
 * marketplace/catalog/domain/listing-queries.ts
 * MKT-05g: the dynamic SQL of GET /marketplace/listings (list and count) and GET /marketplace/search, assembled exactly as the
 * routes did (pure, no database). Whitespace inside the template literals is part of the text and was kept. The pieces are pinned
 * in moved-sql.pins.json; the assembled result is compared with verbatim copies of the original logic in
 * listing-queries.test.ts (every combination of odd inputs).
 */
export interface ListInput { type?: any; limit?: any; offset?: any }
export interface SearchInput { q?: any; type?: any; min_price?: any; max_price?: any; condition?: any; limit?: any; offset?: any }

export function buildListingsList(input: ListInput): { sql: string; params: any[] } {
  const { type, limit = 50, offset = 0 } = input;
  let q = `
      SELECT ml.*, u.username as seller_username
      FROM marketplace_listings ml
      LEFT JOIN users u ON u.id = ml.seller_id
      WHERE ml.status = 'active'
        AND (ml.listing_expires_at IS NULL OR ml.listing_expires_at > NOW())
    `;
  const params: any[] = [];
  if (type) { q += ` AND ml.listing_type = $${params.length + 1}`; params.push(type); }
  q += ` ORDER BY ml.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  params.push(Number(limit), Number(offset));
  return { sql: q, params };
}

export function buildListingsCount(type: any): { sql: string; params: any[] } {
  return {
    sql: `SELECT COUNT(*) FROM marketplace_listings WHERE status = 'active'${type ? " AND listing_type = $1" : ""}`,
    params: type ? [type] : [],
  };
}

export function buildSearch(input: SearchInput): { sql: string; params: any[] } {
  const { q, type, min_price, max_price, condition, limit = 50, offset = 0 } = input;
  let query = `
      SELECT ml.*, u.username as seller_username
      FROM marketplace_listings ml
      LEFT JOIN users u ON u.id = ml.seller_id
      WHERE ml.status = 'active'
        AND (ml.listing_expires_at IS NULL OR ml.listing_expires_at > NOW())
    `;
  const params: any[] = [];
  if (q) { params.push(`%${q}%`); query += ` AND (ml.title ILIKE $${params.length} OR ml.description ILIKE $${params.length})`; }
  if (type) { params.push(type); query += ` AND ml.listing_type = $${params.length}`; }
  if (condition) { params.push(condition); query += ` AND ml.condition = $${params.length}`; }
  if (min_price) { params.push(Number(min_price)); query += ` AND ml.price_azn >= $${params.length}`; }
  if (max_price) { params.push(Number(max_price)); query += ` AND ml.price_azn <= $${params.length}`; }
  query += ` ORDER BY (ml.is_featured AND (ml.featured_until IS NULL OR ml.featured_until > NOW())) DESC, ml.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  params.push(Number(limit), Number(offset));
  return { sql: query, params };
}
