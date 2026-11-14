/**
 * lib/oidc-central-origin.ts — W1-P4: where /oidc/authorize sends a browser that needs the central login, signup or consent UI.
 *
 * Until now these redirects were built from the REQUEST host, which is right while the issuer is the central app host (API and
 * SPA share an origin). With a dedicated IdP host such as https://id.ayzen.tech (ADR-W1-P3-oidc-issuer) the request host has
 * no SPA, so /login there would 404. Rule: if the request arrived on the issuer's host AND that host is not the app's own host
 * (APP_URL), the UI lives on APP_URL; in every other case behave exactly as before (request host).
 */
import { getAppUrl } from "./app-url";
import { resolveIssuer } from "./oidc-discovery";

function originOf(url: string): string | null {
  try { return new URL(url).origin; } catch { return null; }
}

export function centralUiOrigin(requestOrigin: string): string {
  const issuer = originOf(resolveIssuer());
  const app = originOf(getAppUrl());
  if (issuer && app && issuer !== app && issuer === requestOrigin) return app;
  return requestOrigin;
}

/** `screen_hint=signup` (OIDC "Initiating User Registration", prompt=create's sibling) sends an unauthenticated visitor to signup. */
export function centralAuthPath(screenHint: unknown): "/register" | "/login" {
  return screenHint === "signup" ? "/register" : "/login";
}
