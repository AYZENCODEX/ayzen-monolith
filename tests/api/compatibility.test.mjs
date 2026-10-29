import test from "node:test";
import assert from "node:assert/strict";
import { createApiRequest, createApiResponse } from "../../packages/api-contracts/src/index.mjs";

test("API compatibility preserves version and trace envelope", () => {
  const request = createApiRequest({ method: "GET", path: "/v1/health", app: "platform", operation: "health.read" });
  const response = createApiResponse({ data: { ok: true }, context: request.context });
  assert.equal(request.version, "v1");
  assert.equal(response.context.traceId, request.context.traceId);
});