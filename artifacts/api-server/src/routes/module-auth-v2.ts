import { Router, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { getModule, type ModuleId } from "@ayzen/module-registry";
import { getUserFromToken } from "../lib/auth-utils";
import { sendEmail } from "../lib/email";
import { logger } from "../lib/logger";
import { clearModuleSessionCookie } from "../lib/session-cookie";
import { authLimiter, otpLimiter } from "../middlewares/security";
import { moduleCookieName } from "../lib/module-session-policy";
import { poolAuthDb } from "../lib/module-auth-service";
import {
  beginTotpEnrol, confirmTotpEnrol, deletePasskey, listPasskeys, passkeyLoginOptions, passkeyLoginVerify, passkeyRegisterOptions, passkeyRegisterVerify, isWorkspaceSlugFree, checkSignupCode, completeCodeReset, completeLogin, completeSignup, getProfile, isMailLocalFree, isReferralValid, isUsernameFree, newCaptcha, sendLoginEmailCode,
  startCodeReset, startLogin, startSignup, updateProfile, OTP_TTL_MINUTES, type V2Fail,
} from "../lib/module-auth-v2-service";
import { getWebAuthnConfig, rpName } from "../lib/passkey";
import { clientInfo, fail as baseFail, issue, jsonOnly, moduleGate, moduleOf, publicAccount } from "./module-auth";

/**
 * Module auth v2 — the extra steps the designed module login pages use (email code, captcha, username, referral,
 * step-up, code-based reset, profile). Same guards as /auth/module/*: host-scoped module, JSON only, 404 when
 * MODULE_SESSIONS_MODE=off. The module is never read from the request.
 *
 *   GET  /auth/module/v2/captcha                      { id, question }
 *   POST /auth/module/v2/username/check               { username }                      { available }
 *   POST /auth/module/v2/referral/check               { code }                          { valid }
 *   POST /auth/module/v2/mail/check                   { mail }                          { available }   (mail-style modules)
 *   POST /auth/module/v2/signup/verify                { email, code }                   { valid }       (looks, does not consume)
 *   POST /auth/module/v2/signup/start                 { email, captcha: { id, answer } }  202 (always)
 *   POST /auth/module/v2/signup/complete              { email, code, password, username, referral?, profile? }  201 { token, account }
 *   POST /auth/module/v2/login                        { email, password, requireCode? } 200 { token, account } | 200 { stepUp: { challenge, methods } }
 *   POST /auth/module/v2/login/email-code             { challenge }                     202
 *   POST /auth/module/v2/login/verify                 { challenge, code }               200 { token, account }
 *   POST /auth/module/v2/reset/request                { email }                         202 (always)
 *   POST /auth/module/v2/reset/confirm                { email, code, password }         200
 *   GET|PUT /auth/module/v2/profile                   (Bearer / module cookie)          200 { profile }
 */
const router = Router();
const authDb = poolAuthDb(pool as any);
const ACK = { message: "If that address can be used, a code is on its way." };

const V2_STATUS: Record<string, number> = {
  INVALID_CAPTCHA: 400, INVALID_CODE: 400, TOO_MANY_CODES: 429, USERNAME_INVALID: 400, USERNAME_TAKEN: 409,
  REFERRAL_INVALID: 400, CHALLENGE_INVALID: 400, PROFILE_INVALID: 404, MAIL_INVALID: 400, MAIL_TAKEN: 409,
  WORKSPACE_INVALID: 400, WORKSPACE_TAKEN: 409, TOTP_ALREADY_ENABLED: 409, TOTP_NOT_STARTED: 409, PASSKEY_INVALID: 401, PASSKEY_LIMIT: 409,
};
const V2_SOLUTION: Record<string, string> = {
  INVALID_CAPTCHA: "Solve the check again.", INVALID_CODE: "That code is wrong or expired. Request a new one.",
  TOO_MANY_CODES: "Too many codes requested. Try again in an hour.", USERNAME_INVALID: "Use 3-30 letters, numbers or underscores.",
  USERNAME_TAKEN: "That username is taken.", REFERRAL_INVALID: "That referral code is not valid.",
  CHALLENGE_INVALID: "This sign-in step expired. Start again.", MAIL_INVALID: "Use 3-30 letters, numbers, dots, dashes or underscores.", MAIL_TAKEN: "That address is taken.",
  WORKSPACE_INVALID: "Use 3-32 letters, numbers or dashes.", WORKSPACE_TAKEN: "That workspace URL is taken.", TOTP_ALREADY_ENABLED: "An authenticator is already set up.", TOTP_NOT_STARTED: "Start the authenticator setup first.", PASSKEY_INVALID: "That passkey could not be verified.", PASSKEY_LIMIT: "You already have the maximum number of passkeys.",
};
function fail(res: Response, f: V2Fail): void {
  if (f.code in V2_STATUS) {
    res.status(V2_STATUS[f.code]).json({ error: "Request rejected", code: f.code, ...(V2_SOLUTION[f.code] ? { solution: V2_SOLUTION[f.code] } : {}) });
    return;
  }
  baseFail(res, f as any);
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const brand = (m: ModuleId) => getModule(m)?.label ?? m;

function mail(module: ModuleId, to: string, code: string, what: string): void {
  const label = brand(module);
  void sendEmail({
    to, subject: `${code} is your ${label} ${what} code`,
    html: `<p>Your ${label} ${what} code is <b style="font-size:20px;letter-spacing:3px">${code}</b>.</p><p>It expires in ${OTP_TTL_MINUTES} minutes and works once. If you did not ask for it, ignore this email.</p>`,
    text: `Your ${label} ${what} code: ${code}\nIt expires in ${OTP_TTL_MINUTES} minutes and works once. If you did not ask for it, ignore this email.`,
  }).catch((err) => logger.warn({ err, module }, "module.auth_v2.email_failed"));
}

async function principalOf(req: Request, res: Response) {
  const module = moduleOf(res);
  const raw = req.headers.authorization?.replace("Bearer ", "").trim() || (req.cookies as Record<string, unknown> | undefined)?.[moduleCookieName(module)];
  const p = typeof raw === "string" && raw ? await getUserFromToken(raw) : null;
  return p && p.moduleId === module && p.moduleAccountId ? p : null;
}

router.get("/auth/module/v2/captcha", moduleGate, otpLimiter, (_req, res) => {
  res.set("Cache-Control", "no-store").json(newCaptcha(moduleOf(res)));
});

router.post("/auth/module/v2/username/check", moduleGate, otpLimiter, jsonOnly, async (req, res): Promise<void> => {
  const r = await isUsernameFree(authDb.query, moduleOf(res), req.body?.username);
  if (!r.ok) { fail(res, r); return; }
  res.json({ available: r.available, username: r.username });
});

router.post("/auth/module/v2/mail/check", moduleGate, otpLimiter, jsonOnly, async (req, res): Promise<void> => {
  const r = await isMailLocalFree(authDb.query, moduleOf(res), req.body?.mail);
  if (!r.ok) { fail(res, r); return; }
  res.json({ available: r.available, mail: r.mail });
});

router.post("/auth/module/v2/signup/verify", moduleGate, authLimiter, jsonOnly, async (req, res): Promise<void> => {
  const r = await checkSignupCode(authDb, { module: moduleOf(res), email: req.body?.email, code: req.body?.code });
  if (!r.ok) { fail(res, r); return; }
  res.json({ valid: true });
});

router.post("/auth/module/v2/referral/check", moduleGate, otpLimiter, jsonOnly, async (req, res): Promise<void> => {
  res.json({ valid: await isReferralValid(authDb.query, req.body?.code) });
});

router.post("/auth/module/v2/signup/start", moduleGate, otpLimiter, jsonOnly, async (req, res): Promise<void> => {
  const module = moduleOf(res);
  const r = await startSignup(authDb, { module, email: req.body?.email, captchaId: req.body?.captcha?.id, captchaAnswer: req.body?.captcha?.answer, client: clientInfo(req) });
  if (!r.ok) { fail(res, r); return; }
  if (r.send) mail(module, r.send.to, r.send.code, "sign-up");
  res.status(202).json(ACK);
});

router.post("/auth/module/v2/signup/complete", moduleGate, authLimiter, jsonOnly, async (req, res): Promise<void> => {
  const b = req.body ?? {};
  const r = await completeSignup(authDb, { module: moduleOf(res), email: b.email, code: b.code, password: b.password, username: b.username, referral: b.referral, profile: b.profile, mail: b.mail, client: clientInfo(req) });
  if (!r.ok) { fail(res, r); return; }
  const token = await issue(req, res, r, { role: "user", stepUpAt: new Date().toISOString() });
  res.status(201).json({ token, account: publicAccount(r, str(b.email)?.trim().toLowerCase()) });
});

router.post("/auth/module/v2/login", moduleGate, authLimiter, jsonOnly, async (req, res): Promise<void> => {
  const module = moduleOf(res);
  const r = await startLogin(authDb, { module, email: req.body?.email, password: req.body?.password, client: clientInfo(req), requireCode: req.body?.requireCode === true });
  if (!r.ok) { fail(res, r); return; }
  if (r.stepUp) {
    if (r.stepUp.send) mail(module, r.stepUp.send.to, r.stepUp.send.code, "sign-in");
    res.json({ stepUp: { challenge: r.stepUp.challenge, methods: r.stepUp.methods, emailSent: !!r.stepUp.send } });
    return;
  }
  const token = await issue(req, res, r, { stepUpAt: new Date().toISOString() });
  res.json({ token, account: publicAccount(r, str(req.body?.email)?.trim().toLowerCase()) });
});

router.post("/auth/module/v2/login/email-code", moduleGate, otpLimiter, jsonOnly, async (req, res): Promise<void> => {
  const module = moduleOf(res);
  const r = await sendLoginEmailCode(authDb, { module, challenge: req.body?.challenge, client: clientInfo(req) });
  if (!r.ok) { fail(res, r); return; }
  mail(module, r.send.to, r.send.code, "sign-in");
  res.status(202).json(ACK);
});

router.post("/auth/module/v2/login/verify", moduleGate, authLimiter, jsonOnly, async (req, res): Promise<void> => {
  const r = await completeLogin(authDb, { module: moduleOf(res), challenge: req.body?.challenge, code: req.body?.code, client: clientInfo(req) });
  if (!r.ok) { fail(res, r); return; }
  const token = await issue(req, res, r, { stepUpAt: new Date().toISOString() });
  res.json({ token, account: publicAccount(r) });
});

router.post("/auth/module/v2/reset/request", moduleGate, otpLimiter, jsonOnly, async (req, res): Promise<void> => {
  const module = moduleOf(res);
  const r = await startCodeReset(authDb, { module, email: req.body?.email, client: clientInfo(req) });
  if (r.send) mail(module, r.send.to, r.send.code, "password reset");
  res.status(202).json(ACK);
});

router.post("/auth/module/v2/reset/confirm", moduleGate, authLimiter, jsonOnly, async (req, res): Promise<void> => {
  const module = moduleOf(res);
  const r = await completeCodeReset(authDb, { module, email: req.body?.email, code: req.body?.code, newPassword: req.body?.password, client: clientInfo(req) });
  if (!r.ok) { fail(res, r); return; }
  clearModuleSessionCookie(res, module);
  res.json({ message: "Password updated. Sign in with your new password." });
});

router.get("/auth/module/v2/profile", moduleGate, async (req, res): Promise<void> => {
  const p = await principalOf(req, res);
  if (!p) { res.status(401).json({ error: "Unauthorized", code: "INVALID_TOKEN" }); return; }
  res.json({ profile: await getProfile(authDb.query, p.moduleAccountId!) });
});

router.put("/auth/module/v2/profile", moduleGate, authLimiter, jsonOnly, async (req, res): Promise<void> => {
  const p = await principalOf(req, res);
  if (!p) { res.status(401).json({ error: "Unauthorized", code: "INVALID_TOKEN" }); return; }
  const r = await updateProfile(authDb, { module: moduleOf(res), moduleAccountId: p.moduleAccountId!, profile: req.body ?? {}, client: clientInfo(req) });
  if (!r.ok) { fail(res, r); return; }
  res.json({ profile: await getProfile(authDb.query, p.moduleAccountId!) });
});

router.post("/auth/module/v2/workspace/check", moduleGate, authLimiter, jsonOnly, async (req, res): Promise<void> => {
  const r = await isWorkspaceSlugFree(authDb.query, moduleOf(res), req.body?.slug);
  if (!r.ok) { fail(res, r); return; }
  res.json({ available: r.available });
});

router.post("/auth/module/v2/totp/enrol", moduleGate, authLimiter, jsonOnly, async (req, res): Promise<void> => {
  const p = await principalOf(req, res);
  if (!p) { res.status(401).json({ error: "Unauthorized", code: "INVALID_TOKEN" }); return; }
  const r = await beginTotpEnrol(authDb, { module: moduleOf(res), moduleAccountId: p.moduleAccountId!, client: clientInfo(req) });
  if (!r.ok) { fail(res, r); return; }
  res.setHeader("Cache-Control", "no-store");
  res.json({ secret: r.secret, uri: r.uri });
});

router.post("/auth/module/v2/totp/confirm", "/auth/module/v2/passkey", "/auth/module/v2/passkey/register/options", "/auth/module/v2/passkey/register/verify", "/auth/module/v2/login/passkey/options", "/auth/module/v2/login/passkey/verify", moduleGate, authLimiter, jsonOnly, async (req, res): Promise<void> => {
  const p = await principalOf(req, res);
  if (!p) { res.status(401).json({ error: "Unauthorized", code: "INVALID_TOKEN" }); return; }
  const r = await confirmTotpEnrol(authDb, { module: moduleOf(res), moduleAccountId: p.moduleAccountId!, code: req.body?.code, client: clientInfo(req) });
  if (!r.ok) { fail(res, r); return; }
  res.json({ enabled: true });
});

const rpOf = (req: Request) => ({ ...getWebAuthnConfig(req), rpName });

router.get("/auth/module/v2/passkey", moduleGate, async (req, res): Promise<void> => {
  const p = await principalOf(req, res);
  if (!p) { res.status(401).json({ error: "Unauthorized", code: "INVALID_TOKEN" }); return; }
  res.json({ passkeys: await listPasskeys(authDb.query, { module: moduleOf(res), moduleAccountId: p.moduleAccountId! }) });
});

router.delete("/auth/module/v2/passkey/:id", moduleGate, authLimiter, async (req, res): Promise<void> => {
  const p = await principalOf(req, res);
  if (!p) { res.status(401).json({ error: "Unauthorized", code: "INVALID_TOKEN" }); return; }
  const r = await deletePasskey(authDb, { module: moduleOf(res), moduleAccountId: p.moduleAccountId!, id: Number(req.params.id), client: clientInfo(req) });
  if (!r.ok) { fail(res, r); return; }
  res.json({ deleted: true });
});

router.post("/auth/module/v2/passkey/register/options", moduleGate, authLimiter, jsonOnly, async (req, res): Promise<void> => {
  const p = await principalOf(req, res);
  if (!p) { res.status(401).json({ error: "Unauthorized", code: "INVALID_TOKEN" }); return; }
  const r = await passkeyRegisterOptions(authDb, { module: moduleOf(res), moduleAccountId: p.moduleAccountId!, rp: rpOf(req) });
  if (!r.ok) { fail(res, r); return; }
  res.setHeader("Cache-Control", "no-store");
  res.json({ options: r.options, token: r.token });
});

router.post("/auth/module/v2/passkey/register/verify", moduleGate, authLimiter, jsonOnly, async (req, res): Promise<void> => {
  const p = await principalOf(req, res);
  if (!p) { res.status(401).json({ error: "Unauthorized", code: "INVALID_TOKEN" }); return; }
  const r = await passkeyRegisterVerify(authDb, { module: moduleOf(res), moduleAccountId: p.moduleAccountId!, rp: rpOf(req), token: req.body?.token, response: req.body?.response, name: req.body?.name, client: clientInfo(req) });
  if (!r.ok) { fail(res, r); return; }
  res.status(201).json({ id: r.id, name: r.name });
});

router.post("/auth/module/v2/login/passkey/options", moduleGate, authLimiter, jsonOnly, async (req, res): Promise<void> => {
  const r = await passkeyLoginOptions(authDb, { module: moduleOf(res), challenge: req.body?.challenge, rp: rpOf(req) });
  if (!r.ok) { fail(res, r); return; }
  res.setHeader("Cache-Control", "no-store");
  res.json({ options: r.options, token: r.token });
});

router.post("/auth/module/v2/login/passkey/verify", moduleGate, authLimiter, jsonOnly, async (req, res): Promise<void> => {
  const module = moduleOf(res);
  const r = await passkeyLoginVerify(authDb, { module, challenge: req.body?.challenge, token: req.body?.token, response: req.body?.response, rp: rpOf(req), client: clientInfo(req) });
  if (!r.ok) { fail(res, r); return; }
  const token = await issue(req, res, r, { stepUpAt: new Date().toISOString() });
  res.json({ token, account: publicAccount(r) });
});

export const MODULE_AUTH_V2_ROUTE_PATHS = [
  "/auth/module/v2/captcha", "/auth/module/v2/username/check", "/auth/module/v2/referral/check", "/auth/module/v2/mail/check", "/auth/module/v2/signup/verify", "/auth/module/v2/signup/start",
  "/auth/module/v2/signup/complete", "/auth/module/v2/login", "/auth/module/v2/login/email-code", "/auth/module/v2/login/verify",
  "/auth/module/v2/reset/request", "/auth/module/v2/reset/confirm", "/auth/module/v2/profile", "/auth/module/v2/workspace/check", "/auth/module/v2/totp/enrol", "/auth/module/v2/totp/confirm",
] as const;

export default router;
