import crypto from "node:crypto";
import {
  AUTHORIZATION_DECISIONS,
  APP_POLICY_PACKS,
  authorizeCapability,
  authorizeServiceCapability,
  evaluatePolicyPack,
  assertTelegramCommandAuthorized,
  getCapabilityPolicy,
} from "@ayzen/authorization";
import { createPolicyDecisionPoint, validatePolicyContext } from "@ayzen/platform-governance";

/**
 * Phase 07 -- "Unified Policy Decision Contract".
 *
 * Prior to this phase, AYZEN had several real, independently-correct
 * decision engines with no one shared vocabulary or entry point:
 *   - @ayzen/authorization: capability-based decisions (allow / deny /
 *     step_up_required), already app-scoped via APP_POLICY_PACKS, already
 *     the thing `packages/service-runtime` and Telegram command dispatch
 *     call directly.
 *   - @ayzen/platform-governance: a small generic {app -> {action -> fn}}
 *     PDP (allow / deny only), used by services/policy.
 *   - services/policy-simulation: a regression-suite runner that already
 *     expects `policyService.decide(input).decision.decision` to be one of
 *     a small closed set of outcomes -- but that set had never included
 *     anything beyond allow/deny, because nothing produced a third value.
 *
 * This file does not replace any of those (Roadmap section 3,
 * "non-duplication rule" -- do not rebuild an existing enforcement engine).
 * It is the one place that:
 *   1. normalizes whichever engine answered into the roadmap's own
 *      three-value contract (allow / deny / conditional) instead of each
 *      engine's own vocabulary leaking to every caller,
 *   2. gives every decision an explicit app-scoped `namespace` and a
 *      `consumer` tag naming which of the roadmap's seven required
 *      consumer kinds asked,
 *   3. gives the seven consumer kinds one client-construction function
 *      (`createConsumerClient`) instead of each hand-rolling its own
 *      import of @ayzen/authorization's individual functions.
 *
 * "conditional" is this contract's name for what @ayzen/authorization
 * calls `step_up_required`: the request is not simply allowed or denied,
 * it is allowed *once* an additional condition (today: a recent
 * strong-assurance re-authentication) is satisfied. The contract exposes
 * this as a generic `conditions` array (not hard-coded to step-up) so a
 * future condition kind (e.g. "requires a second approver") does not need
 * another decision value -- see decision.v1.json's own comment.
 */

export const POLICY_CONTRACT_VERSION = "v1";

// The roadmap's own list: "Create one decision interface consumed by API,
// service, event, workflow, scheduler, Telegram and Admin." Kept as one
// frozen array so every place that needs to validate/enumerate consumer
// kinds (this file, scripts/validate-policy-contract.mjs, the schema) reads
// from the same source instead of re-typing the list and risking drift.
export const CONSUMERS = Object.freeze(["api", "service", "event", "workflow", "scheduler", "telegram", "admin"]);

export const DECISIONS = Object.freeze(["allow", "deny", "conditional"]);

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

export function assertConsumer(consumer) {
  const value = requiredString(consumer, "Policy contract consumer");
  if (!CONSUMERS.includes(value)) {
    const error = new Error(`Unknown policy contract consumer: ${value}`);
    error.code = "UNKNOWN_POLICY_CONSUMER";
    error.consumer = value;
    throw error;
  }
  return value;
}

const AUTHORIZATION_DECISIONS_AND_NOT_GATED = new Set([...AUTHORIZATION_DECISIONS, "not_gated"]);

// Every engine below returns its own shape; this is the one place that
// maps each of them onto the contract's three decisions instead of any
// individual consumer needing to know which underlying engine answered.
function normalize({ app, namespace, consumer, traceId, subject, actorType, action, resource }, raw) {
  const base = {
    subject: subject ?? "anonymous",
    actorType: actorType ?? raw?.actorType ?? "user",
    app,
    namespace: namespace ?? app,
    action: action ?? raw?.action ?? "unknown",
    resource: resource ?? raw?.capability ?? raw?.resource ?? app,
    consumer,
    traceId,
    audit: true,
    evaluatedAt: new Date().toISOString(),
  };
  if (!raw || typeof raw !== "object" || !AUTHORIZATION_DECISIONS_AND_NOT_GATED.has(raw.decision)) {
    // Fail closed: an engine returning something this contract does not
    // recognize is treated as a denial, never silently allowed.
    return Object.freeze({ ...base, decision: "deny", reason: raw?.reason ?? "POLICY_ENGINE_RETURNED_UNRECOGNIZED_DECISION", conditions: [] });
  }
  switch (raw.decision) {
    case "allow":
      return Object.freeze({ ...base, decision: "allow", reason: raw.reason ?? "POLICY_MATCH", scopes: raw.requiredScopes ?? raw.scopes ?? [], conditions: [] });
    case "not_gated":
      // authorizeServiceCapability's "no capability registered for this
      // route" answer. Nothing was declared to decide against, so the
      // contract has no opinion to enforce -- surfaced as allow (matching
      // that function's own existing caller contract in service-runtime)
      // but with a reason that lets a caller tell "explicitly allowed"
      // apart from "nothing to decide" if it cares to.
      return Object.freeze({ ...base, decision: "allow", reason: "NOT_GATED", conditions: [] });
    case "step_up_required":
      return Object.freeze({
        ...base,
        decision: "conditional",
        reason: raw.reason ?? "STEP_UP_REQUIRED",
        conditions: [{
          code: "STEP_UP_REQUIRED",
          description: "Caller must re-authenticate with a stronger assurance factor (OTP/TOTP/passkey/backup-code) within the step-up window before this action can proceed.",
        }],
      });
    case "deny":
    default:
      return Object.freeze({ ...base, decision: "deny", reason: raw.reason ?? "DEFAULT_DENY", requiredScopes: raw.requiredScopes ?? [], conditions: [] });
  }
}

