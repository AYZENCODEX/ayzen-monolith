/**
 * projects/domain/bulk-enroll-plan.ts
 * PRJ-ISSUE-4: bulk enroll must treat an entity that already has an enrollment row exactly as single enroll does
 * (decideEnrollment), instead of inserting a duplicate row that is then charged again. Pure: no database, no HTTP.
 */
import { decideEnrollment } from "./enrollment-status";

export interface ExistingEnrollment { id: number; vaultEntryId: number; status: string }
export type BulkSkipReason = "already_active" | "banned";

export interface BulkEnrollPlan {
  /** Entities with no enrollment row: insert a new row. */
  create: number[];
  /** Entities with a cancelled/disqualified row: reactivate that row (history kept), like single enroll. */
  reactivate: { entityId: number; enrollmentId: number; from: string }[];
  /** Entities left alone; never charged. */
  skipped: { entityId: number; reason: BulkSkipReason }[];
}

export function planBulkEnroll(entityIds: Iterable<number>, existing: ExistingEnrollment[]): BulkEnrollPlan {
  const byEntity = new Map<number, ExistingEnrollment>();
  for (const e of existing) {
    // Several rows can exist for one entity (the duplicates this fixes): a banned or active row decides first.
    const prev = byEntity.get(e.vaultEntryId);
    const rank = (s: string) => (s === "banned" ? 0 : s === "active" ? 1 : 2);
    if (!prev || rank(e.status) < rank(prev.status)) byEntity.set(e.vaultEntryId, e);
  }
  const plan: BulkEnrollPlan = { create: [], reactivate: [], skipped: [] };
  for (const entityId of new Set(entityIds)) {
    const row = byEntity.get(entityId);
    const decision = decideEnrollment(row);
    if (decision.kind === "create") plan.create.push(entityId);
    else if (decision.kind === "banned") plan.skipped.push({ entityId, reason: "banned" });
    else if (decision.kind === "already_active") plan.skipped.push({ entityId, reason: "already_active" });
    else plan.reactivate.push({ entityId, enrollmentId: row!.id, from: decision.from });
  }
  return plan;
}

/** Number of enrollment rows the plan will write, i.e. the quantity to check and charge. */
export const payableCount = (plan: BulkEnrollPlan): number => plan.create.length + plan.reactivate.length;
