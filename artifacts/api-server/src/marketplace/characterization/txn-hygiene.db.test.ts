// MKT-01b-1: MKT-ISSUE-8. Run in its own file: the defect leaves a pooled connection inside an open transaction, which would
// disturb any later test in the same process. The pool is ended at the end of the file.
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import marketplaceRouter from "../../routes/marketplace";
import { call, createUser, pool, resetTables, startApp } from "./harness";

let app: { base: string; close: () => Promise<void> };
before(async () => { app = await startApp([marketplaceRouter]); });
after(async () => { await app.close(); await pool.end(); });
beforeEach(resetTables);

const idleInTransaction = async (): Promise<number> =>
  (await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction' AND pid <> pg_backend_pid()")).rows[0].n;

test("DEFECT PINNED (MKT-ISSUE-8): PATCH /admin/marketplace/orders/:id with an unknown id leaves its connection idle in transaction", async () => {
  const adminId = await createUser("admin");
  const idleBefore = await idleInTransaction();
  const r = await call(app.base, { userId: adminId, role: "admin" }, "PATCH", "/admin/marketplace/orders/999999", { action: "approve" });
  assert.deepEqual([r.status, r.json], [404, { error: "Order not found" }]);
  const after_ = await idleInTransaction();
  assert.equal(after_, idleBefore + 1, "BEGIN was issued, no ROLLBACK, and the client went back to the pool");
});
