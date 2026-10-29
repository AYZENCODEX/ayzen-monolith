import { and, eq } from "drizzle-orm";
import { db, financePartiesTable } from "@workspace/db";

// Counterparties (people/organizations on receivables, payables, loans). Moved unchanged from
// routes/finance.ts; the route keeps HTTP validation and the ownership middleware.

export interface PartyInput {
  name?: string;
  contact?: string;
  notes?: string;
}

export async function listParties(userId: number) {
  return db.select().from(financePartiesTable).where(eq(financePartiesTable.userId, userId));
}

export async function createParty(userId: number, input: PartyInput & { name: string }) {
  const [row] = await db.insert(financePartiesTable)
    .values({ userId, name: input.name.trim(), contact: input.contact, notes: input.notes })
    .returning();
  return row;
}

/** Undefined fields are left unchanged (drizzle skips them). Returns undefined when not found for this user. */
export async function updateParty(userId: number, id: number, input: PartyInput) {
  const [row] = await db.update(financePartiesTable)
    .set({ name: input.name, contact: input.contact, notes: input.notes, updatedAt: new Date() })
    .where(and(eq(financePartiesTable.id, id), eq(financePartiesTable.userId, userId)))
    .returning();
  return row;
}

export async function deleteParty(userId: number, id: number): Promise<void> {
  await db.delete(financePartiesTable).where(and(eq(financePartiesTable.id, id), eq(financePartiesTable.userId, userId)));
}
