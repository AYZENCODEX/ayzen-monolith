/**
 * subdomain-app.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Workspace — subdomain app scoping (master plan §2/§7 Phase 2:
 * "Split Sylo onto its own subdomain").
 *
 * This is intentionally NOT a separate build/deploy. It's the same SPA
 * bundle served from the same Express app (see app.ts) on every
 * `*.ayzen.tech` host — this file just makes that one bundle *behave*
 * like a single-purpose Sylo app when it detects it's running on Sylo's
 * hostname:
 *   - App.tsx redirects any route outside Sylo's scope back to its home.
 *   - app-sidebar.tsx hides nav groups/items outside Sylo's scope.
 *
 * On the main domain (ayzen.tech / workspace.ayzen.tech) or any
 * unrecognized host, `getCurrentSubdomainApp()` returns null and nothing
 * about the app's behavior changes — this is purely additive.
 *
 * Auth still works exactly as before either way: the AYZEN Account session
 * cookie (lib/session-cookie.ts on the backend) is already shared across
 * every `*.ayzen.tech` subdomain, so a user who's logged in on the main
 * domain is already logged in here too — that part needed zero frontend
 * change.
 *
 * Adding the next split (Ryft, Wisp, Verve, Skarn, Warde — Phase 3/4/8 per
 * the master plan, though in practice all landed the same way: existing
 * routes, just scoped) means adding one more entry to SUBDOMAIN_APPS
 * below. Nothing else in this file changes.
 */

import type { ComponentType } from "react";

export interface SubdomainApp {
  id: string;
  label: string;
  /** Where an in-scope user lands on "/" or when redirected out of an out-of-scope route. */
  homePath: string;
  /** Path prefixes considered "in scope" for this subdomain — checked with exact match or a "/" boundary, never a bare substring match. */
  routePrefixes: string[];
  /** Module Shell Split S1: lucide icon component for the module shell (Season 2 renders it). */
  icon?: ComponentType<{ className?: string }>;
  /** One-line description shown in the central "AYZEN apps" menu (Season 3). */
  description?: string;
  /** Sort order across the module list (lower = earlier). Registry declaration order breaks ties. */
  order?: number;
  /** Season 1 shape marker — every registry entry is a module. */
  kind: "module";
}

