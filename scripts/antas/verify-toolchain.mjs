import fs from "node:fs";
import { spawnSync } from "node:child_process";

const failures = [];
const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
const nodeMajor = Number(process.versions.node.split(".")[0]);
const expectedNode = Number(fs.readFileSync(".nvmrc", "utf8").trim());
if (nodeMajor !== expectedNode) failures.push(`Node ${nodeMajor} is active; repository requires Node ${expectedNode}`);
if (packageJson.packageManager !== "pnpm@10.26.1") failures.push("package.json must pin pnpm@10.26.1");
if (!fs.existsSync("pnpm-lock.yaml")) failures.push("pnpm-lock.yaml is missing");
const pnpm = spawnSync("pnpm", ["--version"], { encoding: "utf8" });
if (pnpm.status !== 0 || pnpm.stdout.trim() !== "10.26.1") failures.push("active pnpm version is not 10.26.1");
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("ANTAS toolchain metadata is consistent");