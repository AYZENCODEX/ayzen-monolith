import test from "node:test";
import assert from "node:assert/strict";
import { decide, explain, createConsumerClient, assertConsumer, CONSUMERS, DECISIONS } from "../src/index.mjs";

// Real, existing capability-registry entries (packages/capabilities), not
// invented fixtures -- so this suite exercises the actual composed engine,
// not a stand-in for it.
const NON_SENSITIVE = { capability: "finance.list-accounts", scopes: ["finance:read"] };
const SENSITIVE = { capability: "finance.post-transaction", scopes: ["finance:write"] };

test("Phase 07 -- allow/deny/conditional regression suite", async (t) => {
  await t.test("allow: authenticated subject with the required scope", () => {
    const result = decide({ consumer: "service", app: "ryft", subject: "user-1", ...NON_SENSITIVE });
    assert.equal(result.decision, "allow");
    assert.equal(result.conditions.length, 0);
  });

  await t.test("deny: missing subject", () => {
    const result = decide({ consumer: "service", app: "ryft", ...NON_SENSITIVE });
    assert.equal(result.decision, "deny");
    assert.equal(result.reason, "AUTHENTICATED_SUBJECT_REQUIRED");
  });

  await t.test("deny: authenticated but missing the required scope", () => {
    const result = decide({ consumer: "service", app: "ryft", subject: "user-1", capability: "finance.list-accounts", scopes: [] });
    assert.equal(result.decision, "deny");
    assert.equal(result.reason, "MISSING_SCOPE");
  });

  await t.test("conditional: sensitive capability without a recent step-up", () => {
    const result = decide({ consumer: "service", app: "ryft", subject: "user-1", ...SENSITIVE });
    assert.equal(result.decision, "conditional");
    assert.equal(result.conditions.length, 1);
    assert.equal(result.conditions[0].code, "STEP_UP_REQUIRED");
  });

  await t.test("allow: sensitive capability with a fresh step-up", () => {
    const result = decide({ consumer: "service", app: "ryft", subject: "user-1", ...SENSITIVE, stepUpAt: new Date().toISOString() });
    assert.equal(result.decision, "allow");
  });

  await t.test("determinism: same input decides the same way twice (services/policy-simulation's own requirement)", () => {
    const first = decide({ consumer: "service", app: "ryft", subject: "user-1", ...SENSITIVE });
    const second = decide({ consumer: "service", app: "ryft", subject: "user-1", ...SENSITIVE });
    assert.equal(first.decision, second.decision);
    assert.equal(first.reason, second.reason);
  });
});

test("Phase 07 -- app-scoped namespaces", () => {
  const ryft = decide({ consumer: "service", app: "ryft", subject: "user-1", ...NON_SENSITIVE });
  const sylo = decide({ consumer: "service", app: "sylo", subject: "user-1", ...NON_SENSITIVE });
  assert.equal(ryft.namespace, "ryft");
  assert.equal(sylo.namespace, "sylo");
  // Same capability request, different namespace -- decisions are tagged
  // to the namespace they were asked under, never silently merged.
  assert.notEqual(ryft.namespace, sylo.namespace);
});

test("Phase 07 -- one decision interface, seven consumer kinds", () => {
  assert.deepEqual(CONSUMERS, ["api", "service", "event", "workflow", "scheduler", "telegram", "admin"]);
  for (const kind of CONSUMERS) {
    const client = createConsumerClient(kind, { app: "ryft" });
    const result = client.decide({ subject: "user-1", ...NON_SENSITIVE });
    assert.equal(result.consumer, kind);
    assert.ok(DECISIONS.includes(result.decision));
  }
});

test("Phase 07 -- unknown consumer kind is rejected, not silently accepted", () => {
  assert.throws(() => assertConsumer("mobile-app"), /Unknown policy contract consumer/);
  assert.throws(() => createConsumerClient("mobile-app"));
  assert.throws(() => decide({ consumer: "mobile-app", app: "ryft", subject: "user-1", ...NON_SENSITIVE }));
});

test("Phase 07 -- fail closed on an unresolvable policy target", () => {
  const result = decide({ consumer: "api", app: "ryft", subject: "user-1" });
  assert.equal(result.decision, "deny");
  assert.equal(result.reason, "POLICY_TARGET_NOT_RESOLVABLE");
});

test("Phase 07 -- explain() gives authorization:explain-policy an explicit, human-readable surface", () => {
  const result = explain({ consumer: "admin", app: "admin", subject: "op-1", ...SENSITIVE });
  assert.equal(result.decision, "conditional");
  assert.match(result.explanation, /CONDITIONAL/);
  assert.match(result.explanation, /STEP_UP_REQUIRED/);
});

test("Phase 07 -- an audit callback observes every decision made through a consumer client", () => {
  const audited = [];
  const client = createConsumerClient("telegram", { app: "ryft", audit: (decision) => audited.push(decision) });
  client.decide({ subject: "user-1", ...NON_SENSITIVE });
  client.explain({ subject: "user-1", ...SENSITIVE });
  assert.equal(audited.length, 2);
  assert.equal(audited[0].decision, "allow");
  assert.equal(audited[1].decision, "conditional");
});
