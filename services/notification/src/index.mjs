import crypto from "node:crypto";
import {
  createAuditLog,
  createConfiguredAuthenticator,
  createServiceServer,
  readJsonBody,
  tenantScopeFromHeaders,
  requireTenantScope,
} from "@ayzen/service-runtime";
import { createHttpEnvelopeTransport } from "@ayzen/event-client";
import { createTransactionalEventPublisher } from "@ayzen/outbox";
import { createIdempotencyKey } from "@ayzen/contracts";
import { createSharedIdempotencyStore } from "@ayzen/idempotency";
import { createPostgresQuery, createStateStore } from "@ayzen/service-state";
import { createNotificationPolicy } from "../policy/index.mjs";
import { createHttpProvider, createProviderRegistry } from "../providers/index.mjs";

// Phase H6.2: durable, Postgres-backed state instead of a plain
// Map() that a restart/redeploy would wipe. Falls back to an
// in-memory Map only when ALLOW_SERVICE_MEMORY_STORE=true (local dev);
// otherwise a missing DATABASE_URL is a boot-time error, not a silent
// data-loss risk.
const dbQuery = await createPostgresQuery();
const allowMemoryState = process.env.ALLOW_SERVICE_MEMORY_STORE === "true";
const notifications = await createStateStore({ service: "notification", collection: "notifications", query: dbQuery, allowMemoryFallback: allowMemoryState });
const preferences = await createStateStore({ service: "notification", collection: "preferences", query: dbQuery, allowMemoryFallback: allowMemoryState });
const quotas = await createStateStore({ service: "notification", collection: "quotas", query: dbQuery, allowMemoryFallback: allowMemoryState });
const quotaUsage = new Map();
// Phase H6.3: Postgres-backed (via the same dbQuery pool as the state
// stores above), so a replayed idempotency key is honored no matter which
// replica handles the retry, instead of only the one that saw the original.
const idempotency = await createSharedIdempotencyStore({ service: "notification", query: dbQuery, allowMemoryFallback: allowMemoryState });
const audit = createAuditLog({ service: "notification" });
const policy = createNotificationPolicy({ preferences, quotas });
const providers = createProviderRegistry({
  providers: {
    "in-app": {
      async send() {
        return { delivered: true };
      },
    },
    email: createHttpProvider({ channel: "email", urlEnv: "NOTIFICATION_EMAIL_PROVIDER_URL" }),
    telegram: createHttpProvider({ channel: "telegram", urlEnv: "NOTIFICATION_TELEGRAM_PROVIDER_URL" }),
    webhook: createHttpProvider({ channel: "webhook", urlEnv: "NOTIFICATION_WEBHOOK_PROVIDER_URL" }),
  },
});

function seedPolicyStore(store, raw) {
  if (!raw) return;
  try {
    for (const [key, value] of Object.entries(JSON.parse(raw))) if (!store.has(key)) store.set(key, value);
  } catch (error) {
    throw new Error(`Invalid notification policy configuration: ${error.message}`);
  }
}

seedPolicyStore(preferences, process.env.NOTIFICATION_PREFERENCES_JSON);
seedPolicyStore(quotas, process.env.NOTIFICATION_QUOTAS_JSON);
// Phase H6.1: publish through the transactional outbox so the state
// write above and this event either both happen or neither does,
// instead of a bare HTTP publish that can fall out of sync with state
// on a crash or network blip between the two.
const publish = createTransactionalEventPublisher({ service: "notification", transport: createHttpEnvelopeTransport({ service: "notification" }) });

function actorFrom(auth) {
  return auth ? { subject: auth.sub ?? auth.subject, actorType: auth.actorType ?? "user" } : undefined;
}

