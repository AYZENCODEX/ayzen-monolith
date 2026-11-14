/**
 * lib/module-auth-service.ts — W1-P2 (req 7, ADR A2): per-module signup / login / logout / password reset /
 * "Continue with AYZEN", plus the server-side check that a module session is still valid.
 *
 * The database is INJECTED (`AuthDb`): production passes the app pool (see `poolAuthDb`), the DB tests pass a
 * pool to a throwaway Postgres. Nothing here imports Express, the JWT signer or @workspace/db, so the whole
 * service is exercised against a real database without booting the API.
 *
 * Model (ADR A2):
 *   module_accounts   one row per (users row, module) — W1-P1. Every data table keys on users.id, so a module
 *                     account is always owned by a users row.
 *   module_credentials  email + argon2id hash for ONE module account.
 *   module_account_links  how an AYZEN identity reaches the account:
 *       backing          the users row was created BY a module signup (non-deliverable email, empty central
 *                        password hash — it can never sign in to the central app).
 *       legacy_continue  an existing AYZEN user pressed "Continue with AYZEN" on a module host.
 *
 * Security properties (each has a test in test-module-auth-db.mjs):
 *   - A login failure never says whether the identifier exists, the account is locked or suspended
 *     (one code, INVALID_CREDENTIALS) and burns the same CPU either way.
 *   - Failed attempts and lockout are counted in ONE atomic UPDATE (no read-modify-write race).
 *   - Reset tokens are 256-bit, stored hashed, single-use (atomic claim), 30 minutes, newest wins.
 *   - Completing a reset revokes every session of that module account.
 *   - The audit trail never stores passwords, tokens or the raw identifier of an unknown account.
 */
import { createHash, randomBytes } from "node:crypto";
import { getModule } from "@ayzen/module-registry";
import { isKnownModuleId } from "./module-session-policy";
import type { ModuleId } from "@ayzen/module-registry";
import {
  burnVerificationTime, checkPasswordPolicy, hashModulePassword, hashResetToken, modulePasswordNeedsRehash,
  newResetToken, verifyModulePassword, type PasswordPolicyResult,
} from "./module-password";

// ─── Database seam ───────────────────────────────────────────────────────────

export interface SqlResult { rows: any[]; rowCount: number | null }
export type Query = (sql: string, params?: unknown[]) => Promise<SqlResult>;
export interface AuthDb {
  query: Query;
  /** Runs `fn` in one transaction (BEGIN … COMMIT, ROLLBACK on throw) on a single connection. */
  transaction<T>(fn: (q: Query) => Promise<T>): Promise<T>;
}

/** Adapts a node-postgres Pool (or anything with query()+connect()) to AuthDb. */
export function poolAuthDb(pool: {
  query: Query;
  connect(): Promise<{ query: Query; release(): void }>;
}): AuthDb {
  return {
    query: (sql, params) => pool.query(sql, params),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const out = await fn((sql, params) => client.query(sql, params));
        await client.query("COMMIT");
        return out;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
  };
}

// ─── Tunables ────────────────────────────────────────────────────────────────

export const MODULE_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // same as the shared session (lib/sessions.ts)
export const RESET_TOKEN_TTL_MINUTES = 30;
const RESET_MAX_PER_HOUR = 3;

function envInt(name: string, fallback: number, min: number, max: number, env: NodeJS.ProcessEnv): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}
export function lockoutConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    maxFailures: envInt("MODULE_LOGIN_MAX_FAILURES", 5, 3, 50, env),
    lockMinutes: envInt("MODULE_LOGIN_LOCK_MINUTES", 15, 1, 1440, env),
  };
}

// ─── Types ───────────────────────────────────────────────────────────────────

