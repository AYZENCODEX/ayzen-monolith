import http from "node:http";
import crypto from "node:crypto";
import { requestContextFromHeaders, runWithRequestContext, contextHeaders } from "@ayzen/tracing";
import { createJwksAuthenticator, createServiceIdentity, verifyServiceRequestHeaders } from "@ayzen/auth-client";
import { securityHeaders } from "@ayzen/security";
import { authorizeCapability, authorizeServiceCapability } from "@ayzen/authorization";
import { createPolicyService } from "@ayzen/policy-service";
import { createPostgresQuotaStore } from "@ayzen/rate-limit";
import { createPostgresQuery } from "@ayzen/service-state";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { ...JSON_HEADERS, ...securityHeaders(), "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

function requestUrl(req) {
  return new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
}

function now() {
  return new Date().toISOString();
}

export async function readJsonBody(req, { maxBytes = 2_097_152 } = {}) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw Object.assign(new Error("Request body too large"), { code: "REQUEST_BODY_TOO_LARGE" });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Request body is not valid JSON"), { code: "INVALID_JSON" });
  }
}

export function tenantScopeFromHeaders(headers = {}, { auth, requireVerified = true, platformScope = false } = {}) {
  const organizationId = headers["x-organization-id"] ?? headers["X-Organization-Id"];
  const workspaceId = headers["x-workspace-id"] ?? headers["X-Workspace-Id"];
  if (organizationId && !/^[A-Za-z0-9._:@/-]{1,256}$/.test(organizationId)) throw new Error("Invalid organization scope");
  if (workspaceId && !/^[A-Za-z0-9._:@/-]{1,256}$/.test(workspaceId)) throw new Error("Invalid workspace scope");
  const verifiedOrganizationId = auth?.organizationId ?? auth?.organization_id;
  const verifiedWorkspaceId = auth?.workspaceId ?? auth?.workspace_id;
  if (organizationId && verifiedOrganizationId && organizationId !== verifiedOrganizationId) throw Object.assign(new Error("Organization scope is not bound to the authenticated actor"), { code: "TENANT_SCOPE_MISMATCH" });
  if (workspaceId && verifiedWorkspaceId && workspaceId !== verifiedWorkspaceId) throw Object.assign(new Error("Workspace scope is not bound to the authenticated actor"), { code: "TENANT_SCOPE_MISMATCH" });
  if ((organizationId && !verifiedOrganizationId) || (workspaceId && !verifiedWorkspaceId)) {
    if (requireVerified && !platformScope && !auth?.tenantScopeAuthorized) throw Object.assign(new Error("Tenant scope must come from verified identity"), { code: "TENANT_SCOPE_NOT_VERIFIED" });
  }
  const resolvedOrganizationId = verifiedOrganizationId ?? organizationId;
  const resolvedWorkspaceId = verifiedWorkspaceId ?? workspaceId;
  if (!resolvedOrganizationId && !resolvedWorkspaceId) return {};
  return { ...(resolvedOrganizationId ? { organizationId: resolvedOrganizationId } : {}), ...(resolvedWorkspaceId ? { workspaceId: resolvedWorkspaceId } : {}) };
}

export function requireTenantScope(scope, { platformScope = false } = {}) {
  if (platformScope) return scope;
  if (!scope?.organizationId && !scope?.workspaceId) throw Object.assign(new Error("A verified tenant scope is required"), { code: "TENANT_SCOPE_REQUIRED" });
  return scope;
}

export function productionMode() {
  return ["production", "staging"].includes(String(process.env.NODE_ENV ?? "").toLowerCase());
}

export function assertProductionSafeMode(name, value, { allowed = ["enforce"] } = {}) {
  if (productionMode() && !allowed.includes(value)) throw new Error(`${name} must be ${allowed.join(" or ")} outside local development`);
}

