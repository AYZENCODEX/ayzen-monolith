/**
 * module-auth-v2-service.ts — the extra steps of the designed module login flows (email code, captcha, username,
 * referral, step-up, code-based reset, profile), on top of module-auth-service.ts. Same style: pure functions over an
 * injected AuthDb, no Express, so they run against a throwaway Postgres in module-auth-v2-service.db.test.ts.
 *
 * Nothing here trusts the client: codes are stored only as HMAC hashes, are single-use with an attempt cap, and the
 * captcha / step-up challenges are stateless HMAC blobs that carry their own expiry and are bound to the module.
 */
import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import type { ModuleId } from "@ayzen/module-registry";
import {
  audit, finishPasswordLogin, normalizeIdentifier, signupWithPassword, verifyLoginCredentials,
  type AuthDb, type ClientInfo, type Fail, type IssuedModuleSession, type Query,
} from "./module-auth-service";
import { isKnownModuleId } from "./module-session-policy";
import { checkPasswordPolicy, hashModulePassword } from "./module-password";
import { totpVerify } from "./totp";

export const OTP_TTL_MINUTES = 10;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_MAX_PER_HOUR = 5;
export const CHALLENGE_TTL_SECONDS = 300;
export const USERNAME_RE = /^[a-z0-9_]{3,30}$/;

export type V2ErrorCode =
  | "INVALID_CAPTCHA" | "INVALID_CODE" | "TOO_MANY_CODES" | "USERNAME_INVALID" | "USERNAME_TAKEN" | "REFERRAL_INVALID"
  | "CHALLENGE_INVALID" | "PROFILE_INVALID";
export type V2Fail = { ok: false; code: V2ErrorCode | Fail["code"] };
const bad = (code: V2Fail["code"]): V2Fail => ({ ok: false, code });

const secretOf = (env: NodeJS.ProcessEnv = process.env) =>
  env.MODULE_AUTH_HMAC_SECRET || env.AYZEN_JWT_SECRET || env.JWT_SECRET || "ayzen-dev-only-module-auth-secret";
const hmac = (secret: string, s: string) => createHmac("sha256", secret).update(s, "utf8").digest("hex");
const safeEq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Step-up at login: off (default) = only accounts with an enrolled authenticator are challenged; email = everyone gets an emailed code. */
export type StepUpMode = "off" | "email";
export const stepUpMode = (env: NodeJS.ProcessEnv = process.env): StepUpMode => (env.MODULE_LOGIN_STEP_UP === "email" ? "email" : "off");

// ─── stateless signed blobs (captcha + step-up challenge) ────────────────────────────────────────

function sign(kind: string, module: ModuleId, payload: Record<string, unknown>, ttlSec: number, secret: string, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ k: kind, m: module, e: Math.floor(now / 1000) + ttlSec, ...payload })).toString("base64url");
  return `${body}.${hmac(secret, `${kind}.${body}`)}`;
}
function open(kind: string, module: ModuleId, blob: unknown, secret: string, now = Date.now()): Record<string, any> | null {
  if (typeof blob !== "string" || blob.length > 1000) return null;
  const [body, mac] = blob.split(".");
  if (!body || !mac || !safeEq(mac, hmac(secret, `${kind}.${body}`))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (p.k !== kind || p.m !== module || typeof p.e !== "number" || p.e < Math.floor(now / 1000)) return null;
    return p;
  } catch { return null; }
}

