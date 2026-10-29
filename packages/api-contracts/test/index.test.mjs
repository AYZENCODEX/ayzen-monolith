import test from "node:test";
import assert from "node:assert/strict";
import { createApiRequest, createApiError, createPage, createSchemaRegistry } from "../src/index.mjs";

test("creates versioned requests with trace and idempotency context", () => {
  const request = createApiRequest({ method: "POST", path: "/v1/orders", app: "ryft", operation: "order.create", idempotencyKey: "order-12345678" });
  assert.equal(request.version, "v1");
  assert.equal(request.context.correlationId.length > 10, true);
  assert.equal(request.idempotencyKey, "order-12345678");
});

test("creates stable errors and bounded pages", () => {
  assert.equal(createApiError({ code: "RATE_LIMITED", message: "Slow down", status: 429 }).error.retryable, false);
  assert.equal(createPage({ items: ["a"], page: 1, pageSize: 10, total: 1 }).items.length, 1);
  assert.throws(() => createPage({ items: [], pageSize: 1001 }), /Invalid page/);
});

test("rejects duplicate schema versions", () => {
  assert.throws(() => createSchemaRegistry([{ name: "order", version: 1 }, { name: "order", version: 1 }]), /Duplicate/);
});