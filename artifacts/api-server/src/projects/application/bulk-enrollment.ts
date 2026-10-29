/**
 * projects/application/bulk-enrollment.ts
 * Bulk enroll use case (PRJ-08 start, fixes PRJ-ISSUE-4). The route keeps HTTP validation and the resolution of
 * the caller's owned vault entities; this decides what to write, writes it and bills it.
 *
 * Rules (same as single enroll): an entity with an active row is skipped, a banned entity is skipped, a cancelled or
 * disqualified row is reactivated (history kept), an entity with no row gets a new row. Credits (PRJ-07) are checked
 * for the rows that will actually be written, before any write, and charged for the rows actually written.
 * No schema change: without a unique constraint a concurrent identical request can still race (recorded risk).
 */
import { logSubjectActivity } from "../../lib/activity-log";
import { serializeAccountData } from "../domain/enrollment-status";
import { payableCount, planBulkEnroll, type BulkSkipReason } from "../domain/bulk-enroll-plan";
import { insertEnrollment, listEnrollmentsForEntities, updateEnrollment } from "../infrastructure/repositories/enrollments-repo";
import { checkEnrollCredits, chargeEnrollCredits, type EnrollCreditCheck } from "./enrollment-billing";

export type BulkEnrollResult =
  | { ok: false; status: 402; body: Extract<EnrollCreditCheck, { ok: false }>["body"] }
  | { ok: true; body: { ok: true; enrolled: number; created: number; reactivated: number; skipped: { entityId: number; reason: BulkSkipReason | "error" }[]; _credits: unknown } };

export async function bulkEnroll(input: {
  userId: number; projectId: number; entityIds: Iterable<number>; accountData?: unknown; dataEntityId?: number | null;
}): Promise<BulkEnrollResult> {
  const { userId, projectId } = input;
  const ids = [...new Set(input.entityIds)];
  const existing = await listEnrollmentsForEntities(projectId, userId, ids);
  const plan = planBulkEnroll(ids, existing);

  const credits = await checkEnrollCredits(userId, payableCount(plan));
  if (!credits.ok) return { ok: false, status: 402, body: credits.body };

  const dataEntityId = input.dataEntityId ?? null;
  const skipped: { entityId: number; reason: BulkSkipReason | "error" }[] = [...plan.skipped];
  let created = 0;
  let reactivated = 0;

  for (const entityId of plan.create) {
    try {
      const row = await insertEnrollment({
        userId, projectId, vaultEntryId: entityId, status: "active",
        accountData: serializeAccountData(input.accountData, null), kycEntryId: null, dataEntityId,
      });
      logSubjectActivity("project_enrollment", row.id, "enrolled", { actorUserId: userId, meta: { projectId, vaultEntryId: entityId } });
      created++;
    } catch { skipped.push({ entityId, reason: "error" }); }
  }

  for (const r of plan.reactivate) {
    try {
      const row = await updateEnrollment(r.enrollmentId, {
        status: "active",
        accountData: serializeAccountData(input.accountData, null) ?? undefined,
        ...(dataEntityId ? { dataEntityId } : {}),
      });
      logSubjectActivity("project_enrollment", row.id, "enrolled", { actorUserId: userId, meta: { projectId, vaultEntryId: r.entityId, reactivatedFrom: r.from } });
      reactivated++;
    } catch { skipped.push({ entityId: r.entityId, reason: "error" }); }
  }

  const charge = await chargeEnrollCredits(userId, created + reactivated);
  return { ok: true, body: { ok: true, enrolled: created + reactivated, created, reactivated, skipped, _credits: charge } };
}
