import test from "node:test";
import assert from "node:assert/strict";
import { authorizeAppRequest, createAppSecurityContext, signSecurityMetadata, verifySecurityMetadata } from "../src/index.mjs";

const policy = { version: 1, apps: { ryft: { defaultDeny: true, capabilities: { "order.read": { scopes: ["orders:read"], roles: ["viewer", "owner"] } } } } };
const context = createAppSecurityContext({
  app: "ryft",
  principal: { subject: "user:1", scopes: ["orders:read"], roles: ["viewer"] },
  tenant: { workspaceId: "workspace:1" },
  request: { requestId: "req-1", traceId: "trace-1", correlationId: "corr-1" },
});

test("allows only registered app capabilities", () => {
  assert.equal(authorizeAppRequest({ context, capability: "order.read", policy }).decision, "allow");
  assert.equal(authorizeAppRequest({ context, capability: "order.write", policy }).decision, "deny");
  assert.equal(authorizeAppRequest({ context, capability: "order.read", targetApp: "sylo", policy }).code, "APP_CONTEXT_MISMATCH");
});

test("signs and verifies request security metadata", () => {
  const signature = signSecurityMetadata({ app: "ryft", requestId: "req-1", bodyHash: "hash", secret: "test-secret" });
  assert.equal(verifySecurityMetadata({ app: "ryft", requestId: "req-1", bodyHash: "hash", signature, secret: "test-secret" }), true);
  assert.equal(verifySecurityMetadata({ app: "ryft", requestId: "req-1", bodyHash: "other", signature, secret: "test-secret" }), false);
});