export type ModuleAuthErrorCode =
  | "INVALID_MODULE" | "INVALID_IDENTIFIER" | "IDENTIFIER_TAKEN" | "INVALID_CREDENTIALS"
  | "ACCOUNT_NOT_ACTIVE" | "INVALID_TOKEN"
  | "ALREADY_HAS_MODULE_ACCOUNT" | "ACCOUNT_ALREADY_LINKED" | "EMAIL_ACCOUNT_EXISTS"
  | Extract<PasswordPolicyResult, { ok: false }>["code"];

export type Fail = { ok: false; code: ModuleAuthErrorCode };
export interface ClientInfo { ip: string | null; userAgent: string | null; deviceLabel: string }

export interface IssuedModuleSession {
  jti: string;
  expiresAt: Date;
  userId: number;
  moduleAccountId: number;
  module: ModuleId;
  moduleUid: string;
}

export type AuthEvent = "signup" | "login" | "logout" | "continue" | "password_reset_requested" | "password_reset_completed" | "oidc_login" | "link" | "clerk_login" | "clerk_user_created" | "clerk_user_deleted";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** lower(trim(email)); null when it is not a plausible email. The same value is what the unique index holds. */
export function normalizeIdentifier(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (v.length < 3 || v.length > 254 || !EMAIL.test(v)) return null;
  return v;
}

const sha16 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
const newJti = () => randomBytes(24).toString("hex"); // same shape as lib/sessions.ts generateSessionId()
const isUnique = (e: unknown, constraint?: string) => (e as any)?.code === "23505" && (!constraint || (e as any)?.constraint === constraint);

