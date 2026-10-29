import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { after, test } from "node:test";
import { eq } from "drizzle-orm";
import { db, pool, financePaymentMethodsTable } from "@workspace/db";
import {
  createFinancePaymentMethod,
  deleteFinancePaymentMethod,
  listActivePaymentMethods,
  listFinancePaymentMethods,
  updateFinancePaymentMethod,
} from "./payment-methods";

if (process.env.DATABASE_URL_TARGET !== "replit-test") {
  throw new Error('Finance database tests require DATABASE_URL_TARGET="replit-test".');
}

const userIds = new Set<number>();

function nextTestUserId(): number {
  const userId = -randomInt(1, 2_000_000_000);
  userIds.add(userId);
  return userId;
}

after(async () => {
  try {
    for (const userId of userIds) {
      await db.delete(financePaymentMethodsTable)
        .where(eq(financePaymentMethodsTable.userId, userId));
    }
  } finally {
    await pool.end();
  }
});

test("payment-method owner preserves ordering, default reset, active filtering, and public QR output", async () => {
  const userId = nextTestUserId();
  const first = await createFinancePaymentMethod(userId, {
    methodType: "bkash",
    label: "Personal",
    accountNumber: "01700000000",
  });
  const second = await createFinancePaymentMethod(userId, {
    methodType: "bank",
    bankAccountNumber: "123456789",
    isDefault: true,
  });
  assert.ok(first);
  assert.ok(second);

  const stored = await listFinancePaymentMethods(userId);
  assert.deepEqual(stored.map((row) => row.id), [second.id, first.id]);
  assert.equal(stored[0]?.isDefault, 1);
  assert.equal(stored[1]?.isDefault, 0);

  const publicMethods = await listActivePaymentMethods(userId);
  assert.equal(publicMethods.length, 2);
  assert.equal(publicMethods.find((method) => method.methodType === "bank")?.isDefault, true);
  assert.equal(publicMethods.find((method) => method.methodType === "bank")?.qrDataUrl?.startsWith("data:image/png;base64,"), true);
  assert.equal(publicMethods.find((method) => method.methodType === "bkash")?.qrDataUrl?.startsWith("data:image/png;base64,"), true);

  const updated = await updateFinancePaymentMethod(userId, second.id, {
    label: "Primary bank",
    isDefault: false,
  });
  assert.equal(updated?.label, "Primary bank");
  assert.equal(updated?.isDefault, 0);
  assert.equal(await deleteFinancePaymentMethod(userId, second.id), true);
  assert.equal(await deleteFinancePaymentMethod(userId, second.id), false);
  assert.equal((await listFinancePaymentMethods(userId)).length, 1);
});
