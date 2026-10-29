/**
 * marketplace/kernel/domain/money.ts
 * MKT-03. The three fee-arithmetic forms the route files used inline, moved here VERBATIM so the floating-point result of
 * every call site stays bit-for-bit what it was. They are deliberately different (operation order changes the last bit):
 *   feeByFraction : amount * (pct / 100)               azn, usdt, nft, spot
 *   feeByProduct  : (amount * pct) / 100                P2P order approve / force-complete (marketplace.ts)
 *   feeRounded4   : Number(((amount * pct) / 100).toFixed(4))   cart totals
 * Money columns are REAL (float32) in the database and no schema change is allowed (D5), so nothing here rounds or "fixes"
 * anything. A rounding change is a separate, listed behavior change (BC-3).
 */

export function feeByFraction(amount: number, pct: number): number {
  return amount * (pct / 100);
}

export function feeByProduct(amount: number, pct: number): number {
  return (amount * pct) / 100;
}

export function feeRounded4(amount: number, pct: number): number {
  return Number(((amount * pct) / 100).toFixed(4));
}
