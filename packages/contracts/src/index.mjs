import crypto from "node:crypto";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:@/-]{1,256}$/;

export const API_VERSIONS = Object.freeze(["v1"]);
export const DOMAIN_NAMES = Object.freeze([
  "identity",
  "authorization",
  "user",
  "workspace",
  "finance",
  "vault",
  "mail",
  "notification",
  "workflow",
  "ai",
  "communication",
  "marketplace",
  "intelligence",
  "telemetry",
  "search",
  "admin",
  "telegram",
  // Phase 06 ("Contract Zero-Gap Sprint") -- catch-all contract for legacy
  // monolith route surface that predates the per-domain contract model. See
  // packages/domain-boundaries/src/index.mjs's "platform" contract comment.
  "platform",
]);
export const REQUEST_HEADERS = Object.freeze({
  requestId: "x-request-id",
  traceId: "x-trace-id",
  correlationId: "x-correlation-id",
  causationId: "x-causation-id",
  service: "x-ayzen-service",
});

export function assertApiVersion(version) {
  if (!API_VERSIONS.includes(version)) throw new Error(`Unsupported API version: ${String(version)}`);
  return version;
}

export function createError({ code, message, requestId, details } = {}) {
  if (typeof code !== "string" || !code) throw new Error("Error code is required");
  if (typeof message !== "string" || !message) throw new Error("Error message is required");
  return {
    error: { code, message, ...(details === undefined ? {} : { details }) },
    ...(requestId && REQUEST_ID_PATTERN.test(requestId) ? { requestId } : {}),
  };
}

export function createSuccess({ data, requestId, meta } = {}) {
  return {
    data,
    ...(requestId && REQUEST_ID_PATTERN.test(requestId) ? { requestId } : {}),
    ...(meta && typeof meta === "object" ? { meta } : {}),
  };
}

export function createPage({ items, page = 1, pageSize = items.length, total = items.length, nextCursor } = {}) {
  if (!Array.isArray(items)) throw new Error("Page items must be an array");
  if (!Number.isSafeInteger(page) || page < 1) throw new Error("Page must be a positive integer");
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000) throw new Error("Page size must be between 1 and 1000");
  if (!Number.isSafeInteger(total) || total < 0) throw new Error("Page total must be a non-negative integer");
  return { items, page, pageSize, total, ...(nextCursor ? { nextCursor } : {}) };
}

export function createCursorPage({ items, nextCursor, hasMore = Boolean(nextCursor), total } = {}) {
  if (!Array.isArray(items)) throw new Error("Cursor page items must be an array");
  if (items.length > 1000) throw new Error("Cursor page cannot contain more than 1000 items");
  if (nextCursor !== undefined && (typeof nextCursor !== "string" || nextCursor.length > 256)) throw new Error("Cursor is invalid");
  if (typeof hasMore !== "boolean") throw new Error("hasMore must be boolean");
  if (total !== undefined && (!Number.isSafeInteger(total) || total < 0)) throw new Error("Total must be a non-negative integer");
  return { items, hasMore, ...(nextCursor ? { nextCursor } : {}), ...(total === undefined ? {} : { total }) };
}

export function createIdempotencyKey({ scope, key }) {
  if (typeof scope !== "string" || !scope.trim()) throw new Error("Idempotency scope is required");
  if (typeof key !== "string" || !/^[A-Za-z0-9._:-]{8,256}$/.test(key)) throw new Error("Invalid idempotency key");
  return `${scope.trim()}:${key}`;
}

export function createServiceMetadata({ name, version = "1.0.0", environment = process.env.NODE_ENV ?? "development" } = {}) {
  if (typeof name !== "string" || !name.trim()) throw new Error("Service name is required");
  return Object.freeze({ name: name.trim(), version, environment });
}

