/**
 * finance/domain/invoice-format.ts
 * Pure invoice presentation helpers (invoice numbering, amount in words).
 * No database, HTTP, filesystem, or provider dependencies. Moved verbatim from
 * lib/finance-invoice.ts; lib/invoice-pdf.ts previously held an identical copy
 * of amountInWords and now imports this owner.
 */

/** Human, sequential-looking invoice number — <prefix>-<year>-<5-digit id>, e.g. INV-2026-00042. Minted once at invoice creation and never changes even if the year rolls over while it's still unpaid. */
export function formatInvoiceNumber(prefix: string | null | undefined, id: number, createdAt: Date = new Date()): string {
  const p = (prefix || "INV").trim().toUpperCase().replace(/[^A-Z0-9]/g, "") || "INV";
  return `${p}-${createdAt.getFullYear()}-${String(id).padStart(5, "0")}`;
}

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
  "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function threeDigitsToWords(n: number): string {
  const parts: string[] = [];
  if (n >= 100) { parts.push(`${ONES[Math.floor(n / 100)]} Hundred`); n %= 100; }
  if (n >= 20) { parts.push(TENS[Math.floor(n / 10)]); n %= 10; if (n) parts.push(ONES[n]); }
  else if (n > 0) { parts.push(ONES[n]); }
  return parts.join(" ");
}

/** Whole-number-to-words, international scale (Thousand/Million/Billion) — good enough for an invoice footer; not meant for lakh/crore-style grouping. */
function integerToWords(n: number): string {
  if (n === 0) return "Zero";
  const scales: [number, string][] = [[1_000_000_000, "Billion"], [1_000_000, "Million"], [1_000, "Thousand"], [1, ""]];
  const parts: string[] = [];
  for (const [scale, label] of scales) {
    if (n >= scale) {
      const chunk = Math.floor(n / scale);
      n %= scale;
      parts.push(label ? `${threeDigitsToWords(chunk)} ${label}` : threeDigitsToWords(chunk));
    }
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/** "BDT Twelve Thousand and 50/100 Only" — the amount-in-words line under an enterprise invoice's totals block. Never throws; falls back to the plain number if anything about the input is unusable. */
export function amountInWords(currency: string, amount: number): string {
  try {
    const safe = Math.max(0, amount || 0);
    const whole = Math.floor(safe);
    const cents = Math.round((safe - whole) * 100);
    const words = integerToWords(whole);
    return `${currency} ${words}${cents > 0 ? ` and ${String(cents).padStart(2, "0")}/100` : ""} Only`;
  } catch {
    return `${currency} ${(amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
}