// Phase H6.3: this used to own a per-process `Map()`-backed
// createIdempotencyStore(), which meant a retried request only got deduped
// if the load balancer happened to route it back to the same replica that
// saw the original — otherwise the "idempotent" request ran twice. That
// store has moved to `@ayzen/idempotency`'s `createSharedIdempotencyStore`,
// which every replica backs with the same Postgres table (or, for local
// dev only, the same in-memory fallback via ALLOW_SERVICE_MEMORY_STORE).
// Import it from there; nothing here re-exports it, so an old import of
// createIdempotencyStore from this package is a loud build-time error
// instead of a silent revert to per-replica dedup.

export function createAuditLog({ service, maxEntries = 5_000 } = {}) {
  const entries = [];
  return {
    record({ action, actor, tenant, resource, outcome = "success", requestId, metadata = {} } = {}) {
      const entry = {
        timestamp: now(),
        service,
        action,
        actor: actor ? { subject: actor.subject, actorType: actor.actorType } : undefined,
        tenant,
        resource,
        outcome,
        requestId,
        metadata: Object.fromEntries(Object.entries(metadata).filter(([key]) => !/(secret|token|password|private|plaintext|key)/i.test(key))),
      };
      entries.push(Object.freeze(entry));
      while (entries.length > maxEntries) entries.shift();
      console.log(JSON.stringify({ ...entry, event: "audit.recorded" }));
      return entry;
    },
    list() {
      return [...entries];
    },
  };
}

export function createConfiguredAuthenticator({ service, required = process.env.SERVICE_AUTH_REQUIRED === "true" } = {}) {
  const jwksUrl = process.env.SERVICE_JWKS_URL ?? process.env.JWKS_URL;
  if (!jwksUrl) {
    console.warn(JSON.stringify({
      level: "warn",
      event: "authentication.jwks_not_configured",
      service,
      message: "Bearer-token verification is unavailable until SERVICE_JWKS_URL or JWKS_URL is configured",
    }));
  }
  const verify = jwksUrl
    ? createJwksAuthenticator({
      jwksUrl,
      issuer: process.env.SERVICE_JWT_ISSUER ?? process.env.JWT_ISSUER,
      audience: process.env.SERVICE_JWT_AUDIENCE ?? "ayzen-internal",
    })
    : undefined;
  return async ({ req }) => {
    const authorization = req.headers.authorization;
    if (!authorization) {
      const internalSecret = process.env.AYZEN_SERVICE_AUTH_SECRET ?? process.env.SERVICE_TO_SERVICE_SECRET;
      if (internalSecret && verifyServiceRequestHeaders(req.headers, { secret: internalSecret })) {
        return createServiceIdentity({ service: req.headers["x-ayzen-service"] ?? "api-gateway", scopes: [`${service}:internal`] });
      }
      if (required) throw Object.assign(new Error("Authentication is required"), { code: "AUTHENTICATION_REQUIRED" });
      return undefined;
    }
    if (!verify) throw Object.assign(new Error(`JWKS is not configured for ${service}`), { code: "AUTHENTICATION_NOT_CONFIGURED" });
    return verify(authorization);
  };
}

function getRequestId(req) {
  const incoming = req.headers["x-request-id"];
  return typeof incoming === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(incoming)
    ? incoming
    : crypto.randomUUID();
}

function normalizeClientAddress(value) {
  if (typeof value !== "string") return undefined;
  const address = value.trim().replace(/^\[(.*)\]$/, "$1");
  return address || undefined;
}

function trustedProxyHopCount(value) {
  const hops = Number(value);
  return Number.isSafeInteger(hops) && hops > 0 ? hops : 0;
}

/**
 * Resolve the originating client address only when the deployment explicitly
 * declares how many reverse proxies are trusted. Without that declaration,
 * forwarded headers are treated as untrusted and the socket peer is used.
 */
