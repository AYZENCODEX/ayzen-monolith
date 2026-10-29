/**
 * scripts/src/test-route-oidc-scope-wiring.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Enforcement Roadmap — Track G, Phase G3: regression test for the
 * actual ROUTE WIRING, not just the middleware function.
 *
 * `test-oidc-scope-enforcement.ts` (Phase 4d-e) already covers
 * `requireOidcScope()` itself in isolation — a correct, thorough unit test
 * of the function. What nothing tested until this pass is the thing G3
 * found broken in practice: whether a given router actually PUTS that
 * function in a route's middleware chain. `routes/oidc-userinfo.ts` (4c-f)
 * imported nothing from `oidc-scope-enforcement.ts` at all and still
 * passed every existing test, because no existing test imported the real
 * `router` and inspected what Express actually registered for `GET
 * /oidc/userinfo`. This file is that missing check — for both files this
 * pass's own coverage script (`check-oidc-scope-enforcement-coverage.ts`)
 * statically checks, exercised here dynamically instead: importing the
 * REAL `router` objects and walking Express's own `router.stack`, the same
 * "drive the real thing, not a reconstruction of it" preference
 * `test-route-ownership-regression.ts` documents for its own ownership-gate
 * coverage.
 *
 * Static (this pass's coverage script) and dynamic (this file) checks
 * deliberately overlap: the static check is fast and needs no env vars at
 * all (part of `security.yml`'s main job, see `oidc:check-scope-
 * enforcement-coverage`); this one needs `DATABASE_URL` present (see below)
 * and catches anything a text-based scan could miss — e.g.
 * `requireOidcScope` imported under a different local name, or a second,
 * unguarded route quietly added to one of these files later.
 *
 * ── Why this file is named `test-route-oidc-*`, not `test-oidc-*` ─────────
 * Every existing `test-oidc-*.ts`/`test-sylo-oidc-*.ts` file is DB-free by
 * design (Phase G1's own CHANGES doc: "pure parts run for real"), and
 * `oidc:test-suite`'s glob (`./src/test-oidc-*.ts ./src/test-sylo-oidc-*.ts`)
 * is invoked in `security.yml` with no `DATABASE_URL` set — that's a load-
 * bearing invariant for anyone who runs `pnpm oidc:test-suite` locally
 * without a database. This file imports the real route files (see below),
 * which is NOT DB-free at import time, so it deliberately sits outside
 * that glob, under its own name/script/CI step, instead of silently
 * changing what `oidc:test-suite` requires for the other 39+ files in it.
 *
 * ── Why `DATABASE_URL` is required but never connected to ─────────────────
 * Importing `routes/oidc-userinfo.ts` pulls in `lib/oidc-userinfo.ts` ->
 * `@workspace/db`, and `lib/oidc-scope-enforcement.ts` pulls in
 * `lib/oidc-token-revocation.ts` -> `@workspace/db`'s `pool` — both only at
 * MODULE-LOAD time (the guard that throws "DATABASE_URL must be set" lives
 * at that package's top level), never actually queried by anything this
 * test does: no route handler is ever invoked here, only each router's
 * already-registered middleware stack is inspected. A same-module
 * `process.env.DATABASE_URL ??= "..."` fallback was tried and removed: ES
 * module imports are hoisted and evaluated before any of this file's own
 * top-level statements run, so by the time that assignment would execute,
 * `@workspace/db` has already been imported (transitively, via the static
 * `requireOidcScope` import below) and already thrown. `DATABASE_URL` must
 * be set by the caller — same "present and well-formed, never valid/
 * reachable" shape `test-route-ownership-regression.ts` already establishes
 * for its own `DATABASE_URL`/`VAULT_FIELD_ENCRYPTION_KEY` requirement, and
 * the same reason that file's env vars are set by its own `pnpm` script
 * invocation rather than inside the test file itself.
 *
 * ── Run ──────────────────────────────────────────────────────────────────
 *   DATABASE_URL=postgres://test:test@localhost:5432/test \
 *   npx tsx --test scripts/src/test-route-oidc-scope-wiring.ts
 *
 *   or, with the env var wired in already:
 *   pnpm --filter @workspace/scripts oidc:test-route-scope-wiring
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { IRouter } from "express";
import { requireOidcScope } from "../../artifacts/api-server/src/lib/oidc-scope-enforcement";

/**
 * Express doesn't expose "which middleware functions are on this route" as
 * a public API, but `router.stack` (an Express implementation detail this
 * codebase's own test suites already rely on elsewhere — see
 * `test-jwks-endpoint.ts`'s own router-introspection precedent) exposes
 * each registered layer's `handle` function. `requireOidcScope(scope)`
 * returns a freshly-created closure per call, so this can't compare
 * function IDENTITY the way a plain `router.get(path, someNamedFn)` check
 * could — instead, we confirm the SHAPE `requireOidcScope`'s factory
 * produces is present: an arrow function of arity 3 (req, res, next) whose
 * source text contains the "insufficient_scope" marker unique to that
 * factory's output (see `oidc-scope-enforcement.ts`'s own
 * `respondInsufficientScope`). This is deliberately a structural check, not
 * a black-box HTTP request through the full stack (no live DB to make a
 * request against) — same trade-off this codebase's other route-wiring
 * regression test documents for why it drives real functions rather than
 * spinning up a live server.
 */
