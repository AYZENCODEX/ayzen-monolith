/**
 * projects/security/enrollment-ownership.ts
 * PEP ownership gate for project enrollments (Route Integration Season C, Phase C9). Moved as-is from
 * routes/projects.ts in PRJ-05; behavior is frozen. Gates `DELETE /projects/:id/enrollments/:enrollmentId` and
 * `GET /projects/enrollments/:enrollmentId/activity`.
 *
 * `DELETE .../enrollments/:enrollmentId` never returned a 404: a non-owner or nonexistent id is a pre-existing
 * silent no-op, so its `onDeny` (supplied by the route) renders `{ message: "Enrollment removed" }` instead of a 404.
 */
import type { Request, Response } from "express";
import { pepDecisionObserver } from "../../middlewares/auth";
import { requireOwnership } from "../../lib/policy/pep/middleware";
import type { ResourceRefBuilder } from "../../lib/policy/pep/types";
import { findEnrollmentOwnerId } from "../infrastructure/repositories/enrollments-repo";

const PROJECT_ENROLLMENT_OWNER_SENTINEL_NONE = -1;

export const projectEnrollmentResource: ResourceRefBuilder = async (req: Request) => {
  const raw = req.params.enrollmentId;
  const id = parseInt(Array.isArray(raw) ? raw[0] : raw, 10);
  if (!Number.isFinite(id)) return { type: "project_enrollment", id: raw, ownerId: PROJECT_ENROLLMENT_OWNER_SENTINEL_NONE };
  const ownerId = await findEnrollmentOwnerId(id);
  return { type: "project_enrollment", id, ownerId: ownerId ?? PROJECT_ENROLLMENT_OWNER_SENTINEL_NONE };
};

export function requireProjectEnrollmentOwnership(action: string, onDeny: (req: Request, res: Response) => void) {
  return requireOwnership(action, projectEnrollmentResource, {
    onDecision: pepDecisionObserver,
    onDeny,
  });
}
