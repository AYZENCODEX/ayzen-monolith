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
import { verifyInboundWebhookSecret, validateInboundPayload, buildInboundMessage } from "./inbound.mjs";

// Phase H6.2: durable, Postgres-backed state instead of a plain
// Map() that a restart/redeploy would wipe. Falls back to an
// in-memory Map only when ALLOW_SERVICE_MEMORY_STORE=true (local dev);
// otherwise a missing DATABASE_URL is a boot-time error, not a silent
// data-loss risk.
const dbQuery = await createPostgresQuery();
const allowMemoryState = process.env.ALLOW_SERVICE_MEMORY_STORE === "true";
const messages = await createStateStore({ service: "mail", collection: "messages", query: dbQuery, allowMemoryFallback: allowMemoryState });
const mailboxPermissions = await createStateStore({ service: "mail", collection: "mailbox_permissions", query: dbQuery, allowMemoryFallback: allowMemoryState });
// Phase H6.3: Postgres-backed (via the same dbQuery pool as the state
// stores above), so a replayed idempotency key is honored no matter which
// replica handles the retry, instead of only the one that saw the original.
const idempotency = await createSharedIdempotencyStore({ service: "mail", query: dbQuery, allowMemoryFallback: allowMemoryState });
const audit = createAuditLog({ service: "mail" });
// Phase H6.1: publish through the transactional outbox so the state
// write above and this event either both happen or neither does,
// instead of a bare HTTP publish that can fall out of sync with state
// on a crash or network blip between the two.
const publish = createTransactionalEventPublisher({ service: "mail", transport: createHttpEnvelopeTransport({ service: "mail" }) });
// AK4 Phase 2, finding 2a — see ./inbound.mjs and
// docs/changes/CHANGES_AK4_PHASE2_EVENT_WIRING_DECISIONS.md. No default:
// an unset secret means the inbound route refuses every request rather
// than accepting unauthenticated mail from the open internet.
const inboundWebhookSecret = process.env.MAIL_INBOUND_WEBHOOK_SECRET;

function visibleToTenant(message, tenant) {
  return (!tenant.workspaceId || message.workspaceId === tenant.workspaceId)
    && (!tenant.organizationId || message.organizationId === tenant.organizationId);
}

function sanitizeAttachments(attachments) {
  if (attachments === undefined) return [];
  if (!Array.isArray(attachments)) throw Object.assign(new Error("attachments must be an array of metadata"), { code: "INVALID_ATTACHMENTS" });
  return attachments.map((attachment) => {
    if (!attachment || typeof attachment.name !== "string" || !attachment.name.trim()) {
      throw Object.assign(new Error("Each attachment requires a name"), { code: "INVALID_ATTACHMENTS" });
    }
    if (!Number.isSafeInteger(attachment.size) || attachment.size < 0) {
      throw Object.assign(new Error("Each attachment requires a non-negative size"), { code: "INVALID_ATTACHMENTS" });
    }
    return {
      id: attachment.id ?? crypto.randomUUID(),
      name: attachment.name.trim(),
      mimeType: typeof attachment.mimeType === "string" ? attachment.mimeType : "application/octet-stream",
      size: attachment.size,
      storageKey: typeof attachment.storageKey === "string" ? attachment.storageKey : undefined,
    };
  });
}

function actorFrom(auth) {
  return auth ? { subject: auth.sub ?? auth.subject ?? auth.userId, actorType: auth.actorType ?? "user" } : undefined;
}

