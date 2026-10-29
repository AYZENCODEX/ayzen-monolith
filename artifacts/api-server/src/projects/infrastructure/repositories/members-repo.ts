// projects/infrastructure/repositories/members-repo.ts
// Reads behind project members, stats and per-entity task completion (PRJ-05), moved unchanged from
// routes/projects.ts. Task and submission tables have no owning module, so these read them directly.
import { db, projectsTable, tasksTable, userProjectsTable } from "@workspace/db";
import { eq, count, sql } from "drizzle-orm";

export async function queryMembers(projectId: number): Promise<any[]> {
  const rows = await db.execute(sql.raw(
    `SELECT up.user_id, up.joined_at, u.username, u.email,
              (SELECT COUNT(*) FROM task_submissions ts
               JOIN tasks t ON t.id = ts.task_id
               WHERE ts.user_id = up.user_id AND t.project_id = ${projectId}
               AND ts.status IN ('approved','completed'))::int as tasks_completed,
              (SELECT COUNT(*) FROM tasks WHERE project_id = ${projectId})::int as total_tasks
       FROM user_projects up
       JOIN users u ON u.id = up.user_id
       WHERE up.project_id = ${projectId}
       ORDER BY up.joined_at DESC`
  ));
  return rows.rows as any[];
}

export async function queryProjectStatsParts(projectId: number) {
  const [{ taskCount }] = await db.select({ taskCount: count() }).from(tasksTable).where(eq(tasksTable.projectId, projectId));
  const [{ memberCount }] = await db.select({ memberCount: count() }).from(userProjectsTable).where(eq(userProjectsTable.projectId, projectId));
  const [roiResult] = await db.select({ roi: sql<number>`COALESCE(SUM(total_roi_distributed), 0)` }).from(projectsTable).where(eq(projectsTable.id, projectId));
  return { taskCount, memberCount, roi: roiResult?.roi };
}

export async function queryProjectTasks(projectId: number) {
  return db.execute(sql.raw(
    `SELECT id, name, description, reward_amount, verification_type, task_type, cost, profit FROM tasks WHERE project_id = ${projectId} ORDER BY id ASC`
  ));
}

export async function queryEnrollmentsWithEntity(projectId: number, userId: number) {
  return db.execute(sql.raw(
    `SELECT pe.*, ve.entity_serial, ve.project_name as entity_name, ve.category, ve.twitter_username, ve.discord_username, ve.email
       FROM project_enrollments pe
       LEFT JOIN vault_entries ve ON ve.id = pe.vault_entry_id
       WHERE pe.project_id = ${projectId} AND pe.user_id = ${userId}`
  ));
}

/** The user's latest submission for a task, as the raw result (rows[0] may be undefined). */
export async function queryLatestSubmission(taskId: number, userId: number) {
  return db.execute(sql.raw(
    `SELECT status FROM task_submissions WHERE task_id = ${taskId} AND user_id = ${userId} ORDER BY submitted_at DESC LIMIT 1`
  ));
}