/** A small arithmetic question; the answer only lives (HMAC-bound) inside the blob. Cheap bot speed bump, not a fraud product. */
export function newCaptcha(module: ModuleId, opts: { env?: NodeJS.ProcessEnv; now?: number } = {}) {
  const a = randomInt(2, 10), b = randomInt(2, 10);
  const secret = secretOf(opts.env);
  const salt = randomInt(1, 2 ** 31).toString(36);
  return { id: sign("captcha", module, { h: hmac(secret, `${salt}:${a + b}`), s: salt }, CHALLENGE_TTL_SECONDS, secret, opts.now), question: `${a} + ${b}` };
}
export function checkCaptcha(module: ModuleId, id: unknown, answer: unknown, opts: { env?: NodeJS.ProcessEnv; now?: number } = {}): boolean {
  const secret = secretOf(opts.env);
  const p = open("captcha", module, id, secret, opts.now);
  const n = typeof answer === "number" ? answer : typeof answer === "string" && /^\d{1,3}$/.test(answer.trim()) ? Number(answer) : NaN;
  return !!p && Number.isInteger(n) && safeEq(String(p.h), hmac(secret, `${p.s}:${n}`));
}

// ─── email codes ─────────────────────────────────────────────────────────────────────────────────

export type OtpPurpose = "signup" | "login" | "reset";
const codeHash = (secret: string, module: string, purpose: string, idn: string, code: string) => hmac(secret, `otp:${module}:${purpose}:${idn}:${code}`);

/** Issues a fresh 6-digit code (older unused ones are voided). Returns null when rate-limited. The code is returned only so the caller can email it. */
export async function issueOtp(
  db: AuthDb,
  input: { module: ModuleId; purpose: OtpPurpose; identifier: string; ip: string | null; env?: NodeJS.ProcessEnv },
): Promise<{ code: string } | null> {
  const secret = secretOf(input.env);
  return db.transaction(async (q) => {
    // Serialise per (module, identifier) so the hourly cap cannot be raced past.
    await q(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`otp:${input.module}:${input.identifier}`]);
    const recent = await q(
      `SELECT count(*)::int n FROM module_otps WHERE module=$1 AND identifier_norm=$2 AND created_at > NOW() - INTERVAL '1 hour'`,
      [input.module, input.identifier],
    );
    if (recent.rows[0].n >= OTP_MAX_PER_HOUR) return null;
    await q(`UPDATE module_otps SET used_at = NOW() WHERE module=$1 AND identifier_norm=$2 AND purpose=$3 AND used_at IS NULL`, [input.module, input.identifier, input.purpose]);
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    await q(
      `INSERT INTO module_otps (module, purpose, identifier_norm, code_hash, expires_at, requested_ip)
       VALUES ($1,$2,$3,$4, NOW() + make_interval(mins => $5::int), $6)`,
      [input.module, input.purpose, input.identifier, codeHash(secret, input.module, input.purpose, input.identifier, code), OTP_TTL_MINUTES, input.ip],
    );
    return { code };
  });
}

/** Checks a code and, when `consume`, burns it atomically. Wrong guesses count against the newest live code. */
export async function checkOtp(
  q: Query,
  input: { module: ModuleId; purpose: OtpPurpose; identifier: string; code: unknown; consume: boolean; env?: NodeJS.ProcessEnv },
): Promise<boolean> {
  if (typeof input.code !== "string" || !/^\d{6}$/.test(input.code.trim())) return false;
  const secret = secretOf(input.env);
  const r = await q(
    `SELECT id, code_hash FROM module_otps
      WHERE module=$1 AND purpose=$2 AND identifier_norm=$3 AND used_at IS NULL AND expires_at > NOW() AND attempts < $4
      ORDER BY id DESC LIMIT 1 FOR UPDATE`,
    [input.module, input.purpose, input.identifier, OTP_MAX_ATTEMPTS],
  );
  const row = r.rows[0];
  if (!row) return false;
  const ok = safeEq(row.code_hash, codeHash(secret, input.module, input.purpose, input.identifier, input.code.trim()));
  if (!ok) { await q(`UPDATE module_otps SET attempts = attempts + 1 WHERE id = $1`, [row.id]); return false; }
  if (input.consume) await q(`UPDATE module_otps SET used_at = NOW() WHERE id = $1`, [row.id]);
  return true;
}

// ─── username / referral ─────────────────────────────────────────────────────────────────────────