async function handle({ req, url, requestId, auth }) {
  const tenant = tenantScopeFromHeaders(req.headers);
  if (url.pathname === "/api/mail/messages" && req.method === "GET") {
    const folder = url.searchParams.get("folder");
    const mailbox = url.searchParams.get("mailbox");
    const threadId = url.searchParams.get("threadId");
    const unread = url.searchParams.get("unread");
    const items = [...messages.values()].filter((message) => visibleToTenant(message, tenant)
      && (!folder || message.folder === folder)
      && (!mailbox || message.mailbox === mailbox)
      && (!threadId || message.threadId === threadId)
      && (unread !== "true" || !message.readAt));
    return { status: 200, body: { items } };
  }
  // Phase H7.3: search needs to fetch a message's real subject/body by ID
  // before it can index anything more meaningful than the bare messageId
  // the wisp.message.sent event payload carries. This is the read side of
  // that lookup.
  const messageReadMatch = url.pathname.match(/^\/api\/mail\/messages\/([^/]+)$/);
  if (messageReadMatch && req.method === "GET") {
    const message = messages.get(messageReadMatch[1]);
    if (!message) return { status: 404, body: { error: "Message not found", code: "MESSAGE_NOT_FOUND" } };
    if (message.workspaceId && tenant.workspaceId && message.workspaceId !== tenant.workspaceId) return { status: 403, body: { error: "Tenant isolation failed", code: "TENANT_MISMATCH" } };
    return { status: 200, body: message };
  }
  const threadMatch = url.pathname.match(/^\/api\/mail\/threads\/([^/]+)$/);
  if (threadMatch && req.method === "GET") {
    const items = [...messages.values()].filter((message) => visibleToTenant(message, tenant) && message.threadId === threadMatch[1]);
    return { status: 200, body: { threadId: threadMatch[1], items } };
  }
  if (url.pathname === "/api/mail/search" && req.method === "GET") {
    const query = url.searchParams.get("q")?.trim().toLowerCase();
    if (!query) return { status: 400, body: { error: "q is required", code: "INVALID_QUERY" } };
    const terms = query.split(/\s+/).filter(Boolean);
    const items = [...messages.values()]
      .filter((message) => visibleToTenant(message, tenant))
      .map((message) => {
        const haystack = [message.subject, message.body, message.from, ...(message.to ?? []), ...(message.labels ?? [])].join(" ").toLowerCase();
        return { message, score: terms.filter((term) => haystack.includes(term)).length };
      })
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, 50)
      .map(({ message, score }) => ({ ...message, score }));
    return { status: 200, body: { query, items } };
  }
  if ((url.pathname === "/api/mail/messages" || url.pathname === "/api/mail/drafts") && req.method === "POST") {
    const body = await readJsonBody(req);
    const key = req.headers["idempotency-key"];
    const normalizedKey = key ? createIdempotencyKey({ scope: "mail", key }) : undefined;
    const previous = await idempotency.get(normalizedKey);
    if (previous) return previous;
    const isDraft = url.pathname === "/api/mail/drafts";
    if ((!isDraft && !body.to) || !body.subject || typeof body.body !== "string") {
      return { status: 400, body: { error: isDraft ? "subject and body are required" : "to, subject and body are required", code: "INVALID_MESSAGE" } };
    }
    const attachments = sanitizeAttachments(body.attachments);
    const message = {
      id: crypto.randomUUID(),
      mailbox: body.mailbox ?? "inbox",
      folder: isDraft ? "drafts" : (body.folder ?? "sent"),
      status: isDraft ? "draft" : "queued",
      to: body.to ?? [],
      cc: body.cc ?? [],
      bcc: body.bcc ?? [],
      from: body.from,
      subject: body.subject,
      body: body.body,
      threadId: body.threadId ?? crypto.randomUUID(),
      labels: Array.isArray(body.labels) ? [...new Set(body.labels.filter((label) => typeof label === "string"))] : [],
      attachments,
      ...tenant,
      createdAt: new Date().toISOString(),
    };
    messages.set(message.id, message);
    const response = { status: 202, body: message };
    await idempotency.set(normalizedKey, response);
    const actor = actorFrom(auth);
    audit.record({ action: isDraft ? "mail.draft.create" : "mail.message.create", actor, tenant, resource: message.id, requestId });
    if (!isDraft) {
      await publish.publish({ eventType: "wisp.message.sent", payload: { messageId: message.id, threadId: message.threadId, recipientCount: [message.to, ...message.cc, ...message.bcc].length }, actor, ...tenant, aggregate: { type: "mail_message", id: message.id } });
      await publish.publish({ eventType: "mail.delivery.requested", payload: { messageId: message.id }, actor, ...tenant, aggregate: { type: "mail_message", id: message.id } });
    }
    return response;
  }
  const messageActionMatch = url.pathname.match(/^\/api\/mail\/messages\/([^/]+)$/);
  if (messageActionMatch && req.method === "PATCH") {
    const message = messages.get(messageActionMatch[1]);
    if (!message) return { status: 404, body: { error: "Message not found", code: "MESSAGE_NOT_FOUND" } };
    if (!visibleToTenant(message, tenant)) return { status: 403, body: { error: "Tenant isolation failed", code: "TENANT_MISMATCH" } };
    const body = await readJsonBody(req);
    const allowedFolders = new Set(["inbox", "sent", "drafts", "archive", "trash", "spam"]);
    if (body.folder !== undefined && !allowedFolders.has(body.folder)) return { status: 400, body: { error: "Unsupported mail folder", code: "INVALID_FOLDER" } };
    if (body.labels !== undefined && (!Array.isArray(body.labels) || body.labels.some((label) => typeof label !== "string"))) return { status: 400, body: { error: "labels must be an array of strings", code: "INVALID_LABELS" } };
    const updated = {
      ...message,
      ...(body.folder !== undefined ? { folder: body.folder } : {}),
      ...(body.labels !== undefined ? { labels: [...new Set(body.labels)] } : {}),
      ...(body.read === true ? { readAt: new Date().toISOString() } : {}),
      ...(body.read === false ? { readAt: undefined } : {}),
      updatedAt: new Date().toISOString(),
    };
    messages.set(updated.id, updated);
    audit.record({ action: "mail.message.update", actor: actorFrom(auth), tenant, resource: updated.id, requestId, metadata: { folder: updated.folder, read: Boolean(updated.readAt) } });
    return { status: 200, body: updated };
  }
  // AK4 Phase 2, finding 2a — the inbound side of wisp.message.received.
  // See ./inbound.mjs's header for why this checks a shared webhook
  // secret instead of going through `auth` (the request has no AYZEN
  // identity to authenticate) and is deliberately unregistered in
  // @ayzen/capabilities.
  if (url.pathname === "/api/mail/messages/receive" && req.method === "POST") {
    const secretCheck = verifyInboundWebhookSecret(req.headers, { secret: inboundWebhookSecret });
    if (!secretCheck.ok) {
      const status = secretCheck.code === "MAIL_INBOUND_WEBHOOK_NOT_CONFIGURED" ? 503 : 401;
      return { status, body: { error: "Inbound mail webhook rejected the request", code: secretCheck.code } };
    }
    const body = await readJsonBody(req);
    const validation = validateInboundPayload(body);
    if (!validation.valid) return { status: 400, body: { error: validation.error, code: validation.code } };
    const normalizedKey = createIdempotencyKey({ scope: "mail-inbound", key: body.providerMessageId });
    const previous = await idempotency.get(normalizedKey);
    if (previous) return previous;
    const message = buildInboundMessage(body, tenant);
    messages.set(message.id, message);
    const response = { status: 202, body: message };
    await idempotency.set(normalizedKey, response);
    audit.record({ action: "mail.message.receive", tenant, resource: message.id, requestId, metadata: { providerMessageId: body.providerMessageId } });
    await publish.publish({ eventType: "wisp.message.received", payload: { messageId: message.id, threadId: message.threadId, mailbox: message.mailbox, from: message.from, recipientCount: 1 }, ...tenant, aggregate: { type: "mail_message", id: message.id } });
    return response;
  }
  const permissionMatch = url.pathname.match(/^\/api\/mail\/mailboxes\/([^/]+)\/permissions$/);
  if (permissionMatch && req.method === "GET") {
    const permission = mailboxPermissions.get(permissionMatch[1]) ?? { mailbox: permissionMatch[1], readers: [], writers: [] };
    return { status: 200, body: permission };
  }
  if (permissionMatch && req.method === "PUT") {
    const body = await readJsonBody(req);
    if (!Array.isArray(body.readers) || !Array.isArray(body.writers) || [...body.readers, ...body.writers].some((item) => typeof item !== "string" || !item.trim())) {
      return { status: 400, body: { error: "readers and writers must be arrays of subject identifiers", code: "INVALID_MAILBOX_PERMISSIONS" } };
    }
    const permission = {
      mailbox: permissionMatch[1],
      readers: [...new Set(body.readers)],
      writers: [...new Set(body.writers)],
      updatedAt: new Date().toISOString(),
      updatedBy: actorFrom(auth)?.subject,
    };
    mailboxPermissions.set(permission.mailbox, permission);
    audit.record({ action: "mail.mailbox.permissions.update", actor: actorFrom(auth), tenant, resource: permission.mailbox, requestId });
    return { status: 200, body: permission };
  }
  if (url.pathname === "/internal/audit" && req.method === "GET") return { status: 200, body: { items: audit.list() } };
  return { status: 404, body: { error: "Route not found", code: "NOT_FOUND" } };
}

