import test from "node:test";
import assert from "node:assert/strict";
import { verifyInboundWebhookSecret, validateInboundPayload, buildInboundMessage } from "./inbound.mjs";

test("AK4 2a: verifyInboundWebhookSecret fails closed when no secret is configured", () => {
  const result = verifyInboundWebhookSecret({ "x-ayzen-mail-webhook-secret": "anything" }, { secret: undefined });
  assert.equal(result.ok, false);
  assert.equal(result.code, "MAIL_INBOUND_WEBHOOK_NOT_CONFIGURED");
});

test("AK4 2a: verifyInboundWebhookSecret rejects a missing header", () => {
  const result = verifyInboundWebhookSecret({}, { secret: "topsecret" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "MAIL_INBOUND_WEBHOOK_UNAUTHORIZED");
});

test("AK4 2a: verifyInboundWebhookSecret rejects a wrong secret", () => {
  const result = verifyInboundWebhookSecret({ "x-ayzen-mail-webhook-secret": "wrong" }, { secret: "topsecret" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "MAIL_INBOUND_WEBHOOK_UNAUTHORIZED");
});

test("AK4 2a: verifyInboundWebhookSecret accepts a matching secret", () => {
  const result = verifyInboundWebhookSecret({ "x-ayzen-mail-webhook-secret": "topsecret" }, { secret: "topsecret" });
  assert.equal(result.ok, true);
});

test("AK4 2a: validateInboundPayload requires mailbox/from/subject/body", () => {
  const result = validateInboundPayload({ from: "a@b.com", subject: "hi", body: "hello", providerMessageId: "p1" });
  assert.equal(result.valid, false);
  assert.equal(result.code, "INVALID_INBOUND_MESSAGE");
});

test("AK4 2a: validateInboundPayload requires providerMessageId for retry idempotency", () => {
  const result = validateInboundPayload({ mailbox: "inbox@ayzen", from: "a@b.com", subject: "hi", body: "hello" });
  assert.equal(result.valid, false);
  assert.match(result.error, /providerMessageId/);
});

test("AK4 2a: validateInboundPayload accepts a complete payload", () => {
  const result = validateInboundPayload({ mailbox: "inbox@ayzen", from: "a@b.com", subject: "hi", body: "hello", providerMessageId: "p1" });
  assert.equal(result.valid, true);
});

test("AK4 2a: buildInboundMessage produces an inbox-folder, inbound-direction message", () => {
  const message = buildInboundMessage(
    { mailbox: "inbox@ayzen", from: "a@b.com", subject: "hi", body: "hello", providerMessageId: "p1" },
    { workspaceId: "ws-1" },
  );
  assert.equal(message.folder, "inbox");
  assert.equal(message.direction, "inbound");
  assert.equal(message.status, "received");
  assert.equal(message.mailbox, "inbox@ayzen");
  assert.equal(message.workspaceId, "ws-1");
  assert.ok(message.id);
  assert.ok(message.threadId);
});

test("AK4 2a: buildInboundMessage preserves a provider-supplied threadId", () => {
  const message = buildInboundMessage(
    { mailbox: "inbox@ayzen", from: "a@b.com", subject: "hi", body: "hello", providerMessageId: "p1", threadId: "thread-1" },
    {},
  );
  assert.equal(message.threadId, "thread-1");
});
