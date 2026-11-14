import test from "node:test";
import assert from "node:assert/strict";
import { MODULES, MODULE_HOST_ALLOWED_PREFIXES, decideModuleHostAccess, pathCandidates } from "@ayzen/module-registry";
import {
  evaluateGuard, isModuleHostGuardEnforcing, isRegisteredFirstPartyOrigin, moduleFrameAncestors, moduleHostGuardMode, sharedPrefixes,
} from "./module-host-guard-core";

const env = (o: Record<string, string> = {}) => o as NodeJS.ProcessEnv;
const own = (m: { routePrefixes: readonly string[] }) => m.routePrefixes[0];

test("mode: unknown or missing value is off; only owned|strict enforce", () => {
  assert.equal(moduleHostGuardMode(env()), "off");
  assert.equal(moduleHostGuardMode(env({ MODULE_HOST_GUARD_MODE: "STRICT " })), "strict");
  assert.equal(moduleHostGuardMode(env({ MODULE_HOST_GUARD_MODE: "yes" })), "off");
  assert.equal(isModuleHostGuardEnforcing(env({ MODULE_HOST_GUARD_MODE: "report" })), false);
  assert.equal(isModuleHostGuardEnforcing(env({ MODULE_HOST_GUARD_MODE: "owned" })), true);
});

test("isolation matrix: every module host gets 404 on every OTHER module's prefix, and keeps its own + plumbing", () => {
  for (const m of MODULES) for (const other of MODULES) for (const p of other.routePrefixes) {
    const d = decideModuleHostAccess({ module: m.id, path: `${p}/x` });
    if (other.id === m.id) assert.equal(d.action, "allow", `${m.id} must keep ${p}`);
    else assert.deepEqual([d.action, d.owner], ["deny", other.id], `${m.id} -> ${p}`);
  }
  for (const m of MODULES) for (const a of MODULE_HOST_ALLOWED_PREFIXES) {
    assert.equal(decideModuleHostAccess({ module: m.id, path: `${a}/x`, strict: true }).action, "allow", `${m.id} ${a}`);
  }
});

test("registry sanity: no prefix is owned by two modules, none collides with the allow-list", () => {
  const seen = new Map<string, string>();
  for (const m of MODULES) for (const p of m.routePrefixes) {
    assert.ok(!seen.has(p), `${p} owned by ${seen.get(p)} and ${m.id}`);
    seen.set(p, m.id);
    assert.ok(!MODULE_HOST_ALLOWED_PREFIXES.some((a) => p === a || p.startsWith(a + "/")), `${p} collides with allow-list`);
  }
});

test("path tricks cannot reach another module: case, //, ./.., percent-encoding, query, allow-list laundering", () => {
  const fyra = MODULES.find((m) => m.id === "fyra")!, p = own(fyra); // /finance
  const tricks = [p.toUpperCase(), `/${p}`, `/./${p.slice(1)}`, `/vault/../${p.slice(1)}`, `/auth/../${p.slice(1)}`, `/health/..${p}`,
    "/%66inance", "/%46INANCE/x", `${p}?next=/vault`, `${p}#/vault`, `/oidc/%2e%2e${p}`];
  for (const t of tricks) for (const strict of [false, true]) {
    assert.equal(decideModuleHostAccess({ module: "sylo", path: t, strict }).action, "deny", `${t} (strict=${strict})`);
  }
  for (const bad of ["/%zz", "/a%00b", "/a\\b", "/%5cfinance"]) assert.equal(decideModuleHostAccess({ module: "sylo", path: bad }).reason, "malformed_path", bad);
  assert.equal(pathCandidates("/%zz"), null);
});

test("an allow-listed prefix is a boundary, not a substring", () => {
  assert.equal(decideModuleHostAccess({ module: "sylo", path: "/authx/y", strict: true }).action, "deny");
  assert.equal(decideModuleHostAccess({ module: "sylo", path: "/auth", strict: true }).action, "allow");
  assert.equal(decideModuleHostAccess({ module: "sylo", path: "/.well-known/openid-configuration", strict: true }).action, "allow");
  assert.equal(decideModuleHostAccess({ module: "sylo", path: "/vaultx", strict: false }).action, "allow"); // unowned, not "vault"
});

test("unowned paths: allowed in owned mode, denied in strict unless shared-listed", () => {
  assert.equal(decideModuleHostAccess({ module: "sylo", path: "/users/me" }).action, "allow");
  assert.equal(decideModuleHostAccess({ module: "sylo", path: "/users/me", strict: true }).action, "deny");
  assert.equal(decideModuleHostAccess({ module: "sylo", path: "/users/me", strict: true, sharedPrefixes: ["/users"] }).action, "allow");
  assert.deepEqual(sharedPrefixes(env({ MODULE_HOST_GUARD_SHARED_PREFIXES: "/users, /Notifications ,bad,/x" })), ["/users", "/notifications", "/x"]);
});

test("unknown module id never gets access", () => {
  assert.equal(decideModuleHostAccess({ module: "nope", path: "/auth" }).action, "deny");
});

test("evaluateGuard: off and no-module are never refused; report logs but does not refuse; owned/strict refuse", () => {
  assert.equal(evaluateGuard("off", "sylo", "/finance").refuse, false);
  assert.equal(evaluateGuard("owned", null, "/finance").refuse, false);
  const rep = evaluateGuard("report", "sylo", "/finance");
  assert.deepEqual([rep.refuse, rep.wouldDeny], [false, true]);
  assert.equal(evaluateGuard("owned", "sylo", "/finance").refuse, true);
  assert.equal(evaluateGuard("owned", "sylo", "/vault/items").refuse, false);
  assert.equal(evaluateGuard("owned", "sylo", "/users").refuse, false);
  assert.equal(evaluateGuard("strict", "sylo", "/users").refuse, true);
});

test("per-module CORS: only registered first-party hosts; localhost and non-first-party are not this check's business", () => {
  const e = env();
  for (const m of MODULES) assert.equal(isRegisteredFirstPartyOrigin(m.defaultHost ? `https://${m.defaultHost}` : "", e), true, m.id);
  for (const ok of ["https://api.ayzen.tech", "https://ayzen.tech", "https://admin.ayzen.tech", "https://mod.ayzen.tech", "https://team.ayzen.tech", "https://mcp.ayzen.tech"]) assert.equal(isRegisteredFirstPartyOrigin(ok, e), true, ok);
  assert.equal(isRegisteredFirstPartyOrigin("https://forgotten.ayzen.tech", e), false);
  assert.equal(isRegisteredFirstPartyOrigin("https://id.ayzen.tech", e), false, "OIDC issuer host is trusted only when configured");
  assert.equal(isRegisteredFirstPartyOrigin("https://id.ayzen.tech", env({ AYZEN_OIDC_ISSUER: "https://id.ayzen.tech" })), true);
  assert.equal(isRegisteredFirstPartyOrigin("https://x.ayzen.tech", env({ MODULE_CORS_EXTRA_HOSTS: "X.ayzen.tech" })), true);
  assert.equal(isRegisteredFirstPartyOrigin("http://sylo.localhost", e), true);
  assert.equal(isRegisteredFirstPartyOrigin("https://evil.example", e), true, "not first-party: left to ALLOWED_ORIGINS");
});

test("frame-ancestors: self plus https extras only", () => {
  assert.equal(moduleFrameAncestors(env()), "'self'");
  assert.equal(moduleFrameAncestors(env({ MODULE_FRAME_ANCESTORS_EXTRA: "https://ayzen.tech, http://bad.test, *, https://x.y;script-src" })), "'self' https://ayzen.tech");
});
