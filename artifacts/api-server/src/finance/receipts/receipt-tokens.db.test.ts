import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { after, test } from "node:test";
import { eq } from "drizzle-orm";
import { db, pool, financeLedgerEntriesTable } from "@workspace/db";
import { ensureReceiptToken, financeReceiptUrl, generateReceiptToken } from "./receipt-tokens";

if (process.env.DATABASE_URL_TARGET !== "replit-test") {
  throw new Error('Finance database tests require DATABASE_URL_TARGET="replit-test".');
}

const testUserIds = new Set<number>();

function nextTestUserId(): number {
  const userId = -randomInt(1, 2_000_000_000);
  testUserIds.add(userId);
  return userId;
}

after(async () => {
  try {
    for (const userId of testUserIds) {
      await db.delete(financeLedgerEntriesTable).where(eq(financeLedgerEntriesTable.userId, userId));
    }
  } finally {
    await pool.end();
  }
});

test("receipt token generation and URL formatting preserve the public receipt contract", () => {
  const previousAppUrl = process.env.APP_URL;
  process.env.APP_URL = "https://receipts.example";
  try {
    const token = generateReceiptToken();
    assert.match(token, /^[A-Za-z0-9_-]{27}$/);
    assert.equal(financeReceiptUrl(token), `https://receipts.example/finance/receipt/${token}`);
  } finally {
    if (previousAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = previousAppUrl;
  }
});

test("receipt tokens are idempotent and scoped to the owning user", async () => {
  const userId = nextTestUserId();
  const [entry] = await db.insert(financeLedgerEntriesTable).values({
    userId,
    kind: "receivable",
    title: "Receipt-token characterization",
    amount: 12.5,
    currency: "BDT",
    status: "pending",
  }).returning({ id: financeLedgerEntriesTable.id });

  const first = await ensureReceiptToken(entry.id, userId);
  const second = await ensureReceiptToken(entry.id, userId);
  const wrongOwner = await ensureReceiptToken(entry.id, userId - 1);
  assert.ok(first);
  assert.equal(first, second);
  assert.equal(wrongOwner, null);
});
