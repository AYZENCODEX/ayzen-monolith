// Phase H10.3 — Season 2 finding #10: `config/eventbus/topology.json`'s
// 5-bus classification and `config/eventbus/routes.json`'s per-bus
// `consumers` allow-list were validated for shape and read by nothing at
// runtime. This exercises the runtime consumer added in `topology.mjs`
// (`resolveEventBus` / `authorizeCrossBusConsumption` /
// `eventBusCrossBusGateMode`) and its wiring into `createInMemoryEventBus`'s
// `subscribe()`, the same way H10.1's identity-gate tests and H10.2's
// payload-policy tests exercise their own runtime consumers — fast,
// deterministic, no network.
import test from "node:test";
import assert from "node:assert/strict";
import { createEventEnvelope } from "@ayzen/events";
import { createInMemoryEventBus } from "../src/index.mjs";
import {
  DEFAULT_BUS_ID,
  resolveEventBus,
  authorizeCrossBusConsumption,
  eventBusCrossBusGateMode,
  loadEventBusTopology,
  loadEventBusRoutes,
} from "../src/topology.mjs";

const routes = loadEventBusRoutes();
const topology = loadEventBusTopology();

test("H10.3: resolveEventBus routes identity.* onto the security bus, not the flat domain one", () => {
  assert.equal(resolveEventBus("identity.telegram.linked", routes), "security");
});

test("H10.3: resolveEventBus routes workflow.*, telegram.* and deployment.* onto their declared buses", () => {
  assert.equal(resolveEventBus("workflow.started", routes), "workflow");
  assert.equal(resolveEventBus("telegram.update.received", routes), "integration");
  assert.equal(resolveEventBus("deployment.started", routes), "platform");
});

test("H10.3: an event type with no routes.json entry falls back to the domain bus", () => {
  assert.equal(resolveEventBus("finance.transaction.created", routes), DEFAULT_BUS_ID);
  assert.equal(resolveEventBus("finance.transaction.created", routes), "domain");
});

test("H10.3: a consumer named in routes.json's consumers list is approved for that bus", () => {
  const decision = authorizeCrossBusConsumption({ consumerService: "audit", eventType: "identity.telegram.linked", topology, routes });
  assert.equal(decision.decision, "allow");
  assert.equal(decision.bus, "security");
});

test("H10.3: a consumer NOT named in routes.json's consumers list is denied for that bus", () => {
  const decision = authorizeCrossBusConsumption({ consumerService: "search", eventType: "identity.telegram.linked", topology, routes });
  assert.equal(decision.decision, "deny");
  assert.equal(decision.code, "TARGET_NOT_ALLOWED");
});

test("H10.3: an unrouted event type is open to any consumer regardless of routes.json", () => {
  const decision = authorizeCrossBusConsumption({ consumerService: "search", eventType: "finance.transaction.created", topology, routes });
  assert.equal(decision.decision, "allow");
  assert.equal(decision.code, "NOT_ROUTED");
});

test("H10.3: a consumer approved for one bus is not thereby approved for a different classified bus", () => {
  // "audit" is approved for security (identity.*), workflow (workflow.*)
  // and integration (telegram.*) per the default routes, but not for
  // platform (deployment.*) — that route's consumers are "admin" and
  // "intelligence" only.
  const decision = authorizeCrossBusConsumption({ consumerService: "audit", eventType: "deployment.started", topology, routes });
  assert.equal(decision.decision, "deny");
  assert.equal(decision.bus, "platform");
});

test("H10.3: an explicit crossBus override other than policy-required allows every consumer", () => {
  const openTopology = { ...topology, crossBus: "open" };
  const decision = authorizeCrossBusConsumption({ consumerService: "search", eventType: "identity.telegram.linked", topology: openTopology, routes });
  assert.equal(decision.decision, "allow");
  assert.equal(decision.code, "CROSS_BUS_POLICY_NOT_REQUIRED");
});

test("H10.3: eventBusCrossBusGateMode defaults to report, never enforce, when unset", () => {
  const previous = process.env.EVENT_BUS_CROSS_BUS_GATE;
  delete process.env.EVENT_BUS_CROSS_BUS_GATE;
  try {
    assert.equal(eventBusCrossBusGateMode(topology), "report");
  } finally {
    if (previous === undefined) delete process.env.EVENT_BUS_CROSS_BUS_GATE;
    else process.env.EVENT_BUS_CROSS_BUS_GATE = previous;
  }
});

test("H10.3: eventBusCrossBusGateMode turns off when the topology's own crossBus flag isn't policy-required", () => {
  const previous = process.env.EVENT_BUS_CROSS_BUS_GATE;
  delete process.env.EVENT_BUS_CROSS_BUS_GATE;
  try {
    assert.equal(eventBusCrossBusGateMode({ ...topology, crossBus: "open" }), "off");
  } finally {
    if (previous === undefined) delete process.env.EVENT_BUS_CROSS_BUS_GATE;
    else process.env.EVENT_BUS_CROSS_BUS_GATE = previous;
  }
});