// Add one entry per app as it gets its own subdomain. Vault's routes already all
// live under /vault (user) and /admin/vault (admin) — see route-config.tsx
// — so Sylo needed no route renaming to gain a scope here.
//
// Phase 3 (this pass): Ryft, Wisp, Verve added the same way — each app's
// routes already lived under one or two existing prefixes in
// route-config.tsx, so like Sylo, no page had to move or get renamed.
//
// Skarn added the same pass, once it was confirmed (not assumed) that it
// already exists as a product surface under a different label: the
// "Protocols" nav group in app-sidebar.tsx (USER_NAV/ADMIN_NAV — comment
// there literally says "Protocols restructure") IS Skarn — airdrop
// project tracking, per-project tasks, operator progress. Nothing to
// build, just scope it: /projects (+ every ?rollup=/?type= filter variant
// the Category sub-tree uses — hasPrefix's "?" boundary check covers
// those for free), /tasks and /content (both live inside the Protocols
// group itself, see app-sidebar.tsx), plus the admin mirror
// (/admin/projects, /admin/project-templates, /admin/operator-progress,
// /admin/tasks — same four entries as ADMIN_NAV's own "Protocols" group).
// Deliberately NOT included, despite being airdrop-farming-adjacent:
// /teams ("Team" nav group — farming teams, but organizationally its own
// top-level group, not nested under Protocols), /leaderboard (lives in
// the "Social" group), /earn (its own "Earn" group), /enroll/* (its own
// "Enroll" group). Ask before folding any of those in — this pass only
// claims what the user pointed at as "Protocols."
//
// Zynth — added once a real user-facing route existed to scope it to (see
// CHANGES_ZYNTH_SUBDOMAIN_SPLIT.md). pages/user/assistant.tsx docks the
// same <AiChat/> that was previously only reachable as a floating widget;
// seed-oidc-clients.ts already had its OIDC client registered and waiting.
const SUBDOMAIN_APPS: Record<string, Omit<SubdomainApp, "id">> = {
  sylo: {
    label: "Sylo",
    kind: "module",
    description: "Vault — credentials, entities and wallets.",
    order: 1,
    // Season 1 (Module Shell Split): sylo owns /admin/team-vault outright —
    // it was double-claimed by warde; the page serves vault data, so the
    // vault module keeps it (see CHANGES_MODULE_SHELL_S1.md).
    homePath: "/vault",
    routePrefixes: ["/vault", "/admin/vault", "/admin/team-vault"],
  },
  ryft: {
    label: "Ryft",
    kind: "module",
    description: "Ryft — wallet hub and wallet analysis.",
    order: 2,
    // Wallet only — Season 1 of the Module Shell Split (CHANGES_MODULE_SHELL_S1.md)
    // superseded the old "Investment stays inside Ryft" decision: /finance and
    // everything on it (including Investments) moved to Fyra, which owns them now.
    // Ryft keeps /wallet, /wallets and the admin mirror /admin/tools/wallet.
    homePath: "/wallet",
    routePrefixes: ["/wallet", "/wallets", "/admin/tools/wallet"],
  },
  wisp: {
    label: "Wisp",
    kind: "module",
    description: "Wisp — AYZEN mailbox and email accounts.",
    order: 4,
    // /mailbox is the native mail client UI (CHANGES_NATIVE_MAILBOX.md);
    // /ayzen-email is the account-setup/status page, kept in-scope since a
    // Wisp visitor still needs it before a mailbox exists.
    homePath: "/mailbox",
    routePrefixes: ["/mailbox", "/ayzen-email", "/email-accounts", "/admin/mail-sending-config"],
  },
  verve: {
    label: "Verve",
    kind: "module",
    description: "Verve — marketplace and P2P trading.",
    order: 5,
    homePath: "/marketplace/hub",
    routePrefixes: [
      "/marketplace",
      "/admin/marketplace",
      "/admin/marketplace-categories",
      "/admin/marketplace-market-config",
    ],
  },
  skarn: {
    label: "Skarn",
    kind: "module",
    description: "Skarn — airdrop projects, tasks and operator progress.",
    order: 6,
    homePath: "/projects",
    routePrefixes: [
      "/projects",
      "/tasks",
      "/content",
      "/admin/projects",
      "/admin/project-templates",
      "/admin/operator-progress",
      "/admin/tasks",
    ],
  },
  zynth: {
    label: "Zynth",
    kind: "module",
    description: "Zynth — AI assistant.",
    order: 7,
    homePath: "/assistant",
    routePrefixes: ["/assistant", "/admin/ai-agent"],
  },
  fyra: {
    label: "Fyra",
    kind: "module",
    description: "Fyra — finance: cash flow, loans, investments, assets.",
    order: 3,
    // Season 1 of the Module Shell Split: Fyra is its own module, fully
    // separate from Ryft. Everything /finance (Receivables, Payables, Loans,
    // Investments, Assets, Expenses, Reports — see route-config.tsx's
    // "Finance module" block) is Fyra's, with no fyra-specific route left
    // under ryft. Public token pages under /finance (receipt, invoice,
    // payment-agreement) stay in ALWAYS_ALLOWED_PREFIXES above so they
    // render on any host.
    homePath: "/finance",
    routePrefixes: ["/finance"],
  },
  warde: {
    label: "Warde",
    kind: "module",
    description: "Warde — farming teams, chat and missions.",
    order: 8,
    // The "Team" nav group (USER_NAV/MODERATOR_NAV/TEAM_LEADER_NAV — same
    // shape in all three, ADMIN_NAV's own "Team" group mirrors it) is
    // farming-team management: members, chat, browse/invite, task &
    // mission progress, team leaderboard/projects rollup, team vault,
    // team settings — every one of those is a `/teams?tab=...` variant of
    // the single route, so one prefix covers all of it (same "?" boundary
    // hasPrefix() already relies on for Ryft's finance filters and
    // Skarn's project rollups). /team_leader is included too — the
    // Sidebar Builder's team-leader-role custom-page route
    // (`/team_leader/custom/:slug`), the team-leader equivalent of
    // Skarn/admin's own custom-page routes.
    homePath: "/teams",
    routePrefixes: ["/teams", "/team_leader", "/admin/teams"],
  },
};

// Pages that make sense to reach from ANY subdomain regardless of scope —
// auth, the public status page, and every public/unauthenticated token-link
// page (emergency access, receipts). None of these go through the
// ProtectedRoute scope guard anyway (see App.tsx), but isPathInSubdomainScope
// is kept accurate for anything that calls it directly in the future.
const ALWAYS_ALLOWED_PREFIXES = [
  "/login", "/register", "/forgot-password", "/status",
  "/emergency-access", "/finance/receipt", "/finance/invoice",
  "/finance/payment-agreement", "/receipt",
  // OIDC Roadmap — Season 3, Phase 5b-b: the callback route has to render
  // regardless of which subdomain app is scoped (or whether one is scoped
  // at all) — it's what ESTABLISHES the session App.tsx's ProtectedRoute
  // guard checks, so it can't itself require a resolved app/session first.
  "/oidc/callback",
];

function hasPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix + "/") || path.startsWith(prefix + "?");
}

