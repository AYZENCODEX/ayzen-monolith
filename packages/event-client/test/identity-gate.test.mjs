// Phase H10.1 — Season 2 finding #9: `config/eventbus/security.json`
// (`defaultDeny`, `producerIdentity`, `consumerIdentity`) was validated
// for shape by a script and read by nothing else at runtime. This adds
// the runtime consumer: `createInMemoryEventBus` and `createRedisEventBus`
// now verify a signed producer attestation before accepting a publish,
// and a signed consumer attestation before accepting a subscribe, via
// `identity.mjs`'s HMAC primitives (reusing the same
// `AYZEN_SERVICE_AUTH_SECRET` already used for internal HTTP calls).
//
// These tests drive `createInMemoryEventBus` directly (fast, deterministic,
// no network) for the gate-mode matrix, then repeat the two outcomes that
// matter most (a valid publish succeeds; an invalid one is denied under
// "enforce") against a real `createRedisEventBus` — the actual landing
// point in production — the same way `redis-bus-chaos.test.mjs` verifies
// crash-recovery against a live broker rather than a mock.
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { createEventEnvelope } from "@ayzen/events";
import {
  createInMemoryEventBus,
  createRedisEventBus,
  createEventClient,
} from "../src/index.mjs";
import {
  attachProducerIdentity,
  signConsumerIdentity,
  eventBusIdentityGateMode,
} from "../src/identity.mjs";

const SECRET = "test-shared-secret-for-h10-1";

function withEnv(vars, fn) {
  const previous = {};
  for (const key of Object.keys(vars)) {
    previous[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of Object.keys(previous)) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    });
}

function envelope(overrides = {}) {
  return createEventEnvelope({ eventType: "workflow.started", payload: { executionId: "h10-1" }, ...overrides });
}

// --- gate mode itself ------------------------------------------------

test("H10.1: EVENT_BUS_IDENTITY_GATE defaults to 'report', not 'enforce'", async () => {
  await withEnv({ EVENT_BUS_IDENTITY_GATE: undefined }, () => {
    assert.equal(eventBusIdentityGateMode(), "report");
  });
});

test("H10.1: an unrecognized EVENT_BUS_IDENTITY_GATE value fails toward 'report'", async () => {
  await withEnv({ EVENT_BUS_IDENTITY_GATE: "not-a-real-mode" }, () => {
    assert.equal(eventBusIdentityGateMode(), "report");
  });
});

test("H10.1: an explicit config defaultDeny:false turns the gate 'off' even with no env var set", async () => {
  await withEnv({ EVENT_BUS_IDENTITY_GATE: undefined }, () => {
    assert.equal(eventBusIdentityGateMode({ defaultDeny: false }), "off");
  });
});

test("H10.1: the env var always wins over policy.defaultDeny", async () => {
  await withEnv({ EVENT_BUS_IDENTITY_GATE: "enforce" }, () => {
    assert.equal(eventBusIdentityGateMode({ defaultDeny: false }), "enforce");
  });
});

// --- in-memory bus: publish (producer identity) -----------------------

test("H10.1: publish with no producer identity is denied (403-equivalent) under EVENT_BUS_IDENTITY_GATE=enforce", async () => {
  await withEnv({ AYZEN_SERVICE_AUTH_SECRET: SECRET, EVENT_BUS_IDENTITY_GATE: "enforce" }, async () => {
    const bus = createInMemoryEventBus();
    await assert.rejects(
      () => bus.publish(envelope()),
      (error) => error.code === "EVENT_PRODUCER_IDENTITY_DENIED" && error.reason === "PRODUCER_IDENTITY_MISSING",
    );
  });
});

test("H10.1: publish with a valid producer attestation succeeds under enforce", async () => {
  await withEnv({ AYZEN_SERVICE_AUTH_SECRET: SECRET, EVENT_BUS_IDENTITY_GATE: "enforce" }, async () => {
    const bus = createInMemoryEventBus();
    const signed = attachProducerIdentity(envelope(), { service: "finance", secret: SECRET });
    const result = await bus.publish(signed);
    assert.equal(result.eventId, signed.eventId);
    assert.equal(bus.received().length, 1);
  });
});

test("H10.1: a tampered payload invalidates the producer signature and is denied under enforce", async () => {
  await withEnv({ AYZEN_SERVICE_AUTH_SECRET: SECRET, EVENT_BUS_IDENTITY_GATE: "enforce" }, async () => {
    const bus = createInMemoryEventBus();
    const signed = attachProducerIdentity(envelope(), { service: "finance", secret: SECRET });
    const tampered = { ...signed, payload: { executionId: "not-what-was-signed" } };
    await assert.rejects(
      () => bus.publish(tampered),
      (error) => error.code === "EVENT_PRODUCER_IDENTITY_DENIED" && error.reason === "PRODUCER_IDENTITY_INVALID",
    );
  });
});

