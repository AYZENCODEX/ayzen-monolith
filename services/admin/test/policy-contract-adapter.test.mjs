import test from "node:test";
import assert from "node:assert/strict";
import { createAdminPolicyClient, decideAdminRole } from "../src/policy-contract-adapter.mjs";

test("Phase 07 -- admin consumer is pinned to the admin namespace", () => {
  assert.equal(createAdminPolicyClient().consumer, "admin");
  const result = decideAdminRole({ role: "operator", action: "users.suspend" });
  assert.equal(result.app, "admin");
  assert.equal(result.namespace, "admin");
  assert.equal(result.decision, "allow");
});

test("Phase 07 -- admin role checks: deny unknown role and insufficient role", () => {
  assert.equal(decideAdminRole({ role: "intern", action: "users.suspend" }).decision, "deny");
  const insufficient = decideAdminRole({ role: "auditor", action: "users.suspend", requiredRole: "operator" });
  assert.equal(insufficient.decision, "deny");
  assert.equal(insufficient.reason, "INSUFFICIENT_ROLE");
  assert.equal(decideAdminRole({ role: "owner", action: "users.suspend", requiredRole: "operator" }).decision, "allow");
});