// Audit finding (event/workflow/notification/scheduler/policy wiring pass):
// `notification.sent`/`notification.failed` were declared in emittedEvents
// (here, in @ayzen/events' EVENT_TYPES, and in @ayzen/domain-boundaries)
// with no publish() call anywhere in the repo for either — every
// notification was created "queued" and left there forever; GET
// /api/notifications never reported anything but "queued", the same
// stale-status bug H7.5's doc describes for workflow_executions before
// that fix. Unlike workflow's case, there is no other process anywhere
// in this repo that ever decides a notification's outcome, so the fix
// has to live here, at creation time, not as a subscriber elsewhere.
//
// This repo has no real outbound channel adapter (no SMTP/SES/FCM/APNs
// client anywhere in packages/ or services/ — checked before writing
// this). "in-app" is the one channel this service can honestly deliver
// itself, since delivery for it is nothing more than the record existing
// for GET /api/notifications to return — so only that channel resolves
// to "sent". Any other channel fails loudly with a real, specific code
// instead of being silently marked "sent" for a delivery that never
// happened; that mirrors apps/worker's own acknowledgeOnly() honesty
// convention (H7.1) rather than fabricating a delivery this service
// cannot actually perform.
async function deliver(notification, actor, tenant, requestId) {
  const timestamp = new Date().toISOString();
  let outcome;
  if (!policy.allows({ recipient: notification.recipient, channel: notification.channel })) {
    outcome = { ...notification, status: "failed", failedAt: timestamp, error: "Recipient has disabled this notification channel", code: "NOTIFICATION_RECIPIENT_OPTED_OUT" };
  } else {
    const provider = providers.get(notification.channel);
    if (!provider) {
      outcome = { ...notification, status: "failed", failedAt: timestamp, error: `No delivery adapter configured for channel "${notification.channel}"`, code: "NOTIFICATION_CHANNEL_NOT_CONFIGURED" };
    } else {
      const quota = policy.quotaFor({ app: notification.app, channel: notification.channel });
      const quotaKey = `${notification.app}:${notification.channel}:${notification.recipient}`;
      const nowMs = Date.now();
      const current = quotaUsage.get(quotaKey);
      const windowMs = Number(quota?.windowMs) > 0 ? Number(quota.windowMs) : 86_400_000;
      const usage = !current || nowMs - current.startedAt >= windowMs ? { startedAt: nowMs, count: 0 } : current;
      if (Number.isFinite(Number(quota?.limit)) && usage.count >= Number(quota.limit)) {
        outcome = { ...notification, status: "failed", failedAt: timestamp, error: "Notification quota exceeded", code: "NOTIFICATION_QUOTA_EXCEEDED" };
      } else {
        try {
          await provider.send({ notification, actor, tenant, requestId });
          usage.count += 1;
          quotaUsage.set(quotaKey, usage);
          outcome = { ...notification, status: "sent", sentAt: timestamp };
        } catch (error) {
          outcome = {
            ...notification,
            status: "failed",
            failedAt: timestamp,
            error: error instanceof Error ? error.message : String(error),
            code: error?.code ?? "NOTIFICATION_PROVIDER_FAILED",
          };
        }
      }
    }
  }
  notifications.set(notification.id, outcome);
  audit.record({ action: `notification.${outcome.status}`, actor, tenant, resource: notification.id, requestId, metadata: { channel: notification.channel } });
  await publish.publish({
    eventType: outcome.status === "sent" ? "notification.sent" : "notification.failed",
    payload: outcome.status === "sent"
      ? { notificationId: notification.id, channel: notification.channel }
      : { notificationId: notification.id, channel: notification.channel, code: outcome.code },
    actor,
    ...tenant,
    aggregate: { type: "notification", id: notification.id },
  });
  return outcome;
}

