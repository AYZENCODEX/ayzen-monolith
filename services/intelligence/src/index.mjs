import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  createAuditLog,
  createConfiguredAuthenticator,
  createServiceServer,
  readJsonBody,
  tenantScopeFromHeaders,
} from "@ayzen/service-runtime";
import { createHttpEnvelopeTransport } from "@ayzen/event-client";
import { createTransactionalEventPublisher } from "@ayzen/outbox";
import { createAlertOrchestrator } from "@ayzen/alerting";

const statePath = process.env.INTELLIGENCE_STATE_PATH ?? path.join(".data", "intelligence-state.json");
const state = loadState();
const observations = state.observations;
const signals = state.signals;
const audit = createAuditLog({ service: "intelligence" });
// Phase H6.1: publish through the transactional outbox so the state
// write above and this event either both happen or neither does,
// instead of a bare HTTP publish that can fall out of sync with state
// on a crash or network blip between the two.
const publish = createTransactionalEventPublisher({ service: "intelligence", transport: createHttpEnvelopeTransport({ service: "intelligence" }) });
const alerting = createAlertOrchestrator({
  filePath: process.env.INTELLIGENCE_ALERTS_PATH ?? path.join(".data", "intelligence-alerts.json"),
  routing: loadRouting(),
});

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return fallback;
  }
}

function loadState() {
  const saved = loadJson(statePath, {});
  return {
    observations: Array.isArray(saved.observations) ? saved.observations : [],
    signals: Array.isArray(saved.signals) ? saved.signals : [],
  };
}

function loadRouting() {
  try { return loadJson("infrastructure/platform/alert-routing.json", {}); }
  catch { return {}; }
}

function persistState() {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const temporary = `${statePath}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 1, observations, signals }, null, 2)}\n`);
  fs.renameSync(temporary, statePath);
}

function paginated(items, url) {
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get("pageSize") ?? 50) || 50));
  const start = (page - 1) * pageSize;
  return { items: items.slice(start, start + pageSize), page, pageSize, total: items.length, hasNext: start + pageSize < items.length };
}

function actorFrom(auth) {
  return auth ? { subject: auth.sub ?? auth.subject, actorType: auth.actorType ?? "user" } : undefined;
}

function safeEvent(event) {
  return {
    eventId: event.eventId ?? event.id,
    eventType: event.eventType ?? event.type,
    occurredAt: event.occurredAt,
    organizationId: event.organizationId,
    workspaceId: event.workspaceId,
    aggregate: event.aggregate,
    metadata: event.metadata,
  };
}

async function handle({ req, url, requestId, auth }) {
  const tenant = tenantScopeFromHeaders(req.headers);
  if (url.pathname === "/api/intelligence/events" && req.method === "POST") {
    const event = await readJsonBody(req);
    if (!event.eventType && !event.type) return { status: 400, body: { error: "Versioned event envelope is required", code: "INVALID_EVENT" } };
    const observation = { id: crypto.randomUUID(), event: safeEvent(event), receivedAt: new Date().toISOString(), ...tenant };
    observations.push(observation);
    const signal = {
      id: crypto.randomUUID(),
      kind: event.eventType === "authentication.failed" ? "security" : "activity",
      confidence: event.eventType === "authentication.failed" ? 0.9 : 0.5,
      observationId: observation.id,
      createdAt: new Date().toISOString(),
      ...tenant,
    };
    signals.push(signal);
    persistState();
    audit.record({ action: "intelligence.observe", actor: actorFrom(auth), tenant, resource: observation.id, requestId, metadata: { eventType: observation.event.eventType } });
    await publish.publish({ eventType: "intelligence.observation.created", payload: { observationId: observation.id, eventType: observation.event.eventType }, actor: actorFrom(auth), ...tenant, aggregate: { type: "intelligence_observation", id: observation.id } });
    if (signal.kind === "security") await publish.publish({ eventType: "intelligence.signal.created", payload: { signalId: signal.id, kind: signal.kind, confidence: signal.confidence }, actor: actorFrom(auth), ...tenant, aggregate: { type: "intelligence_signal", id: signal.id } });
    if (signal.kind === "security") {
      await alerting.create({
        eventType: "security.signal.created",
        service: "intelligence",
        severity: "high",
        environment: process.env.NODE_ENV ?? "development",
        tenant,
        resource: observation.id,
        summary: "Security signal detected by intelligence ingestion",
        evidence: { signalId: signal.id, eventType: observation.event.eventType, requestId },
      });
    }
    return { status: 202, body: { accepted: true, observationId: observation.id, signal } };
  }
  if (url.pathname === "/api/intelligence/signals" && req.method === "GET") {
    return { status: 200, body: paginated(signals.filter((item) => (!tenant.workspaceId || item.workspaceId === tenant.workspaceId) && (!tenant.organizationId || item.organizationId === tenant.organizationId)), url) };
  }
  if (url.pathname === "/api/intelligence/observations" && req.method === "GET") {
    return { status: 200, body: paginated(observations.filter((item) => (!tenant.workspaceId || item.workspaceId === tenant.workspaceId) && (!tenant.organizationId || item.organizationId === tenant.organizationId)), url) };
  }
  if (url.pathname === "/api/intelligence/alerts" && req.method === "GET") return { status: 200, body: paginated(await alerting.list({}), url) };
  if (url.pathname === "/internal/audit" && req.method === "GET") return { status: 200, body: { items: audit.list() } };
  return { status: 404, body: { error: "Route not found", code: "NOT_FOUND" } };
}

createServiceServer({
  service: "intelligence",
  displayName: "Intelligence / ACIE",
  port: Number(process.env.PORT ?? 8109),
  routePrefixes: ["/api/intelligence"],
  handle,
  authenticate: createConfiguredAuthenticator({ service: "intelligence" }),
  domain: "intelligence",
  owner: "ACIE",
  ownedResources: ["acie_observations", "acie_signals", "acie_patterns", "acie_audits"],
  emittedEvents: ["intelligence.observation.created", "intelligence.signal.created"],
  rollbackStrategy: "disable INTELLIGENCE_SERVICE_URL; preserve raw event outbox",
  dependencies: { configuration: true, eventStore: true, eventBus: true },
}).start();