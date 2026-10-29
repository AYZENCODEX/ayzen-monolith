import crypto from "node:crypto";

// AK4 Phase 2, finding 2a — see docs/changes/CHANGES_AK4_PHASE2_EVENT_WIRING_DECISIONS.md.
//
// `wisp.message.received` had real, working consumers (notification,
// workflow — see apps/worker/src/index.mjs's registry.register calls) and
// no producer anywhere: a fully wired pipeline reacting to nothing. This
// module is the producer — an inbound-mail-receive path — closing the gap
// rather than deleting the consumer side, since the roadmap flagged this
// as the one finding of the five with real downstream code already
// depending on the event actually firing.
//
// This is a webhook target for an external mail provider (inbound-parse /
// IMAP-bridge style), not an AYZEN-authenticated caller, so it cannot use
// `createConfiguredAuthenticator`'s JWT/service-signature scheme the rest
// of this service's routes use — an external provider has no AYZEN
// identity to present. It is deliberately NOT registered in
// `@ayzen/capabilities`' CAPABILITY_REGISTRY for the same reason: that
// registry models AYZEN-scoped user/service actions, and this route has
// neither a user nor an internal service on the other end. Trust is
// established with a single shared secret instead, checked in constant
// time, the same posture `@ayzen/auth-client`'s verifyServiceSignature
// uses for its own comparison. Fails closed: no configured secret means
// the route refuses everything rather than accepting unauthenticated
// inbound mail.

export function verifyInboundWebhookSecret(headers = {}, { secret } = {}) {
  if (!secret) return { ok: false, code: "MAIL_INBOUND_WEBHOOK_NOT_CONFIGURED" };
  const provided = headers["x-ayzen-mail-webhook-secret"];
  if (typeof provided !== "string" || !provided) return { ok: false, code: "MAIL_INBOUND_WEBHOOK_UNAUTHORIZED" };
  const providedBytes = Buffer.from(provided);
  const secretBytes = Buffer.from(secret);
  const ok = providedBytes.length === secretBytes.length && crypto.timingSafeEqual(providedBytes, secretBytes);
  return ok ? { ok: true } : { ok: false, code: "MAIL_INBOUND_WEBHOOK_UNAUTHORIZED" };
}

export function validateInboundPayload(body = {}) {
  if (!body.mailbox || !body.from || !body.subject || typeof body.body !== "string") {
    return { valid: false, error: "mailbox, from, subject and body are required", code: "INVALID_INBOUND_MESSAGE" };
  }
  if (!body.providerMessageId || typeof body.providerMessageId !== "string") {
    // Providers retry webhook delivery on anything short of a 2xx; without
    // their message id to key idempotency on, a retried delivery would be
    // recorded as a second, distinct inbound message.
    return { valid: false, error: "providerMessageId is required for delivery-retry idempotency", code: "INVALID_INBOUND_MESSAGE" };
  }
  return { valid: true };
}

export function buildInboundMessage(body, tenant) {
  return {
    id: crypto.randomUUID(),
    mailbox: body.mailbox,
    folder: "inbox",
    direction: "inbound",
    status: "received",
    to: [body.mailbox],
    cc: [],
    from: body.from,
    subject: body.subject,
    body: body.body,
    threadId: body.threadId ?? crypto.randomUUID(),
    providerMessageId: body.providerMessageId,
    ...tenant,
    createdAt: new Date().toISOString(),
  };
}
