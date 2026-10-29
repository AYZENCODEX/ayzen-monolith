/**
 * lib/policy/events/decision-event-observer.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Enforcement Roadmap — Track H, Phase H3: tie policy decisions into
 * the EventBus.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * `policy.decision.allowed` / `policy.decision.denied` were DECLARED
 * everywhere — `packages/domain-boundaries` lists them as the policy domain's
 * `emittedEvents`, `lib/event-bus/event-registry.ts` registers them,
 * `infra/event-catalog/catalog.json` catalogs them — and CONSUMED:
 * `lib/acie/index.ts` (`acie-collector:*`) and
 * `lib/mega-engine/audit-integration.ts` (`mega-engine-audit`, denied only)
 * both `subscribe()` to them. But nothing in the codebase ever PUBLISHED
 * either type. Both subscribers were dead code: the "auditable, replayable"
 * decision stream the roadmap describes existed only as a promise, while the
 * real decision record lived solely in `authorization_audit_log` (a local
 * table, not a bus event other services can subscribe to or replay).
 *
 * This file is the missing producer half: a `PolicyDecisionObserver` — the
 * same `onDecision` seam `createLoggingObserver()` (Phase 1C) and
 * `createAuthorizationAuditObserver()` (Phase 17) already use — that turns a
 * finalized decision into a bus event and hands it to a caller-supplied
 * publisher.
 *
 * ── Deliberately DB-free / bus-free ─────────────────────────────────────────
 * `lib/policy/*` stays decoupled from app singletons (no `@workspace/db`, no
 * Express, no event-bus import — see `decision-observer.ts`'s header for the
 * same rule). This file therefore takes a `PolicyDecisionEventPublisher`
 * function instead of importing `publishEvent`; the real, DB-backed adapter
 * lives one level up in `lib/policy-decision-events.ts`, mirroring how
 * `audit-observer.ts` takes an `AuthorizationAuditWriter` and
 * `drizzle-audit-writer.ts` is the DB-backed half.
 *
 * ── Effect -> event type ────────────────────────────────────────────────────
 * Only two event types exist. `ALLOW` -> `policy.decision.allowed`. Every
 * other effect (`DENY`, `STEP_UP`, `APPROVAL_REQUIRED`) means "this request
 * was NOT allowed to proceed as-is" -> `policy.decision.denied`, with the
 * exact effect preserved in `payload.effect` so a consumer that cares about
 * the difference (a step-up is not a hard deny) can still tell them apart.
 * This matches `createLoggingObserver()`'s own grouping (ALLOW = info,
 * everything else = warn).
 *
 * ── Payload = the audit row's fields, nothing more ──────────────────────────
 * The payload is built by `toAuditEntry()` (the ONE place that decides what
 * is safe to persist about a decision) and then reshaped, so this stream can
 * never carry more than `authorization_audit_log` already does: no
 * `context.ip`, `sessionId`, `context.extra`, subject `scopes`, or resource
 * attributes beyond `type`+`id`. `decisionId` is intentionally NOT copied —
 * `toAuditEntry()` mints a fresh random one on every call, so the event's
 * would never match the audit row's. Join on `requestId` instead (one
 * request = one decision = one audit row = one event).
 *
 * ── Never affects authorization ─────────────────────────────────────────────
 * Same contract as every other observer: a publisher that throws, or returns
 * a rejected promise, is swallowed here (and reported to the optional
 * `onError`). A broken event bus must never become a way for authorization
 * to fail or slow down — `PolicyEngine.notifyObserver()` already never
 * awaits the returned promise.
 *
 * ── Volume / kill switch ────────────────────────────────────────────────────
 * `mode` (or env `POLICY_DECISION_EVENTS`) is `all` (default — the roadmap's
 * "every decision" deliverable), `denied` (publish only non-ALLOW effects;
 * the cheap option, since ALLOW is the overwhelming majority of traffic), or
 * `off`. An unrecognised value falls back to `all`: a typo should never
 * silently disable an audit stream.
 */

import type { AuthorizationDecision, AuthorizationRequest, DecisionEffect } from "../types";
import type { PolicyDecisionObserver } from "../policy-engine";
import { toAuditEntry } from "../audit/to-audit-entry";

export const POLICY_DECISION_ALLOWED_EVENT = "policy.decision.allowed" as const;
export const POLICY_DECISION_DENIED_EVENT = "policy.decision.denied" as const;
export type PolicyDecisionEventType =
  | typeof POLICY_DECISION_ALLOWED_EVENT
  | typeof POLICY_DECISION_DENIED_EVENT;

/** The event payload. Flat and JSON-safe (no `Date`, no `undefined`-only
 *  required fields) so it survives the outbox's JSON column unchanged. */
