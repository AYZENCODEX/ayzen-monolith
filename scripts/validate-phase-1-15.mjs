import fs from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";

const required = [
  "docs/architecture/phase-1-15-implementation.md",
  "docs/architecture/data-ownership.md",
  "packages/contracts/src/index.mjs",
  "packages/events/src/index.mjs",
  "packages/event-client/src/index.mjs",
  "packages/auth-client/src/index.mjs",
  "packages/service-runtime/src/index.mjs",
  "packages/domain-boundaries/src/index.mjs",
  "apps/api-gateway/src/index.mjs",
  "apps/worker/src/index.mjs",
  "services/identity/src/index.mjs",
  "services/notification/src/index.mjs",
  "services/mail/src/index.mjs",
  "services/finance/src/index.mjs",
  "services/vault/src/index.mjs",
  "services/workflow/src/index.mjs",
];

const missing = required.filter((file) => !fs.existsSync(file));
if (missing.length) {
  console.error(missing.map((file) => `Missing phase 1–15 evidence: ${file}`).join("\n"));
  process.exit(1);
}

const syntaxTargets = required.filter((file) => file.endsWith(".mjs"));
for (const file of syntaxTargets) {
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, ["--check", file], { stdio: "pipe" });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stderr }));
  });
  if (result.code !== 0) {
    console.error(`Syntax check failed: ${file}\n${result.stderr}`);
    process.exit(1);
  }
}

const contracts = await import("../packages/contracts/src/index.mjs");
const events = await import("../packages/events/src/index.mjs");
const boundaries = await import("../packages/domain-boundaries/src/index.mjs");
const eventClient = await import("../packages/event-client/src/index.mjs");

const envelope = events.createEventEnvelope({
  eventType: "finance.transaction.created",
  payload: { transactionId: "validation-transaction", amountCents: 1 },
  organizationId: "validation-org",
  aggregate: { type: "finance_transaction", id: "validation-transaction" },
});
events.assertEventEnvelope(envelope);
events.validateEventOwnership(envelope, "finance");
contracts.assertTenantScope({ organizationId: "validation-org" });
boundaries.assertPublicOperation("finance", "post-transaction");

const bus = eventClient.createInMemoryEventBus();
let handled = 0;
bus.subscribe("finance.transaction.created", async () => { handled += 1; });
await bus.publish(envelope);
await bus.replay({ eventType: "finance.transaction.created" });
if (handled !== 2 || bus.metrics().deadLetters !== 0) {
  throw new Error("Event bus idempotency/replay validation failed");
}

console.log(`Phase 1–15 validation passed (${required.length} evidence files, ${syntaxTargets.length} syntax checks)`);