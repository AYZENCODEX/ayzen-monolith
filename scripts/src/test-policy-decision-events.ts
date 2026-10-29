/**
 * scripts/src/test-policy-decision-events.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Enforcement Roadmap — Track H, Phase H3: policy decisions as
 * EventBus events.
 *
 * DB-free, runnable anywhere (`npx tsx scripts/src/test-policy-decision-events.ts`);
 * picked up by `check:verification`'s `test-policy-*` glob. Covers the pure
 * producer half (`lib/policy/events/decision-event-observer.ts`), driven
 * through the REAL `PolicyEngine` so the `onDecision` seam itself is
 * exercised, plus static wiring checks for the parts that need a database to
 * import (the outbox adapter, `pepDecisionObserver`, the two subscribers).
 *
 * NOT covered here (needs a live DB): the outbox insert
 * (`lib/policy-decision-events.ts` -> `publishEventStandalone`) and the
 * dispatcher's delivery to `acie-collector` / `mega-engine-audit`. The roadmap
 * gate ("deny a request, confirm `policy.decision.denied` lands in a
 * consumer") is therefore verified here as: real engine -> observer -> event
 * with the right type/payload, PLUS static checks that the publisher is
 * composed into `pepDecisionObserver` and that subscribers exist for both
 * types. A DB-backed publish/consume round trip remains a manual step.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  PolicyEngine,
  allow,
  deny,
  stepUp,
  approvalRequired,
  buildAuthorizationRequest,
  createPolicyDecisionEventObserver,
  parsePolicyDecisionEventMode,
  toPolicyDecisionEvent,
  type PolicyDecisionEvent,
  type Subject,
} from "../../artifacts/api-server/src/lib/policy";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, "../../artifacts/api-server/src");
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), "utf8");

const alice: Subject = { userId: 7, role: "user", authType: "session", organizationId: 3, scopes: ["SECRET_SCOPE_VALUE"] };
const input = (overrides: Record<string, unknown> = {}) => ({
  subject: alice as Subject | null,
  action: "sylo.vault.read",
  resource: { type: "sylo.vault_item", id: 42, ownerId: 7 },
  context: { ip: "203.0.113.9", sessionId: "SECRET_SESSION_ID", extra: { note: "SECRET_EXTRA" } },
  ...overrides,
});

/** Drives a real engine whose only observer is the H3 observer; resolves the events published. */
async function run(
  ruleResult: "allow" | "deny" | "stepUp" | "approval",
  observerOptions: Parameters<typeof createPolicyDecisionEventObserver>[1] = { mode: "all" },
  inputOverrides: Record<string, unknown> = {},
): Promise<PolicyDecisionEvent[]> {
  const events: PolicyDecisionEvent[] = [];
  const engine = new PolicyEngine({
    onDecision: createPolicyDecisionEventObserver((e) => { events.push(e); }, observerOptions),
  });
  engine.registerRule("r", (request) => {
    switch (ruleResult) {
      case "allow": return allow(request, "EXPLICIT_ALLOW", { policyId: "p1", policyVersion: 4 });
      case "deny": return deny(request, "EXPLICIT_DENY");
      case "stepUp": return stepUp(request, { requiredAssurance: "totp" });
      case "approval": return approvalRequired(request);
    }
  });
  await engine.evaluate(input(inputOverrides) as never);
  return events;
}

test("ALLOW -> exactly one policy.decision.allowed event with the decision's fields", async () => {
  const events = await run("allow");
  assert.equal(events.length, 1);
  const [e] = events;
  assert.equal(e.type, "policy.decision.allowed");
  assert.equal(e.payload.effect, "ALLOW");
  assert.equal(e.payload.reasonCode, "EXPLICIT_ALLOW");
  assert.equal(e.payload.policyId, "p1");
  assert.equal(e.payload.policyVersion, 4);
  assert.equal(e.payload.action, "sylo.vault.read");
  assert.equal(e.payload.product, "sylo");
  assert.equal(e.payload.resourceType, "sylo.vault_item");
  assert.equal(e.payload.resourceId, "42");
  assert.equal(e.payload.subjectUserId, 7);
  assert.equal(typeof e.payload.evaluatedAt, "string");
  assert.ok(!Number.isNaN(Date.parse(e.payload.evaluatedAt)));
  assert.deepEqual(e.aggregate, { type: "policy_decision", id: e.payload.requestId });
  assert.deepEqual(e.actor, { userId: 7, organizationId: 3, source: "policy-engine" });
});

