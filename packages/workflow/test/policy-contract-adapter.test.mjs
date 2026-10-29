import test from "node:test";
import assert from "node:assert/strict";
import { createWorkflowPolicyClient, decideWorkflowStep } from "../src/policy-contract-adapter.mjs";

test("Phase 07 -- workflow consumer: allow / conditional / deny", () => {
  assert.equal(createWorkflowPolicyClient({ app: "ryft" }).decide({ capability: "finance.list-accounts", subject: "wf-1", scopes: ["finance:read"] }).consumer, "workflow");
  assert.equal(decideWorkflowStep({ app: "ryft", capability: "finance.list-accounts", subject: "wf-1", scopes: ["finance:read"] }).decision, "allow");
  assert.equal(decideWorkflowStep({ app: "ryft", capability: "finance.post-transaction", subject: "wf-1", scopes: ["finance:write"] }).decision, "conditional");
  assert.equal(decideWorkflowStep({ app: "ryft", capability: "finance.post-transaction", scopes: ["finance:write"] }).decision, "deny");
});
