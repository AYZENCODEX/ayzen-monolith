import { assertEventEnvelope, createEventEnvelope, validateEventOwnership, EVENT_TYPES, isSensitiveEventType } from "@ayzen/events";
import { createAuditRecord } from "@ayzen/audit";
import net from "node:net";
import tls from "node:tls";
import crypto from "node:crypto";
import { loadEventBusSecurityPolicy } from "./security-policy.mjs";
import { redactRestrictedPayload } from "./payload-policy.mjs";
import { resolveEventBus, authorizeCrossBusConsumption, eventBusCrossBusGateMode, loadEventBusTopology, loadEventBusRoutes, DEFAULT_BUS_ID } from "./topology.mjs";
import {
  attachProducerIdentity,
  eventBusIdentityGateMode,
  resolveEventBusSecret,
  signConsumerIdentity,
  verifyConsumerIdentity,
  verifyProducerIdentity,
} from "./identity.mjs";

function noopAllowed() {
  return process.env.ALLOW_EVENTBUS_NOOP === "true"
    && !["production", "staging"].includes(String(process.env.NODE_ENV ?? "").toLowerCase());
}

export function createEventClient({ publish, service, secret = resolveEventBusSecret() }) {
  if (typeof publish !== "function") throw new Error("Event publisher is required");
  return Object.freeze({
    async publish(envelope) {
      assertEventEnvelope(envelope);
      const withProducer = { ...envelope, metadata: { ...(envelope.metadata ?? {}), producer: service } };
      return publish(attachProducerIdentity(withProducer, { service, secret }));
    },
  });
}

/**
 * Phase H10.1 — shared by `createInMemoryEventBus` and
 * `createRedisEventBus`: the point where an envelope actually lands on
 * the bus is where `defaultDeny` / producer identity gets checked, not in
 * the publisher-side helpers above (those just attach a signature — a
 * caller could always hand a bus `publish()` a hand-built envelope
 * directly, so signing without verifying at the landing point would be
 * security theater). See `identity.mjs`'s own header for why
 * `AYZEN_SERVICE_AUTH_SECRET` is the identity source and why this gate's
 * safe default tracks the config's `defaultDeny` flag instead of
 * defaulting to "report" the way H9.2's did.
 */
function enforceProducerIdentity(envelope, { policy, logDenial }) {
  if (noopAllowed()) return;
  const mode = eventBusIdentityGateMode(policy);
  if (mode === "off") return;
  const decision = verifyProducerIdentity(envelope);
  if (decision.valid) return;
  logDenial?.(decision);
  if (mode === "enforce") {
    const error = new Error(`Event publish denied: producer identity is not verifiable (${decision.reason})`);
    error.code = "EVENT_PRODUCER_IDENTITY_DENIED";
    error.reason = decision.reason;
    throw error;
  }
}

function enforceConsumerIdentity(type, { policy, identity, logDenial }) {
  if (noopAllowed()) return;
  const mode = eventBusIdentityGateMode(policy);
  if (mode === "off") return;
  const decision = verifyConsumerIdentity({ identity, eventType: type });
  if (decision.valid) return;
  logDenial?.(decision);
  if (mode === "enforce") {
    const error = new Error(`Event subscribe denied: consumer identity is not verifiable (${decision.reason})`);
    error.code = "EVENT_CONSUMER_IDENTITY_DENIED";
    error.reason = decision.reason;
    throw error;
  }
}

/**
 * Phase H10.3 — `config/eventbus/routes.json`'s per-bus `consumers`
 * allow-list (Season 2 finding #10) was, like #9, validated for shape
 * and read by nothing. Applied at the same subscribe-time landing point
 * `enforceConsumerIdentity` uses, right after it — a consumer whose
 * identity doesn't even verify has no business being evaluated for
 * *which* bus it may read, but an identity-verified consumer still needs
 * this second, independent check before it's approved to cross into a
 * classified bus.
 */
function enforceCrossBusPolicy(type, { consumerService, topology, logDenial }) {
  if (noopAllowed()) return;
  const mode = eventBusCrossBusGateMode(topology);
  if (mode === "off") return;
  const decision = authorizeCrossBusConsumption({ consumerService, eventType: type, topology });
  if (decision.decision === "allow") return;
  logDenial?.(decision);
  if (mode === "enforce") {
    const error = new Error(`Event subscribe denied: consumer '${consumerService ?? "unknown"}' is not approved to read the '${decision.bus}' bus for '${type}' (${decision.code})`);
    error.code = "EVENT_CROSS_BUS_CONSUMPTION_DENIED";
    error.reason = decision.code;
    error.bus = decision.bus;
    throw error;
  }
}