test("H10.3: an unrecognized EVENT_BUS_CROSS_BUS_GATE value fails toward the safe report default", () => {
  const previous = process.env.EVENT_BUS_CROSS_BUS_GATE;
  process.env.EVENT_BUS_CROSS_BUS_GATE = "not-a-real-mode";
  try {
    assert.equal(eventBusCrossBusGateMode(topology), "report");
  } finally {
    if (previous === undefined) delete process.env.EVENT_BUS_CROSS_BUS_GATE;
    else process.env.EVENT_BUS_CROSS_BUS_GATE = previous;
  }
});

// --- wired into createInMemoryEventBus's subscribe() ---

function envelope(overrides = {}) {
  return createEventEnvelope({ eventType: "identity.telegram.linked", payload: { userId: "u1" }, ...overrides });
}

test("H10.3: under enforce, subscribe() throws for a consumer not approved for the event's bus", () => {
  const previous = process.env.EVENT_BUS_CROSS_BUS_GATE;
  process.env.EVENT_BUS_CROSS_BUS_GATE = "enforce";
  try {
    const bus = createInMemoryEventBus({ service: "search" });
    assert.throws(() => bus.subscribe("identity.telegram.linked", () => {}), (error) => error.code === "EVENT_CROSS_BUS_CONSUMPTION_DENIED");
  } finally {
    if (previous === undefined) delete process.env.EVENT_BUS_CROSS_BUS_GATE;
    else process.env.EVENT_BUS_CROSS_BUS_GATE = previous;
  }
});

test("H10.3: under enforce, subscribe() succeeds for a consumer routes.json approves for that bus", () => {
  const previous = process.env.EVENT_BUS_CROSS_BUS_GATE;
  process.env.EVENT_BUS_CROSS_BUS_GATE = "enforce";
  try {
    const bus = createInMemoryEventBus({ service: "audit" });
    assert.doesNotThrow(() => bus.subscribe("identity.telegram.linked", () => {}));
  } finally {
    if (previous === undefined) delete process.env.EVENT_BUS_CROSS_BUS_GATE;
    else process.env.EVENT_BUS_CROSS_BUS_GATE = previous;
  }
});

test("H10.3: with the gate unset (default report), an unapproved subscribe is logged, not blocked, and still receives events", async () => {
  const previous = process.env.EVENT_BUS_CROSS_BUS_GATE;
  delete process.env.EVENT_BUS_CROSS_BUS_GATE;
  try {
    const bus = createInMemoryEventBus({ service: "search" });
    let received;
    assert.doesNotThrow(() => bus.subscribe("identity.telegram.linked", (event) => { received = event; }));
    await bus.publish(envelope());
    assert.ok(received, "the handler must still run under report mode");
  } finally {
    if (previous === undefined) delete process.env.EVENT_BUS_CROSS_BUS_GATE;
    else process.env.EVENT_BUS_CROSS_BUS_GATE = previous;
  }
});

test("H10.3: EVENT_BUS_CROSS_BUS_GATE=off skips the cross-bus check entirely", () => {
  const previous = process.env.EVENT_BUS_CROSS_BUS_GATE;
  process.env.EVENT_BUS_CROSS_BUS_GATE = "off";
  try {
    const bus = createInMemoryEventBus({ service: "search" });
    assert.doesNotThrow(() => bus.subscribe("identity.telegram.linked", () => {}));
  } finally {
    if (previous === undefined) delete process.env.EVENT_BUS_CROSS_BUS_GATE;
    else process.env.EVENT_BUS_CROSS_BUS_GATE = previous;
  }
});

test("H10.3: ALLOW_EVENTBUS_NOOP=true bypasses the cross-bus gate the same way it bypasses the identity gate", () => {
  const previousGate = process.env.EVENT_BUS_CROSS_BUS_GATE;
  const previousNoop = process.env.ALLOW_EVENTBUS_NOOP;
  process.env.EVENT_BUS_CROSS_BUS_GATE = "enforce";
  process.env.ALLOW_EVENTBUS_NOOP = "true";
  try {
    const bus = createInMemoryEventBus({ service: "search" });
    assert.doesNotThrow(() => bus.subscribe("identity.telegram.linked", () => {}));
  } finally {
    if (previousGate === undefined) delete process.env.EVENT_BUS_CROSS_BUS_GATE; else process.env.EVENT_BUS_CROSS_BUS_GATE = previousGate;
    if (previousNoop === undefined) delete process.env.ALLOW_EVENTBUS_NOOP; else process.env.ALLOW_EVENTBUS_NOOP = previousNoop;
  }
});

test("H10.3: an unrouted event type's subscribe is never gated, even under enforce", () => {
  const previous = process.env.EVENT_BUS_CROSS_BUS_GATE;
  process.env.EVENT_BUS_CROSS_BUS_GATE = "enforce";
  try {
    const bus = createInMemoryEventBus({ service: "search" });
    assert.doesNotThrow(() => bus.subscribe("finance.transaction.created", () => {}));
  } finally {
    if (previous === undefined) delete process.env.EVENT_BUS_CROSS_BUS_GATE;
    else process.env.EVENT_BUS_CROSS_BUS_GATE = previous;
  }
});
