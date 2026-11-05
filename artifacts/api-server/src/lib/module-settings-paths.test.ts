import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { MODULES } from "@ayzen/module-registry";
import { SHARED_APP_DEFINITIONS } from "./shared-apps";
import { getTelegramBotDescriptor } from "./telegram-bot-registry";

// Frontend files are read as text: the SPA uses import.meta.env and is not importable from node:test.
const FRONTEND = new URL("../../../ayzen/src/", import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, FRONTEND), "utf8");

const settingsSource = read("lib/module-settings.ts");
const SETTINGS_PATHS = Object.fromEntries([...settingsSource.matchAll(/^\s+(\w+):\s*"(\/[^"]+)",?$/gm)].map((m) => [m[1], m[2]]));

const hasPrefix = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}?`);

test("every module has a settings path and every settings path belongs to a module", () => {
  assert.deepEqual(Object.keys(SETTINGS_PATHS).sort(), SHARED_APP_DEFINITIONS.map((a) => a.id).sort());
});

test("settings paths sit inside the module's routePrefixes (backend shared-apps.ts)", () => {
  for (const app of SHARED_APP_DEFINITIONS) {
    assert.ok(app.routePrefixes.some((p) => hasPrefix(SETTINGS_PATHS[app.id], p)), `${app.id}: ${SETTINGS_PATHS[app.id]} outside routePrefixes`);
  }
});

test("settings paths sit inside the module's routePrefixes (frontend subdomain-app.ts, derived from @ayzen/module-registry)", () => {
  // W0-P3: subdomain-app.ts no longer declares prefixes; it must derive from the shared registry.
  assert.match(read("lib/subdomain-app.ts"), /from "@ayzen\/module-registry"/);
  for (const [id, path] of Object.entries(SETTINGS_PATHS)) {
    const mod = MODULES.find((m) => m.id === id);
    assert.ok(mod, `${id} missing from @ayzen/module-registry`);
    assert.ok(mod.routePrefixes.some((p) => hasPrefix(path, p)), `${id}: ${path} outside registry routePrefixes`);
  }
});

test("module id is also a registered Telegram bot key (the card calls /telegram/bots/<id>/...)", () => {
  for (const id of Object.keys(SETTINGS_PATHS)) assert.ok(getTelegramBotDescriptor(id), `${id} has no bot`);
});

test("route-config registers every settings path before any /<module>/:param route", () => {
  const source = read("lib/route-config.tsx");
  for (const path of Object.values(SETTINGS_PATHS)) {
    const at = source.indexOf(`path: "${path}"`);
    assert.notEqual(at, -1, `${path} missing from USER_ROUTES`);
    const moduleRoot = path.replace(/\/settings$/, "");
    const param = source.indexOf(`path: "${moduleRoot}/:`);
    if (param !== -1) assert.ok(at < param, `${path} must come before ${moduleRoot}/:param`);
  }
});

test("module sidebar renders a Settings link for modules", () => {
  const source = read("components/layout/module-sidebar.tsx");
  assert.match(source, /moduleSettingsPath\(app\.id\)/);
  assert.match(source, /data-testid="module-settings-link"/);
});
