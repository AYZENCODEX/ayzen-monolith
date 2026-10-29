import { chargeCredits } from "../../../services/credit-meter";
import { decryptSeedPhrase } from "../../crypto/seed-phrase";
import { logVaultActivityStrict } from "../entity";
import { selectVaultOne } from "../../infrastructure/repositories/entity-repository";
import { selectOrgSeedRevealBlock } from "../../infrastructure/repositories/secret-repository";

/**
 * Seed-phrase reveal use-case (VLT-GAP-05-B). Body moved unchanged from
 * GET /vault/:id/seed in routes/vault.ts: same gate order (org extension policy →
 * entity-PIN reveal token → entry lookup → seed presence → decrypt), same status codes and
 * bodies, same best-effort audit entry, same charge-on-success credit semantics.
 * The reveal-token store (routes/vault-security, owned by GAP-06) is injected as a port because the
 * application layer must not import the API layer.
 */

/** A re-reveal of the same seed within this window is a retry of the same charge, not a new reveal. */
export const REVEAL_RETRY_WINDOW_MS = 5 * 60 * 1000;

export interface SecretResult { status: number; body: unknown }
export interface SecretRevealDeps {
  hasNoEntityPin: (userId: number) => Promise<boolean>;
  consumeRevealToken: (userId: number, token: string | undefined | null) => boolean;
}

export async function revealSeedPhrase(
  userId: number,
  idParam: string | string[],
  headerToken: string | undefined,
  queryToken: unknown,
  deps: SecretRevealDeps,
): Promise<SecretResult> {
  const id = parseInt(Array.isArray(idParam) ? idParam[0] : idParam, 10);

  // Phase 8 — managed extension policy (master plan §2/§9). An org
  // owner/admin can set organization_extension_policies.disable_seed_reveal
  // to block this endpoint for every ACTIVE member of that org, regardless
  // of which entity they're revealing — enforced server-side (not
  // just an Astra UI toggle) since this is the actual seed-reveal
  // choke point every other read/autofill path already goes through. Any
  // one org membership with the flag set is enough to block; a user who
  // wants seed reveal back has to leave that org or ask an admin to relax
  // the policy, not bypass it entity-by-entity.
  const orgBlock = await selectOrgSeedRevealBlock(userId);
  if (orgBlock.length) {
    return {
      status: 403,
      body: {
        error: "Seed phrase reveal is disabled by your organization's extension policy",
        code: "ORG_SEED_REVEAL_DISABLED",
      },
    };
  }

  const pinless = await deps.hasNoEntityPin(userId);
  if (!pinless) {
    const token = (headerToken ?? queryToken) as string | undefined;
    if (!deps.consumeRevealToken(userId, token)) {
      return {
        status: 403,
        body: {
          error: "Reveal token missing or expired",
          code: "REVEAL_TOKEN_REQUIRED",
          solution: "Verify your entity PIN again — the reveal token is single-use and expires quickly.",
        },
      };
    }
  }

  const entry = await selectVaultOne(id, userId);
  if (!entry) return { status: 404, body: { error: "Vault entry not found" } };
  const encSeed = entry.encrypted_seed_phrase ?? entry.encryptedSeedPhrase ?? null;
  if (!encSeed) return { status: 404, body: { error: "No seed phrase stored for this entity" } };
  const plaintext = decryptSeedPhrase(encSeed as string);
  if (!plaintext) return { status: 500, body: { error: "Failed to decrypt seed phrase" } };
  // VLT-GAP-19: the reveal audit is fail-closed. It used to be fire-and-forget, so a transient failure of that one insert delivered the
  // seed phrase with no audit row. Now the row must be written BEFORE the plaintext is returned (and before any credit is charged);
  // if it cannot be, the reveal is refused and the user retries with a fresh token.
  try {
    await logVaultActivityStrict(id, userId, "seed_revealed");
  } catch {
    return { status: 503, body: { error: "Seed reveal is temporarily unavailable because the audit trail could not be written — nothing was revealed or charged", code: "REVEAL_AUDIT_UNAVAILABLE" } };
  }
  // Charge-on-success: only after the seed was actually decrypted and is
  // about to be returned — a missing seed / decrypt failure above never
  // costs the user credits.
  // VLT-GAP-19: charged once per (user, entity) per window. If the response is lost after the charge (connection drop, worker killed)
  // the user re-verifies the PIN and reveals again; that retry finds the ledger row and is not charged a second time.
  const charge = await chargeCredits(userId, "sylo.credential_access", { referenceId: `seed:${id}`, dedupeWithinMs: REVEAL_RETRY_WINDOW_MS });
  return { status: 200, body: { seedPhrase: plaintext, _credits: charge.ok ? { charged: charge.charged, newBalance: charge.newBalance } : null } };
}
