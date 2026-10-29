import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";

// Per-user invoice branding (logo/theme/business details), stored on the users row.
// Moved unchanged from routes/finance-invoices.ts (FIN-WP-2b). The route keeps the
// themeColor format check (HTTP validation).

const BRANDING_COLUMNS = {
  logoUrl: usersTable.financeInvoiceLogoUrl,
  themeColor: usersTable.financeInvoiceThemeColor,
  businessName: usersTable.financeInvoiceBusinessName,
  businessAddress: usersTable.financeInvoiceBusinessAddress,
  footerNote: usersTable.financeInvoiceFooterNote,
  taxId: usersTable.financeInvoiceTaxId,
  businessEmail: usersTable.financeInvoiceBusinessEmail,
  businessPhone: usersTable.financeInvoiceBusinessPhone,
  website: usersTable.financeInvoiceWebsite,
  termsText: usersTable.financeInvoiceTerms,
  numberPrefix: usersTable.financeInvoiceNumberPrefix,
};

export async function getInvoiceBranding(userId: number) {
  const [row] = await db.select(BRANDING_COLUMNS).from(usersTable).where(eq(usersTable.id, userId));
  return row ?? {
    logoUrl: null, themeColor: "#00a89f", businessName: null, businessAddress: null, footerNote: null,
    taxId: null, businessEmail: null, businessPhone: null, website: null, termsText: null, numberPrefix: "INV",
  };
}

/** Only keys present in `body` are written. Caller must have validated themeColor. */
export async function updateInvoiceBranding(userId: number, body: Record<string, any>) {
  const patch: Record<string, any> = {};
  if ("logoUrl" in body) patch.financeInvoiceLogoUrl = body.logoUrl || null;
  if ("themeColor" in body) patch.financeInvoiceThemeColor = body.themeColor || "#00a89f";
  if ("businessName" in body) patch.financeInvoiceBusinessName = body.businessName || null;
  if ("businessAddress" in body) patch.financeInvoiceBusinessAddress = body.businessAddress || null;
  if ("footerNote" in body) patch.financeInvoiceFooterNote = body.footerNote || null;
  if ("taxId" in body) patch.financeInvoiceTaxId = body.taxId || null;
  if ("businessEmail" in body) patch.financeInvoiceBusinessEmail = body.businessEmail || null;
  if ("businessPhone" in body) patch.financeInvoiceBusinessPhone = body.businessPhone || null;
  if ("website" in body) patch.financeInvoiceWebsite = body.website || null;
  if ("termsText" in body) patch.financeInvoiceTerms = body.termsText || null;
  if ("numberPrefix" in body) patch.financeInvoiceNumberPrefix = (body.numberPrefix || "INV").toString().trim().toUpperCase().replace(/[^A-Z0-9]/g, "") || "INV";

  const [row] = await db.update(usersTable).set(patch).where(eq(usersTable.id, userId)).returning(BRANDING_COLUMNS);
  return row;
}
