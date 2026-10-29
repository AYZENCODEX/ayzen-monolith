import crypto from "node:crypto";
import {
  createAuditLog,
  createConfiguredAuthenticator,
  createServiceServer,
  readJsonBody,
  tenantScopeFromHeaders,
} from "@ayzen/service-runtime";
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
const listings = await createStateStore({ service: "marketplace", collection: "listings", query: dbQuery, allowMemoryFallback: allowMemoryState });
// Phase H6.3: Postgres-backed (via the same dbQuery pool as the state
// stores above), so a replayed idempotency key is honored no matter which
// replica handles the retry, instead of only the one that saw the original.
const idempotency = await createSharedIdempotencyStore({ service: "marketplace", query: dbQuery, allowMemoryFallback: allowMemoryState });
const audit = createAuditLog({ service: "marketplace" });
// Phase H6.1: publish through the transactional outbox so the state
// write above and this event either both happen or neither does,
// instead of a bare HTTP publish that can fall out of sync with state
// on a crash or network blip between the two.
const publish = createTransactionalEventPublisher({ service: "marketplace", transport: createHttpEnvelopeTransport({ service: "marketplace" }) });

function actorFrom(auth) {
  return auth ? { subject: auth.sub ?? auth.subject, actorType: auth.actorType ?? "user" } : undefined;
}

function visibleTo(listing, tenant) {
  return (!tenant.workspaceId || listing.workspaceId === tenant.workspaceId)
    && (!tenant.organizationId || listing.organizationId === tenant.organizationId);
}

async function handle({ req, url, requestId, auth }) {
  const tenant = tenantScopeFromHeaders(req.headers);
  if ((url.pathname === "/api/marketplace" || url.pathname === "/api/marketplace/listings") && req.method === "GET") {
    const status = url.searchParams.get("status");
    const query = url.searchParams.get("q")?.toLowerCase();
    const items = [...listings.values()]
      .filter((listing) => visibleTo(listing, tenant))
      .filter((listing) => !status || listing.status === status)
      .filter((listing) => !query || `${listing.title} ${listing.description}`.toLowerCase().includes(query))
      .slice(0, 100)
      .map(({ description, ...listing }) => ({ ...listing, description: description.slice(0, 500) }));
    return { status: 200, body: { items, page: 1, pageSize: items.length, total: items.length } };
  }
  if ((url.pathname === "/api/marketplace" || url.pathname === "/api/marketplace/listings") && req.method === "POST") {
    const body = await readJsonBody(req);
    if (typeof body.title !== "string" || !body.title.trim() || typeof body.description !== "string" || !Number.isSafeInteger(body.priceCents) || body.priceCents < 0) {
      return { status: 400, body: { error: "title, description, and non-negative integer priceCents are required", code: "INVALID_LISTING" } };
    }
    const headerKey = req.headers["idempotency-key"];
    const key = headerKey ? createIdempotencyKey({ scope: "marketplace", key: headerKey }) : undefined;
    const previous = await idempotency.get(key);
    if (previous) return previous;
    const listing = {
      id: crypto.randomUUID(),
      title: body.title.trim().slice(0, 200),
      description: body.description.slice(0, 10_000),
      priceCents: body.priceCents,
      currency: body.currency ?? "USD",
      category: typeof body.category === "string" ? body.category.slice(0, 80) : "general",
      status: "pending_review",
      seller: actorFrom(auth),
      ...tenant,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    listings.set(listing.id, listing);
    const response = { status: 201, body: listing };
    await idempotency.set(key, response);
    audit.record({ action: "marketplace.listing.create", actor: actorFrom(auth), tenant, resource: listing.id, requestId, metadata: { priceCents: listing.priceCents } });
    await publish.publish({
      eventType: "marketplace.listing.created",
      payload: { listingId: listing.id, priceCents: listing.priceCents, currency: listing.currency },
      actor: actorFrom(auth),
      ...tenant,
      aggregate: { type: "marketplace_listing", id: listing.id },
    }).catch(() => {});
    return response;
  }
  if (url.pathname === "/internal/audit" && req.method === "GET") return { status: 200, body: { items: audit.list() } };
  return { status: 404, body: { error: "Route not found", code: "NOT_FOUND" } };
}

createServiceServer({
  service: "marketplace",
  displayName: "Marketplace / VERVE",
  port: Number(process.env.PORT ?? 8107),
  routePrefixes: ["/api/marketplace"],
  handle,
  authenticate: createConfiguredAuthenticator({ service: "marketplace" }),
  domain: "marketplace",
  owner: "VERVE",
  ownedResources: ["marketplace_listings", "marketplace_orders", "marketplace_reviews"],
  emittedEvents: ["marketplace.listing.created"],
  rollbackStrategy: "disable MARKETPLACE_SERVICE_URL and return listing reads to monolith",
  dependencies: { configuration: true, listingStore: true, audit: true, eventBus: true },
}).start();