export function resolveClientIp(req, {
  trustedProxyHops = process.env.TRUSTED_PROXY_HOPS ?? process.env.AYZEN_TRUSTED_PROXY_HOPS ?? 0,
} = {}) {
  const remoteAddress = normalizeClientAddress(req?.socket?.remoteAddress) ?? "unknown";
  const hops = trustedProxyHopCount(trustedProxyHops);
  if (!hops) return remoteAddress;
  const forwarded = req?.headers?.["x-forwarded-for"];
  const chain = (Array.isArray(forwarded) ? forwarded.join(",") : forwarded ?? "")
    .split(",")
    .map(normalizeClientAddress)
    .filter(Boolean);
  if (!chain.length) return remoteAddress;
  chain.push(remoteAddress);
  return chain[Math.max(0, chain.length - hops - 1)] ?? remoteAddress;
}

function pruneRateLimitState(state, nowMs, windowMs, maxKeys) {
  for (const [key, bucket] of state) {
    if (nowMs - bucket.startedAt >= windowMs) state.delete(key);
  }
  if (state.size <= maxKeys) return;
  const oldest = [...state.entries()]
    .sort(([, left], [, right]) => left.startedAt - right.startedAt)
    .slice(0, state.size - maxKeys);
  for (const [key] of oldest) state.delete(key);
}

/**
 * Enforcement Roadmap Track H, Phase H9.1: `authorizeServiceCapability`
 * (H4) proves identity *presence* only — its own header explains why it
 * stops at "IDENTITY_PRESENT_SCOPE_NOT_VERIFIED" rather than actually
 * checking scopes/roles/step-up. This normalizes whatever shape `auth`
 * came out of `authenticate()` as (a raw verified-JWT payload from
 * `@ayzen/auth-client`'s `createJwksAuthenticator` — `sub`, not
 * necessarily `subject` — or a `createServiceIdentity()` object, which
 * already uses `subject`) into the `{ subject, actorType, scopes, roles,
 * stepUpAt }` shape `@ayzen/authorization`'s `authorizeCapability` expects,
 * the same normalization services/workflow/src/index.mjs's own
 * `actorFrom()` already does for the same reason (H8.3/H8.4).
 */
function capabilityAuthContext(auth) {
  return {
    subject: auth?.subject ?? auth?.sub ?? auth?.userId,
    actorType: auth?.actorType ?? "user",
    organizationId: auth?.organizationId,
    workspaceId: auth?.workspaceId,
    scopes: Array.isArray(auth?.scopes) ? auth.scopes : [],
    roles: Array.isArray(auth?.roles) ? auth.roles : [],
    stepUpAt: auth?.stepUpAt,
  };
}

/**
 * Small transport-only runtime shared by extracted services.
 *
 * It deliberately contains no database client and no domain behavior. Domain
 * services own their handlers and can be deployed independently without
 * importing the legacy API server.
 */
