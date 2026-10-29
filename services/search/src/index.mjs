import {
  createAuditLog,
  createConfiguredAuthenticator,
  createServiceServer,
  readJsonBody,
  tenantScopeFromHeaders,
} from "@ayzen/service-runtime";
import { createPostgresQuery, createStateStore } from "@ayzen/service-state";
import { createRedisEventBus, createHttpEnvelopeTransport } from "@ayzen/event-client";
import { createTransactionalEventPublisher } from "@ayzen/outbox";
import { createDocumentIndexer, tokenize } from "./indexing.mjs";
import { createSearchEventHandlers } from "./event-handlers.mjs";

// Phase H6.2: durable, Postgres-backed state instead of a plain
// Map() that a restart/redeploy would wipe. Falls back to an
// in-memory Map only when ALLOW_SERVICE_MEMORY_STORE=true (local dev);
// otherwise a missing DATABASE_URL is a boot-time error, not a silent
// data-loss risk.
const dbQuery = await createPostgresQuery();
const allowMemoryState = process.env.ALLOW_SERVICE_MEMORY_STORE === "true";
const documents = await createStateStore({ service: "search", collection: "documents", query: dbQuery, allowMemoryFallback: allowMemoryState });
const audit = createAuditLog({ service: "search-knowledge" });
// See ./indexing.mjs's header: publishes search.document.indexed on every
// index write, same transactional-outbox-over-HTTP publish pattern every
// other service in services/*/src/index.mjs already uses.
const publish = createTransactionalEventPublisher({ service: "search-knowledge", transport: createHttpEnvelopeTransport({ service: "search-knowledge" }) });
const indexer = createDocumentIndexer({ documents, audit, publish });

function actorFrom(auth) {
  return auth ? { subject: auth.sub ?? auth.subject, actorType: auth.actorType ?? "user" } : undefined;
}

// ---------------------------------------------------------------------------
// Phase H7.3 — search subscribes to the event bus directly (rather than
// waiting on the worker's dispatch table to call this service over HTTP)
// specifically so the indexing call on the far side of the fetch below is a
// direct, in-process call to indexer.indexDocument, not a second HTTP hop
// back to this same service's own POST /api/search/documents route. Getting
// the real content still means one HTTP call out — to mail or finance,
// whichever produced the event — since search has no DB access of its own
// to those services' tables.
// ---------------------------------------------------------------------------
const eventHandlers = createSearchEventHandlers({
  indexDocument: indexer.indexDocument,
  mailServiceUrl: process.env.WISP_SERVICE_URL ?? process.env.MAIL_SERVICE_URL,
  financeServiceUrl: process.env.FINANCE_SERVICE_URL,
  serviceAuthSecret: process.env.AYZEN_SERVICE_AUTH_SECRET ?? process.env.SERVICE_TO_SERVICE_SECRET,
});

// Same requirement as apps/worker: this is a separately deployed process, so
// falling back to an in-memory bus would acknowledge indexing work that no
// other process (and no restart of this one) could ever observe again.
if (process.env.EVENT_BUS_REDIS_URL || process.env.EVENT_BUS_URL) {
  const bus = createRedisEventBus({ consumer: process.env.EVENT_BUS_CONSUMER ?? `search-${process.pid}` });
  for (const [eventType, handler] of Object.entries(eventHandlers)) {
    bus.subscribe(eventType, async (event) => {
      try {
        await handler(event);
      } catch (error) {
        console.error(JSON.stringify({ timestamp: new Date().toISOString(), service: "search", event: "event.consumer.failed", type: eventType, event_id: event?.eventId, error: String(error?.message ?? error) }));
        throw error;
      }
    });
  }
} else if (process.env.ALLOW_EVENTBUS_NOOP !== "true") {
  throw new Error("search requires EVENT_BUS_REDIS_URL to consume wisp.message.sent/finance.transaction.created; set ALLOW_EVENTBUS_NOOP=true only for local development");
}

async function handle({ req, url, requestId, auth }) {
  const tenant = tenantScopeFromHeaders(req.headers);
  if (url.pathname === "/api/search/documents" && req.method === "POST") {
    const body = await readJsonBody(req);
    if (!body.sourceId || !body.content) return { status: 400, body: { error: "sourceId and content are required", code: "INVALID_DOCUMENT" } };
    const document = indexer.indexDocument({ sourceId: body.sourceId, title: body.title, content: body.content, tenant, actor: actorFrom(auth) });
    return { status: 202, body: { id: document.id, sourceId: document.sourceId, indexedAt: document.indexedAt, ...tenant } };
  }
  if (url.pathname === "/api/search" && req.method === "GET") {
    const query = url.searchParams.get("q")?.trim();
    if (!query) return { status: 400, body: { error: "q is required", code: "INVALID_QUERY" } };
    const terms = tokenize(query);
    const items = [...documents.values()].filter((document) => (!tenant.workspaceId || document.workspaceId === tenant.workspaceId) && (!tenant.organizationId || document.organizationId === tenant.organizationId)).map((document) => {
      const score = [...terms].filter((term) => document.tokens.includes(term)).length;
      return { document, score };
    }).filter(({ score }) => score > 0).sort((a, b) => b.score - a.score).slice(0, 50).map(({ document, score }) => ({ id: document.id, sourceId: document.sourceId, title: document.title, score, ...tenant }));
    return { status: 200, body: { items, query } };
  }
  if (url.pathname === "/internal/audit" && req.method === "GET") return { status: 200, body: { items: audit.list() } };
  return { status: 404, body: { error: "Route not found", code: "NOT_FOUND" } };
}

createServiceServer({
  service: "search-knowledge",
  displayName: "Search / Knowledge",
  port: Number(process.env.PORT ?? 8108),
  routePrefixes: ["/api/search"],
  handle,
  authenticate: createConfiguredAuthenticator({ service: "search-knowledge" }),
  domain: "search",
  owner: "Search / Knowledge",
  ownedResources: ["search_documents", "search_indexes"],
  consumedEvents: ["wisp.message.sent", "finance.transaction.created"],
  emittedEvents: ["search.document.indexed"],
  rollbackStrategy: "disable SEARCH_SERVICE_URL; retain transactional source records",
  dependencies: { configuration: true, index: true, eventBus: true },
}).start();