export function createTraceContext({ requestId, traceId, correlationId, causationId } = {}) {
  for (const [name, value] of Object.entries({ requestId, traceId, correlationId, causationId })) {
    if (value !== undefined && (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value))) {
      throw new Error(`Invalid ${name}`);
    }
  }
  return Object.freeze({
    requestId: requestId ?? crypto.randomUUID(),
    traceId: traceId ?? crypto.randomUUID(),
    correlationId: correlationId ?? crypto.randomUUID(),
    ...(causationId ? { causationId } : {}),
  });
}

export function createAuthContext({
  subject,
  actorType = "user",
  organizationId,
  workspaceId,
  sessionId,
  clientId,
  scopes = [],
  roles = [],
} = {}) {
  if (typeof subject !== "string" || !IDENTIFIER_PATTERN.test(subject)) throw new Error("Authenticated subject is required");
  if (!["user", "service", "client"].includes(actorType)) throw new Error("Invalid actor type");
  if (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== "string")) throw new Error("Invalid scopes");
  if (!Array.isArray(roles) || roles.some((role) => typeof role !== "string")) throw new Error("Invalid roles");
  return Object.freeze({
    subject,
    actorType,
    ...(organizationId ? { organizationId } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(clientId ? { clientId } : {}),
    scopes: Object.freeze([...new Set(scopes)]),
    roles: Object.freeze([...new Set(roles)]),
  });
}

export function createAuthorizationContext({ auth, resource, action, decision = "allow" } = {}) {
  if (!auth || typeof auth.subject !== "string") throw new Error("Authentication context is required");
  if (typeof resource !== "string" || !resource) throw new Error("Authorization resource is required");
  if (typeof action !== "string" || !action) throw new Error("Authorization action is required");
  if (!["allow", "deny"].includes(decision)) throw new Error("Invalid authorization decision");
  return Object.freeze({ auth, resource, action, decision });
}

export function assertRequestId(requestId) {
  if (typeof requestId !== "string" || !REQUEST_ID_PATTERN.test(requestId)) throw new Error("Invalid request ID");
  return requestId;
}

export function assertTenantScope({ organizationId, workspaceId } = {}) {
  for (const [name, value] of Object.entries({ organizationId, workspaceId })) {
    if (value !== undefined && (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value))) {
      throw new Error(`Invalid ${name}`);
    }
  }
  if (organizationId === undefined && workspaceId === undefined) {
    throw new Error("Organization or workspace scope is required");
  }
  return Object.freeze({ organizationId, workspaceId });
}

export function createServiceRequest({
  service,
  operation,
  auth,
  tenant,
  idempotencyKey,
  context,
} = {}) {
  if (typeof service !== "string" || !service.trim()) throw new Error("Service is required");
  if (typeof operation !== "string" || !operation.trim()) throw new Error("Operation is required");
  if (!auth || typeof auth.subject !== "string") throw new Error("Authentication context is required");
  const scope = assertTenantScope(tenant);
  return Object.freeze({
    service: service.trim(),
    operation: operation.trim(),
    auth,
    tenant: scope,
    ...(idempotencyKey ? { idempotencyKey: createIdempotencyKey({ scope: service, key: idempotencyKey }) } : {}),
    ...(context ? { context } : {}),
  });
}

export function createDomainContract({
  name,
  owner,
  publicOperations = [],
  ownedResources = [],
  emittedEvents = [],
  consumedEvents = [],
} = {}) {
  if (!DOMAIN_NAMES.includes(name)) throw new Error(`Unknown domain: ${String(name)}`);
  if (typeof owner !== "string" || !owner.trim()) throw new Error("Domain owner is required");
  const list = (value, label) => {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
      throw new Error(`${label} must be an array of strings`);
    }
    return Object.freeze([...new Set(value.map((item) => item.trim()))]);
  };
  return Object.freeze({
    name,
    owner: owner.trim(),
    publicOperations: list(publicOperations, "Public operations"),
    ownedResources: list(ownedResources, "Owned resources"),
    emittedEvents: list(emittedEvents, "Emitted events"),
    consumedEvents: list(consumedEvents, "Consumed events"),
  });
}