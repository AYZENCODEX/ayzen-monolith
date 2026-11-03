/**
 * lib/role-hosts.ts
 *
 * Phase 7 — role domains (admin / moderator / team leader).
 *
 * Source of truth for "which role lives on which host", the role-side
 * counterpart of lib/shared-apps.ts (which maps hosts to product modules).
 * Pure and dependency-free so unit tests and scripts can import it.
 *
 *   ADMIN_HOSTS        default admin.ayzen.tech   roles: admin, dev
 *   MODERATOR_HOSTS    default mod.ayzen.tech     roles: moderator
 *   TEAM_LEADER_HOSTS  default team.ayzen.tech    roles: team_leader
 *                      (host name is an ASSUMPTION — confirm, then set the env)
 *   CENTRAL_HOSTS      hosts that behave as the central app; a role with a
 *                      dedicated host is redirected away from them
 *                      (default: APP_URL host + workspace.ayzen.tech)
 *   ROLE_HOSTS_ENABLED "1" turns enforcement on. Off by default so nothing
 *                      changes until the DNS / custom domains exist.
 *
 * Authorization itself is still owned by requireRoles()/the policy engine.
 * This module only decides which HOST a role belongs on.
 */

export type RoleHostId = "admin" | "moderator" | "team_leader";

export interface RoleHostDefinition {
  id: RoleHostId;
  label: string;
  /** Backend `users.role` values that live on this host. */
  roles: readonly string[];
  /** Where a role lands on "/" and after login. */
  homePath: string;
  /** Paths that belong to this role; used to decide whether a redirect keeps the path or lands on home. */
  routePrefixes: readonly string[];
  hostEnv: string;
  defaultHost: string;
}

export const ROLE_HOST_DEFINITIONS: readonly RoleHostDefinition[] = [
  { id: "admin", label: "Admin", roles: ["admin", "dev"], homePath: "/admin/dashboard", routePrefixes: ["/admin"], hostEnv: "ADMIN_HOSTS", defaultHost: "admin.ayzen.tech" },
  {
    id: "moderator", label: "Moderator", roles: ["moderator"], homePath: "/dashboard",
    routePrefixes: ["/moderator", "/admin/projects", "/admin/project-templates", "/admin/tasks", "/admin/teams"],
    hostEnv: "MODERATOR_HOSTS", defaultHost: "mod.ayzen.tech",
  },
  { id: "team_leader", label: "Team leader", roles: ["team_leader"], homePath: "/teams", routePrefixes: ["/team_leader", "/teams"], hostEnv: "TEAM_LEADER_HOSTS", defaultHost: "team.ayzen.tech" },
];

/** Public / token / auth pages that must render on any host for any visitor. */
export const ROLE_HOST_EXEMPT_PREFIXES: readonly string[] = [
  "/login", "/register", "/forgot-password", "/status", "/emergency-access",
  "/finance/receipt", "/finance/invoice", "/finance/payment-agreement", "/receipt", "/oidc/callback",
];

/** API paths (relative to /api) the gate never blocks, so a mismatched session can still learn who it is and sign out. */
export const ROLE_HOST_EXEMPT_API_PREFIXES: readonly string[] = ["/auth", "/health", "/telegram/gateway"];

export function normalizeHostname(host: string | undefined | null): string {
  return (host ?? "").trim().toLowerCase().split(":")[0];
}

function parseList(raw: string | undefined, fallback: string[]): string[] {
  const list = (raw ?? "").split(",").map((h) => normalizeHostname(h)).filter(Boolean);
  return list.length > 0 ? list : fallback;
}

export function isRoleHostsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ROLE_HOSTS_ENABLED === "1";
}

export function getRoleHostHosts(def: RoleHostDefinition, env: NodeJS.ProcessEnv = process.env): string[] {
  return parseList(env[def.hostEnv], [def.defaultHost]);
}

export function getCentralHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  let appHost = "ayzen.tech";
  try { appHost = normalizeHostname(new URL(env.APP_URL?.trim() || "https://ayzen.tech").host); } catch { /* keep default */ }
  return parseList(env.CENTRAL_HOSTS, [...new Set([appHost, "workspace.ayzen.tech"])]);
}

