import fs from "node:fs";
import path from "node:path";

export const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

export function readJson(relativePath) {
  const file = path.join(ROOT, relativePath);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function exists(relativePath) {
  return fs.existsSync(path.join(ROOT, relativePath));
}

export function writeReport(relativePath, report) {
  const file = path.join(ROOT, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

export function gate(name, passed, details = {}) {
  const result = { name, passed: Boolean(passed), details };
  if (!result.passed) {
    console.error(JSON.stringify(result, null, 2));
    process.exitCode = 1;
  }
  return result;
}