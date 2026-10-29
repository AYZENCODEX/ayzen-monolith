import fs from "node:fs";

const requiredFiles = [
  "PHASES_10_25_IMPLEMENTATION.md",
  "PHASES_26_40_IMPLEMENTATION.md",
  "docs/operations/staging-runbook.md",
  "docs/operations/production-runbook.md",
  "docs/operations/go-live-checklist.md",
  "docs/security/incident-response.md",
  "docs/security/data-governance.md",
  "infrastructure/monitoring/prometheus.yml",
  "infrastructure/monitoring/alerts.yml",
  "infrastructure/docker/docker-compose.yml",
];

const failures = requiredFiles
  .filter((file) => !fs.existsSync(file))
  .map((file) => `Missing production-readiness evidence: ${file}`);

const forbiddenPatterns = [
  /PRIVATE KEY-----/,
  /AKIA[0-9A-Z]{16}/,
  /(?:password|secret|token)\s*[:=]\s*["'][^$][^"']{8,}/i,
];
for (const file of requiredFiles.filter((file) => fs.existsSync(file))) {
  const source = fs.readFileSync(file, "utf8");
  if (forbiddenPatterns.some((pattern) => pattern.test(source))) {
    failures.push(`Possible credential material in readiness file: ${file}`);
  }
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`Production readiness evidence present (${requiredFiles.length} files)`);