import {
  db, financeInvoicesTable, financeInvoiceLineItemsTable, usersTable,
  type FinanceInvoice, type FinanceInvoiceLineItem,
} from "@workspace/db";
import { eq, asc } from "drizzle-orm";
import {
  computeLineItemsTotal,
  type InvoiceLineItemInput,
} from "../domain/invoice-totals";
import type { FinanceDbTransaction } from "../ledger/journal";

// Invoice persistence helpers. Moved from lib/finance-invoice.ts (FIN-WP-6a).
//
// Keep the current invoice persistence contract: amount remains the denormalized total consumed by reminders,
// late fees, partial-payment math, and the linked-ledger path. Pure calculations live in finance/domain.
//
// Changes against the legacy code (both recorded in finance-safety-findings.md):
//  - F15: replaceInvoiceLineItems deleted the old lines and inserted the new ones as two statements outside a
//    transaction, so a failed insert left the invoice with no lines. It is now one transaction, and
//    replaceInvoiceLineItemsInTx lets a caller make it part of a larger one (create, edit).
//  - getCreditorProfile selects only the columns the invoice code reads instead of the whole users row, so the
//    public invoice and PDF routes no longer load the creditor's credentials into memory. Same values.

export async function getInvoiceByToken(token: string): Promise<FinanceInvoice | null> {
  const [row] = await db.select().from(financeInvoicesTable).where(eq(financeInvoicesTable.invoiceToken, token)).limit(1);
  return row ?? null;
}

export async function getInvoiceLineItems(invoiceId: number): Promise<FinanceInvoiceLineItem[]> {
  return db.select().from(financeInvoiceLineItemsTable)
    .where(eq(financeInvoiceLineItemsTable.invoiceId, invoiceId))
    .orderBy(asc(financeInvoiceLineItemsTable.sortOrder), asc(financeInvoiceLineItemsTable.id));
}

/**
 * Replaces every line item on an invoice inside the caller's transaction and returns the new computed total.
 * Falls back to a single "Invoice total" line if the caller passes none, so every invoice keeps at least one row.
 */
export async function replaceInvoiceLineItemsInTx(tx: FinanceDbTransaction, invoiceId: number, lines: InvoiceLineItemInput[]): Promise<number> {
  const clean = (lines ?? []).filter(l => l.description?.trim());
  const effective = clean.length > 0 ? clean : [{ description: "Invoice total", quantity: 1, unitPrice: 0 }];

  await tx.delete(financeInvoiceLineItemsTable).where(eq(financeInvoiceLineItemsTable.invoiceId, invoiceId));
  await tx.insert(financeInvoiceLineItemsTable).values(
    effective.map((l, i) => ({
      invoiceId,
      description: l.description.trim(),
      quantity: l.quantity || 1,
      unitPrice: l.unitPrice || 0,
      sortOrder: i,
    })),
  );
  return computeLineItemsTotal(effective);
}

/** Replaces every line item on an invoice atomically (F15) and returns the new computed total. */
export async function replaceInvoiceLineItems(invoiceId: number, lines: InvoiceLineItemInput[]): Promise<number> {
  return db.transaction((tx) => replaceInvoiceLineItemsInTx(tx, invoiceId, lines));
}

// Keys keep the users-table property names so brandingFromUser() (application/invoices.ts) is unchanged.
const CREDITOR_PROFILE_COLUMNS = {
  username: usersTable.username,
  financeInvoiceNumberPrefix: usersTable.financeInvoiceNumberPrefix,
  financeInvoiceLogoUrl: usersTable.financeInvoiceLogoUrl,
  financeInvoiceThemeColor: usersTable.financeInvoiceThemeColor,
  financeInvoiceBusinessName: usersTable.financeInvoiceBusinessName,
  financeInvoiceBusinessAddress: usersTable.financeInvoiceBusinessAddress,
  financeInvoiceFooterNote: usersTable.financeInvoiceFooterNote,
  financeInvoiceTaxId: usersTable.financeInvoiceTaxId,
  financeInvoiceBusinessEmail: usersTable.financeInvoiceBusinessEmail,
  financeInvoiceBusinessPhone: usersTable.financeInvoiceBusinessPhone,
  financeInvoiceWebsite: usersTable.financeInvoiceWebsite,
  financeInvoiceTerms: usersTable.financeInvoiceTerms,
};

export async function getCreditorProfile(userId: number) {
  const [row] = await db.select(CREDITOR_PROFILE_COLUMNS).from(usersTable).where(eq(usersTable.id, userId));
  return row;
}
