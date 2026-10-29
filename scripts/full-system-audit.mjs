import fs from "node:fs";
import { spawnSync } from "node:child_process";

const checks = fs.readdirSync("scripts")
  .filter((file) => /^validate-.+\.mjs$/.test(file))
  .sort()
  .map((file) => [file.replace(/^validate-/, "").replace(/\.mjs$/, ""), `scripts/${file}`]);
checks.push(["backup-restore-policy", "scripts/backup-restore-check.mjs"]);
checks.push(["event-catalog", "tools/event-catalog-lint.mjs"]);
checks.push(["validator-orphans", "tools/validator-coverage.mjs"]);
const results = [];
for (const [name, script] of checks) {
  const result = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: { ...process.env, ALLOW_EVENTBUS_NOOP: "true" },
  });
  results.push({
    name,
    script,
    passed: result.status === 0,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().slice(-2_000),
  });
}
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  status: results.every((result) => result.passed) ? "passed" : "failed",
  results,
  nextAction: results.every((result) => result.passed) ? "review evidence and schedule provider-backed chaos/capacity drills" : "fix failed gates before release",
};
const output = process.env.AUDIT_OUTPUT ?? "artifacts/release/full-system-audit.json";
fs.mkdirSync("artifacts/release", { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ output, status: report.status, checks: results.length }, null, 2));
if (report.status !== "passed") process.exit(1);