test("DENY -> policy.decision.denied (the roadmap gate: deny a request, get the denied event)", async () => {
  const [e] = await run("deny");
  assert.equal(e.type, "policy.decision.denied");
  assert.equal(e.payload.effect, "DENY");
  assert.equal(e.payload.reasonCode, "EXPLICIT_DENY");
});

test("default-deny (no matching policy) is also published as denied", async () => {
  const events: PolicyDecisionEvent[] = [];
  const engine = new PolicyEngine({ onDecision: createPolicyDecisionEventObserver((e) => { events.push(e); }, { mode: "all" }) });
  const decision = await engine.evaluate(input() as never);
  assert.equal(decision.effect, "DENY");
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "policy.decision.denied");
  assert.equal(events[0].payload.reasonCode, "NO_MATCHING_POLICY");
});

test("STEP_UP and APPROVAL_REQUIRED map to denied but keep their exact effect", async () => {
  const [s] = await run("stepUp");
  assert.equal(s.type, "policy.decision.denied");
  assert.equal(s.payload.effect, "STEP_UP");
  assert.equal(s.payload.requiredAssurance, "totp");
  const [a] = await run("approval");
  assert.equal(a.type, "policy.decision.denied");
  assert.equal(a.payload.effect, "APPROVAL_REQUIRED");
});

test("a malformed request (no request object could be built) still yields a denied event", async () => {
  const events = await run("allow", { mode: "all" }, { action: "" });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "policy.decision.denied");
  assert.equal(events[0].payload.reasonCode, "INVALID_AUTHORIZATION_CONTEXT");
  assert.equal(events[0].payload.action, undefined);
  assert.equal(events[0].actor, undefined);
});

test("unauthenticated (subject null) has no actor and no subject fields", async () => {
  const events = await run("deny", { mode: "all" }, { subject: null });
  assert.equal(events.length, 1);
  assert.equal(events[0].actor, undefined);
  assert.equal(events[0].payload.subjectUserId, undefined);
});

test("payload carries no ip, sessionId, context.extra, scopes, or decisionId", async () => {
  const [e] = await run("allow");
  const wire = JSON.stringify(e);
  for (const secret of ["203.0.113.9", "SECRET_SESSION_ID", "SECRET_EXTRA", "SECRET_SCOPE_VALUE"]) {
    assert.ok(!wire.includes(secret), `event leaked ${secret}`);
  }
  assert.ok(!("decisionId" in e.payload), "decisionId would never match the audit row's — join on requestId");
});

test("requestId in the event equals the decision's requestId (join key to authorization_audit_log)", async () => {
  const request = buildAuthorizationRequest(input() as never);
  const decision = allow(request, "EXPLICIT_ALLOW");
  assert.equal(toPolicyDecisionEvent(decision, request).payload.requestId, decision.requestId);
});

test("a publisher that throws synchronously never affects the decision and is reported", async () => {
  const errors: unknown[] = [];
  const engine = new PolicyEngine({
    onDecision: createPolicyDecisionEventObserver(() => { throw new Error("bus down"); }, { mode: "all", onError: (e) => errors.push(e) }),
  });
  engine.registerRule("r", (request) => allow(request, "EXPLICIT_ALLOW"));
  const decision = await engine.evaluate(input() as never);
  assert.equal(decision.effect, "ALLOW");
  assert.equal(errors.length, 1);
});

test("a publisher whose promise rejects is swallowed (no unhandled rejection) and reported", async () => {
  const errors: unknown[] = [];
  const observer = createPolicyDecisionEventObserver(() => Promise.reject(new Error("outbox insert failed")), {
    mode: "all",
    onError: (e) => errors.push(e),
  });
  const request = buildAuthorizationRequest(input() as never);
  await assert.doesNotReject(async () => { await observer(allow(request, "EXPLICIT_ALLOW"), request); });
  assert.equal(errors.length, 1);
});

