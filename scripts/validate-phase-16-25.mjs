import fs from "node:fs";
import { spawn } from "node:child_process";

const required = [
  "docs/architecture/phase-16-25-implementation.md",
  "infrastructure/deployment/topology.yaml",
  "infrastructure/monitoring/prometheus.yml",
  "infrastructure/monitoring/alerts.yml",
  "packages/auth-client/src/index.mjs",
  "packages/reliability/src/index.mjs",
  "apps/api-gateway/src/index.mjs",
  "apps/telegram-gateway/src/index.mjs",
  "apps/worker/src/index.mjs",
  "services/ai/src/index.mjs",
  "services/intelligence/src/index.mjs",
  "services/search/src/index.mjs",
  "artifacts/api-server/src/lib/migration-registry.ts",
  "artifacts/api-server/src/lib/service-to-service-security.ts",
];

const missing = required.filter((file) => !fs.existsSync(file));
if (missing.length) {
  console.error(missing.map((file) => `Missing phase 16–25 evidence: ${file}`).join("\n"));
  process.exit(1);
}

for (const file of required.filter((file) => file.endsWith(".mjs"))) {
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

const auth = await import("../packages/auth-client/src/index.mjs");
const reliability = await import("../packages/reliability/src/index.mjs");
const events = await import("../packages/events/src/index.mjs");
const boundaries = await import("../packages/domain-boundaries/src/index.mjs");

const body = { amount: 10, currency: "USD" };
const signed = auth.createServiceRequestHeaders({
  service: "api-gateway",
  requestId: "phase16-25-request",
  body,
  secret: "phase16-25-contract-secret",
  now: 1_700_000_000_000,
});
if (!auth.verifyServiceRequestHeaders(signed, { secret: "phase16-25-contract-secret", now: 1_700_000_000_001 })) throw new Error("Internal service signature contract failed");
if (auth.verifyServiceRequestHeaders({ ...signed, "x-ayzen-body-sha256": auth.hashRequestBody({ amount: 11, currency: "USD" }) }, { secret: "phase16-25-contract-secret", now: 1_700_000_000_001 })) throw new Error("Tampered service body was accepted");

const envelope = events.createEventEnvelope({
  eventType: "ai.task.completed",
  payload: { taskId: "phase16-task", status: "completed" },
});
events.validateEventOwnership(envelope, "ai-agent");
boundaries.assertPublicOperation("search", "search");
if (typeof reliability.createBulkhead !== "function" || typeof reliability.createResilientOperation !== "function") throw new Error("Reliability primitives are missing");

const migrationSource = fs.readFileSync("artifacts/api-server/src/lib/migration-registry.ts", "utf8");
for (const gate of ["backup", "characterization", "backfill", "validation", "rollback"]) {
  if (!migrationSource.includes(`"${gate}"`)) throw new Error(`Migration gate missing: ${gate}`);
}
console.log(`Phase 16–25 validation passed (${required.length} evidence files)`);