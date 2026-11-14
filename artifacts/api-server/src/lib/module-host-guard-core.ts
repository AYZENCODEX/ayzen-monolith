/**
 * lib/module-host-guard-core.ts — W2-P1: the pure half of the module host guard (mode switch, decision, registered-origin check,
 * frame-ancestors value). No logger, no express: importable by tests and scripts without installing anything.
 * The middleware that uses it is lib/module-host-guard.ts (read its header for the full design).
 */
import { decideModuleHostAccess, type ModuleId } from "@ayzen/module-registry";
import { getApiHosts, getMcpHosts, isFirstPartyProdOrigin } from "./api-hosts";
import { SHARED_APP_DEFINITIONS, getSharedAppHosts } from "./shared-apps";
import { ROLE_HOST_DEFINITIONS, getCentralHosts, getRoleHostHosts, normalizeHostname } from "./role-hosts";

export type ModuleHostGuardMode = "off" | "report" | "owned" | "strict";
const MODES: readonly ModuleHostGuardMode[] = ["off", "report", "owned", "strict"];

export function moduleHostGuardMode(env: NodeJS.ProcessEnv = process.env): ModuleHostGuardMode {
  const raw = env.MODULE_HOST_GUARD_MODE?.trim().toLowerCase();
  return (MODES as readonly string[]).includes(raw ?? "") ? (raw as ModuleHostGuardMode) : "off";
}
/** owned / strict: the guard refuses requests and the CORS + header tightening is on. */
export const isModuleHostGuardEnforcing = (env: NodeJS.ProcessEnv = process.env): boolean => {
  const m = moduleHostGuardMode(env);
  return m === "owned" || m === "strict";
};

export function sharedPrefixes(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.MODULE_HOST_GUARD_SHARED_PREFIXES ?? "").split(",").map((p) => p.trim().toLowerCase()).filter((p) => p.startsWith("/"));
}

/** Pure core, exported for tests: what the guard does for (mode, module, path). */
export function evaluateGuard(mode: ModuleHostGuardMode, module: ModuleId | null, path: string, env: NodeJS.ProcessEnv = process.env) {
  if (mode === "off" || !module) return { refuse: false as const, wouldDeny: false, reason: "n/a" };
  const d = decideModuleHostAccess({ module, path, strict: mode === "strict", sharedPrefixes: sharedPrefixes(env) });
  const wouldDeny = d.action === "deny";
  return { refuse: wouldDeny && mode !== "report", wouldDeny, reason: d.reason };
}

// ─── per-module CORS allow-list ──────────────────────────────────────────────────────────────────────────────────

function registeredHosts(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const hosts = new Set<string>([...getApiHosts(), ...getMcpHosts(), ...getCentralHosts(env)]);
  for (const d of SHARED_APP_DEFINITIONS) for (const h of getSharedAppHosts(d)) hosts.add(h);
  for (const d of ROLE_HOST_DEFINITIONS) for (const h of getRoleHostHosts(d, env)) hosts.add(h);
  for (const raw of [env.AYZEN_OIDC_ISSUER, env.APP_URL]) { try { if (raw) hosts.add(normalizeHostname(new URL(raw).host)); } catch { /* ignore */ } }
  for (const h of (env.MODULE_CORS_EXTRA_HOSTS ?? "").split(",")) if (h.trim()) hosts.add(normalizeHostname(h));
  return hosts;
}

/**
 * Production first-party origins are only trusted when they are a REGISTERED host (module, role, central, API, MCP, OIDC
 * issuer, or MODULE_CORS_EXTRA_HOSTS), not merely "<anything>.ayzen.tech": a forgotten or hijacked subdomain gets no CORS.
 * Origins that are not production first-party (localhost dev, explicit ALLOWED_ORIGINS) are left to the existing rules.
 */
export function isRegisteredFirstPartyOrigin(origin: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!isFirstPartyProdOrigin(origin)) return true;
  try { return registeredHosts(env).has(normalizeHostname(new URL(origin).host)); } catch { return false; }
}

// ─── per-module response headers ─────────────────────────────────────────────────────────────────────────────────

/**
 * On a module's own host: `frame-ancestors 'self'` (+ MODULE_FRAME_ANCESTORS_EXTRA origins) so no other site, and no other
 * module, can embed it, and an explicit `Referrer-Policy: no-referrer`. Only the frame-ancestors directive is set, so it
 * cannot break scripts or styles; helmet's X-Frame-Options: SAMEORIGIN already says the same for old browsers.
 */
export function moduleFrameAncestors(env: NodeJS.ProcessEnv = process.env): string {
  const extra = (env.MODULE_FRAME_ANCESTORS_EXTRA ?? "").split(",").map((s) => s.trim()).filter((s) => /^https:\/\/[a-z0-9.-]+$/i.test(s));
  return ["'self'", ...extra].join(" ");
}