function routeRequiresOidcScope(router: IRouter, method: "get" | "post", routePath: string): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stack = (router as any).stack as Array<{
    route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...args: unknown[]) => unknown }> };
  }>;
  const layer = stack.find((l) => l.route?.path === routePath && l.route.methods[method]);
  assert.ok(layer?.route, `no ${method.toUpperCase()} ${routePath} route registered on this router`);
  return layer!.route!.stack.some((middlewareLayer) => {
    const source = middlewareLayer.handle.toString();
    // requireOidcScope()'s returned closure is the only middleware in this
    // codebase whose body issues RFC 6750's `insufficient_scope` challenge.
    return source.includes("insufficient_scope");
  });
}

test("requireOidcScope() itself still produces a middleware carrying the insufficient_scope marker this file's structural check relies on", () => {
  const middleware = requireOidcScope("openid");
  assert.equal(typeof middleware, "function");
  assert.ok(
    middleware.toString().includes("insufficient_scope"),
    "requireOidcScope()'s output no longer matches the shape this route-wiring test detects — " +
      "update routeRequiresOidcScope()'s marker alongside whatever changed in oidc-scope-enforcement.ts",
  );
});

test("GET /oidc/userinfo actually mounts requireOidcScope() — not just imports it", async () => {
  const { default: oidcUserinfoRouter } = await import("../../artifacts/api-server/src/routes/oidc-userinfo");
  assert.ok(
    routeRequiresOidcScope(oidcUserinfoRouter, "get", "/oidc/userinfo"),
    "GET /oidc/userinfo has no requireOidcScope(...) middleware in its stack — " +
      "Phase G3 regression: see docs/changes/CHANGES_ENFORCEMENT_ROADMAP_TRACK_G_PHASE_G3.md",
  );
});

test("GET /oidc/resource/profile actually mounts requireOidcScope() — not just imports it", async () => {
  const { default: oidcResourceRouter } = await import("../../artifacts/api-server/src/routes/oidc-resource");
  assert.ok(routeRequiresOidcScope(oidcResourceRouter, "get", "/oidc/resource/profile"));
});

test("GET /oidc/resource/email actually mounts requireOidcScope() — not just imports it", async () => {
  const { default: oidcResourceRouter } = await import("../../artifacts/api-server/src/routes/oidc-resource");
  assert.ok(routeRequiresOidcScope(oidcResourceRouter, "get", "/oidc/resource/email"));
});
