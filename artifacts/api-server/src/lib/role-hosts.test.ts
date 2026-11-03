import assert from "node:assert/strict";
import test from "node:test";
import {
  decideRoleHostAccess, getCentralHosts, getRoleHostForHost, getRoleHostForRole,
  isRoleHostsEnabled, ROLE_HOST_DEFINITIONS,
} from "./role-hosts";

const ENV: NodeJS.ProcessEnv = {};
const d = (role: string, hostname: string, path: string, kind: "api" | "page", search = "") =>
  decideRoleHostAccess({ role, hostname, path, kind, search, env: ENV });

test("registry: defaults and role mapping", () => {
  assert.deepEqual(ROLE_HOST_DEFINITIONS.map((r) => r.defaultHost), ["admin.ayzen.tech", "mod.ayzen.tech", "team.ayzen.tech"]);
  assert.equal(getRoleHostForRole("admin")?.id, "admin");
  assert.equal(getRoleHostForRole("dev")?.id, "admin");
  assert.equal(getRoleHostForRole("moderator")?.id, "moderator");
  assert.equal(getRoleHostForRole("team_leader")?.id, "team_leader");
  assert.equal(getRoleHostForRole("user"), null);
  assert.equal(getRoleHostForHost("ADMIN.ayzen.tech:443", ENV)?.id, "admin");
  assert.equal(getRoleHostForHost("sylo.ayzen.tech", ENV), null);
});

test("env overrides host names; CENTRAL_HOSTS defaults to APP_URL host + workspace", () => {
  assert.equal(getRoleHostForHost("lead.ayzen.tech", { TEAM_LEADER_HOSTS: "lead.ayzen.tech" })?.id, "team_leader");
  assert.equal(getRoleHostForHost("team.ayzen.tech", { TEAM_LEADER_HOSTS: "lead.ayzen.tech" }), null);
  assert.deepEqual(getCentralHosts({}), ["ayzen.tech", "workspace.ayzen.tech"]);
  assert.deepEqual(getCentralHosts({ APP_URL: "https://app.example.test/" }), ["app.example.test", "workspace.ayzen.tech"]);
});

test("enforcement is opt-in", () => {
  assert.equal(isRoleHostsEnabled({}), false);
  assert.equal(isRoleHostsEnabled({ ROLE_HOSTS_ENABLED: "1" }), true);
  assert.equal(isRoleHostsEnabled({ ROLE_HOSTS_ENABLED: "true" }), false);
});

test("role host: matching role allowed, wrong role denied on API (not hidden)", () => {
  assert.deepEqual(d("admin", "admin.ayzen.tech", "/users", "api"), { action: "allow" });
  assert.deepEqual(d("dev", "admin.ayzen.tech", "/users", "api"), { action: "allow" });
  assert.deepEqual(d("user", "admin.ayzen.tech", "/users", "api"), { action: "deny", code: "ROLE_HOST_MISMATCH", expectedHost: "ayzen.tech" });
  assert.deepEqual(d("moderator", "admin.ayzen.tech", "/users", "api"), { action: "deny", code: "ROLE_HOST_MISMATCH", expectedHost: "mod.ayzen.tech" });
  assert.deepEqual(d("admin", "mod.ayzen.tech", "/users", "api"), { action: "deny", code: "ROLE_HOST_MISMATCH", expectedHost: "admin.ayzen.tech" });
});

test("role host: wrong-role page visit redirects to the role's own host, or central", () => {
  assert.deepEqual(d("moderator", "admin.ayzen.tech", "/admin/users", "page"), { action: "redirect", location: "https://mod.ayzen.tech/dashboard" });
  assert.deepEqual(d("user", "admin.ayzen.tech", "/admin/users", "page"), { action: "redirect", location: "https://ayzen.tech/" });
});

test("central host: roles with a dedicated host are redirected, path kept only when it belongs to the role", () => {
  assert.deepEqual(d("admin", "ayzen.tech", "/", "page"), { action: "redirect", location: "https://admin.ayzen.tech/admin/dashboard" });
  assert.deepEqual(d("admin", "ayzen.tech", "/admin/users", "page", "?q=1"), { action: "redirect", location: "https://admin.ayzen.tech/admin/users?q=1" });
  assert.deepEqual(d("admin", "workspace.ayzen.tech", "/home", "page"), { action: "redirect", location: "https://admin.ayzen.tech/admin/dashboard" });
  assert.deepEqual(d("team_leader", "ayzen.tech", "/teams", "page"), { action: "redirect", location: "https://team.ayzen.tech/teams" });
  assert.deepEqual(d("user", "ayzen.tech", "/home", "page"), { action: "allow" });
});

test("central host API traffic and module hosts are never blocked or redirected", () => {
  assert.deepEqual(d("admin", "ayzen.tech", "/users", "api"), { action: "allow" });
  assert.deepEqual(d("admin", "sylo.ayzen.tech", "/admin/vault", "page"), { action: "allow" });
  assert.deepEqual(d("moderator", "skarn.ayzen.tech", "/projects", "page"), { action: "allow" });
});

test("auth, health, public token pages and login are exempt everywhere", () => {
  assert.deepEqual(d("user", "admin.ayzen.tech", "/auth/me", "api"), { action: "allow" });
  assert.deepEqual(d("user", "admin.ayzen.tech", "/health", "api"), { action: "allow" });
  assert.deepEqual(d("user", "admin.ayzen.tech", "/login", "page"), { action: "allow" });
  assert.deepEqual(d("admin", "ayzen.tech", "/receipt/abc", "page"), { action: "allow" });
  assert.deepEqual(d("admin", "ayzen.tech", "/finance/invoice/tok", "page"), { action: "allow" });
});
