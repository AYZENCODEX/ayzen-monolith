/**
 * scripts/src/test-module-build.ts — W2-P2 browser-side pieces of per-module builds: which module a bundle is for, and which
 * routes it mounts. Pure. Run: npx tsx scripts/src/test-module-build.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { MODULES } from "@ayzen/module-registry";
import { buildModuleId, isRouteInBuild } from "../../artifacts/ayzen/src/lib/build-module";

test("buildModuleId: only a known module id counts; case and spaces are tolerated; anything else is the full build", () => {
  assert.equal(buildModuleId("sylo"), "sylo");
  assert.equal(buildModuleId(" Verve "), "verve");
  assert.equal(buildModuleId(undefined), null);
  assert.equal(buildModuleId(""), null);
  assert.equal(buildModuleId("central"), null);
  assert.equal(buildModuleId("__proto__"), null);
});

test("the full build mounts every route", () => {
  for (const p of ["/vault", "/finance", "/marketplace", "/projects", "/admin/users", "/dashboard"]) assert.equal(isRouteInBuild(p, null), true, p);
});

test("a module build mounts its own routes and unowned ones, never another module's", () => {
  for (const m of MODULES) for (const o of MODULES) for (const p of o.routePrefixes) {
    assert.equal(isRouteInBuild(`${p}/x`, m.id), o.id === m.id, `${m.id} on ${p}`);
  }
  for (const m of MODULES) for (const shared of ["/dashboard", "/profile", "/admin/users", "/login"]) assert.equal(isRouteInBuild(shared, m.id), true, `${m.id} ${shared}`);
});

test("route ownership agrees with the server guard (same registry decision)", async () => {
  const { decideModuleHostAccess } = await import("@ayzen/module-registry");
  for (const m of MODULES) for (const o of MODULES) for (const p of o.routePrefixes) {
    const server = decideModuleHostAccess({ module: m.id, path: p }).action === "allow";
    assert.equal(isRouteInBuild(p, m.id), server, `${m.id} ${p}`);
  }
});
