import test from "node:test";
import assert from "node:assert/strict";
import { requireTenantScope, tenantScopeFromHeaders } from "../../packages/service-runtime/src/index.mjs";

test("tenant headers must match verified identity", () => {
  assert.deepEqual(
    tenantScopeFromHeaders({ "x-organization-id": "org-1" }, { auth: { organizationId: "org-1" } }),
    { organizationId: "org-1" },
  );
  assert.throws(
    () => tenantScopeFromHeaders({ "x-organization-id": "org-2" }, { auth: { organizationId: "org-1" } }),
    (error) => error.code === "TENANT_SCOPE_MISMATCH",
  );
  assert.throws(
    () => tenantScopeFromHeaders({ "x-workspace-id": "ws-1" }, { auth: { subject: "user-1" } }),
    (error) => error.code === "TENANT_SCOPE_NOT_VERIFIED",
  );
  assert.throws(() => requireTenantScope({}), (error) => error.code === "TENANT_SCOPE_REQUIRED");
});