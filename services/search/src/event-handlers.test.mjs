import test from "node:test";
import assert from "node:assert/strict";
import { createSearchEventHandlers } from "./event-handlers.mjs";

function fakeFetch(responses) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    const match = responses.find((entry) => url.includes(entry.path));
    if (!match) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: match.status < 400, status: match.status, json: async () => match.body };
  };
  impl.calls = calls;
  return impl;
}

test("wisp.message.sent: fetches the real message from mail, then indexes in-process", async () => {
  const indexed = [];
  const fetchImpl = fakeFetch([{ path: "/api/mail/messages/msg-1", status: 200, body: { id: "msg-1", subject: "Q3 renewal", body: "Your plan renews in Q3." } }]);
  const handlers = createSearchEventHandlers({
    indexDocument: (doc) => indexed.push(doc),
    mailServiceUrl: "http://mail.internal",
    financeServiceUrl: "http://finance.internal",
    serviceAuthSecret: "s3cr3t",
    fetchImpl,
  });

  const outcome = await handlers["wisp.message.sent"]({ eventId: "evt-1", payload: { messageId: "msg-1" }, organizationId: "org-1", workspaceId: "ws-1" });

  assert.equal(outcome.skipped, false);
  assert.equal(indexed.length, 1);
  assert.equal(indexed[0].sourceId, "msg-1");
  assert.equal(indexed[0].title, "Q3 renewal");
  assert.equal(indexed[0].content, "Your plan renews in Q3.");
  assert.deepEqual(indexed[0].tenant, { organizationId: "org-1", workspaceId: "ws-1" });
  assert.equal(fetchImpl.calls.length, 1);
  assert.ok(fetchImpl.calls[0].url.endsWith("/api/mail/messages/msg-1"));
  assert.equal(fetchImpl.calls[0].options.method, "GET");
  assert.ok(fetchImpl.calls[0].options.headers["x-ayzen-signature"]);
});

test("finance.transaction.created: fetches the real transaction from finance, then indexes in-process", async () => {
  const indexed = [];
  const fetchImpl = fakeFetch([{ path: "/api/finance/accounts/acc-1/transactions/txn-1", status: 200, body: { id: "txn-1", accountId: "acc-1", description: "Coffee purchase", amountCents: -450, currency: "USD" } }]);
  const handlers = createSearchEventHandlers({
    indexDocument: (doc) => indexed.push(doc),
    financeServiceUrl: "http://finance.internal",
    fetchImpl,
  });

  const outcome = await handlers["finance.transaction.created"]({ eventId: "evt-2", payload: { transactionId: "txn-1", accountId: "acc-1" } });

  assert.equal(outcome.skipped, false);
  assert.equal(indexed.length, 1);
  assert.equal(indexed[0].sourceId, "txn-1");
  assert.equal(indexed[0].title, "Coffee purchase");
  assert.match(indexed[0].content, /Coffee purchase/);
  assert.match(indexed[0].content, /-450/);
});

test("wisp.message.sent: skips (does not index) when the message no longer exists", async () => {
  const indexed = [];
  const fetchImpl = fakeFetch([]); // every lookup 404s
  const handlers = createSearchEventHandlers({ indexDocument: (doc) => indexed.push(doc), mailServiceUrl: "http://mail.internal", fetchImpl });

  const outcome = await handlers["wisp.message.sent"]({ eventId: "evt-3", payload: { messageId: "gone" } });

  assert.equal(outcome.skipped, true);
  assert.equal(indexed.length, 0);
});

test("finance.transaction.created: skips when the event payload is missing an id", async () => {
  const indexed = [];
  const handlers = createSearchEventHandlers({ indexDocument: (doc) => indexed.push(doc), financeServiceUrl: "http://finance.internal", fetchImpl: fakeFetch([]) });

  const outcome = await handlers["finance.transaction.created"]({ eventId: "evt-4", payload: {} });

  assert.equal(outcome.skipped, true);
  assert.equal(indexed.length, 0);
});

test("throws (so the bus retries / dead-letters) when the source service is unreachable with a real error, not a 404", async () => {
  const fetchImpl = async () => { throw new Error("ECONNREFUSED"); };
  const handlers = createSearchEventHandlers({ indexDocument: () => {}, mailServiceUrl: "http://mail.internal", fetchImpl });

  await assert.rejects(() => handlers["wisp.message.sent"]({ eventId: "evt-5", payload: { messageId: "msg-1" } }), /ECONNREFUSED/);
});

test("throws when no service URL is configured for the source, instead of silently skipping", async () => {
  const handlers = createSearchEventHandlers({ indexDocument: () => {}, fetchImpl: fakeFetch([]) });
  await assert.rejects(() => handlers["wisp.message.sent"]({ eventId: "evt-6", payload: { messageId: "msg-1" } }), /SERVICE_URL_NOT_CONFIGURED|No service URL configured/);
});