/**
 * Phase H10.2 — `config/eventbus/security.json`'s `restrictedPayloads`
 * and `sensitiveEventsRequireAudit` were Season 2 finding #9's other
 * half: `defaultDeny`/producer identity got a runtime consumer in H10.1,
 * these two flags did not. This is that consumer, applied at the same
 * landing point H10.1 chose for the same reason (a caller can always hand
 * a bus `publish()` a hand-built envelope directly, so redacting only in
 * the publisher-side helpers would leave that path unprotected).
 *
 * Order matters: redact first, so a payload that both matches a
 * restricted key AND belongs to a sensitive event type produces one audit
 * record that already reflects the redaction (`redactedPaths` alongside
 * it), not two separate records or an audit trail that itself leaks the
 * secret it's supposed to be flagging.
 */
function enforcePayloadPolicy(envelope, { policy, service, auditSink }) {
  const type = envelope.eventType ?? envelope.type;
  const { payload, redactedPaths } = redactRestrictedPayload(envelope.payload, policy.restrictedPayloads ?? []);
  const nextEnvelope = redactedPaths.length > 0 ? { ...envelope, payload } : envelope;
  if (policy.sensitiveEventsRequireAudit && (isSensitiveEventType(type) || redactedPaths.length > 0)) {
    recordEventAudit(nextEnvelope, { service, redactedPaths, auditSink });
  }
  return nextEnvelope;
}

/**
 * Records the audit trail entry itself. This package has no durable audit
 * store of its own to write into — every service that has one
 * (`admin`, via `@ayzen/audit`'s `createAuditStore`) already owns a
 * different persistence choice (file-backed here, in-memory there), and
 * picking one for all of them would mean either a second, conflicting
 * store or a hidden write to a path the service never configured. So the
 * default mirrors `service-runtime`'s own `createAuditLog` precedent
 * exactly: a structured `console.log` line tagged `audit.recorded` is
 * itself the audit trail unless the caller opts into more. A caller that
 * wants durability passes `auditSink` (e.g. `admin`'s own
 * `audit.append`, or a publisher that turns this into an `audit.created`
 * event) and gets both: the log line always happens, the sink is
 * additive, and a sink that throws never blocks the publish it's
 * auditing.
 */
function recordEventAudit(envelope, { service, redactedPaths, auditSink }) {
  const type = envelope.eventType ?? envelope.type;
  const record = createAuditRecord({
    service: service || envelope.metadata?.producer || "event-bus",
    action: "event.published.sensitive",
    outcome: "success",
    resource: { eventType: type, eventId: envelope.eventId ?? envelope.id },
    traceId: envelope.traceId,
    requestId: envelope.correlationId,
    metadata: { redactedPaths, sensitive: isSensitiveEventType(type) },
  });
  if (typeof auditSink === "function") {
    try {
      auditSink(record);
    } catch (error) {
      console.error(JSON.stringify({
        timestamp: new Date().toISOString(), level: "error", event: "event.audit.sink.error",
        event_type: type, event_id: envelope.eventId ?? envelope.id, error: String(error?.message ?? error),
      }));
    }
  } else {
    console.log(JSON.stringify({ ...record, event: "audit.recorded" }));
  }
  return record;
}

