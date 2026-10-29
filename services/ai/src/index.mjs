import crypto from "node:crypto";
import {
  createAuditLog,
  createConfiguredAuthenticator,
  createServiceServer,
  readJsonBody,
  tenantScopeFromHeaders,
  requireTenantScope,
} from "@ayzen/service-runtime";
import { verifyStepUpToken } from "@ayzen/auth-client";
import { createHttpEnvelopeTransport } from "@ayzen/event-client";
import { createTransactionalEventPublisher } from "@ayzen/outbox";
import { createIdempotencyKey } from "@ayzen/contracts";
import { createSharedIdempotencyStore } from "@ayzen/idempotency";
import { createPostgresQuery, createStateStore } from "@ayzen/service-state";

// Phase H6.2: durable, Postgres-backed state instead of a plain
// Map() that a restart/redeploy would wipe. Falls back to an
// in-memory Map only when ALLOW_SERVICE_MEMORY_STORE=true (local dev);
// otherwise a missing DATABASE_URL is a boot-time error, not a silent
// data-loss risk.
const dbQuery = await createPostgresQuery();
const allowMemoryState = process.env.ALLOW_SERVICE_MEMORY_STORE === "true";
const tasks = await createStateStore({ service: "ai", collection: "tasks", query: dbQuery, allowMemoryFallback: allowMemoryState });
// Phase H6.3: Postgres-backed (via the same dbQuery pool as the state
// stores above), so a replayed idempotency key is honored no matter which
// replica handles the retry, instead of only the one that saw the original.
const idempotency = await createSharedIdempotencyStore({ service: "ai", query: dbQuery, allowMemoryFallback: allowMemoryState });
const audit = createAuditLog({ service: "ai-agent" });
// Phase H6.1: publish through the transactional outbox so the state
// write above and this event either both happen or neither does,
// instead of a bare HTTP publish that can fall out of sync with state
// on a crash or network blip between the two.
const publish = createTransactionalEventPublisher({ service: "ai-agent", transport: createHttpEnvelopeTransport({ service: "ai-agent" }) });
const allowedTools = new Set((process.env.ZYNTH_ALLOWED_TOOLS ?? "").split(",").map((value) => value.trim()).filter(Boolean));
const sensitiveTools = new Set(["finance.write", "vault.reveal", "workflow.execute"]);
const consumedStepUps = new Set();

function actorFrom(auth) {
  return auth ? { subject: auth.sub ?? auth.subject, actorType: auth.actorType ?? "user" } : undefined;
}

async function callProvider(task, signal) {
  const providerUrl = process.env.ZYNTH_PROVIDER_URL;
  if (!providerUrl) return { status: "queued", provider: "unconfigured" };
  const response = await fetch(providerUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: task.model, prompt: task.prompt, tools: task.tools }),
    signal,
  });
  if (!response.ok) throw Object.assign(new Error(`AI provider returned ${response.status}`), { code: "AI_PROVIDER_FAILED" });
  return response.json();
}

async function handle({ req, url, requestId, auth, signal }) {
  const tenant = tenantScopeFromHeaders(req.headers, { auth });
  if (url.pathname === "/api/ai/tasks" && req.method === "GET") {
    return { status: 200, body: { items: [...tasks.values()].filter((task) => (!tenant.workspaceId || task.workspaceId === tenant.workspaceId) && (!tenant.organizationId || task.organizationId === tenant.organizationId)).map(({ prompt, ...safe }) => safe) } };
  }
  if (url.pathname === "/api/ai/tasks" && req.method === "POST") {
    requireTenantScope(tenant);
    const body = await readJsonBody(req);
    if (!body.prompt || typeof body.prompt !== "string" || body.prompt.length > 50_000) return { status: 400, body: { error: "A prompt up to 50,000 characters is required", code: "INVALID_AI_TASK" } };
    const tools = Array.isArray(body.tools) ? body.tools : [];
    if (tools.some((tool) => !allowedTools.has(tool))) return { status: 403, body: { error: "Requested tool is not allowlisted", code: "AI_TOOL_NOT_ALLOWED" } };
    if (tools.some((tool) => sensitiveTools.has(tool))) {
      const stepUp = verifyStepUpToken(req.headers["x-step-up-token"], {
        subject: auth?.sub ?? auth?.subject,
        purpose: "ai.sensitive-action",
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId,
        consumed: consumedStepUps,
      });
      if (!stepUp.valid) return { status: 428, body: { error: "Fresh single-use step-up authorization is required", code: stepUp.reason } };
    }
    const headerKey = req.headers["idempotency-key"];
    const key = headerKey ? createIdempotencyKey({ scope: "ai", key: headerKey }) : undefined;
    const previous = await idempotency.get(key);
    if (previous) return previous;
    const task = { id: crypto.randomUUID(), status: "running", model: body.model ?? process.env.ZYNTH_DEFAULT_MODEL ?? "default", tools, ...tenant, createdAt: new Date().toISOString() };
    tasks.set(task.id, { ...task, prompt: body.prompt });
    const actor = actorFrom(auth);
    audit.record({ action: "ai.task.request", actor, tenant, resource: task.id, requestId, metadata: { model: task.model, toolCount: tools.length } });
    try {
      const result = await callProvider({ ...task, prompt: body.prompt }, signal);
      const updated = { ...task, status: result.status === "queued" ? "queued" : "completed", result: result.status === "queued" ? undefined : result, completedAt: result.status === "queued" ? undefined : new Date().toISOString() };
      tasks.set(task.id, { ...updated, prompt: body.prompt });
      await publish.publish({ eventType: "ai.task.completed", payload: { taskId: task.id, status: updated.status, model: task.model }, actor, ...tenant, aggregate: { type: "ai_task", id: task.id } });
      const response = { status: updated.status === "queued" ? 202 : 200, body: { ...updated, prompt: undefined } };
      await idempotency.set(key, response);
      return response;
    } catch (error) {
      tasks.set(task.id, { ...task, status: "failed", error: error.message, prompt: body.prompt });
      await publish.publish({ eventType: "ai.task.failed", payload: { taskId: task.id, code: error.code ?? "AI_TASK_FAILED" }, actor, ...tenant, aggregate: { type: "ai_task", id: task.id } }).catch(() => {});
      return { status: 502, body: { error: "AI provider unavailable", code: error.code ?? "AI_TASK_FAILED", taskId: task.id } };
    }
  }
  if (url.pathname === "/internal/audit" && req.method === "GET") return { status: 200, body: { items: audit.list() } };
  return { status: 404, body: { error: "Route not found", code: "NOT_FOUND" } };
}

createServiceServer({
  service: "ai-agent",
  displayName: "AI / Agent / ZYNTH",
  port: Number(process.env.PORT ?? 8106),
  routePrefixes: ["/api/ai"],
  handle,
  authenticate: createConfiguredAuthenticator({ service: "ai-agent" }),
  domain: "ai",
  owner: "ZYNTH",
  ownedResources: ["ai_runs", "ai_usage", "ai_audit"],
  emittedEvents: ["ai.task.completed", "ai.task.failed"],
  consumedEvents: ["workflow.completed"],
  rollbackStrategy: "disable AI_SERVICE_URL and reject new provider work",
  dependencies: { configuration: true, policy: true, audit: true, eventBus: true },
}).start();