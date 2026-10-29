/**
 * projects/application/enrollment.ts
 * Enrollment use cases (PRJ-05). Moved unchanged from routes/projects.ts. The route keeps the HTTP concerns: id
 * parsing, the PEP gates, the credit-balance check, and response mapping. Rules live in
 * domain/enrollment-status.ts; queries in infrastructure/repositories/enrollments-repo.ts.
 *
 * Cross-module dependencies, all pinned by the boundary manifest: Vault's KYC enrollment helpers (contract
 * VAULT-PUBLIC-1) and KYC ownership resource (VAULT-PUBLIC-2). KYC logic is NOT re-implemented here.
 *
 * Credits are charged after a successful write on either branch (reactivation or fresh enrollment); every
 * validation failure returns before the ledger is touched.
 */
import { loadKycEntryForEnrollment, buildEnrollmentAccountData } from "../../vault/application/kyc/enrollment";
import { kycEntryOwnerResource } from "../../vault/security/kyc-ownership";
import { chargeCredits } from "../../services/credit-meter";
import { ENROLL_CREDIT_ACTION } from "./enrollment-billing";
import { logSubjectActivity, getSubjectActivitySummary } from "../../lib/activity-log";
import {
  decideEnrollment,
  formatEnrollment,
  MODERATION_STATUS_ERROR,
  moderationLogAction,
  serializeAccountData,
} from "../domain/enrollment-status";
import { formatAdminEnrollmentEntity, formatEnrollmentEntity } from "../domain/enrollment-overview";
import {
  deleteOwnEnrollment,
  findActiveEnrollmentByKyc,
  findEnrollmentById,
  findEnrollmentForEntity,
  findOwnEnrollment,
  findUserProjectLinks,
  insertEnrollment,
  insertUserProject,
  listAdminEntityEnrollments,
  listUserEnrollmentsWithVault,
  updateEnrollment,
} from "../infrastructure/repositories/enrollments-repo";
import { findUserVaultEntry } from "../infrastructure/repositories/vault-entries-reader";

export async function joinProject(userId: number, projectId: number): Promise<void> {
  const existing = await findUserProjectLinks(userId, projectId);
  if (existing.length === 0) await insertUserProject(userId, projectId);
}

export type EnrollResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: 400 | 403 | 404 | 409; error: string };

/** Audit-only hook the adapter binds to the request: (action, resource) => audit decision, result discarded. */
export type EnrollAudit = (action: string, resource: Awaited<ReturnType<typeof kycEntryOwnerResource>>) => Promise<void>;

export async function enrollEntity(input: { projectId: number; userId: number; body: any; audit: EnrollAudit }): Promise<EnrollResult> {
  const { projectId, userId, audit } = input;
  const { vaultEntryId, kycEntryId, dataEntityId } = input.body as {
    vaultEntryId: number; kycEntryId?: number; dataEntityId?: number;
  };
  let { accountData } = input.body as { accountData?: Record<string, unknown> };
  if (!vaultEntryId) return { ok: false, status: 400, error: "vaultEntryId is required" };

  const vaultEntry = await findUserVaultEntry(vaultEntryId, userId);
  if (!vaultEntry) return { ok: false, status: 404, error: "Vault entity not found" };

  // Exchange enroll-by-KYC-entity shortcut: verify the KYC entity belongs to this user and is not already spent on
  // another active enrollment, then auto-build account_data from its own fields.
  if (kycEntryId) {
    const kycRow = await loadKycEntryForEnrollment(userId, kycEntryId);
    if (!kycRow) return { ok: false, status: 404, error: "KYC entity not found" };
    // Audit-only (D7): the check above already decided the 404; re-reads kycEntryId's real owner unfiltered.
    await audit("project.enroll.kyc_entry", await kycEntryOwnerResource(kycEntryId));
    const inUse = await findActiveEnrollmentByKyc(kycEntryId);
    if (inUse && inUse.vaultEntryId !== vaultEntryId) {
      return { ok: false, status: 409, error: "This KYC entity is already enrolled elsewhere" };
    }
    accountData = buildEnrollmentAccountData(kycRow);
  }

  const existing = await findEnrollmentForEntity(projectId, userId, vaultEntryId);
  const decision = decideEnrollment(existing);
  if (decision.kind === "banned") return { ok: false, status: 403, error: "This entity is banned from this project" };
  if (decision.kind === "already_active") return { ok: false, status: 409, error: "Entity already enrolled in this project" };

  if (decision.kind === "reactivate" && existing) {
    // "disqualified"/"cancelled" reactivate the same row, keeping its history, rather than inserting a duplicate.
    const reactivated = await updateEnrollment(existing.id, {
      status: "active",
      accountData: serializeAccountData(accountData, existing.accountData),
      kycEntryId: kycEntryId ?? existing.kycEntryId,
      dataEntityId: dataEntityId ?? existing.dataEntityId,
    });
    logSubjectActivity("project_enrollment", reactivated.id, "enrolled", {
      actorUserId: userId, meta: { projectId, vaultEntryId, reactivatedFrom: existing.status },
    });
    const reactivateCharge = await chargeCredits(userId, ENROLL_CREDIT_ACTION);
    return {
      ok: true,
      body: {
        ...formatEnrollment(reactivated),
        _credits: reactivateCharge.ok ? { charged: reactivateCharge.charged, newBalance: reactivateCharge.newBalance } : null,
      },
    };
  }

  const enrollment = await insertEnrollment({
    userId, projectId, vaultEntryId, status: "active",
    accountData: serializeAccountData(accountData, null),
    kycEntryId: kycEntryId ?? null,
    dataEntityId: dataEntityId ?? null,
  });

  const alreadyJoined = await findUserProjectLinks(userId, projectId);
  if (alreadyJoined.length === 0) await insertUserProject(userId, projectId);

  // Activity log: record the enrollment start so cumulative days-active can be computed from the log later.
  logSubjectActivity("project_enrollment", enrollment.id, "enrolled", {
    actorUserId: userId, meta: { projectId, vaultEntryId },
  });

  const charge = await chargeCredits(userId, ENROLL_CREDIT_ACTION);
  return {
    ok: true,
    body: {
      ...formatEnrollment(enrollment),
      _credits: charge.ok ? { charged: charge.charged, newBalance: charge.newBalance } : null,
    },
  };
}

