import crypto from "node:crypto";

export const EVENT_TYPES = Object.freeze([
  "organization.created",
  "organization.member.added",
  "workspace.created",
  "workspace.member.added",
  "user.created",
  "user.updated",
  "session.created",
  "session.revoked",
  "authentication.failed",
  "finance.transaction.updated",
  "finance.transaction.created",
  "vault.secret.accessed",
  "vault.secret.updated",
  "workflow.completed",
  "workflow.started",
  "workflow.failed",
  "workflow.cancelled",
  "wisp.message.received",
  "wisp.message.sent",
  "mail.delivery.requested",
  "mail.delivery.updated",
  "notification.requested",
  "notification.sent",
  "notification.failed",
  "ai.task.completed",
  "ai.task.failed",
  "intelligence.observation.created",
  "intelligence.signal.created",
  "search.document.indexed",
  "marketplace.listing.created",
  "marketplace.order.created",
  "analytics.event.recorded",
  "identity.telegram.linked",
  "authorization.decision.allowed",
  "authorization.decision.denied",
  "policy.decision.allowed",
  "policy.decision.denied",
  "telegram.update.received",
  "telegram.update.failed",
  "technical_gap.detected",
  "technical_gap.updated",
  "deployment.started",
  "deployment.succeeded",
  "deployment.failed",
  "service.health.changed",
  "event.consumer.lag",
  "workflow.stalled",
  "audit.created",
  "alert.created",
  "incident.created",
  "incident.resolved",
  "user.error",
  "telegram.auth.linked",
  "telegram.auth.unlinked",
  "backup.restore.completed",
]);

const EVENT_TYPE_SET = new Set(EVENT_TYPES);
const EVENT_DEFINITIONS = new Map([
  ["user.created", { owner: "identity", version: 1 }],
  ["user.updated", { owner: "identity", version: 1 }],
  ["session.created", { owner: "identity", version: 1, sensitive: true }],
  ["session.revoked", { owner: "identity", version: 1, sensitive: true }],
  ["authentication.failed", { owner: "identity", version: 1, sensitive: true }],
  ["finance.transaction.created", { owner: "finance", version: 1, sensitive: true }],
  ["finance.transaction.updated", { owner: "finance", version: 1, sensitive: true }],
  ["vault.secret.accessed", { owner: "vault", version: 1, sensitive: true }],
  ["vault.secret.updated", { owner: "vault", version: 1, sensitive: true }],
  ["wisp.message.received", { owner: "mail", version: 1 }],
  ["wisp.message.sent", { owner: "mail", version: 1 }],
  ["mail.delivery.requested", { owner: "mail", version: 1 }],
  ["mail.delivery.updated", { owner: "mail", version: 1 }],
  ["notification.requested", { owner: "notification", version: 1 }],
  ["notification.sent", { owner: "notification", version: 1 }],
  ["notification.failed", { owner: "notification", version: 1 }],
  ["workflow.started", { owner: "workflow", version: 1 }],
  ["workflow.completed", { owner: "workflow", version: 1 }],
  ["workflow.failed", { owner: "workflow", version: 1 }],
  ["workflow.cancelled", { owner: "workflow", version: 1 }],
  ["ai.task.completed", { owner: "ai-agent", version: 1 }],
  ["ai.task.failed", { owner: "ai-agent", version: 1 }],
  ["intelligence.observation.created", { owner: "intelligence", version: 1 }],
  ["intelligence.signal.created", { owner: "intelligence", version: 1 }],
  ["marketplace.listing.created", { owner: "marketplace", version: 1 }],
  ["marketplace.order.created", { owner: "marketplace", version: 1 }],
  ["identity.telegram.linked", { owner: "identity", version: 1, sensitive: true }],
  ["authorization.decision.allowed", { owner: "authorization", version: 1, sensitive: true }],
  ["authorization.decision.denied", { owner: "authorization", version: 1, sensitive: true }],
  ["policy.decision.allowed", { owner: "policy", version: 1, sensitive: true }],
  ["policy.decision.denied", { owner: "policy", version: 1, sensitive: true }],
  ["telegram.update.received", { owner: "telegram-gateway", version: 1 }],
  ["telegram.update.failed", { owner: "telegram-gateway", version: 1 }],
  ["technical_gap.detected", { owner: "intelligence", version: 1 }],
  ["technical_gap.updated", { owner: "intelligence", version: 1 }],
  ["deployment.started", { owner: "platform", version: 1 }],
  ["deployment.succeeded", { owner: "platform", version: 1 }],
  ["deployment.failed", { owner: "platform", version: 1 }],
  ["service.health.changed", { owner: "platform", version: 1 }],
  ["event.consumer.lag", { owner: "event-bus", version: 1 }],
  ["workflow.stalled", { owner: "workflow", version: 1 }],
  ["audit.created", { owner: "audit", version: 1 }],
  ["alert.created", { owner: "alerting", version: 1 }],
  ["incident.created", { owner: "incident", version: 1 }],
  ["incident.resolved", { owner: "incident", version: 1 }],
  ["user.error", { owner: "intelligence", version: 1 }],
  ["telegram.auth.linked", { owner: "identity", version: 1, sensitive: true }],
  ["telegram.auth.unlinked", { owner: "identity", version: 1, sensitive: true }],
  ["backup.restore.completed", { owner: "backup", version: 1, sensitive: true }],
]);

