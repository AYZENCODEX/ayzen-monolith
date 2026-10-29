import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");
const registryPath = path.join(root, "artifacts/ayzen/frontend-registry.json");

test("committed artifacts/ayzen/frontend-registry.json is fresh (matches a fresh --check build)", () => {
  const result = spawnSync(process.execPath, ["tools/ui-circuit-validator/build.mjs", "--check"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stdout || result.stderr);
});

test("committed registry has zero critical findings (ROUTE_PAGE_UNRESOLVED, ORPHAN_API_CALL)", () => {
  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  const criticals = registry.findings.filter((finding) => finding.severity === "critical");
  assert.deepEqual(criticals, []);
});

test("every route in the committed registry resolves to a page file", () => {
  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  const unresolved = registry.routes.filter((route) => route.resolution.status !== "resolved");
  assert.deepEqual(unresolved, []);
  assert.equal(registry.completeness.totalRoutes, registry.completeness.resolvedToPage);
});

test("registry schema reference and top-level shape are intact", () => {
  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  assert.equal(registry.schema, "schemas/ui-circuit/frontend-route-entry.v1.json");
  assert.ok(Array.isArray(registry.routes));
  assert.ok(Array.isArray(registry.deadPages));
  assert.ok(Array.isArray(registry.findings));
});
