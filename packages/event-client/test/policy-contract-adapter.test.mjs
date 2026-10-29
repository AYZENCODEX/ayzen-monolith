import test from "node:test";
import assert from "node:assert/strict";
import { createEventPolicyClient, decideEventAction } from "../src/policy-contract-adapter.mjs";

test("Phase 07 -- event consumer client is tagged and app-scoped", () => {
  const client = createEventPolicyClient({ app: "ryft" });
  const result = client.decide({ capability: "finance.list-accounts", subject: "svc-finance", actorType: "service", scopes: ["finance:read"] });
  assert.equal(result.consumer, "event");
  assert.equal(result.app, "ryft");
  assert.equal(result.decision, "allow");
});

test("Phase 07 -- decideEventAction: conditional for a sensitive publish without step-up", () => {
  const result = decideEventAction({ app: "ryft", capability: "finance.post-transaction", subject: "svc-finance", scopes: ["finance:write"] });
  assert.equal(result.decision, "conditional");
});

test("Phase 07 -- decideEventAction: deny with no subject", () => {
  const result = decideEventAction({ app: "ryft", capability: "finance.post-transaction", scopes: ["finance:write"] });
  assert.equal(result.decision, "deny");
  assert.equal(result.reason, "AUTHENTICATED_SUBJECT_REQUIRED");
});