/**
 * Phase H10.2 — `config/eventbus/security.json`'s `sensitiveEventsRequireAudit`
 * needs a source of truth for *which* event types count as sensitive; there
 * wasn't one anywhere in the repo (the closest analog, `@ayzen/capabilities`'
 * `CAPABILITY_REGISTRY`, marks sensitivity per HTTP capability, not per event
 * type). This adds a `sensitive` flag alongside each type's existing `owner`
 * annotation here — the one place event-type metadata already lives — rather
 * than inventing a second registry. Marked `true` for: session lifecycle,
 * failed authentication, financial transactions, vault secret access,
 * identity/Telegram linking, and authorization/policy decisions — the event
 * types whose payloads or mere occurrence are themselves audit-relevant.
 * `audit.created` is deliberately NOT marked sensitive: it already **is**
 * the audit trail, so routing it back through audit would be circular.
 */
export function isSensitiveEventType(type) {
  const eventType = assertRegisteredEventType(type);
  return Boolean(EVENT_DEFINITIONS.get(eventType)?.sensitive);
}

export function assertRegisteredEventType(type) {
  if (typeof type !== "string" || !EVENT_TYPE_SET.has(type)) {
    throw new Error(`Unregistered event type: ${String(type)}`);
  }
  return type;
}

export function registerEventDefinition(type, definition = {}) {
  assertRegisteredEventType(type);
  const current = EVENT_DEFINITIONS.get(type) ?? {};
  const version = definition.version ?? current.version ?? 1;
  if (!Number.isSafeInteger(version) || version < 1) throw new Error("Event version must be a positive integer");
  EVENT_DEFINITIONS.set(type, Object.freeze({
    ...current,
    ...definition,
    version,
    owner: definition.owner ?? current.owner,
  }));
  return EVENT_DEFINITIONS.get(type);
}

export function getEventDefinition(type) {
  assertRegisteredEventType(type);
  return EVENT_DEFINITIONS.get(type) ?? Object.freeze({ version: 1 });
}

export function listEventDefinitions() {
  return [...EVENT_DEFINITIONS.entries()].map(([type, definition]) => ({ type, ...definition }));
}

export function createEventEnvelope({
  type,
  eventType = type,
  version,
  eventVersion,
  eventId,
  id = eventId,
  payload,
  actor,
  organizationId,
  workspaceId,
  aggregate,
  traceId,
  correlationId,
  causationId,
  metadata = {},
}) {
  assertRegisteredEventType(eventType);
  const definition = getEventDefinition(eventType);
  const resolvedVersion = eventVersion ?? version ?? definition.version;
  if (!Number.isSafeInteger(resolvedVersion) || resolvedVersion < 1) throw new Error("Event version must be a positive integer");
  if (payload === undefined) throw new Error("Event payload is required");
  const resolvedId = id ?? crypto.randomUUID();
  const resolvedTraceId = traceId ?? crypto.randomUUID();
  const resolvedCorrelationId = correlationId ?? resolvedTraceId;
  const resolvedMetadata = {
    ...metadata,
    owner: metadata.owner ?? definition.owner,
  };
  return {
    eventId: resolvedId,
    eventType,
    eventVersion: resolvedVersion,
    occurredAt: new Date().toISOString(),
    actor,
    organizationId,
    workspaceId,
    aggregate,
    traceId: resolvedTraceId,
    correlationId: resolvedCorrelationId,
    causationId,
    payload,
    metadata: resolvedMetadata,
    // These aliases keep older monolith publishers and consumers compatible
    // while the shared contract migrates to the service-ready vocabulary.
    id: resolvedId,
    type: eventType,
    version: resolvedVersion,
  };
}

export function assertEventEnvelope(envelope) {
  if (!envelope || typeof envelope !== "object") throw new Error("Event envelope must be an object");
  const eventType = envelope.eventType ?? envelope.type;
  const eventId = envelope.eventId ?? envelope.id;
  const eventVersion = envelope.eventVersion ?? envelope.version;
  assertRegisteredEventType(eventType);
  if (typeof eventId !== "string" || eventId.length < 16) throw new Error("Event ID is invalid");
  if (!Number.isSafeInteger(eventVersion) || eventVersion < 1) throw new Error("Event version is invalid");
  if (typeof envelope.occurredAt !== "string" || Number.isNaN(Date.parse(envelope.occurredAt))) throw new Error("Event timestamp is invalid");
  for (const field of ["traceId", "correlationId"]) {
    if (typeof envelope[field] !== "string" || envelope[field].length < 8) throw new Error(`Event ${field} is required`);
  }
  if (!Object.prototype.hasOwnProperty.call(envelope, "payload")) throw new Error("Event payload is required");
  return envelope;
}

export function validateEventOwnership(envelope, expectedOwner) {
  assertEventEnvelope(envelope);
  const owner = envelope.metadata?.owner;
  if (expectedOwner && owner && owner !== expectedOwner) {
    throw new Error(`Event owner mismatch: expected ${expectedOwner}, received ${owner}`);
  }
  return envelope;
}