export function createServiceServer({
  service,
  displayName = service,
  version = "1.0.0",
  port = Number(process.env.PORT ?? 8080),
  routePrefixes = [],
  handle = async () => ({ status: 404, body: { error: "Route not implemented" } }),
  dependencies = {},
  requestTimeoutMs = Number(process.env.SERVICE_REQUEST_TIMEOUT_MS ?? 15_000),
  authenticate,
  rateLimit = { windowMs: 60_000, max: 300 },
  rateLimitStore,
  domain,
  owner,
  ownedResources = [],
  emittedEvents = [],
  consumedEvents = [],
  rollbackStrategy = "gateway-fallback",
  policyService,
}) {
  // H5.1: EVENT_BUS_URL was one var doing double duty as both the HTTP base
  // URL (createHttpEventPublisher) and the raw Redis connection string
  // (createRedisEventBus). This runtime is shared by HTTP-publishing
  // services and the Redis-consuming worker, so it accepts either dedicated
  // var here; each transport enforces its own var is set where it's used.
  if (
    dependencies.eventBus === true &&
    !process.env.EVENT_BUS_HTTP_URL &&
    !process.env.EVENT_BUS_REDIS_URL &&
    process.env.ALLOW_EVENTBUS_NOOP !== "true"
  ) {
    const error = new Error(`${service} requires EVENT_BUS_HTTP_URL or EVENT_BUS_REDIS_URL; set ALLOW_EVENTBUS_NOOP=true only for local development`);
    error.code = "EVENT_BUS_NOT_CONFIGURED";
    throw error;
  }
  let draining = false;
  let server;
  const metrics = {
    requests_total: 0,
    requests_failed_total: 0,
    requests_timed_out_total: 0,
    responses_5xx_total: 0,
    request_duration_ms_sum: 0,
    request_duration_ms_count: 0,
  };
  const rateLimitState = new Map();
  const sharedRateLimitStorePromise = rateLimitStore
    ? Promise.resolve(rateLimitStore)
    : createPostgresQuery().then((query) => query ? createPostgresQuotaStore({ query }) : undefined);
  const decisionPoint = policyService ?? createPolicyService({
    policies: {
      [service]: {
        request: ({ subject }) => typeof subject === "string" && subject.length > 0 && subject !== "anonymous",
      },
    },
    audit: (decision) => {
      console.log(JSON.stringify({
        timestamp: now(),
        level: decision.decision === "allow" ? "info" : "warn",
        service,
        event: decision.decision === "allow" ? "policy.decision.allowed" : "policy.decision.denied",
        policy_engine: "services/policy",
        subject: decision.subject,
        app: decision.app,
        action: decision.action,
        resource: decision.resource,
        reason: decision.reason,
        trace_id: decision.traceId,
      }));
    },
  });
  const rateLimitMaxKeys = Number(process.env.RATE_LIMIT_MAX_KEYS ?? 10_000);
  const trustedProxyHops = process.env.TRUSTED_PROXY_HOPS ?? process.env.AYZEN_TRUSTED_PROXY_HOPS ?? 0;
  let nextRateLimitSweepAt = 0;

  const manifest = {
    service,
    displayName,
    version,
    routePrefixes,
    mode: "independent-process",
    transport: "http",
    ...(domain ? { domain } : {}),
    ...(owner ? { owner } : {}),
    ownedResources,
    emittedEvents,
    consumedEvents,
    rollbackStrategy,
    startedAt: now(),
  };

  async function handler(req, res) {
    const url = requestUrl(req);
    const startedAt = Date.now();
    const requestId = getRequestId(req);
    const context = requestContextFromHeaders(req.headers, { service });
    res.setHeader("x-request-id", requestId);
    for (const [header, value] of Object.entries(contextHeaders({ ...context, requestId }))) res.setHeader(header, value);
    res.setHeader("x-service", service);
    for (const [header, value] of Object.entries(securityHeaders())) res.setHeader(header, value);
    metrics.requests_total += 1;
    const finish = (status) => {
      if (status >= 500) metrics.responses_5xx_total += 1;
      const durationMs = Date.now() - startedAt;
      metrics.request_duration_ms_sum += durationMs;
      metrics.request_duration_ms_count += 1;
      console.log(JSON.stringify({
        timestamp: now(),
        level: status >= 500 ? "warn" : "info",
        service,
        event: "request.completed",
        request_id: requestId,
        method: req.method,
        path: url.pathname,
        status,
         duration_ms: durationMs,
      }));
    };
    if (req.method === "OPTIONS") {
       res.writeHead(204, {
        "access-control-allow-origin": process.env.CORS_ORIGIN ?? "*",
        "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
        "access-control-allow-headers": "authorization,content-type,x-request-id,x-trace-id,x-correlation-id,x-causation-id",
      });
      res.end();
      finish(204);
      return;
    }
    res.setHeader("access-control-allow-origin", process.env.CORS_ORIGIN ?? "*");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("access-control-expose-headers", "x-request-id,x-trace-id,x-correlation-id,x-service");
    if (rateLimit?.max > 0) {
      const nowMs = Date.now();
      const key = resolveClientIp(req, { trustedProxyHops });
      const sharedStore = await sharedRateLimitStorePromise;
      let decision;
      if (sharedStore) {
        decision = await sharedStore.consume({ key: `${service}:${key}`, limit: rateLimit.max, windowMs: rateLimit.windowMs, cost: 1 });
      } else {
        if (productionMode()) throw Object.assign(new Error(`${service} requires DATABASE_URL for shared rate limiting`), { code: "RATE_LIMIT_STORE_NOT_CONFIGURED" });
        if (nowMs >= nextRateLimitSweepAt) {
          pruneRateLimitState(rateLimitState, nowMs, rateLimit.windowMs, Number.isSafeInteger(rateLimitMaxKeys) && rateLimitMaxKeys > 0 ? rateLimitMaxKeys : 10_000);
          nextRateLimitSweepAt = nowMs + Math.min(rateLimit.windowMs, 60_000);
        }
        const current = rateLimitState.get(key);
        const bucket = !current || nowMs - current.startedAt >= rateLimit.windowMs
          ? { startedAt: nowMs, count: 0 }
          : current;
        bucket.count += 1;
        rateLimitState.set(key, bucket);
        decision = { allowed: bucket.count <= rateLimit.max };
      }
      if (!decision.allowed) {
        json(res, 429, { error: "Rate limit exceeded", code: "RATE_LIMITED", requestId });
        finish(429);
        return;
      }
    }
    if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/live")) {
      json(res, 200, { ok: true, status: "ok", service, requestId, timestamp: now() });
      finish(200);
      return;
    }
    if (req.method === "GET" && url.pathname === "/ready") {
      const checks = Object.fromEntries(
        Object.entries(dependencies).map(([name, value]) => {
          if (name === "eventBus" && value === true) return [name, Boolean(process.env.EVENT_BUS_HTTP_URL || process.env.EVENT_BUS_REDIS_URL || process.env.ALLOW_EVENTBUS_NOOP === "true")];
          return [name, value === true || typeof value !== "function" ? Boolean(value) : Boolean(value())];
        }),
      );
      const ready = Object.values(checks).every(Boolean) && !draining;
      json(res, ready ? 200 : 503, { ok: ready, status: ready ? "ready" : "not_ready", service, checks, timestamp: now() });
      finish(ready ? 200 : 503);
      return;
    }
    if (req.method === "GET" && url.pathname === "/metrics") {
      const lines = [
        "# TYPE service_requests_total counter",
        `service_requests_total{service="${service}"} ${metrics.requests_total}`,
        `service_requests_failed_total{service="${service}"} ${metrics.requests_failed_total}`,
        `service_requests_timed_out_total{service="${service}"} ${metrics.requests_timed_out_total}`,
        `service_responses_5xx_total{service="${service}"} ${metrics.responses_5xx_total}`,
        `service_request_duration_ms_sum{service="${service}"} ${metrics.request_duration_ms_sum}`,
        `service_request_duration_ms_count{service="${service}"} ${metrics.request_duration_ms_count}`,
      ];
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4", "cache-control": "no-store", "x-request-id": requestId });
      res.end(`${lines.join("\n")}\n`);
      finish(200);
      return;
    }
    if (req.method === "GET" && url.pathname === "/internal/manifest") {
      json(res, 200, { ...manifest, draining });
      finish(200);
      return;
    }
    if (req.method === "GET" && url.pathname === "/internal/health") {
      json(res, 200, { ...manifest, ok: true, draining, timestamp: now() });
      finish(200);
      return;
    }
    if (draining) {
      json(res, 503, { error: "Service is draining", code: "SERVICE_DRAINING" });
      finish(503);
      return;
    }

    try {
      const auth = authenticate ? await authenticate({ req, url, context }) : undefined;
      const gateDecision = authorizeServiceCapability({
        method: req.method,
        pathname: url.pathname,
        auth,
        internalService: auth?.actorType === "service",
      });
      // Enforcement Roadmap Track H, Phase H4 — every extracted service goes
      // through this ONE gate (see @ayzen/authorization's
      // authorizeServiceCapability for what it does and does not decide yet)
      // instead of each service hand-rolling its own check. Kill switch
      // mirrors Phase H3's POLICY_DECISION_EVENTS pattern: "enforce" (default)
      // blocks AUTHENTICATED_SUBJECT_REQUIRED denials; "report" logs the same
      // decision but never blocks (safe rollout / staging); "off" skips the
      // gate entirely. An unset or typo'd value fails toward "enforce" — a
      // misconfigured env var must never silently disable a gate that fails
      // closed by design.
      const gateMode = (() => {
        const raw = (process.env.SERVICE_CAPABILITY_GATE ?? "enforce").toLowerCase();
        return raw === "off" || raw === "report" ? raw : "enforce";
      })();
      if (gateMode !== "off") {
        if (gateDecision.decision !== "not_gated") {
          console.log(JSON.stringify({
            timestamp: now(), level: gateDecision.decision === "deny" ? "warn" : "info", service,
            event: gateDecision.decision === "deny" ? "policy.decision.denied" : "policy.decision.allowed",
            request_id: requestId, method: req.method, path: url.pathname,
            capability: gateDecision.capability, reason: gateDecision.reason, gate_mode: gateMode,
          }));
        }
        if (gateDecision.decision !== "deny") {
          const subject = auth?.subject ?? auth?.sub ?? auth?.userId ?? "anonymous";
          const policyDecision = decisionPoint.decide({
            subject,
            actorType: auth?.actorType ?? "user",
            app: service,
            action: "request",
            resource: `${req.method}:${url.pathname}`,
            scopes: Array.isArray(auth?.scopes) ? auth.scopes : [],
            traceId: context.traceId,
          });
          if (policyDecision.decision !== "allow") {
            json(res, 401, {
              error: "Policy decision denied this request",
              code: "POLICY_DECISION_DENIED",
              reason: policyDecision.reason,
              requestId,
            });
            finish(401);
            return;
          }
        }
        if (gateDecision.decision === "deny" && gateMode === "enforce") {
          json(res, 401, { error: "Authentication is required for this capability", code: gateDecision.reason, capability: gateDecision.capability, requestId });
          finish(401);
          return;
        }
        // Phase H9.1/H9.2 — the second, fine-grained gate stage the coarse
        // gate above (H4) explicitly deferred (see authorizeServiceCapability's
        // own header for why it stops at "IDENTITY_PRESENT_SCOPE_NOT_VERIFIED"
        // rather than checking scopes/roles/step-up itself). Only runs once
        // the coarse gate resolved a real capability requirement for this
        // route: "NO_SCOPE_REQUIRED" has nothing further to verify, and an
        // already-trusted service-to-service caller ("INTERNAL_SERVICE_TRUSTED")
        // is deliberately not re-derived from scratch here either, for the
        // same reason the coarse gate trusts it in the first place.
        //
        // H9.2 — this gets its OWN kill switch, CAPABILITY_AUTHZ_GATE,
        // independent of SERVICE_CAPABILITY_GATE above. It is fail-closed
        // by default now that the identity service mints scopes/roles onto
        // session tokens. Operators can explicitly use "report" during a
        // controlled migration and "off" only for a declared local escape
        // hatch; unset or typo'd values must never weaken authorization.
        const capabilityAuthzGateMode = (() => {
          const raw = (process.env.CAPABILITY_AUTHZ_GATE ?? "enforce").toLowerCase();
          return raw === "off" || raw === "report" ? raw : "enforce";
        })();
        if (
          capabilityAuthzGateMode !== "off" &&
          gateDecision.decision === "allow" &&
          gateDecision.reason !== "NO_SCOPE_REQUIRED" &&
          gateDecision.reason !== "INTERNAL_SERVICE_TRUSTED"
        ) {
          const capabilityDecision = authorizeCapability({ capability: gateDecision.capability, ...capabilityAuthContext(auth) });
          if (capabilityDecision.decision !== "allow") {
            console.log(JSON.stringify({
              timestamp: now(), level: "warn", service,
              event: "policy.decision.denied",
              stage: "capability_authz",
              request_id: requestId, method: req.method, path: url.pathname,
              capability: gateDecision.capability, reason: capabilityDecision.reason, gate_mode: capabilityAuthzGateMode,
            }));
            if (capabilityAuthzGateMode === "enforce") {
              const status = capabilityDecision.reason === "MISSING_SCOPE" ? 403
                : capabilityDecision.reason === "STEP_UP_REQUIRED" ? 428
                : 401;
              json(res, status, {
                error: capabilityDecision.reason === "MISSING_SCOPE"
                  ? "This capability requires a scope the caller does not have"
                  : capabilityDecision.reason === "STEP_UP_REQUIRED"
                    ? "This capability requires a recent step-up authentication"
                    : "Authentication is required for this capability",
                code: capabilityDecision.reason,
                capability: gateDecision.capability,
                ...(capabilityDecision.requiredScopes ? { requiredScopes: capabilityDecision.requiredScopes } : {}),
                requestId,
              });
              finish(status);
              return;
            }
          }
        }
      }
      const abort = new AbortController();
      const timeout = setTimeout(() => abort.abort(), requestTimeoutMs);
      const result = await Promise.race([
        runWithRequestContext({ ...context, requestId, actor: auth?.actor, organizationId: auth?.organizationId, workspaceId: auth?.workspaceId }, () =>
          handle({ req, res, url, service, requestId, context, auth, signal: abort.signal }),
        ),
        new Promise((_, reject) => abort.signal.addEventListener("abort", () => {
          const error = new Error("Service request timed out");
          error.code = "SERVICE_REQUEST_TIMEOUT";
          reject(error);
        }, { once: true })),
      ]).finally(() => clearTimeout(timeout));
      if (res.writableEnded) return;
      json(res, result?.status ?? 200, result?.body ?? { ok: true });
      finish(result?.status ?? 200);
    } catch (error) {
      metrics.requests_failed_total += 1;
      if (error?.code === "SERVICE_REQUEST_TIMEOUT") metrics.requests_timed_out_total += 1;
      console.error(JSON.stringify({
        timestamp: now(),
        level: "error",
        service,
        event: "request.failed",
        request_id: requestId,
        method: req.method,
        path: url.pathname,
        code: error?.code ?? "SERVICE_REQUEST_FAILED",
        error: error instanceof Error ? error.message : String(error),
      }));
      const timedOut = error?.code === "SERVICE_REQUEST_TIMEOUT";
      if (!res.writableEnded) json(res, timedOut ? 504 : (error?.code === "REQUEST_BODY_TOO_LARGE" ? 413 : error?.code === "INVALID_JSON" ? 400 : 500), {
        error: timedOut ? "Service request timed out" : "Internal service error",
        code: timedOut ? error.code : (error?.code ?? "SERVICE_REQUEST_FAILED"),
        requestId,
      });
      finish(timedOut ? 504 : (error?.code === "REQUEST_BODY_TOO_LARGE" ? 413 : error?.code === "INVALID_JSON" ? 400 : 500));
    }
  }

  function start() {
    server = http.createServer(handler);
    server.listen(port, "0.0.0.0", () => {
      console.log(JSON.stringify({ timestamp: now(), level: "info", service, event: "service.started", port, routePrefixes }));
    });
    const shutdown = (signal) => {
      if (draining) return;
      draining = true;
      console.log(JSON.stringify({ timestamp: now(), level: "info", service, event: "service.draining", signal }));
      server.close(() => process.exit(0));
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
    return server;
  }

  return { start, manifest };
}

export { json };