/**
 * The contract's one entry point. `request.consumer` and `request.app` are
 * always required (every decision is app-scoped and attributed to one of
 * the seven consumer kinds); everything else depends on which underlying
 * engine the request targets:
 *   - `request.capability` set                -> @ayzen/authorization's
 *     capability engine (authorizeCapability).
 *   - `request.method` + `request.pathname`    -> the coarse route-gate
 *     engine (authorizeServiceCapability) service-runtime already uses.
 *   - `request.role` set                       -> the app policy-pack
 *     engine (evaluatePolicyPack).
 *   - none of the above                        -> fail-closed deny; the
 *     contract does not guess which engine a caller meant.
 */
export function decide(request = {}) {
  const consumer = assertConsumer(request.consumer);
  const app = requiredString(request.app, "Policy decision app namespace");
  const traceId = request.traceId ?? crypto.randomUUID();
  const meta = { app, namespace: request.namespace ?? app, consumer, traceId, subject: request.subject, actorType: request.actorType, action: request.action, resource: request.resource };

  let raw;
  if (request.capability) {
    raw = authorizeCapability({
      capability: request.capability,
      subject: request.subject,
      actorType: request.actorType,
      organizationId: request.organizationId,
      workspaceId: request.workspaceId,
      scopes: request.scopes,
      roles: request.roles,
      stepUpAt: request.stepUpAt,
      now: request.now,
      stepUpWindowMs: request.stepUpWindowMs,
    });
  } else if (request.method && request.pathname) {
    raw = authorizeServiceCapability({ method: request.method, pathname: request.pathname, auth: request.auth, internalService: request.internalService });
  } else if (request.role) {
    raw = evaluatePolicyPack({ app, role: request.role, action: request.action, requiredRole: request.requiredRole });
  } else {
    raw = { decision: "deny", reason: "POLICY_TARGET_NOT_RESOLVABLE" };
  }
  return normalize(meta, raw);
}

/**
 * Gives packages/authorization's in-process decision interface the
 * explicit "explain" surface that
 * docs/changes/CHANGES_CONTRACT_ZERO_GAP_PHASE6.md's exception entry for
 * `authorization:explain-policy` was tracking against this phase (see this
 * package's own CHANGES doc for why the underlying contract-exceptions.json
 * entry itself is left as-is rather than force-closed -- this function is
 * the code-level answer, not a route).
 */
export function explain(request = {}) {
  const decision = decide(request);
  const parts = [
    `${decision.decision.toUpperCase()} for ${request.action ?? request.capability ?? request.pathname ?? "request"} in app "${decision.app}" (consumer: ${decision.consumer})`,
    `reason: ${decision.reason}`,
  ];
  if (decision.conditions?.length) parts.push(`conditions: ${decision.conditions.map((condition) => condition.code).join(", ")}`);
  return Object.freeze({ ...decision, explanation: parts.join(" -- ") });
}

/**
 * One client per consumer kind, so a package like packages/telegram or
 * services/scheduler gets a pre-scoped `{ decide, explain }` instead of
 * needing to remember to pass `consumer`/`app` on every call, and so a
 * consumer's default `app` can be set once at construction time.
 */
export function createConsumerClient(consumerKind, { app: defaultApp, audit = () => {} } = {}) {
  const consumer = assertConsumer(consumerKind);
  function record(result) {
    audit(result);
    return result;
  }
  return Object.freeze({
    consumer,
    decide(request = {}) {
      return record(decide({ ...request, consumer, app: request.app ?? defaultApp }));
    },
    explain(request = {}) {
      return record(explain({ ...request, consumer, app: request.app ?? defaultApp }));
    },
  });
}

export {
  AUTHORIZATION_DECISIONS,
  APP_POLICY_PACKS,
  assertTelegramCommandAuthorized,
  getCapabilityPolicy,
  createPolicyDecisionPoint,
  validatePolicyContext,
};
