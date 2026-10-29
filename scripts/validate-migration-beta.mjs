import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
const registry = readJson("migrations/beta/registry.json");
const categories = new Set(registry.categories);
const requiredGates = new Set(registry.requiredGates);
assert.deepEqual([...categories].sort(), ["architecture", "features", "infrastructure", "security"]);
for (const gate of ["backup", "characterization", "backfill", "validation", "rollback"]) {
  assert.ok(requiredGates.has(gate), `required gate missing: ${gate}`);
}
assert.equal(readJson(registry.centralWebsite.manifest).app, registry.centralWebsite.app);
const shared = readJson(registry.shared.manifest);
assert.equal(shared.scope, "workspace");
assert.equal(shared.contracts.workspace, "canonical-workspace-id");

const ids = new Set();
for (const entry of registry.apps) {
  const manifest = readJson(entry.manifest);
  assert.equal(manifest.app, entry.app);
  assert.ok(manifest.owner, `${entry.app}: owner missing`);
  assert.ok(manifest.beta?.isolationKey, `${entry.app}: beta isolation key missing`);
  assert.ok(manifest.beta?.stage, `${entry.app}: beta stage missing`);
  for (const category of categories) {
    assert.ok(Array.isArray(manifest.categories?.[category]), `${entry.app}: ${category} category missing`);
    for (const migration of manifest.categories[category]) {
      assert.ok(migration.id.startsWith(`${category}.`), `${migration.id}: category prefix missing`);
      assert.ok(migration.owner, `${migration.id}: owner missing`);
      assert.ok(Array.isArray(migration.dependsOn), `${migration.id}: dependencies missing`);
      assert.notEqual(migration.reversible, false, `${migration.id}: irreversible migration must be explicitly reviewed`);
      assert.equal(ids.has(migration.id), false, `${migration.id}: duplicate migration id`);
      ids.add(migration.id);
    }
  }
}
console.log(`Beta migration registry passed (${registry.apps.length} apps, ${ids.size} categorized entries)`);