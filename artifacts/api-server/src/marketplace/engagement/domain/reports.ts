/**
 * marketplace/engagement/domain/reports.ts
 * MKT-05e: the pure rules of routes/marketplace-reports.ts, moved verbatim. No database, no HTTP.
 */
export const REPORT_ACTIONS = ["dismiss", "remove_listing"] as const;

export const validateReason = (reason: any): string | null => (!reason ? "reason is required" : null);

/** Seller report: the reason is checked first, then self-reporting (the order of the original checks). */
export function validateSellerReport(userId: number, sellerId: number, reason: any): string | null {
  if (!reason) return "reason is required";
  if (sellerId === userId) return "Cannot report yourself";
  return null;
}

export const isValidAction = (action: any): boolean => (REPORT_ACTIONS as readonly any[]).includes(action);

export const listingReportParams = (listingId: number, userId: number, reason: any, details: any): any[] => [listingId, userId, reason, details || null];
export const sellerReportParams = (sellerId: number, userId: number, reason: any, details: any): any[] => [sellerId, userId, reason, details || null];

/** The note stored on a resolved report: the admin's note, else the action name. */
export const resolveNote = (adminNote: any, action: string): string => adminNote || action;

/** remove_listing also removes the reported listing, but only when the report points at one. */
export const shouldRemoveListing = (action: string, report: { listing_id?: any }): boolean => action === "remove_listing" && !!report.listing_id;
