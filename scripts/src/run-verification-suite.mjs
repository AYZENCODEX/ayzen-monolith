import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const directory = path.resolve("src");
// G1: widened from `oidc|policy` to also match the `test-sylo-oidc-*.ts`
// family (client-side OIDC login/cutover suites) — these were previously
// invisible to this glob (their filename prefix is "sylo-oidc", not "oidc"),
// so a regression in any of them could land without failing this suite or
// security.yml's `check:verification` step.
const files = fs.readdirSync(directory)
  .filter((file) => /^test-(oidc|sylo-oidc|policy)-.+\.ts$/.test(file))
  .sort();
const results = files.map((file) => {
  const result = spawnSync("pnpm", ["exec", "tsx", path.join("src", file)], { encoding: "utf8", stdio: "pipe" });
  return { file, passed: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().slice(-1_000) };
});
console.log(JSON.stringify({ total: results.length, passed: results.filter((result) => result.passed).length, failed: results.filter((result) => !result.passed).map((result) => result.file) }, null, 2));
if (results.some((result) => !result.passed)) process.exit(1);