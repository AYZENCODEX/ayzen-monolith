import test from "node:test";
import assert from "node:assert/strict";
import { createTelegramPolicyClient, decideTelegramCommand } from "../src/policy-contract-adapter.mjs";

test("Phase 07 -- Telegram consumer client is tagged and app-scoped", () => {
  const client = createTelegramPolicyClient({ app: "ryft" });
  const result = client.decide({ capability: "finance.list-accounts", subject: "tg-1", scopes: ["finance:read"] });
  assert.equal(result.consumer, "telegram");
  assert.equal(result.app, "ryft");
  assert.equal(result.decision, "allow");
});

test("Phase 07 -- decideTelegramCommand: allow for a non-sensitive registered command", () => {
  const result = decideTelegramCommand({ command: "/balance", botKey: "ryft", auth: { subject: "tg-1", scopes: ["finance:read"] } });
  assert.equal(result.decision, "allow");
});

test("Phase 07 -- decideTelegramCommand: conditional for a sensitive command without step-up", () => {
  const result = decideTelegramCommand({ command: "/transaction", botKey: "ryft", auth: { subject: "tg-1", scopes: ["finance:write"] } });
  assert.equal(result.decision, "conditional");
  assert.equal(result.conditions[0].code, "STEP_UP_REQUIRED");
});

test("Phase 07 -- decideTelegramCommand: allow for a sensitive command with a fresh step-up", () => {
  const result = decideTelegramCommand({ command: "/transaction", botKey: "ryft", auth: { subject: "tg-1", scopes: ["finance:write"], stepUpAt: new Date().toISOString() } });
  assert.equal(result.decision, "allow");
});

test("Phase 07 -- decideTelegramCommand: unregistered command throws, is not silently denied", () => {
  assert.throws(() => decideTelegramCommand({ command: "/does-not-exist", botKey: "ryft", auth: { subject: "tg-1" } }), /is not registered/);
});

test("Phase 07 -- decideTelegramCommand: command registered for a different bot throws, is not silently denied", () => {
  assert.throws(() => decideTelegramCommand({ command: "/balance", botKey: "sylo", auth: { subject: "tg-1" } }), /TELEGRAM_COMMAND_BOT_MISMATCH|not registered/);
});
