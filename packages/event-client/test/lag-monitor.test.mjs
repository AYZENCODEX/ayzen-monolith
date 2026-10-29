import assert from "node:assert/strict";
import test from "node:test";
import { createConsumerLagMonitor } from "../src/lag-monitor.mjs";

function fakeBus(pendingByType) {
  return {
    async consumerLag(eventType) {
      return {
        eventType,
        bus: "domain",
        stream: `ayzen:events:domain:${eventType}`,
        consumerGroup: "ayzen:events:worker",
        pending: pendingByType[eventType] ?? 0,
        minId: null,
        maxId: null,
        consumers: [],
      };
    },
  };
}

test("H11.2: a backlog under the threshold publishes nothing", async () => {
  const bus = fakeBus({ "finance.transaction.created": 3 });
  const published = [];
  const monitor = createConsumerLagMonitor({
    bus,
    eventTypes: ["finance.transaction.created"],
    threshold: 100,
    publish: (envelope) => published.push(envelope),
  });
  const readings = await monitor.checkOnce();
  assert.equal(published.length, 0);
  assert.equal(readings[0].pending, 3);
  assert.equal(monitor.isAlerted("finance.transaction.created"), false);
});

test("H11.2: a backlog at or above the threshold publishes event.consumer.lag with the offending type and pending count", async () => {
  const bus = fakeBus({ "finance.transaction.created": 150 });
  const published = [];
  const monitor = createConsumerLagMonitor({
    bus,
    eventTypes: ["finance.transaction.created"],
    threshold: 100,
    publish: (envelope) => published.push(envelope),
  });
  await monitor.checkOnce();
  assert.equal(published.length, 1);
  assert.equal(published[0].eventType, "event.consumer.lag");
  assert.equal(published[0].payload.laggingEventType, "finance.transaction.created");
  assert.equal(published[0].payload.pending, 150);
  assert.equal(published[0].payload.threshold, 100);
  assert.equal(published[0].payload.bus, "domain");
  assert.equal(monitor.isAlerted("finance.transaction.created"), true);
});

test("H11.2: a still-stuck consumer does not re-alert on every subsequent poll", async () => {
  const pendingByType = { "finance.transaction.created": 150 };
  const bus = fakeBus(pendingByType);
  const published = [];
  const monitor = createConsumerLagMonitor({
    bus,
    eventTypes: ["finance.transaction.created"],
    threshold: 100,
    publish: (envelope) => published.push(envelope),
  });
  await monitor.checkOnce();
  await monitor.checkOnce();
  await monitor.checkOnce();
  assert.equal(published.length, 1, "only the first crossing publishes an alert");
});

test("H11.2: a backlog that drains under the threshold clears the alert, and a later re-cross alerts again", async () => {
  const pendingByType = { "finance.transaction.created": 150 };
  const bus = fakeBus(pendingByType);
  const published = [];
  const monitor = createConsumerLagMonitor({
    bus,
    eventTypes: ["finance.transaction.created"],
    threshold: 100,
    publish: (envelope) => published.push(envelope),
  });
  await monitor.checkOnce();
  assert.equal(monitor.isAlerted("finance.transaction.created"), true);

  pendingByType["finance.transaction.created"] = 10;
  await monitor.checkOnce();
  assert.equal(monitor.isAlerted("finance.transaction.created"), false);
  assert.equal(published.length, 1, "draining below threshold does not itself publish anything");

  pendingByType["finance.transaction.created"] = 200;
  await monitor.checkOnce();
  assert.equal(published.length, 2, "a later re-cross of the threshold alerts again");
});

test("H11.2: each event type is tracked and alerted independently", async () => {
  const bus = fakeBus({ "finance.transaction.created": 200, "wisp.message.sent": 5 });
  const published = [];
  const monitor = createConsumerLagMonitor({
    bus,
    eventTypes: ["finance.transaction.created", "wisp.message.sent"],
    threshold: 100,
    publish: (envelope) => published.push(envelope),
  });
  const readings = await monitor.checkOnce();
  assert.equal(published.length, 1);
  assert.equal(published[0].payload.laggingEventType, "finance.transaction.created");
  assert.equal(readings.length, 2);
  assert.equal(monitor.isAlerted("wisp.message.sent"), false);
});

test("H11.2: an error reading one type's lag is logged and does not block checking the rest", async () => {
  const bus = {
    async consumerLag(eventType) {
      if (eventType === "broken.type") throw new Error("boom");
      return { eventType, bus: "domain", consumerGroup: "g", pending: 200, minId: null, maxId: null, consumers: [] };
    },
  };
  const published = [];
  const logs = [];
  const monitor = createConsumerLagMonitor({
    bus,
    eventTypes: ["broken.type", "finance.transaction.created"],
    threshold: 100,
    publish: (envelope) => published.push(envelope),
    log: (fields) => logs.push(fields),
  });
  const readings = await monitor.checkOnce();
  assert.equal(readings.length, 1);
  assert.equal(readings[0].eventType, "finance.transaction.created");
  assert.equal(published.length, 1);
  assert.equal(published[0].payload.laggingEventType, "finance.transaction.created");
  assert.ok(logs.some((entry) => entry.event === "event.consumer.lag.check.error" && entry.event_type === "broken.type"));
});

test("H11.2: a publish failure does not suppress the next poll's re-alert attempt", async () => {
  const bus = fakeBus({ "finance.transaction.created": 150 });
  let attempts = 0;
  const logs = [];
  const monitor = createConsumerLagMonitor({
    bus,
    eventTypes: ["finance.transaction.created"],
    threshold: 100,
    publish: () => {
      attempts += 1;
      if (attempts === 1) throw new Error("transport down");
    },
    log: (fields) => logs.push(fields),
  });
  await monitor.checkOnce();
  assert.equal(monitor.isAlerted("finance.transaction.created"), false, "a failed publish does not leave a false alerted state");
  await monitor.checkOnce();
  assert.equal(attempts, 2, "the next poll retries the alert instead of assuming it already fired");
  assert.equal(monitor.isAlerted("finance.transaction.created"), true);
});

test("H11.2: constructor validates its required inputs", () => {
  assert.throws(() => createConsumerLagMonitor({ eventTypes: ["x"], publish: () => {} }), /consumerLag/);
  assert.throws(() => createConsumerLagMonitor({ bus: fakeBus({}), publish: () => {} }), /eventTypes/);
});
