import test from "node:test";
import assert from "node:assert/strict";
import { createAdminGateway } from "../../services/admin-gateway/src/index.mjs";

test("admin gateway does not silently bypass policy", async () => {
  const gateway = createAdminGateway({ services: { platform: { health: async () => "ok" } } });
  const result = await gateway.execute({ capability: "admin.read", service: "platform", operation: "health", subject: "operator" });
  assert.ok([200, 403].includes(result.status));
  assert.equal(result.policy.audit, true);
});