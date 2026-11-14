/**
 * lib/module-clerk-service.ts — W1-P5: module accounts for people who sign in with Clerk social providers (Google / Facebook / GitHub).
 *
 * The caller has ALREADY proven the Clerk identity (route: lib/clerk-verify.ts against the module's own Clerk application; webhook:
 * Svix signature with the module's own secret). This file only maps `(module, Clerk user id)` to a module account:
 *   - clerkSignIn:        existing identity -> its account's session; unknown identity -> create backing user + account +
 *                         backing link + identity row, then a session. Never links by email (see EMAIL_ACCOUNT_EXISTS).
 *   - clerkUserCreated:   webhook user.created -> the same account creation, no session. Idempotent with clerkSignIn.
 *   - clerkUserDeleted:   webhook user.deleted -> identity row removed, account closed, its sessions revoked. Data is kept.
 * The Clerk user id is only ever looked up together with the module, so the same id string in two modules is two unrelated rows.
 */
import { randomBytes } from "node:crypto";
import { isKnownModuleId } from "./module-session-policy";
import type { ModuleId } from "@ayzen/module-registry";
import { audit, insertSession, type AuthDb, type ClientInfo, type Fail, type IssuedModuleSession } from "./module-auth-service";

type Query = AuthDb["query"];
const isUnique = (e: unknown) => (e as any)?.code === "23505";
const CLERK_ID = /^user_[A-Za-z0-9]{8,64}$/;

interface Profile { email?: string | null; emailVerified?: boolean }

/** Creates the backing user + module account + backing link + identity row. Caller holds the transaction. */
async function createAccount(q: Query, module: ModuleId, clerkUserId: string, profile: Profile) {
  const tag = randomBytes(12).toString("hex");
  // Same non-deliverable, un-loginable backing row as a password signup (lib/module-auth-service.ts signupWithPassword).
  const u = await q(
    `INSERT INTO users (username, email, password_hash, role, status, email_verified) VALUES ($1, $2, '', 'user', 'active', FALSE) RETURNING id`,
    [`m_${module}_${tag}`, `m-${module}-${tag}@module-accounts.invalid`],
  );
  const userId: number = u.rows[0].id;
  const acct = (await q(`SELECT id, module_uid FROM ayzen_provision_module_account($1::int, $2, 'signup')`, [userId, module])).rows[0];
  await q(`INSERT INTO module_account_links (module_account_id, module, ayzen_user_id, method) VALUES ($1, $2, $3, 'backing')`, [acct.id, module, userId]);
  await q(
    `INSERT INTO module_external_identities (module_account_id, module, provider, external_id, email, email_verified) VALUES ($1, $2, 'clerk', $3, $4, $5)`,
    [acct.id, module, clerkUserId, profile.email?.slice(0, 320) ?? null, profile.emailVerified === true],
  );
  return { userId, accountId: acct.id as number, moduleUid: acct.module_uid as string };
}

const findIdentity = (q: Query, module: ModuleId, clerkUserId: string) => q(
  `SELECT i.module_account_id, a.user_id, a.status, a.module_uid, u.status AS user_status
     FROM module_external_identities i
     JOIN module_accounts a ON a.id = i.module_account_id
     JOIN users u ON u.id = a.user_id
    WHERE i.module = $1 AND i.provider = 'clerk' AND i.external_id = $2`,
  [module, clerkUserId],
);

