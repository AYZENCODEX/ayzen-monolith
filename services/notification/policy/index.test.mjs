import test from "node:test";
import assert from "node:assert/strict";
import { createNotificationPolicy } from "./index.mjs";
import { createProviderRegistry } from "../providers/index.mjs";

test("notification policy honors durable preference and quota maps", () => {
  const policy = createNotificationPolicy({
    preferences: new Map([["user-1", { disabledChannels: ["in-app"] }]]),
    quotas: new Map([["ayzen:in-app", { limit: 2, windowMs: 60_000 }]]),
  });

  assert.equal(policy.allows({ recipient: "user-1", channel: "in-app" }), false);
  assert.equal(policy.allows({ recipient: "user-2", channel: "in-app" }), true);
  assert.deepEqual(policy.quotaFor({ app: "ayzen", channel: "in-app" }), { limit: 2, windowMs: 60_000 });
});

test("provider registry exposes the configured delivery adapter", async () => {
  let sent = false;
  const providers = createProviderRegistry({
    providers: {
      "in-app": { async send() { sent = true; } },
    },
  });
  await providers.get("in-app").send({});
  assert.equal(sent, true);
  assert.deepEqual(providers.list(), ["in-app"]);
});