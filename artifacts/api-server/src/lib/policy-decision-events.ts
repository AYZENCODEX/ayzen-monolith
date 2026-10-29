/**
 * lib/policy-decision-events.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Enforcement Roadmap — Track H, Phase H3: the DB-backed half of
 * "policy decisions are durable events on the EventBus".
 *
 * `lib/policy/events/decision-event-observer.ts` (DB-free) turns a finalized
 * `AuthorizationDecision` into a bus-agnostic `PolicyDecisionEvent`; this file
 * (app-level, allowed to touch `@workspace/db` through the event bus) is what
 * actually writes it to the transactional outbox (`publishEventStandalone`),
 * from where `lib/event-bus/dispatcher.ts` delivers it to every subscriber —
 * today `acie-collector:policy.decision.*` (lib/acie) and
 * `mega-engine-audit` for denials (lib/mega-engine/audit-integration.ts),
 * both of which had been subscribed to events nothing ever published.
 *
 * It exports ONE thing callers care about: `policyDecisionEventObserver`, a
 * ready-to-compose `PolicyDecisionObserver`, wired into
 * `pepDecisionObserver` (middlewares/auth.ts) next to the metrics and audit
 * observers. Coverage is therefore exactly the audit trail's coverage: every
 * route that passes `onDecision: pepDecisionObserver` emits an event.
 *
 * ── Schemas ─────────────────────────────────────────────────────────────────
 * The default registry entries for these two types (event-registry.ts) have
 * no schema — "each type's actual shape belongs to the domain module that
 * owns it" (that file's header). This is that module: it re-registers both
 * types (same owner/version, so nothing else changes) with a real zod schema,
 * including a per-type check that the `effect` matches the type
 * (`allowed` <-> ALLOW; `denied` <-> DENY/STEP_UP/APPROVAL_REQUIRED). A
 * mismatch is rejected at publish time — and, per the observer's contract,
 * swallowed, never surfaced to the request being authorized.
 *
 * ── Failure handling ────────────────────────────────────────────────────────
 * Publishing is best-effort and off the request path (the engine never awaits
 * observers). If the outbox insert fails (DB down, schema mismatch), the
 * failure is logged — throttled to once per minute with a running count, so a
 * database outage doesn't turn every authorized request into a log line — and
 * the decision itself is unaffected. `authorization_audit_log` remains the
 * durable record of last resort; the event stream is the subscribable copy.
 *
 * ── Kill switch ─────────────────────────────────────────────────────────────
 * `POLICY_DECISION_EVENTS=all|denied|off` (default `all`). `denied` skips the
 * ALLOW events (the bulk of traffic) and keeps only non-ALLOW effects.
 */
import { z } from "zod/v4";
import { logger } from "./logger";
import { registerEvent } from "./event-bus/event-registry";
import { publishEventStandalone } from "./event-bus/publisher";
import {
  POLICY_DECISION_ALLOWED_EVENT,
  POLICY_DECISION_DENIED_EVENT,
  createPolicyDecisionEventObserver,
  type PolicyDecisionEvent,
  type PolicyDecisionEventPayload,
} from "./policy/events";

const decisionPayloadBase = {
  requestId: z.string().min(1),
  reasonCode: z.string().min(1),
  policyId: z.string().optional(),
  policyVersion: z.number().optional(),
  subjectUserId: z.number().optional(),
  subjectRole: z.string().optional(),
  subjectAuthType: z.string().optional(),
  subjectOrganizationId: z.number().nullable().optional(),
  product: z.string().optional(),
  action: z.string().optional(),
  resourceType: z.string().optional(),
  resourceId: z.string().optional(),
  risk: z.enum(["low", "medium", "high"]).optional(),
  requiredAssurance: z.string().optional(),
  evaluatedAt: z.string().min(1),
  latencyMs: z.number().optional(),
};

/** `policy.decision.allowed` — effect is always ALLOW. */
export const policyDecisionAllowedSchema = z.object({
  ...decisionPayloadBase,
  effect: z.literal("ALLOW"),
});

/** `policy.decision.denied` — any non-ALLOW effect (a step-up is not a hard deny; the effect says which). */
export const policyDecisionDeniedSchema = z.object({
  ...decisionPayloadBase,
  effect: z.enum(["DENY", "STEP_UP", "APPROVAL_REQUIRED"]),
});

/** Idempotent (registerEvent overwrites by type) — safe under hot reload. */
export function registerPolicyDecisionEvents(): void {
  registerEvent<PolicyDecisionEventPayload>({
    type: POLICY_DECISION_ALLOWED_EVENT,
    version: 1,
    owner: "policy",
    description: "A policy decision (PDP) allowed the request. Metadata only; join to authorization_audit_log on requestId.",
    schema: policyDecisionAllowedSchema as unknown as z.ZodType<PolicyDecisionEventPayload>,
  });
  registerEvent<PolicyDecisionEventPayload>({
    type: POLICY_DECISION_DENIED_EVENT,
    version: 1,
    owner: "policy",
    description: "A policy decision (PDP) did not allow the request as-is (DENY, STEP_UP or APPROVAL_REQUIRED — see payload.effect).",
    schema: policyDecisionDeniedSchema as unknown as z.ZodType<PolicyDecisionEventPayload>,
  });
}

registerPolicyDecisionEvents();

/** Writes one decision event to the outbox. Rejects on failure — callers (the observer) swallow it. */
export async function publishPolicyDecisionEvent(event: PolicyDecisionEvent): Promise<void> {
  await publishEventStandalone<PolicyDecisionEventPayload>({
    type: event.type,
    payload: event.payload,
    actor: event.actor,
    aggregate: event.aggregate,
  });
}

// ── Throttled failure reporting ────────────────────────────────────────────
const FAILURE_LOG_INTERVAL_MS = 60_000;
let lastFailureLogAt = 0;
let failuresSinceLastLog = 0;
let totalFailures = 0;

/** Test/diagnostic hook: how many publishes have failed since process start. */
export function getPolicyDecisionEventFailureCount(): number {
  return totalFailures;
}

function reportPublishFailure(error: unknown): void {
  totalFailures += 1;
  failuresSinceLastLog += 1;
  const now = Date.now();
  if (now - lastFailureLogAt < FAILURE_LOG_INTERVAL_MS) return;
  lastFailureLogAt = now;
  logger.warn(
    { err: error, failuresSinceLastLog, totalFailures },
    "policy.decision.event_publish_failed (decision unaffected; authorization_audit_log still holds the record)",
  );
  failuresSinceLastLog = 0;
}

/** Ready-to-compose observer — see `pepDecisionObserver` (middlewares/auth.ts). */
export const policyDecisionEventObserver = createPolicyDecisionEventObserver(publishPolicyDecisionEvent, {
  onError: reportPublishFailure,
});
