/**
 * role-hosts.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 7 — role domains (admin / moderator / team leader). Frontend mirror of
 * the server registry in artifacts/api-server/src/lib/role-hosts.ts; keep the
 * two in step (same ids, roles, home paths and default hosts).
 *
 *   VITE_ROLE_HOSTS=1            turns role-host redirects on (off by default,
 *                                so nothing changes until the hosts exist)
 *   VITE_ADMIN_HOSTS             default admin.ayzen.tech
 *   VITE_MODERATOR_HOSTS         default mod.ayzen.tech
 *   VITE_TEAM_LEADER_HOSTS       default team.ayzen.tech (assumed name)
 *   VITE_CENTRAL_HOSTS           default ayzen.tech,workspace.ayzen.tech
 *
 * The server is the authority (it denies a wrong-role session on a role host);
 * this file only makes the browser land on the right host without a bounce.
 * Admin pages mirrored per module (/admin/vault …) stay on the module hosts —
 * role hosts never pull a visitor off a module host.
 */

import { ALWAYS_ALLOWED_PREFIXES } from "@/lib/subdomain-app";

export type RoleHostId = "admin" | "moderator" | "team_leader";

export interface RoleHost {
  id: RoleHostId;
  label: string;
  roles: readonly string[];
  homePath: string;
  routePrefixes: readonly string[];
  hosts: string[];
}

function hostList(raw: unknown, fallback: string[]): string[] {
  const list = String(raw ?? "").split(",").map((h) => h.trim().toLowerCase().split(":")[0]).filter(Boolean);
  return list.length > 0 ? list : fallback;
}

const env = import.meta.env as Record<string, string | undefined>;

export const ROLE_HOSTS: readonly RoleHost[] = [
  { id: "admin", label: "Admin", roles: ["admin", "dev"], homePath: "/admin/dashboard", routePrefixes: ["/admin"], hosts: hostList(env.VITE_ADMIN_HOSTS, ["admin.ayzen.tech"]) },
  {
    id: "moderator", label: "Moderator", roles: ["moderator"], homePath: "/dashboard",
    routePrefixes: ["/moderator", "/admin/projects", "/admin/project-templates", "/admin/tasks", "/admin/teams"],
    hosts: hostList(env.VITE_MODERATOR_HOSTS, ["mod.ayzen.tech"]),
  },
  { id: "team_leader", label: "Team leader", roles: ["team_leader"], homePath: "/teams", routePrefixes: ["/team_leader", "/teams"], hosts: hostList(env.VITE_TEAM_LEADER_HOSTS, ["team.ayzen.tech"]) },
];

const CENTRAL_HOSTS = hostList(env.VITE_CENTRAL_HOSTS, ["ayzen.tech", "workspace.ayzen.tech"]);

export function isRoleHostsEnabled(): boolean {
  return String(env.VITE_ROLE_HOSTS ?? "") === "1";
}

export function getRoleHostForRole(role: string | undefined | null): RoleHost | null {
  return role ? ROLE_HOSTS.find((r) => r.roles.includes(role)) ?? null : null;
}

export function getCurrentRoleHost(hostname: string = window.location.hostname): RoleHost | null {
  const host = hostname.toLowerCase();
  return ROLE_HOSTS.find((r) => r.hosts.includes(host)) ?? null;
}

function hasPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix + "/") || path.startsWith(prefix + "?");
}

function isPublicPath(path: string): boolean {
  const p = path.split("?")[0];
  return ALWAYS_ALLOWED_PREFIXES.some((prefix) => p === prefix || p.startsWith(prefix + "/"));
}

/**
 * Absolute URL this signed-in role should be on for `path`, or null when it is
 * already in the right place (or role hosts are not enabled). Same decision
 * table as the server's decideRoleHostAccess() for page requests.
 */
export function getRoleHostRedirect(
  role: string,
  path: string,
  hostname: string = window.location.hostname,
): string | null {
  if (!isRoleHostsEnabled() || isPublicPath(path)) return null;
  const host = hostname.toLowerCase();
  const onRoleHost = getCurrentRoleHost(host);
  const own = getRoleHostForRole(role);

  if (onRoleHost) {
    if (onRoleHost.roles.includes(role)) return null;
    return own ? `https://${own.hosts[0]}${own.homePath}` : `https://${CENTRAL_HOSTS[0]}/`;
  }
  if (own && CENTRAL_HOSTS.includes(host)) {
    const clean = path.startsWith("/") ? path : "/" + path;
    const keep = clean !== "/" && own.routePrefixes.some((p) => hasPrefix(clean, p));
    return `https://${own.hosts[0]}${keep ? clean : own.homePath}`;
  }
  return null;
}
