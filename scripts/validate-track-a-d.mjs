#!/usr/bin/env node

import assert from "node:assert/strict";
import { createEventEnvelope } from "../packages/events/src/index.mjs";
import { createInMemoryEventBus } from "../packages/event-client/src/index.mjs";
import { createWorkflowExecutor } from "../packages/workflow/src/index.mjs";
import { listTelegramCommands } from "../packages/capabilities/src/index.mjs";
import fs from "node:fs";

const bus = createInMemoryEventBus();
let delivered = 0;
bus.subscribe("workflow.started", async () => { delivered += 1; });
await bus.publish(createEventEnvelope({
  eventType: "workflow.started",
  payload: { executionId: "track-a-d" },
}));
assert.equal(delivered, 1, "EventBus did not deliver a registered event");
assert.equal(bus.deadLetters().length, 0, "EventBus produced an unexpected dead letter");

const published = [];
const executor = createWorkflowExecutor({
  publish: async (event) => { published.push(event); },
  http: async () => ({ ok: true, status: 200, json: async () => ({ http: true }) }),
  approval: async () => ({ approved: true }),
  worker: async ({ step }) => ({ worker: step.id }),
});
const workflow = await executor.run({
  id: "track-a-d-workflow",
  version: 1,
  owner: "platform",
  steps: [
    { id: "http", type: "http", url: "https://example.invalid", timeoutMs: 1_000 },
    { id: "event", type: "event", eventType: "workflow.started" },
    { id: "delay", type: "delay", delayMs: 1 },
    { id: "approval", type: "approval" },
    { id: "condition", type: "condition", when: true },
    { id: "worker", type: "worker", action: "track-a-d" },
  ],
});
assert.equal(workflow.run.status, "COMPLETED", "Workflow did not reach a terminal success state");
assert.equal(published.length, 1, "Workflow event step did not publish");
assert.equal(Object.keys(workflow.values).length, 6, "Workflow did not execute every step type");

const catalog = JSON.parse(fs.readFileSync("infra/event-catalog/catalog.json", "utf8"));
assert.ok(catalog.events.every((entry) => entry.consumers?.length), "Event catalog contains an event without consumers");
assert.ok(listTelegramCommands().length >= 50, "Telegram command registry is unexpectedly incomplete");
const telegramRoute = fs.readFileSync("artifacts/api-server/src/routes/telegram.ts", "utf8");
assert.ok(telegramRoute.includes("TELEGRAM_ADAPTERS[envelope.botKey]"), "Telegram gateway is not adapter-dispatched");
assert.ok(fs.readFileSync("apps/worker/src/index.mjs", "utf8").includes("createRedisEventBus"), "Worker is not connected to the broker");

for (const route of ["/telegram/gateway/failures", "/telegram/bots"]) {
  const declaration = telegramRoute.split("\n").find((line) => line.startsWith(`router.get("${route}"`));
  assert.ok(declaration, `${route} route declaration not found`);
  assert.ok(declaration.includes("requireAdmin"), `${route} must be admin-gated`);
}
console.log("Track A-D validation passed: broker contract, workflow execution, worker wiring, catalog, and Telegram adapter dispatch.");