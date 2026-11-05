import assert from "node:assert/strict";
import test from "node:test";
import { MODULES, MODULE_IDS, getModule, getModuleIdForPath, getModulesByOrder } from "../src/index.mjs";

test("eight modules with unique ids, uid prefixes, hosts and orders", () => {
  assert.equal(MODULES.length, 8);
  for (const key of ["id", "uidPrefix", "defaultHost", "hostEnv", "order"]) {
    assert.equal(new Set(MODULES.map((m) => m[key])).size, 8, `${key} must be unique`);
  }
  for (const m of MODULES) assert.match(m.uidPrefix, /^[A-Z]{3}$/);
});

test("no routePrefix is claimed by two modules", () => {
  const seen = new Map();
  for (const m of MODULES) for (const p of m.routePrefixes) {
    assert.equal(seen.has(p), false, `${p} claimed by ${seen.get(p)} and ${m.id}`);
    seen.set(p, m.id);
  }
});

test("/admin/team-vault belongs to sylo, not warde", () => {
  assert.equal(getModuleIdForPath("/admin/team-vault"), "sylo");
  assert.equal(getModuleIdForPath("/admin/teams/1"), "warde");
});

test("path resolution and ordering", () => {
  assert.equal(getModuleIdForPath("/finance/receipt/abc"), "fyra");
  assert.equal(getModuleIdForPath("/projects?rollup=x"), "skarn");
  assert.equal(getModuleIdForPath("/nope"), null);
  assert.deepEqual(getModulesByOrder().map((m) => m.id), ["sylo", "ryft", "fyra", "wisp", "verve", "skarn", "zynth", "warde"]);
  assert.equal(getModule("zynth")?.homePath, "/assistant");
  assert.equal(MODULE_IDS.length, 8);
});

test("registry is frozen", () => {
  assert.throws(() => { "use strict"; MODULES.push({}); });
  assert.throws(() => { "use strict"; MODULES[0].routePrefixes.push("/x"); });
});