export interface PolicyDecisionEventPayload {
  /** Correlation id of the authorization request — the join key to `authorization_audit_log.request_id`. */
  requestId: string;
  effect: DecisionEffect;
  reasonCode: string;
  policyId?: string;
  policyVersion?: number;

  subjectUserId?: number;
  subjectRole?: string;
  subjectAuthType?: string;
  subjectOrganizationId?: number | null;

  product?: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;

  risk?: "low" | "medium" | "high";
  requiredAssurance?: string;

  /** ISO-8601 — `decision.evaluatedAt`, when the PDP produced the decision. */
  evaluatedAt: string;
  latencyMs?: number;
}

/** What the observer hands to a publisher — the bus-agnostic shape of one event. */
export interface PolicyDecisionEvent {
  type: PolicyDecisionEventType;
  payload: PolicyDecisionEventPayload;
  actor?: { userId?: number; organizationId?: number; source: string };
  aggregate: { type: "policy_decision"; id: string };
}

export type PolicyDecisionEventPublisher = (event: PolicyDecisionEvent) => unknown | Promise<unknown>;

export type PolicyDecisionEventMode = "all" | "denied" | "off";

/** Parses `POLICY_DECISION_EVENTS`. Unset/empty/unknown -> `"all"` (see file header: fail toward auditability). */
export function parsePolicyDecisionEventMode(raw: string | undefined | null): PolicyDecisionEventMode {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "off" || value === "false" || value === "0" || value === "none") return "off";
  if (value === "denied" || value === "deny") return "denied";
  return "all";
}

export function policyDecisionEventTypeFor(effect: DecisionEffect): PolicyDecisionEventType {
  return effect === "ALLOW" ? POLICY_DECISION_ALLOWED_EVENT : POLICY_DECISION_DENIED_EVENT;
}

/** Pure: one finalized decision (+ its request, when one could be built) -> one event. */
export function toPolicyDecisionEvent(
  decision: AuthorizationDecision,
  request: AuthorizationRequest | undefined,
): PolicyDecisionEvent {
  const entry = toAuditEntry(decision, request);
  const payload: PolicyDecisionEventPayload = {
    requestId: entry.requestId,
    effect: entry.decision,
    reasonCode: entry.reasonCode,
    policyId: entry.policyId,
    policyVersion: entry.policyVersion,
    subjectUserId: entry.subjectUserId,
    subjectRole: entry.subjectRole,
    subjectAuthType: entry.subjectAuthType,
    subjectOrganizationId: entry.subjectOrganizationId,
    product: entry.product,
    action: entry.action,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId,
    risk: entry.risk,
    requiredAssurance: entry.requiredAssurance,
    evaluatedAt: entry.timestamp.toISOString(),
    latencyMs: entry.latencyMs,
  };
  const hasActor = entry.subjectUserId !== undefined || typeof entry.subjectOrganizationId === "number";
  return {
    type: policyDecisionEventTypeFor(entry.decision),
    payload,
    actor: hasActor
      ? {
          userId: entry.subjectUserId,
          organizationId: typeof entry.subjectOrganizationId === "number" ? entry.subjectOrganizationId : undefined,
          source: "policy-engine",
        }
      : undefined,
    aggregate: { type: "policy_decision", id: entry.requestId },
  };
}

export interface PolicyDecisionEventObserverOptions {
  /** A fixed mode, or a getter re-read on every decision (so the env kill switch is honoured live). Defaults to `POLICY_DECISION_EVENTS`. */
  mode?: PolicyDecisionEventMode | (() => PolicyDecisionEventMode);
  /** Called (never throws into the engine) when building or publishing an event failed. */
  onError?: (error: unknown, decision: AuthorizationDecision) => void;
}

export function createPolicyDecisionEventObserver(
  publish: PolicyDecisionEventPublisher,
  options: PolicyDecisionEventObserverOptions = {},
): PolicyDecisionObserver {
  const resolveMode = (): PolicyDecisionEventMode => {
    const configured = options.mode;
    if (typeof configured === "function") return configured();
    if (configured) return configured;
    return parsePolicyDecisionEventMode(process.env.POLICY_DECISION_EVENTS);
  };
  const report = (error: unknown, decision: AuthorizationDecision): void => {
    try {
      options.onError?.(error, decision);
    } catch {
      // Error reporting must never itself throw into the engine.
    }
  };

  return (decision: AuthorizationDecision, request: AuthorizationRequest | undefined): void | Promise<void> => {
    try {
      const mode = resolveMode();
      if (mode === "off") return undefined;
      if (mode === "denied" && decision.effect === "ALLOW") return undefined;

      const result = publish(toPolicyDecisionEvent(decision, request));
      if (result && typeof (result as Promise<unknown>).then === "function") {
        return (result as Promise<unknown>).then(
          () => undefined,
          (error) => report(error, decision),
        );
      }
      return undefined;
    } catch (error) {
      report(error, decision);
      return undefined;
    }
  };
}
