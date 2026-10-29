/**
 * Local account domain values: SQL-literal escaping, score clamping, age/ROI
 * metadata and the public receipt projections. Pure — no I/O, no framework.
 * Extracted verbatim from routes/local-accounts.ts (VLT-GAP-02-B); the only
 * refactors are aggregateCategoryRows (arithmetic split out of the old
 * computeCategoryAggregate, whose SELECT now lives in the repository) and the
 * named FoundCategoryReceipt parameter type.
 */

// Safely escape a string for SQL — only used for string values; integers are coerced with Number()
export const safe = (v: unknown) => v === null || v === undefined ? "NULL" : `'${String(v).replace(/'/g, "''")}'`;
export const safeNum = (v: unknown) => isNaN(Number(v)) ? 0 : Number(v);
export const safeDate = (v: unknown) => v ? `'${String(v).replace(/'/g, "''")}'` : "NULL";
// Rank/badge score — clamped to the 0-10 scale the 5-tier badge system expects.
export const safeScore = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(10, Math.round(n))) : 5;
};

export function calcAgeLabel(dateVal: unknown): string | null {
  if (!dateVal) return null;
  const d = new Date(dateVal as string);
  if (Number.isNaN(d.getTime())) return null;
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days < 1) return "Today";
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${(days / 365).toFixed(1)}y`;
}

export function calcRoiPct(worth: number, buyPrice: number): number | null {
  if (!buyPrice || buyPrice <= 0) return null;
  return ((worth - buyPrice) / buyPrice) * 100;
}

export function fmtPublicLocalReceipt(row: any, issuedBy: string | null) {
  const worth = Number(row.account_worth) || 0;
  const buyPrice = Number(row.buy_price) || 0;
  const roiPct = calcRoiPct(worth, buyPrice);
  return {
    id: row.id,
    category: row.category,
    label: row.label,
    username: row.username,
    followers: row.followers,
    age: calcAgeLabel(row.account_create_date),
    accountWorth: worth,
    buyPrice,
    profit: buyPrice > 0 ? worth - buyPrice : null,
    roiPct,
    status: row.status,
    score: row.score,
    createdAt: row.account_create_date,
    issuedBy,
    generatedAt: new Date().toISOString(),
  };
}

export function ageInDays(dateVal: unknown): number | null {
  if (!dateVal) return null;
  const d = new Date(dateVal as string);
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}

export function fmtAvgAgeLabel(avgDays: number | null): string | null {
  if (avgDays === null) return null;
  if (avgDays < 1) return "Today";
  if (avgDays < 30) return `${avgDays.toFixed(0)}d`;
  if (avgDays < 365) return `${(avgDays / 30).toFixed(1)}mo`;
  return `${(avgDays / 365).toFixed(1)}y`;
}

/** Arithmetic half of the old computeCategoryAggregate (rows now come from the repository). */
export function aggregateCategoryRows(rows: any[]) {
  const count = rows.length;
  let followerSum = 0, followerCount = 0;
  let ageSum = 0, ageCount = 0;
  let totalWorth = 0, totalBuyValue = 0, pnlCount = 0;

  for (const row of rows) {
    const followers = Number(row.followers);
    if (Number.isFinite(followers)) { followerSum += followers; followerCount++; }

    const days = ageInDays(row.account_create_date);
    if (days !== null) { ageSum += days; ageCount++; }

    const worth = Number(row.account_worth) || 0;
    const buyPrice = Number(row.buy_price) || 0;
    totalWorth += worth;
    if (buyPrice > 0) { totalBuyValue += buyPrice; pnlCount++; }
  }

  const avgFollowers = followerCount > 0 ? followerSum / followerCount : null;
  const avgAgeDays = ageCount > 0 ? ageSum / ageCount : null;
  const totalPnl = pnlCount > 0 ? totalWorth - totalBuyValue : null;
  const pnlPct = totalBuyValue > 0 ? (totalPnl! / totalBuyValue) * 100 : null;

  return {
    count, avgFollowers, avgAgeDays, avgAgeLabel: fmtAvgAgeLabel(avgAgeDays),
    totalWorth, totalBuyValue, totalPnl, pnlPct,
  };
}

export type CategoryAggregate = ReturnType<typeof aggregateCategoryRows>;
export interface FoundCategoryReceipt {
  receipt: any;
  issuedBy: any;
  aggregate: CategoryAggregate;
}

export function fmtPublicCategoryReceipt(found: FoundCategoryReceipt) {
  const { receipt, issuedBy, aggregate } = found;
  return {
    id: receipt.id,
    category: receipt.category,
    accountCount: aggregate.count,
    avgFollowers: aggregate.avgFollowers,
    avgAge: aggregate.avgAgeLabel,
    totalWorth: aggregate.totalWorth,
    totalBuyValue: aggregate.totalBuyValue,
    totalPnl: aggregate.totalPnl,
    pnlPct: aggregate.pnlPct,
    issuedBy,
    generatedAt: new Date().toISOString(),
  };
}
