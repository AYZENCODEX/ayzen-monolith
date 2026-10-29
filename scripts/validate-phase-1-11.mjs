import fs from "node:fs";
import { spawn } from "node:child_process";

const required = [
  "packages/authorization/src/index.mjs",
  "packages/capabilities/src/index.mjs",
  "packages/auth-client/src/index.mjs",
  "packages/domain-boundaries/src/index.mjs",
  "packages/migration/src/index.mjs",
  "packages/events/src/index.mjs",
  "packages/telegram/src/index.mjs",
  "packages/service-runtime/src/index.mjs",
  "apps/api-gateway/src/index.mjs",
  "apps/telegram-gateway/src/index.mjs",
  "docs/architecture/phase-1-11-implementation.md",
];

const missing = required.filter((file) => !fs.existsSync(file));
if (missing.length) throw new Error(`Missing phase 1–11 evidence:\n${missing.join("\n")}`);

for (const file of required.filter((file) => file.endsWith(".mjs"))) {
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, ["--check", file], { stdio: "pipe" });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stderr }));
  });
  if (result.code !== 0) throw new Error(`Syntax check failed: ${file}\n${result.stderr}`);
}

const capabilities = await import("../packages/capabilities/src/index.mjs");
const authorization = await import("../packages/authorization/src/index.mjs");
const telegram = await import("../packages/telegram/src/index.mjs");
const auth = await import("../packages/auth-client/src/index.mjs");
const boundaries = await import("../packages/domain-boundaries/src/index.mjs");
const migration = await import("../packages/migration/src/index.mjs");
const events = await import("../packages/events/src/index.mjs");

if (!capabilities.getCapability("finance.post-transaction")) throw new Error("Finance capability registry entry missing");
if (capabilities.resolveTelegramCommand("/transaction")?.capability !== "finance.post-transaction") throw new Error("Telegram capability mapping failed");
const allowed = authorization.authorizeCapability({
  capability: "finance.get-balance",
  subject: "user:validation",
  scopes: ["finance:read"],
});
if (allowed.decision !== "allow") throw new Error("Capability authorization should allow finance read");
if (authorization.authorizeCapability({ capability: "finance.post-transaction", subject: "user:validation", scopes: ["finance:write"] }).decision !== "step_up_required") {
  throw new Error("Sensitive capability must require step-up");
}
const link = auth.createTelegramIdentityLink({ userId: "user:validation", telegramUserId: 123, botKey: "ryft", verified: true });
auth.assertVerifiedTelegramLink(link);
boundaries.assertTableOwnedBy("finance", "finance_accounts");
if (boundaries.getTableOwner("finance_accounts") !== "finance") throw new Error("Database ownership registry failed");
const report = migration.createReconciliationReport({ service: "finance", sourceRows: [{ id: 1, amount: 10 }], targetRows: [{ id: 1, amount: 10 }] });
if (!report.valid || !migration.canAdvanceCutover("monolith", "dual_read", migration.REQUIRED_GATES)) throw new Error("Migration gate validation failed");
const envelope = events.createEventEnvelope({ eventType: "telegram.update.received", payload: { updateId: 1 }, aggregate: { type: "telegram_update", id: "1" } });
events.assertEventEnvelope(envelope);
const normalized = telegram.normalizeTelegramMessage({ botKey: "ryft", updateId: 1, payload: { message: { from: { id: 123 }, chat: { id: 123 }, text: "/balance" } } });
if (normalized?.capability?.capability !== "finance.get-balance") throw new Error("Telegram message normalization failed");

console.log(`Phase 1–11 validation passed (${required.length} evidence files, ${capabilities.CAPABILITY_REGISTRY.length} capabilities)`);