export async function clerkSignIn(
  db: AuthDb,
  input: { module: unknown; clerkUserId: unknown; email?: string | null; emailVerified?: boolean; client: ClientInfo },
): Promise<({ ok: true; created: boolean } & IssuedModuleSession) | Fail> {
  if (!isKnownModuleId(input.module)) return { ok: false, code: "INVALID_MODULE" };
  if (typeof input.clerkUserId !== "string" || !CLERK_ID.test(input.clerkUserId)) return { ok: false, code: "INVALID_TOKEN" };
  const module = input.module, clerkUserId = input.clerkUserId;

  const attempt = (): Promise<({ ok: true; created: boolean } & IssuedModuleSession) | Fail> => db.transaction(async (q) => {
    const found = (await findIdentity(q, module, clerkUserId)).rows[0];
    if (found) {
      if (found.status !== "active" || found.user_status === "banned" || found.user_status === "suspended") {
        await audit(q, module, found.module_account_id, "clerk_login", "failure", input.client, { status: found.status, userStatus: found.user_status });
        return { ok: false, code: "ACCOUNT_NOT_ACTIVE" } as Fail;
      }
      await q(`UPDATE module_external_identities SET last_login_at = NOW(), email = COALESCE($3, email), email_verified = email_verified OR $4
                WHERE module = $1 AND provider = 'clerk' AND external_id = $2`, [module, clerkUserId, input.email?.slice(0, 320) ?? null, input.emailVerified === true]);
      const session = await insertSession(q, { userId: found.user_id, moduleAccountId: found.module_account_id, module, moduleUid: found.module_uid }, input.client);
      await audit(q, module, found.module_account_id, "clerk_login", "success", input.client, { created: false });
      return { ok: true, created: false, ...session } as const;
    }
    // New identity. A verified email that already belongs to a password account in THIS module is refused rather than merged:
    // silently attaching a social login to an existing account is an account-takeover path if either side's email is not what it seems.
    const email = input.email?.trim().toLowerCase();
    if (email && input.emailVerified === true) {
      const clash = await q(`SELECT module_account_id FROM module_credentials WHERE module = $1 AND identifier_norm = $2`, [module, email]);
      if (clash.rows.length > 0) {
        await audit(q, module, clash.rows[0].module_account_id, "clerk_login", "failure", input.client, { reason: "email_account_exists" });
        return { ok: false, code: "EMAIL_ACCOUNT_EXISTS" } as Fail;
      }
    }
    const a = await createAccount(q, module, clerkUserId, { email: input.email, emailVerified: input.emailVerified });
    const session = await insertSession(q, { userId: a.userId, moduleAccountId: a.accountId, module, moduleUid: a.moduleUid }, input.client);
    await audit(q, module, a.accountId, "clerk_login", "success", input.client, { created: true });
    return { ok: true, created: true, ...session } as const;
  });

  try { return await attempt(); }
  catch (e) {
    // Two first sign-ins of the same Clerk user racing: the unique index picked a winner; the loser now simply finds it.
    if (isUnique(e)) return attempt();
    throw e;
  }
}

/** Webhook user.created: idempotent; `created` is false when the identity already existed (e.g. the person signed in first). */
export async function clerkUserCreated(
  db: AuthDb, input: { module: unknown; clerkUserId: unknown; email?: string | null; emailVerified?: boolean },
): Promise<{ ok: true; created: boolean } | Fail> {
  if (!isKnownModuleId(input.module)) return { ok: false, code: "INVALID_MODULE" };
  if (typeof input.clerkUserId !== "string" || !CLERK_ID.test(input.clerkUserId)) return { ok: false, code: "INVALID_TOKEN" };
  const module = input.module, clerkUserId = input.clerkUserId;
  const attempt = () => db.transaction(async (q) => {
    if ((await findIdentity(q, module, clerkUserId)).rows[0]) return { ok: true, created: false } as const;
    const a = await createAccount(q, module, clerkUserId, { email: input.email, emailVerified: input.emailVerified });
    await audit(q, module, a.accountId, "clerk_user_created", "success", null, {});
    return { ok: true, created: true } as const;
  });
  try { return await attempt(); } catch (e) { if (isUnique(e)) return attempt(); throw e; }
}

/** Webhook user.deleted: the identity is gone for good, so the account is closed and every session of it revoked. Rows and data stay. */
export async function clerkUserDeleted(
  db: AuthDb, input: { module: unknown; clerkUserId: unknown },
): Promise<{ ok: true; closed: boolean; sessionsRevoked: number } | Fail> {
  if (!isKnownModuleId(input.module)) return { ok: false, code: "INVALID_MODULE" };
  if (typeof input.clerkUserId !== "string" || !CLERK_ID.test(input.clerkUserId)) return { ok: false, code: "INVALID_TOKEN" };
  const module = input.module, clerkUserId = input.clerkUserId;
  return db.transaction(async (q) => {
    const row = (await q(
      `DELETE FROM module_external_identities WHERE module = $1 AND provider = 'clerk' AND external_id = $2 RETURNING module_account_id`,
      [module, clerkUserId],
    )).rows[0];
    if (!row) return { ok: true, closed: false, sessionsRevoked: 0 } as const;
    await q(`UPDATE module_accounts SET status = 'closed', updated_at = NOW() WHERE id = $1 AND module = $2 AND status <> 'closed'`, [row.module_account_id, module]);
    const revoked = await q(`UPDATE user_sessions SET revoked_at = NOW() WHERE module_account_id = $1 AND module = $2 AND revoked_at IS NULL`, [row.module_account_id, module]);
    await audit(q, module, row.module_account_id, "clerk_user_deleted", "success", null, { sessionsRevoked: revoked.rowCount ?? 0 });
    return { ok: true, closed: true, sessionsRevoked: revoked.rowCount ?? 0 } as const;
  });
}
