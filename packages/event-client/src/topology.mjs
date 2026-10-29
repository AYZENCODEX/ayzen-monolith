import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServicePolicy, authorizeServiceCall } from "@ayzen/service-auth";

/**
 * Phase H10.3 — Season 2 finding #10: `config/eventbus/topology.json`
 * declares 5 classified buses (`domain`, `security`, `integration`,
 * `workflow`, `platform`) with `crossBus: "policy-required"`, and
 * `config/eventbus/routes.json` maps event-type prefixes to a bus plus
 * the consumers approved to read it there — but `createRedisEventBus`
 * only ever implemented one flat `ayzen:events:*` namespace, so neither
 * file had a runtime reader. This is that reader, mirroring
 * `security-policy.mjs`'s loader exactly (same fail-closed reasoning: an
 * unreadable/missing config file keeps the documented strictest
 * defaults, never `{}`/`[]`, so a bad deploy can't quietly reopen this
 * gap).
 *
 * `identity.mjs`'s own header already earmarked this: "`@ayzen/service-auth`
 * has no `allowedTargets` routing configured anywhere yet — wiring that
 * up is a bus-routing concern, H10.3's job". This module is that wiring:
 * each `routes.json` entry's `consumers` list is turned into a
 * `@ayzen/service-auth` policy per consumer service, whose one
 * `allowedTarget` is the bus that route lands on — so `authorizeServiceCall`
 * (already used for HTTP caller/target checks elsewhere) is the same
 * primitive that decides whether a subscribe crosses a bus boundary
 * without approval, instead of a second, bespoke allow-list mechanism.
 */

export const DEFAULT_BUS_ID = "domain";

export const DEFAULT_EVENTBUS_TOPOLOGY = Object.freeze({
  schemaVersion: 1,
  buses: Object.freeze([
    Object.freeze({ id: "domain", classification: "internal" }),
    Object.freeze({ id: "security", classification: "restricted" }),
    Object.freeze({ id: "integration", classification: "sensitive" }),
    Object.freeze({ id: "workflow", classification: "internal" }),
    Object.freeze({ id: "platform", classification: "internal" }),
  ]),
  crossBus: "policy-required",
});

export const DEFAULT_EVENTBUS_ROUTES = Object.freeze({
  schemaVersion: 1,
  routes: Object.freeze([
    Object.freeze({ eventPrefix: "identity.", bus: "security", consumers: Object.freeze(["audit", "intelligence"]) }),
    Object.freeze({ eventPrefix: "workflow.", bus: "workflow", consumers: Object.freeze(["workflow-worker", "audit"]) }),
    Object.freeze({ eventPrefix: "telegram.", bus: "integration", consumers: Object.freeze(["intelligence", "audit"]) }),
    Object.freeze({ eventPrefix: "deployment.", bus: "platform", consumers: Object.freeze(["admin", "intelligence"]) }),
  ]),
});

function resolveConfigPath(envVar, fallbackFile) {
  if (process.env[envVar]) return process.env[envVar];
  // packages/event-client/src/ -> repo root is three levels up. Resolved
  // from this file's own location (not process.cwd()) so it works the
  // same whether the caller's cwd is the repo root (tests, scripts) or a
  // service's own directory (a deployed process) — same approach as
  // `security-policy.mjs`.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../../config/eventbus", fallbackFile);
}

let cachedTopology;
let cachedRoutes;

export function loadEventBusTopology({ forceReload = false } = {}) {
  if (cachedTopology && !forceReload) return cachedTopology;
  try {
    const raw = fs.readFileSync(resolveConfigPath("EVENTBUS_TOPOLOGY_CONFIG_PATH", "topology.json"), "utf8");
    const parsed = JSON.parse(raw);
    cachedTopology = Object.freeze({ ...DEFAULT_EVENTBUS_TOPOLOGY, ...parsed });
  } catch {
    cachedTopology = DEFAULT_EVENTBUS_TOPOLOGY;
  }
  return cachedTopology;
}

export function loadEventBusRoutes({ forceReload = false } = {}) {
  if (cachedRoutes && !forceReload) return cachedRoutes;
  try {
    const raw = fs.readFileSync(resolveConfigPath("EVENTBUS_ROUTES_CONFIG_PATH", "routes.json"), "utf8");
    const parsed = JSON.parse(raw);
    const routes = Array.isArray(parsed.routes) ? parsed.routes : DEFAULT_EVENTBUS_ROUTES.routes;
    cachedRoutes = Object.freeze(routes.map((route) => Object.freeze({ ...route, consumers: Object.freeze([...(route.consumers ?? [])]) })));
  } catch {
    cachedRoutes = DEFAULT_EVENTBUS_ROUTES.routes;
  }
  return cachedRoutes;
}

/** Test-only: clears the module-level caches so a test can point the
 * *_CONFIG_PATH env vars at fixtures and see them take effect. */
