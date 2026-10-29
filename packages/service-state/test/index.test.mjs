import assert from "node:assert/strict";
import { test } from "node:test";
import { createPostgresStateStore, createStateStore, createInMemoryStateStore } from "../src/index.mjs";

function createFakeDb() {
  const table = new Map(); // key: `${service}:${collection}:${id}` -> row
  const key = (service, collection, id) => `${service}:${collection}:${id}`;
  let failNext = 0;
  return {
    failNextWrites(n) { failNext = n; },
    async query(text, params) {
      if (/CREATE TABLE/i.test(text)) return { rows: [] };
      if (/^\s*SELECT/i.test(text)) {
        const [service, collection] = params;
        const rows = [...table.values()]
          .filter((r) => r.service === service && r.collection === collection)
          .map((r) => ({ id: r.id, data: r.data }));
        return { rows };
      }
      if (/^\s*INSERT/i.test(text)) {
        if (failNext > 0) { failNext -= 1; throw new Error("simulated transient failure"); }
        const [service, collection, id, dataJson] = params;
        table.set(key(service, collection, id), { service, collection, id, data: JSON.parse(dataJson) });
        return { rows: [] };
      }
      if (/^\s*DELETE/i.test(text)) {
        if (failNext > 0) { failNext -= 1; throw new Error("simulated transient failure"); }
        const [service, collection, id] = params;
        table.delete(key(service, collection, id));
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${text}`);
    },
    dump() { return [...table.values()]; },
  };
}

test("hydrates existing rows and persists new writes", async () => {
  const db = createFakeDb();
  await db.query("INSERT INTO x", ["finance", "accounts", "acc1", JSON.stringify({ balance: 100 })]);

  const store = await createPostgresStateStore({ query: db.query, service: "finance", collection: "accounts" });
  assert.equal(store.get("acc1").balance, 100, "should hydrate pre-existing row");

  store.set("acc2", { balance: 50 });
  await store.flush();
  assert.equal(db.dump().find((r) => r.id === "acc2").data.balance, 50);

  store.delete("acc1");
  await store.flush();
  assert.equal(db.dump().find((r) => r.id === "acc1"), undefined, "delete should remove the durable row too");
  assert.equal(store.has("acc1"), false);
});

test("retries a write that fails transiently instead of dropping it", async () => {
  const db = createFakeDb();
  const store = await createPostgresStateStore({ query: db.query, service: "vault", collection: "records" });
  db.failNextWrites(1);
  store.set("rec1", { secret: "shh" });
  await store.flush();
  assert.equal(db.dump().find((r) => r.id === "rec1").data.secret, "shh", "retried write should eventually land");
});

test("createStateStore throws without a query fn unless memory fallback is explicitly allowed", async () => {
  await assert.rejects(() => createStateStore({ service: "x", collection: "y" }));
  const store = await createStateStore({ service: "x", collection: "y", allowMemoryFallback: true });
  assert.ok(store instanceof Map);
});

test("createInMemoryStateStore is a plain Map", () => {
  const store = createInMemoryStateStore();
  store.set("a", 1);
  assert.equal(store.get("a"), 1);
});