export function getRoleHostForHost(hostname: string | undefined | null, env: NodeJS.ProcessEnv = process.env): RoleHostDefinition | null {
  const host = normalizeHostname(hostname);
  if (!host) return null;
  return ROLE_HOST_DEFINITIONS.find((def) => getRoleHostHosts(def, env).includes(host)) ?? null;
}

export function getRoleHostForRole(role: string | undefined | null): RoleHostDefinition | null {
  if (!role) return null;
  return ROLE_HOST_DEFINITIONS.find((def) => def.roles.includes(role)) ?? null;
}

export function isCentralHost(hostname: string | undefined | null, env: NodeJS.ProcessEnv = process.env): boolean {
  return getCentralHosts(env).includes(normalizeHostname(hostname));
}

function hasPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix + "/") || path.startsWith(prefix + "?");
}

export function isExemptPagePath(path: string): boolean {
  const p = path.split("?")[0];
  return ROLE_HOST_EXEMPT_PREFIXES.some((prefix) => p === prefix || p.startsWith(prefix + "/"));
}

export function isExemptApiPath(path: string): boolean {
  return ROLE_HOST_EXEMPT_API_PREFIXES.some((prefix) => hasPrefix(path, prefix));
}

export type RoleHostDecision =
  | { action: "allow" }
  | { action: "redirect"; location: string }
  | { action: "deny"; code: "ROLE_HOST_MISMATCH"; expectedHost: string | null };

export interface RoleHostInput {
  /** The authenticated user's `users.role`. */
  role: string;
  /** Host the request is acting for (see resolveCallerHost in middlewares/role-host.ts). */
  hostname: string;
  /** Path (page path, or path relative to /api for API requests). */
  path: string;
  kind: "api" | "page";
  /** Query string including the leading "?", preserved when a page redirect keeps the path. */
  search?: string;
  env?: NodeJS.ProcessEnv;
}

function originFor(def: RoleHostDefinition, env: NodeJS.ProcessEnv): string {
  return `https://${getRoleHostHosts(def, env)[0]}`;
}

/** Where a role with no dedicated host belongs: the central app. */
function centralOrigin(env: NodeJS.ProcessEnv): string {
  return `https://${getCentralHosts(env)[0]}`;
}

/**
 * The decision table:
 *
 *   on a role host, role belongs there            → allow
 *   on a role host, role does NOT belong there    → api: deny (403) / page: redirect to the
 *                                                   role's own host (or central if it has none)
 *   on the central host, role has its own host    → api: allow / page: redirect to that host
 *   anywhere else (module hosts, unknown hosts)   → allow (admin pages mirrored per module stay put)
 */
export function decideRoleHostAccess(input: RoleHostInput): RoleHostDecision {
  const env = input.env ?? process.env;
  const hostDef = getRoleHostForHost(input.hostname, env);
  const ownDef = getRoleHostForRole(input.role);
  const exempt = input.kind === "api" ? isExemptApiPath(input.path) : isExemptPagePath(input.path);
  if (exempt) return { action: "allow" };

  if (hostDef) {
    if (hostDef.roles.includes(input.role)) return { action: "allow" };
    if (input.kind === "api") {
      return { action: "deny", code: "ROLE_HOST_MISMATCH", expectedHost: ownDef ? getRoleHostHosts(ownDef, env)[0] : getCentralHosts(env)[0] };
    }
    const target = ownDef ? `${originFor(ownDef, env)}${ownDef.homePath}` : `${centralOrigin(env)}/`;
    return { action: "redirect", location: target };
  }

  if (input.kind === "page" && ownDef && isCentralHost(input.hostname, env)) {
    const keep = input.path !== "/" && ownDef.routePrefixes.some((p) => hasPrefix(input.path, p));
    return { action: "redirect", location: `${originFor(ownDef, env)}${keep ? input.path + (input.search ?? "") : ownDef.homePath}` };
  }

  return { action: "allow" };
}
