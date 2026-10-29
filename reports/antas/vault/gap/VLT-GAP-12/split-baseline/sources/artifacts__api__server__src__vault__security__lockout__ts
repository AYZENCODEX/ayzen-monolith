/**
 * vault/security/lockout.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Extracted from routes/vault-security.ts (VLT-GAP-06-B). Generic brute-force
 * lockout for the Vault Security routes — in-memory, best-effort (see the
 * original file header for why this is intentionally lightweight: good
 * enough for a 4-digit PIN behind a logged-in session, on top of the global
 * API rate limiter already applied at the /api level in app.ts).
 *
 * Five independent lockout kinds share this tracker by key suffix, so a
 * mistake in one flow never locks out another:
 *   "vault" / "entity" — POST /vault/security/verify (also reused as the
 *                        currentPin check in PUT /vault/security/pin).
 *   "password"         — wrong currentPassword on PUT /vault/security/password.
 *   "vault-pin-setup"  — wrong accountPassword/emailCode on
 *                        PUT /vault/security/pin (kind="vault").
 *   "reauth"           — Vault re-auth (routes/vault-reauth.ts, VLT-GAP-06-D).
 *                        One tracker shared by every re-auth method (passkey,
 *                        Vault PIN/password + 2FA, email code + PIN), so a
 *                        lockout on one blocks the others. Same limits (5
 *                        failures → 60s) as the former private Map in that
 *                        route; this replaces that duplicate implementation.
 *
 * This is a separate tracker from vault/security/pin-guard.ts's lockout,
 * which gates the step-up requireVaultPin() check used elsewhere in Vault.
 * Behavior, limits and timing are unchanged from the original inline Map.
 */

export type PinKind = "vault" | "entity";
export type LockoutKind = PinKind | "password" | "vault-pin-setup" | "reauth";

const FAILED_ATTEMPT_LIMIT = 5;
const LOCKOUT_MS = 60_000;
const failedAttempts = new Map<string, { count: number; lockedUntil: number }>();

function attemptKey(userId: number, kind: LockoutKind): string {
  return `${userId}:${kind}`;
}

export function isLockedOut(userId: number, kind: LockoutKind): number {
  const entry = failedAttempts.get(attemptKey(userId, kind));
  if (!entry) return 0;
  const remaining = entry.lockedUntil - Date.now();
  return remaining > 0 ? remaining : 0;
}

export function recordFailure(userId: number, kind: LockoutKind): void {
  const key = attemptKey(userId, kind);
  const entry = failedAttempts.get(key) ?? { count: 0, lockedUntil: 0 };
  entry.count += 1;
  if (entry.count >= FAILED_ATTEMPT_LIMIT) {
    entry.lockedUntil = Date.now() + LOCKOUT_MS;
    entry.count = 0;
  }
  failedAttempts.set(key, entry);
}

export function clearFailures(userId: number, kind: LockoutKind): void {
  failedAttempts.delete(attemptKey(userId, kind));
}
