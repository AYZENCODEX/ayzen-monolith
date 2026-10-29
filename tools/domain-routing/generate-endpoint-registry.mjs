#!/usr/bin/env node
/**
 * tools/domain-routing/generate-endpoint-registry.mjs
 * ─────────────────────────────────────────────────────────────────────────
 * AYZEN Roadmap — Track F, Phase F1 ("Make ENDPOINT_REGISTRY the generated
 * source of truth").
 *
 * Instead of hand-maintaining `packages/endpoint-registry/src/index.mjs`'s
 * `definitions` array (which drifted to ~28 entries against 150 real route
 * files), this scans the real route sources and EMITS that file.
 *
 * Sources scanned, in this order (later sources never override an
 * already-discovered method+path — see `addEntry`):
 *
 *   1. SEED_ENTRIES — a short, explicitly-reviewed list for the handful of
 *      routes that this scanner structurally cannot detect (see the
 *      comment above that constant). Kept intentionally tiny.
 *   2. Extracted services (`services/*\/src/index.mjs`) — these already
 *      declare their own `domain`/`owner` in the `createServiceServer(...)`
 *      call, so their entries are the most authoritative for the ~11
 *      prefixes that have a real extracted service.
 *   3. The monolith's Express routes (`artifacts/api-server/src/routes/*.ts`,
 *      limited to the files actually mounted by `routes/index.ts`) — this
 *      is the bulk of the 150-file surface with no extracted-service
 *      equivalent yet.
 *
 * Auth mode and owner are INFERRED, not hand-typed:
 *   - Extracted-service routes: owner = that service's declared `domain`;
 *     auth = "admin" for that service's admin-domain routes and any
 *     `/internal/*` operational route, "service" for the one declared
 *     service-to-service webhook-style route, else "user".
 *   - Monolith routes: owner = the route path's leading segment, mapped
 *     through GROUP_TO_OWNER (built from `packages/domain-boundaries`'
 *     domain names; anything with no clear domain home falls into the
 *     "platform" bucket rather than being forced into a wrong domain —
 *     that bucket is exactly the kind of gap Phase F4's domain-contract
 *     cross-check is meant to surface later). Auth mode is inferred from
 *     the text of that specific route's own handler slice (requireAdmin/
 *     requireDev -> admin, requireAuth/requireRoles/getUserFromToken/
 *     getTokenFromReq/apiKeyScopeGate -> user, else public.
 *
 * Usage:
 *   node tools/domain-routing/generate-endpoint-registry.mjs [--check]
 *
 *   (no flag)  Regenerates packages/endpoint-registry/src/index.mjs.
 *   --check    Regenerates into memory and diffs against the committed
 *              file; exits 1 and prints the diff summary on drift. This is
 *              the mode the Phase F1 CI gate runs.
 *
 * Phase F3 note: `config/api/routes.json` used to be a second, unread
 * routing config that declared its own per-route "policy" string. It was
 * never imported anywhere, so it's now marked `deprecated: true` with no
 * live routes (see that file). The concept it half-declared is this
 * registry's `permission` field on every entry below (e.g. its old
 * `"vault.read"` policy is this registry's `"vault:read"` permission on the
 * matching endpoint) — one declared routing/policy source, not two.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");

const ROUTES_DIR = path.join(repoRoot, "artifacts/api-server/src/routes");
const ROUTES_INDEX = path.join(ROUTES_DIR, "index.ts");
const SERVICES_DIR = path.join(repoRoot, "services");
const TOPOLOGY_FILE = path.join(repoRoot, "infrastructure/deployment/topology.yaml");
const OUTPUT_FILE = path.join(repoRoot, "packages/endpoint-registry/src/index.mjs");

// ─── Domain ownership map (monolith routes only) ───────────────────────────
// Keyed by the route path's leading segment (e.g. "/vault/secrets" -> "vault").
// Values are `packages/domain-boundaries` domain names where one clearly
// applies. Anything else lands in "platform" — a deliberate catch-all for
// product surface that doesn't map to a declared domain contract yet,
// rather than a guess dressed up as certainty.
const GROUP_TO_OWNER = {
  // identity
  auth: "identity", users: "identity", passkey: "identity", "two-factor": "identity",
  "api-keys": "identity", security: "identity",
  // vault
  vault: "vault", "vault-shares": "vault", "vault-entity-links": "vault",
  // finance
  finance: "finance", payments: "finance", credits: "finance", subscription: "finance",
  plans: "finance", "exchange-balance": "finance", "value-history": "finance",
  // mail
  email: "mail", "email-accounts": "mail", "ayzen-email": "mail", "ayzen-mail": "mail",
  "mail-messages": "mail",
  // marketplace
  marketplace: "marketplace", spot: "marketplace", wallets: "marketplace",
  "nft-subscriptions": "marketplace",
  // ai
  ai: "ai",
  // search
  search: "search",
  // notification
  notifications: "notification", "notification-preferences": "notification",
  // admin / internal ops consoles
  admin: "admin", compliance: "admin", "kyc-entries": "admin", "kyc-data-entities": "admin",
  "emergency-access": "admin", "key-manager": "admin", siora: "admin", "sub-engines": "admin",
  "new-engines": "admin", acie: "admin", dev: "admin", mcp: "admin",
  // telegram
  telegram: "telegram",
  // workspace
  teams: "workspace", organizations: "workspace", workspaces: "workspace", projects: "workspace",
  "project-dates": "workspace", "project-templates": "workspace", tasks: "workspace",
  categories: "workspace", "category-templates": "workspace",
};
const DEFAULT_OWNER = "platform";

// ─── SEED_ENTRIES ───────────────────────────────────────────────────────────
// Routes this scanner cannot structurally detect, reviewed by hand:
//  - GET /health is answered by api-gateway itself (apps/api-gateway/src/
//    index.mjs), never proxied to any service's `handle()` — there is no
//    route source to scan.
//  - The Telegram webhook is written as a guard-clause (`if (!match) return
//    404; ...`), not the `if (match && method) {...}` success-block shape
//    every other match-based route in this codebase uses, so the regex
//    scanner below intentionally does not special-case it.
const SEED_ENTRIES = [
  ["identity", "GET", "/health", "public", "identity:health", "none", false],
  ["telegram-gateway", "POST", "/api/telegram/gateway/:botKey/webhook", "service", "telegram:update", "telegram.update.received", true],
  ["telegram-gateway", "GET", "/api/telegram/gateway/failures", "admin", "telegram:admin", "none", false],
  // JWKS is mounted directly on the bare `app` instance (routes/well-known-
  // jwks.ts), deliberately outside `/api` per RFC 8414 -- so it is not one
  // of the routers combined in routes/index.ts and this scanner's
  // mountedRouteFiles()/scanMonolithRoutes() never sees it. Same class of
  // gap as the Telegram webhook above: structurally undetectable, reviewed
  // by hand. Closes G02/Phase 06's "identity:jwks" unresolved-operation
  // finding -- see domain-boundaries' identity contract's `jwks` operation.
  ["identity", "GET", "/.well-known/jwks.json", "public", "identity:read", "identity.jwks.read", false],
];

function verbFor(method) {
  if (method === "GET") return "read";
  if (method === "DELETE") return "delete";
  return "write";
}

function auditEventFor(owner, routePath, method) {
  const slug = routePath
    .split("/")
    .filter(Boolean)
    .map((segment) => (segment.startsWith(":") ? null : segment))
    .filter(Boolean)
    .join(".");
  return `${owner}.${slug || "root"}.${verbFor(method).replace("write", method === "DELETE" ? "delete" : "write")}`;
}

function looksIdempotent(handlerSlice, method) {
  if (method === "GET") return false;
  return /idempot/i.test(handlerSlice);
}

function inferMonolithAuth(handlerSlice) {
  // requireAuth/requireAdmin/requireDev are almost always passed BY
  // REFERENCE as Express middleware (`router.post(path, requireAdmin,
  // handler)`), not invoked with parens — only requireRoles(...) and
  // requirePublicAudit(...)/requireRole(...)-family helpers are actually
  // called. So admin/auth detection must match the bare identifier, not
  // assume a call.
  if (/\brequireAdmin\b|\brequireDev\b/.test(handlerSlice)) return "admin";
  if (/\brequireRoles\s*\(\s*["'](admin|dev)["']/.test(handlerSlice)) return "admin";
  if (/\brequireAuth\b|\brequireSessionAuth\b|\brequireRoles\s*\(|\bgetUserFromToken\s*\(|\bgetTokenFromReq\s*\(|\bapiKeyScopeGate\b|\brequireRole\s*\(/.test(handlerSlice)) return "user";
  // requirePublicAudit(...) is a deliberately-public, audited route (e.g.
  // a shareable receipt link) — it must NOT be classified as "user".
  return "public";
}

// ─── Monolith route scan ────────────────────────────────────────────────────

function mountedRouteFiles() {
  const indexSource = fs.readFileSync(ROUTES_INDEX, "utf8");
  const importRe = /import\s+(\w+)\s+from\s+["']\.\/([\w-]+)["']/g;
  const importMap = new Map();
  for (const match of indexSource.matchAll(importRe)) importMap.set(match[1], match[2]);
  const mounted = new Set();
  for (const match of indexSource.matchAll(/router\.use\((\w+)\)/g)) {
    const file = importMap.get(match[1]);
    if (file) mounted.add(file);
  }
  return [...mounted].sort();
}

const ROUTE_CALL_RE = /router\.(get|post|put|patch|delete)\(\s*["']([^"']+)["']/g;

function scanMonolithRoutes() {
  const entries = [];
  for (const file of mountedRouteFiles()) {
    const filePath = path.join(ROUTES_DIR, `${file}.ts`);
    if (!fs.existsSync(filePath)) continue;
    const source = fs.readFileSync(filePath, "utf8");
    const calls = [...source.matchAll(ROUTE_CALL_RE)];
    for (let i = 0; i < calls.length; i += 1) {
      const call = calls[i];
      const method = call[1].toUpperCase();
      const routePath = call[2].startsWith("/") ? call[2] : `/${call[2]}`;
      const sliceEnd = i + 1 < calls.length ? calls[i + 1].index : source.length;
      const handlerSlice = source.slice(call.index, sliceEnd);
      const segment = routePath.split("/")[1] ?? "";
      const owner = GROUP_TO_OWNER[segment] ?? DEFAULT_OWNER;
      const auth = inferMonolithAuth(handlerSlice);
      const fullPath = `/api${routePath}`;
      entries.push([
        owner,
        method,
        fullPath,
        auth,
        `${owner}:${verbFor(method)}`,
        auditEventFor(owner, routePath, method),
        looksIdempotent(handlerSlice, method),
      ]);
    }
  }
  return entries;
}

// ─── Extracted-service route scan ──────────────────────────────────────────

function regexLiteralToTemplate(pattern) {
  let paramIndex = 0;
  return pattern
    .replace(/^\^/, "")
    .replace(/\$$/, "")
    .replace(/\\\//g, "/")
    .replace(/\(\[\^\/\]\+\)/g, () => {
      paramIndex += 1;
      return paramIndex === 1 ? ":id" : `:param${paramIndex}`;
    });
}

function scanExtractedServices() {
  const entries = [];
  for (const dirName of fs.readdirSync(SERVICES_DIR)) {
    if (dirName === "_service-template") continue;
    const filePath = path.join(SERVICES_DIR, dirName, "src/index.mjs");
    if (!fs.existsSync(filePath)) continue;
    const source = fs.readFileSync(filePath, "utf8");
    const domainMatch = source.match(/domain:\s*["']([\w-]+)["']/);
    if (!domainMatch) continue; // pure proxy service (e.g. identity) — nothing to scan
    const owner = domainMatch[1];

    const matchVarRe = /const\s+(\w+)\s*=\s*url\.pathname\.match\(\/(.+?)\/\)/g;
    const matchVars = new Map();
    for (const m of source.matchAll(matchVarRe)) matchVars.set(m[1], regexLiteralToTemplate(m[2]));

    const ifLineRe = /if\s*\(([^)]*req\.method\s*===\s*["']\w+["'][^)]*)\)/g;
    for (const ifMatch of source.matchAll(ifLineRe)) {
      const condition = ifMatch[1];
      const methodMatch = condition.match(/req\.method\s*===\s*["'](\w+)["']/);
      if (!methodMatch) continue;
      const method = methodMatch[1];
      const literalPaths = [...condition.matchAll(/url\.pathname\s*===\s*["']([^"']+)["']/g)].map((m) => m[1]);
      const matchRefs = [...condition.matchAll(/\b(\w+)\b/g)]
        .map((m) => matchVars.get(m[1]))
        .filter(Boolean);
      const routePaths = [...new Set([...literalPaths, ...matchRefs])];
      for (const routePath of routePaths) {
        const isInternal = routePath.startsWith("/internal/");
        let auth = "user";
        if (isInternal) auth = "admin";
        else if (owner === "admin" && routePath === "/api/admin/events") auth = "service";
        else if (owner === "admin") auth = "admin";
        entries.push([
          owner,
          method,
          routePath,
          auth,
          `${owner}:${verbFor(method)}`,
          auditEventFor(owner, routePath.replace(/^\/api\/[\w-]+/, ""), method),
          looksIdempotent(source, method),
        ]);
      }
    }
  }
  return entries;
}

// ─── Service route table (Phase F2 input) ──────────────────────────────────
// `apps/api-gateway` used to hand-maintain its own `serviceRoutes` array of
// [prefix, envVar, serviceName] triples, hardcoded and drifting from this
// registry. Phase F2 makes the gateway load this instead. It's built from
// two authoritative, already-real sources (not guessed):
//   - infrastructure/deployment/topology.yaml's `services.<domain>.routeEnv`
//     — the actual env var name each domain's upstream URL is read from.
//   - each services/*/src/index.mjs's own `service:`/`domain:`/
//     `routePrefixes:` fields — the actual prefixes that service's `handle()`
//     recognizes, so the gateway can never proxy a path a service doesn't
//     understand.

