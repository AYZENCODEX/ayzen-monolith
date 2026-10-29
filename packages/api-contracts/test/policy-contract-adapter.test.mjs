import test from "node:test";
import assert from "node:assert/strict";
import { createApiPolicyClient, decideApiRoute } from "../src/policy-contract-adapter.mjs";

test("Phase 07 -- api consumer: route gate allow / deny / not-gated", () => {
  assert.equal(createApiPolicyClient({ app: "ryft" }).consumer, "api");
  const allow = decideApiRoute({ app: "ryft", method: "GET", pathname: "/api/finance/accounts", auth: { subject: "u-1" } });
  assert.equal(allow.decision, "allow");
  const deny = decideApiRoute({ app: "ryft", method: "GET", pathname: "/api/finance/accounts" });
  assert.equal(deny.decision, "deny");
  assert.equal(deny.reason, "AUTHENTICATED_SUBJECT_REQUIRED");
  assert.equal(decideApiRoute({ app: "ryft", method: "GET", pathname: "/api/unregistered/thing" }).reason, "NOT_GATED");
});
