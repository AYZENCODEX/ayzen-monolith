import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  createConfiguredAuthenticator,
  createServiceServer,
  readJsonBody,
} from "@ayzen/service-runtime";
import { createAuditStore } from "@ayzen/audit";
import { createAdminDataAccess, listAdminResources, authorizeAdminDataAction } from "@ayzen/admin-data";
import { authorizeAdminAction, createBreakGlassManager } from "@ayzen/admin-policy";
import { createServiceRequestHeaders } from "@ayzen/auth-client";
import { createHttpEnvelopeTransport, createRedisEventBus } from "@ayzen/event-client";
import { createTransactionalEventPublisher } from "@ayzen/outbox";
import { createDeadLetterOperations } from "./dead-letters.mjs";
import {
  getXukaImplementationSnapshot,
  getXukaPhaseStatus,
  listXukaPhases,
  createApiContract,
  createOperationPreview,
  createAccessBoundary,
  createCanonicalContext,
  createDependencyGraph,
  createConfigurationEngine,
  createEventSchemaRegistry,
  getXukaPhase,
  createFeatureFlagEngine,
  createStateEngine,
  createQuotaEngine,
  createDataDiscoveryEngine,
  createDataLifecycleEngine,
  createArtifactLifecycleEngine,
  createCredentialLifecycleEngine,
  createVersionCompatibilityEngine,
  createKnowledgeGraphEngine,
  createProductionGapClosureEngine,
  createFrontendVerificationPlan,
} from "@ayzen/xuka";

const statePath = process.env.ADMIN_STATE_PATH ?? path.join(".data", "admin-state.json");
const auditPath = process.env.ADMIN_AUDIT_PATH ?? path.join(".data", "admin-audit.json");
const audit = createAuditStore({ filePath: auditPath });
// Phase H6.1: publish through the transactional outbox so the state
// write above and this event either both happen or neither does,
// instead of a bare HTTP publish that can fall out of sync with state
// on a crash or network blip between the two.
const publish = createTransactionalEventPublisher({ service: "admin", transport: createHttpEnvelopeTransport({ service: "admin" }) });
// Phase H11.1: `replayDeadLetter`/`deadLetters` live on `createRedisEventBus`
// (the consumer-side bus), not the HTTP publisher above, so this is a
// second, separate accessor — built lazily the same way api-gateway's own
// `getEventBus` is, so admin can boot without Redis reachable unless an
// operator actually opens the dead-letter routes.
let eventBus;
function getEventBus() {
  const redisUrl = process.env.EVENT_BUS_REDIS_URL ?? process.env.EVENT_BUS_URL;
  if (!redisUrl) return undefined;
  if (!eventBus) eventBus = createRedisEventBus({ url: redisUrl, consumer: process.env.EVENT_BUS_CONSUMER ?? `admin-${process.pid}` });
  return eventBus;
}
const deadLetters = createDeadLetterOperations({ getBus: getEventBus });
const breakGlass = createBreakGlassManager();
const providerUrl = (process.env.ADMIN_DATA_PROVIDER_URL ?? "").replace(/\/+$/, "");
const state = loadState();

function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return {
      alerts: Array.isArray(parsed.alerts) ? parsed.alerts : [],
      gaps: Array.isArray(parsed.gaps) ? parsed.gaps : [],
      deployments: Array.isArray(parsed.deployments) ? parsed.deployments : [],
      adminOwner: parsed.adminOwner ?? null,
    };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return { alerts: [], gaps: [], deployments: [], adminOwner: null };
  }
}

