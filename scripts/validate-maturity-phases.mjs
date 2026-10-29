import fs from "node:fs";
import path from "node:path";

const failures = [];
const required = [
  "infrastructure/platform/chaos-plan.json",
  "infrastructure/platform/capacity-plan.json",
  "infrastructure/platform/security-review.json",
  "infrastructure/platform/architecture-review.json",
  "infrastructure/platform/release-train.json",
  "infrastructure/platform/remediation-policy.json",
  "docs/architecture/phase-61-70-implementation.md",
  "scripts/full-system-audit.mjs",
];
for (const file of required) if (!fs.existsSync(file)) failures.push(`Missing phase 61–70 evidence: ${file}`);
const read = (file) => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { failures.push(`${file}: ${error.message}`); return {}; }
};
const chaos = read("infrastructure/platform/chaos-plan.json");
const capacity = read("infrastructure/platform/capacity-plan.json");
const security = read("infrastructure/platform/security-review.json");
const architecture = read("infrastructure/platform/architecture-review.json");
const release = read("infrastructure/platform/release-train.json");
const remediation = read("infrastructure/platform/remediation-policy.json");

if (chaos.environment !== "staging-only" || chaos.requiresSyntheticData !== true || chaos.requiresApproval !== true) failures.push("Chaos plan is not staging-only, synthetic, and approval-gated");
if (!chaos.forbidden?.includes("production") || !chaos.forbidden?.includes("destructive-database-delete")) failures.push("Chaos plan does not forbid production/destructive actions");
if (!Array.isArray(capacity.scenarios) || capacity.scenarios.length < 5 || capacity.rules?.noInventedReplicaCounts !== true) failures.push("Capacity plan is incomplete or invents scaling assumptions");
if (security.rules?.highRiskGapsBlockRelease !== true || security.rules?.exceptionsRequireOwnerAndExpiry !== true) failures.push("Security review does not block high-risk gaps or govern exceptions");
if (!Array.isArray(architecture.checks) || !architecture.checks.includes("admin-policy-boundary") || architecture.exceptionPolicy?.cannotBypassSecurity !== true) failures.push("Architecture audit does not cover Admin/security exceptions");
if (!release.rules?.buildOncePromoteDigest || !release.rules?.releaseEvidenceIsImmutable || !release.rules?.rollbackSwitchIsRecorded) failures.push("Release train is missing immutable evidence or rollback controls");
if (remediation.rules?.allowlistOnly !== true || remediation.rules?.everyActionAudited !== true || remediation.rules?.reAuditAfterAction !== true) failures.push("Remediation is not allowlisted, audited, and re-audited");
for (const forbidden of ["delete-production-data", "restore-production-backup", "promote-unapproved-artifact"]) {
  if (!remediation.forbiddenAutomaticActions?.includes(forbidden)) failures.push(`Remediation policy missing forbidden action: ${forbidden}`);
}
const auditSource = fs.readFileSync("scripts/full-system-audit.mjs", "utf8");
// full-system-audit discovers every scripts/validate-*.mjs dynamically (Roadmap C1),
// so require the discovery mechanism plus the presence of the validators it must pick up.
if (!auditSource.includes('fs.readdirSync("scripts")') || !auditSource.includes("validate-.+")) failures.push("Full-system audit does not discover validate-*.mjs validators");
for (const validator of ["validate-cloud-phases.mjs", "validate-platform-phases.mjs", "validate-maturity-phases.mjs"]) {
  if (!fs.existsSync(`scripts/${validator}`)) failures.push(`Validator missing from scripts/: ${validator}`);
}
if (!auditSource.includes("backup-restore-check.mjs")) failures.push("Full-system audit missing backup-restore-check.mjs");
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`Maturity phases 61–70 validation passed (${chaos.scenarios.length} chaos scenarios, ${capacity.scenarios.length} capacity scenarios)`);