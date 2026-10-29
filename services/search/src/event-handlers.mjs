import { createServiceRequestHeaders } from "@ayzen/auth-client";

/**
 * Phase H7.3 — before this, `wisp.message.sent` and `finance.transaction.created`
 * had no consumer at all for search: the worker's dispatch table (H7.1)
 * acknowledged them without indexing anything, because both events' payloads
 * carry only an ID (`messageId` / `transactionId`), never the subject/body or
 * description search would actually need to index — and the worker, a
 * separate process with no DB access of its own to mail's or finance's
 * tables, has no way to get that content.
 *
 * search is in a different position: it's the service that owns the index,
 * so once it has the real content it can call `indexDocument` directly,
 * in-process — no HTTP hop back to its own POST /api/search/documents route.
 * Getting the content in the first place still means a real HTTP call to
 * mail or finance (there is no shared DB to read across services), so this
 * module makes exactly that one call, then indexes locally.
 */

async function callInternalService({ url, path, requestId, service, secret, fetchImpl = fetch }) {
  if (!url) {
    const error = new Error(`No service URL configured for internal call to ${path}`);
    error.code = "SERVICE_URL_NOT_CONFIGURED";
    throw error;
  }
  const headers = {};
  if (secret) Object.assign(headers, createServiceRequestHeaders({ service, requestId, body: undefined, secret }));
  const response = await fetchImpl(`${url.replace(/\/+$/, "")}${path}`, { method: "GET", headers });
  if (response.status === 404) return undefined;
  if (!response.ok) {
    const error = new Error(`${path} returned ${response.status}`);
    error.code = "INTERNAL_SERVICE_CALL_FAILED";
    throw error;
  }
  return response.json();
}

function tenantOf(event) {
  return { organizationId: event.organizationId, workspaceId: event.workspaceId };
}

function actorOf(event) {
  return event.actor;
}

/**
 * @param indexDocument   from createDocumentIndexer (./indexing.mjs)
 * @param mailServiceUrl  base URL for mail's GET /api/mail/messages/:id
 * @param financeServiceUrl base URL for finance's GET
 *   /api/finance/accounts/:accountId/transactions/:transactionId
 * @param serviceAuthSecret shared secret for signed internal service-to-service calls
 */
export function createSearchEventHandlers({
  indexDocument,
  mailServiceUrl,
  financeServiceUrl,
  serviceAuthSecret,
  fetchImpl = fetch,
}) {
  if (typeof indexDocument !== "function") throw new Error("indexDocument is required");

  async function onMessageSent(event) {
    const messageId = event.payload?.messageId;
    if (!messageId) return { skipped: true };
    const message = await callInternalService({
      url: mailServiceUrl,
      path: `/api/mail/messages/${messageId}`,
      requestId: event.eventId,
      service: "search",
      secret: serviceAuthSecret,
      fetchImpl,
    });
    // The message may since have been deleted, or mail may be temporarily
    // unreachable — either way there's nothing to index yet, and this
    // shouldn't fabricate a document out of the bare ID.
    if (!message) return { skipped: true };
    indexDocument({
      sourceId: message.id,
      title: message.subject,
      content: message.body,
      tenant: tenantOf(event),
      actor: actorOf(event),
    });
    return { skipped: false };
  }

  async function onTransactionCreated(event) {
    const transactionId = event.payload?.transactionId;
    const accountId = event.payload?.accountId;
    if (!transactionId || !accountId) return { skipped: true };
    const transaction = await callInternalService({
      url: financeServiceUrl,
      path: `/api/finance/accounts/${accountId}/transactions/${transactionId}`,
      requestId: event.eventId,
      service: "search",
      secret: serviceAuthSecret,
      fetchImpl,
    });
    if (!transaction) return { skipped: true };
    indexDocument({
      sourceId: transaction.id,
      title: transaction.description,
      content: `${transaction.description} (${transaction.amountCents} ${transaction.currency ?? ""})`.trim(),
      tenant: tenantOf(event),
      actor: actorOf(event),
    });
    return { skipped: false };
  }

  return Object.freeze({
    "wisp.message.sent": onMessageSent,
    "finance.transaction.created": onTransactionCreated,
  });
}
