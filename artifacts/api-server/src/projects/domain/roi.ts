/**
 * projects/domain/roi.ts
 * Pure money rules for a project: the per-entity ROI roll-up and the per-user project P&L figures.
 * No database, HTTP, or logging dependencies. Moved unchanged from routes/projects.ts (PRJ-04).
 * Plain IEEE-754 doubles on purpose: no rounding, no currency conversion. That is what receipts showed
 * before the move, and the characterization tests pin it. The ledger amounts are summed as stored, in whatever
 * currency each row was recorded in; this differs from GET /finance/investments, which converts to base currency.
 */

/** ROI of one entity row: the stored value when present (including 0), otherwise profit minus cost. */
export function entityRoi(row: { roi: number | null; totalProfit: number; totalCost: number }): number {
  return row.roi ?? (row.totalProfit - row.totalCost);
}

export interface RoiRow {
  vaultEntryId: number;
  entitySerial: string | null;
  entityName: string | null;
  totalProfit: number;
  totalCost: number;
  roi: number | null;
  recordedAt: Date;
}

export function summarizeRoi(projectId: number, rows: RoiRow[]) {
  const entries = rows.map((r) => ({
    vaultEntryId: r.vaultEntryId,
    entitySerial: r.entitySerial,
    entityName: r.entityName,
    totalProfit: r.totalProfit,
    totalCost: r.totalCost,
    roi: entityRoi(r),
    recordedAt: r.recordedAt.toISOString(),
  }));
  const totalProfit = entries.reduce((s, e) => s + e.totalProfit, 0);
  const totalCost = entries.reduce((s, e) => s + e.totalCost, 0);
  return { projectId, entries, summary: { totalProfit, totalCost, totalRoi: totalProfit - totalCost } };
}

export interface LedgerKindTotal { kind: string; total: number }

/**
 * P&L for one user and project from ledger totals grouped by kind.
 * invested = 'investment', spent = 'expense', earned = 'income'; any other kind is ignored.
 * roiPct is null only when nothing was spent and nothing was earned; spent = 0 with earnings reads as 100.
 */
export function computeProjectPnl(rows: LedgerKindTotal[]) {
  let invested = 0, spent = 0, earned = 0;
  for (const r of rows) {
    if (r.kind === "investment") invested += r.total;
    if (r.kind === "expense") spent += r.total;
    if (r.kind === "income") earned += r.total;
  }
  const netPnl = earned - spent;
  const netPosition = invested - spent + earned;
  const roiPct = spent > 0 ? (netPnl / spent) * 100 : (earned > 0 ? 100 : null);
  return { invested, spent, earned, netPnl, netPosition, roiPct };
}

export type ProjectPnl = ReturnType<typeof computeProjectPnl>;
