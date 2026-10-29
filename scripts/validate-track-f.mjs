#!/usr/bin/env node
/**
 * AYZEN Roadmap — Track F (Domain Routing Engine), Phases F1-F3.
 *
 * F1 gate: regenerating packages/endpoint-registry/src/index.mjs from the
 * real route sources must produce exactly what's committed (no drift), and
 * the generator must actually be discovering the full real surface, not a
 * degenerate stub.
 *
 * F2 gate: the gateway's routing table must come from that same generated
 * registry (not a second hand-written list), it must still resolve every
 * prefix the old hardcoded 11-entry table did, and it must leave anything
 * without a declared upstream (e.g. "/api/tasks") to the monolith fallback
 * rather than inventing a route.
 *
 * F3 gate: config/api/routes.json — previously dead (imported nowhere) but
 * declaring its own "policy" field per route — must be explicitly marked
 * deprecated with no live route entries, and nothing in the repo may import
 * it. The concept it half-declared is already covered by the Phase F1
 * registry's "permission" field on every entry, so there is exactly one
 * declared routing/policy source, not two.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { generateDefinitions, scanServiceRouteTable } from "../tools/domain-routing/generate-endpoint-registry.mjs";
import { ENDPOINT_REGISTRY, SERVICE_ROUTE_TABLE, resolveEndpoint } from "../packages/endpoint-registry/src/index.mjs";
import { routeFor } from "../apps/api-gateway/src/routing.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

// --- Phase F1: generated registry matches the committed file ------------
{
  const check = spawnSync(process.execPath, ["tools/domain-routing/generate-endpoint-registry.mjs", "--check"], { encoding: "utf8" });
  assert.equal(check.status, 0, `endpoint-registry has drifted from the real route sources:\n${check.stdout}${check.stderr}`);

  const definitions = generateDefinitions();
  assert.ok(definitions.length > 1000, `generator only found ${definitions.length} endpoints — expected 1000+ across the monolith's 150 route files plus extracted services; this smells like a broken scan, not a real count`);
  assert.deepEqual(definitions.length, ENDPOINT_REGISTRY.length, "generateDefinitions() and the committed ENDPOINT_REGISTRY disagree on endpoint count");

  const owners = new Set(ENDPOINT_REGISTRY.map((e) => e.owner));
  for (const expectedOwner of ["identity", "finance", "vault", "mail", "workflow", "marketplace", "search", "admin", "notification", "ai", "telegram"]) {
    assert.ok(owners.has(expectedOwner), `generated registry is missing the "${expectedOwner}" owner`);
  }

  // Every entry must satisfy the registry's own runtime validation (this
  // also runs at import time, but assert it explicitly here so a future
  // relaxation of that check doesn't silently stop being exercised).
  for (const endpoint of ENDPOINT_REGISTRY) {
    assert.ok(["GET", "POST", "PUT", "PATCH", "DELETE"].includes(endpoint.method));
    assert.ok(["public", "user", "service", "admin"].includes(endpoint.auth));
    assert.ok(endpoint.path.startsWith("/"));
  }

  // Spot-check a handful of routes whose auth mode is unambiguous from the
  // real source, so a scanner regression that silently mis-tags everything
  // "public" (or everything "admin") gets caught here.
  assert.equal(resolveEndpoint("POST", "/api/tasks").auth, "admin", "POST /api/tasks is requireRoles(\"admin\",\"moderator\")-gated in source");
  assert.equal(resolveEndpoint("GET", "/api/tasks/1").auth, "public", "GET /api/tasks/:id has no auth check in source");
  assert.equal(resolveEndpoint("POST", "/api/tasks/1/visit").auth, "user", "POST /api/tasks/:id/visit is requireAuth-gated in source");
  assert.equal(resolveEndpoint("POST", "/api/finance/accounts/1/transactions").auth, "user");
  assert.equal(resolveEndpoint("POST", "/api/admin/break-glass").auth, "admin");

  console.log(`Phase F1: generated registry in sync (${definitions.length} endpoints, ${owners.size} owners).`);
}

// --- Phase F2: gateway reads the registry, not a hardcoded array --------
{
  const generatedServiceRoutes = scanServiceRouteTable();
  assert.deepEqual(SERVICE_ROUTE_TABLE.map(([p, e, s]) => [p, e, s]), generatedServiceRoutes, "committed SERVICE_ROUTE_TABLE has drifted from a fresh scan");

  // Every prefix the OLD hand-written apps/api-gateway serviceRoutes array
  // declared must still resolve to the same upstream env var — Phase F2
  // must not silently drop a route the hardcoded table used to serve.
  const previouslyHardcoded = [
    ["/api/auth", "IDENTITY_SERVICE_URL"],
    ["/api/finance", "FINANCE_SERVICE_URL"],
    ["/api/vault", "VAULT_SERVICE_URL"],
    ["/api/mail", "WISP_SERVICE_URL"],
    ["/api/notifications", "NOTIFICATION_SERVICE_URL"],
    ["/api/workflows", "WORKFLOW_SERVICE_URL"],
    ["/api/ai", "AI_SERVICE_URL"],
    ["/api/marketplace", "MARKETPLACE_SERVICE_URL"],
    ["/api/search", "SEARCH_SERVICE_URL"],
    ["/api/intelligence", "INTELLIGENCE_SERVICE_URL"],
    ["/api/admin", "ADMIN_SERVICE_URL"],
  ];
  for (const [prefix, envVar] of previouslyHardcoded) {
    const match = routeFor(`${prefix}/some-path`, SERVICE_ROUTE_TABLE);
    assert.ok(match, `${prefix} no longer resolves to any route in the generated SERVICE_ROUTE_TABLE`);
    assert.equal(match[1], envVar, `${prefix} used to route via ${envVar}, generated table now says ${match[1]}`);
  }

  // The generator picked up MORE than the old table knew about (identity's
  // /oidc and /.well-known prefixes, declared in its own routePrefixes but
  // never reflected in the old hand-written array).
  assert.ok(routeFor("/oidc/token", SERVICE_ROUTE_TABLE), "identity's declared /oidc routePrefix should now be reachable through the gateway table");

  // Registry owners with no extracted service (no routeEnv in
  // infrastructure/deployment/topology.yaml) must NOT get a fabricated
  // route — they stay on the monolith fallback, same as before.
  assert.equal(routeFor("/api/tasks", SERVICE_ROUTE_TABLE), undefined, "\"/api/tasks\" (workspace domain, no extracted service) must not get a gateway route");

  const gatewayTest = spawnSync(process.execPath, ["--test", "src/routing.test.mjs"], { cwd: "apps/api-gateway", encoding: "utf8" });
  assert.equal(gatewayTest.status, 0, `apps/api-gateway routing test suite failed:\n${gatewayTest.stdout}${gatewayTest.stderr}`);

  console.log(`Phase F2: gateway's SERVICE_ROUTE_TABLE is registry-generated (${SERVICE_ROUTE_TABLE.length} prefixes) and its routing test suite passes.`);
}

// --- Phase F3: config/api/routes.json retired, permission is the one policy source ---
{
  const ROUTES_JSON = path.join(repoRoot, "config/api/routes.json");
  const declared = JSON.parse(fs.readFileSync(ROUTES_JSON, "utf8"));
  assert.equal(declared.deprecated, true, "config/api/routes.json must be explicitly marked deprecated");
  assert.deepEqual(declared.routes, [], "config/api/routes.json must not declare any live routes once retired");
  assert.ok(typeof declared.supersededBy === "string" && declared.supersededBy.length > 0, "config/api/routes.json must point at what replaced it");

  // Nothing in the repo may still READ the retired file (an actual
  // import/require/readFileSync of it) — not merely mention its path in a
  // doc comment, which the generator and the gateway both legitimately do
  // now to explain the F3 migration. Same check the F3 investigation used
  // to first confirm the file was dead, just narrowed to real usage.
  const grep = spawnSync("grep", ["-rlE", "(readFileSync|require|import)\\([^)]*config/api/routes\\.json|from [\"'][^\"']*config/api/routes\\.json[\"']", "--include=*.mjs", "--include=*.ts", "--include=*.js", repoRoot], { encoding: "utf8" });
  const referencingFiles = (grep.stdout || "")
    .split("\n")
    .filter(Boolean)
    .filter((file) => !file.includes("/node_modules/") && path.resolve(file) !== path.resolve(__filename));
  assert.deepEqual(referencingFiles, [], `config/api/routes.json should have zero live readers, found: ${referencingFiles.join(", ")}`);

  // The concept routes.json half-declared (a "policy" string per route) is
  // already covered by every generated registry entry's "permission" field
  // — this is F1's own per-entry validation re-asserted here so the F3
  // "one source, not two" claim stays tied to a real check, not just prose.
  for (const endpoint of ENDPOINT_REGISTRY) {
    assert.ok(typeof endpoint.permission === "string" && endpoint.permission.length > 0, `${endpoint.method} ${endpoint.path} is missing a permission (the routes.json "policy" field's replacement)`);
  }

  console.log("Phase F3: config/api/routes.json is retired (deprecated, zero live routes, zero importers) — permission on the generated registry is the one policy source.");
}

console.log("Track F (F1-F3) validation passed: endpoint-registry is generated from real route sources, the gateway routes from it, and the old dead routes.json config is retired in favor of that one source.");
