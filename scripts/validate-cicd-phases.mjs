import fs from "node:fs";

const failures = [];
const required = [
  ".github/CODEOWNERS",
  ".github/pull_request_template.md",
  ".github/workflows/ci.yml",
  ".github/workflows/security.yml",
  ".github/workflows/release.yml",
  ".github/workflows/audit.yml",
  ".github/workflows/reusable-service.yml",
  "infrastructure/deployment/service-catalog.json",
  "infrastructure/deployment/promotion-policy.json",
  "scripts/detect-affected.mjs",
];
for (const file of required) if (!fs.existsSync(file)) failures.push(`Missing CI/CD evidence: ${file}`);
const read = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    failures.push(`${file}: ${error.message}`);
    return {};
  }
};
const readText = (file) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    failures.push(`${file}: ${error.message}`);
    return "";
  }
};
const catalog = read("infrastructure/deployment/service-catalog.json");
const promotion = read("infrastructure/deployment/promotion-policy.json");
const ci = readText(".github/workflows/ci.yml");
const release = readText(".github/workflows/release.yml");
const security = readText(".github/workflows/security.yml");
const reusable = readText(".github/workflows/reusable-service.yml");

for (const marker of ["fromJSON(needs.affected.outputs.services)", "pnpm install --frozen-lockfile", "validate-phase-1-15", "validate-phase-16-25", "validate-platform-phases", "validate-maturity-phases"]) {
  if (!ci.includes(marker)) failures.push(`CI workflow missing ${marker}`);
}
for (const marker of ["docker/build-push-action", "provenance: true", "sbom: true", "promotion-gate", "IMAGE_DIGEST"]) {
  if (!release.includes(marker)) failures.push(`Release workflow missing ${marker}`);
}
for (const marker of ["pnpm audit", "Secret pattern scan", "JavaScript syntax scan", "validate-domain-boundaries"]) {
  if (!security.includes(marker)) failures.push(`Security workflow missing ${marker}`);
}
for (const marker of ["workflow_call", "inputs:", "docker build", "validate-cloud-phases"]) {
  if (!reusable.includes(marker)) failures.push(`Reusable service workflow missing ${marker}`);
}
for (const gate of ["affected-build", "database-migrations", "event-contracts", "workflow-definitions", "telegram-registry", "container-scan", "staging-smoke", "health-check"]) {
  if (!promotion.requiredGates?.includes(gate)) failures.push(`Promotion policy missing gate: ${gate}`);
}
for (const deployable of catalog.deployables ?? []) {
  if (!deployable.owner || !deployable.package || !deployable.source || !deployable.rollback) {
    failures.push(`Deployable is missing release metadata: ${deployable.name}`);
  }
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`CI/CD phases 10–30 validation passed (${catalog.deployables.length} deployables)`);