export type ChangeStatusResult =
  | { ok: true; body: ReturnType<typeof formatEnrollment> }
  | { ok: false; status: 400 | 404; error: string };

/** Admin/moderator moderation: keeps the row and its history, changes only `status`, logs who/when/why. */
export async function changeEnrollmentStatus(input: {
  enrollmentId: number; status: string; reason?: string; actorUserId: number;
}): Promise<ChangeStatusResult> {
  const logAction = moderationLogAction(input.status);
  if (!logAction) return { ok: false, status: 400, error: MODERATION_STATUS_ERROR };

  const existing = await findEnrollmentById(input.enrollmentId);
  if (!existing) return { ok: false, status: 404, error: "Enrollment not found" };

  const updated = await updateEnrollment(input.enrollmentId, { status: input.status });

  logSubjectActivity("project_enrollment", input.enrollmentId, logAction, {
    actorUserId: input.actorUserId,
    meta: { projectId: existing.projectId, vaultEntryId: existing.vaultEntryId, reason: input.reason ?? null },
  });

  return { ok: true, body: formatEnrollment(updated) };
}

/** Every entity enrollment for a project across ALL users (admin moderation view). */
export async function listAdminEnrollments(projectId: number) {
  const rows = await listAdminEntityEnrollments(projectId);
  return rows.map(({ enrollment, vault, ownerUsername }) => ({
    ...formatEnrollment(enrollment),
    ownerUsername: ownerUsername ?? null,
    entity: formatAdminEnrollmentEntity(vault),
  }));
}

/** The caller's own entity enrollments for a project. */
export async function listMyEnrollments(projectId: number, userId: number) {
  const enrollments = await listUserEnrollmentsWithVault(projectId, userId);
  return enrollments.map(({ enrollment, vault }) => ({
    ...formatEnrollment(enrollment),
    entity: formatEnrollmentEntity(vault),
  }));
}

/** Voluntary unenroll: logs "left" with a snapshot BEFORE the row is deleted, since the log must outlive it. */
export async function leaveEnrollment(enrollmentId: number, userId: number): Promise<void> {
  const existing = await findOwnEnrollment(enrollmentId, userId);
  if (existing) {
    logSubjectActivity("project_enrollment", enrollmentId, "left", {
      actorUserId: userId, meta: { projectId: existing.projectId, vaultEntryId: existing.vaultEntryId },
    });
  }
  await deleteOwnEnrollment(enrollmentId, userId);
}

export async function ownEnrollmentExists(enrollmentId: number, userId: number): Promise<boolean> {
  return Boolean(await findOwnEnrollment(enrollmentId, userId));
}

/** Totals are always derived from the activity log at read time, never stored. */
export function getEnrollmentActivitySummary(enrollmentId: number) {
  return getSubjectActivitySummary("project_enrollment", enrollmentId);
}
