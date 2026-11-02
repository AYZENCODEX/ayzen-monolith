/**
 * Per-module Settings pages (Phase 5).
 *
 * Every module gets /<its first prefix>/settings, which sits inside that
 * module's routePrefixes (lib/subdomain-app.ts and api-server shared-apps.ts),
 * so the subdomain redirect in App.tsx does not bounce it to the module home.
 * Module ids double as Telegram bot keys (api-server telegram-bot-registry).
 */
export const MODULE_SETTINGS_PATHS = {
  sylo: "/vault/settings",
  ryft: "/wallet/settings",
  fyra: "/finance/settings",
  verve: "/marketplace/settings",
  skarn: "/projects/settings",
  warde: "/teams/settings",
  wisp: "/mailbox/settings",
  zynth: "/assistant/settings",
} as const;

export type ModuleSettingsId = keyof typeof MODULE_SETTINGS_PATHS;

export function moduleSettingsPath(moduleId: string): string | null {
  return (MODULE_SETTINGS_PATHS as Record<string, string>)[moduleId] ?? null;
}

/** Inverse lookup: which module a settings path belongs to (ignores query/hash/trailing slash). */
export function moduleIdForSettingsPath(path: string): ModuleSettingsId | null {
  const clean = path.split(/[?#]/)[0].replace(/\/+$/, "");
  const hit = Object.entries(MODULE_SETTINGS_PATHS).find(([, p]) => p === clean);
  return hit ? (hit[0] as ModuleSettingsId) : null;
}
