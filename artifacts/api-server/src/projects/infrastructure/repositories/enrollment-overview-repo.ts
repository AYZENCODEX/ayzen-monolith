// projects/infrastructure/repositories/enrollment-overview-repo.ts
// Raw-SQL reads behind the "enrolled" views (PRJ-05), moved unchanged from routes/projects.ts.
// The activity-log based overviews (getUserEnrollmentsOverview etc.) stay in lib/activity-log.
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

/** GET /projects/enrolled: projects the user has active/completed enrollments in, with entity counts. */
export async function queryEnrolledProjects(userId: number): Promise<any[]> {
  const result = await db.execute(sql.raw(`
      SELECT p.id, p.name, p.category, p.status,
             COUNT(DISTINCT pe.vault_entry_id)::int AS enrolled_count
      FROM projects p
      JOIN project_enrollments pe ON pe.project_id = p.id AND pe.user_id = ${userId}
      WHERE pe.status NOT IN ('cancelled', 'banned')
      GROUP BY p.id, p.name, p.category, p.status
      ORDER BY p.name
    `));
  return result.rows as any[];
}

/** GET /projects/:id/enrolled-entities: vault entities enrolled in one project. */
export async function queryEnrolledEntitiesForProject(projectId: number, userId: number): Promise<any[]> {
  const result = await db.execute(sql.raw(`
      SELECT ve.id, ve.project_name, ve.category, ve.entity_serial, ve.status,
             ve.twitter_username, ve.discord_username, ve.telegram_username,
             pe.status AS enrollment_status
      FROM project_enrollments pe
      JOIN vault_entries ve ON ve.id = pe.vault_entry_id
      WHERE pe.project_id = ${projectId} AND pe.user_id = ${userId}
        AND pe.status NOT IN ('cancelled', 'banned')
      ORDER BY pe.created_at DESC
    `));
  return result.rows as any[];
}

export async function queryMineEnrolled(userId: number): Promise<any[]> {
  const rows = await db.execute(sql.raw(
    `SELECT p.id as project_id, p.name as project_name, p.thumbnail_url, p.category,
            COUNT(pe.id)::int as enrolled_count
     FROM project_enrollments pe
     JOIN projects p ON p.id = pe.project_id
     WHERE pe.user_id = ${userId}
     GROUP BY p.id, p.name, p.thumbnail_url, p.category
     ORDER BY p.name ASC`
  ));
  return rows.rows as any[];
}

export async function queryMineEnrolledEntities(userId: number): Promise<any[]> {
  const rows = await db.execute(sql.raw(
    `SELECT
         ve.id as vault_entry_id, ve.entity_serial, ve.project_name as entity_name, ve.category,
         p.id as project_id, p.name as project_name, p.status as project_status, p.thumbnail_url as project_thumbnail_url,
         pe.status as enrollment_status, pe.enrolled_at
       FROM project_enrollments pe
       JOIN vault_entries ve ON ve.id = pe.vault_entry_id
       JOIN projects p ON p.id = pe.project_id
       WHERE pe.user_id = ${userId}
       ORDER BY pe.enrolled_at DESC`
  ));
  return rows.rows as any[];
}
