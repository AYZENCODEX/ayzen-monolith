import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("SOTA Phase 1–60 repository gate passes without weakening external gates", () => {
  const result = spawnSync(process.execPath, ["scripts/validate-sota-phase-1-60.mjs"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /60 phases/);
  assert.match(result.stdout, /external production gates remain explicit/);
});