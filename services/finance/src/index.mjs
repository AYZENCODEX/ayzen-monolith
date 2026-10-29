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
const accounts = await createStateStore({ service: "finance", collection: "accounts", query: dbQuery, allowMemoryFallback: allowMemoryState });
const transactions = await createStateStore({ service: "finance", collection: "transactions", query: dbQuery, allowMemoryFallback: allowMemoryState });
// Phase H6.3: Postgres-backed (via the same dbQuery pool as the state
// stores above), so a replayed idempotency key is honored no matter which
// replica handles the retry, instead of only the one that saw the original.
const idempotency = await createSharedIdempotencyStore({ service: "finance", query: dbQuery, allowMemoryFallback: allowMemoryState });
const audit = createAuditLog({ service: "finance" });
// Phase H6.1: publish through the transactional outbox so the state
// write above and this event either both happen or neither does,
// instead of a bare HTTP publish that can fall out of sync with state
// on a crash or network blip between the two.
const publish = createTransactionalEventPublisher({ service: "finance", transport: createHttpEnvelopeTransport({ service: "finance" }) });

function actorFrom(auth) {
  return auth ? { subject: auth.sub ?? auth.subject, actorType: auth.actorType ?? "user" } : undefined;
}

async function handle({ req, url, requestId, auth }) {
  const tenant = tenantScopeFromHeaders(req.headers);
  if (url.pathname === "/api/finance/accounts" && req.method === "GET") {
    return { status: 200, body: { items: [...accounts.values()].filter((account) => (!tenant.workspaceId || account.workspaceId === tenant.workspaceId) && (!tenant.organizationId || account.organizationId === tenant.organizationId)) } };
  }
  if (url.pathname === "/api/finance/accounts" && req.method === "POST") {
    const body = await readJsonBody(req);
    if (!body.name || !Number.isSafeInteger(body.initialBalanceCents ?? 0)) return { status: 400, body: { error: "name and integer initialBalanceCents are required", code: "INVALID_ACCOUNT" } };
    const account = { id: crypto.randomUUID(), name: body.name, balanceCents: body.initialBalanceCents ?? 0, currency: body.currency ?? "USD", ...tenant, createdAt: new Date().toISOString() };
    accounts.set(account.id, account);
    audit.record({ action: "finance.account.create", actor: actorFrom(auth), tenant, resource: account.id, requestId });
    return { status: 201, body: account };
  }
  // Phase H7.3: search needs to fetch a transaction's real content
  // (description, amount, currency) by ID before it can index anything
  // more meaningful than the bare transactionId the finance.transaction.created
  // event payload carries. This is the read side of that lookup.
  const transactionReadMatch = url.pathname.match(/^\/api\/finance\/accounts\/([^/]+)\/transactions\/([^/]+)$/);
  if (transactionReadMatch && req.method === "GET") {
    const account = accounts.get(transactionReadMatch[1]);
    if (!account) return { status: 404, body: { error: "Account not found", code: "ACCOUNT_NOT_FOUND" } };
    const transaction = transactions.get(transactionReadMatch[2]);
    if (!transaction || transaction.accountId !== account.id) return { status: 404, body: { error: "Transaction not found", code: "TRANSACTION_NOT_FOUND" } };
    if (account.workspaceId && tenant.workspaceId && account.workspaceId !== tenant.workspaceId) return { status: 403, body: { error: "Tenant isolation failed", code: "TENANT_MISMATCH" } };
    return { status: 200, body: { ...transaction, currency: account.currency, accountName: account.name } };
  }
  const transactionMatch = url.pathname.match(/^\/api\/finance\/accounts\/([^/]+)\/transactions$/);
  if (transactionMatch && req.method === "POST") {
    const account = accounts.get(transactionMatch[1]);
    if (!account) return { status: 404, body: { error: "Account not found", code: "ACCOUNT_NOT_FOUND" } };
    const body = await readJsonBody(req);
    if (!Number.isSafeInteger(body.amountCents) || !body.description) return { status: 400, body: { error: "amountCents and description are required", code: "INVALID_TRANSACTION" } };
    if (account.workspaceId && tenant.workspaceId && account.workspaceId !== tenant.workspaceId) return { status: 403, body: { error: "Tenant isolation failed", code: "TENANT_MISMATCH" } };
    const headerKey = req.headers["idempotency-key"];
    const key = headerKey ? createIdempotencyKey({ scope: `finance:${account.id}`, key: headerKey }) : undefined;
    const previous = await idempotency.get(key);
    if (previous) return previous;
    const transaction = { id: crypto.randomUUID(), accountId: account.id, amountCents: body.amountCents, description: body.description, status: "posted", ...tenant, createdAt: new Date().toISOString() };
    account.balanceCents += transaction.amountCents;
    transactions.set(transaction.id, transaction);
    const response = { status: 201, body: transaction };
    await idempotency.set(key, response);
    audit.record({ action: "finance.transaction.create", actor: actorFrom(auth), tenant, resource: transaction.id, requestId });
    await publish.publish({ eventType: "finance.transaction.created", payload: { transactionId: transaction.id, accountId: account.id, amountCents: transaction.amountCents, currency: account.currency }, actor: actorFrom(auth), ...tenant, aggregate: { type: "finance_transaction", id: transaction.id } });
    return response;
  }
  if (url.pathname === "/internal/audit" && req.method === "GET") return { status: 200, body: { items: audit.list() } };
  return { status: 404, body: { error: "Route not found", code: "NOT_FOUND" } };
}

createServiceServer({
  service: "finance",
  displayName: "Finance / RYFT",
  port: Number(process.env.PORT ?? 8101),
  routePrefixes: ["/api/finance"],
  handle,
  authenticate: createConfiguredAuthenticator({ service: "finance", required: process.env.FINANCE_AUTH_REQUIRED === "true" }),
  domain: "finance",
  owner: "RYFT",
  ownedResources: ["finance_accounts", "finance_transactions", "finance_ledger", "finance_audit"],
  // AK4 Phase 2, finding 2c — "finance.transaction.updated" removed.
  // services/finance has no PATCH/PUT route: transactions are create-only,
  // and this service's own rollbackStrategy below already states the
  // design intent explicitly — committed ledger entries are never
  // reversed. That is a target-state accounting decision (corrections are
  // meant to happen via a new reversing/adjusting transaction, standard
  // ledger practice), not just an unimplemented route, so this correction
  // also removes the entry from packages/domain-boundaries' finance
  // contract rather than leaving it there as an aspirational future
  // event. See docs/changes/CHANGES_AK4_PHASE2_EVENT_WIRING_DECISIONS.md.
  emittedEvents: ["finance.transaction.created"],
  rollbackStrategy: "disable FINANCE_SERVICE_URL; never reverse committed ledger entries",
  dependencies: { configuration: true, ledger: true, eventBus: true },
}).start();