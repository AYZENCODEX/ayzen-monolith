import { logSubjectActivity } from "../../../lib/activity-log";
import { executeVaultEntriesForLogVaultActivity, insertVaultActivityLogForLogVaultActivity } from "../../infrastructure/repositories/vault-activity-repository";

/** Entity activity audit. Extracted verbatim from routes/vault.ts (VLT-GAP-01-B). */

/**
 * VLT-GAP-19: fail-closed audit write for security-critical actions (seed reveal). Unlike logVaultActivity() below, a failed insert
 * THROWS, so the caller can refuse the action instead of performing it unaudited.
 */
export async function logVaultActivityStrict(vaultEntryId: number, userId: number, action: string, detail?: string): Promise<void> {
  await insertVaultActivityLogForLogVaultActivity(vaultEntryId, userId, action, detail);
}

// Best-effort audit log — never blocks or fails the calling request.
export async function logVaultActivity(vaultEntryId: number, userId: number, action: string, detail?: string): Promise<void> {
  try {
    await insertVaultActivityLogForLogVaultActivity(vaultEntryId, userId, action, detail);
  } catch (err) {
    console.error("vault activity log failed:", err);
  }
  // Phase 15B — if this entry belongs to a team, mirror the same event into
  // the shared activity_log (subject_type="team") so the team's Other →
  // Activity Log sub-view sees vault-usage entries without reading a second
  // logging system. Best-effort and non-blocking, same as the write above.
  try {
    const teamRow = await executeVaultEntriesForLogVaultActivity(vaultEntryId);
    const teamId = (teamRow.rows[0] as any)?.team_id;
    if (teamId) {
      await logSubjectActivity("team", Number(teamId), "vault_used", {
        actorUserId: userId,
        meta: { vaultEntryId, vaultAction: action, detail: detail ?? null },
      });
    }
  } catch {
    // best-effort — never block the caller
  }
}
