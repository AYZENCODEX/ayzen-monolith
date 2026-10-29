#!/usr/bin/env node
/**
 * scripts/validate-ui-circuit.mjs
 * ─────────────────────────────────────────────────────────────────────────
 * AYZEN Roadmap — Phase 05 ("UI-to-Backend Circuit") CI gate.
 *
 * Auto-discovered by scripts/full-system-audit.mjs (any scripts/validate-*.mjs
 * file), same as every other roadmap gate — no separate wiring needed there.
 *
 * Two checks, both must pass:
 *   1. artifacts/ayzen/frontend-registry.json is not stale — delegates to
 *      tools/ui-circuit-validator/build.mjs --check (routes/deadPages diff).
 *   2. The committed registry has zero critical findings (ROUTE_PAGE_UNRESOLVED,
 *      ORPHAN_API_CALL). MOCK_OR_STATIC_PAGE and DEAD_PAGE stay warnings —
 *      they need a human look (genuinely static page vs. undetected call
 *      pattern; genuinely orphaned page vs. a route this scanner missed),
 *      not an automatic block. See tools/ui-circuit-validator/build.mjs's
 *      header for what each finding code means.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const registryPath = path.join(root, "artifacts/ayzen/frontend-registry.json");

const drift = spawnSync(process.execPath, ["tools/ui-circuit-validator/build.mjs", "--check"], {
  cwd: root,
  encoding: "utf8",
});
if (drift.status !== 0) {
  console.error(drift.stdout || drift.stderr || "Frontend registry check failed.");
  process.exit(1);
}

const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
const criticals = registry.findings.filter((finding) => finding.severity === "critical");

if (criticals.length) {
  console.error(`UI circuit gate failed: ${criticals.length} critical finding(s) in artifacts/ayzen/frontend-registry.json:`);
  for (const finding of criticals) console.error(`  [${finding.code}] ${finding.path ?? finding.pageFile}`);
  process.exit(1);
}

const warnings = registry.findings.length;
console.log(`UI circuit gate passed: 0 critical findings (${warnings} warning(s): mock/static pages + dead pages, tracked but non-blocking).`);
