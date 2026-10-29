import crypto from "node:crypto";

export const API_VERSIONS = Object.freeze(["v1"]);
export const HTTP_METHODS = Object.freeze(["GET", "POST", "PUT", "PATCH", "DELETE"]);

const ID = /^[A-Za-z0-9._:@/-]{1,256}$/;

function required(value, label) {
  if (typeof value !== "string" || !value.trim() || !ID.test(value.trim())) throw new Error(`${label} is required`);
  return value.trim();
}

export function createRequestContext({ requestId, traceId, correlationId, causationId } = {}) {
  return Object.freeze({
    requestId: requestId && required(requestId, "Request id") || crypto.randomUUID(),
    traceId: traceId && required(traceId, "Trace id") || crypto.randomUUID(),
    correlationId: correlationId && required(correlationId, "Correlation id") || crypto.randomUUID(),
    ...(causationId ? { causationId: required(causationId, "Causation id") } : {}),
  });
}

export function createApiRequest({
  version = "v1",
  method,
  path,
  context,
  app,
  operation,
  body,
  query = {},
  idempotencyKey,
} = {}) {
  if (!API_VERSIONS.includes(version)) throw new Error("Unsupported API version");
  if (!HTTP_METHODS.includes(method)) throw new Error("Unsupported HTTP method");
  const result = {
    version,
    method,
    path: required(path, "API path"),
    app: required(app, "App"),
    operation: required(operation, "Operation"),
    context: context ?? createRequestContext(),
    query,
    ...(body === undefined ? {} : { body }),
    ...(idempotencyKey ? { idempotencyKey: required(idempotencyKey, "Idempotency key") } : {}),
  };
  return Object.freeze(result);
}

export function createApiResponse({ data, context, status = 200, meta } = {}) {
  if (!Number.isSafeInteger(status) || status < 100 || status > 599) throw new Error("Invalid HTTP status");
  return { data, status, context: context ?? createRequestContext(), ...(meta ? { meta } : {}) };
}

export function createApiError({ code, message, status = 400, context, details, retryable = false } = {}) {
  if (!/^[A-Z][A-Z0-9_]{2,96}$/.test(String(code))) throw new Error("Invalid API error code");
  if (typeof message !== "string" || !message.trim()) throw new Error("API error message is required");
  return {
    error: { code, message: message.trim(), ...(details === undefined ? {} : { details }), retryable: retryable === true },
    status,
    context: context ?? createRequestContext(),
  };
}

export function createPage({ items, page = 1, pageSize = items?.length ?? 0, total = items?.length ?? 0, nextCursor } = {}) {
  if (!Array.isArray(items)) throw new Error("Page items must be an array");
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000) throw new Error("Invalid page");
  if (!Number.isSafeInteger(total) || total < 0) throw new Error("Invalid total");
  return { items, page, pageSize, total, ...(nextCursor ? { nextCursor: required(nextCursor, "Next cursor") } : {}) };
}

export function createSchemaRegistry(definitions = []) {
  const registry = new Map();
  for (const definition of definitions) {
    const name = required(definition.name, "Schema name");
    if (!Number.isSafeInteger(definition.version) || definition.version < 1) throw new Error("Schema version must be positive");
    const key = `${name}:v${definition.version}`;
    if (registry.has(key)) throw new Error(`Duplicate schema: ${key}`);
    registry.set(key, Object.freeze({ ...definition, name, key }));
  }
  return Object.freeze({
    get(name, version = 1) { return registry.get(`${name}:v${version}`); },
    list() { return [...registry.values()]; },
    register(definition) {
      const name = required(definition.name, "Schema name");
      const key = `${name}:v${definition.version}`;
      if (registry.has(key)) throw new Error(`Schema already exists: ${key}`);
      const valid = Object.freeze({ ...definition, name, key });
      registry.set(key, valid);
      return valid;
    },
  });
}