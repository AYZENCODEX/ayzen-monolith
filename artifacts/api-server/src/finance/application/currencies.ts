import { eq } from "drizzle-orm";
import { db, financeCurrencyRatesTable } from "@workspace/db";

// Per-user exchange rates to the base currency (BDT, fixed at 1 and never stored). Moved
// unchanged from routes/finance.ts; rate lookup for reports lives in application/reports.ts.

export async function listCurrencyRates(userId: number) {
  return db.select().from(financeCurrencyRatesTable).where(eq(financeCurrencyRatesTable.userId, userId));
}

export async function upsertCurrencyRate(userId: number, currency: string, rateToBase: number) {
  const [row] = await db.insert(financeCurrencyRatesTable)
    .values({ userId, currency, rateToBase })
    .onConflictDoUpdate({
      target: [financeCurrencyRatesTable.userId, financeCurrencyRatesTable.currency],
      set: { rateToBase, updatedAt: new Date() },
    })
    .returning();
  return row;
}