/**
 * Detects which AYZEN sub-app (if any) the current hostname is scoped to.
 * Matches:
 *  - configured production hostnames (VITE_<APP>_HOSTS, each with a matching
 *    `<app>.ayzen.tech` default) — exact match.
 *  - dev/preview convenience: any hostname whose FIRST label equals a known
 *    app id, e.g. "sylo.localhost" or a "sylo-<replit-preview>" domain —
 *    so this is testable before ayzen.tech DNS/subdomains exist for real.
 * Returns null on the main domain or any unrecognized host.
 */
export function getCurrentSubdomainApp(): SubdomainApp | null {
  if (typeof window === "undefined") return null;
  const host = window.location.hostname;

  for (const [id, app] of Object.entries(SUBDOMAIN_APPS)) {
    const configuredHosts = ((import.meta.env[`VITE_${id.toUpperCase()}_HOSTS`] as string | undefined) ?? `${id}.ayzen.tech`)
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);
    if (configuredHosts.includes(host.toLowerCase())) return { id, ...app };
  }

  const firstLabel = host.split(".")[0];
  const app = SUBDOMAIN_APPS[firstLabel];
  return app ? { id: firstLabel, ...app } : null;
}

/** True when `path` is in-scope for the given subdomain app, or is one of the always-reachable public/auth pages. */
export function isPathInSubdomainScope(path: string, app: SubdomainApp): boolean {
  if (ALWAYS_ALLOWED_PREFIXES.some((p) => hasPrefix(path, p))) return true;
  return app.routePrefixes.some((p) => hasPrefix(path, p));
}

/*
 * Module Shell Split, Season 1 helpers.
 * URL builders and path-to-module resolution used by later seasons
 * (module shell, central AYZEN apps menu, cross-module link fixes).
 * Hosts come from the same configured-hosts logic getCurrentSubdomainApp
 * uses, so VITE_<ID>_HOSTS stays the single source of truth.
 */

/** All registered modules, sorted by order (declaration order breaks ties). */
export function getAllModules(): Array<SubdomainApp & { id: string }> {
  return Object.entries(SUBDOMAIN_APPS)
    .map(([id, app]) => ({ id, ...app }))
    .sort((a, b) => ((a.order ?? 99) - (b.order ?? 99)));
}

function configuredHostsFor(id: string): string[] {
  const envValue = import.meta.env[`VITE_${id.toUpperCase()}_HOSTS`] as string | undefined;
  const fallback = `${id}.ayzen.tech`;
  return (envValue ?? fallback)
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Build a URL to a module host. path must start with "/" (or be empty).
 * Preserves the dev/preview pattern (sylo.localhost, sylo-<replit-preview>
 * hosts) by swapping the FIRST label of the CURRENT hostname instead of
 * hard-coding production, so the same call works in all three modes:
 * prod -> https://sylo.ayzen.tech/vault, dev -> http://sylo.localhost/vault,
 * preview -> https://sylo-<preview>.replit.dev/vault.
 */
export function moduleUrl(id: string, path = ""): string {
  const app = SUBDOMAIN_APPS[id];
  if (!app) return path ? path : "/";
  const host = window.location.hostname.toLowerCase();
  const isProdHost = configuredHostsFor(id).includes(host);
  const isMainHost = host === "ayzen.tech" || host === "www.ayzen.tech" || host.endsWith(".ayzen.tech");
  if (isProdHost || isMainHost) {
    return `https://${configuredHostsFor(id)[0]}${path}`;
  }
  // dev/preview: swap the first label on the current hostname
  const swapped = [id, ...host.split(".").slice(1)].join(".");
  return `${window.location.protocol}//${swapped}${path}`;
}

/** Build a URL on the main AYZEN host (ayzen.tech). */
export function centralUrl(path = "/"): string {
  const host = window.location.hostname.toLowerCase();
  const isDev = host === "localhost" || host.endsWith(".localhost") || host.includes(".replit");
  if (isDev) {
    const stripped = window.location.host.replace(/^[^.]+[.]/, "");
    return `${window.location.protocol}//${stripped}${path}`;
  }
  return `https://ayzen.tech${path}`;
}

/**
 * Resolve which module owns path - longest matching prefix wins, so
 * /finance/receipt/... matches fyra and not a shorter or other claim.
 * Returns the module id or null on the main domain routes.
 */
export function getModuleForPath(path: string): string | null {
  let best: { id: string; len: number } | null = null;
  for (const [id, app] of Object.entries(SUBDOMAIN_APPS)) {
    for (const prefix of app.routePrefixes) {
      if (hasPrefix(path, prefix)) {
        if (!best || prefix.length > best.len) best = { id, len: prefix.length };
      }
    }
  }
  return best ? best.id : null;
}
