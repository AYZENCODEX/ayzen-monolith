import crypto from "node:crypto";
import { createEventEnvelope } from "@ayzen/events";

export function createOutboxInbox({ now = () => Date.now(), maxAttempts = 5 } = {}) {
  const outbox = [];
  const inbox = new Set();
  const deadLetters = [];
  return Object.freeze({
    append({ aggregateId, event, transactionId } = {}) {
      if (!aggregateId || !event) throw new Error("Outbox aggregate and event are required");
      const record = { id: crypto.randomUUID(), aggregateId, event, transactionId: transactionId ?? crypto.randomUUID(), status: "pending", attempts: 0, createdAt: now() };
      outbox.push(record);
      return { ...record };
    },
    claim(limit = 10) {
      return outbox.filter((record) => record.status === "pending").slice(0, limit).map((record) => {
        record.status = "processing";
        record.attempts += 1;
        return { ...record };
      });
    },
    ack(id) {
      const record = outbox.find((item) => item.id === id);
      if (!record) throw new Error("Outbox record not found");
      record.status = "published";
      record.publishedAt = now();
      return { ...record };
    },
    fail(id, error) {
      const record = outbox.find((item) => item.id === id);
      if (!record) throw new Error("Outbox record not found");
      record.error = String(error);
      record.status = record.attempts >= maxAttempts ? "dead-lettered" : "pending";
      if (record.status === "dead-lettered") deadLetters.push({ ...record });
      return { ...record };
    },
    consumeOnce(eventId) {
      if (inbox.has(eventId)) return false;
      inbox.add(eventId);
      return true;
    },
    pending() { return outbox.filter((record) => record.status === "pending").map((record) => ({ ...record })); },
    deadLetters() { return deadLetters.map((record) => ({ ...record })); },
    snapshot() { return { outbox: outbox.map((record) => ({ ...record })), inbox: [...inbox], deadLetters: deadLetters.map((record) => ({ ...record })) }; },
  });
}

/**
 * Phase H6.1 — the transactional-outbox-pattern publisher every
 * state-mutating route should use in place of calling an event-client
 * transport directly. Before this, services did
 * `state.set(id, record); await publish.publish(...)` as two independent
 * steps: if the publish call threw (network blip, event bus down, process
 * killed between the two lines) the state change and the event fell out of
 * sync with no way to reconcile them, and nothing survived a restart.
 *
 * `.publish()` here does the state-adjacent half synchronously and
 * in-process — append an outbox record right next to the `Map.set()` that
 * produced it, so the two either both happen or (if the process dies first)
 * neither does. It returns immediately; the actual network call happens on
 * a background relay loop that claims pending records and hands them to
 * `transport`, acking on success and leaving failures `pending` (via
 * `outbox.fail`) for the next relay pass to retry, up to the outbox's
 * `maxAttempts` before it's dead-lettered.
 *
 * This closes the atomicity gap between state and event; it does not by
 * itself survive a process restart, since `createOutboxInbox` is in-memory
 * — that's Phase H6.2 (move service state, and this outbox, to Postgres).
 * Passing a `store` created from a durable-backed outbox implementation
 * will make this publisher durable without any call-site changes.
 */
export function createTransactionalEventPublisher({ service, transport, store = createOutboxInbox(), relayIntervalMs = 25 } = {}) {
  if (!service) throw new Error("Service is required");
  if (typeof transport !== "function") throw new Error("An envelope transport function is required");

  let relaying = false;
  async function relayOnce() {
    if (relaying) return;
    relaying = true;
    try {
      for (const record of store.claim(25)) {
        try {
          await transport(record.event);
          store.ack(record.id);
        } catch (error) {
          store.fail(record.id, error);
        }
      }
    } finally {
      relaying = false;
    }
  }
  const timer = setInterval(() => { relayOnce().catch(() => {}); }, relayIntervalMs);
  timer.unref?.();

  return Object.freeze({
    publish({ eventType, payload, actor, organizationId, workspaceId, aggregate, context, metadata } = {}) {
      const envelope = createEventEnvelope({
        eventType,
        payload,
        actor,
        organizationId,
        workspaceId,
        aggregate,
        traceId: context?.traceId,
        correlationId: context?.correlationId,
        causationId: context?.causationId,
        metadata: { ...metadata, producer: service },
      });
      store.append({ aggregateId: aggregate?.id ?? envelope.eventId, event: envelope, transactionId: envelope.eventId });
      // Best-effort immediate flush so events go out promptly under normal
      // conditions; the interval above is the durability backstop for a
      // pass that's mid-flight or a publish that needs a retry.
      void relayOnce();
      return Promise.resolve(envelope);
    },
    outbox: store,
    relayOnce,
    close() { clearInterval(timer); },
  });
}