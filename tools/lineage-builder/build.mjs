#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRouteIndex, resolveEndpoint } from "./lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../../");
const routesDir = path.join(root, "artifacts/api-server/src/routes");
const appTsPath = path.join(root, "artifacts/api-server/src/app.ts");

/**
 * Phase 04 — Function/Module/API Lineage.
 *
 * Reverse-traces every ENDPOINT_REGISTRY definition (the Phase F1
 * machine-generated registry `packages/endpoint-registry` already
 * produces) to the route file/line that declares it and the local
 * lib/service functions its handler references, then writes
 * reports/lineage/lineage.json.
 *
 * Route files mount two ways:
 *  - ~150 files combined through artifacts/api-server/src/routes/index.ts,
 *    which app.ts mounts at app.use("/api", ..., router) -> prefix "/api".
 *  - A handful (well-known-jwks, well-known-openid-configuration, and the
 *    oidc-* routers) mounted standalone directly in app.ts with no prefix
 *    -> their own paths are already absolute.
 * Both are derived from app.ts itself below rather than hand-listed, so a
 * newly-added standalone router is picked up automatically.
 */
function standaloneRouteFiles() {
  const appSource = fs.readFileSync(appTsPath, "utf8");
  const importPattern = /import\s+(\w+)\s+from\s+["']\.\/routes\/([\w-]+)["']/g;
  const localNameToFile = new Map();
  let match;
  while ((match = importPattern.exec(appSource)) !== null) localNameToFile.set(match[1], `${match[2]}.ts`);

  const standalone = new Set();
  const usePattern = /app\.use\((\w+)\)/g;
  while ((match = usePattern.exec(appSource)) !== null) {
    const file = localNameToFile.get(match[1]);
    if (file) standalone.add(file);
  }
  return standalone;
}

async function loadEndpointRegistry() {
  const mod = await import("../../packages/endpoint-registry/src/index.mjs");
  return mod.ENDPOINT_REGISTRY;
}

async function build() {
  const standalone = standaloneRouteFiles();
  const prefixByFile = Object.fromEntries([...standalone].map((file) => [file, ""]));

  const routeIndex = buildRouteIndex({ routesDir, prefixByFile });
  const endpoints = await loadEndpointRegistry();
  const entries = endpoints.map((endpoint) => resolveEndpoint(endpoint, routeIndex));

  const resolved = entries.filter((e) => e.resolution.status === "resolved");
  const unresolved = entries.filter((e) => e.resolution.status === "unresolved");
  const criticalEntries = entries.filter((e) => e.critical);
  const criticalResolved = criticalEntries.filter((e) => e.resolution.status === "resolved");
  const criticalUnresolved = criticalEntries.filter((e) => e.resolution.status === "unresolved");

  const findings = criticalUnresolved.map((e) => ({
    severity: "critical",
    code: "CRITICAL_ENDPOINT_UNRESOLVED",
    method: e.method,
    path: e.path,
    owner: e.owner,
  }));

  const output = {
    schemaVersion: 1,
    reportId: "function-module-api-lineage",
    generatedAt: new Date().toISOString().slice(0, 10),
    generatedBy: "tools/lineage-builder/build.mjs",
    schema: "schemas/lineage/lineage-entry.v1.json",
    sourceRegistries: [
      "packages/endpoint-registry/src/index.mjs (ENDPOINT_REGISTRY)",
      "artifacts/api-server/src/routes/*.ts (static regex scan, not full AST)",
      "artifacts/api-server/src/app.ts (route-file mount prefixes)",
    ],
    method: "Static regex scan of router.<method>(path) declarations, matched to ENDPOINT_REGISTRY by method+path. Handler-body function references are a heuristic identifier scan within each handler's source span, not a real call graph -- see schemas/lineage/lineage-entry.v1.json's description for exact limits.",
    completeness: {
      totalEndpoints: entries.length,
      resolved: resolved.length,
      resolvedRatio: entries.length ? resolved.length / entries.length : 1,
      criticalEndpoints: criticalEntries.length,
      criticalResolved: criticalResolved.length,
      criticalResolvedRatio: criticalEntries.length ? criticalResolved.length / criticalEntries.length : 1,
    },
    findings,
    entries,
  };

  const reportPath = path.join(root, "reports/lineage/lineage.json");
  if (process.argv.includes("--check")) {
    const committed = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    if (JSON.stringify(committed.entries) !== JSON.stringify(output.entries)) {
      console.error("Lineage report is stale. Run: node tools/lineage-builder/build.mjs");
      process.exit(1);
    }
  } else {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(output, null, 2)}\n`);
  }

  console.log(JSON.stringify({
    output: "reports/lineage/lineage.json",
    completeness: output.completeness,
    findingCount: findings.length,
    status: findings.length > 0 ? "BLOCKED" : "READY",
  }, null, 2));

  return output;
}

build();