createServiceServer({
  service: "mail",
  displayName: "WISP Mailbox",
  port: Number(process.env.PORT ?? 8103),
  routePrefixes: ["/api/mail"],
  handle,
  authenticate: createConfiguredAuthenticator({ service: "mail" }),
  domain: "mail",
  owner: "WISP",
  ownedResources: ["mailboxes", "mail_messages", "mail_threads", "mail_attachments"],
  // AK4 Phase 2, finding 2b — "mail.delivery.updated" removed. No
  // delivery-status-update mechanism exists anywhere in this service (no
  // provider webhook, no poll), so the declaration was a claim about
  // nothing the running code does. Unlike 2a's wisp.message.received,
  // nothing consumes this type either, so there is no dead-pipeline risk
  // on the other side — just an inaccurate manifest entry. Whether to
  // build a real delivery-status mechanism (provider webhook vs. poll) is
  // still an open product decision; see
  // docs/changes/CHANGES_AK4_PHASE2_EVENT_WIRING_DECISIONS.md. The type
  // stays registered in @ayzen/events (packages/events) since it remains
  // a legitimate future event, just not one this service emits today.
  emittedEvents: ["wisp.message.received", "wisp.message.sent", "mail.delivery.requested"],
  rollbackStrategy: "disable WISP_SERVICE_URL and drain compatibility mailbox path",
  dependencies: { configuration: true, mailboxStorage: true, eventBus: true },
}).start();