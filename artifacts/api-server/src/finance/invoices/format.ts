// Tiny presentation helpers shared by the invoice routes and use cases (moved from routes/finance-invoices.ts,
// FIN-WP-6a). Unchanged.

export function iso(d: Date | string | null | undefined) {
  if (!d) return null;
  return typeof d === "string" ? d : d.toISOString();
}

export function money(currency: string, amount: number): string {
  return `${currency} ${amount.toLocaleString()}`;
}
