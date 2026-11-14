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
 *   clerkApp (W1-P5: the module's own Clerk application key; one pool per module), oidcClientId (W1-P3), mcpEndpoint (W3-P3).
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
    telegramBot: "sylo", clerkApp: "sylo", oidcClientId: "sylo", mcpEndpoint: null,
  }),
  defineModule({
    id: "ryft", label: "Ryft", uidPrefix: "RFT", order: 2,
    description: "Ryft — wallet hub and wallet analysis.",
    homePath: "/wallet",
    routePrefixes: ["/wallet", "/wallets", "/admin/tools/wallet"],
    hostEnv: "RYFT_HOSTS", defaultHost: "ryft.ayzen.tech",
    telegramBot: "ryft", clerkApp: "ryft", oidcClientId: "ryft", mcpEndpoint: null,
  }),
  defineModule({
    id: "fyra", label: "Fyra", uidPrefix: "FYR", order: 3,
    description: "Fyra — finance: cash flow, loans, investments, assets.",
    homePath: "/finance",
    routePrefixes: ["/finance"],
    hostEnv: "FYRA_HOSTS", defaultHost: "fyra.ayzen.tech",
    telegramBot: "fyra", clerkApp: "fyra", oidcClientId: "fyra", mcpEndpoint: null,
  }),
  defineModule({
    id: "verve", label: "Verve", uidPrefix: "VRV", order: 5,
    description: "Verve — marketplace and P2P trading.",
    homePath: "/marketplace/hub",
    routePrefixes: ["/marketplace", "/admin/marketplace", "/admin/marketplace-categories", "/admin/marketplace-market-config"],
    hostEnv: "VERVE_HOSTS", defaultHost: "verve.ayzen.tech",
    telegramBot: "verve", clerkApp: "verve", oidcClientId: "verve", mcpEndpoint: null,
  }),
  defineModule({
    id: "skarn", label: "Skarn", uidPrefix: "SKR", order: 6,
    description: "Skarn — airdrop projects, tasks and operator progress.",
    homePath: "/projects",
    routePrefixes: ["/projects", "/tasks", "/content", "/admin/projects", "/admin/project-templates", "/admin/operator-progress", "/admin/tasks"],
    hostEnv: "SKARN_HOSTS", defaultHost: "skarn.ayzen.tech",
    telegramBot: "skarn", clerkApp: "skarn", oidcClientId: "skarn", mcpEndpoint: null,
  }),
  defineModule({
    id: "warde", label: "Warde", uidPrefix: "WRD", order: 8,
    description: "Warde — farming teams, chat and missions.",
    homePath: "/teams",
    // /admin/team-vault was double-claimed here by the old backend copy; Sylo owns it (S1).
    routePrefixes: ["/teams", "/team_leader", "/admin/teams"],
    hostEnv: "WARDE_HOSTS", defaultHost: "warde.ayzen.tech",
    telegramBot: "warde", clerkApp: "warde", oidcClientId: "warde", mcpEndpoint: null,
  }),
  defineModule({
    id: "wisp", label: "Wisp", uidPrefix: "WSP", order: 4,
    description: "Wisp — AYZEN mailbox and email accounts.",
    homePath: "/mailbox",
    routePrefixes: ["/mailbox", "/ayzen-email", "/email-accounts", "/admin/mail-sending-config"],
    hostEnv: "WISP_HOSTS", defaultHost: "wisp.ayzen.tech",
    telegramBot: "wisp", clerkApp: "wisp", oidcClientId: "wisp", mcpEndpoint: null,
  }),
  defineModule({
    id: "zynth", label: "Zynth", uidPrefix: "ZYN", order: 7,
    description: "Zynth — AI assistant.",
    homePath: "/assistant",
    routePrefixes: ["/assistant", "/admin/ai-agent"],
    hostEnv: "ZYNTH_HOSTS", defaultHost: "zynth.ayzen.tech",
    telegramBot: "zynth", clerkApp: "zynth", oidcClientId: "zynth", mcpEndpoint: null,
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

// ─── W2-P1: server-side module guard (req 4) ─────────────────────────────────────────────────────────────────────
// Pure decision shared by the API middleware (artifacts/api-server/src/lib/module-host-guard.ts) and the CI check
// (scripts/check-module-isolation.mjs), so the rule that is enforced is the rule that is tested.

/** Paths every module host may reach: auth/OIDC plumbing, discovery, health and connector callbacks. */
export const MODULE_HOST_ALLOWED_PREFIXES = Object.freeze(["/auth", "/oidc", "/.well-known", "/health", "/connector"]);

/**
 * Candidate spellings of a request path to judge: the lower-cased raw path (Express routes are case-insensitive) and a
 * normalized one (percent-decoded once, `//` collapsed, `.`/`..` resolved). A path is only as safe as its worst spelling.
 * Returns null for paths no router could legitimately serve (bad escapes, NUL, backslashes).
 */
export function pathCandidates(rawPath) {
  const noQuery = String(rawPath ?? "").split("?")[0].split("#")[0];
  const lowerRaw = noQuery.toLowerCase();
  let decoded;
  try { decoded = decodeURIComponent(noQuery); } catch { return null; }
  if (/[\u0000\\]/.test(decoded)) return null;
  const out = [];
  for (const seg of decoded.toLowerCase().split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") { out.pop(); continue; }
    out.push(seg);
  }
  const normalized = "/" + out.join("/");
  return [...new Set([lowerRaw.startsWith("/") ? lowerRaw : "/" + lowerRaw, normalized])];
}

/**
 * Decide whether a request acting for `module` may touch `path` (relative to /api for API calls, the URL path for pages).
 *   - a path owned by ANOTHER module is always denied (that is the isolation guarantee);
 *   - allow-listed plumbing is always allowed;
 *   - in `strict` mode a path owned by nobody is denied unless it is allow-listed or in `sharedPrefixes`.
 * Returns { action: "allow" | "deny", reason, owner }. Deny is rendered as a plain 404 by the caller.
 */
export function decideModuleHostAccess({ module, path, strict = false, sharedPrefixes = [] }) {
  const own = getModule(module);
  if (!own) return { action: "deny", reason: "unknown_module", owner: null };
  const candidates = pathCandidates(path);
  if (!candidates) return { action: "deny", reason: "malformed_path", owner: null };
  for (const c of candidates) {
    const owner = getModuleIdForPath(c);
    if (owner && owner !== module) return { action: "deny", reason: "other_module", owner };
  }
  const covered = (c) => getModuleIdForPath(c) === module || [...MODULE_HOST_ALLOWED_PREFIXES, ...sharedPrefixes].some((p) => hasPrefix(c, p));
  if (strict && !candidates.every(covered)) return { action: "deny", reason: "not_in_module", owner: null };
  return { action: "allow", reason: candidates.every(covered) ? "own_or_allowlisted" : "unowned", owner: null };
}