export function createInMemoryEventBus({ service = process.env.SERVICE_NAME, policy = loadEventBusSecurityPolicy(), topology = loadEventBusTopology(), auditSink } = {}) {
  const subscribers = new Map();
  const received = [];
  const deadLetters = [];
  const processed = new Set();
  const attempts = new Map();
  const retention = 10_000;
  return {
    subscribe(type, handler, { identity = signConsumerIdentity({ service, eventType: type }) } = {}) {
      if (typeof handler !== "function") throw new Error("Event handler is required");
      enforceConsumerIdentity(type, {
        policy,
        identity,
        logDenial: (decision) => console.log(JSON.stringify({
          timestamp: new Date().toISOString(), level: "warn", event: "event.consumer.identity.denied",
          event_type: type, reason: decision.reason,
        })),
      });
      enforceCrossBusPolicy(type, {
        consumerService: service,
        topology,
        logDenial: (decision) => console.log(JSON.stringify({
          timestamp: new Date().toISOString(), level: "warn", event: "event.consumer.cross_bus.denied",
          event_type: type, consumer: service, bus: decision.bus, reason: decision.code,
        })),
      });
      const list = subscribers.get(type) ?? [];
      list.push(handler);
      subscribers.set(type, list);
      return () => subscribers.set(type, list.filter((candidate) => candidate !== handler));
    },
    async publish(rawEnvelope) {
      assertEventEnvelope(rawEnvelope);
      enforceProducerIdentity(rawEnvelope, {
        policy,
        logDenial: (decision) => console.log(JSON.stringify({
          timestamp: new Date().toISOString(), level: "warn", event: "event.producer.identity.denied",
          event_type: rawEnvelope.eventType ?? rawEnvelope.type, event_id: rawEnvelope.eventId, reason: decision.reason,
        })),
      });
      const envelope = enforcePayloadPolicy(rawEnvelope, { policy, service, auditSink });
      if (received.length >= retention) received.shift();
      received.push(Object.freeze({ ...envelope }));
      for (const handler of subscribers.get(envelope.eventType ?? envelope.type) ?? []) {
        const consumer = handler.consumer ?? handler.name ?? "anonymous";
        const key = `${envelope.eventId}:${consumer}`;
        if (processed.has(key)) continue;
        try {
          attempts.set(key, (attempts.get(key) ?? 0) + 1);
          await (typeof handler === "function" ? handler(envelope) : handler.handle(envelope));
          processed.add(key);
        } catch (error) {
          deadLetters.push({ envelope, consumer, attempts: attempts.get(key), error: error instanceof Error ? error.message : String(error) });
          throw error;
        }
      }
      return envelope;
    },
    replay({ eventType, from = 0, to = received.length, consumer } = {}) {
      const events = received.slice(from, to).filter((event) => !eventType || event.eventType === eventType || event.type === eventType);
      return Promise.all(events.map(async (event) => {
        const handlers = subscribers.get(event.eventType ?? event.type) ?? [];
        for (const handler of handlers) {
          if (consumer && (handler.consumer ?? handler.name) !== consumer) continue;
          const key = `${event.eventId}:${handler.consumer ?? handler.name ?? "anonymous"}`;
          processed.delete(key);
        }
        return this.publish(event);
      }));
    },
    received() {
      return [...received];
    },
    deadLetters() {
      return [...deadLetters];
    },
    metrics() {
      return { received: received.length, processed: processed.size, deadLetters: deadLetters.length };
    },
  };
}

/*
 * A deliberately small Redis Streams client. Keeping the transport here avoids
 * adding a second Redis client dependency to every service while still giving
 * the event contract a real cross-process implementation. Each short command
 * gets its own connection; the consumer loop uses the same command helper with
 * a bounded BLOCK timeout, which also makes shutdown/unsubscribe deterministic.
 */
