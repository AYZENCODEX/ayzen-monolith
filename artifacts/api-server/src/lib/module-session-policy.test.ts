import assert from "node:assert/strict";
import test from "node:test";
import { MODULES } from "@ayzen/module-registry";
import {
  decideTokenModuleAccess, legacySessionsAcceptedOnModuleHosts, moduleCookieName, parseModuleClaims, readModuleSessionsConfig,
  resolveRequestModule, selectSessionToken, type ModuleSessionsConfig,
} from "./module-session-policy";

const IDS = MODULES.map((m) => m.id);
const cfg = (mode: ModuleSessionsConfig["mode"], legacyUntil: Date | null = null): ModuleSessionsConfig => ({ mode, legacyUntil });

test("config: off by default; unknown values fail closed and are reported", () => {
  assert.equal(readModuleSessionsConfig({}).mode, "off");
  assert.equal(readModuleSessionsConfig({ MODULE_SESSIONS_MODE: "" }).mode, "off");
  assert.equal(readModuleSessionsConfig({ MODULE_SESSIONS_MODE: " DUAL " }).mode, "dual");
  assert.equal(readModuleSessionsConfig({ MODULE_SESSIONS_MODE: "strict" }).mode, "strict");
  const bad = readModuleSessionsConfig({ MODULE_SESSIONS_MODE: "yes please" });
  assert.equal(bad.mode, "off");
  assert.deepEqual(bad.invalid, ['MODULE_SESSIONS_MODE="yes please"']);
});

test("config: an unparseable grace deadline means 'already over', never 'no deadline'", () => {
  const c = readModuleSessionsConfig({ MODULE_SESSIONS_MODE: "dual", MODULE_SESSIONS_LEGACY_UNTIL: "next tuesday-ish" });
  assert.equal(c.legacyUntil?.getTime(), 0);
  assert.equal(c.invalid?.length, 1);
  assert.equal(legacySessionsAcceptedOnModuleHosts(c, new Date("2026-11-10T00:00:00Z")), false);
  const ok = readModuleSessionsConfig({ MODULE_SESSIONS_MODE: "dual", MODULE_SESSIONS_LEGACY_UNTIL: "2026-12-01T00:00:00Z" });
  assert.equal(ok.legacyUntil?.toISOString(), "2026-12-01T00:00:00.000Z");
  assert.equal(ok.invalid, undefined);
});

test("grace window: off = untouched, dual = until the deadline (exclusive), strict = never", () => {
  const before = new Date("2026-11-30T23:59:59Z"), at = new Date("2026-12-01T00:00:00Z");
  assert.equal(legacySessionsAcceptedOnModuleHosts(cfg("off"), at), true);
  assert.equal(legacySessionsAcceptedOnModuleHosts(cfg("dual"), at), true, "no deadline set");
  assert.equal(legacySessionsAcceptedOnModuleHosts(cfg("dual", at), before), true);
  assert.equal(legacySessionsAcceptedOnModuleHosts(cfg("dual", at), at), false);
  assert.equal(legacySessionsAcceptedOnModuleHosts(cfg("strict"), before), false);
});

test("cookie name: __Host- prefix in production, plain name in dev", () => {
  assert.equal(moduleCookieName("sylo", true), "__Host-sylo_sid");
  assert.equal(moduleCookieName("sylo", false), "sylo_sid");
  assert.equal(new Set(IDS.map((i) => moduleCookieName(i, true))).size, IDS.length, "one distinct cookie per module");
});

test("resolveRequestModule: module hosts resolve (case/port-insensitive); everything else is null", () => {
  for (const m of MODULES) {
    assert.equal(resolveRequestModule(`${m.id}.ayzen.tech`), m.id);
    assert.equal(resolveRequestModule(`${m.id.toUpperCase()}.AYZEN.TECH:443`), m.id);
  }
  for (const h of ["ayzen.tech", "api.ayzen.tech", "mcp.ayzen.tech", "admin.ayzen.tech", "evil.com", "sylo.ayzen.tech.evil.com", "", undefined, null]) {
    assert.equal(resolveRequestModule(h as string | undefined), null, String(h));
  }
});

// ─── cookie selection ────────────────────────────────────────────────────────

test("selectSessionToken: module cookie wins on its own host; another module's cookie is never read", () => {
  const cookies = { __Host_x: "n/a", "__Host-sylo_sid": "SYLO", "__Host-ryft_sid": "RYFT", ayzen_session: "SHARED" };
  const pick = (contextModule: any, config: ModuleSessionsConfig) => selectSessionToken({ contextModule, cookies, config, hostPrefix: true });
  assert.deepEqual(pick("sylo", cfg("dual")), { token: "SYLO", source: "module" });
  assert.deepEqual(pick("ryft", cfg("strict")), { token: "RYFT", source: "module" });
  assert.deepEqual(pick("fyra", cfg("dual")), { token: "SHARED", source: "legacy" }, "fyra has no cookie: shared fallback, never sylo's or ryft's");
  assert.equal(pick("fyra", cfg("strict")), null, "strict: no shared fallback on a module host");
  assert.deepEqual(pick(null, cfg("strict")), { token: "SHARED", source: "legacy" }, "off a module host nothing changes");
  assert.deepEqual(pick("sylo", cfg("off")), { token: "SHARED", source: "legacy" }, "feature off: module cookie ignored");
});

