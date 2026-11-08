/** Currency / percentage formatting shared by the Sylo console. USD only: every Sylo figure is USD-denominated. */
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const usdCompact = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 });

export const formatUsd = (n: number, opts: { compact?: boolean } = {}): string =>
  (opts.compact ? usdCompact : usd).format(Number.isFinite(n) ? n : 0);

/** "+$1,200.00" / "−$300.00" — explicit sign so profit and loss read at a glance. */
export const formatSignedUsd = (n: number): string => {
  const v = Number.isFinite(n) ? n : 0;
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${usd.format(Math.abs(v))}`;
};

export const formatPct = (n: number, digits = 1): string =>
  `${Number.isFinite(n) ? n.toFixed(digits) : "0.0"}%`;

/** ROI as a percentage of cost; null when there is no cost basis to compare against. */
export const roiPct = (worth: number, buy: number): number | null => (buy > 0 ? ((worth - buy) / buy) * 100 : null);
