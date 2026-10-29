import fs from "node:fs";
import { spawnSync } from "node:child_process";

const failures = [];
const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { failures.push(`${file}: ${error.message}`); return undefined; }
};
const exists = (file) => {
  if (!fs.existsSync(file)) failures.push(`Missing roadmap evidence: ${file}`);
  return fs.existsSync(file);
};

for (const file of [
  "docs/architecture/phase-0-completion.md",
  "docs/architecture/phase-1-11-implementation.md",
  "docs/architecture/phase-11-30-implementation.md",
  "infrastructure/platform/domain-contract-registry.json",
  "infrastructure/platform/api-contract-registry.json",
  "infrastructure/platform/endpoint-registry.json",
  "infrastructure/platform/telegram-bot-contract.json",
  "packages/endpoint-registry/src/index.mjs",
  "packages/admin-data/src/index.mjs",
  "packages/admin-policy/src/index.mjs",
]) exists(file);

const domains = readJson("infrastructure/platform/domain-contract-registry.json");
const api = readJson("infrastructure/platform/api-contract-registry.json");
const endpoints = readJson("infrastructure/platform/endpoint-registry.json");
const telegram = readJson("infrastructure/platform/telegram-bot-contract.json");

if (domains?.policy?.defaultDeny !== true) failures.push("Domain contract registry must be default deny");
if (domains?.policy?.databaseAccess !== "owner-mediated") failures.push("Domain contract registry must require owner-mediated database access");
if (!Array.isArray(domains?.domains) || domains.domains.length < 12) failures.push("Domain contract registry is incomplete");
for (const domain of domains?.domains ?? []) {
  for (const field of ["name", "owner", "data", "api", "events"]) {
    if (!domain[field] || (Array.isArray(domain[field]) && domain[field].length === 0)) failures.push(`Domain ${domain.name ?? "unknown"} is missing ${field}`);
  }
}
for (const field of ["version", "source", "responseEnvelope", "requiredRequestContext", "requiredWriteControls"]) {
  if (!api?.[field]) failures.push(`API contract registry is missing ${field}`);
}
for (const field of ["version", "source", "strictModeEnv", "registryModule", "requiredFields"]) {
  if (!endpoints?.[field]) failures.push(`Endpoint registry is missing ${field}`);
}
if (!Array.isArray(telegram?.bots) || telegram.bots.length !== 9) failures.push("Telegram contract must include all eight product bots plus Admin");
if (telegram?.callback?.algorithm !== "HMAC-SHA256" || telegram?.callback?.singleUse !== true) failures.push("Telegram callbacks must be signed and single-use");
if (telegram?.session?.mustBind?.length !== 3) failures.push("Telegram sessions must bind bot, user, and workspace");
const botKeys = new Set((telegram?.bots ?? []).map((bot) => bot.key));
if (botKeys.size !== 9 || !["ayzenx", "warde", "verve", "ryft", "sylo", "skarn", "zynth", "wisp", "admin"].every((key) => botKeys.has(key))) {
  failures.push("Telegram contract must cover every product bot and the separate Admin bot");
}
for (const bot of telegram?.bots ?? []) {
  if (!Array.isArray(bot.commands) || bot.commands.length < 5 || new Set(bot.commands).size !== bot.commands.length) {
    failures.push(`Telegram bot ${bot.key} must have a unique expanded command surface`);
  }
}
if (!Array.isArray(readJson("infrastructure/platform/telegram-command-registry.json")?.commands)) failures.push("Telegram command registry is missing commands");
const commandRegistry = readJson("infrastructure/platform/telegram-command-registry.json");
const registeredCommandKeys = new Set((commandRegistry?.commands ?? []).map((item) => `${item.bot}:${item.command}`));
for (const bot of telegram?.bots ?? []) {
  for (const command of bot.commands ?? []) {
    if (!registeredCommandKeys.has(`${bot.key}:${command}`)) failures.push(`Telegram command registry is missing ${bot.key}:${command}`);
  }
}
if ((commandRegistry?.commands ?? []).length < 70) failures.push("Telegram command registry must include the expanded product and Admin command surfaces");

const endpointSource = fs.existsSync("packages/endpoint-registry/src/index.mjs") ? fs.readFileSync("packages/endpoint-registry/src/index.mjs", "utf8") : "";
for (const marker of ["ENDPOINT_REGISTRY", "validateEndpointDefinition", "resolveEndpoint", "retry", "idempotency", "audit"]) {
  if (!endpointSource.includes(marker)) failures.push(`Endpoint registry missing ${marker}`);
}
const adminDataSource = fs.existsSync("packages/admin-data/src/index.mjs") ? fs.readFileSync("packages/admin-data/src/index.mjs", "utf8") : "";
for (const marker of ["ADMIN_DATA_RESOURCES", "authorizeAdminDataAction", "validateAdminQuery", "validateAdminMutation", "deleteEnabled: false"]) {
  if (!adminDataSource.includes(marker)) failures.push(`Admin data governance missing ${marker}`);
}
const adminPolicySource = fs.existsSync("packages/admin-policy/src/index.mjs") ? fs.readFileSync("packages/admin-policy/src/index.mjs", "utf8") : "";
for (const marker of ["authorizeAdminAction", "createBreakGlassManager", "BREAK_GLASS_REASON_AND_CONFIRMATION_REQUIRED", "crypto.randomUUID"]) {
  if (!adminPolicySource.includes(marker)) failures.push(`Admin policy missing ${marker}`);
}
const adminServiceSource = fs.existsSync("services/admin/src/index.mjs") ? fs.readFileSync("services/admin/src/index.mjs", "utf8") : "";
for (const marker of ["ADMIN_STATE_PATH", "ADMIN_AUDIT_PATH", "/api/admin/data/query", "/api/admin/data/mutate", "/api/admin/break-glass", "persistState"]) {
  if (!adminServiceSource.includes(marker)) failures.push(`Admin service missing ${marker}`);
}
const telegramSource = fs.existsSync("packages/telegram/src/index.mjs") ? fs.readFileSync("packages/telegram/src/index.mjs", "utf8") : "";
for (const marker of ["createTelegramCallback", "verifyTelegramCallback", "createTelegramSession", "assertTelegramSession"]) {
  if (!telegramSource.includes(marker)) failures.push(`Telegram platform contract missing ${marker}`);
}

const syntaxFiles = [
  "packages/contracts/src/index.mjs",
  "packages/events/src/index.mjs",
  "packages/audit/src/index.mjs",
  "packages/capabilities/src/index.mjs",
  "packages/authorization/src/index.mjs",
  "packages/telegram/src/index.mjs",
  "packages/domain-boundaries/src/index.mjs",
  "packages/endpoint-registry/src/index.mjs",
  "packages/admin-data/src/index.mjs",
  "packages/admin-policy/src/index.mjs",
  "apps/api-gateway/src/index.mjs",
  "apps/telegram-gateway/src/index.mjs",
  "services/admin/src/index.mjs",
  "services/marketplace/src/index.mjs",
];
for (const file of syntaxFiles) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) failures.push(`${file}: syntax check failed: ${result.stderr}`);
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("Roadmap phases 0–30 contract and governance validation passed");