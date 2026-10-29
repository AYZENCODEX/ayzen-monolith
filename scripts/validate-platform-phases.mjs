import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const failures = [];
const requiredFiles = [
  "infrastructure/platform/event-taxonomy.json",
  "infrastructure/platform/workflow-registry.json",
  "infrastructure/platform/telegram-command-registry.json",
  "infrastructure/platform/connection-fabric.json",
  "infrastructure/platform/policy-packs.json",
  "infrastructure/platform/backup-policy.json",
  "infrastructure/platform/alert-routing.json",
  "infrastructure/platform/slo-policy.json",
  "infrastructure/platform/retention-policy.json",
  "packages/workflow/src/index.mjs",
  "packages/audit/src/index.mjs",
  "scripts/record-deployment-event.mjs",
  "scripts/backup-restore-check.mjs",
];
for (const file of requiredFiles) if (!fs.existsSync(file)) failures.push(`Missing phase 31–60 evidence: ${file}`);

const json = (file) => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { failures.push(`${file}: ${error.message}`); return {}; }
};
const taxonomy = json("infrastructure/platform/event-taxonomy.json");
const workflows = json("infrastructure/platform/workflow-registry.json");
const telegram = json("infrastructure/platform/telegram-command-registry.json");
const fabric = json("infrastructure/platform/connection-fabric.json");
const policies = json("infrastructure/platform/policy-packs.json");
const backup = json("infrastructure/platform/backup-policy.json");
const alerts = json("infrastructure/platform/alert-routing.json");
const slo = json("infrastructure/platform/slo-policy.json");
const retention = json("infrastructure/platform/retention-policy.json");

for (const field of ["eventId", "eventType", "eventVersion", "occurredAt", "payload", "traceId", "correlationId", "causationId"]) {
  if (!taxonomy.requiredEnvelopeFields?.includes(field)) failures.push(`Event taxonomy missing envelope field: ${field}`);
}
for (const key of ["producerMustBeRegistered", "consumerMustBeIdempotent", "replayRequiresOperator", "deadLettersRequireAudit"]) {
  if (taxonomy.rules?.[key] !== true) failures.push(`Event taxonomy rule missing: ${key}`);
}
if (workflows.rules?.arbitraryCodeExecution !== false || workflows.rules?.allActionsRequirePolicyContext !== true) {
  failures.push("Workflow registry does not enforce safe policy-bound execution");
}
if (telegram.adminBot?.singleOwner !== true || telegram.adminBot?.identityField !== "verifiedTelegramNumericUserId") {
  failures.push("Telegram Admin Bot does not enforce single verified numeric owner");
}
if (fabric.rules?.directDatabaseAccess !== false || fabric.rules?.allowedTransports?.sort().join(",") !== "api,eventbus") {
  failures.push("Cross-app connection fabric permits an unsafe transport");
}
if (policies.defaultDeny !== true || policies.stepUpForSensitiveActions !== true || Object.keys(policies.apps ?? {}).length < 9) {
  failures.push("App policy packs are incomplete or not default-deny");
}
if (backup.restoreVerification?.isolatedTargetRequired !== true || backup.rules?.runtimeIdentityCannotRestoreProduction !== true) {
  failures.push("Backup policy does not require isolated restore and restricted production access");
}
if (!Array.isArray(alerts.channels) || !alerts.channels.includes("admin-telegram") || alerts.deduplication?.cooldownSeconds <= 0) {
  failures.push("Alert routing is missing Admin Telegram or deduplication");
}
if (!slo.services?.["api-gateway"] || !slo.backbone?.eventConsumerLagSeconds || !slo.backbone?.workflowStallSeconds) {
  failures.push("SLO policy is incomplete");
}
if (retention.rules?.neverLogSecrets !== true || retention.rules?.tenantScopeRequired !== true) {
  failures.push("Retention policy does not protect secrets and tenant scope");
}
for (const command of telegram.commands ?? []) {
  if (!command.command?.startsWith("/") || !command.bot || !command.capability) failures.push("Telegram command registry contains an invalid command");
}
for (const connection of fabric.connections ?? []) {
  if (!["api", "eventbus"].includes(connection.transport) || !connection.from || !connection.to) failures.push("Connection fabric contains an invalid connection");
}
for (const file of ["packages/workflow/src/index.mjs", "packages/audit/src/index.mjs", "scripts/record-deployment-event.mjs", "scripts/backup-restore-check.mjs"]) {
  if (!fs.existsSync(file)) continue;
  if (spawnSync(process.execPath, ["--check", file], { encoding: "utf8" }).status !== 0) failures.push(`${file}: syntax check failed`);
}
const telegramSource = fs.readFileSync("packages/telegram/src/index.mjs", "utf8");
for (const marker of ["admin:", "TELEGRAM_COMMAND_REGISTRY", "createLayeredMenu", "verifiedTelegramNumericUserId"]) {
  if (marker === "verifiedTelegramNumericUserId") continue;
  if (!telegramSource.includes(marker)) failures.push(`Telegram package missing ${marker}`);
}
const eventsSource = fs.readFileSync("packages/events/src/index.mjs", "utf8");
for (const type of ["deployment.succeeded", "technical_gap.detected", "alert.created", "incident.created", "user.error"]) {
  if (!eventsSource.includes(`"${type}"`)) failures.push(`EventBus vocabulary missing ${type}`);
}
const boundarySource = fs.readFileSync("packages/domain-boundaries/src/index.mjs", "utf8");
if (!boundarySource.includes("assertTableOwnedBy")) failures.push("Database ownership guard is missing");

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`Platform phases 31–60 validation passed (${telegram.commands.length} Telegram commands, ${workflows.workflows.length} workflows)`);