function persistState() {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const temporary = `${statePath}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state));
  fs.renameSync(temporary, statePath);
}

function actorFrom(auth) {
  return auth ? { subject: auth.sub ?? auth.subject, actorType: auth.actorType ?? "user" } : undefined;
}

function hasScope(auth, scope) {
  return Boolean(auth?.scopes?.includes(scope) || auth?.scope?.split?.(" ")?.includes(scope));
}

function deny(scope) {
  return { status: 403, body: { error: "Admin scope is required", code: "ADMIN_SCOPE_REQUIRED", scope } };
}

function record(action, auth, requestId, metadata = {}, tenant) {
  return audit.append({ service: "admin", action, actor: actorFrom(auth), requestId, tenant, metadata });
}

function providerError() {
  const error = new Error("Admin data provider is not configured");
  error.code = "ADMIN_DATA_PROVIDER_NOT_CONFIGURED";
  return error;
}

function createProvider(requestId, auth) {
  return {
    async request(operation, input) {
      if (!providerUrl) throw providerError();
      const body = JSON.stringify({ operation, ...input });
      const secret = process.env.AYZEN_SERVICE_AUTH_SECRET ?? process.env.SERVICE_TO_SERVICE_SECRET;
      const headers = {
        "content-type": "application/json",
        "x-ayzen-admin-operation": operation,
        ...(secret ? createServiceRequestHeaders({ service: "admin", requestId, body: Buffer.from(body), secret }) : {}),
      };
      const response = await fetch(`${providerUrl}/admin-data`, { method: "POST", headers, body });
      const payload = await response.json().catch(() => ({ error: "Admin data provider returned invalid JSON" }));
      if (!response.ok) {
        const error = new Error(payload.error ?? `Admin data provider returned ${response.status}`);
        error.code = payload.code ?? "ADMIN_DATA_PROVIDER_FAILED";
        throw error;
      }
      return payload;
    },
    query(input) {
      return this.request("query", { ...input, actor: actorFrom(auth) });
    },
    mutate(input) {
      return this.request("mutate", { ...input, actor: actorFrom(auth) });
    },
  };
}

function dataAccessFor(requestId, auth) {
  return createAdminDataAccess({ provider: createProvider(requestId, auth) });
}

function elevatedGrant(body, auth) {
  if (!body?.breakGlassId) return { valid: false };
  return breakGlass.consume({ id: body.breakGlassId, actor: actorFrom(auth), scope: "admin:break-glass" });
}

async function handle({ req, url, requestId, auth }) {
  if (url.pathname === "/api/admin/health" && req.method === "GET") {
    if (!hasScope(auth, "admin:read")) return deny("admin:read");
    return { status: 200, body: { ok: true, alerts: state.alerts.length, gaps: state.gaps.length, deployments: state.deployments.length, auditChainValid: audit.verifyChain(), persistentState: Boolean(statePath), dataProviderConfigured: Boolean(providerUrl) } };
  }
  if (url.pathname === "/api/admin/xuka/phases" && req.method === "GET") {
    if (!hasScope(auth, "admin:read")) return deny("admin:read");
    record("admin.xuka.phases.read", auth, requestId);
    return { status: 200, body: { items: listXukaPhases(), snapshot: getXukaImplementationSnapshot() } };
  }
  const xukaPhaseMatch = url.pathname.match(/^\/api\/admin\/xuka\/phases\/([^/]+)$/);
  if (xukaPhaseMatch && req.method === "GET") {
    if (!hasScope(auth, "admin:read")) return deny("admin:read");
    try {
      const phase = getXukaPhaseStatus(xukaPhaseMatch[1]);
      record("admin.xuka.phase.read", auth, requestId, { phase: phase.phase });
      return { status: 200, body: phase };
    } catch (error) {
      return { status: 404, body: { error: error.message, code: "XUKA_PHASE_NOT_FOUND", requestId } };
    }
  }
  if (url.pathname === "/api/admin/xuka/registry" && req.method === "GET") {
    if (!hasScope(auth, "admin:read")) return deny("admin:read");
    record("admin.xuka.registry.read", auth, requestId);
    return { status: 200, body: getXukaImplementationSnapshot() };
  }
  if (url.pathname === "/api/admin/xuka/validate" && req.method === "POST") {
    if (!hasScope(auth, "admin:read")) return deny("admin:read");
    const body = await readJsonBody(req);
    try {
      const contract = createApiContract(body);
      record("admin.xuka.validate", auth, requestId, { contract: contract.name });
      return { status: 200, body: { valid: true, contract } };
    } catch (error) {
      record("admin.xuka.validate.failed", auth, requestId, { code: error.code ?? "XUKA_CONTRACT_INVALID" });
      return { status: 400, body: { valid: false, error: error.message, code: error.code ?? "XUKA_CONTRACT_INVALID", requestId } };
    }
  }
  if (url.pathname === "/api/admin/xuka/preview" && req.method === "POST") {
    if (!hasScope(auth, "admin:read")) return deny("admin:read");
    const body = await readJsonBody(req);
    const preview = createOperationPreview({
      operation: body.operation,
      resource: body.resource,
      changes: body.changes,
      auth: { role: auth?.roles?.[0], scope: body.scope },
      policy: { authorize: ({ role, scope, resource, action }) => ({
        allowed: role === "owner" && scope === "admin:read" && Boolean(resource) && Boolean(action),
        role,
        scope,
        resource,
        action,
      }) },
    });
    record("admin.xuka.preview", auth, requestId, { resource: preview.resource, operation: preview.operation, authorized: preview.authorized });
    return { status: 200, body: preview };
  }
  if (url.pathname === "/api/admin/xuka/inspect" && req.method === "POST") {
    if (!hasScope(auth, "admin:read")) return deny("admin:read");
    const body = await readJsonBody(req);
    try {
      let result;
      if (body.operation === "boundary") {
        result = createAccessBoundary({ owner: body.owner, resources: body.resources, operations: body.operations, events: body.events }).allows(body.request);
      } else if (body.operation === "context") {
        result = createCanonicalContext(body.context);
      } else if (body.operation === "dependencies") {
        result = createDependencyGraph({ nodes: body.nodes, edges: body.edges });
        result = { nodes: result.nodes(), edges: result.edges(), cycles: result.cycles(), impact: body.node ? result.impact(body.node) : [] };
      } else if (body.operation === "events") {
        const registry = createEventSchemaRegistry({ definitions: body.definitions ?? [] });
        result = registry.validate(body.type, body.version, body.payload);
      } else if (body.operation === "configuration") {
        const engine = createConfigurationEngine({ layers: body.layers, schema: body.schema, initial: body.initial });
        result = { resolved: engine.resolve(body.overrides), ui: engine.uiModel(), audit: engine.audit() };
      } else if (body.operation === "feature-flags") {
        const engine = createFeatureFlagEngine({ definitions: body.definitions });
        result = { evaluation: body.name ? engine.evaluate(body.name, body.context) : undefined, flags: engine.uiModel(), audit: engine.audit() };
      } else if (body.operation === "state") {
        const engine = createStateEngine({ states: body.states, transitions: body.transitions, initial: body.initial });
        result = { catalog: engine.catalog(), records: body.id ? [engine.inspect(body.id)] : undefined, history: engine.timeline() };
      } else if (body.operation === "quotas") {
        const engine = createQuotaEngine({ quotas: body.quotas });
        result = { status: body.name ? engine.status(body.name) : undefined, quotas: engine.uiModel(), events: engine.events() };
      } else if (body.operation === "discovery") {
        const engine = createDataDiscoveryEngine({ datasets: body.datasets });
        result = { schemas: engine.schemas(), relationships: engine.relationships(), findings: engine.findings(), map: engine.dataMap() };
      } else if (body.operation === "lifecycle") {
        const engine = createDataLifecycleEngine({ policies: body.policies });
        result = { model: engine.model(), audit: engine.audit() };
      } else if (body.operation === "artifacts") {
        const engine = createArtifactLifecycleEngine({ artifacts: body.artifacts });
        result = { artifacts: engine.uiModel(), orphans: engine.orphans(body.knownSources) };
      } else if (body.operation === "credentials") {
        const engine = createCredentialLifecycleEngine({ credentials: body.credentials });
        result = { credentials: engine.list(), audit: engine.audit() };
      } else if (body.operation === "compatibility") {
        const engine = createVersionCompatibilityEngine({ versions: body.versions, rules: body.rules, consumers: body.consumers });
        result = {
          check: body.from && body.to ? engine.check(body.from, body.to, body.context) : undefined,
          breakingChanges: body.previousSchema && body.nextSchema ? engine.detectBreakingChanges(body.previousSchema, body.nextSchema) : undefined,
          report: engine.report(),
          releaseGate: body.from && body.to ? engine.releaseGate(body.from, body.to, body.context) : undefined,
        };
      } else if (body.operation === "knowledge-graph") {
        const engine = createKnowledgeGraphEngine({ entities: body.entities, relationships: body.relationships });
        result = {
          entities: engine.entities(body.subject),
          relationships: engine.relationships(body.subject),
          traversal: body.start ? engine.traverse(body.start, { depth: body.depth, subject: body.subject }) : undefined,
        };
      } else if (body.operation === "production-gap-closure") {
        const engine = createProductionGapClosureEngine({ checks: body.checks });
        for (const [name, input] of Object.entries(body.results ?? {})) {
          if (typeof engine[name] === "function") engine[name](input);
        }
        result = engine.summary();
      } else if (body.operation === "frontend-verification") {
        const plan = createFrontendVerificationPlan({ routes: body.routes, contracts: body.contracts, states: body.states, responsive: body.responsive });
        result = { valid: plan.validate(), routes: plan.uiModel(), responsive: plan.responsive, contracts: plan.contracts };
      } else if (body.phase) {
        result = getXukaPhase(body.phase);
      } else {
        return { status: 400, body: { error: "Unsupported XUKA inspection operation", code: "XUKA_OPERATION_INVALID", requestId } };
      }
      record("admin.xuka.inspect", auth, requestId, { operation: body.operation ?? "phase" });
      return { status: 200, body: result };
    } catch (error) {
      record("admin.xuka.inspect.failed", auth, requestId, { code: error.code ?? "XUKA_INSPECTION_FAILED" });
      return { status: 400, body: { error: error.message, code: error.code ?? "XUKA_INSPECTION_FAILED", requestId } };
    }
  }
  if (url.pathname === "/api/admin/data/resources" && req.method === "GET") {
    if (!hasScope(auth, "admin:read")) return deny("admin:read");
    record("admin.data.catalog.read", auth, requestId);
    return { status: 200, body: { items: listAdminResources() } };
  }
  if (url.pathname === "/api/admin/data/query" && req.method === "POST") {
    const body = await readJsonBody(req);
    const authorization = authorizeAdminDataAction({ auth, resource: body.resource, action: "read", breakGlass: Boolean(body.breakGlassId) });
    if (!authorization.allowed) return deny(authorization.code === "ADMIN_SCOPE_REQUIRED" ? "admin:data:read" : authorization.code);
    const grant = elevatedGrant(body, auth);
    if (body.breakGlassId && !grant.valid) return { status: 403, body: { error: "Break-glass grant is invalid or expired", code: grant.code } };
    try {
      const result = await dataAccessFor(requestId, auth).query(body);
      record("admin.data.query", auth, requestId, { resource: body.resource, breakGlass: Boolean(grant.valid) });
      return { status: 200, body: result };
    } catch (error) {
      record("admin.data.query.failed", auth, requestId, { resource: body.resource, code: error.code ?? "ADMIN_DATA_QUERY_FAILED" });
      return { status: error.code === "ADMIN_DATA_PROVIDER_NOT_CONFIGURED" ? 503 : 502, body: { error: error.message, code: error.code ?? "ADMIN_DATA_QUERY_FAILED", requestId } };
    }
  }
  if (url.pathname === "/api/admin/data/mutate" && req.method === "POST") {
    const body = await readJsonBody(req);
    const breakGlassRequested = Boolean(body.breakGlassId);
    const policy = authorizeAdminAction({ auth, scope: "admin:data:write", reason: body.reason, confirmation: body.confirmation === true, breakGlass: breakGlassRequested });
    if (!policy.allowed) return { status: 403, body: { error: "Admin data mutation is not authorized", code: policy.code, scope: policy.scope } };
    const authorization = authorizeAdminDataAction({ auth, resource: body.resource, action: "write", breakGlass: breakGlassRequested });
    if (!authorization.allowed) return deny("admin:data:write");
    const grant = elevatedGrant(body, auth);
    if (breakGlassRequested && !grant.valid) return { status: 403, body: { error: "Break-glass grant is invalid or expired", code: grant.code } };
    try {
      const result = await dataAccessFor(requestId, auth).mutate(body);
      record("admin.data.mutate", auth, requestId, { resource: body.resource, operation: body.operation, reason: body.reason, breakGlass: Boolean(grant.valid) });
      return { status: 200, body: result };
    } catch (error) {
      record("admin.data.mutate.failed", auth, requestId, { resource: body.resource, code: error.code ?? "ADMIN_DATA_MUTATION_FAILED" });
      return { status: error.code === "ADMIN_DATA_PROVIDER_NOT_CONFIGURED" ? 503 : 400, body: { error: error.message, code: error.code ?? "ADMIN_DATA_MUTATION_FAILED", requestId } };
    }
  }
  if (url.pathname === "/api/admin/break-glass" && req.method === "POST") {
    const body = await readJsonBody(req);
    const policy = authorizeAdminAction({ auth, scope: "admin:break-glass", reason: body.reason, confirmation: body.confirmation === true, breakGlass: true });
    if (!policy.allowed) return { status: 403, body: { error: "Break-glass policy denied", code: policy.code } };
    try {
      const grant = breakGlass.issue({ actor: actorFrom(auth), reason: body.reason, confirmation: body.confirmation === true });
      record("admin.break_glass.issued", auth, requestId, { grantId: grant.id, expiresAt: grant.expiresAt, reason: grant.reason });
      await publish.publish({ eventType: "audit.created", payload: { action: "admin.break_glass.issued", grantId: grant.id, expiresAt: grant.expiresAt }, actor: actorFrom(auth), metadata: { source: "admin-api" } });
      return { status: 201, body: grant };
    } catch (error) {
      return { status: 400, body: { error: error.message, code: error.code ?? "BREAK_GLASS_INVALID" } };
    }
  }
  if (url.pathname === "/api/admin/alerts" && req.method === "GET") {
    if (!hasScope(auth, "admin:read")) return deny("admin:read");
    return { status: 200, body: { items: [...state.alerts] } };
  }
  if (url.pathname === "/api/admin/gaps" && req.method === "GET") {
    if (!hasScope(auth, "admin:read")) return deny("admin:read");
    return { status: 200, body: { items: [...state.gaps] } };
  }
  if (url.pathname === "/api/admin/deployments" && req.method === "GET") {
    if (!hasScope(auth, "admin:read")) return deny("admin:read");
    return { status: 200, body: { items: [...state.deployments] } };
  }
  if (url.pathname === "/api/admin/audits" && req.method === "GET") {
    if (!hasScope(auth, "admin:audit")) return deny("admin:audit");
    return { status: 200, body: { items: audit.list() } };
  }
  if (url.pathname === "/api/admin/events" && req.method === "POST") {
    if (!hasScope(auth, "admin:write") && !hasScope(auth, "platform:internal")) return deny("admin:write");
    const event = await readJsonBody(req);
    if (!event.eventType || event.payload === undefined) return { status: 400, body: { error: "Versioned event is required", code: "INVALID_ADMIN_EVENT" } };
    const item = { id: crypto.randomUUID(), eventType: event.eventType, payload: event.payload, receivedAt: new Date().toISOString() };
    if (event.eventType.startsWith("deployment.")) state.deployments.push(item);
    if (event.eventType === "technical_gap.detected" || event.eventType === "technical_gap.updated") state.gaps.push(item);
    if (event.eventType === "alert.created" || event.eventType === "incident.created") state.alerts.push(item);
    persistState();
    record("admin.event.accepted", auth, requestId, { eventType: event.eventType, itemId: item.id });
    await publish.publish({ eventType: "audit.created", payload: { action: "admin.event.accepted", eventType: event.eventType, itemId: item.id }, actor: actorFrom(auth), metadata: { source: "admin-api" } });
    return { status: 202, body: { accepted: true, itemId: item.id } };
  }
  if (url.pathname === "/api/admin/owner" && req.method === "GET") {
    if (!hasScope(auth, "admin:read")) return deny("admin:read");
    return { status: 200, body: { configured: Boolean(state.adminOwner), ...(state.adminOwner ? { username: state.adminOwner.username, telegramUserId: state.adminOwner.telegramUserId } : {}) } };
  }
  if (url.pathname === "/api/admin/owner/transfer" && req.method === "POST") {
    if (!hasScope(auth, "admin:remediate")) return deny("admin:remediate");
    const body = await readJsonBody(req);
    if (!Number.isSafeInteger(body.telegramUserId) || body.telegramUserId < 1 || typeof body.username !== "string" || !body.username.trim() || body.challenge !== "verified") {
      return { status: 400, body: { error: "Verified Telegram owner challenge is required", code: "OWNER_VERIFICATION_REQUIRED" } };
    }
    state.adminOwner = { telegramUserId: body.telegramUserId, username: body.username.replace(/^@/, ""), verifiedAt: new Date().toISOString() };
    persistState();
    record("admin.owner.transfer", auth, requestId, { telegramUserId: body.telegramUserId });
    return { status: 200, body: { transferred: true, username: state.adminOwner.username, telegramUserId: state.adminOwner.telegramUserId } };
  }
  if (url.pathname === "/api/admin/remediation" && req.method === "POST") {
    if (!hasScope(auth, "admin:remediate")) return deny("admin:remediate");
    const body = await readJsonBody(req);
    if (body.action !== "acknowledge" && body.action !== "resolve") return { status: 400, body: { error: "Unsupported remediation action", code: "INVALID_REMEDIATION" } };
    record(`admin.remediation.${body.action}`, auth, requestId, { resourceId: body.resourceId, reason: body.reason });
    return { status: 202, body: { accepted: true, action: body.action, resourceId: body.resourceId } };
  }
  if (url.pathname === "/api/admin/events/dead-letters" && req.method === "GET") {
    if (!hasScope(auth, "admin:read")) return deny("admin:read");
    try {
      const eventType = url.searchParams.get("eventType") ?? undefined;
      const items = await deadLetters.list({ eventType });
      return { status: 200, body: { items } };
    } catch (error) {
      return { status: error.code === "EVENT_BUS_NOT_CONFIGURED" ? 503 : 502, body: { error: error.message, code: error.code ?? "DEAD_LETTER_LIST_FAILED", requestId } };
    }
  }
  if (url.pathname === "/api/admin/events/dead-letters/replay" && req.method === "POST") {
    if (!hasScope(auth, "admin:remediate")) return deny("admin:remediate");
    const body = await readJsonBody(req);
    // Phase H11.1: an unscoped `all: true` replays the entire dead-letter
    // queue in one call, so — same precedent as `admin.data.mutate` and
    // break-glass above — it needs an explicit confirmation on top of the
    // scope check; a single `eventId` needs no such confirmation since it
    // can only ever replay the event(s) that specific ID names.
    if (body.all === true) {
      const policy = authorizeAdminAction({ auth, scope: "admin:remediate", reason: body.reason, confirmation: body.confirmation === true });
      if (!policy.allowed) return { status: 403, body: { error: "Replaying the full dead-letter queue requires confirmation", code: policy.code, scope: policy.scope } };
    }
    try {
      const replayed = await deadLetters.replay({ eventId: body.eventId, all: body.all === true });
      record("admin.events.dead-letters.replay", auth, requestId, { eventId: body.eventId ?? null, all: body.all === true, replayed: replayed.length });
      return { status: 200, body: { replayed } };
    } catch (error) {
      const status = error.code === "EVENT_BUS_NOT_CONFIGURED" ? 503 : error.code === "DEAD_LETTER_REPLAY_TARGET_REQUIRED" ? 400 : 502;
      return { status, body: { error: error.message, code: error.code ?? "DEAD_LETTER_REPLAY_FAILED", requestId } };
    }
  }
  return { status: 404, body: { error: "Route not found", code: "NOT_FOUND" } };
}

createServiceServer({
  service: "admin",
  displayName: "Admin Control Plane",
  port: Number(process.env.PORT ?? 8111),
  routePrefixes: ["/api/admin"],
  handle,
  authenticate: createConfiguredAuthenticator({ service: "admin", required: true }),
  domain: "admin",
  owner: "Admin",
  ownedResources: ["admin_configuration", "admin_alerts", "admin_gaps", "admin_deployments", "admin_owner", "admin_data_access", "admin_event_dead_letters"],
  // AK4 Phase 2, findings 2d/2e — "alert.created"/"incident.created"
  // removed. admin only ever ingests these two types, pushed in
  // externally via POST /api/admin/events (see that handler above); it
  // never produces them. @ayzen/events' own registry (packages/events)
  // already names different owners for both ("alerting" and "incident"
  // respectively, not "admin"), and packages/domain-boundaries had listed
  // both types in admin's consumedEvents *and* emittedEvents identically
  // — the shape of a copy-paste, not a deliberate "admin is also the
  // producer" design, so that duplicate is removed there too (consumed
  // stays; emitted does not). Whether packages/alerting should be wired
  // as the real producer (fed by, e.g., apps/worker's H11.2 monitors
  // rerouted through it) is still an open product decision — see
  // docs/changes/CHANGES_AK4_PHASE2_EVENT_WIRING_DECISIONS.md.
  emittedEvents: ["audit.created"],
  rollbackStrategy: "disable-admin-route-and-keep-application-traffic",
  dependencies: { configuration: true, auditStore: true, stateStore: true, eventBus: true },
}).start();