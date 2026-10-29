import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const failures = [];
const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    failures.push(`${file}: ${error.message}`);
    return undefined;
  }
};
const exists = (file) => {
  if (!fs.existsSync(file)) failures.push(`Missing cloud phase evidence: ${file}`);
  return fs.existsSync(file);
};

const catalog = readJson("infrastructure/deployment/service-catalog.json");
const runtime = readJson("infrastructure/deployment/runtime-definition.json");
const promotion = readJson("infrastructure/deployment/promotion-policy.json");
const env = readJson("infrastructure/deployment/environment.schema.json");

for (const file of [
  ".dockerignore",
  "infrastructure/docker/Dockerfile",
  "infrastructure/deployment/service-catalog.json",
  "infrastructure/deployment/runtime-definition.json",
  "infrastructure/deployment/promotion-policy.json",
  "infrastructure/deployment/environment.schema.json",
  "infrastructure/iac/README.md",
  "infrastructure/staging/smoke.sh",
  ".github/workflows/ci.yml",
  ".github/workflows/security.yml",
  ".github/workflows/release.yml",
  "scripts/detect-affected.mjs",
  "scripts/release-manifest.mjs",
  "scripts/cloud-smoke.mjs",
]) exists(file);

const names = new Set();
for (const deployable of catalog?.deployables ?? []) {
  if (names.has(deployable.name)) failures.push(`Duplicate deployable: ${deployable.name}`);
  names.add(deployable.name);
  for (const field of ["name", "package", "source", "owner", "kind", "port", "health", "readiness", "metrics", "rollback"]) {
    if (deployable[field] === undefined || deployable[field] === "") failures.push(`${deployable.name}: missing ${field}`);
  }
  const packageFile = path.join(deployable.source, "package.json");
  if (!exists(packageFile)) continue;
  const packageJson = readJson(packageFile);
  if (!packageJson?.scripts?.start) failures.push(`${deployable.name}: package has no start script`);
  const entry = path.join(deployable.source, "src/index.mjs");
  if (deployable.name !== "monolith" && !exists(entry)) continue;
  if (deployable.name !== "monolith") {
    const source = fs.readFileSync(entry, "utf8");
    const usesRuntime = source.includes("createServiceServer");
    const implementsGatewayProbes = deployable.name === "api-gateway"
      && source.includes('"/health"')
      && source.includes('"/ready"')
      && source.includes('"/metrics"');
    if (!usesRuntime && !implementsGatewayProbes) failures.push(`${deployable.name}: does not use the standard service runtime`);
  }
}

for (const field of ["allowSharedRuntime", "neverAssumeOneServerPerService"]) {
  if (runtime?.costPolicy?.[field] !== true) failures.push(`runtime-definition: cost policy ${field} must be true`);
}
for (const gate of promotion?.requiredGates ?? []) {
  if (typeof gate !== "string" || !gate.length) failures.push("promotion-policy: invalid required gate");
}
if (!env?.profiles?.production?.requiredAnyOf?.length) failures.push("environment schema: production secret requirements are missing");

const dockerfile = fs.readFileSync("infrastructure/docker/Dockerfile", "utf8");
for (const marker of ["FROM node:20-bookworm-slim AS build", "FROM node:20-bookworm-slim AS runtime", "USER node", "HEALTHCHECK", "pnpm prune --prod"]) {
  if (!dockerfile.includes(marker)) failures.push(`Dockerfile missing standardization marker: ${marker}`);
}

const workflowFiles = [".github/workflows/ci.yml", ".github/workflows/security.yml", ".github/workflows/release.yml"];
for (const file of workflowFiles) {
  if (!fs.existsSync(file)) continue;
  const source = fs.readFileSync(file, "utf8");
  if (!source.includes("permissions:")) failures.push(`${file}: explicit permissions are required`);
  if (!source.includes("actions/checkout@")) failures.push(`${file}: checkout action is missing`);
}

for (const file of ["scripts/detect-affected.mjs", "scripts/release-manifest.mjs", "scripts/cloud-smoke.mjs", "scripts/validate-env.mjs"]) {
  if (!fs.existsSync(file)) continue;
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) failures.push(`${file}: syntax check failed: ${result.stderr}`);
}

const secretLike = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|AKIA[0-9A-Z]{16}|(?:password|secret|token)\s*[:=]\s*["'][^$<][^"']{8,}/i;
for (const file of [".github/workflows/ci.yml", ".github/workflows/security.yml", ".github/workflows/release.yml", "infrastructure/deployment/service-catalog.json", "infrastructure/deployment/runtime-definition.json"]) {
  if (fs.existsSync(file) && secretLike.test(fs.readFileSync(file, "utf8"))) failures.push(`${file}: possible credential material`);
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`Cloud phases 11–30 validation passed (${catalog.deployables.length} deployables)`);