test("an onError that itself throws is contained", async () => {
  const observer = createPolicyDecisionEventObserver(() => { throw new Error("x"); }, { mode: "all", onError: () => { throw new Error("y"); } });
  const request = buildAuthorizationRequest(input() as never);
  assert.doesNotThrow(() => observer(allow(request, "EXPLICIT_ALLOW"), request));
});

test("mode=off publishes nothing; mode=denied skips ALLOW but keeps every non-ALLOW effect", async () => {
  assert.equal((await run("allow", { mode: "off" })).length, 0);
  assert.equal((await run("deny", { mode: "off" })).length, 0);
  assert.equal((await run("allow", { mode: "denied" })).length, 0);
  assert.equal((await run("deny", { mode: "denied" })).length, 1);
  assert.equal((await run("stepUp", { mode: "denied" })).length, 1);
  assert.equal((await run("approval", { mode: "denied" })).length, 1);
});

test("mode getter is re-read on every decision (live kill switch)", async () => {
  let mode: "all" | "off" = "all";
  const events: PolicyDecisionEvent[] = [];
  const observer = createPolicyDecisionEventObserver((e) => { events.push(e); }, { mode: () => mode });
  const request = buildAuthorizationRequest(input() as never);
  observer(allow(request, "EXPLICIT_ALLOW"), request);
  mode = "off";
  observer(allow(request, "EXPLICIT_ALLOW"), request);
  assert.equal(events.length, 1);
});

test("parsePolicyDecisionEventMode: unset/typos fall back to 'all' (never silently disable the stream)", () => {
  assert.equal(parsePolicyDecisionEventMode(undefined), "all");
  assert.equal(parsePolicyDecisionEventMode(""), "all");
  assert.equal(parsePolicyDecisionEventMode("of"), "all");
  assert.equal(parsePolicyDecisionEventMode("ALL"), "all");
  assert.equal(parsePolicyDecisionEventMode("denied"), "denied");
  assert.equal(parsePolicyDecisionEventMode(" Denied "), "denied");
  assert.equal(parsePolicyDecisionEventMode("off"), "off");
  assert.equal(parsePolicyDecisionEventMode("false"), "off");
});

// ── Static wiring (these files need a DB to import, so they are read as text) ──

test("pepDecisionObserver composes the policy-decision event observer (H3 wiring)", () => {
  const auth = read("middlewares/auth.ts");
  const m = /export const pepDecisionObserver = composeObservers\(([\s\S]*?)\);/.exec(auth);
  assert.ok(m, "pepDecisionObserver's composeObservers(...) call not found — update this test if it was restructured");
  assert.ok(m![1].includes("policyDecisionEventObserver"), "pepDecisionObserver no longer includes policyDecisionEventObserver — policy decisions stop being published");
  assert.ok(/from "\.\.\/lib\/policy-decision-events"/.test(auth));
});

test("the DB-backed adapter registers both event types with a schema and publishes through the outbox", () => {
  const adapter = read("lib/policy-decision-events.ts");
  assert.ok(adapter.includes("POLICY_DECISION_ALLOWED_EVENT") && adapter.includes("POLICY_DECISION_DENIED_EVENT"));
  assert.equal((adapter.match(/registerEvent</g) ?? []).length, 2);
  assert.ok((adapter.match(/schema:/g) ?? []).length >= 2, "both event types must carry a schema");
  assert.ok(adapter.includes("publishEventStandalone"));
  assert.ok(/export const policyDecisionEventObserver = createPolicyDecisionEventObserver\(/.test(adapter));
});

test("each policy.decision.* type has at least one subscriber in the code (consumers are no longer dead)", () => {
  const acie = read("lib/acie/index.ts");
  assert.ok(acie.includes('"policy.decision.allowed"') && acie.includes('"policy.decision.denied"'));
  const audit = read("lib/mega-engine/audit-integration.ts");
  assert.ok(audit.includes('"policy.decision.denied"'));
});

test("event type strings agree across the pure module, the default registry and the domain-boundary contract", () => {
  const registry = read("lib/event-bus/event-registry.ts");
  assert.ok(registry.includes('"policy.decision.allowed"') && registry.includes('"policy.decision.denied"'));
  const contract = fs.readFileSync(path.resolve(SRC, "../../../packages/domain-boundaries/src/index.mjs"), "utf8");
  assert.ok(contract.includes('"policy.decision.allowed"') && contract.includes('"policy.decision.denied"'));
});
