/**
 * projects/application/members.ts
 * Project members, stats and per-entity task completion (PRJ-05). Moved unchanged from routes/projects.ts.
 */
import { buildStats, mapEntityTaskEnrollment, mapMembers, mapTaskStatus } from "../domain/members";
import {
  queryEnrollmentsWithEntity,
  queryLatestSubmission,
  queryMembers,
  queryProjectStatsParts,
  queryProjectTasks,
} from "../infrastructure/repositories/members-repo";

export async function listMembers(projectId: number) {
  return mapMembers(await queryMembers(projectId));
}

export async function getProjectStats(projectId: number) {
  const { taskCount, memberCount, roi } = await queryProjectStatsParts(projectId);
  return buildStats(taskCount, memberCount, roi);
}

/** Per-entity task completion for the caller's enrollments in a project. */
export async function getEntityTasks(projectId: number, userId: number) {
  const tasks = await queryProjectTasks(projectId);
  const enrollments = await queryEnrollmentsWithEntity(projectId, userId);

  const result = await Promise.all((enrollments.rows as any[]).map(async (enr) => {
    const taskStatuses = await Promise.all((tasks.rows as any[]).map(async (task) => {
      const sub = await queryLatestSubmission(task.id, userId);
      return mapTaskStatus(task, sub.rows[0] as { status?: string } | undefined);
    }));
    return mapEntityTaskEnrollment(enr, taskStatuses, tasks.rows.length);
  }));

  return { tasks: tasks.rows, entities: result };
}