export async function audit(
  q: Query, module: ModuleId, accountId: number | null, event: AuthEvent, outcome: "success" | "failure",
  client: Pick<ClientInfo, "ip" | "userAgent"> | null, detail: Record<string, unknown> = {},
): Promise<void> {
  await q(
    `INSERT INTO module_auth_events (module, module_account_id, event, outcome, ip, user_agent, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [module, accountId, event, outcome, client?.ip ?? null, client?.userAgent?.slice(0, 300) ?? null, JSON.stringify(detail)],
  );
}

export async function insertSession(
  q: Query, a: { userId: number; moduleAccountId: number; module: ModuleId; moduleUid: string }, client: ClientInfo,
): Promise<IssuedModuleSession> {
  const jti = newJti();
  const expiresAt = new Date(Date.now() + MODULE_SESSION_TTL_MS);
  await q(
    `INSERT INTO user_sessions (user_id, jti, device_label, ip, user_agent, expires_at, module, module_account_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [a.userId, jti, client.deviceLabel, client.ip, client.userAgent, expiresAt, a.module, a.moduleAccountId],
  );
  return { jti, expiresAt, userId: a.userId, moduleAccountId: a.moduleAccountId, module: a.module, moduleUid: a.moduleUid };
}

// ─── Signup ──────────────────────────────────────────────────────────────────

export async function signupWithPassword(
  db: AuthDb,
  input: { module: unknown; identifier: unknown; password: unknown; client: ClientInfo },
): Promise<({ ok: true } & IssuedModuleSession) | Fail> {
  if (!isKnownModuleId(input.module)) return { ok: false, code: "INVALID_MODULE" };
  const module = input.module;
  const identifier = normalizeIdentifier(input.identifier);
  if (!identifier) return { ok: false, code: "INVALID_IDENTIFIER" };
  const policy = checkPasswordPolicy(input.password, identifier);
  if (!policy.ok) return { ok: false, code: policy.code };

  // Hash before opening the transaction: argon2 is the slow part and must not hold a connection.
  const passwordHash = await hashModulePassword(input.password as string);

  try {
    return await db.transaction(async (q) => {
      const taken = await q(`SELECT 1 FROM module_credentials WHERE module = $1 AND identifier_norm = $2`, [module, identifier]);
      if (taken.rows.length > 0) return { ok: false, code: "IDENTIFIER_TAKEN" } as Fail;

      const tag = randomBytes(12).toString("hex");
      // Non-deliverable by construction (.invalid, RFC 2606) with an EMPTY central hash: verifyPassword("") is false,
      // so this users row can never sign in to the central app, and mail sent to it goes nowhere.
      const u = await q(
        `INSERT INTO users (username, email, password_hash, role, status, email_verified)
         VALUES ($1, $2, '', 'user', 'active', FALSE) RETURNING id`,
        [`m_${module}_${tag}`, `m-${module}-${tag}@module-accounts.invalid`],
      );
      const userId: number = u.rows[0].id;
      const acct = (await q(`SELECT id, module_uid FROM ayzen_provision_module_account($1::int, $2, 'signup')`, [userId, module])).rows[0];
      await q(
        `INSERT INTO module_credentials (module_account_id, module, identifier, identifier_norm, password_hash)
         VALUES ($1, $2, $3, $3, $4)`,
        [acct.id, module, identifier, passwordHash],
      );
      await q(`INSERT INTO module_account_links (module_account_id, module, ayzen_user_id, method) VALUES ($1, $2, $3, 'backing')`, [acct.id, module, userId]);
      const session = await insertSession(q, { userId, moduleAccountId: acct.id, module, moduleUid: acct.module_uid }, input.client);
      await audit(q, module, acct.id, "signup", "success", input.client);
      return { ok: true, ...session } as const;
    });
  } catch (err) {
    // Two signups for one identifier racing: the unique index decides, the loser gets the normal answer.
    if (isUnique(err, "module_credentials_module_ident_idx")) return { ok: false, code: "IDENTIFIER_TAKEN" };
    throw err;
  }
}

// ─── Login ───────────────────────────────────────────────────────────────────

export async function loginWithPassword(
  db: AuthDb,
  input: { module: unknown; identifier: unknown; password: unknown; client: ClientInfo; env?: NodeJS.ProcessEnv },
): Promise<({ ok: true } & IssuedModuleSession) | Fail> {
  if (!isKnownModuleId(input.module)) return { ok: false, code: "INVALID_MODULE" };
  const module = input.module;
  const password = typeof input.password === "string" ? input.password.slice(0, 1024) : "";
  const identifier = normalizeIdentifier(input.identifier);

  const fail = async (accountId: number | null, detail: Record<string, unknown>): Promise<Fail> => {
    await audit(db.query, module, accountId, "login", "failure", input.client, detail).catch(() => {});
    return { ok: false, code: "INVALID_CREDENTIALS" };
  };

  if (!identifier) { await burnVerificationTime(password); return fail(null, { reason: "bad_identifier" }); }

  const found = await db.query(
    `SELECT c.id AS cred_id, c.module_account_id, c.password_hash, c.locked_until,
            (c.locked_until IS NOT NULL AND c.locked_until > NOW()) AS is_locked,
            a.user_id, a.status, a.module_uid, u.status AS user_status
       FROM module_credentials c
       JOIN module_accounts a ON a.id = c.module_account_id
       JOIN users u ON u.id = a.user_id
      WHERE c.module = $1 AND c.identifier_norm = $2`,
    [module, identifier],
  );
  const row = found.rows[0];
  if (!row) { await burnVerificationTime(password); return fail(null, { reason: "unknown", identifierHash: sha16(identifier) }); }
  // Locked / not-active look identical to a wrong password from the outside; the audit row says which.
  if (row.is_locked) { await burnVerificationTime(password); return fail(row.module_account_id, { reason: "locked" }); }
  if (row.status !== "active") { await burnVerificationTime(password); return fail(row.module_account_id, { reason: "status", status: row.status }); }
  // An admin ban/suspension of the owning users row applies to its module accounts too (getUserFromToken enforces the
  // same on every request; refusing here just avoids issuing a session that would be dead on arrival).
  if (row.user_status === "banned" || row.user_status === "suspended") { await burnVerificationTime(password); return fail(row.module_account_id, { reason: "user_status", status: row.user_status }); }

  if (!(await verifyModulePassword(password, row.password_hash))) {
    const { maxFailures, lockMinutes } = lockoutConfig(input.env);
    // One statement, evaluated against the latest row version: concurrent bad guesses cannot undercount.
    const upd = await db.query(
      `UPDATE module_credentials SET
         failed_attempts = CASE WHEN locked_until IS NOT NULL AND locked_until <= NOW() THEN 1 ELSE failed_attempts + 1 END,
         locked_until = CASE
           WHEN (CASE WHEN locked_until IS NOT NULL AND locked_until <= NOW() THEN 1 ELSE failed_attempts + 1 END) >= $2::int
             THEN NOW() + make_interval(mins => $3::int)
           WHEN locked_until IS NOT NULL AND locked_until <= NOW() THEN NULL
           ELSE locked_until END,
         updated_at = NOW()
       WHERE id = $1 RETURNING failed_attempts, locked_until`,
      [row.cred_id, maxFailures, lockMinutes],
    );
    return fail(row.module_account_id, { reason: "bad_password", failedAttempts: upd.rows[0]?.failed_attempts });
  }

  // Upgrade an old-parameter hash while we hold the plaintext (computed outside the transaction).
  const rehash = modulePasswordNeedsRehash(row.password_hash) ? await hashModulePassword(password) : null;
  return db.transaction(async (q) => {
    await q(
      `UPDATE module_credentials SET failed_attempts = 0, locked_until = NULL, last_login_at = NOW(), updated_at = NOW(),
              password_hash = COALESCE($2, password_hash), password_updated_at = CASE WHEN $2::text IS NULL THEN password_updated_at ELSE NOW() END
        WHERE id = $1`,
      [row.cred_id, rehash],
    );
    const session = await insertSession(q, { userId: row.user_id, moduleAccountId: row.module_account_id, module, moduleUid: row.module_uid }, input.client);
    await audit(q, module, row.module_account_id, "login", "success", input.client, rehash ? { rehashed: true } : {});
    return { ok: true, ...session } as const;
  });
}

// ─── Continue with AYZEN (existing shared-session user, first visit to a module) ─────────────────

export async function continueWithAyzen(
  db: AuthDb,
  input: { module: unknown; userId: number; client: ClientInfo },
): Promise<({ ok: true; created: boolean } & IssuedModuleSession) | Fail> {
  if (!isKnownModuleId(input.module)) return { ok: false, code: "INVALID_MODULE" };
  const module = input.module;
  return db.transaction(async (q) => {
    const existed = (await q(`SELECT 1 FROM module_accounts WHERE user_id = $1 AND module = $2`, [input.userId, module])).rows.length > 0;
    const acct = (await q(`SELECT id, module_uid, status FROM ayzen_provision_module_account($1::int, $2, 'lazy')`, [input.userId, module])).rows[0];
    if (acct.status !== "active") {
      await audit(q, module, acct.id, "continue", "failure", input.client, { status: acct.status });
      return { ok: false, code: "ACCOUNT_NOT_ACTIVE" } as Fail;
    }
    await q(
      `INSERT INTO module_account_links (module_account_id, module, ayzen_user_id, method)
       VALUES ($1, $2, $3, 'legacy_continue') ON CONFLICT DO NOTHING`,
      [acct.id, module, input.userId],
    );
    const session = await insertSession(q, { userId: input.userId, moduleAccountId: acct.id, module, moduleUid: acct.module_uid }, input.client);
    await audit(q, module, acct.id, "continue", "success", input.client, { created: !existed });
    return { ok: true, created: !existed, ...session } as const;
  });
}

// ─── Login with AYZEN (OIDC) and explicit linking — W1-P4 ─────────────────────────────────────────────────────

/**
 * Opens a module session for an AYZEN identity that has ALREADY been proven by the caller (the route verifies an OIDC
 * access token issued to THIS module's client). Three outcomes, in order:
 *   1. the identity is linked to a module account (explicitly, or via an earlier sign-in): that account's session;
 *   2. the identity already owns a module account (W1-P1 backfill / earlier lazy provision): link it (method 'oidc');
 *   3. otherwise a new module account is provisioned (source 'lazy', module_uid issued) and linked.
 * Case 1 matters for explicit links: the session then belongs to the LINKED account's owning user, not to the AYZEN user.
 */
export async function oidcSignIn(
  db: AuthDb,
  input: { module: unknown; ayzenUserId: number; client: ClientInfo },
): Promise<({ ok: true; created: boolean } & IssuedModuleSession) | Fail> {
  if (!isKnownModuleId(input.module)) return { ok: false, code: "INVALID_MODULE" };
  const module = input.module;
  return db.transaction(async (q) => {
    const linked = (await q(
      `SELECT a.id, a.user_id, a.module_uid, a.status
         FROM module_account_links l JOIN module_accounts a ON a.id = l.module_account_id
        WHERE l.ayzen_user_id = $1 AND l.module = $2`,
      [input.ayzenUserId, module],
    )).rows[0];
    let acct = linked;
    let created = false;
    if (!acct) {
      const existed = (await q(`SELECT 1 FROM module_accounts WHERE user_id = $1 AND module = $2`, [input.ayzenUserId, module])).rows.length > 0;
      const p = (await q(`SELECT id, module_uid, status FROM ayzen_provision_module_account($1::int, $2, 'lazy')`, [input.ayzenUserId, module])).rows[0];
      acct = { id: p.id, user_id: input.ayzenUserId, module_uid: p.module_uid, status: p.status };
      created = !existed;
      if (acct.status === "active") {
        await q(
          `INSERT INTO module_account_links (module_account_id, module, ayzen_user_id, method) VALUES ($1, $2, $3, 'oidc') ON CONFLICT DO NOTHING`,
          [acct.id, module, input.ayzenUserId],
        );
      }
    }
    if (acct.status !== "active") {
      await audit(q, module, acct.id, "oidc_login", "failure", input.client, { status: acct.status });
      return { ok: false, code: "ACCOUNT_NOT_ACTIVE" } as Fail;
    }
    // Both the AYZEN identity that signed in and the user that owns the account's data must be in good standing.
    const statuses = (await q(`SELECT id, status FROM users WHERE id = ANY($1::int[])`, [[input.ayzenUserId, acct.user_id]])).rows as Array<{ id: number; status: string }>;
    const blocked = [input.ayzenUserId, acct.user_id].some((id) => { const u = statuses.find((x) => x.id === id); return !u || u.status === "banned" || u.status === "suspended"; });
    if (blocked) {
      await audit(q, module, acct.id, "oidc_login", "failure", input.client, { reason: "user_status" });
      return { ok: false, code: "ACCOUNT_NOT_ACTIVE" } as Fail;
    }
    const session = await insertSession(q, { userId: acct.user_id, moduleAccountId: acct.id, module, moduleUid: acct.module_uid }, input.client);
    await audit(q, module, acct.id, "oidc_login", "success", input.client, { created, linkedAccount: Boolean(linked) });
    return { ok: true, created, ...session } as const;
  });
}

/**
 * Explicit link: an AYZEN identity (already proven by the caller) is attached to an EXISTING module account, proven by that
 * account's own email + password. Credentials are checked by loginWithPassword (same lockout, timing and ban rules as a normal
 * module login); the link is then written under constraints, and the session that login opened is revoked if the link is refused.
 *
 * Refused (never merged, never silently dropped):
 *   - ALREADY_HAS_MODULE_ACCOUNT: the AYZEN identity already has its own account in this module (data would have to be merged);
 *   - ACCOUNT_ALREADY_LINKED: the target account is already linked to a different AYZEN identity.
 */
export async function linkAyzenToModuleAccount(
  db: AuthDb,
  input: { module: unknown; ayzenUserId: number; identifier: unknown; password: unknown; client: ClientInfo; env?: NodeJS.ProcessEnv },
): Promise<({ ok: true; alreadyLinked: boolean } & IssuedModuleSession) | Fail> {
  const login = await loginWithPassword(db, { module: input.module, identifier: input.identifier, password: input.password, client: input.client, env: input.env });
  if (!login.ok) return login;
  const module = login.module;
  type Refusal = { refused: "ALREADY_HAS_MODULE_ACCOUNT" | "ACCOUNT_ALREADY_LINKED"; detail: Record<string, unknown> };
  // Refusals are DECIDED inside the transaction but ACTED ON after it ends: the revoke + audit use another connection, and
  // audit rows reference the account row this transaction has locked — doing it inside would wait on ourselves forever.
  const refuseAfter = async (r: Refusal): Promise<Fail> => {
    await db.query(`UPDATE user_sessions SET revoked_at = NOW() WHERE jti = $1 AND revoked_at IS NULL`, [login.jti]);
    await audit(db.query, module, login.moduleAccountId, "link", "failure", input.client, { code: r.refused, ...r.detail }).catch(() => {});
    return { ok: false, code: r.refused };
  };
  let outcome: { ok: true; alreadyLinked: boolean } | Refusal;
  try {
    outcome = await db.transaction(async (q) => {
      // Serialise concurrent links to the same account. NO KEY UPDATE: blocks other lockers, not the audit/FK checks.
      await q(`SELECT id FROM module_accounts WHERE id = $1 FOR NO KEY UPDATE`, [login.moduleAccountId]);
      const mine = (await q(`SELECT module_account_id FROM module_account_links WHERE ayzen_user_id = $1 AND module = $2`, [input.ayzenUserId, module])).rows[0];
      if (mine && mine.module_account_id === login.moduleAccountId) {
        await audit(q, module, login.moduleAccountId, "link", "success", input.client, { alreadyLinked: true });
        return { ok: true as const, alreadyLinked: true };
      }
      if (mine) return { refused: "ALREADY_HAS_MODULE_ACCOUNT" as const, detail: { reason: "identity_linked_elsewhere" } };
      const own = (await q(`SELECT id FROM module_accounts WHERE user_id = $1 AND module = $2`, [input.ayzenUserId, module])).rows[0];
      if (own && own.id !== login.moduleAccountId) return { refused: "ALREADY_HAS_MODULE_ACCOUNT" as const, detail: { reason: "identity_owns_account" } };
      const others = (await q(
        `SELECT 1 FROM module_account_links WHERE module_account_id = $1 AND ayzen_user_id <> $2 AND method <> 'backing'`,
        [login.moduleAccountId, input.ayzenUserId],
      )).rows;
      if (others.length > 0) return { refused: "ACCOUNT_ALREADY_LINKED" as const, detail: { reason: "other_identity" } };
      await q(
        `INSERT INTO module_account_links (module_account_id, module, ayzen_user_id, method) VALUES ($1, $2, $3, 'explicit')`,
        [login.moduleAccountId, module, input.ayzenUserId],
      );
      await audit(q, module, login.moduleAccountId, "link", "success", input.client, { alreadyLinked: false });
      return { ok: true as const, alreadyLinked: false };
    });
  } catch (e) {
    // A racing link by another request lost against a unique index: report it as a conflict, never a 500.
    if ((e as { code?: string })?.code === "23505") outcome = { refused: "ACCOUNT_ALREADY_LINKED", detail: { reason: "race" } };
    else throw e;
  }
  if ("refused" in outcome) return refuseAfter(outcome);
  return { ...login, ok: true as const, alreadyLinked: outcome.alreadyLinked };
}

// ─── Logout ──────────────────────────────────────────────────────────────────

/** Revokes one module session. Scoped by module so a token can only end sessions of its own module. */
export async function logoutModuleSession(db: AuthDb, input: { jti: string; module: ModuleId; client: ClientInfo | null }): Promise<boolean> {
  const r = await db.query(
    `UPDATE user_sessions SET revoked_at = NOW() WHERE jti = $1 AND module = $2 AND revoked_at IS NULL RETURNING module_account_id`,
    [input.jti, input.module],
  );
  if (r.rows.length === 0) return false;
  await audit(db.query, input.module, r.rows[0].module_account_id, "logout", "success", input.client).catch(() => {});
  return true;
}

// ─── Password reset ──────────────────────────────────────────────────────────

/**
 * Starts a reset. Returns the one-time token (to be emailed to `to`) or null when there is nothing to send — the
 * caller answers 202 either way, so the response never reveals whether the identifier has an account.
 */
export async function requestPasswordReset(
  db: AuthDb,
  input: { module: unknown; identifier: unknown; client: Pick<ClientInfo, "ip" | "userAgent"> },
): Promise<{ token: string; to: string; moduleAccountId: number } | null> {
  if (!isKnownModuleId(input.module)) return null;
  const module = input.module;
  const identifier = normalizeIdentifier(input.identifier);
  if (!identifier) return null;
  return db.transaction(async (q) => {
    const r = await q(
      `SELECT c.module_account_id, c.identifier FROM module_credentials c JOIN module_accounts a ON a.id = c.module_account_id
        WHERE c.module = $1 AND c.identifier_norm = $2 AND a.status = 'active' FOR UPDATE OF c`,
      [module, identifier],
    );
    const c = r.rows[0];
    if (!c) return null;
    const recent = await q(
      `SELECT count(*)::int AS n FROM module_password_resets WHERE module_account_id = $1 AND created_at > NOW() - INTERVAL '1 hour'`,
      [c.module_account_id],
    );
    if (recent.rows[0].n >= RESET_MAX_PER_HOUR) return null;
    await q(`UPDATE module_password_resets SET used_at = NOW() WHERE module_account_id = $1 AND used_at IS NULL`, [c.module_account_id]);
    const { token, tokenHash } = newResetToken();
    await q(
      `INSERT INTO module_password_resets (module_account_id, module, token_hash, expires_at, requested_ip)
       VALUES ($1, $2, $3, NOW() + make_interval(mins => $4::int), $5)`,
      [c.module_account_id, module, tokenHash, RESET_TOKEN_TTL_MINUTES, input.client.ip],
    );
    await audit(q, module, c.module_account_id, "password_reset_requested", "success", input.client);
    return { token, to: c.identifier as string, moduleAccountId: c.module_account_id as number };
  });
}

export async function completePasswordReset(
  db: AuthDb,
  input: { module: unknown; token: unknown; newPassword: unknown; client: Pick<ClientInfo, "ip" | "userAgent"> },
): Promise<{ ok: true; moduleAccountId: number } | Fail> {
  if (!isKnownModuleId(input.module)) return { ok: false, code: "INVALID_MODULE" };
  const module = input.module;
  if (typeof input.token !== "string" || input.token.length < 20 || input.token.length > 200) return { ok: false, code: "INVALID_TOKEN" };
  const tokenHash = hashResetToken(input.token);

  const found = await db.query(
    `SELECT r.id AS reset_id, r.module_account_id, c.identifier_norm
       FROM module_password_resets r JOIN module_credentials c ON c.module_account_id = r.module_account_id
      WHERE r.token_hash = $1 AND r.module = $2 AND r.used_at IS NULL AND r.expires_at > NOW()`,
    [tokenHash, module],
  );
  const row = found.rows[0];
  if (!row) return { ok: false, code: "INVALID_TOKEN" };

  // Policy BEFORE the claim, so a too-weak password does not burn the token.
  const policy = checkPasswordPolicy(input.newPassword, row.identifier_norm);
  if (!policy.ok) return { ok: false, code: policy.code };
  const newHash = await hashModulePassword(input.newPassword as string);

  return db.transaction(async (q) => {
    // Atomic single-use claim: of two concurrent submissions of one token, exactly one gets a row back.
    const claim = await q(
      `UPDATE module_password_resets SET used_at = NOW() WHERE id = $1 AND used_at IS NULL AND expires_at > NOW() RETURNING id`,
      [row.reset_id],
    );
    if (claim.rows.length === 0) return { ok: false, code: "INVALID_TOKEN" } as Fail;
    await q(
      // Owning the mailbox the token was sent to is proof of the identifier, so this also verifies it.
      `UPDATE module_credentials SET password_hash = $2, password_updated_at = NOW(), failed_attempts = 0, locked_until = NULL,
              identifier_verified_at = COALESCE(identifier_verified_at, NOW()), updated_at = NOW()
        WHERE module_account_id = $1`,
      [row.module_account_id, newHash],
    );
    await q(`UPDATE user_sessions SET revoked_at = NOW() WHERE module_account_id = $1 AND revoked_at IS NULL`, [row.module_account_id]);
    await audit(q, module, row.module_account_id, "password_reset_completed", "success", input.client);
    return { ok: true, moduleAccountId: row.module_account_id as number } as const;
  });
}

// ─── Session validation (called on every request that carries a module token) ───────────────────

export type ModuleSessionCheck =
  | { ok: true; userId: number; moduleUid: string }
  | { ok: false; reason: "unknown_session" | "revoked_or_expired" | "mismatch" | "account_not_active" };

/**
 * A module session MUST have a user_sessions row (unlike a pre-feature shared token, which may have none): the
 * claims `mod`/`mac` are checked against that row and the account, so a token cannot outlive a revoke, a
 * suspension or a reset, and cannot be replayed against a different account.
 */
export async function checkModuleSession(
  q: Query,
  input: { sid: string; module: ModuleId; moduleAccountId: number; userId: number },
): Promise<ModuleSessionCheck> {
  const r = await q(
    `SELECT s.user_id, s.module, s.module_account_id, (s.revoked_at IS NOT NULL OR s.expires_at <= NOW()) AS dead,
            a.status, a.module_uid
       FROM user_sessions s JOIN module_accounts a ON a.id = s.module_account_id WHERE s.jti = $1`,
    [input.sid],
  );
  const s = r.rows[0];
  if (!s) return { ok: false, reason: "unknown_session" };
  if (s.dead) return { ok: false, reason: "revoked_or_expired" };
  if (s.module !== input.module || s.module_account_id !== input.moduleAccountId || s.user_id !== input.userId) return { ok: false, reason: "mismatch" };
  if (s.status !== "active") return { ok: false, reason: "account_not_active" };
  return { ok: true, userId: s.user_id, moduleUid: s.module_uid };
}

/** The signed-in module account, for GET /auth/module/me. */
export async function describeModuleAccount(q: Query, moduleAccountId: number) {
  const r = await q(
    `SELECT a.module, a.module_uid, a.status, a.created_at, c.identifier, c.identifier_verified_at, l.method AS link_method
       FROM module_accounts a
       LEFT JOIN module_credentials c ON c.module_account_id = a.id
       LEFT JOIN module_account_links l ON l.module_account_id = a.id AND l.ayzen_user_id = a.user_id
      WHERE a.id = $1`,
    [moduleAccountId],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    module: row.module as ModuleId,
    label: getModule(row.module)?.label ?? row.module,
    moduleUid: row.module_uid as string,
    status: row.status as string,
    identifier: (row.identifier as string | null) ?? null,
    identifierVerified: !!row.identifier_verified_at,
    hasPassword: row.identifier !== null,
    link: (row.link_method as string | null) ?? null,
    createdAt: row.created_at as Date,
  };
}
