/**
 * projects/domain/enrollment-status.ts
 * Pure enrollment rules: the moderation status vocabulary, the enroll decision for an existing
 * (project, user, entity) pair, and the public enrollment shape. No database, HTTP, or logging dependencies.
 * Moved unchanged from routes/projects.ts (PRJ-05).
 */

/** Admin/moderator status changes and the activity-log event each one writes. */
export const ENROLLMENT_MODERATION_ACTIONS: Record<string, string> = {
  disqualified: "disqualified", // stops future reward accrual, keeps history
  banned: "banned",             // disqualify + blocks re-enrollment
  cancelled: "cancelled",       // voluntary/admin removal, no stigma, can re-enroll
  active: "enrolled",           // admin restoring a previously moderated enrollment
};

export const MODERATION_STATUS_ERROR = "status must be one of: disqualified, banned, cancelled, active";

/** Activity-log action for a moderation status, or undefined when the status is not allowed. */
export function moderationLogAction(status: unknown): string | undefined {
  // Own-property check on a string: inherited keys (toString, constructor, ...) and non-strings are rejected.
  // Before PRJ-06 this indexed the object directly, so those keys passed validation (PRJ-ISSUE-3).
  if (typeof status !== "string") return undefined;
  return Object.prototype.hasOwnProperty.call(ENROLLMENT_MODERATION_ACTIONS, status) ? ENROLLMENT_MODERATION_ACTIONS[status] : undefined;
}

export type EnrollDecision =
  | { kind: "create" }
  | { kind: "banned" }
  | { kind: "already_active" }
  | { kind: "reactivate"; from: string };

/**
 * What to do with an existing enrollment row for this entity-project pair. A "banned" row permanently blocks
 * re-enrollment; "active" is a conflict; "disqualified"/"cancelled" reactivate the same row, keeping its history.
 */
export function decideEnrollment(existing: { status: string } | undefined | null): EnrollDecision {
  if (!existing) return { kind: "create" };
  if (existing.status === "banned") return { kind: "banned" };
  if (existing.status === "active") return { kind: "already_active" };
  return { kind: "reactivate", from: existing.status };
}

/** accountData is stored as JSON text; only a non-null object is serialized, anything else yields `fallback`. */
export function serializeAccountData(accountData: unknown, fallback: string | null): string | null {
  return accountData && typeof accountData === "object" ? JSON.stringify(accountData) : fallback;
}

export interface EnrollmentRecord { enrolledAt: Date; accountData: string | null }

/** Public enrollment shape: ISO enrolledAt and parsed accountData (null when empty). */
export function formatEnrollment<T extends EnrollmentRecord>(e: T) {
  return { ...e, enrolledAt: e.enrolledAt.toISOString(), accountData: e.accountData ? JSON.parse(e.accountData) : null };
}
