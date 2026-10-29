import test from "node:test";
import assert from "node:assert/strict";
import {
  extractLazyImports,
  extractEagerImports,
  extractRouteArrayEntries,
  extractJsxRoutes,
  extractApiCalls,
  extractLocalHookImports,
  resolveApiCall,
} from "../../tools/ui-circuit-validator/lib.mjs";

test("extractLazyImports maps a lazy() page import to its pages/*.tsx path", () => {
  const source = `const Vault = lazy(() => import("@/pages/admin/vault"));`;
  const map = extractLazyImports(source);
  assert.equal(map.get("Vault"), "pages/admin/vault.tsx");
});

test("extractEagerImports maps App.tsx's eager auth-page imports", () => {
  const source = `import Login from "@/pages/login";\nimport NotAPage from "@/components/header";\n`;
  const map = extractEagerImports(source);
  assert.equal(map.get("Login"), "pages/login.tsx");
  assert.equal(map.has("NotAPage"), false);
});

test("extractRouteArrayEntries parses object-literal route entries with adminOnly/allowedRoles", () => {
  const source = `
    export const ADMIN_ROUTES: RouteConfig[] = [
      { path: "/admin/vault", component: Vault, adminOnly: true, allowedRoles: ["admin", "superadmin"] },
    ];
  `;
  const entries = extractRouteArrayEntries(source);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].path, "/admin/vault");
  assert.equal(entries[0].component, "Vault");
  assert.equal(entries[0].adminOnly, true);
  assert.deepEqual(entries[0].allowedRoles, ["admin", "superadmin"]);
});

test("extractRouteArrayEntries defaults adminOnly/allowedRoles when omitted", () => {
  const source = `export const USER_ROUTES: RouteConfig[] = [{ path: "/dashboard", component: Dashboard }];`;
  const entries = extractRouteArrayEntries(source);
  assert.equal(entries[0].adminOnly, false);
  assert.deepEqual(entries[0].allowedRoles, []);
});

test("extractJsxRoutes parses literal <Route path=.. component={..}> JSX", () => {
  const source = `<Route path="/login" component={Login} />`;
  const routes = extractJsxRoutes(source);
  assert.equal(routes.length, 1);
  assert.equal(routes[0].path, "/login");
  assert.equal(routes[0].component, "Login");
});

test("extractApiCalls normalizes template-literal path params to :param", () => {
  const source = "fetch(`/api/admin/vault/${id}/items`, { method: \"GET\" });";
  const calls = [...extractApiCalls(source)];
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].path, "/api/admin/vault/:param/items");
  assert.equal(calls[0].raw, "/api/admin/vault/${id}/items");
});

test("extractApiCalls defaults to GET when no method option is present", () => {
  const source = `fetch("/api/health");`;
  const calls = [...extractApiCalls(source)];
  assert.equal(calls[0].method, "GET");
});

test("extractApiCalls truncates a query-string suffix built from a non-segment ${...} instead of treating it as a path param", () => {
  // `${BASE}/api/admin/marketplace/orders${q}` where q = "?status=open" --
  // the ${q} directly follows non-"/" text ("orders"), so it is not its own
  // path segment and must be truncated, not normalized to :param.
  const source = "fetch(`${BASE}/api/admin/marketplace/orders${q}`);";
  const calls = [...extractApiCalls(source)];
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/api/admin/marketplace/orders");
});

test("extractLocalHookImports finds @/hooks/* specifiers", () => {
  const source = `import { useVaultItems } from "@/hooks/use-vault-items";\nimport React from "react";`;
  const hooks = [...extractLocalHookImports(source)];
  assert.ok(hooks.includes("use-vault-items"));
});

test("resolveApiCall matches method+path against a lineage registry entry", () => {
  const registry = [{ method: "GET", path: "/api/admin/vault/:param/items" }];
  const match = resolveApiCall({ method: "GET", path: "/api/admin/vault/:param/items" }, registry);
  assert.deepEqual(match, registry[0]);
});

test("resolveApiCall returns null for an orphaned call with no matching registry entry", () => {
  const registry = [{ method: "GET", path: "/api/admin/vault" }];
  const match = resolveApiCall({ method: "POST", path: "/api/admin/vault" }, registry);
  assert.equal(match, null);
});