export function __resetEventBusTopologyCacheForTests() {
  cachedTopology = undefined;
  cachedRoutes = undefined;
}

/**
 * The route whose `eventPrefix` the given type starts with, or `undefined`
 * if the type isn't classified onto a dedicated bus (in which case it
 * stays on the flat `domain` bus and, per `resolveEventBus` below, is
 * open to every consumer — `crossBus: "policy-required"` only ever
 * restricts the buses `routes.json` actually names).
 */
function matchRoute(eventType, routes) {
  return routes.find((route) => typeof eventType === "string" && eventType.startsWith(route.eventPrefix));
}

/** Which bus a given event type lands on: the `routes.json` entry whose
 * prefix it matches, or `DEFAULT_BUS_ID` ("domain") for everything else —
 * this is the mapping `createRedisEventBus` uses to pick a stream
 * namespace and the one the roadmap's own verification checks
 * (`identity.*` → `security`, not the flat `domain` one). */
export function resolveEventBus(eventType, routes = loadEventBusRoutes()) {
  return matchRoute(eventType, routes)?.bus ?? DEFAULT_BUS_ID;
}

const EVENTBUS_AUDIENCE = "eventbus";

/** Builds one `@ayzen/service-auth` policy per consumer service named in
 * `routes.json`, whose `allowedTargets` are every bus that service is
 * approved to read from. Recomputed per call (four routes, a handful of
 * consumers — not worth caching against config hot-reload/tests). */
function policyForConsumer(consumerService, routes) {
  const allowedTargets = new Set();
  for (const route of routes) {
    if (route.consumers?.includes(consumerService)) allowedTargets.add(route.bus);
  }
  return createServicePolicy({ service: consumerService, audience: EVENTBUS_AUDIENCE, allowedTargets: [...allowedTargets] });
}

/**
 * The cross-bus consumption decision itself. An event type with no
 * `routes.json` entry stays on the open `domain` bus — no approval
 * needed, same as before this phase. An event type that IS routed onto a
 * classified bus needs `consumerService` to appear in that route's
 * `consumers` list (via `authorizeServiceCall`'s `allowedTargets` check)
 * unless the topology's own `crossBus` flag has been explicitly turned
 * off, in which case an operator has declared they don't want this
 * checked at all — mirroring `policy.defaultDeny: false` in
 * `security-policy.mjs`'s own identity gate.
 */
export function authorizeCrossBusConsumption({
  consumerService,
  eventType,
  topology = loadEventBusTopology(),
  routes = loadEventBusRoutes(),
} = {}) {
  const route = matchRoute(eventType, routes);
  if (!route) return { decision: "allow", bus: DEFAULT_BUS_ID, code: "NOT_ROUTED" };
  if (topology.crossBus !== "policy-required") return { decision: "allow", bus: route.bus, code: "CROSS_BUS_POLICY_NOT_REQUIRED" };
  if (!consumerService) return { decision: "deny", bus: route.bus, code: "CONSUMER_SERVICE_UNKNOWN" };
  const policy = policyForConsumer(consumerService, routes);
  const result = authorizeServiceCall({ policy, caller: consumerService, target: route.bus, audience: EVENTBUS_AUDIENCE });
  return { decision: result.decision, bus: route.bus, code: result.code };
}

/**
 * Shared enforce/report/off gate, same three-state shape as
 * `eventBusIdentityGateMode` (H10.1) and `CAPABILITY_AUTHZ_GATE` (H9.2).
 *
 * Defaults to "report", not "enforce", for the same class of reason
 * H10.1's identity gate does: `consumerService` here is whatever H10.1
 * already resolves a subscriber's identity to (`SERVICE_NAME` if set,
 * else a per-process consumer id like `worker-58213`) — and today only
 * `apps/worker`'s container sets `SERVICE_NAME` at all (to `worker`,
 * not the `workflow-worker` / `audit` / `intelligence` / `admin` names
 * `routes.json` actually lists as approved consumers). Defaulting to
 * "enforce" before every service's deployment config sets `SERVICE_NAME`
 * to match its `routes.json` identity would deny real, intended
 * consumers — not just unapproved ones. "report" makes every such
 * mismatch visible in logs first, the same rollout this repo's own
 * SERVICE_CAPABILITY_GATE / CAPABILITY_AUTHZ_GATE precedent describes.
 * An explicit `topology.crossBus` value other than `"policy-required"`
 * still turns this fully "off", the same opt-out `eventBusIdentityGateMode`
 * gives `policy.defaultDeny: false`.
 */
export function eventBusCrossBusGateMode(topology = loadEventBusTopology()) {
  const raw = (process.env.EVENT_BUS_CROSS_BUS_GATE ?? "").toLowerCase();
  if (raw === "off" || raw === "report" || raw === "enforce") return raw;
  return topology?.crossBus === "policy-required" ? "report" : "off";
}
