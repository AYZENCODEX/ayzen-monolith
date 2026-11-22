// Builds every module bundle one after another: node build/build-all-modules.mjs [sylo ryft ...]
import { spawnSync } from "node:child_process";
import { MODULE_IDS } from "@ayzen/module-registry";

const wanted = process.argv.slice(2);
const bad = wanted.filter((m) => !MODULE_IDS.includes(m));
if (bad.length) { console.error(`Unknown module(s): ${bad.join(", ")}. Valid: ${MODULE_IDS.join(", ")}`); process.exit(2); }
let failed = 0;
for (const id of wanted.length ? wanted : MODULE_IDS) {
  console.log(`\n=== build:module ${id} ===`);
  const r = spawnSync("pnpm", ["run", "build:module"], { stdio: "inherit", env: { ...process.env, VITE_MODULE: id }, shell: process.platform === "win32" });
  if (r.status !== 0) { failed++; console.error(`build:module ${id} FAILED`); }
}
process.exit(failed ? 1 : 0);
