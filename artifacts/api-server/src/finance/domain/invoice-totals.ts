/**
 * Pure invoice amount calculations.
 *
 * Keep these rules independent of persistence and transport so they can be
 * characterized and reused without loading the wider invoice integration
 * module. The existing Number/Math.round behavior is intentional here:
 * callers rely on these totals, so changing precision policy is a separate
 * financial decision.
 */
export interface InvoiceLineItemInput {
  description: string;
  quantity: number;
  unitPrice: number;
}

export interface InvoiceTaxDiscountInput {
  discountType?: string | null; // 'flat' | 'percent' | null
  discountValue?: number | null;
  taxRate?: number | null; // percent
}

export interface InvoiceTotals {
  subtotal: number;
  discountAmount: number;
  taxableAmount: number;
  taxAmount: number;
  total: number;
}

export function computeLineItemsTotal(lines: InvoiceLineItemInput[]): number {
  return Math.round(lines.reduce((sum, line) => sum + (line.quantity || 0) * (line.unitPrice || 0), 0) * 100) / 100;
}

/**
 * Compose an invoice total in the existing order: subtotal → discount →
 * tax on the discounted amount → grand total.
 */
export function computeInvoiceTotals(
  lines: InvoiceLineItemInput[],
  cfg: InvoiceTaxDiscountInput = {},
): InvoiceTotals {
  const subtotal = computeLineItemsTotal(lines);
  const round2 = (value: number) => Math.round(value * 100) / 100;

  let discountAmount = 0;
  if (cfg.discountType === "percent") {
    discountAmount = round2(subtotal * Math.min(Math.max(cfg.discountValue || 0, 0), 100) / 100);
  } else if (cfg.discountType === "flat") {
    discountAmount = round2(Math.min(Math.max(cfg.discountValue || 0, 0), subtotal));
  }

  const taxableAmount = round2(subtotal - discountAmount);
  const taxAmount = round2(taxableAmount * Math.max(cfg.taxRate || 0, 0) / 100);
  const total = round2(taxableAmount + taxAmount);

  return { subtotal, discountAmount, taxableAmount, taxAmount, total };
}