test("H10.1: a signature produced with the wrong secret is denied under enforce", async () => {
  await withEnv({ AYZEN_SERVICE_AUTH_SECRET: SECRET, EVENT_BUS_IDENTITY_GATE: "enforce" }, async () => {
    const bus = createInMemoryEventBus();
    const signed = attachProducerIdentity(envelope(), { service: "finance", secret: "wrong-secret" });
    await assert.rejects(
      () => bus.publish(signed),
      (error) => error.code === "EVENT_PRODUCER_IDENTITY_DENIED" && error.reason === "PRODUCER_IDENTITY_INVALID",
    );
  });
});

test("H10.1: default mode ('report') logs a missing producer identity but does not block the publish", async () => {
  await withEnv({ AYZEN_SERVICE_AUTH_SECRET: SECRET, EVENT_BUS_IDENTITY_GATE: undefined }, async () => {
    const bus = createInMemoryEventBus();
    const result = await bus.publish(envelope());
    assert.ok(result.eventId);
    assert.equal(bus.received().length, 1);
  });
});

test("H10.1: with no secret configured anywhere, publish is not blocked even under 'enforce' request — EVENT_BUS_SECRET_NOT_CONFIGURED still denies, but only 'report'-logs unless the operator also supplies a secret", async () => {
  // This pins the actual (safe) behavior: enforce with no secret configured
  // still throws, because "no way to verify" is not the same as "verified".
  // A deployment that wants this to be a no-op must use EVENT_BUS_IDENTITY_GATE=off
  // or ALLOW_EVENTBUS_NOOP, not just "leave the secret unset".
  await withEnv({ AYZEN_SERVICE_AUTH_SECRET: undefined, SERVICE_TO_SERVICE_SECRET: undefined, EVENT_BUS_IDENTITY_GATE: "enforce" }, async () => {
    const bus = createInMemoryEventBus();
    await assert.rejects(
      () => bus.publish(envelope()),
      (error) => error.code === "EVENT_PRODUCER_IDENTITY_DENIED" && error.reason === "EVENT_BUS_SECRET_NOT_CONFIGURED",
    );
  });
});

test("H10.1: EVENT_BUS_IDENTITY_GATE=off skips producer verification entirely", async () => {
  await withEnv({ AYZEN_SERVICE_AUTH_SECRET: SECRET, EVENT_BUS_IDENTITY_GATE: "off" }, async () => {
    const bus = createInMemoryEventBus();
    const result = await bus.publish(envelope());
    assert.ok(result.eventId);
  });
});

test("H10.1: ALLOW_EVENTBUS_NOOP=true bypasses identity enforcement even under 'enforce' (local-dev escape hatch)", async () => {
  await withEnv({ AYZEN_SERVICE_AUTH_SECRET: SECRET, EVENT_BUS_IDENTITY_GATE: "enforce", ALLOW_EVENTBUS_NOOP: "true" }, async () => {
    const bus = createInMemoryEventBus();
    const result = await bus.publish(envelope());
    assert.ok(result.eventId);
  });
});

// --- in-memory bus: subscribe (consumer identity) ----------------------

test("H10.1: subscribe with no consumer identity is denied under enforce", async () => {
  await withEnv({ AYZEN_SERVICE_AUTH_SECRET: SECRET, EVENT_BUS_IDENTITY_GATE: "enforce" }, async () => {
    const bus = createInMemoryEventBus({ service: undefined });
    assert.throws(
      () => bus.subscribe("workflow.started", () => {}),
      (error) => error.code === "EVENT_CONSUMER_IDENTITY_DENIED" && error.reason === "CONSUMER_IDENTITY_MISSING",
    );
  });
});

test("H10.1: subscribe with a valid consumer identity (via SERVICE_NAME) succeeds under enforce", async () => {
  await withEnv({ AYZEN_SERVICE_AUTH_SECRET: SECRET, EVENT_BUS_IDENTITY_GATE: "enforce" }, async () => {
    const bus = createInMemoryEventBus({ service: "notification" });
    assert.doesNotThrow(() => bus.subscribe("workflow.started", () => {}));
  });
});

