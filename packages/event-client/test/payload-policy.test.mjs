// Phase H10.2 — Season 2 finding #9's other half: `config/eventbus/security.json`'s
// `restrictedPayloads` (`["credentials", "tokens", "private-keys"]`) and
// `sensitiveEventsRequireAudit` were validated for shape and read by
// nothing else at runtime, same as `defaultDeny`/identity was before
// H10.1. This exercises the runtime consumer added in `src/index.mjs`
// (`enforcePayloadPolicy` / `recordEventAudit`), driven through
// `createInMemoryEventBus` directly — fast, deterministic, no network —
// the same way H10.1's own identity-gate tests do.
import test from "node:test";
import assert from "node:assert/strict";
import { createEventEnvelope, isSensitiveEventType } from "@ayzen/events";
import { createInMemoryEventBus } from "../src/index.mjs";
import { redactRestrictedPayload, payloadHasRestrictedKeys } from "../src/payload-policy.mjs";

function envelope(overrides = {}) {
  return createEventEnvelope({
    eventType: "workflow.started",
    payload: { runId: "run_1" },
    ...overrides,
  });
}

function captureConsoleLog() {
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(line);
  return {
    lines,
    restore() { console.log = original; },
  };
}

test("H10.2: a payload with a restricted-shaped key is redacted before it lands on the bus", async () => {
  const bus = createInMemoryEventBus({ service: "finance" });
  bus.subscribe("finance.transaction.created", () => {});
  const published = await bus.publish(envelope({
    eventType: "finance.transaction.created",
    payload: { amount: 100, apiToken: "shhh", nested: { privateKey: "0xdead" }, refreshTokens: ["a", "b"] },
  }));
  assert.equal(published.payload.apiToken, "[redacted]");
  assert.equal(published.payload.nested.privateKey, "[redacted]");
  assert.equal(published.payload.refreshTokens, "[redacted]");
  assert.equal(published.payload.amount, 100, "fields that don't match a restricted name are left alone");
});

test("H10.2: a payload with no restricted keys passes through unchanged", async () => {
  const bus = createInMemoryEventBus({ service: "workflow" });
  const published = await bus.publish(envelope({ payload: { runId: "run_1", status: "started" } }));
  assert.deepEqual(published.payload, { runId: "run_1", status: "started" });
});

test("H10.2: publishing a sensitive event type writes exactly one audit line by default", async () => {
  assert.equal(isSensitiveEventType("finance.transaction.created"), true);
  const capture = captureConsoleLog();
  try {
    const bus = createInMemoryEventBus({ service: "finance" });
    await bus.publish(envelope({ eventType: "finance.transaction.created", payload: { amount: 5 } }));
  } finally {
    capture.restore();
  }
  const audits = capture.lines.map((line) => JSON.parse(line)).filter((entry) => entry.event === "audit.recorded");
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "event.published.sensitive");
  assert.equal(audits[0].service, "finance");
  assert.equal(audits[0].resource.eventType, "finance.transaction.created");
  assert.deepEqual(audits[0].metadata.redactedPaths, []);
  assert.equal(audits[0].metadata.sensitive, true);
});

test("H10.2: publishing a non-sensitive event with no restricted keys writes no audit line", async () => {
  assert.equal(isSensitiveEventType("workflow.started"), false);
  const capture = captureConsoleLog();
  try {
    const bus = createInMemoryEventBus({ service: "workflow" });
    await bus.publish(envelope());
  } finally {
    capture.restore();
  }
  const audits = capture.lines.map((line) => { try { return JSON.parse(line); } catch { return {}; } }).filter((entry) => entry.event === "audit.recorded");
  assert.equal(audits.length, 0);
});

test("H10.2: a non-sensitive event whose payload happens to contain a restricted key still gets audited", async () => {
  assert.equal(isSensitiveEventType("workflow.started"), false);
  const capture = captureConsoleLog();
  try {
    const bus = createInMemoryEventBus({ service: "workflow" });
    await bus.publish(envelope({ payload: { runId: "run_1", credentials: { user: "x", pass: "y" } } }));
  } finally {
    capture.restore();
  }
  const audits = capture.lines.map((line) => JSON.parse(line)).filter((entry) => entry.event === "audit.recorded");
  assert.equal(audits.length, 1);
  assert.equal(audits[0].metadata.sensitive, false, "flagged for audit because of the redaction, not because the type is sensitive");
  assert.deepEqual(audits[0].metadata.redactedPaths, ["credentials"]);
});

test("H10.2: a caller-supplied auditSink receives the record and a throwing sink never blocks the publish", async () => {
  const received = [];
  const bus = createInMemoryEventBus({
    service: "finance",
    auditSink: (record) => { received.push(record); throw new Error("downstream sink is down"); },
  });
  const published = await bus.publish(envelope({ eventType: "vault.secret.accessed", payload: { secretId: "s1" } }));
  assert.equal(published.eventType, "vault.secret.accessed");
  assert.equal(received.length, 1);
  assert.equal(received[0].resource.eventType, "vault.secret.accessed");
});

test("H10.2: audit records are hash-chained and stable (createAuditRecord contract, not re-derived)", async () => {
  const records = [];
  const bus = createInMemoryEventBus({ service: "finance", auditSink: (record) => records.push(record) });
  await bus.publish(envelope({ eventType: "finance.transaction.created", payload: { amount: 1 } }));
  await bus.publish(envelope({ eventType: "finance.transaction.created", payload: { amount: 2 } }));
  assert.equal(records.length, 2);
  assert.notEqual(records[0].hash, records[1].hash);
});

test("payload-policy: redactRestrictedPayload tolerates the config's punctuation/casing conventions", () => {
  const restricted = ["credentials", "tokens", "private-keys"];
  const { payload, redactedPaths } = redactRestrictedPayload({
    apiCredential: "x",
    accessToken: "y",
    privateKeys: ["a"],
    private_key: "z",
    safe: "kept",
  }, restricted);
  assert.deepEqual(payload, {
    apiCredential: "[redacted]",
    accessToken: "[redacted]",
    privateKeys: "[redacted]",
    private_key: "[redacted]",
    safe: "kept",
  });
  assert.equal(redactedPaths.length, 4);
});

test("payload-policy: payloadHasRestrictedKeys is a cheap pre-check that doesn't build a redacted copy", () => {
  assert.equal(payloadHasRestrictedKeys({ nested: { token: "x" } }, ["tokens"]), true);
  assert.equal(payloadHasRestrictedKeys({ nested: { fine: "x" } }, ["tokens"]), false);
});