export const normalizeUsername = (raw: unknown): string | null => {
  if (typeof raw !== "string") return null;
  const v = raw.trim().replace(/^@/, "").toLowerCase();
  return USERNAME_RE.test(v) ? v : null;
};

export async function isUsernameFree(q: Query, module: ModuleId, raw: unknown): Promise<{ ok: true; available: boolean; username: string } | V2Fail> {
  const username = normalizeUsername(raw);
  if (!username) return bad("USERNAME_INVALID");
  const r = await q(`SELECT 1 FROM module_profiles WHERE module=$1 AND username_norm=$2`, [module, username]);
  return { ok: true, available: r.rows.length === 0, username };
}

/** A referral code is an existing AYZEN user's code. Only validity is revealed, never whose it is. */
export async function isReferralValid(q: Query, raw: unknown): Promise<boolean> {
  if (typeof raw !== "string" || !/^[A-Za-z0-9_-]{3,40}$/.test(raw.trim())) return false;
  const r = await q(`SELECT 1 FROM users WHERE referral_code = $1 AND status = 'active'`, [raw.trim()]);
  return r.rows.length > 0;
}

// ─── sign-up (email code → account) ──────────────────────────────────────────────────────────────

/** Step 1. Answers the same whether or not the email is already registered (no account enumeration); returns a code to mail only for a free email. */
export async function startSignup(
  db: AuthDb,
  input: { module: unknown; email: unknown; captchaId: unknown; captchaAnswer: unknown; client: ClientInfo; env?: NodeJS.ProcessEnv; now?: number },
): Promise<{ ok: true; send: { to: string; code: string } | null } | V2Fail> {
  if (!isKnownModuleId(input.module)) return bad("INVALID_MODULE");
  const module = input.module;
  const identifier = normalizeIdentifier(input.email);
  if (!identifier) return bad("INVALID_IDENTIFIER");
  if (!checkCaptcha(module, input.captchaId, input.captchaAnswer, { env: input.env, now: input.now })) return bad("INVALID_CAPTCHA");
  const taken = await db.query(`SELECT 1 FROM module_credentials WHERE module=$1 AND identifier_norm=$2`, [module, identifier]);
  if (taken.rows.length) return { ok: true, send: null };
  const otp = await issueOtp(db, { module, purpose: "signup", identifier, ip: input.client.ip, env: input.env });
  if (!otp) return bad("TOO_MANY_CODES");
  return { ok: true, send: { to: identifier, code: otp.code } };
}

