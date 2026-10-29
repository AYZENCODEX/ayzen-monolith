import test from "node:test";
import assert from "node:assert/strict";
import { authorizeAppRequest, createAppSecurityContext } from "../../packages/app-api-security/src/index.mjs";

test("cross-app requests are denied by the app security boundary", () => {
  const context = createAppSecurityContext({
    app: "ryft",
    principal: { subject: "user:1", scopes: ["orders:read"], roles: ["viewer"] },
    tenant: { workspaceId: "workspace:1" },
    request: { requestId: "r1", traceId: "t1", correlationId: "c1" },
  });
  const policy = { version: 1, apps: { ryft: { defaultDeny: true, capabilities: { "orders.read": { scopes: ["orders:read"], roles: ["viewer"] } } } } };
  assert.equal(authorizeAppRequest({ context, targetApp: "sylo", capability: "orders.read", policy }).decision, "deny");
});