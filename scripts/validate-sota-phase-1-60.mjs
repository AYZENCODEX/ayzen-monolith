#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const failures = [];
const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(path.join(root, file), "utf8")); }
  catch (error) { failures.push(`${file}: ${error.message}`); return undefined; }
};
const exists = (file, label) => {
  if (!fs.existsSync(path.join(root, file))) failures.push(`Missing ${label}: ${file}`);
};

const manifest = readJson("infrastructure/platform/sota-phase-1-60.json");
const expected = Array.from({ length: 60 }, (_, index) => index + 1);
if (manifest?.phaseRange?.join(",") !== "1,60") failures.push("SOTA manifest must cover phases 1 through 60");
if (manifest?.phases?.map(({ phase }) => phase).join(",") !== expected.join(",")) failures.push("SOTA manifest must contain every phase 1–60 exactly once and in order");
for (const phase of manifest?.phases ?? []) for (const evidence of phase.evidence ?? []) exists(evidence, `phase ${phase.phase} evidence`);

const source = (file) => fs.readFileSync(path.join(root, file), "utf8");
for (const file of [
  "packages/auth-client/src/index.mjs",
  "packages/event-client/src/identity.mjs",
  "packages/event-client/src/index.mjs",
  "packages/rate-limit/src/index.mjs",
  "packages/service-runtime/src/index.mjs",
  "services/ai/src/index.mjs",
  "services/notification/providers/index.mjs",
  "services/notification/src/index.mjs",
  "services/vault/src/index.mjs",
  "services/workflow/src/index.mjs",
]) {
  exists(file, "SOTA control");
  if (fs.existsSync(path.join(root, file)) && spawnSync(process.execPath, ["--check", file], { encoding: "utf8" }).status !== 0) failures.push(`Syntax check failed: ${file}`);
}
const auth = source("packages/auth-client/src/index.mjs");
for (const marker of ["createStepUpToken", "verifyStepUpToken", "x-ayzen-method", "x-ayzen-audience"]) if (!auth.includes(marker)) failures.push(`Auth binding control missing: ${marker}`);
const runtime = source("packages/service-runtime/src/index.mjs");
for (const marker of ["TENANT_SCOPE_MISMATCH", "TENANT_SCOPE_NOT_VERIFIED", "RATE_LIMIT_STORE_NOT_CONFIGURED"]) if (!runtime.includes(marker)) failures.push(`Runtime isolation control missing: ${marker}`);
const vault = source("services/vault/src/index.mjs");
if (vault.includes("process.env.SYLO_MASTER_KEY ?? crypto.randomUUID()")) failures.push("Vault still has an ephemeral master-key fallback");
for (const [file, markers] of [
  ["services/ai/src/index.mjs", ["verifyStepUpToken", "ai.sensitive-action"]],
  ["services/notification/src/index.mjs", ["TENANT_OVERRIDE_REJECTED", "requireTenantScope"]],
  ["services/workflow/src/index.mjs", ["APPROVAL_CAPABILITY_REQUIRED", "APPROVAL_TENANT_MISMATCH"]],
  ["packages/rate-limit/src/index.mjs", ["ON CONFLICT", "createPostgresQuotaStore"]],
]) for (const marker of markers) if (!source(file).includes(marker)) failures.push(`${file} missing SOTA marker: ${marker}`);
const eventClient = source("packages/event-client/src/index.mjs");
if (!eventClient.includes("NODE_ENV") || !eventClient.includes("noopAllowed")) failures.push("EventBus NOOP lockdown is missing");

const report = {
  schemaVersion: 1,
  roadmap: "sota-phase-1-60",
  generatedAt: new Date().toISOString(),
  repositoryStatus: failures.length ? "failed" : "implemented",
  phases: manifest?.phases?.length ?? 0,
  externalGates: manifest?.externalGates ?? [],
  failures,
};
fs.mkdirSync(path.join(root, "reports/certification"), { recursive: true });
fs.writeFileSync(path.join(root, "reports/certification/sota-phase-1-60.json"), `${JSON.stringify(report, null, 2)}\n`);
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`SOTA Phase 1–60 repository validation passed (${report.phases} phases; external production gates remain explicit)`);