import fs from "node:fs";
import { execFileSync } from "node:child_process";

const catalog = JSON.parse(fs.readFileSync("infrastructure/deployment/service-catalog.json", "utf8"));
const base = process.argv.find((arg) => arg.startsWith("--base="))?.slice("--base=".length)
  ?? process.env.GITHUB_BASE_REF
  ?? "HEAD~1";

let changed;
try {
  changed = execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], { encoding: "utf8" })
    .split(/\r?\n/).filter(Boolean);
} catch {
  changed = [];
}

const all = changed.length === 0 || changed.some((file) => /^(package.json|pnpm-lock.yaml|pnpm-workspace.yaml|packages\/|lib\/|artifacts\/)/.test(file));
const affected = catalog.deployables
  .filter((deployable) => all || changed.some((file) => file === deployable.source || file.startsWith(`${deployable.source}/`)))
  .map((deployable) => deployable.name);

const result = {
  base,
  changedFiles: changed,
  allDeployables: all,
  affectedDeployables: all ? catalog.deployables.map(({ name }) => name) : affected,
  reason: all ? "shared dependency or no diff available" : "source path intersection",
};
if (process.argv.includes("--format=names")) {
  console.log(JSON.stringify(result.affectedDeployables));
} else {
  console.log(JSON.stringify(result, null, 2));
}