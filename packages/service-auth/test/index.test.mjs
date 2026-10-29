import test from "node:test";
import assert from "node:assert/strict";
import { authorizeServiceCall, createServicePolicy } from "../src/index.mjs";

test("enforces target, audience, scope, and sensitive step-up", () => {
  const policy = createServicePolicy({ service: "api-gateway", audience: "identity", scopes: ["identity:read"], allowedTargets: ["identity"], sensitive: true });
  assert.equal(authorizeServiceCall({ policy, caller: "api-gateway", target: "identity", audience: "identity", scope: "identity:read" }).code, "STEP_UP_REQUIRED");
  assert.equal(authorizeServiceCall({ policy, caller: "api-gateway", target: "identity", audience: "identity", scope: "identity:read", stepUp: true }).decision, "allow");
  assert.equal(authorizeServiceCall({ policy, caller: "api-gateway", target: "vault", audience: "identity", stepUp: true }).decision, "deny");
});