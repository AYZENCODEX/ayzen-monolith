/**
 * routes/oidc-userinfo.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 2, Phase 4c-f: `GET /oidc/userinfo`.
 *
 * Composes `requireOidcScope("openid")` (`lib/oidc-scope-enforcement.ts`,
 * which itself wraps 4c-a/4c-b/4c-c's `verifyOidcAccessToken()` plus the
 * Season 5 / 10b revocation check) and 4c-d/4c-e (`lib/oidc-userinfo.ts`)
 * into the actual HTTP endpoint:
 *
 *   requireOidcScope("openid") middleware (G3 — see below)
 *     -> extract Bearer token from Authorization header
 *     -> verify signature/issuer/expiry, extract subject + scopes
 *     -> reject a token that has been revoked via `POST /oidc/revoke`
 *     -> reject a token that does not carry the `openid` scope (403)
 *   userinfoHandler (this file)
 *     -> look up the user, rejecting banned/suspended accounts
 *        (fetchOidcUserinfoRecord())
 *     -> shape the response claims by granted scope
 *        (4c-d/4c-e, buildUserinfoClaims())
 *
 * ENFORCEMENT ROADMAP, TRACK G, PHASE G3 — WHY THIS FILE CHANGED
 *   Before G3 this file hand-rolled its own bearer extraction +
 *   `verifyOidcAccessToken()` + revocation check inline (a copy of what
 *   `requireOidcScope()` does) and NEVER checked the token's granted scopes
 *   at all: any cryptographically-valid, non-revoked access token — including
 *   one issued for, say, `profile` alone with no `openid` — could read
 *   UserInfo. OIDC Core §5.3 says the UserInfo endpoint is only for access
 *   tokens obtained via the `openid` scope. The route now goes through the
 *   shared middleware like every other bearer-token resource route, and
 *   `scripts/src/check-oidc-scope-enforcement-coverage.ts` (static) plus
 *   `scripts/src/test-route-oidc-scope-wiring.ts` (dynamic) keep it that way.
 *   Behavior changes, all deliberate: a token without `openid` now gets
 *   `403 insufficient_scope` (RFC 6750 §3.1) instead of claims; every other
 *   failure keeps its previous status and `WWW-Authenticate` shape.
 *
 * BEARER EXTRACTION (now performed by `requireOidcScope()`, unchanged in
 * behavior): `Authorization: Bearer <token>` ONLY — deliberately
 * NOT `lib/auth-utils.ts`'s `getTokenFromReq()`, which also reads the
 * `ayzen_session` cookie. UserInfo is a resource-server endpoint any OIDC
 * client's BACKEND calls directly (RFC 6750 §2.1's bearer-token usage,
 * same "this URL is called cross-origin, server-to-server, no browser
 * cookie jar involved" reasoning `routes/oidc-token.ts`'s own header
 * already gives for why it never reads a cookie either) — accepting a
 * cookie here would mean a same-site XSS or CSRF-adjacent bug on
 * `ayzen.tech` could exfiltrate account claims through an endpoint that
 * was only ever meant to answer OIDC clients presenting a token they
 * themselves received.
 *
 * ERROR SHAPE: RFC 6750 §3.1, not section 4's `OidcTokenErrorCode` union
 * — UserInfo is a RESOURCE endpoint, not a TOKEN endpoint, and RFC 6750
 * defines its own `WWW-Authenticate: Bearer ...` challenge header
 * separately from OAuth's token-endpoint error body. Every failure here
 * (missing header, malformed token, bad signature, expired, unknown
 * `kid`, banned account, ...) is reported identically as `401` +
 * `WWW-Authenticate: Bearer error="invalid_token"` + `{ error:
 * "invalid_token" }` — collapsing every internal reason to one public
 * shape is the same "one public code, richer internal-only detail via
 * logging" discipline `oidc-authorize.ts`/`oidc-token.ts` already use for
 * their own error unions, applied to RFC 6750's (smaller) vocabulary
 * instead of RFC 6749's. The one exception: a request with NO
 * `Authorization` header at all gets `error="invalid_request"` per RFC
 * 6750 §3.1's own distinction between "didn't even try to authenticate"
 * and "tried, and it didn't check out".
 *
 * MOUNTING / RATE LIMITING: bare origin (not `/api`, not behind
 * `apiKeyScopeGate`) — same convention `routes/oidc-authorize.ts` and
 * `routes/oidc-token.ts` already established, for the identical reason:
 * an OIDC client's backend calls this URL directly against the issuer's
 * origin. `globalLimiter`, NOT `authLimiter` — this is a resource
 * endpoint read by a client that already holds a validly-issued,
 * unguessable access token, not a credential-guessing surface the way
 * `/oidc/token` (accepts a client-supplied authorization `code`) or a
 * login form is; the concern `authLimiter` exists for doesn't apply here.
 */
import { Router, type IRouter, type Response } from "express";
import { globalLimiter } from "../middlewares/security";
import { requireOidcScope, type RequestWithOidcToken } from "../lib/oidc-scope-enforcement";
import { fetchOidcUserinfoRecord, buildUserinfoClaims } from "../lib/oidc-userinfo";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/** RFC 6750 §3.1: the one challenge this handler still issues itself — a token that already cleared `requireOidcScope()` but whose user row is gone/banned/suspended. Reported identically to every other "token didn't check out" case (`invalid_token`), same collapse-to-one-public-shape discipline `requireOidcScope()` itself uses. */
function respondInvalidToken(res: Response): void {
  res.setHeader("WWW-Authenticate", 'Bearer error="invalid_token"');
  res.status(401).json({ error: "invalid_token" });
}

/**
 * The actual handler logic, exported separately from the router wiring —
 * same reasoning as `tokenHandler`/`authorizeHandler` and every earlier
 * route in this roadmap: unit-testable with a minimal req/res double
 * instead of a live HTTP server. (This one still needs a live DB for
 * `fetchOidcUserinfoRecord()` — see `test-oidc-userinfo.ts`'s own header
 * for exactly which parts of the chain that leaves untested here.)
 *
 * Runs ONLY behind `requireOidcScope("openid")` (see the `router.get(...)`
 * below): by the time it executes, the bearer token has been extracted,
 * verified, checked against revocation, and confirmed to carry `openid`,
 * and `req.oidcToken` is set. Missing/invalid/revoked/insufficient-scope
 * are all responded to inside the middleware, so none of that is
 * re-implemented here (re-implementing it is exactly the pre-G3 bug).
 */
export async function userinfoHandler(req: RequestWithOidcToken, res: Response): Promise<void> {
  const token = req.oidcToken;
  if (!token) {
    // Unreachable when mounted correctly (requireOidcScope() always sets
    // req.oidcToken before next()). Fail closed rather than serve claims
    // if this handler is ever mounted without the middleware in front.
    logger.error({}, "oidc.userinfo.mounted_without_scope_enforcement");
    respondInvalidToken(res);
    return;
  }

  // Banned/suspended accounts rejected here too — see lib/oidc-userinfo.ts's
  // own header for why this is the identical check getUserFromToken()
  // already applies to session tokens.
  const user = await fetchOidcUserinfoRecord(token.userId);
  if (!user) {
    logger.warn({ userId: token.userId }, "oidc.userinfo.failed");
    respondInvalidToken(res);
    return;
  }

  // 4c-d/4c-e
  const claims = buildUserinfoClaims(user, token.scopes);

  logger.info({ userId: user.id, clientId: token.clientId }, "oidc.userinfo.served");
  res.status(200).json(claims);
}

router.get("/oidc/userinfo", globalLimiter, requireOidcScope("openid"), userinfoHandler);

export default router;
