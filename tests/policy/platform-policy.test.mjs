import test from "node:test";
import assert from "node:assert/strict";
import { createPolicyDecisionPoint } from "../../packages/platform-governance/src/index.mjs";

test("policy decision point defaults to deny and records an audit decision", () => {
  const audit = [];
  const pdp = createPolicyDecisionPoint({ policies: { ryft: { "finance.read": true } }, audit: (entry) => audit.push(entry) });
  assert.equal(pdp.decide({ subject: "user-1", app: "ryft", action: "finance.read", resource: "finance" }).decision, "allow");
  assert.equal(pdp.decide({ subject: "user-1", app: "ryft", action: "finance.write", resource: "finance" }).decision, "deny");
  assert.equal(audit.length, 2);
});