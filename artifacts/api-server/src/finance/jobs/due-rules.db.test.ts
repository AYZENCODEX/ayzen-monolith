import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { after, test } from "node:test";
import { eq } from "drizzle-orm";
import { db, pool, financeRecurringRulesTable } from "@workspace/db";
import { selectDueRecurringRules } from "./due-rules";

// F1 regression: the manual "run now" sweep must only see the caller's rules, while the
// scheduled sweep (no userId) still sees everyone's. Runs in the isolated Finance schema.

if (process.env.DATABASE_URL_TARGET !== "replit-test") {
  throw new Error('Finance database tests require DATABASE_URL_TARGET="replit-test".');
}

const testUserIds = new Set<number>();
const nextTestUserId = (): number => {
  const userId = -randomInt(1, 2_000_000_000);
  testUserIds.add(userId);
  return userId;
};

const HOUR = 3_600_000;
const addRule = async (userId: number, fields: { nextRunDate: Date; active?: number }) => {
  const [rule] = await db.insert(financeRecurringRulesTable).values({
    userId,
    kind: "expense",
    title: "WP-1 due-rule scope",
    amount: 10,
    currency: "BDT",
    frequency: "monthly",
    intervalCount: 1,
    nextRunDate: fields.nextRunDate,
    active: fields.active ?? 1,
  }).returning();
  return rule;
};

after(async () => {
  try {
    for (const userId of testUserIds) {
      await db.delete(financeRecurringRulesTable).where(eq(financeRecurringRulesTable.userId, userId));
    }
  } finally {
    await pool.end();
  }
});

test("a user-scoped selection returns only that user's due, active rules", async () => {
  const now = new Date();
  const userA = nextTestUserId();
  const userB = nextTestUserId();
  const dueA = await addRule(userA, { nextRunDate: new Date(now.getTime() - HOUR) });
  const futureA = await addRule(userA, { nextRunDate: new Date(now.getTime() + 24 * HOUR) });
  const inactiveA = await addRule(userA, { nextRunDate: new Date(now.getTime() - HOUR), active: 0 });
  const dueB = await addRule(userB, { nextRunDate: new Date(now.getTime() - HOUR) });

  const rows = await selectDueRecurringRules(now, userA);
  const ids = rows.map((rule) => rule.id);
  assert.ok(rows.every((rule) => rule.userId === userA), "rows from another user returned");
  assert.ok(ids.includes(dueA.id));
  assert.ok(!ids.includes(futureA.id), "not-yet-due rule returned");
  assert.ok(!ids.includes(inactiveA.id), "inactive rule returned");
  assert.ok(!ids.includes(dueB.id), "other user's rule returned");
});

test("the unscoped selection used by the scheduled sweep still covers every user", async () => {
  const now = new Date();
  const userA = nextTestUserId();
  const userB = nextTestUserId();
  const dueA = await addRule(userA, { nextRunDate: new Date(now.getTime() - HOUR) });
  const dueB = await addRule(userB, { nextRunDate: new Date(now.getTime() - HOUR) });

  const ids = (await selectDueRecurringRules(now)).map((rule) => rule.id);
  assert.ok(ids.includes(dueA.id));
  assert.ok(ids.includes(dueB.id));
});