test("selectSessionToken: empty/garbage values and past-deadline fallback", () => {
  const cookies = { "__Host-sylo_sid": "", ayzen_session: 42 as unknown };
  assert.equal(selectSessionToken({ contextModule: "sylo", cookies, config: cfg("dual"), hostPrefix: true }), null);
  assert.equal(selectSessionToken({ contextModule: "sylo", cookies: undefined, config: cfg("dual") }), null);
  const late = selectSessionToken({
    contextModule: "sylo", cookies: { ayzen_session: "S" }, config: cfg("dual", new Date("2026-12-01T00:00:00Z")), now: new Date("2026-12-02T00:00:00Z"),
  });
  assert.equal(late, null, "grace is over");
});

// ─── the isolation rule ──────────────────────────────────────────────────────

test("8x8 matrix: a token of module i is allowed on module j's host ONLY when i == j (every mode that enables modules)", () => {
  for (const mode of ["dual", "strict"] as const) {
    let checked = 0;
    for (const i of IDS) for (const j of IDS) {
      const d = decideTokenModuleAccess({ tokenModule: i, contextModule: j, config: cfg(mode) });
      assert.equal(d.allow, i === j, `${mode}: token ${i} on host ${j}`);
      if (!d.allow) assert.equal(d.code, "MODULE_SESSION_WRONG_MODULE");
      checked++;
    }
    assert.equal(checked, 64);
  }
});

test("a module token is refused with no module context (central app, API host, workers) and when the feature is off", () => {
  for (const i of IDS) {
    assert.deepEqual(decideTokenModuleAccess({ tokenModule: i, contextModule: null, config: cfg("dual") }), { allow: false, code: "MODULE_SESSION_NO_CONTEXT" });
    assert.deepEqual(decideTokenModuleAccess({ tokenModule: i, contextModule: i, config: cfg("off") }), { allow: false, code: "MODULE_SESSIONS_DISABLED" }, "kill switch");
    assert.deepEqual(decideTokenModuleAccess({ tokenModule: i, contextModule: null, config: cfg("off") }), { allow: false, code: "MODULE_SESSIONS_DISABLED" });
  }
});

test("a shared token: unchanged off a module host and with the feature off; gated on module hosts by mode and grace", () => {
  const now = new Date("2026-11-10T00:00:00Z");
  for (const j of IDS) {
    assert.deepEqual(decideTokenModuleAccess({ tokenModule: null, contextModule: j, config: cfg("off"), now }), { allow: true });
    assert.deepEqual(decideTokenModuleAccess({ tokenModule: null, contextModule: j, config: cfg("dual", new Date("2026-11-24T00:00:00Z")), now }), { allow: true });
    assert.deepEqual(decideTokenModuleAccess({ tokenModule: null, contextModule: j, config: cfg("dual", new Date("2026-11-01T00:00:00Z")), now }), { allow: false, code: "LEGACY_SESSION_NOT_ACCEPTED_ON_MODULE_HOST" });
    assert.deepEqual(decideTokenModuleAccess({ tokenModule: null, contextModule: j, config: cfg("strict"), now }), { allow: false, code: "LEGACY_SESSION_NOT_ACCEPTED_ON_MODULE_HOST" });
  }
  for (const mode of ["off", "dual", "strict"] as const) {
    assert.deepEqual(decideTokenModuleAccess({ tokenModule: null, contextModule: null, config: cfg(mode), now }), { allow: true }, `${mode}: central app unaffected`);
  }
});

// ─── token claims ────────────────────────────────────────────────────────────

test("parseModuleClaims: both or neither; unknown modules and bad account ids make the token invalid", () => {
  assert.deepEqual(parseModuleClaims({ userId: 1 }), { ok: true, mod: null, mac: null });
  assert.deepEqual(parseModuleClaims({ mod: "sylo", mac: 7 }), { ok: true, mod: "sylo", mac: 7 });
  const bad: Array<Record<string, unknown>> = [
    { mod: "sylo" }, { mac: 7 }, { mod: "exchange", mac: 7 }, { mod: "SYLO", mac: 7 }, { mod: ["sylo"], mac: 7 }, { mod: null, mac: 7 }, { mod: "sylo", mac: null },
    { mod: "sylo", mac: "7" }, { mod: "sylo", mac: 0 }, { mod: "sylo", mac: -3 }, { mod: "sylo", mac: 1.5 }, { mod: "sylo", mac: Number.MAX_SAFE_INTEGER + 2 }, { mod: "", mac: 1 },
  ];
  for (const b of bad) assert.deepEqual(parseModuleClaims(b), { ok: false }, JSON.stringify(b));
});
