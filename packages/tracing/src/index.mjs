import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage();
const VALID_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function incomingId(value) {
  return typeof value === "string" && VALID_ID.test(value) ? value : crypto.randomUUID();
}

export function createRequestContext(headers = {}, overrides = {}) {
  const traceId = incomingId(overrides.traceId ?? headers["x-trace-id"]);
  const requestId = incomingId(overrides.requestId ?? headers["x-request-id"]);
  const correlationId = incomingId(overrides.correlationId ?? headers["x-correlation-id"]);
  const causationId = overrides.causationId ?? headers["x-causation-id"];
  return Object.freeze({
    requestId,
    traceId,
    correlationId,
    ...(typeof causationId === "string" && VALID_ID.test(causationId) ? { causationId } : {}),
    actor: overrides.actor,
    organizationId: overrides.organizationId,
    workspaceId: overrides.workspaceId,
    service: overrides.service,
    client: overrides.client,
  });
}

export function runWithRequestContext(context, callback) {
  return storage.run(context, callback);
}

export function getRequestContext() {
  return storage.getStore();
}

export function contextHeaders(context = getRequestContext()) {
  if (!context) return {};
  return Object.fromEntries([
    ["x-request-id", context.requestId],
    ["x-trace-id", context.traceId],
    ["x-correlation-id", context.correlationId],
    ["x-causation-id", context.causationId],
  ].filter(([, value]) => value));
}

export function requestContextFromHeaders(headers = {}, overrides = {}) {
  return createRequestContext({
    headers: {
      "x-request-id": headers["x-request-id"] ?? headers["X-Request-Id"],
      "x-trace-id": headers["x-trace-id"] ?? headers["X-Trace-Id"],
      "x-correlation-id": headers["x-correlation-id"] ?? headers["X-Correlation-Id"],
      "x-causation-id": headers["x-causation-id"] ?? headers["X-Causation-Id"],
    },
    overrides,
  });
}

export function propagateContextHeaders(context = getRequestContext()) {
  return contextHeaders(context);
}