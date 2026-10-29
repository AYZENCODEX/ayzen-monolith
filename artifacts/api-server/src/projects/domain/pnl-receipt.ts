/**
 * projects/domain/pnl-receipt.ts
 * Pure shapes for the public project P&L receipt: the JSON card and the PDF layout spec.
 * Moved unchanged from routes/projects.ts (PRJ-04). Amounts are printed with a `$` prefix whatever the
 * recorded currency was; that is existing behavior and is pinned by a test, not endorsed.
 */
import type { ProjectPnl } from "./roi";

export interface PublicReceiptSource {
  receipt: { id: number };
  project: { id: number; name: string; tier: string | null; thumbnailUrl: string | null };
  issuedBy: string | null;
  summary: ProjectPnl;
}

export function formatPublicReceipt(found: PublicReceiptSource, now: Date) {
  const { receipt, project, issuedBy, summary } = found;
  return {
    id: receipt.id,
    projectId: project.id,
    projectName: project.name,
    projectTier: project.tier,
    thumbnailUrl: project.thumbnailUrl,
    invested: summary.invested,
    spent: summary.spent,
    earned: summary.earned,
    netPnl: summary.netPnl,
    netPosition: summary.netPosition,
    roiPct: summary.roiPct,
    issuedBy,
    generatedAt: now.toISOString(),
  };
}

export type PublicReceipt = ReturnType<typeof formatPublicReceipt>;

/** Layout spec handed to the PDF renderer (lib/receipt-theme), which stays outside the module. */
export function buildProjectReceiptPdfSpec(r: PublicReceipt) {
  return {
    kicker: "Project P&L Receipt",
    title: r.projectName,
    subtitle: r.projectTier != null ? `Tier ${r.projectTier}` : undefined,
    avatarLetter: r.projectName,
    heroLabel: r.roiPct !== null ? "Return on Investment" : "Net P&L",
    heroValue: r.roiPct !== null ? `${r.roiPct >= 0 ? "+" : ""}${r.roiPct.toFixed(1)}%` : `${r.netPnl >= 0 ? "+" : ""}$${r.netPnl.toFixed(2)}`,
    heroPositive: r.roiPct !== null ? r.roiPct >= 0 : (r.netPnl >= 0),
    stats: [
      { label: "Invested", value: `$${r.invested.toFixed(2)}` },
      { label: "Earned", value: `$${r.earned.toFixed(2)}`, color: "#0f9d58" },
      { label: "Spent", value: `$${r.spent.toFixed(2)}`, color: "#e4453a" },
      { label: "Net PnL", value: `${r.netPnl >= 0 ? "+" : ""}$${r.netPnl.toFixed(2)}`, color: r.netPnl >= 0 ? "#0f9d58" : "#e4453a" },
      { label: "Net Position", value: `$${r.netPosition.toFixed(2)}` },
    ],
    receiptId: r.id,
    issuedBy: r.issuedBy,
    filenamePrefix: "project-pnl",
  };
}
