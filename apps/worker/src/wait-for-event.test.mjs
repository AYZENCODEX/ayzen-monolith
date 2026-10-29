import assert from "node:assert/strict";
import test from "node:test";
import { createEventWaiter } from "./wait-for-event.mjs";

function envelope({ eventType, correlationId, payload = {} }) {
  return { eventType, correlationId, payload, eventId: `evt-${Math.random()}` };
}

test("waitForEvent resolves once a matching (eventType, correlationId) event is notified", async () => {
  const waiter = createEventWaiter();
  const pending = waiter.waitForEvent("workflow.completed", { correlationId: "corr-1" });
  assert.equal(waiter.pendingCount(), 1);

  // An unrelated event (wrong type, wrong correlationId) must not resolve it.
  assert.equal(waiter.notify(envelope({ eventType: "workflow.completed", correlationId: "corr-other" })), false);
  assert.equal(waiter.notify(envelope({ eventType: "workflow.failed", correlationId: "corr-1" })), false);
  assert.equal(waiter.pendingCount(), 1);

  const matching = envelope({ eventType: "workflow.completed", correlationId: "corr-1", payload: { ok: true } });
  assert.equal(waiter.notify(matching), true);
  assert.equal(waiter.pendingCount(), 0);

  const resolved = await pending;
  assert.deepEqual(resolved, matching);
});

test("waitForEvent times out if nothing matching ever arrives", async () => {
  const waiter = createEventWaiter();
  await assert.rejects(
    waiter.waitForEvent("workflow.completed", { correlationId: "corr-timeout", timeoutMs: 20 }),
    (error) => error.code === "WORKFLOW_WAIT_FOR_EVENT_TIMEOUT",
  );
  assert.equal(waiter.pendingCount(), 0);
});

test("with no timeoutMs, waitForEvent waits indefinitely until notified", async () => {
  const waiter = createEventWaiter();
  const pending = waiter.waitForEvent("workflow.completed", { correlationId: "corr-forever" });
  let settled = false;
  pending.then(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(settled, false, "must not resolve on its own without a matching notify");
  waiter.notify(envelope({ eventType: "workflow.completed", correlationId: "corr-forever" }));
  await pending;
  assert.equal(settled, true);
});

test("two independent correlationIds for the same eventType don't cross-resolve", async () => {
  const waiter = createEventWaiter();
  const a = waiter.waitForEvent("workflow.completed", { correlationId: "corr-a" });
  const b = waiter.waitForEvent("workflow.completed", { correlationId: "corr-b" });
  waiter.notify(envelope({ eventType: "workflow.completed", correlationId: "corr-b", payload: { who: "b" } }));
  const resolvedB = await b;
  assert.equal(resolvedB.payload.who, "b");
  assert.equal(waiter.pendingCount(), 1, "corr-a must still be pending");
  waiter.notify(envelope({ eventType: "workflow.completed", correlationId: "corr-a", payload: { who: "a" } }));
  const resolvedA = await a;
  assert.equal(resolvedA.payload.who, "a");
});

test("waitForEvent requires an eventType and a correlationId", () => {
  const waiter = createEventWaiter();
  assert.throws(() => waiter.waitForEvent(), /eventType/);
  assert.throws(() => waiter.waitForEvent("workflow.completed"), /correlationId/);
});

test("a second wait on the same (eventType, correlationId) pair fails loudly instead of silently overwriting the first", async () => {
  const waiter = createEventWaiter();
  const first = waiter.waitForEvent("workflow.completed", { correlationId: "corr-dup", timeoutMs: 20 }).catch(() => {});
  assert.throws(
    () => waiter.waitForEvent("workflow.completed", { correlationId: "corr-dup" }),
    /Already waiting/,
  );
  await first;
});

test("notify() is a safe no-op when nothing is waiting", () => {
  const waiter = createEventWaiter();
  assert.equal(waiter.notify(envelope({ eventType: "workflow.completed", correlationId: "corr-nobody" })), false);
  assert.equal(waiter.notify({}), false);
  assert.equal(waiter.notify(undefined), false);
});
