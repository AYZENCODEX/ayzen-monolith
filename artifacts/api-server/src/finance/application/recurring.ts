import { and, eq } from "drizzle-orm";
import { db, financeRecurringRulesTable } from "@workspace/db";

// Recurring rules CRUD and the manual "run now" trigger. Moved unchanged from routes/finance.ts
// (FIN-WP-5a). The route keeps HTTP validation of required fields, the PDP ownership middleware and
// response formatting (date serialisation, `active` as boolean on the list). Update and delete keep the
// `user_id` predicate the routes always had. The sweep itself lives in jobs/recurring.ts.

export interface RecurringRuleInput {
  kind?: string;
  title?: string;
  amount?: unknown;
  currency?: string;
  partyId?: number | null;
  projectId?: number | null;
  category?: string | null;
  interestRate?: number | null;
  frequency?: string;
  intervalCount?: unknown;
  startDate?: string;
  nextRunDate?: string;
  endDate?: string | null;
  active?: boolean;
  notes?: string | null;
}

export async function listRecurringRules(userId: number) {
  return db.select().from(financeRecurringRulesTable)
    .where(eq(financeRecurringRulesTable.userId, userId))
    .orderBy(financeRecurringRulesTable.nextRunDate);
}

/** Caller must have validated that kind, a non-blank title and amount are present. */
export async function createRecurringRule(userId: number, b: RecurringRuleInput & { kind: string; title: string }) {
  const start = b.startDate ? new Date(b.startDate) : new Date();
  const [row] = await db.insert(financeRecurringRulesTable).values({
    userId,
    kind: b.kind,
    title: b.title.trim(),
    amount: Number(b.amount) || 0,
    currency: b.currency || "BDT",
    partyId: b.partyId ?? null,
    projectId: b.projectId ?? null,
    category: b.category ?? null,
    interestRate: b.interestRate ?? null,
    frequency: b.frequency || "monthly",
    intervalCount: Number(b.intervalCount) || 1,
    startDate: start,
    nextRunDate: b.nextRunDate ? new Date(b.nextRunDate) : start,
    endDate: b.endDate ? new Date(b.endDate) : null,
    active: b.active === false ? 0 : 1,
    notes: b.notes ?? null,
  }).returning();
  return row;
}

/** Undefined fields are left unchanged. Returns undefined when the rule is not this user's. */
export async function updateRecurringRule(userId: number, id: number, b: Record<string, any>) {
  const update: Record<string, any> = { updatedAt: new Date() };
  for (const k of ["title", "amount", "currency", "partyId", "projectId", "category", "interestRate", "frequency", "intervalCount", "notes"]) {
    if (b[k] !== undefined) update[k] = b[k];
  }
  if (b.active !== undefined) update.active = b.active ? 1 : 0;
  if (b.nextRunDate !== undefined) update.nextRunDate = new Date(b.nextRunDate);
  if (b.endDate !== undefined) update.endDate = b.endDate ? new Date(b.endDate) : null;

  const [row] = await db.update(financeRecurringRulesTable)
    .set(update)
    .where(and(eq(financeRecurringRulesTable.id, id), eq(financeRecurringRulesTable.userId, userId)))
    .returning();
  return row;
}

/** Idempotent: deleting a missing or foreign rule removes nothing and does not throw. */
export async function deleteRecurringRule(userId: number, id: number): Promise<void> {
  await db.delete(financeRecurringRulesTable)
    .where(and(eq(financeRecurringRulesTable.id, id), eq(financeRecurringRulesTable.userId, userId)));
}

/** Manual trigger. Scoped to the caller (F1): only this user's due rules run and are counted. */
export async function runRecurringNow(userId: number) {
  // Loaded on demand: the sweep pulls in invoice, email and Telegram modules (legacy until WP-6) that the
  // CRUD use cases and their isolated-schema tests must not load.
  const { runFinanceRecurringSweep } = await import("../jobs/recurring");
  return runFinanceRecurringSweep({ userId });
}
