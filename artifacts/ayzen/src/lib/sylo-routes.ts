/**
 * lib/sylo-routes.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Single source of truth for Sylo's Account URLs, plus the legacy `?tab=`
 * translation. Everything lives under /vault because that is Sylo's
 * routePrefix (packages/module-registry) — a route outside it would be
 * bounced by the subdomain scope guard in App.tsx.
 *
 *   /vault                                  Console (Sylo home)
 *   /vault/account/:section/:view           section ∈ entity|local|kyc|game
 *                                           view    ∈ home|dashboard|analysis|management
 */
export const ACCOUNT_SECTIONS = ["entity", "local", "kyc", "game"] as const;
export type AccountSection = (typeof ACCOUNT_SECTIONS)[number];

export const ACCOUNT_VIEWS = ["home", "dashboard", "analysis", "management"] as const;
export type AccountView = (typeof ACCOUNT_VIEWS)[number];

export const isAccountSection = (v: string | undefined): v is AccountSection =>
  !!v && (ACCOUNT_SECTIONS as readonly string[]).includes(v);

export const isAccountView = (v: string | undefined): v is AccountView =>
  !!v && (ACCOUNT_VIEWS as readonly string[]).includes(v);

export const SYLO_HOME = "/vault";

export const accountPath = (section: AccountSection, view: AccountView = "home"): string =>
  `/vault/account/${section}/${view}`;

/**
 * Maps a legacy `/vault?tab=…` query to its new location, or null when the
 * query carries no legacy tab (i.e. the user really wants the Console).
 * Unrelated params (e.g. `editId`) are preserved. Old behaviour is kept:
 * entity/local/kyc opened on their Dashboard, unless an `editId` asked for the
 * editor.
 */
export function resolveLegacyTab(search: string): string | null {
  const params = new URLSearchParams(search);
  const tab = params.get("tab");
  if (!tab) return null;

  params.delete("tab");
  params.delete("view");
  const rest = params.toString();
  const withRest = (path: string) => (rest ? `${path}?${rest}` : path);

  switch (tab) {
    case "entity":
    case "local":
    case "kyc":
      return withRest(accountPath(tab, params.has("editId") ? "management" : "dashboard"));
    case "game":
      return withRest(accountPath("game", "management"));
    case "wallet":
      return withRest("/vault/wallet-hub/wallet");
    case "mail":
      return withRest("/vault/mail-hub/entity");
    default:
      return null;
  }
}
