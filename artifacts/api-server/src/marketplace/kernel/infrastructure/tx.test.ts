import test from "node:test";
import assert from "node:assert/strict";
import { TxAbort, withTransaction, type TxClient, type TxPool } from "./tx";

function fake(opts: { failOn?: string; failConnect?: boolean } = {}) {
  const log: string[] = [];
  let released = 0;
  const client: TxClient = {
    async query(text: string) {
      log.push(text);
      if (opts.failOn && text === opts.failOn) throw new Error(`boom on ${text}`);
      return { rows: [], rowCount: 0 };
    },
    release() { released++; },
  };
  const pool: TxPool = { async connect() { if (opts.failConnect) throw new Error("no connection"); return client; } };
  return { pool, log, released: () => released };
}

test("commit path: BEGIN, work, COMMIT, release once", async () => {
  const f = fake();
  const out = await withTransaction(f.pool, async (c) => { await c.query("WORK"); return 42; });
  assert.deepEqual(out, { committed: true, value: 42 });
  assert.deepEqual(f.log, ["BEGIN", "WORK", "COMMIT"]);
  assert.equal(f.released(), 1);
});
test("error in the work: ROLLBACK, the original error is rethrown, release once, no COMMIT", async () => {
  const f = fake();
  await assert.rejects(withTransaction(f.pool, async () => { throw new Error("work failed"); }), /work failed/);
  assert.deepEqual(f.log, ["BEGIN", "ROLLBACK"]);
  assert.equal(f.released(), 1);
});
test("TxAbort: ROLLBACK, no throw, the abort result comes back, release once", async () => {
  const f = fake();
  const out = await withTransaction(f.pool, async () => { throw new TxAbort({ status: 400, error: "Insufficient balance" }); });
  assert.deepEqual(out, { committed: false, abort: { status: 400, error: "Insufficient balance" } });
  assert.deepEqual(f.log, ["BEGIN", "ROLLBACK"]);
  assert.equal(f.released(), 1);
});
test("a failing ROLLBACK is not swallowed (same as the hand-written handlers) and the client is still released", async () => {
  const f = fake({ failOn: "ROLLBACK" });
  await assert.rejects(withTransaction(f.pool, async () => { throw new Error("work failed"); }), /boom on ROLLBACK/);
  assert.equal(f.released(), 1);
});
test("a failing COMMIT rolls back and rethrows", async () => {
  const f = fake({ failOn: "COMMIT" });
  await assert.rejects(withTransaction(f.pool, async () => 1), /boom on COMMIT/);
  assert.deepEqual(f.log, ["BEGIN", "COMMIT", "ROLLBACK"]);
  assert.equal(f.released(), 1);
});
test("connect failure: nothing runs and nothing is released", async () => {
  const f = fake({ failConnect: true });
  await assert.rejects(withTransaction(f.pool, async () => 1), /no connection/);
  assert.deepEqual(f.log, []);
  assert.equal(f.released(), 0);
});