export interface ProfileInput { firstName?: unknown; lastName?: unknown; location?: unknown; bio?: unknown; links?: unknown }
const clip = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
export function cleanProfile(p: ProfileInput | undefined) {
  const links = Array.isArray(p?.links) ? (p!.links as unknown[]).filter((l): l is string => typeof l === "string" && /^https?:\/\//i.test(l)).slice(0, 5).map((l) => l.slice(0, 300)) : [];
  return { firstName: clip(p?.firstName, 60), lastName: clip(p?.lastName, 60), location: clip(p?.location, 120), bio: clip(p?.bio, 500), links };
}

/** Step 2. Proves the mailbox with the code, then creates account + credential (identifier verified) + profile in one transaction. */
export async function completeSignup(
  db: AuthDb,
  input: {
    module: unknown; email: unknown; code: unknown; password: unknown; username: unknown; referral?: unknown; profile?: ProfileInput;
    client: ClientInfo; env?: NodeJS.ProcessEnv;
  },
): Promise<({ ok: true } & IssuedModuleSession) | V2Fail> {
  if (!isKnownModuleId(input.module)) return bad("INVALID_MODULE");
  const module = input.module;
  const identifier = normalizeIdentifier(input.email);
  if (!identifier) return bad("INVALID_IDENTIFIER");
  const username = normalizeUsername(input.username);
  if (!username) return bad("USERNAME_INVALID");
  // Cheap checks first so a typo in the password or username does not burn the emailed code.
  const policy = checkPasswordPolicy(input.password, identifier);
  if (!policy.ok) return bad(policy.code);
  let referral: string | null = null;
  if (typeof input.referral === "string" && input.referral.trim()) {
    if (!(await isReferralValid(db.query, input.referral))) return bad("REFERRAL_INVALID");
    referral = input.referral.trim();
  }
  const free = await isUsernameFree(db.query, module, username);
  if (!free.ok) return free;
  if (!free.available) return bad("USERNAME_TAKEN");
  const profile = cleanProfile(input.profile);

  // The code is checked-and-burned only together with the account creation: if creation fails, the code survives.
  let codeOk = false;
  try {
    const r = await db.transaction(async (q) => {
      codeOk = await checkOtp(q, { module, purpose: "signup", identifier, code: input.code, consume: false, env: input.env });
      if (!codeOk) return { ok: false, code: "INVALID_CODE" } as V2Fail;
      const s = await signupWithPassword(
        { query: q, transaction: (fn) => fn(q) },
        {
          module, identifier, password: input.password, client: input.client, verified: true,
          afterCreate: async (tq, acct) => {
            await tq(
              `INSERT INTO module_profiles (module_account_id, module, username, username_norm, first_name, last_name, display_name, location, bio, links, referral_code_used)
               VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`,
              [acct.id, module, username, profile.firstName, profile.lastName, [profile.firstName, profile.lastName].filter(Boolean).join(" ") || username,
               profile.location, profile.bio, JSON.stringify(profile.links), referral],
            );
          },
        },
      );
      if (!s.ok) return s as V2Fail;
      await q(`UPDATE module_otps SET used_at = NOW() WHERE module=$1 AND purpose='signup' AND identifier_norm=$2 AND used_at IS NULL`, [module, identifier]);
      return s;
    });
    return r;
  } catch (e) {
    if ((e as any)?.code === "23505" && /username/.test(String((e as any).constraint))) return bad("USERNAME_TAKEN");
    throw e;
  }
}

// ─── login with optional step-up ─────────────────────────────────────────────────────────────────

export type LoginResult =
  | ({ ok: true; stepUp?: undefined } & IssuedModuleSession)
  | { ok: true; stepUp: { challenge: string; methods: Array<"totp" | "email">; send: { to: string; code: string } | null } }
  | V2Fail;

/** Password check, then either a session (default) or a short-lived challenge when an extra factor is required. */
export async function startLogin(
  db: AuthDb,
  input: { module: unknown; email: unknown; password: unknown; client: ClientInfo; env?: NodeJS.ProcessEnv; now?: number },
): Promise<LoginResult> {
  const v = await verifyLoginCredentials(db, { module: input.module, identifier: input.email, password: input.password, client: input.client, env: input.env });
  if (!v.ok) return v;
  const mode = stepUpMode(input.env);
  const totp = v.row.mfa_enabled && !!v.row.mfa_secret;
  if (!totp && mode === "off") return finishPasswordLogin(db, v, input.client);
  const methods: Array<"totp" | "email"> = totp ? ["totp", "email"] : ["email"];
  const secret = secretOf(input.env);
  const challenge = sign("stepup", v.module, { a: v.row.module_account_id, c: v.row.cred_id }, CHALLENGE_TTL_SECONDS, secret, input.now);
  let send: { to: string; code: string } | null = null;
  // Email is offered as the fallback for a lost authenticator only when the mailbox was verified at sign-up/reset.
  const idn = normalizeIdentifier(input.email)!;
  const vr = await db.query(`SELECT identifier_verified_at FROM module_credentials WHERE id=$1`, [v.row.cred_id]);
  const emailOk = !!vr.rows[0]?.identifier_verified_at;
  if (!emailOk) { const i = methods.indexOf("email"); if (i >= 0) methods.splice(i, 1); }
  if (!totp && emailOk) {
    const otp = await issueOtp(db, { module: v.module, purpose: "login", identifier: idn, ip: input.client.ip, env: input.env });
    if (!otp) return bad("TOO_MANY_CODES");
    send = { to: v.row.identifier, code: otp.code };
  }
  if (methods.length === 0) return finishPasswordLogin(db, v, input.client); // unverified mailbox and no authenticator: nothing to challenge with
  return { ok: true, stepUp: { challenge, methods, send } };
}

/** Sends the emailed fallback for an authenticator account (explicit user action). */
export async function sendLoginEmailCode(
  db: AuthDb, input: { module: unknown; challenge: unknown; client: ClientInfo; env?: NodeJS.ProcessEnv; now?: number },
): Promise<{ ok: true; send: { to: string; code: string } } | V2Fail> {
  if (!isKnownModuleId(input.module)) return bad("INVALID_MODULE");
  const p = open("stepup", input.module, input.challenge, secretOf(input.env), input.now);
  if (!p) return bad("CHALLENGE_INVALID");
  const r = await db.query(
    `SELECT identifier, identifier_norm, identifier_verified_at FROM module_credentials WHERE id=$1 AND module_account_id=$2 AND module=$3`,
    [p.c, p.a, input.module],
  );
  const row = r.rows[0];
  if (!row || !row.identifier_verified_at) return bad("CHALLENGE_INVALID");
  const otp = await issueOtp(db, { module: input.module, purpose: "login", identifier: row.identifier_norm, ip: input.client.ip, env: input.env });
  if (!otp) return bad("TOO_MANY_CODES");
  return { ok: true, send: { to: row.identifier, code: otp.code } };
}

/** Second step: a TOTP code or the emailed code opens the session. The challenge is bound to the module and expires in 5 minutes. */
export async function completeLogin(
  db: AuthDb,
  input: { module: unknown; challenge: unknown; code: unknown; client: ClientInfo; env?: NodeJS.ProcessEnv; now?: number },
): Promise<({ ok: true } & IssuedModuleSession) | V2Fail> {
  if (!isKnownModuleId(input.module)) return bad("INVALID_MODULE");
  const module = input.module;
  const p = open("stepup", module, input.challenge, secretOf(input.env), input.now);
  if (!p) return bad("CHALLENGE_INVALID");
  const found = await db.query(
    `SELECT c.id AS cred_id, c.module_account_id, c.password_hash, c.mfa_enabled, c.mfa_secret, c.identifier, c.identifier_norm, c.identifier_verified_at,
            a.user_id, a.status, a.module_uid, u.status AS user_status
       FROM module_credentials c JOIN module_accounts a ON a.id=c.module_account_id JOIN users u ON u.id=a.user_id
      WHERE c.id=$1 AND c.module_account_id=$2 AND c.module=$3`,
    [p.c, p.a, module],
  );
  const row = found.rows[0];
  const dead = !row || row.status !== "active" || row.user_status === "banned" || row.user_status === "suspended";
  if (dead) return bad("CHALLENGE_INVALID");
  const code = typeof input.code === "string" ? input.code.trim() : "";
  let ok = false;
  if (row.mfa_enabled && row.mfa_secret && /^\d{6}$/.test(code)) ok = totpVerify(code, row.mfa_secret);
  if (!ok && row.identifier_verified_at) {
    ok = await db.transaction((q) => checkOtp(q, { module, purpose: "login", identifier: row.identifier_norm, code, consume: true, env: input.env }));
  }
  if (!ok) {
    await audit(db.query, module, row.module_account_id, "step_up", "failure", input.client).catch(() => {});
    return bad("INVALID_CODE");
  }
  await audit(db.query, module, row.module_account_id, "step_up", "success", input.client).catch(() => {});
  return finishPasswordLogin(db, { module, password: "", row: { ...row, password_hash: row.password_hash } } as any, input.client);
}

// ─── code-based password reset ───────────────────────────────────────────────────────────────────

/** Always answers the same; a code is returned for mailing only when an active account exists. */
export async function startCodeReset(
  db: AuthDb, input: { module: unknown; email: unknown; client: ClientInfo; env?: NodeJS.ProcessEnv },
): Promise<{ send: { to: string; code: string } | null }> {
  if (!isKnownModuleId(input.module)) return { send: null };
  const idn = normalizeIdentifier(input.email);
  if (!idn) return { send: null };
  const r = await db.query(
    `SELECT c.identifier FROM module_credentials c JOIN module_accounts a ON a.id=c.module_account_id WHERE c.module=$1 AND c.identifier_norm=$2 AND a.status='active'`,
    [input.module, idn],
  );
  if (!r.rows[0]) return { send: null };
  const otp = await issueOtp(db, { module: input.module, purpose: "reset", identifier: idn, ip: input.client.ip, env: input.env });
  return { send: otp ? { to: r.rows[0].identifier as string, code: otp.code } : null };
}

export async function completeCodeReset(
  db: AuthDb, input: { module: unknown; email: unknown; code: unknown; newPassword: unknown; client: ClientInfo; env?: NodeJS.ProcessEnv },
): Promise<{ ok: true } | V2Fail> {
  if (!isKnownModuleId(input.module)) return bad("INVALID_MODULE");
  const module = input.module;
  const idn = normalizeIdentifier(input.email);
  if (!idn) return bad("INVALID_CODE");
  const policy = checkPasswordPolicy(input.newPassword, idn);
  if (!policy.ok) return bad(policy.code);
  const hash = await hashModulePassword(input.newPassword as string);
  return db.transaction(async (q) => {
    if (!(await checkOtp(q, { module, purpose: "reset", identifier: idn, code: input.code, consume: true, env: input.env }))) return bad("INVALID_CODE");
    const u = await q(
      `UPDATE module_credentials SET password_hash=$3, password_updated_at=NOW(), failed_attempts=0, locked_until=NULL,
              identifier_verified_at=COALESCE(identifier_verified_at, NOW()), updated_at=NOW()
        WHERE module=$1 AND identifier_norm=$2 RETURNING module_account_id`,
      [module, idn, hash],
    );
    if (!u.rows[0]) return bad("INVALID_CODE");
    await q(`UPDATE user_sessions SET revoked_at=NOW() WHERE module_account_id=$1 AND revoked_at IS NULL`, [u.rows[0].module_account_id]);
    await audit(q, module, u.rows[0].module_account_id, "password_reset_completed", "success", input.client, { via: "code" });
    return { ok: true } as const;
  });
}

// ─── profile ─────────────────────────────────────────────────────────────────────────────────────

export async function getProfile(q: Query, moduleAccountId: number) {
  const r = await q(`SELECT username, first_name, last_name, display_name, location, bio, links FROM module_profiles WHERE module_account_id=$1`, [moduleAccountId]);
  const p = r.rows[0];
  return p ? { username: p.username as string, firstName: p.first_name as string | null, lastName: p.last_name as string | null, displayName: p.display_name as string | null, location: p.location as string | null, bio: p.bio as string | null, links: (p.links ?? []) as string[] } : null;
}

export async function updateProfile(
  db: AuthDb, input: { module: ModuleId; moduleAccountId: number; profile: ProfileInput; client: ClientInfo },
): Promise<{ ok: true } | V2Fail> {
  const p = cleanProfile(input.profile);
  return db.transaction(async (q) => {
    const u = await q(
      `UPDATE module_profiles SET first_name=$3, last_name=$4, display_name=COALESCE(NULLIF(trim(concat_ws(' ', $3::text, $4::text)), ''), username),
              location=$5, bio=$6, links=$7::jsonb, updated_at=NOW()
        WHERE module_account_id=$1 AND module=$2`,
      [input.moduleAccountId, input.module, p.firstName, p.lastName, p.location, p.bio, JSON.stringify(p.links)],
    );
    if (!u.rowCount) return bad("PROFILE_INVALID");
    await audit(q, input.module, input.moduleAccountId, "profile_updated", "success", input.client);
    return { ok: true } as const;
  });
}
