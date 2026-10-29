import test from "node:test";
import assert from "node:assert/strict";
import { createSchedulerPolicyClient, decideScheduledJob } from "../src/policy-contract-adapter.mjs";

test("Phase 07 -- scheduler consumer: allow / conditional / deny, always as a service actor", () => {
  assert.equal(createSchedulerPolicyClient({ app: "ryft" }).consumer, "scheduler");
  const allow = decideScheduledJob({ app: "ryft", capability: "finance.list-accounts", subject: "svc-billing", scopes: ["finance:read"] });
  assert.equal(allow.decision, "allow");
  assert.equal(allow.actorType, "service");
  assert.equal(decideScheduledJob({ app: "ryft", capability: "finance.post-transaction", subject: "svc-billing", scopes: ["finance:write"] }).decision, "conditional");
  assert.equal(decideScheduledJob({ app: "ryft", capability: "finance.post-transaction", scopes: ["finance:write"] }).decision, "deny");
});
