/**
 * projects/application/roi-receipts.ts
 * ROI summary and public P&L receipt use cases (PRJ-04). Moved unchanged from routes/projects.ts.
 * Projects owns the project-level ROI and P&L end to end; the only Finance data it touches is the raw ledger
 * totals returned by project-ledger-reader. Idempotent mint (repeat calls return the same token until revoked);
 * revoke deletes the row outright. HTTP concerns (id parsing, PEP audit, PDF streaming) stay in the adapter.
 */
import { buildProjectReceiptPdfSpec, formatPublicReceipt } from "../domain/pnl-receipt";
import { computeProjectPnl, summarizeRoi } from "../domain/roi";
import { findProjectById, projectExists } from "../infrastructure/repositories/projects-repo";
import { listRoiRowsForUserProject } from "../infrastructure/repositories/roi-repo";
import { sumLedgerByKind } from "../infrastructure/repositories/project-ledger-reader";
import {
  deleteReceipt,
  findReceipt,
  findReceiptByToken,
  findUsernameById,
  insertReceipt,
} from "../infrastructure/repositories/pnl-receipts-repo";
import { generateProjectReceiptToken, projectReceiptUrl } from "../security/receipt-token";

export async function getRoiSummary(userId: number, projectId: number) {
  const rows = await listRoiRowsForUserProject(userId, projectId);
  return summarizeRoi(projectId, rows.map(({ roi, vault }) => ({
    vaultEntryId: roi.vaultEntryId,
    entitySerial: vault?.entitySerial ?? null,
    entityName: vault?.projectName ?? null,
    totalProfit: roi.totalProfit,
    totalCost: roi.totalCost,
    roi: roi.roi,
    recordedAt: roi.recordedAt,
  })));
}

export async function computeProjectPnlSummary(userId: number, projectId: number) {
  return computeProjectPnl(await sumLedgerByKind(userId, projectId));
}

export type MintReceiptResult =
  | { ok: true; token: string; url: string }
  | { ok: false; status: 404 | 500; error: string };

/** Mint (or fetch the existing) public link. Up to 3 attempts on a token collision. */
export async function mintPnlReceipt(userId: number, projectId: number): Promise<MintReceiptResult> {
  if (!(await projectExists(projectId))) return { ok: false, status: 404, error: "Project not found" };

  const existing = await findReceipt(userId, projectId);
  let token = existing?.receiptToken ?? null;
  if (!token) {
    for (let attempt = 0; attempt < 3 && !token; attempt++) {
      const candidate = generateProjectReceiptToken();
      try {
        const row = await insertReceipt(userId, projectId, candidate);
        token = row.receiptToken;
      } catch { /* unique collision — loop and retry */ }
    }
    if (!token) return { ok: false, status: 500, error: "Could not generate a receipt link, please try again" };
  }
  return { ok: true, token, url: projectReceiptUrl(token) };
}

/** True when a link existed and was revoked. */
export async function revokePnlReceipt(userId: number, projectId: number): Promise<boolean> {
  const deleted = await deleteReceipt(userId, projectId);
  return deleted.length > 0;
}

async function findProjectReceiptByToken(token: string) {
  const receipt = await findReceiptByToken(token);
  if (!receipt) return null;
  const project = await findProjectById(receipt.projectId);
  if (!project) return null;
  const issuedBy = (await findUsernameById(receipt.userId)) ?? null;
  const summary = await computeProjectPnlSummary(receipt.userId, receipt.projectId);
  return { receipt, project, issuedBy, summary };
}

/** Public card for a token; null when the link is invalid or revoked. */
export async function getPublicReceipt(token: string) {
  const found = await findProjectReceiptByToken(token);
  return found ? formatPublicReceipt(found, new Date()) : null;
}

/** PDF layout spec for a token; null when the link is invalid or revoked. */
export async function getPublicReceiptPdfSpec(token: string) {
  const card = await getPublicReceipt(token);
  return card ? buildProjectReceiptPdfSpec(card) : null;
}
