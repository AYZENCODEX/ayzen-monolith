import test from "node:test";
import assert from "node:assert/strict";
import { createConnectorRegistry } from "../src/index.mjs";

test("executes versioned connector operations with idempotency", async () => {
  let calls = 0;
  const registry = createConnectorRegistry({
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  registry.register({ id: "billing", version: 1, baseUrl: "https://billing.example", allowedHosts: ["billing.example"], operations: { charge: {} } });
  const first = await registry.execute({ connectorId: "billing", operation: "charge", path: "/charges", method: "POST", body: { amount: 10 }, idempotencyKey: "charge-1" });
  const second = await registry.execute({ connectorId: "billing", operation: "charge", path: "/charges", method: "POST", body: { amount: 10 }, idempotencyKey: "charge-1" });
  assert.equal(first.data.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(calls, 1);
});

test("rejects unregistered hosts and operations", () => {
  const registry = createConnectorRegistry();
  assert.throws(() => registry.register({ id: "bad", baseUrl: "https://bad.example", allowedHosts: ["good.example"], operations: {} }), /allowlisted/);
});