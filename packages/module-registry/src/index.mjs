/**
 * @ayzen/module-registry (W0-P3)
 *
 * Single source of truth for the eight AYZEN modules. Replaces the two hand-synced
 * copies that used to live in artifacts/api-server/src/lib/shared-apps.ts
 * (SHARED_APP_DEFINITIONS) and artifacts/ayzen/src/lib/subdomain-app.ts
 * (SUBDOMAIN_APPS). Both now derive from MODULES below.
 *
 * Pure data + pure helpers: no DOM, no process.env reads, no I/O, so it is safe to
 * bundle into the SPA and the API server alike. Host resolution that needs an
 * environment (SYLO_HOSTS / VITE_SYLO_HOSTS) stays in the consumers.
 *
 * Fields reserved for later waves are present but null until their phase lands:
 *   clerkApp (W1-P5), oidcClientId (W1-P3), mcpEndpoint (W3-P3).
 */

/** @typedef {"sylo"|"ryft"|"fyra"|"verve"|"skarn"|"warde"|"wisp"|"zynth"} ModuleId */

const defineModule = (m) =>
  Object.freeze({ ...m, routePrefixes: Object.freeze([...m.routePrefixes]), kind: "module" });

// Declaration order = historical backend order. UI order comes from `order`.
export const MODULES = Object.freeze([
  defineModule({
    id: "sylo", label: "Sylo", uidPrefix: "SYL", order: 1,
    description: "Vault — credentials, entities and wallets.",
    homePath: "/vault",
    // Module Shell Split S1: sylo owns /admin/team-vault outright (it serves vault data).
    routePrefixes: ["/vault", "/admin/vault", "/admin/team-vault"],
    hostEnv: "SYLO_HOSTS", defaultHost: "sylo.ayzen.tech",
    telegramBot: "sylo", clerkApp: null, oidcClientId: "sylo", mcpEndpoint: null,
  }),
  defineModule({
    id: "ryft", label: "Ryft", uidPrefix: "RFT", order: 2,
    description: "Ryft — wallet hub and wallet analysis.",
    homePath: "/wallet",
    routePrefixes: ["/wallet", "/wallets", "/admin/tools/wallet"],
    hostEnv: "RYFT_HOSTS", defaultHost: "ryft.ayzen.tech",
    telegramBot: "ryft", clerkApp: null, oidcClientId: "ryft", mcpEndpoint: null,
  }),
  defineModule({
    id: "fyra", label: "Fyra", uidPrefix: "FYR", order: 3,
    description: "Fyra — finance: cash flow, loans, investments, assets.",
    homePath: "/finance",
    routePrefixes: ["/finance"],
    hostEnv: "FYRA_HOSTS", defaultHost: "fyra.ayzen.tech",
    telegramBot: "fyra", clerkApp: null, oidcClientId: "fyra", mcpEndpoint: null,
  }),
  defineModule({
    id: "verve", label: "Verve", uidPrefix: "VRV", order: 5,
    description: "Verve — marketplace and P2P trading.",
    homePath: "/marketplace/hub",
    routePrefixes: ["/marketplace", "/admin/marketplace", "/admin/marketplace-categories", "/admin/marketplace-market-config"],
    hostEnv: "VERVE_HOSTS", defaultHost: "verve.ayzen.tech",
    telegramBot: "verve", clerkApp: null, oidcClientId: "verve", mcpEndpoint: null,
  }),
  defineModule({
    id: "skarn", label: "Skarn", uidPrefix: "SKR", order: 6,
    description: "Skarn — airdrop projects, tasks and operator progress.",
    homePath: "/projects",
    routePrefixes: ["/projects", "/tasks", "/content", "/admin/projects", "/admin/project-templates", "/admin/operator-progress", "/admin/tasks"],
    hostEnv: "SKARN_HOSTS", defaultHost: "skarn.ayzen.tech",
    telegramBot: "skarn", clerkApp: null, oidcClientId: "skarn", mcpEndpoint: null,
  }),
  defineModule({
    id: "warde", label: "Warde", uidPrefix: "WRD", order: 8,
    description: "Warde — farming teams, chat and missions.",
    homePath: "/teams",
    // /admin/team-vault was double-claimed here by the old backend copy; Sylo owns it (S1).
    routePrefixes: ["/teams", "/team_leader", "/admin/teams"],
    hostEnv: "WARDE_HOSTS", defaultHost: "warde.ayzen.tech",
    telegramBot: "warde", clerkApp: null, oidcClientId: "warde", mcpEndpoint: null,
  }),
  defineModule({
    id: "wisp", label: "Wisp", uidPrefix: "WSP", order: 4,
    description: "Wisp — AYZEN mailbox and email accounts.",
    homePath: "/mailbox",
    routePrefixes: ["/mailbox", "/ayzen-email", "/email-accounts", "/admin/mail-sending-config"],
    hostEnv: "WISP_HOSTS", defaultHost: "wisp.ayzen.tech",
    telegramBot: "wisp", clerkApp: null, oidcClientId: "wisp", mcpEndpoint: null,
  }),
  defineModule({
    id: "zynth", label: "Zynth", uidPrefix: "ZYN", order: 7,
    description: "Zynth — AI assistant.",
    homePath: "/assistant",
    routePrefixes: ["/assistant", "/admin/ai-agent"],
    hostEnv: "ZYNTH_HOSTS", defaultHost: "zynth.ayzen.tech",
    telegramBot: "zynth", clerkApp: null, oidcClientId: "zynth", mcpEndpoint: null,
  }),
]);

export const MODULE_IDS = Object.freeze(MODULES.map((m) => m.id));

const BY_ID = new Map(MODULES.map((m) => [m.id, m]));

export function getModule(id) {
  return BY_ID.get(id) ?? null;
}

/** Modules sorted by `order` (declaration order breaks ties). */
export function getModulesByOrder() {
  return [...MODULES].sort((a, b) => a.order - b.order);
}

/** Boundary-aware prefix test: exact, "/" child, or "?" query (same rule the SPA uses). */
export function hasPrefix(path, prefix) {
  return path === prefix || path.startsWith(prefix + "/") || path.startsWith(prefix + "?");
}

/** Module owning `path`; longest matching prefix wins. Returns the module id or null. */
export function getModuleIdForPath(path) {
  let best = null;
  for (const m of MODULES) {
    for (const p of m.routePrefixes) {
      if (hasPrefix(path, p) && (!best || p.length > best.len)) best = { id: m.id, len: p.length };
    }
  }
  return best ? best.id : null;
}