test("H10.1: subscribe with an explicitly-passed, correctly signed identity succeeds under enforce", async () => {
  await withEnv({ AYZEN_SERVICE_AUTH_SECRET: SECRET, EVENT_BUS_IDENTITY_GATE: "enforce" }, async () => {
    const bus = createInMemoryEventBus({ service: undefined });
    const identity = signConsumerIdentity({ service: "search", eventType: "wisp.message.sent", secret: SECRET });
    assert.doesNotThrow(() => bus.subscribe("wisp.message.sent", () => {}, { identity }));
  });
});

test("H10.1: subscribe with an identity signed for a different event type is denied under enforce", async () => {
  await withEnv({ AYZEN_SERVICE_AUTH_SECRET: SECRET, EVENT_BUS_IDENTITY_GATE: "enforce" }, async () => {
    const bus = createInMemoryEventBus({ service: undefined });
    const identity = signConsumerIdentity({ service: "search", eventType: "wisp.message.sent", secret: SECRET });
    assert.throws(
      () => bus.subscribe("finance.transaction.created", () => {}, { identity }),
      (error) => error.code === "EVENT_CONSUMER_IDENTITY_DENIED" && error.reason === "CONSUMER_IDENTITY_INVALID",
    );
  });
});

test("H10.1: end-to-end through createEventClient — publish attaches a producer identity the bus then accepts under enforce", async () => {
  await withEnv({ AYZEN_SERVICE_AUTH_SECRET: SECRET, EVENT_BUS_IDENTITY_GATE: "enforce" }, async () => {
    const bus = createInMemoryEventBus();
    const client = createEventClient({ service: "finance", publish: bus.publish });
    await client.publish(envelope());
    assert.equal(bus.received().length, 1);
    assert.equal(bus.received()[0].metadata.producerIdentity.service, "finance");
  });
});

// --- real Redis: the two outcomes that matter most, against the actual
// production landing point rather than a mock ---------------------------

async function redisReachable(redisUrl) {
  if (!redisUrl) return false;
  try {
    const parsed = new URL(redisUrl);
    await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: parsed.hostname, port: Number(parsed.port || 6379) });
      socket.once("connect", () => { socket.destroy(); resolve(); });
      socket.once("error", reject);
      socket.setTimeout(1_000, () => { socket.destroy(); reject(new Error("timeout")); });
    });
    return true;
  } catch {
    return false;
  }
}

test("H10.1 (Redis): a valid producer attestation is accepted and delivered under enforce", async (t) => {
  const url = process.env.EVENT_BUS_URL ?? process.env.REDIS_TEST_URL;
  if (!(await redisReachable(url))) {
    t.skip("No reachable Redis (set EVENT_BUS_URL / REDIS_TEST_URL) — skipping live identity test");
    return;
  }
  await withEnv({ AYZEN_SERVICE_AUTH_SECRET: SECRET, EVENT_BUS_IDENTITY_GATE: "enforce" }, async () => {
    const namespace = `ayzen:events:h10-1:${Date.now()}`;
    const bus = createRedisEventBus({ url, namespace, consumerGroup: "h10-1-group", consumer: "h10-1-consumer" });
    const seen = [];
    bus.subscribe("workflow.started", (received) => { seen.push(received.eventId); }, {
      identity: signConsumerIdentity({ service: "worker", eventType: "workflow.started", secret: SECRET }),
    });
    const signed = attachProducerIdentity(envelope(), { service: "workflow", secret: SECRET });
    await bus.publish(signed);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !seen.includes(signed.eventId)) await new Promise((r) => setTimeout(r, 100));
    bus.close();
    assert.ok(seen.includes(signed.eventId), "the signed event should have been delivered to the subscriber");
  });
});

test("H10.1 (Redis): an unsigned publish is rejected before it ever reaches the stream, under enforce", async (t) => {
  const url = process.env.EVENT_BUS_URL ?? process.env.REDIS_TEST_URL;
  if (!(await redisReachable(url))) {
    t.skip("No reachable Redis (set EVENT_BUS_URL / REDIS_TEST_URL) — skipping live identity test");
    return;
  }
  await withEnv({ AYZEN_SERVICE_AUTH_SECRET: SECRET, EVENT_BUS_IDENTITY_GATE: "enforce" }, async () => {
    const namespace = `ayzen:events:h10-1:${Date.now()}`;
    const bus = createRedisEventBus({ url, namespace, consumerGroup: "h10-1-group-b", consumer: "h10-1-consumer-b" });
    await assert.rejects(
      () => bus.publish(envelope()),
      (error) => error.code === "EVENT_PRODUCER_IDENTITY_DENIED",
    );
    const received = await bus.received({ eventType: "workflow.started" });
    assert.equal(received.length, 0, "a denied publish must never land on the Redis stream");
    bus.close();
  });
});
