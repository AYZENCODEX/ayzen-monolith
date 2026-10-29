import test from "node:test";
import assert from "node:assert/strict";
import { ALERT_OWNER_SENTINEL_NONE, createAlertResourceBuilder } from "./alert-resource";

const req = (id: string) => ({ params: { id } }) as any;

test("a non-numeric id maps to the sentinel owner without touching the database", async () => {
  let called = 0;
  const b = createAlertResourceBuilder({ async findAlertOwner() { called++; return []; } });
  assert.deepEqual(await b(req("abc")), { type: "marketplace_alert", id: "abc", ownerId: ALERT_OWNER_SENTINEL_NONE });
  assert.equal(called, 0);
});
test("an existing alert maps to its owner; a missing one to the sentinel", async () => {
  const hit = createAlertResourceBuilder({ async findAlertOwner(id: number) { return id === 5 ? [{ user_id: 9 }] : []; } });
  assert.deepEqual(await hit(req("5")), { type: "marketplace_alert", id: 5, ownerId: 9 });
  assert.deepEqual(await hit(req("6")), { type: "marketplace_alert", id: 6, ownerId: -1 });
  assert.equal(ALERT_OWNER_SENTINEL_NONE, -1);
});
