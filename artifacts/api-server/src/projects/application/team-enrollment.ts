/**
 * projects/application/team-enrollment.ts
 * Team enroll use case (PRJ-08b). Moved from routes/teams.ts: the leader enrolls every active team member in a
 * project, using the leader's own vault entity for each member's row. The route keeps authentication, the team
 * leader PDP decision, the team_members reads, notifications, the broadcast and the activity log.
 *
 * Rules are unchanged from the route: every member gets a user_projects link; with a vaultEntryId a member gets a
 * new active row only when no row exists for (project, member, entity) (an existing row of any status is left alone).
 * Billing (PRJ-07): credits are checked for the members who still need a row before any write, charged to the
 * leader for the rows actually created.
 */
import { findProjectById } from "../infrastructure/repositories/projects-repo";
import { findEnrollmentForEntity, findUserProjectLinks, insertEnrollment, insertUserProject } from "../infrastructure/repositories/enrollments-repo";
import { findUserVaultEntry } from "../infrastructure/repositories/vault-entries-reader";
import { checkEnrollCredits, chargeEnrollCredits, type EnrollCreditCheck } from "./enrollment-billing";

export type TeamEnrollResult =
  | { ok: false; status: 404; error: string }
  | { ok: false; status: 402; body: Extract<EnrollCreditCheck, { ok: false }>["body"] }
  | { ok: true; projectName: string; enrolledCount: number; charge: unknown };

export async function enrollTeamInProject(input: {
  leaderId: number; projectId: number; vaultEntryId?: number; memberIds: number[];
}): Promise<TeamEnrollResult> {
  const { leaderId, projectId, vaultEntryId, memberIds } = input;

  const project = await findProjectById(projectId);
  if (!project) return { ok: false, status: 404, error: "Project not found" };

  // C34: the entity must belong to the leader, otherwise it would be written into every member's row.
  if (vaultEntryId) {
    const entity = await findUserVaultEntry(vaultEntryId, leaderId);
    if (!entity) return { ok: false, status: 404, error: "Vault entity not found" };
  }

  if (vaultEntryId) {
    let needed = 0;
    for (const memberId of memberIds) {
      if (!(await findEnrollmentForEntity(projectId, memberId, vaultEntryId))) needed++;
    }
    const credits = await checkEnrollCredits(leaderId, needed);
    if (!credits.ok) return { ok: false, status: 402, body: credits.body };
  }

  let enrolledCount = 0;
  for (const memberId of memberIds) {
    if ((await findUserProjectLinks(memberId, projectId)).length === 0) await insertUserProject(memberId, projectId);
    if (vaultEntryId && !(await findEnrollmentForEntity(projectId, memberId, vaultEntryId))) {
      await insertEnrollment({ userId: memberId, projectId, vaultEntryId, status: "active", accountData: null, kycEntryId: null, dataEntityId: null });
      enrolledCount++;
    }
  }

  const charge = await chargeEnrollCredits(leaderId, enrolledCount);
  return { ok: true, projectName: project.name, enrolledCount, charge };
}