function parseTopologyRouteEnv() {
  const source = fs.readFileSync(TOPOLOGY_FILE, "utf8");
  const routeEnvByDomain = new Map();
  for (const match of source.matchAll(/^\s*(\w+):\s*\{[^}]*routeEnv:\s*(\w+)[^}]*\}/gm)) {
    routeEnvByDomain.set(match[1], match[2]);
  }
  return routeEnvByDomain;
}

function scanServiceRouteTable() {
  const routeEnvByDomain = parseTopologyRouteEnv();
  const rows = [];
  for (const dirName of fs.readdirSync(SERVICES_DIR)) {
    if (dirName === "_service-template") continue;
    const filePath = path.join(SERVICES_DIR, dirName, "src/index.mjs");
    if (!fs.existsSync(filePath)) continue;
    const source = fs.readFileSync(filePath, "utf8");
    const domainMatch = source.match(/domain:\s*["']([\w-]+)["']/);
    const serviceMatch = source.match(/(?:^|\s)service:\s*["']([\w-]+)["']/m);
    const prefixesMatch = source.match(/routePrefixes:\s*\[([^\]]*)\]/);
    if (!domainMatch || !serviceMatch || !prefixesMatch) continue;
    const domain = domainMatch[1];
    const serviceName = serviceMatch[1];
    const envVar = routeEnvByDomain.get(domain);
    if (!envVar) continue; // no declared upstream env var — nothing for the gateway to route to
    const prefixes = [...prefixesMatch[1].matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
    for (const prefix of prefixes) rows.push([prefix, envVar, serviceName]);
  }
  return rows.sort((a, b) => b[0].length - a[0].length || a[0].localeCompare(b[0]));
}

// ─── Merge + render ─────────────────────────────────────────────────────────

function addEntry(map, entry) {
  const [, method, fullPath] = entry;
  const key = `${method} ${fullPath}`;
  if (!map.has(key)) map.set(key, entry);
}

export { scanServiceRouteTable };

export function generateDefinitions() {
  const merged = new Map();
  for (const entry of SEED_ENTRIES) addEntry(merged, entry);
  for (const entry of scanExtractedServices()) addEntry(merged, entry);
  for (const entry of scanMonolithRoutes()) addEntry(merged, entry);
  return [...merged.values()].sort((a, b) => (a[2] === b[2] ? a[1].localeCompare(b[1]) : a[2].localeCompare(b[2])));
}

function renderDefinitionsLiteral(definitions) {
  return definitions
    .map(([owner, method, p, auth, permission, auditEvent, idempotent]) =>
      `  [${JSON.stringify(owner)}, ${JSON.stringify(method)}, ${JSON.stringify(p)}, ${JSON.stringify(auth)}, ${JSON.stringify(permission)}, ${JSON.stringify(auditEvent)}, ${idempotent}],`)
    .join("\n");
}

function renderServiceRouteTableLiteral(rows) {
  return rows.map(([prefix, envVar, service]) => `  [${JSON.stringify(prefix)}, ${JSON.stringify(envVar)}, ${JSON.stringify(service)}],`).join("\n");
}

function renderFile(definitions, serviceRouteTable) {
  return `// ─────────────────────────────────────────────────────────────────────────
// GENERATED FILE — do not hand-edit.
//
// Produced by tools/domain-routing/generate-endpoint-registry.mjs (AYZEN
// Roadmap Track F, Phase F1) by scanning:
//   - services/*/src/index.mjs (extracted services; owner/domain read from
//     each service's own createServiceServer(...) declaration)
//   - artifacts/api-server/src/routes/*.ts (the monolith's Express routers,
//     limited to files actually mounted by routes/index.ts)
//   - a short, hand-reviewed SEED_ENTRIES list for the few routes that are
//     structurally undetectable (see that constant's comment)
//
// To regenerate: node tools/domain-routing/generate-endpoint-registry.mjs
// CI (Phase F1's gate) runs the same script with --check and fails the
// build if this file has drifted from what the real route sources declare.
// ─────────────────────────────────────────────────────────────────────────
import { assertApiVersion } from "@ayzen/contracts";

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const AUTH_MODES = new Set(["public", "user", "service", "admin"]);

const definitions = [
${renderDefinitionsLiteral(definitions)}
];

export const ENDPOINT_REGISTRY = Object.freeze(definitions.map(([owner, method, path, auth, permission, auditEvent, idempotent]) => Object.freeze({
  owner,
  version: "v1",
  method,
  path,
  auth,
  permission,
  timeoutMs: method === "GET" ? 10_000 : 15_000,
  retry: method === "GET" ? { maxAttempts: 2, backoff: "exponential" } : { maxAttempts: 0, backoff: "none" },
  idempotency: idempotent ? "required-for-retries" : "not-applicable",
  audit: auditEvent,
})));

function normalizePath(path) {
  return \`/\${String(path ?? "").replace(/^\\/+|\\/+$/g, "")}\`;
}

function pathMatches(pattern, path) {
  const patternParts = normalizePath(pattern).split("/");
  const pathParts = normalizePath(path).split("/");
  return patternParts.length === pathParts.length && patternParts.every((part, index) => part.startsWith(":") || part === pathParts[index]);
}

export function validateEndpointDefinition(endpoint) {
  if (!endpoint || typeof endpoint !== "object") throw new Error("Endpoint definition must be an object");
  if (typeof endpoint.owner !== "string" || !endpoint.owner) throw new Error("Endpoint owner is required");
  assertApiVersion(endpoint.version);
  if (!METHODS.has(endpoint.method)) throw new Error(\`Unsupported endpoint method: \${endpoint.method}\`);
  if (typeof endpoint.path !== "string" || !endpoint.path.startsWith("/")) throw new Error("Endpoint path must be absolute");
  if (!AUTH_MODES.has(endpoint.auth)) throw new Error(\`Unsupported endpoint auth mode: \${endpoint.auth}\`);
  if (typeof endpoint.permission !== "string" || !endpoint.permission) throw new Error("Endpoint permission is required");
  if (!Number.isSafeInteger(endpoint.timeoutMs) || endpoint.timeoutMs < 100 || endpoint.timeoutMs > 120_000) throw new Error("Endpoint timeout is unsafe");
  if (!endpoint.retry || !Number.isSafeInteger(endpoint.retry.maxAttempts) || endpoint.retry.maxAttempts < 0 || endpoint.retry.maxAttempts > 5) throw new Error("Endpoint retry policy is unsafe");
  if (typeof endpoint.audit !== "string" || !endpoint.audit) throw new Error("Endpoint audit classification is required");
  return endpoint;
}

for (const endpoint of ENDPOINT_REGISTRY) validateEndpointDefinition(endpoint);

export function listEndpoints({ owner, method, auth } = {}) {
  return ENDPOINT_REGISTRY.filter((endpoint) =>
    (!owner || endpoint.owner === owner)
    && (!method || endpoint.method === method)
    && (!auth || endpoint.auth === auth));
}

export function resolveEndpoint(method, path) {
  const normalizedMethod = String(method ?? "").toUpperCase();
  return ENDPOINT_REGISTRY.find((endpoint) => endpoint.method === normalizedMethod && pathMatches(endpoint.path, path));
}

export function assertEndpointRegistered(method, path) {
  const endpoint = resolveEndpoint(method, path);
  if (!endpoint) throw new Error(\`Endpoint is not registered: \${normalizedMethod(method)} \${path}\`);
  return endpoint;
}

function normalizedMethod(method) {
  return String(method ?? "").toUpperCase();
}

// ─── Phase F2: gateway routing table ───────────────────────────────────────
// [prefix, envVar, serviceName] triples — the same shape apps/api-gateway
// used to hand-maintain as \`serviceRoutes\`, now generated from
// infrastructure/deployment/topology.yaml's routeEnv declarations and each
// extracted service's own routePrefixes. Sorted longest-prefix-first so a
// consumer can pick the first match without its own sort step.
export const SERVICE_ROUTE_TABLE = Object.freeze([
${renderServiceRouteTableLiteral(serviceRouteTable)}
].map((row) => Object.freeze(row)));
`;
}

function main() {
  const checkMode = process.argv.includes("--check");
  const definitions = generateDefinitions();
  const serviceRouteTable = scanServiceRouteTable();
  const rendered = renderFile(definitions, serviceRouteTable);

  if (checkMode) {
    const current = fs.existsSync(OUTPUT_FILE) ? fs.readFileSync(OUTPUT_FILE, "utf8") : "";
    if (current === rendered) {
      console.log(`endpoint-registry is up to date (${definitions.length} endpoints across ${new Set(definitions.map((d) => d[0])).size} owners).`);
      return;
    }
    console.error("packages/endpoint-registry/src/index.mjs is out of date.");
    console.error("Run: node tools/domain-routing/generate-endpoint-registry.mjs");
    console.error(`Generated ${definitions.length} endpoints from real route sources; committed file does not match.`);
    process.exit(1);
  }

  fs.writeFileSync(OUTPUT_FILE, rendered);
  console.log(`Wrote ${definitions.length} endpoints across ${new Set(definitions.map((d) => d[0])).size} owners to ${path.relative(repoRoot, OUTPUT_FILE)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
