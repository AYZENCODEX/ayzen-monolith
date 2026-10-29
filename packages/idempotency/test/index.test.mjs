import test from "node:test";
import assert from "node:assert/strict";
import {
  createIdempotencyStore,
  createInMemoryIdempotencyStore,
  createPostgresIdempotencyStore,
  createSharedIdempotencyStore,
} from "../src/index.mjs";

test("prevents duplicate effects and conflicting key reuse", () => {
  const store = createIdempotencyStore();
  const reservation = store.begin({ scope: "orders", key: "1", request: { amount: 5 } });
  reservation.complete({ orderId: "order-1" });
  assert.deepEqual(store.begin({ scope: "orders", key: "1", request: { amount: 5 } }).value, { orderId: "order-1" });
  assert.throws(() => store.begin({ scope: "orders", key: "1", request: { amount: 6 } }), /different request/);
});

/**
 * Minimal in-process stand-in for a pg.Pool#query-shaped function, backed by
 * a plain Map keyed by row id, so createPostgresIdempotencyStore's SQL can be
 * exercised without a real Postgres instance. Good enough to prove the
 * get/set/expiry contract; not a SQL engine.
 */
function createFakeDb() {
  const rows = new Map();
  return async function query(text, params = []) {
    const sql = text.replace(/\s+/g, " ").trim();
    if (sql.startsWith("CREATE TABLE") || sql.startsWith("CREATE INDEX")) return { rows: [] };
    if (sql.startsWith("INSERT INTO idempotency_records")) {
      const [key, responseJson, ttlMs] = params;
      rows.set(key, { key, response: JSON.parse(responseJson), expiresAt: Date.now() + Number(ttlMs) });
      return { rows: [] };
    }
    if (sql.startsWith("SELECT response FROM idempotency_records")) {
      const [key] = params;
      const row = rows.get(key);
      return { rows: row && row.expiresAt > Date.now() ? [{ response: row.response }] : [] };
    }
    if (sql.startsWith("DELETE FROM idempotency_records")) {
      for (const [key, row] of rows) if (row.expiresAt <= Date.now()) rows.delete(key);
      return { rows: [] };
    }
    if (sql.startsWith("SELECT count(*)")) {
      let count = 0;
      for (const row of rows.values()) if (row.expiresAt > Date.now()) count += 1;
      return { rows: [{ count }] };
    }
    throw new Error(`Unhandled fake query: ${sql}`);
  };
}

test("createPostgresIdempotencyStore replays a cached response for a repeated key", async () => {
  const query = createFakeDb();
  const store = await createPostgresIdempotencyStore({ query });
  assert.equal(await store.get("finance:acct-1:retry-key"), undefined);
  await store.set("finance:acct-1:retry-key", { status: 201, body: { id: "txn-1" } });
  assert.deepEqual(await store.get("finance:acct-1:retry-key"), { status: 201, body: { id: "txn-1" } });
  assert.equal(await store.size(), 1);
});

test("createPostgresIdempotencyStore shares reservations across replicas backed by the same table", async () => {
  // Two independent store instances over the same fake DB stand in for two
  // replicas behind a load balancer: a key set by "replica A" must be
  // visible to "replica B" without either holding process-local state.
  const query = createFakeDb();
  const replicaA = await createPostgresIdempotencyStore({ query });
  const replicaB = await createPostgresIdempotencyStore({ query });
  await replicaA.set("mail:send:retry-key", { status: 202, body: { id: "msg-1" } });
  assert.deepEqual(await replicaB.get("mail:send:retry-key"), { status: 202, body: { id: "msg-1" } });
});

test("createPostgresIdempotencyStore expires entries past ttlMs", async () => {
  const query = createFakeDb();
  const store = await createPostgresIdempotencyStore({ query, ttlMs: 1 });
  await store.set("ai:task:retry-key", { status: 200, body: {} });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(await store.get("ai:task:retry-key"), undefined);
});

test("createSharedIdempotencyStore requires a query function unless memory fallback is allowed", async () => {
  await assert.rejects(
    () => createSharedIdempotencyStore({ service: "finance" }),
    /requires DATABASE_URL/,
  );
  const memoryStore = await createSharedIdempotencyStore({ service: "finance", allowMemoryFallback: true });
  memoryStore.set("finance:acct-1:retry-key", { status: 201 });
  assert.deepEqual(memoryStore.get("finance:acct-1:retry-key"), { status: 201 });
});

test("createInMemoryIdempotencyStore dedups within one process", () => {
  const store = createInMemoryIdempotencyStore();
  store.set("workflow:run-1:retry-key", { status: 201, body: { id: "run-1" } });
  assert.deepEqual(store.get("workflow:run-1:retry-key"), { status: 201, body: { id: "run-1" } });
});