function encodeRedisCommand(args) {
  return `*${args.length}\r\n${args.map((arg) => {
    const value = String(arg);
    return `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
  }).join("")}`;
}

function parseRedisValue(buffer, offset = 0) {
  const end = buffer.indexOf("\r\n", offset);
  if (end < 0) return undefined;
  const prefix = buffer[offset];
  if (prefix === 43 || prefix === 45 || prefix === 58) {
    const value = buffer.toString("utf8", offset + 1, end);
    return { value: prefix === 58 ? Number(value) : value, offset: end + 2 };
  }
  if (prefix === 36) {
    const length = Number(buffer.toString("utf8", offset + 1, end));
    if (length === -1) return { value: null, offset: end + 2 };
    const start = end + 2;
    const finish = start + length;
    if (buffer.length < finish + 2) return undefined;
    return { value: buffer.toString("utf8", start, finish), offset: finish + 2 };
  }
  if (prefix === 42) {
    const length = Number(buffer.toString("utf8", offset + 1, end));
    if (length === -1) return { value: null, offset: end + 2 };
    const values = [];
    let cursor = end + 2;
    for (let index = 0; index < length; index += 1) {
      const item = parseRedisValue(buffer, cursor);
      if (!item) return undefined;
      values.push(item.value);
      cursor = item.offset;
    }
    return { value: values, offset: cursor };
  }
  throw new Error(`Unsupported Redis response prefix: ${String.fromCharCode(prefix)}`);
}

function redisConnectionOptions(redisUrl) {
  const parsed = new URL(redisUrl);
  if (!["redis:", "rediss:"].includes(parsed.protocol)) throw new Error("EVENT_BUS_REDIS_URL must use redis:// or rediss://");
  return {
    host: parsed.hostname || "127.0.0.1",
    port: Number(parsed.port || 6379),
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    database: parsed.pathname && parsed.pathname !== "/" ? Number(parsed.pathname.slice(1)) : undefined,
    tls: parsed.protocol === "rediss:",
  };
}

async function redisCommand(redisUrl, args, { block = false } = {}) {
  const options = redisConnectionOptions(redisUrl);
  return new Promise((resolve, reject) => {
    const socket = options.tls
      ? tls.connect({ host: options.host, port: options.port, servername: options.host })
      : net.createConnection({ host: options.host, port: options.port });
    let buffer = Buffer.alloc(0);
    const setup = [];
    if (options.password) setup.push(["AUTH", options.password]);
    if (options.database !== undefined) setup.push(["SELECT", options.database]);
    const commands = [...setup, args];
    let responses = [];
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      callback(value);
    };
    socket.on("connect", () => socket.write(commands.map(encodeRedisCommand).join("")));
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (!settled) {
        const parsed = parseRedisValue(buffer);
        if (!parsed) return;
        buffer = buffer.subarray(parsed.offset);
        responses.push(parsed.value);
        if (responses.length === commands.length) finish(resolve, responses.at(-1));
      }
    });
    socket.on("error", (error) => finish(reject, error));
    socket.setTimeout(block ? 2_500 : 10_000, () => finish(reject, new Error("Redis command timed out")));
  });
}

function redisError(value) {
  if (typeof value === "string" && value.startsWith("ERR ")) return new Error(value);
  return value;
}

function streamEntryToEnvelope(fields = []) {
  const values = Object.fromEntries(Array.from({ length: Math.floor(fields.length / 2) }, (_, index) => [fields[index * 2], fields[index * 2 + 1]]));
  if (!values.envelope) return undefined;
  try {
    return JSON.parse(values.envelope);
  } catch {
    return undefined;
  }
}

export function createRedisEventBus({
  url = process.env.EVENT_BUS_REDIS_URL ?? process.env.EVENT_BUS_URL,
  namespace = process.env.EVENT_BUS_NAMESPACE ?? "ayzen:events",
  consumerGroup = process.env.EVENT_BUS_CONSUMER_GROUP ?? `${namespace}:${process.env.SERVICE_NAME ?? "default"}`,
  consumer = process.env.EVENT_BUS_CONSUMER ?? `${process.env.SERVICE_NAME ?? "service"}-${crypto.randomUUID()}`,
  maxAttempts = 5,
  // How long a delivery may sit unacked (e.g. its owning process died) before
  // another consumer in the group is allowed to reclaim and reprocess it.
  // Overridable so integration/chaos tests don't have to wait 30s per run.
  claimIdleMs = Number(process.env.EVENT_BUS_CLAIM_IDLE_MS ?? 30_000),
  policy = loadEventBusSecurityPolicy(),
  topology = loadEventBusTopology(),
  routes = loadEventBusRoutes(),
  service = process.env.SERVICE_NAME,
  auditSink,
} = {}) {
  if (!url) throw new Error("EVENT_BUS_REDIS_URL (or legacy EVENT_BUS_URL) is required for the Redis event bus");
  const subscriptions = new Map();
  const processed = new Set();
  let closed = false;
  // Phase H10.3: each event type's stream now lives under its classified
  // bus segment (`ayzen:events:security:identity.created`, say) instead
  // of every type sharing one flat namespace — the runtime consumer
  // `topology.json` / `routes.json` never had. Types with no `routes.json`
  // entry fall back to `DEFAULT_BUS_ID` ("domain"), same as before this
  // phase in every way that matters (still one stream per event type,
  // just now under an explicit "domain" segment rather than an implicit
  // flat one).
  const streamFor = (type) => `${namespace}:${resolveEventBus(type, routes)}:${type}`;
  const deadLetterStream = `${namespace}:dead-letter`;

  async function ensureGroup(stream) {
    const result = await redisCommand(url, ["XGROUP", "CREATE", stream, consumerGroup, "0", "MKSTREAM"]);
    if (typeof result === "string" && result.startsWith("BUSYGROUP")) return result;
    return redisError(result);
  }

  async function addEnvelope(envelope, stream = streamFor(envelope.eventType ?? envelope.type), metadata = {}) {
    const result = await redisCommand(url, ["XADD", stream, "*", "eventId", envelope.eventId, "eventType", envelope.eventType, "envelope", JSON.stringify(envelope), ...Object.entries(metadata).flatMap(([key, value]) => [key, String(value)])]);
    return result;
  }

  async function consume(type, registration) {
    const stream = streamFor(type);
    try { await ensureGroup(stream); } catch (error) {
      if (!String(error?.message ?? error).includes("BUSYGROUP")) throw error;
    }
    while (!closed && subscriptions.get(type) === registration) {
      let entries = [];
      try {
        // Recover deliveries owned by a process that died before ACK. The
        // consumer group is durable, so restarts must not strand messages.
        const claimed = await redisCommand(url, ["XAUTOCLAIM", stream, consumerGroup, consumer, String(claimIdleMs), "0-0", "COUNT", "10"]);
        entries = claimed?.[1] ?? [];
      } catch (error) {
        if (!closed && !String(error?.message ?? error).includes("unknown command")) {
          console.error(JSON.stringify({ event: "event.consumer.reclaim.error", service: consumer, event_type: type, error: String(error?.message ?? error) }));
        }
      }
      if (entries.length === 0) {
        let response;
        try {
          response = await redisCommand(url, ["XREADGROUP", "GROUP", consumerGroup, consumer, "COUNT", "10", "BLOCK", "1000", "STREAMS", stream, ">"], { block: true });
        } catch (error) {
          if (!closed) console.error(JSON.stringify({ event: "event.consumer.error", service: consumer, event_type: type, error: String(error?.message ?? error) }));
          continue;
        }
        entries = response?.[0]?.[1] ?? [];
      }
      for (const [entryId, fields] of entries) {
        const envelope = streamEntryToEnvelope(fields);
        if (!envelope) {
          await redisCommand(url, ["XACK", stream, consumerGroup, entryId]);
          continue;
        }
        const handler = registration.handler;
        const handlerName = handler.consumer ?? handler.name ?? consumer;
        const processedKey = `${envelope.eventId}:${handlerName}`;
        if (processed.has(processedKey)) {
          await redisCommand(url, ["XACK", stream, consumerGroup, entryId]);
          continue;
        }
        const persisted = await redisCommand(url, ["GET", `${namespace}:processed:${processedKey}`]);
        if (persisted === "1") {
          processed.add(processedKey);
          await redisCommand(url, ["XACK", stream, consumerGroup, entryId]);
          continue;
        }
        try {
          await (typeof handler === "function" ? handler(envelope) : handler.handle(envelope));
          processed.add(processedKey);
          await redisCommand(url, ["SET", `${namespace}:processed:${processedKey}`, "1", "EX", "604800"]);
          await redisCommand(url, ["XACK", stream, consumerGroup, entryId]);
        } catch (error) {
          const attemptsKey = `${namespace}:attempts:${processedKey}`;
          const attempts = Number(await redisCommand(url, ["INCR", attemptsKey]));
          if (attempts >= maxAttempts) {
            await redisCommand(url, ["XADD", deadLetterStream, "*", "eventId", envelope.eventId, "eventType", envelope.eventType, "consumer", handlerName, "attempts", attempts, "error", String(error?.message ?? error).slice(0, 1000), "envelope", JSON.stringify(envelope)]);
            await redisCommand(url, ["XACK", stream, consumerGroup, entryId]);
          } else {
            await redisCommand(url, ["XACK", stream, consumerGroup, entryId]);
            await addEnvelope(envelope, stream, { retryAttempt: attempts });
          }
        }
      }
    }
  }

  return {
    subscribe(type, handler, { identity = signConsumerIdentity({ service: process.env.SERVICE_NAME ?? consumer, eventType: type }) } = {}) {
      if (typeof handler !== "function" && typeof handler?.handle !== "function") throw new Error("Event handler is required");
      enforceConsumerIdentity(type, {
        policy,
        identity,
        logDenial: (decision) => console.log(JSON.stringify({
          timestamp: new Date().toISOString(), level: "warn", event: "event.consumer.identity.denied",
          event_type: type, consumer, reason: decision.reason,
        })),
      });
      enforceCrossBusPolicy(type, {
        consumerService: process.env.SERVICE_NAME ?? consumer,
        topology,
        logDenial: (decision) => console.log(JSON.stringify({
          timestamp: new Date().toISOString(), level: "warn", event: "event.consumer.cross_bus.denied",
          event_type: type, consumer, bus: decision.bus, reason: decision.code,
        })),
      });
      const registration = { handler };
      subscriptions.set(type, registration);
      void consume(type, registration);
      return () => {
        if (subscriptions.get(type) === registration) subscriptions.delete(type);
      };
    },
    async publish(rawEnvelope) {
      assertEventEnvelope(rawEnvelope);
      enforceProducerIdentity(rawEnvelope, {
        policy,
        logDenial: (decision) => console.log(JSON.stringify({
          timestamp: new Date().toISOString(), level: "warn", event: "event.producer.identity.denied",
          event_type: rawEnvelope.eventType ?? rawEnvelope.type, event_id: rawEnvelope.eventId, reason: decision.reason,
        })),
      });
      const envelope = enforcePayloadPolicy(rawEnvelope, { policy, service, auditSink });
      await addEnvelope(envelope);
      return envelope;
    },
    async replay({ eventType, from = "-", to = "+", consumer: requestedConsumer } = {}) {
      const types = eventType ? [eventType] : EVENT_TYPES;
      const replayed = [];
      for (const type of types) {
        const entries = await redisCommand(url, ["XRANGE", streamFor(type), from, to, "COUNT", "1000"]);
        for (const [, fields] of entries ?? []) {
          const envelope = streamEntryToEnvelope(fields);
          if (envelope) {
            if (requestedConsumer) processed.delete(`${envelope.eventId}:${requestedConsumer}`);
            await addEnvelope(envelope);
            replayed.push(envelope);
          }
        }
      }
      return replayed;
    },
    async received({ eventType, from = "-", to = "+" } = {}) {
      const types = eventType ? [eventType] : [];
      const events = [];
      for (const type of types) {
        const entries = await redisCommand(url, ["XRANGE", streamFor(type), from, to, "COUNT", "1000"]);
        events.push(...(entries ?? []).map(([, fields]) => streamEntryToEnvelope(fields)).filter(Boolean));
      }
      return events;
    },
    async deadLetters() {
      const entries = await redisCommand(url, ["XRANGE", deadLetterStream, "-", "+", "COUNT", "1000"]);
      return (entries ?? []).map(([, fields]) => {
        const values = Object.fromEntries(Array.from({ length: Math.floor(fields.length / 2) }, (_, index) => [fields[index * 2], fields[index * 2 + 1]]));
        return { ...values, attempts: Number(values.attempts), envelope: values.envelope ? JSON.parse(values.envelope) : undefined };
      });
    },
    async replayDeadLetter({ eventId } = {}) {
      const entries = await this.deadLetters();
      const matches = entries.filter((entry) => !eventId || entry.eventId === eventId);
      for (const entry of matches) if (entry.envelope) await this.publish(entry.envelope);
      return matches;
    },
    // Phase H11.2 — the missing piece behind `event.consumer.lag` (Season 2
    // finding #14): turns a consumer group's `XPENDING` summary into a
    // per-event-type backlog reading `createConsumerLagMonitor`
    // (`./lag-monitor.mjs`) can poll and threshold. If the group has never
    // been created (`ensureGroup` only runs once a subscriber actually
    // calls `.subscribe()` for this type — see `consume()` above), Redis
    // reports `NOGROUP`; that's zero backlog, not an error, since nothing
    // has ever had the chance to fall behind.
    async consumerLag(eventType) {
      const stream = streamFor(eventType);
      const summary = await redisCommand(url, ["XPENDING", stream, consumerGroup]);
      // Redis error replies (e.g. NOGROUP — no subscriber has ever called
      // .subscribe() for this type, so ensureGroup() never ran) surface as
      // plain strings here rather than a rejection (see parseRedisValue's
      // '-' handling above); that's zero backlog, not a failure, since
      // nothing has ever had the chance to fall behind.
      if (typeof summary === "string") {
        if (summary.startsWith("NOGROUP")) {
          return { eventType, bus: resolveEventBus(eventType, routes), stream, consumerGroup, pending: 0, minId: null, maxId: null, consumers: [] };
        }
        throw redisError(summary);
      }
      const [count, minId, maxId, consumersRaw] = Array.isArray(summary) ? summary : [0, null, null, null];
      const consumers = (consumersRaw ?? []).map(([name, pending]) => ({ name, pending: Number(pending) }));
      return {
        eventType,
        bus: resolveEventBus(eventType, routes),
        stream,
        consumerGroup,
        pending: Number(count) || 0,
        minId: minId ?? null,
        maxId: maxId ?? null,
        consumers,
      };
    },
    metrics() {
      return { transport: "redis-streams", namespace, consumerGroup, consumer };
    },
    close() {
      closed = true;
      subscriptions.clear();
    },
  };
}

export function createDomainEventPublisher({ service, publish, secret = resolveEventBusSecret() }) {
  if (typeof service !== "string" || typeof publish !== "function") throw new Error("Service and publish are required");
  return {
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
      // H10.1: stamp a verifiable producer attestation before handing the
      // envelope to the transport, so it survives an HTTP hop (the /events
      // ingest gateway, H5.2) intact for the bus to verify on arrival —
      // this wrapper itself does not enforce anything (see
      // `enforceProducerIdentity` in `createInMemoryEventBus` /
      // `createRedisEventBus`, the actual landing points).
      return publish(attachProducerIdentity(envelope, { service, secret }));
    },
  };
}

// A raw envelope->HTTP transport, factored out of `createHttpEventPublisher`
// so Phase H6.1's `createTransactionalEventPublisher` (in `@ayzen/outbox`)
// can use the exact same "POST an already-built envelope to the gateway's
// /events ingest route" logic as its relay transport, instead of every
// call site re-implementing the fetch. `createHttpEventPublisher` below is
// just this transport plus envelope construction (`createDomainEventPublisher`),
// kept for callers that don't need outbox durability.
export function createHttpEnvelopeTransport({ service, eventBusUrl = process.env.EVENT_BUS_HTTP_URL ?? process.env.EVENT_BUS_URL, fetchImpl = fetch } = {}) {
  if (!service) throw new Error("Service is required");
  return async function transport(envelope) {
    if (!eventBusUrl) {
      if (!noopAllowed()) {
        const error = new Error("EVENT_BUS_HTTP_URL (or legacy EVENT_BUS_URL) is required; set ALLOW_EVENTBUS_NOOP=true only for local development");
        error.code = "EVENT_BUS_NOT_CONFIGURED";
        throw error;
      }
      console.log(JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "info",
        event: "event.published",
        producer: service,
        event_type: envelope.eventType,
        event_id: envelope.eventId,
        trace_id: envelope.traceId,
        correlation_id: envelope.correlationId,
      }));
      return envelope;
    }
    const response = await fetchImpl(`${eventBusUrl.replace(/\/+$/, "")}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
    });
    if (!response.ok) throw new Error(`Event bus rejected event with ${response.status}`);
    return response.json().catch(() => envelope);
  };
}

export function createHttpEventPublisher({ service, eventBusUrl, fetchImpl, secret } = {}) {
  if (!service) throw new Error("Service is required");
  return createDomainEventPublisher({
    service,
    secret,
    publish: createHttpEnvelopeTransport({ service, eventBusUrl, fetchImpl }),
  });
}

export { createConsumerLagMonitor } from "./lag-monitor.mjs";
export { validateEventOwnership };
export { loadEventBusSecurityPolicy } from "./security-policy.mjs";
export {
  DEFAULT_BUS_ID,
  loadEventBusTopology,
  loadEventBusRoutes,
  resolveEventBus,
  authorizeCrossBusConsumption,
  eventBusCrossBusGateMode,
} from "./topology.mjs";
export {
  attachProducerIdentity,
  eventBusIdentityGateMode,
  resolveEventBusSecret,
  signConsumerIdentity,
  verifyConsumerIdentity,
  verifyProducerIdentity,
} from "./identity.mjs";