async function handle({ req, url, requestId, auth }) {
  if (url.pathname === "/api/notifications" && req.method === "GET") {
    const tenant = tenantScopeFromHeaders(req.headers, { auth });
    return { status: 200, body: { items: [...notifications.values()].filter((item) => (!tenant.workspaceId || item.workspaceId === tenant.workspaceId) && (!tenant.organizationId || item.organizationId === tenant.organizationId)) } };
  }
  if (url.pathname === "/api/notifications" && req.method === "POST") {
    const body = await readJsonBody(req);
    const tenant = tenantScopeFromHeaders(req.headers, { auth });
    requireTenantScope(tenant);
    if (body.tenant && JSON.stringify(body.tenant) !== JSON.stringify(tenant)) {
      return { status: 400, body: { error: "Notification tenant must come from verified request context", code: "TENANT_OVERRIDE_REJECTED" } };
    }
    const key = req.headers["idempotency-key"];
    const normalizedKey = key ? createIdempotencyKey({ scope: "notification", key }) : undefined;
    const previous = await idempotency.get(normalizedKey);
    if (previous) return previous;
    if (!body.recipient || !body.template) return { status: 400, body: { error: "recipient and template are required", code: "INVALID_NOTIFICATION" } };
    const notification = {
      id: crypto.randomUUID(),
      status: "queued",
      app: body.app ?? "default",
      recipient: body.recipient,
      template: body.template,
      channel: body.channel ?? "in-app",
      data: body.data ?? {},
      ...tenant,
      createdAt: new Date().toISOString(),
    };
    notifications.set(notification.id, notification);
    const actor = actorFrom(auth);
    audit.record({ action: "notification.create", actor, tenant, resource: notification.id, requestId });
    await publish.publish({ eventType: "notification.requested", payload: { notificationId: notification.id, channel: notification.channel, recipient: notification.recipient }, actor, ...tenant, aggregate: { type: "notification", id: notification.id } });
    const delivered = await deliver(notification, actor, tenant, requestId);
    const response = { status: 202, body: delivered };
    await idempotency.set(normalizedKey, response);
    return response;
  }
  if (url.pathname === "/internal/notification-policy/preferences" && req.method === "PUT") {
    const body = await readJsonBody(req);
    if (!body.recipient || !Array.isArray(body.disabledChannels)) return { status: 400, body: { error: "recipient and disabledChannels are required", code: "INVALID_NOTIFICATION_PREFERENCE" } };
    preferences.set(body.recipient, { disabledChannels: [...new Set(body.disabledChannels)] });
    return { status: 200, body: { recipient: body.recipient, disabledChannels: preferences.get(body.recipient).disabledChannels } };
  }
  if (url.pathname === "/internal/notification-policy/quotas" && req.method === "PUT") {
    const body = await readJsonBody(req);
    const key = body.app && body.channel ? `${body.app}:${body.channel}` : body.app;
    if (!key || !Number.isSafeInteger(body.limit) || body.limit < 0 || !Number.isSafeInteger(body.windowMs) || body.windowMs < 1) return { status: 400, body: { error: "app, channel, non-negative limit, and positive windowMs are required", code: "INVALID_NOTIFICATION_QUOTA" } };
    quotas.set(key, { limit: body.limit, windowMs: body.windowMs });
    return { status: 200, body: { key, ...quotas.get(key) } };
  }
  if (url.pathname === "/internal/audit" && req.method === "GET") return { status: 200, body: { items: audit.list() } };
  return { status: 404, body: { error: "Route not found", code: "NOT_FOUND" } };
}

createServiceServer({
  service: "notification",
  displayName: "Notification",
  port: Number(process.env.PORT ?? 8104),
  routePrefixes: ["/api/notifications"],
  handle,
  authenticate: createConfiguredAuthenticator({ service: "notification" }),
  domain: "notification",
  owner: "Notification",
  ownedResources: ["notification_templates", "notification_preferences", "notification_deliveries"],
  emittedEvents: ["notification.requested", "notification.sent", "notification.failed"],
  consumedEvents: ["finance.transaction.created", "wisp.message.received", "workflow.completed"],
  rollbackStrategy: "disable NOTIFICATION_SERVICE_URL and replay outbox events",
  dependencies: { configuration: true, eventBus: true },
}).start();