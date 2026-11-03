/**
 * middlewares/role-host.ts
 *
 * Phase 7 — server-side enforcement of host <-> role (see lib/role-hosts.ts
 * for the decision table). Both gates are no-ops unless ROLE_HOSTS_ENABLED=1,
 * so deploying this changes nothing until the role hosts exist in DNS.
 *
 *  - roleHostApiGate  mounted on /api. All API traffic goes to api.ayzen.tech,
 *                     so the host a request is "acting for" is the first-party
 *                     Origin the browser sent, falling back to the Host header
 *                     (same-origin calls made directly on admin.ayzen.tech).
 *                     A session on a role host whose role does not belong
 *                     there gets 403 ROLE_HOST_MISMATCH (denied, not hidden).
 *                     Only fires for requests made on a role host; everything
 *                     else never pays for the extra token lookup.
 *  - roleHostPageGate mounted before static/SPA serving. Redirects a signed-in
 *                     role with a dedicated host off the central host, and a
 *                     wrong-role session off a role host. Anonymous visitors
 *                     are never redirected (login must always render).
 *
 * API keys are never affected: they are not browser sessions and carry no
 * Origin/host semantics.
 */
import type { NextFunction, Request, Response } from "express";
import { getTokenFromReq } from "../lib/auth-utils";
import { looksLikeApiKey } from "../lib/api-key-crypto";
import { authenticateAccessToken } from "../lib/identity-service";
import { isFirstPartyOrigin, isApiHost } from "../lib/api-hosts";
import { decideRoleHostAccess, getRoleHostForHost, isCentralHost, isRoleHostsEnabled, normalizeHostname } from "../lib/role-hosts";

/** The host a request is acting for: first-party Origin when present, else the Host header. */
export function resolveCallerHost(req: Request): string {
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin && isFirstPartyOrigin(origin)) {
    try { return normalizeHostname(new URL(origin).host); } catch { /* fall through */ }
  }
  return normalizeHostname(req.hostname);
}

export function roleHostApiGate(req: Request, res: Response, next: NextFunction): void {
  apiGate(req, res, next).catch(next);
}

async function apiGate(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!isRoleHostsEnabled()) { next(); return; }
  const callerHost = resolveCallerHost(req);
  if (!getRoleHostForHost(callerHost)) { next(); return; }

  const token = getTokenFromReq(req);
  if (!token || looksLikeApiKey(token)) { next(); return; }
  const user = await authenticateAccessToken(token);
  if (!user) { next(); return; } // route-level requireAuth produces the normal 401

  const decision = decideRoleHostAccess({ role: user.role, hostname: callerHost, path: req.path, kind: "api" });
  if (decision.action === "deny") {
    res.status(403).json({
      error: "Forbidden",
      code: decision.code,
      solution: "This account's role does not belong on this host. Sign in on the host for your role.",
      expectedHost: decision.expectedHost,
    });
    return;
  }
  next();
}

const ASSET_PATH = /\.[a-z0-9]{1,8}$/i;

export function roleHostPageGate(req: Request, res: Response, next: NextFunction): void {
  pageGate(req, res, next).catch(next);
}

async function pageGate(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!isRoleHostsEnabled() || (req.method !== "GET" && req.method !== "HEAD")) { next(); return; }
  if (req.path.startsWith("/api") || req.path.startsWith("/oidc") || req.path.startsWith("/.well-known") || ASSET_PATH.test(req.path)) { next(); return; }
  if (isApiHost(req.hostname)) { next(); return; }
  if (!getRoleHostForHost(req.hostname) && !isCentralHost(req.hostname)) { next(); return; }

  const token = getTokenFromReq(req);
  if (!token || looksLikeApiKey(token)) { next(); return; }
  const user = await authenticateAccessToken(token);
  if (!user) { next(); return; }

  const queryIndex = req.originalUrl.indexOf("?");
  const decision = decideRoleHostAccess({
    role: user.role,
    hostname: req.hostname,
    path: req.path,
    search: queryIndex >= 0 ? req.originalUrl.slice(queryIndex) : "",
    kind: "page",
  });
  if (decision.action === "redirect") { res.redirect(302, decision.location); return; }
  next();
}
