import fs from "node:fs";

const required = [
  "docs/architecture/current-state.md",
  "docs/architecture/domain-map.md",
  "docs/architecture/dependency-map.md",
  "docs/architecture/data-flow.md",
  "docs/architecture/security-boundary.md",
  "docs/architecture/migration-plan.md",
  "docs/inventory/routes.md",
  "docs/inventory/database.md",
  "docs/inventory/integrations.md",
  "docs/architecture/phase-1-10-implementation.md",
  "packages/events/src/index.mjs",
  "packages/telegram/src/index.mjs",
  "apps/telegram-gateway/src/index.mjs",
  "artifacts/api-server/src/lib/event-bus/event-registry.ts",
  "artifacts/api-server/src/lib/telegram-gateway.ts",
];

const missing = required.filter((file) => !fs.existsSync(file));
if (missing.length) {
  console.error(missing.map((file) => `Missing phase 1–10 evidence: ${file}`).join("\n"));
  process.exit(1);
}
console.log(`Phase 1–10 evidence present (${required.length} files)`);