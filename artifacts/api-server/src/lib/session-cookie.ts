/**
 * lib/session-cookie.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Account — central SSO cookie (master plan §4, "Option A — Shared
 * cookie domain").
 *
 * Every AYZEN sub-app (Sylo, Ryft, Wisp, Verve, Zynth, Skarn, Warde…) is
 * planned to move onto its own `*.ayzen.tech` subdomain. For that split to
 * still feel like "one login for every app," the session has to be
 * readable by every subdomain without asking the user to sign in again.
 *
 * The existing auth stack already issues a signed, session-bound JWT
 * (lib/jwt.ts + lib/sessions.ts) — this file just also hands that same
 * token to the browser as a cookie scoped to `Domain=.ayzen.tech`, so
 * `sylo.ayzen.tech`, `ryft.ayzen.tech`, etc. all see it automatically.
 *
 * This is purely additive:
 *  - The token is still returned in the JSON body of every login-ish
 *    response exactly as before, so the Expo app and any Bearer-token
 *    caller (API keys, `setAuthTokenGetter`) are completely unaffected.
 *  - `getTokenFromReq()` (auth-utils.ts) now checks the cookie only as a
 *    *fallback* when there's no `Authorization` header, so nothing that
 *    already sends a Bearer token changes behavior.
 *
 * ENV VARS
 *  AYZEN_COOKIE_DOMAIN   e.g. ".ayzen.tech" in production. Leave unset in
 *                        local dev — the browser then scopes the cookie to
 *                        whatever single host you're on (localhost, a
 *                        Replit preview domain, etc), which is exactly
 *                        what you want before subdomains exist.
 *
 * Cross-subdomain requests (sylo.ayzen.tech fetching from ayzen.tech) are
 * still "same-site" (same registrable domain), so `SameSite=Lax` already
 * covers them — no need for `SameSite=None`, which would force `Secure`
 * even on local HTTP dev.
 */

import type { Request, Response } from "express";
import type { ModuleId } from "@ayzen/module-registry";
import { moduleCookieName } from "./module-session-policy";

export const AYZEN_SESSION_COOKIE = "ayzen_session";

// Matches SESSION_TTL_MS in lib/sessions.ts — keep the cookie's own expiry
// in sync with how long the underlying user_sessions row (and therefore the
// JWT's `exp`) is actually valid for, so the browser doesn't hang on to a
// cookie the server would reject anyway.
const COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function cookieDomain(): string | undefined {
  const domain = process.env.AYZEN_COOKIE_DOMAIN?.trim();
  return domain ? domain : undefined;
}

function isProd(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * Attaches the session token as an httpOnly cookie on the response.
 * Call this alongside (not instead of) returning `{ token }` in the JSON
 * body — both paths stay valid at once.
 */
export function setSessionCookie(res: Response, token: string): void {
  res.cookie(AYZEN_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isProd(),
    sameSite: "lax",
    domain: cookieDomain(),
    maxAge: COOKIE_MAX_AGE_MS,
    path: "/",
  });
}

/** Clears the session cookie — call on logout. Options must mirror setSessionCookie's (domain/path/sameSite) or the browser won't match the cookie to delete. */
export function clearSessionCookie(res: Response): void {
  res.clearCookie(AYZEN_SESSION_COOKIE, {
    httpOnly: true,
    secure: isProd(),
    sameSite: "lax",
    domain: cookieDomain(),
    path: "/",
  });
}

/** Reads the raw token out of the AYZEN session cookie, if present. */
export function getSessionCookie(req: Request): string | null {
  const value = (req as Request & { cookies?: Record<string, unknown> }).cookies?.[AYZEN_SESSION_COOKIE];
  return typeof value === "string" && value ? value : null;
}

// ─── W1-P2: per-module, host-only session cookie (ADR A4) ────────────────────────────────────────
// `__Host-<module>_sid`: Secure, Path=/, and deliberately NO Domain attribute — the browser keeps it on the one host
// that set it (sylo.ayzen.tech) and refuses any attempt to set it from another subdomain. This is the opposite of the
// shared `ayzen_session` cookie above, which is scoped to `.ayzen.tech` on purpose.
// SameSite=Lax: a cross-site POST/fetch never carries it; same-site module navigation does.

export function setModuleSessionCookie(res: Response, module: ModuleId, token: string): void {
  res.cookie(moduleCookieName(module), token, {
    httpOnly: true,
    secure: isProd(),
    sameSite: "lax",
    maxAge: COOKIE_MAX_AGE_MS,
    path: "/",
  }); // no `domain` — host-only by construction
}

export function clearModuleSessionCookie(res: Response, module: ModuleId): void {
  res.clearCookie(moduleCookieName(module), { httpOnly: true, secure: isProd(), sameSite: "lax", path: "/" });
}
