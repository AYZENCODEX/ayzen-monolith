import fs from "node:fs";
import { spawnSync } from "node:child_process";

const failures = [];
const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { failures.push(`${file}: ${error.message}`); return {}; }
};
const exists = (file, label = "roadmap evidence") => {
  if (!fs.existsSync(file)) failures.push(`Missing ${label}: ${file}`);
  return fs.existsSync(file);
};

const roadmap = readJson("infrastructure/platform/roadmap-30-70.json");
const phases = roadmap.phases ?? [];
const expected = Array.from({ length: 41 }, (_, index) => index + 30);
if (roadmap.phaseRange?.join(",") !== "30,70") failures.push("Roadmap must cover phases 30 through 70");
if (phases.length !== expected.length || phases.some((item, index) => item.phase !== expected[index])) {
  failures.push("Roadmap phases must contain every phase 30–70 exactly once and in order");
}
for (const phase of phases) {
  for (const file of phase.evidence ?? []) exists(file, `phase ${phase.phase} evidence`);
}

for (const file of [
  "packages/audit/src/index.mjs",
  "packages/alerting/src/index.mjs",
  "services/intelligence/src/index.mjs",
  "packages/tracing/src/index.mjs",
  "packages/telemetry/src/index.mjs",
  "packages/security/src/index.mjs",
  "packages/domain-boundaries/src/index.mjs",
  "packages/endpoint-registry/src/index.mjs",
  "packages/telegram/src/index.mjs",
  "packages/admin-data/src/index.mjs",
  "packages/admin-policy/src/index.mjs",
  "scripts/full-system-audit.mjs",
]) {
  if (exists(file)) {
    const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    if (result.status !== 0) failures.push(`${file}: syntax check failed`);
  }
}

const audit = fs.readFileSync("packages/audit/src/index.mjs", "utf8");
for (const marker of ["previousHash", "verifyChain", "redactAuditValue"]) {
  if (!audit.includes(marker)) failures.push(`Audit integrity control missing: ${marker}`);
}
const intelligence = fs.readFileSync("services/intelligence/src/index.mjs", "utf8");
for (const marker of ["INTELLIGENCE_STATE_PATH", "persistState", "api/intelligence/alerts"]) {
  if (!intelligence.includes(marker)) failures.push(`Intelligence persistence/console control missing: ${marker}`);
}
const alerting = fs.readFileSync("packages/alerting/src/index.mjs", "utf8");
for (const marker of ["deduplicated", "acknowledge", "resolve", "escalationDue"]) {
  if (!alerting.includes(marker)) failures.push(`Alert lifecycle control missing: ${marker}`);
}
const telegram = readJson("infrastructure/platform/telegram-command-registry.json");
if (telegram.adminBot?.singleOwner !== true || telegram.adminBot?.identityField !== "verifiedTelegramNumericUserId") {
  failures.push("Admin Telegram ownership controls are incomplete");
}
const promotion = readJson("infrastructure/deployment/promotion-policy.json");
if (promotion.rollback?.auditRequired !== true || promotion.immutableArtifact?.required !== true) {
  failures.push("Deployment safety controls are incomplete");
}
const retention = readJson("infrastructure/platform/retention-policy.json");
if (retention.rules?.neverLogSecrets !== true || retention.rules?.tenantScopeRequired !== true) {
  failures.push("Data governance controls are incomplete");
}
const security = readJson("infrastructure/platform/security-review.json");
if (security.rules?.highRiskGapsBlockRelease !== true || security.rules?.exceptionsRequireOwnerAndExpiry !== true) {
  failures.push("Security review release controls are incomplete");
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`Roadmap phases 30–70 validation passed (${phases.length} phases; provider-gated actions remain explicitly gated)`);