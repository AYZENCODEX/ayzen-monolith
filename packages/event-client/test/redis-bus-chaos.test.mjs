// Phase A4 gate: "kill a consumer mid-processing, confirm the event isn't
// lost and isn't double-processed on restart." This is a real cross-process
// (well, cross-connection-group) integration test against a live Redis, not
// a mock — the crash-recovery path lives entirely in Redis consumer-group
// bookkeeping (XREADGROUP/XAUTOCLAIM/XACK), so faking the transport would
// not exercise the thing the gate cares about.
//
// Requires a reachable Redis. Set EVENT_BUS_URL (or REDIS_TEST_URL) to run
// it for real; otherwise it skips with an explicit reason instead of
// silently reporting green. CI wires a `redis:` service and sets
// EVENT_BUS_URL for exactly this job (see .github/workflows/ci.yml).
import assert from "node:assert/strict";
import test from "node:test";
import net from "node:net";
import crypto from "node:crypto";
import { createEventEnvelope } from "@ayzen/events";
import { createRedisEventBus } from "../src/index.mjs";

const url = process.env.EVENT_BUS_URL ?? process.env.REDIS_TEST_URL;

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

test("a consumer killed mid-processing does not lose or double-process its event", async (t) => {
  if (!(await redisReachable(url))) {
    t.skip("No reachable Redis (set EVENT_BUS_URL / REDIS_TEST_URL) — skipping live chaos test");
    return;
  }

  const namespace = `ayzen:events:chaos:${crypto.randomUUID()}`;
  const eventType = "workflow.started";
  const claimIdleMs = 250;

  // Consumer A: reads the message (which marks it pending-for-A in the
  // group) but never acks it, then goes away — simulating a process that
  // dies mid-handler, after delivery but before acknowledgement.
  const seenByA = [];
  const busA = createRedisEventBus({ url, namespace, consumerGroup: "chaos-group", consumer: "consumer-a", claimIdleMs });
  const stuck = new Promise(() => {}); // never resolves: models a crashed handler
  busA.subscribe(eventType, async (envelope) => {
    seenByA.push(envelope.eventId);
    await stuck;
  });

  const envelope = createEventEnvelope({ eventType, payload: { executionId: "chaos-a4" } });
  await busA.publish(envelope);

  // Give A a moment to actually pick the message up (XREADGROUP), then "kill"
  // it. Because the handler never resolved, the entry is still pending and
  // unacked in the consumer group — that pending, unacked state is the crash.
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(seenByA.length, 1, "consumer A should have received the event before being killed");
  busA.close();

  // Consumer B comes up after A's crash and must reclaim the abandoned,
  // still-pending delivery once it has been idle past claimIdleMs.
  const processedByB = [];
  const busB = createRedisEventBus({ url, namespace, consumerGroup: "chaos-group", consumer: "consumer-b", claimIdleMs });
  busB.subscribe(eventType, async (envelope) => {
    processedByB.push(envelope.eventId);
  });

  const deadline = Date.now() + 5_000;
  while (processedByB.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  busB.close();

  assert.equal(processedByB.length, 1, "the event must be reclaimed and processed exactly once after the owning consumer dies");
  assert.equal(processedByB[0], envelope.eventId, "the reclaimed event must be the same one consumer A never acked");

  const deadLetters = await busB.deadLetters();
  assert.equal(
    deadLetters.filter((entry) => entry.eventId === envelope.eventId).length,
    0,
    "a successfully reclaimed-and-processed event must not also land in the DLQ",
  );
});

test("a poison message is quarantined to the DLQ after maxAttempts, not retried forever", async (t) => {
  if (!(await redisReachable(url))) {
    t.skip("No reachable Redis (set EVENT_BUS_URL / REDIS_TEST_URL) — skipping live chaos test");
    return;
  }

  const namespace = `ayzen:events:chaos:${crypto.randomUUID()}`;
  const eventType = "workflow.started";
  const maxAttempts = 2;

  let attempts = 0;
  const bus = createRedisEventBus({ url, namespace, consumerGroup: "poison-group", consumer: "poison-consumer", maxAttempts });
  bus.subscribe(eventType, async () => {
    attempts += 1;
    throw new Error("always fails");
  });

  const envelope = createEventEnvelope({ eventType, payload: { executionId: "chaos-poison" } });
  await bus.publish(envelope);

  const deadline = Date.now() + 8_000;
  let deadLetters = [];
  while (Date.now() < deadline) {
    deadLetters = (await bus.deadLetters()).filter((entry) => entry.eventId === envelope.eventId);
    if (deadLetters.length > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  bus.close();

  assert.equal(deadLetters.length, 1, "a handler that always throws must be quarantined to the DLQ, not retried forever");
  assert.ok(attempts >= maxAttempts, `expected at least ${maxAttempts} attempts before quarantine, saw ${attempts}`);
});
