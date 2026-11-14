import { Router, type NextFunction, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { getModule, type ModuleId } from "@ayzen/module-registry";
import { getUserFromToken } from "../lib/auth-utils";
import { verifyOidcAccessToken } from "../lib/oidc-access-token-verification";
import { getOidcRolloutFlag } from "../lib/oidc-client-rollout";
import { signAuthToken, verifyAuthToken } from "../lib/jwt";
import { sendEmail } from "../lib/email";
import { logger } from "../lib/logger";
import { getClientIp } from "../lib/login-security";
import { deviceLabelFromUserAgent } from "../lib/sessions";
import { getSessionCookie, setModuleSessionCookie, clearModuleSessionCookie } from "../lib/session-cookie";
import { resolveSessionScopes } from "../lib/policy/rbac/session-scopes";
import { authLimiter, otpLimiter } from "../middlewares/security";
import { currentModuleContext } from "../lib/module-request-context";
import { isModuleSessionsEnabled, moduleCookieName, resolveRequestModule } from "../lib/module-session-policy";
import { readClerkConfig } from "../lib/clerk-config";
import { verifyClerkSessionToken } from "../lib/clerk-verify";
import { clerkSignIn } from "../lib/module-clerk-service";
import { getSharedAppHosts, SHARED_APP_DEFINITIONS } from "../lib/shared-apps";
import {
  completePasswordReset, continueWithAyzen, describeModuleAccount, linkAyzenToModuleAccount, loginWithPassword, logoutModuleSession,
  oidcSignIn, poolAuthDb, requestPasswordReset, signupWithPassword, type ClientInfo, type Fail, type IssuedModuleSession,
} from "../lib/module-auth-service";

/**
 * W1-P2 (req 7, ADR A2 + A4) — per-module credentials and sessions. Host-scoped: the module is NEVER taken from the
 * request body or a header the client chooses; it is the module the request is acting for (lib/module-request-context.ts:
 * the first-party Origin, else the Host). Off a module host these routes answer 404.
 *
 *   POST /auth/module/signup                    { email, password }          201 { token, account }
 *   POST /auth/module/login                     { email, password }          200 { token, account }
 *   POST /auth/module/logout                                                 200
 *   GET  /auth/module/me                                                     200 { account }
 *   POST /auth/module/continue                  (shared AYZEN session)       200 { token, account }   "Continue with AYZEN"
 *   POST /auth/module/password-reset/request    { email }                    202 (always)
 *   POST /auth/module/password-reset/confirm    { token, password }          200
 *
 * Kill switch: MODULE_SESSIONS_MODE=off (the default) makes every route here a 404 and every module token invalid.
 */
const router = Router();
const authDb = poolAuthDb(pool as any);

// ─── guards ──────────────────────────────────────────────────────────────────

function moduleGate(req: Request, res: Response, next: NextFunction): void {
  if (!isModuleSessionsEnabled()) { res.status(404).json({ error: "Route not found", code: "NOT_FOUND" }); return; }
  const module = currentModuleContext();
  if (!module) {
    res.status(404).json({ error: "Route not found", code: "MODULE_HOST_REQUIRED", solution: "Call this from a module host (for example sylo.ayzen.tech)." });
    return;
  }
  res.locals.moduleId = module;
  next();
}

/** Only JSON bodies: a cross-site HTML form (urlencoded / text/plain) can never reach these state-changing routes. */
function jsonOnly(req: Request, res: Response, next: NextFunction): void {
  if (!req.is("application/json")) { res.status(415).json({ error: "Send application/json", code: "UNSUPPORTED_MEDIA_TYPE" }); return; }
  next();
}

const moduleOf = (res: Response): ModuleId => res.locals.moduleId as ModuleId;

function clientInfo(req: Request): ClientInfo {
  const userAgent = (req.headers["user-agent"] as string) || null;
  return { ip: getClientIp(req), userAgent, deviceLabel: deviceLabelFromUserAgent(userAgent) };
}

const STATUS: Record<Fail["code"], number> = {
  INVALID_MODULE: 400, INVALID_IDENTIFIER: 400, PASSWORD_TOO_SHORT: 400, PASSWORD_TOO_LONG: 400, PASSWORD_EQUALS_IDENTIFIER: 400,
  PASSWORD_TOO_SIMPLE: 400, INVALID_TOKEN: 400, IDENTIFIER_TAKEN: 409, INVALID_CREDENTIALS: 401, ACCOUNT_NOT_ACTIVE: 403,
  ALREADY_HAS_MODULE_ACCOUNT: 409, ACCOUNT_ALREADY_LINKED: 409, EMAIL_ACCOUNT_EXISTS: 409,
};
const SOLUTION: Partial<Record<Fail["code"], string>> = {
  INVALID_CREDENTIALS: "Check your email and password, or reset your password.",
  IDENTIFIER_TAKEN: "An account with this email already exists in this module. Log in instead.",
  INVALID_TOKEN: "This link is invalid, expired or already used. Request a new one.",
  ALREADY_HAS_MODULE_ACCOUNT: "Your AYZEN identity already has its own account in this module, so another account cannot be linked to it. Continue with AYZEN to use that account.",
  ACCOUNT_ALREADY_LINKED: "That module account is already linked to a different AYZEN identity.",
  EMAIL_ACCOUNT_EXISTS: "This email already has a password account in this module. Log in with your password; social sign-in is not merged into existing accounts.",
};
function fail(res: Response, f: Fail): void {
  res.status(STATUS[f.code] ?? 400).json({ error: f.code === "INVALID_CREDENTIALS" ? "Invalid credentials" : "Request rejected", code: f.code, ...(SOLUTION[f.code] ? { solution: SOLUTION[f.code] } : {}) });
}

/** Signs the module token and, when the request is on the module's own host, sets its host-only cookie. */
async function issue(req: Request, res: Response, s: IssuedModuleSession, opts: { stepUpAt?: string; role?: string } = {}): Promise<string> {
  let role = opts.role;
  if (!role) role = (await pool.query("SELECT role FROM users WHERE id = $1", [s.userId])).rows[0]?.role ?? "user";
  const { scopes, roles } = await resolveSessionScopes(s.userId, role!);
  const token = signAuthToken(s.userId, role!, { sid: s.jti, scopes, roles, stepUpAt: opts.stepUpAt, mod: s.module, mac: s.moduleAccountId });
  // The cookie is host-only, so it is only meaningful when the response comes from the module host itself. A call made
  // cross-origin through api.ayzen.tech gets the token in the body instead (same as every other login-ish response).
  if (resolveRequestModule(req.hostname) === s.module) setModuleSessionCookie(res, s.module, token);
  return token;
}

const publicAccount = (s: IssuedModuleSession, identifier?: string) => ({
  module: s.module, label: getModule(s.module)?.label ?? s.module, moduleUid: s.moduleUid, ...(identifier ? { identifier } : {}),
});
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

// ─── routes ──────────────────────────────────────────────────────────────────

router.post("/auth/module/signup", moduleGate, authLimiter, jsonOnly, async (req, res): Promise<void> => {
  const r = await signupWithPassword(authDb, { module: moduleOf(res), identifier: req.body?.email, password: req.body?.password, client: clientInfo(req) });
  if (!r.ok) { fail(res, r); return; }
  const token = await issue(req, res, r, { role: "user", stepUpAt: new Date().toISOString() });
  res.status(201).json({ token, account: publicAccount(r, str(req.body?.email)?.trim().toLowerCase()) });
});

router.post("/auth/module/login", moduleGate, authLimiter, jsonOnly, async (req, res): Promise<void> => {
  const r = await loginWithPassword(authDb, { module: moduleOf(res), identifier: req.body?.email, password: req.body?.password, client: clientInfo(req) });
  if (!r.ok) { fail(res, r); return; }
  const token = await issue(req, res, r, { stepUpAt: new Date().toISOString() });
  res.json({ token, account: publicAccount(r, str(req.body?.email)?.trim().toLowerCase()) });
});

router.post("/auth/module/logout", moduleGate, async (req, res): Promise<void> => {
  const module = moduleOf(res);
  const raw = req.headers.authorization?.replace("Bearer ", "").trim() || (req.cookies as Record<string, unknown> | undefined)?.[moduleCookieName(module)];
  const claims = typeof raw === "string" && raw ? verifyAuthToken(raw) : null;
  // Only a token of THIS module can end a session here, and logoutModuleSession is module-scoped again in SQL.
  if (claims?.mod === module && claims.sid) await logoutModuleSession(authDb, { jti: claims.sid, module, client: clientInfo(req) });
  clearModuleSessionCookie(res, module);
  res.json({ message: "Signed out" });
});

router.get("/auth/module/me", moduleGate, async (req, res): Promise<void> => {
  const raw = req.headers.authorization?.replace("Bearer ", "").trim() || (req.cookies as Record<string, unknown> | undefined)?.[moduleCookieName(moduleOf(res))];
  const principal = typeof raw === "string" && raw ? await getUserFromToken(raw) : null;
  if (!principal || principal.moduleId !== moduleOf(res) || !principal.moduleAccountId) { res.status(401).json({ error: "Unauthorized", code: "INVALID_TOKEN" }); return; }
  const account = await describeModuleAccount((sql, p) => pool.query(sql, p as any[]), principal.moduleAccountId);
  if (!account) { res.status(401).json({ error: "Unauthorized", code: "INVALID_TOKEN" }); return; }
  res.json({ account });
});

/**
 * "Continue with AYZEN": an existing AYZEN user who arrives on a module host with a still-valid SHARED session gets a
 * module account provisioned on the spot (source 'lazy', link 'legacy_continue') and a module session. Needs the shared
 * session to be acceptable on this host, i.e. MODULE_SESSIONS_MODE=dual before MODULE_SESSIONS_LEGACY_UNTIL; in `strict`
 * mode shared sessions are refused on module hosts and the user signs in through the AYZEN OIDC flow instead (W1-P4).
 */
router.post("/auth/module/continue", moduleGate, authLimiter, jsonOnly, async (req, res): Promise<void> => {
  const raw = req.headers.authorization?.replace("Bearer ", "").trim() || getSessionCookie(req); // the SHARED cookie, never the module cookie
  if (!raw) { res.status(401).json({ error: "Unauthorized", code: "NO_SHARED_SESSION", solution: "Sign in to AYZEN first." }); return; }
  const principal = await getUserFromToken(raw);
  if (!principal) { res.status(401).json({ error: "Unauthorized", code: "INVALID_TOKEN" }); return; }
  if (principal.authType !== "session" || principal.moduleId) {
    res.status(403).json({ error: "Forbidden", code: "SHARED_SESSION_REQUIRED", solution: "Continue requires your AYZEN login session." });
    return;
  }
  const r = await continueWithAyzen(authDb, { module: moduleOf(res), userId: principal.userId, client: clientInfo(req) });
  if (!r.ok) { fail(res, r); return; }
  // A continue does not re-verify a credential, so it carries the original step-up time forward rather than refreshing it.
  const token = await issue(req, res, r, { role: principal.role, stepUpAt: verifyAuthToken(raw)?.stepUpAt });
  res.json({ token, created: r.created, account: publicAccount(r) });
});

/** The OIDC access token must be this fresh to open a module session: the call is made straight after the code exchange. */
const OIDC_SIGNIN_MAX_TOKEN_AGE_SECONDS = 300;

/** What the module's sign-in screen may offer. Public: it reveals nothing beyond which buttons to draw. */
router.get("/auth/module/options", moduleGate, async (_req, res): Promise<void> => {
  const module = moduleOf(res);
  const def = getModule(module)!;
  res.json({ module, label: def.label, password: true, signup: true, oidc: await getOidcRolloutFlag(def.oidcClientId), social: readClerkConfig(module) !== null });
});

/**
 * "Login with AYZEN" (W1-P4). The browser has just finished the OIDC code+PKCE round trip against THIS module's client and
 * sends the resulting access token. The token, not a shared cookie, is the proof of the AYZEN identity, so this works in
 * MODULE_SESSIONS_MODE=strict where shared sessions are refused on module hosts.
 *
 *   body { access_token }                                  flows 1+2: existing or newly created AYZEN user -> module account
 *   body { access_token, link: { identifier, password } }  flow 3: attach this AYZEN identity to an existing module account
 *
 * Refused unless: the module's rollout flag is on; the token verifies (RS256, issuer) and is fresh; it was issued to THIS
 * module's own client (a token minted for sylo can never open a ryft session); it carries the openid scope.
 */
router.post("/auth/module/oidc", moduleGate, authLimiter, jsonOnly, async (req, res): Promise<void> => {
  const module = moduleOf(res);
  const def = getModule(module)!;
  if (!(await getOidcRolloutFlag(def.oidcClientId))) {
    res.status(403).json({ error: "Forbidden", code: "OIDC_NOT_ENABLED", solution: "Sign-in with AYZEN is not enabled for this module yet. Use the module's own login." });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const accessToken = str(body.access_token);
  if (!accessToken) { res.status(400).json({ error: "Request rejected", code: "INVALID_REQUEST", solution: "Send the access_token from the AYZEN sign-in." }); return; }
  const v = verifyOidcAccessToken(accessToken);
  if (!v.ok) { res.status(401).json({ error: "Unauthorized", code: "INVALID_TOKEN" }); return; }
  if (v.token.clientId !== def.oidcClientId) { res.status(403).json({ error: "Forbidden", code: "CLIENT_MISMATCH", solution: "This sign-in was issued for a different app." }); return; }
  if (!v.token.scopes.includes("openid")) { res.status(403).json({ error: "Forbidden", code: "INSUFFICIENT_SCOPE" }); return; }
  if (Math.floor(Date.now() / 1000) - v.token.iat > OIDC_SIGNIN_MAX_TOKEN_AGE_SECONDS) {
    res.status(401).json({ error: "Unauthorized", code: "TOKEN_TOO_OLD", solution: "Start the AYZEN sign-in again." });
    return;
  }
  const client = clientInfo(req);
  if (body.link !== undefined) {
    const link = body.link as Record<string, unknown> | null;
    if (!link || typeof link !== "object") { res.status(400).json({ error: "Request rejected", code: "INVALID_REQUEST" }); return; }
    const r = await linkAyzenToModuleAccount(authDb, { module, ayzenUserId: v.token.userId, identifier: link.identifier, password: link.password, client });
    if (!r.ok) { fail(res, r); return; }
    const token = await issue(req, res, r);
    res.json({ token, linked: true, alreadyLinked: r.alreadyLinked, ayzenUserId: v.token.userId, account: publicAccount(r) });
    return;
  }
  const r = await oidcSignIn(authDb, { module, ayzenUserId: v.token.userId, client });
  if (!r.ok) { fail(res, r); return; }
  const token = await issue(req, res, r);
  res.json({ token, created: r.created, ayzenUserId: v.token.userId, account: publicAccount(r) });
});

/**
 * W1-P5 (req 8) — POST /auth/module/clerk  { session_token }  -> 200 { token, created, account }
 * The Clerk session token is verified against THIS module's own Clerk application only (issuer + JWKS + authorized parties
 * come from per-module env; lib/clerk-config.ts), so a token from another module's Clerk pool cannot open this module.
 * Off unless MODULE_CLERK_ENABLED=1 and the module's Clerk env is complete: 404 otherwise.
 */
router.post("/auth/module/clerk", moduleGate, authLimiter, jsonOnly, async (req, res): Promise<void> => {
  const module = moduleOf(res);
  const cfg = readClerkConfig(module);
  if (!cfg) { res.status(404).json({ error: "Not found", code: "CLERK_NOT_ENABLED" }); return; }
  const sessionToken = str((req.body ?? {}).session_token);
  if (!sessionToken) { res.status(400).json({ error: "Request rejected", code: "INVALID_REQUEST", solution: "Send the session_token from the social sign-in." }); return; }
  const v = await verifyClerkSessionToken(sessionToken, cfg);
  if (!v.ok) {
    if (v.reason === "jwks_unavailable") { res.status(503).json({ error: "Service unavailable", code: "CLERK_UNAVAILABLE" }); return; }
    res.status(401).json({ error: "Unauthorized", code: "INVALID_TOKEN" });
    return;
  }
  const r = await clerkSignIn(authDb, { module, clerkUserId: v.claims.sub, email: v.claims.email, emailVerified: v.claims.emailVerified, client: clientInfo(req) });
  if (!r.ok) { fail(res, r); return; }
  const token = await issue(req, res, r);
  res.json({ token, created: r.created, account: publicAccount(r) });
});

const RESET_ACK = { message: "If an account exists for that email, a reset link has been sent." };

router.post("/auth/module/password-reset/request", moduleGate, otpLimiter, jsonOnly, async (req, res): Promise<void> => {
  const module = moduleOf(res);
  const r = await requestPasswordReset(authDb, { module, identifier: req.body?.email, client: clientInfo(req) });
  if (r) {
    const def = SHARED_APP_DEFINITIONS.find((d) => d.id === module);
    const host = def ? getSharedAppHosts(def)[0] : undefined;
    const scheme = process.env.NODE_ENV === "production" ? "https" : "http";
    const link = host ? `${scheme}://${host}/reset-password?token=${encodeURIComponent(r.token)}` : null;
    const label = getModule(module)?.label ?? module;
    // Fire and forget: the answer below must not depend on (or time) the mail provider.
    void sendEmail({
      to: r.to,
      subject: `${label} — reset your password`,
      html: `<p>Use this link to reset your ${label} password. It expires in 30 minutes and works once.</p>${link ? `<p><a href="${link}">${link}</a></p>` : `<p>Reset code: ${r.token}</p>`}<p>If you did not ask for this, ignore this email.</p>`,
      text: `Reset your ${label} password (expires in 30 minutes, single use): ${link ?? r.token}\nIf you did not ask for this, ignore this email.`,
    }).catch((err) => logger.warn({ err, module }, "module.password_reset.email_failed"));
  }
  res.status(202).json(RESET_ACK);
});

router.post("/auth/module/password-reset/confirm", moduleGate, authLimiter, jsonOnly, async (req, res): Promise<void> => {
  const module = moduleOf(res);
  const r = await completePasswordReset(authDb, { module, token: req.body?.token, newPassword: req.body?.password, client: clientInfo(req) });
  if (!r.ok) { fail(res, r); return; }
  clearModuleSessionCookie(res, module);
  res.json({ message: "Password updated. Sign in with your new password." });
});

// Exported for the validator/tests: which hosts this router is expected to serve.
export const MODULE_AUTH_ROUTE_PATHS = [
  "/auth/module/signup", "/auth/module/login", "/auth/module/clerk", "/auth/module/logout", "/auth/module/me", "/auth/module/continue",
  "/auth/module/password-reset/request", "/auth/module/password-reset/confirm",
] as const;

export default router;
