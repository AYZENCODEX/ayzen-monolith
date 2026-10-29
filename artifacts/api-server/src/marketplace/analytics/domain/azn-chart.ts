/**
 * marketplace/analytics/domain/azn-chart.ts
 * MKT-05f: GET /marketplace/azn/chart, moved verbatim. IMPORTANT: this is SYNTHETIC data, not a market price. It is generated
 * from a date-seeded pseudo random series (100 AZN = 1 USD, base price 0.01 USD per AZN), and only the very last point uses the
 * random source it is given (Math.random in the route) to wobble around the base. There is no SQL. `now` and `random` are
 * injected so the function is testable; the route passes `new Date()` and Math.random exactly where the handler used them.
 * Date arithmetic uses the local-time getters and setDate as in the original.
 */
export interface ChartPoint { date: string; open: number; high: number; low: number; close: number; volume: number; price_usd: number; azn_per_usd: number }

export function buildAznChart(now: Date, random: () => number): { base_usd: number; azn_per_usd: number; data: ChartPoint[] } {
  const BASE_PRICE = 0.01; // USD per AZN
  const days = 30;
  const data: ChartPoint[] = [];

  let price = BASE_PRICE;
  for (let i = days; i >= 0; i--) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().slice(0, 10);

    // Seed based on date for determinism
    const seed = date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();
    const pseudoRand = (s: number) => ((s * 1664525 + 1013904223) & 0x7FFFFFFF) / 0x7FFFFFFF;

    const r1 = pseudoRand(seed);
    const r2 = pseudoRand(seed + 1);
    const r3 = pseudoRand(seed + 2);
    const r4 = pseudoRand(seed + 3);

    // Daily swing: up to 8% intraday but close within 2% of open
    const intraSwing = (r1 - 0.5) * 0.08;
    const closeAdj = (r2 - 0.5) * 0.02;

    const open = price;
    const high = price * (1 + Math.abs(intraSwing) + r3 * 0.02);
    const low = price * (1 - Math.abs(intraSwing) - r4 * 0.02);
    const close = price * (1 + closeAdj);

    data.push({
      date: dateStr,
      open: Number(open.toFixed(5)),
      high: Number(high.toFixed(5)),
      low: Number(low.toFixed(5)),
      close: Number(close.toFixed(5)),
      volume: Math.floor(10000 + r1 * 90000),
      price_usd: Number(close.toFixed(5)),
      azn_per_usd: Math.round(1 / close),
    });

    price = close; // next day opens where today closed
  }

  // Always ensure latest price stays near base (stable)
  const last = data[data.length - 1];
  last.close = BASE_PRICE * (1 + (random() - 0.5) * 0.01);
  last.price_usd = last.close;
  last.azn_per_usd = Math.round(1 / last.close);

  return { base_usd: BASE_PRICE, azn_per_usd: 100, data };
}
