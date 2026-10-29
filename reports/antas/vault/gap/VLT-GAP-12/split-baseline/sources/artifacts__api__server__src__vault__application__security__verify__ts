import { verifyPassword } from "../../../lib/password";
import { isLockedOut, recordFailure, clearFailures, type PinKind } from "../../security/lockout";
import { getRow } from "../../infrastructure/repositories/vault-security-repository";
import { mintRevealToken, REVEAL_TOKEN_TTL_MS } from "../../security/reveal-token";

export interface VaultSecurityResult { status: number; body: unknown }
const PIN_REGEX = /^\d{4}$/;

/**
 * POST /vault/security/verify — check a PIN without changing anything.
 * Moved unchanged from routes/vault-security.ts (VLT-GAP-06-B).
 *
 * This also fixes a dangling `REVEAL_TOKEN_TTL_MS` reference that an earlier,
 * partial refactor (commit 2fc65e1, outside the tracked GAP-06 steps) left
 * behind when it moved mintRevealToken()/the token store to
 * vault/security/reveal-token.ts but not the TTL constant the response body
 * still reported: the route was referencing an identifier that no longer
 * existed in its scope. REVEAL_TOKEN_TTL_MS is now exported by, and imported
 * here from, that same owner — same 45_000ms value, same response field.
 *
 * A successful entity-PIN verify mints a short-lived, single-use reveal
 * token (owned by vault/security/reveal-token.ts), which GET /vault/:id/seed
 * (routes/vault.ts) requires. Without this, a leaked session cookie/token
 * alone was enough to call that route directly and get a plaintext seed
 * phrase — the PIN gate only ever lived in the frontend UI.
 */
export async function verifyPin(userId: number, kind: unknown, pin: unknown): Promise<VaultSecurityResult> {
  if (kind !== "vault" && kind !== "entity") {
    return { status: 400, body: { error: "Invalid kind", solution: "kind must be \"vault\" or \"entity\"." } };
  }

  const lockedMs = isLockedOut(userId, kind as PinKind);
  if (lockedMs > 0) {
    return { status: 429, body: { error: "Too many attempts", code: "PIN_LOCKED", solution: `Wait ${Math.ceil(lockedMs / 1000)}s before trying again.`, retryAfterMs: lockedMs } };
  }

  if (typeof pin !== "string" || !PIN_REGEX.test(pin)) {
    return { status: 400, body: { error: "Invalid PIN", solution: "PIN must be exactly 4 digits." } };
  }

  const row = await getRow(userId);
  const hash = kind === "vault" ? row?.vaultPinHash : row?.entityPinHash;

  if (!hash) {
    // Nothing set yet — nothing to verify against. Treat as valid so the
    // frontend gate (which already skips locking when unset) never dead-ends.
    return { status: 200, body: { valid: true, pinSet: false } };
  }

  const matches = await verifyPassword(pin, hash);
  if (!matches) {
    recordFailure(userId, kind as PinKind);
    return { status: 200, body: { valid: false, pinSet: true } };
  }

  clearFailures(userId, kind as PinKind);
  if (kind === "entity") {
    const revealToken = mintRevealToken(userId);
    return { status: 200, body: { valid: true, pinSet: true, revealToken, revealTokenExpiresInMs: REVEAL_TOKEN_TTL_MS } };
  }
  return { status: 200, body: { valid: true, pinSet: true } };
}
